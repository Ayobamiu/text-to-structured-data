/**
 * Schema Registry (Phase 0)
 *
 * Read + write operations against the document_types and schemas tables.
 *
 * Read operations are cached briefly (CACHE_TTL_MS) to keep latency low for
 * the future per-section extraction path which calls getActiveSchema(slug)
 * once per detected section per file. Cache is invalidated on any write
 * through this module.
 *
 * Per-section extraction and the visual classifier read active schemas here.
 * Admin CRUD lives in `server.js` under `/registry/document-types/*` (admin JWT).
 */

import pool from '../database.js';

const CACHE_TTL_MS = 30_000; // 30s — cheap and adequate; bust on writes anyway

const cache = {
    activeSchemas: new Map(), // slug -> { value, expiresAt }
    documentTypes: { value: null, expiresAt: 0 },
};

function now() {
    return Date.now();
}

function bustCache() {
    cache.activeSchemas.clear();
    cache.documentTypes = { value: null, expiresAt: 0 };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List all document types.
 * @param {Object} opts
 * @param {boolean} [opts.includeDeprecated=false]
 */
export async function listDocumentTypes({ includeDeprecated = false } = {}) {
    if (
        cache.documentTypes.value &&
        cache.documentTypes.expiresAt > now() &&
        !includeDeprecated
    ) {
        return cache.documentTypes.value;
    }

    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT id, slug, display_name, description, default_extractor,
                    routing_confidence_threshold, current_schema_version_id,
                    classifier_hints, qa_hints, identifier_fields,
                    status, created_at, updated_at
             FROM document_types
             ${includeDeprecated ? '' : "WHERE status = 'active'"}
             ORDER BY slug ASC`
        );
        const rows = result.rows;
        if (!includeDeprecated) {
            cache.documentTypes = { value: rows, expiresAt: now() + CACHE_TTL_MS };
        }
        return rows;
    } finally {
        client.release();
    }
}

/**
 * Get the subset of active document types matching the requested slugs.
 *
 * Used by callers (CLI, classifier stage, future job-creation API) that want
 * to restrict classification to a known set of document types — e.g. "this
 * batch is all well logs, only consider mgs_well_log + 'none'".
 *
 * Behaviour:
 *   - Empty / null / undefined slugs → returns ALL active types
 *     (delegates to listDocumentTypes). This is the documented default so
 *     callers can leave the field optional without surprise.
 *   - Errors loudly when any requested slug doesn't match an active type,
 *     listing both the missing slugs and the available ones. Silently
 *     filtering would mask config typos that waste classifier money.
 *   - Result is sorted to match the requested-slug order so the response
 *     schema enum is deterministic across calls.
 *
 * @param {Array<string>|null|undefined} slugs
 * @param {Object} [opts]
 * @param {boolean} [opts.includeDeprecated=false]
 * @returns {Promise<Array<Object>>}
 */
export async function getDocumentTypesBySlugs(slugs, opts = {}) {
    const requested = Array.isArray(slugs)
        ? [...new Set(slugs.filter((s) => typeof s === 'string' && s.length > 0))]
        : [];

    if (requested.length === 0) {
        return listDocumentTypes(opts);
    }

    const all = await listDocumentTypes(opts);
    const bySlug = new Map(all.map((d) => [d.slug, d]));

    const found = [];
    const missing = [];
    for (const slug of requested) {
        const dt = bySlug.get(slug);
        if (dt) {
            found.push(dt);
        } else {
            missing.push(slug);
        }
    }

    if (missing.length > 0) {
        const available = all.map((d) => d.slug).join(', ') || '(none registered)';
        throw new Error(
            `Unknown document_type slug(s): ${missing.join(', ')}. Available active types: ${available}.`
        );
    }

    return found;
}

/**
 * Get a single document type by slug.
 * @param {string} slug
 * @returns {Promise<Object|null>}
 */
export async function getDocumentTypeBySlug(slug) {
    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT id, slug, display_name, description, default_extractor,
                    routing_confidence_threshold, current_schema_version_id,
                    classifier_hints, qa_hints, identifier_fields,
                    status, created_at, updated_at
             FROM document_types
             WHERE slug = $1`,
            [slug]
        );
        return result.rows[0] || null;
    } finally {
        client.release();
    }
}

