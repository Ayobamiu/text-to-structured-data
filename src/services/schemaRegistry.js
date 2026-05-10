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
 * This module is intentionally NOT wired into the worker / processingService
 * yet. Phase 0 ships the registry as read-ready infrastructure; the wiring
 * happens in Phase 1 when per-section extraction lands.
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
 * Promote a draft (or older active) schema version to current_schema_version.
 * Useful when a draft schema has been validated against held-out files and
 * is ready to take over from the previous active version.
 */
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
    getDocumentTypeBySlug,
    getActiveSchema,
    getSchemaVersion,
    registerDocumentType,
    registerSchema,
    setCurrentSchemaVersion,
};