/**
 * Resolve the currently-active schema for a document type slug.
 *
 * Returns the shape that processingService expects today (so it's a drop-in
 * when we wire it):
 *   { schemaName, schema, promptHints, version, documentTypeSlug, schemaId }
 *
 * @param {string} slug
 * @returns {Promise<Object|null>}
 */
export async function getActiveSchema(slug) {
    const cached = cache.activeSchemas.get(slug);
    if (cached && cached.expiresAt > now()) {
        return cached.value;
    }

    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT s.id              AS schema_id,
                    s.version         AS version,
                    s.json_schema     AS json_schema,
                    s.prompt_hints    AS prompt_hints,
                    s.schema_name     AS schema_name,
                    dt.slug           AS slug,
                    dt.display_name   AS display_name,
                    dt.default_extractor AS default_extractor
             FROM document_types dt
             JOIN schemas s ON s.id = dt.current_schema_version_id
             WHERE dt.slug = $1 AND dt.status = 'active' AND s.status = 'active'`,
            [slug]
        );

        if (result.rows.length === 0) {
            cache.activeSchemas.set(slug, { value: null, expiresAt: now() + CACHE_TTL_MS });
            return null;
        }

        const r = result.rows[0];
        const value = {
            schemaName: r.schema_name || `${slug}_extraction`,
            schema: r.json_schema,
            promptHints: r.prompt_hints || {},
            version: r.version,
            documentTypeSlug: r.slug,
            displayName: r.display_name,
            defaultExtractor: r.default_extractor,
            schemaId: r.schema_id,
        };
        cache.activeSchemas.set(slug, { value, expiresAt: now() + CACHE_TTL_MS });
        return value;
    } finally {
        client.release();
    }
}

/**
 * Get a specific historical schema version (for re-running an old extraction
 * with the schema it was originally extracted under, or for diffing).
 * @param {string} slug
 * @param {number} version
 */
export async function getSchemaVersion(slug, version) {
    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT s.id              AS schema_id,
                    s.version         AS version,
                    s.json_schema     AS json_schema,
                    s.prompt_hints    AS prompt_hints,
                    s.schema_name     AS schema_name,
                    s.status          AS status,
                    dt.slug           AS slug,
                    dt.display_name   AS display_name,
                    dt.default_extractor AS default_extractor
             FROM schemas s
             JOIN document_types dt ON dt.id = s.document_type_id
             WHERE dt.slug = $1 AND s.version = $2`,
            [slug, version]
        );
        if (result.rows.length === 0) return null;
        const r = result.rows[0];
        return {
            schemaName: r.schema_name || `${slug}_extraction`,
            schema: r.json_schema,
            promptHints: r.prompt_hints || {},
            version: r.version,
            status: r.status,
            documentTypeSlug: r.slug,
            displayName: r.display_name,
            defaultExtractor: r.default_extractor,
            schemaId: r.schema_id,
        };
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Register a new document type. Idempotent on slug — if the slug already
 * exists, returns the existing row unchanged.
 *
 * @param {Object} args
 * @param {string} args.slug
 * @param {string} args.displayName
 * @param {string} [args.description]
 * @param {string} [args.defaultExtractor='extendai']
 * @param {number} [args.routingConfidenceThreshold=0.75]
 */
export async function registerDocumentType({
    slug,
    displayName,
    description = null,
    defaultExtractor = 'extendai',
    routingConfidenceThreshold = 0.75,
}) {
    if (!slug || !displayName) {
        throw new Error('registerDocumentType requires slug and displayName');
    }

    const client = await pool.connect();
    try {
        const existing = await client.query(
            `SELECT id, slug, display_name FROM document_types WHERE slug = $1`,
            [slug]
        );
        if (existing.rows.length > 0) {
            return { ...existing.rows[0], created: false };
        }

        const result = await client.query(
            `INSERT INTO document_types
                (slug, display_name, description, default_extractor, routing_confidence_threshold)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, slug, display_name, description, default_extractor,
                       routing_confidence_threshold, status, created_at`,
            [slug, displayName, description, defaultExtractor, routingConfidenceThreshold]
        );
        bustCache();
        return { ...result.rows[0], created: true };
    } finally {
        client.release();
    }
}

/**
 * Register (or version-bump) a schema for a document type.
 *
 * Behaviour:
 *   - If no schema exists yet for the document type → version 1, becomes
 *     current_schema_version_id.
 *   - If a schema exists and `setActive` is true (default) → next version,
 *     becomes current_schema_version_id, previous current is left in place
 *     with status='active' (history is preserved; we don't auto-deprecate
 *     because old extracted records still reference the old version).
 *   - If `setActive` is false → next version with status='draft', current
 *     active version is unchanged.
 *
 * @param {Object} args
 * @param {string} args.documentTypeSlug
 * @param {Object} args.jsonSchema           OpenAI strict JSON Schema
 * @param {Object} [args.promptHints={}]      Extracted x-* hints (see schemas.prompt_hints comment)
 * @param {string} [args.schemaName]          Optional friendly name for OpenAI response_format
 * @param {string} [args.notes]
 * @param {string} [args.createdBy]           User UUID
 * @param {boolean} [args.setActive=true]     Whether to point document_types.current_schema_version_id at this row
 */
export async function registerSchema({
    documentTypeSlug,
    jsonSchema,
    promptHints = {},
    schemaName = null,
    notes = null,
    createdBy = null,
    setActive = true,
}) {
    if (!documentTypeSlug) throw new Error('registerSchema requires documentTypeSlug');
    if (!jsonSchema || typeof jsonSchema !== 'object') {
        throw new Error('registerSchema requires a jsonSchema object');
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const dtResult = await client.query(
            `SELECT id, slug FROM document_types WHERE slug = $1`,
            [documentTypeSlug]
        );
        if (dtResult.rows.length === 0) {
            throw new Error(
                `document_type '${documentTypeSlug}' is not registered. Call registerDocumentType first.`
            );
        }
        const documentTypeId = dtResult.rows[0].id;

        const versionResult = await client.query(
            `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
             FROM schemas WHERE document_type_id = $1`,
            [documentTypeId]
        );
        const nextVersion = versionResult.rows[0].next_version;

        const insertResult = await client.query(
            `INSERT INTO schemas
                (document_type_id, version, json_schema, prompt_hints, schema_name, status, created_by, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, version, status, created_at`,
            [
                documentTypeId,
                nextVersion,
                JSON.stringify(jsonSchema),
                JSON.stringify(promptHints),
                schemaName,
                setActive ? 'active' : 'draft',
                createdBy,
                notes,
            ]
        );
        const schemaRow = insertResult.rows[0];

        if (setActive) {
            await client.query(
                `UPDATE document_types
                 SET current_schema_version_id = $1, updated_at = NOW()
                 WHERE id = $2`,
                [schemaRow.id, documentTypeId]
            );
        }

        await client.query('COMMIT');
        bustCache();

        return {
            schemaId: schemaRow.id,
            documentTypeSlug,
            version: schemaRow.version,
            status: schemaRow.status,
            isCurrent: setActive,
            createdAt: schemaRow.created_at,
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Set (replace) the classifier_hints object on a document type.
 *
 * Why a replace, not a merge: hints are short, hand-edited objects whose
 * authors expect "what I wrote is what gets used." A merge would let stale
 * skip_when rules silently linger, which is the exact failure mode hints
 * are meant to prevent.
 *
 * @param {string} slug
 * @param {Object} hints   Free-form object; see migrations/add_classifier_hints_to_document_types.js for shape.
 *                         Typically { skip_when: [...], keep_when: [...] }.
 *
 * @returns {Promise<{ slug, classifier_hints, updated_at }>}
 */
export async function setClassifierHints(slug, hints) {
    if (!slug) throw new Error('setClassifierHints requires slug');
    if (!hints || typeof hints !== 'object' || Array.isArray(hints)) {
        throw new Error('setClassifierHints requires a plain object for hints');
    }

    const client = await pool.connect();
    try {
        const result = await client.query(
            `UPDATE document_types
             SET classifier_hints = $1::jsonb, updated_at = NOW()
             WHERE slug = $2
             RETURNING slug, classifier_hints, updated_at`,
            [JSON.stringify(hints), slug]
        );
        if (result.rows.length === 0) {
            throw new Error(`document_type '${slug}' not found`);
        }
        bustCache();
        return result.rows[0];
    } finally {
        client.release();
    }
}

/**
 * Set (replace) the per-document-type post-processing defaults — the list of
 * services that auto-run during processing for this slug unless a job overrides
 * them. Replace (not merge), same reasoning as classifier hints: the authored
 * array is exactly what runs, so removing an entry actually disables it.
 *
 * @param {string} slug
 * @param {Array<{name:string, enabled?:boolean, options?:object}>} defaults
 * @returns {Promise<{ slug, post_processing_defaults, updated_at }>}
 */
export async function setPostProcessingDefaults(slug, defaults) {
    if (!slug) throw new Error('setPostProcessingDefaults requires slug');
    if (!Array.isArray(defaults)) {
        throw new Error('setPostProcessingDefaults requires an array');
    }
    for (const entry of defaults) {
        if (!entry || typeof entry.name !== 'string' || !entry.name) {
            throw new Error('each post-processing default needs a string "name"');
        }
        if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
            throw new Error(`post-processing default "${entry.name}".enabled must be a boolean`);
        }
    }

    const client = await pool.connect();
    try {
        const result = await client.query(
            `UPDATE document_types
             SET post_processing_defaults = $1::jsonb, updated_at = NOW()
             WHERE slug = $2
             RETURNING slug, post_processing_defaults, updated_at`,
            [JSON.stringify(defaults), slug]
        );
        if (result.rows.length === 0) {
            throw new Error(`document_type '${slug}' not found`);
        }
        bustCache();
        return result.rows[0];
    } finally {
        client.release();
    }
}

/**
 * Set (replace) the per-document-type identifier field paths — the ordered list
 * of dot-paths used to label a record in the preview ID column / drawer header.
 * Replace (not merge), same reasoning as classifier hints / post-processing
 * defaults: the authored array is exactly what's used.
 *
 * @param {string} slug
 * @param {string[]} fields  Ordered dot-paths, e.g. ['site_identification.boring_well_id'].
 *                           First non-empty scalar at preview time wins.
 * @returns {Promise<{ slug, identifier_fields, updated_at }>}
 */
export async function setIdentifierFields(slug, fields) {
    if (!slug) throw new Error('setIdentifierFields requires slug');
    if (!Array.isArray(fields)) {
        throw new Error('setIdentifierFields requires an array of dot-path strings');
    }
    for (const f of fields) {
        if (typeof f !== 'string' || !f.trim()) {
            throw new Error('each identifier field must be a non-empty string (dot-path)');
        }
    }

    const client = await pool.connect();
    try {
        const result = await client.query(
            `UPDATE document_types
             SET identifier_fields = $1::jsonb, updated_at = NOW()
             WHERE slug = $2
             RETURNING slug, identifier_fields, updated_at`,
            [JSON.stringify(fields), slug]
        );
        if (result.rows.length === 0) {
            throw new Error(`document_type '${slug}' not found`);
        }
        bustCache();
        return result.rows[0];
    } finally {
        client.release();
    }
}

/**
 * Promote a draft (or older active) schema version to current_schema_version.
 * Useful when a draft schema has been validated against held-out files and
 * is ready to take over from the previous active version.
 */
/**
 * Full document type row + current schema summary (for registry admin UI).
 * @param {string} slug
 * @returns {Promise<Object|null>}
 */
export async function getDocumentTypeDetail(slug) {
    const client = await pool.connect();
    try {
        const r = await client.query(
            `SELECT dt.id AS document_type_id,
                    dt.slug,
                    dt.display_name,
                    dt.description,
                    dt.default_extractor,
                    dt.routing_confidence_threshold,
                    dt.status,
                    dt.classifier_hints,
                    dt.qa_hints,
                    dt.post_processing_defaults,
                    dt.identifier_fields,
                    dt.created_at,
                    dt.updated_at,
                    dt.current_schema_version_id,
                    s.version AS current_schema_version,
                    s.schema_name AS current_schema_name,
                    s.status AS current_schema_row_status
             FROM document_types dt
             LEFT JOIN schemas s ON s.id = dt.current_schema_version_id
             WHERE dt.slug = $1`,
            [slug]
        );
        return r.rows[0] || null;
    } finally {
        client.release();
    }
}

/**
 * List schema versions for a slug, newest first. Each row includes `is_current`.
 * @returns {Promise<Array<Object>|null>} null if document type missing
 */
export async function listSchemaVersionsForSlug(slug) {
    const client = await pool.connect();
    try {
        const dt = await client.query(
            `SELECT id, current_schema_version_id FROM document_types WHERE slug = $1`,
            [slug]
        );
        if (dt.rows.length === 0) return null;

        const documentTypeId = dt.rows[0].id;
        const currentId = dt.rows[0].current_schema_version_id;

        const versions = await client.query(
            `SELECT s.id,
                    s.version,
                    s.schema_name,
                    s.status,
                    s.notes,
                    s.created_at,
                    (s.id = $2) AS is_current
             FROM schemas s
             WHERE s.document_type_id = $1
             ORDER BY s.version DESC`,
            [documentTypeId, currentId]
        );
        return versions.rows;
    } finally {
        client.release();
    }
}

/**
 * PATCH fields on document_types (slug is immutable).
 */
export async function updateDocumentType(slug, patch = {}) {
    if (!slug) throw new Error('updateDocumentType requires slug');

    const allowed = {
        displayName: 'display_name',
        description: 'description',
        defaultExtractor: 'default_extractor',
        routingConfidenceThreshold: 'routing_confidence_threshold',
        status: 'status',
    };

    const cols = [];
    const vals = [];
    let i = 1;

    for (const [jsKey, sqlCol] of Object.entries(allowed)) {
        if (patch[jsKey] !== undefined) {
            cols.push(`${sqlCol} = $${i}`);
            vals.push(patch[jsKey]);
            i++;
        }
    }

    if (cols.length === 0) {
        throw new Error('updateDocumentType: no valid fields to update');
    }

    vals.push(slug);

    const client = await pool.connect();
    try {
        const r = await client.query(
            `UPDATE document_types
             SET ${cols.join(', ')}, updated_at = NOW()
             WHERE slug = $${i}
             RETURNING id, slug, display_name, description, default_extractor,
                       routing_confidence_threshold, status, updated_at`,
            vals
        );
        if (r.rows.length === 0) {
            throw new Error(`document_type '${slug}' not found`);
        }
        bustCache();
        return r.rows[0];
    } finally {
        client.release();
    }
}

/**
 * Hard-delete a document type and all schema versions (schemas.document_type_id ON DELETE CASCADE).
 * Also sets current_schema_version_id via CASCADE from document_types row removal.
 */
export async function deleteDocumentTypeBySlug(slug) {
    if (!slug) throw new Error('deleteDocumentTypeBySlug requires slug');

    const client = await pool.connect();
    try {
        const r = await client.query(
            `DELETE FROM document_types WHERE slug = $1 RETURNING id, slug`,
            [slug]
        );
        bustCache();
        return r.rows[0] || null;
    } finally {
        client.release();
    }
}

/**
 * Clear classifier_hints completely (UI "remove hints").
 */
export async function clearClassifierHints(slug) {
    if (!slug) throw new Error('clearClassifierHints requires slug');

    const client = await pool.connect();
    try {
        const result = await client.query(
            `UPDATE document_types
             SET classifier_hints = NULL, updated_at = NOW()
             WHERE slug = $1
             RETURNING slug, classifier_hints, updated_at`,
            [slug]
        );
        if (result.rows.length === 0) {
            throw new Error(`document_type '${slug}' not found`);
        }
        bustCache();
        return result.rows[0];
    } finally {
        client.release();
    }
}

/**
 * Get the qa_hints object for a document type (used by sectionQAService to
 * splice per-field-group priority/ignore guidance into the QA system prompt).
 * @param {string} slug
 * @returns {Promise<Object>} the qa_hints object, or {} if the type is unknown
 *   or has none set — QA should degrade to its generic prompt, not fail.
 */
export async function getQAHints(slug) {
    if (!slug) return {};
    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT qa_hints FROM document_types WHERE slug = $1`,
            [slug]
        );
        return result.rows[0]?.qa_hints || {};
    } finally {
        client.release();
    }
}

/**
 * Set (replace) the qa_hints object on a document type. Replace, not merge —
 * same reasoning as setClassifierHints: the authored object is exactly what's
 * used, so a removed group's guidance actually stops applying.
 *
 * @param {string} slug
 * @param {Object} hints  Keyed by top-level schema field-group name, e.g.
 *                        { lithology_intervals: { priority: 'critical', notes: '...' } }.
 *                        See migrations/add_qa_hints_to_document_types.js for shape.
 * @returns {Promise<{ slug, qa_hints, updated_at }>}
 */
export async function setQAHints(slug, hints) {
    if (!slug) throw new Error('setQAHints requires slug');
    if (!hints || typeof hints !== 'object' || Array.isArray(hints)) {
        throw new Error('setQAHints requires a plain object for hints');
    }

    const client = await pool.connect();
    try {
        const result = await client.query(
            `UPDATE document_types
             SET qa_hints = $1::jsonb, updated_at = NOW()
             WHERE slug = $2
             RETURNING slug, qa_hints, updated_at`,
            [JSON.stringify(hints), slug]
        );
        if (result.rows.length === 0) {
            throw new Error(`document_type '${slug}' not found`);
        }
        bustCache();
        return result.rows[0];
    } finally {
        client.release();
    }
}

/**
 * Clear qa_hints back to the empty-object default (not NULL — the column is
 * NOT NULL DEFAULT '{}'::jsonb).
 * @param {string} slug
 * @returns {Promise<{ slug, qa_hints, updated_at }>}
 */
export async function clearQAHints(slug) {
    if (!slug) throw new Error('clearQAHints requires slug');

    const client = await pool.connect();
    try {
        const result = await client.query(
            `UPDATE document_types
             SET qa_hints = '{}'::jsonb, updated_at = NOW()
             WHERE slug = $1
             RETURNING slug, qa_hints, updated_at`,
            [slug]
        );
        if (result.rows.length === 0) {
            throw new Error(`document_type '${slug}' not found`);
        }
        bustCache();
        return result.rows[0];
    } finally {
        client.release();
    }
}

export async function setCurrentSchemaVersion(documentTypeSlug, version) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `SELECT s.id AS schema_id, dt.id AS document_type_id
             FROM schemas s
             JOIN document_types dt ON dt.id = s.document_type_id
             WHERE dt.slug = $1 AND s.version = $2`,
            [documentTypeSlug, version]
        );
        if (result.rows.length === 0) {
            throw new Error(
                `No schema version ${version} for document_type '${documentTypeSlug}'`
            );
        }
        const { schema_id, document_type_id } = result.rows[0];
        await client.query(
            `UPDATE schemas SET status = 'active', updated_at = NOW() WHERE id = $1`,
            [schema_id]
        );
        await client.query(
            `UPDATE document_types SET current_schema_version_id = $1, updated_at = NOW() WHERE id = $2`,
            [schema_id, document_type_id]
        );
        await client.query('COMMIT');
        bustCache();
        return { documentTypeSlug, version, schemaId: schema_id };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

export default {
    listDocumentTypes,
    getDocumentTypesBySlugs,
    getDocumentTypeBySlug,
    getActiveSchema,
    getSchemaVersion,
    registerDocumentType,
    registerSchema,
    setClassifierHints,
    clearClassifierHints,
    getQAHints,
    setQAHints,
    clearQAHints,
    setPostProcessingDefaults,
    setCurrentSchemaVersion,
    getDocumentTypeDetail,
    listSchemaVersionsForSlug,
    updateDocumentType,
    deleteDocumentTypeBySlug,
};
