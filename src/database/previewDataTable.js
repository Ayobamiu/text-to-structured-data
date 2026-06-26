/**
 * Preview Data Table Database Functions
 * Handles CRUD operations for preview_data_table
 */

import pool from '../database.js';
import { flattenRecords, inferSlugFromShape } from '../utils/resultEnvelope.js';

/**
 * Create a new preview data table
 */
export async function createPreviewDataTable(name, schema, logo = null) {
    const client = await pool.connect();
    try {
        const query = `
            INSERT INTO preview_data_table (name, schema, logo)
            VALUES ($1, $2, $3)
            RETURNING id, name, schema, logo, items_ids, created_at, updated_at
        `;

        const values = [name, schema, logo];
        const result = await client.query(query, values);

        return result.rows[0];
    } finally {
        client.release();
    }
}

/**
 * Get all preview data tables
 */
export async function getPreviewDataTables() {
    const client = await pool.connect();
    try {
        const query = `
            SELECT id, name, schema, logo, items_ids, created_at, updated_at,
                   array_length(items_ids, 1) as item_count
            FROM preview_data_table
            ORDER BY created_at DESC
        `;

        const result = await client.query(query);
        return result.rows;
    } finally {
        client.release();
    }
}

/**
 * Get a specific preview data table by ID
 */
export async function getPreviewDataTableById(id) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT id, name, schema, logo, items_ids, created_at, updated_at
            FROM preview_data_table
            WHERE id = $1
        `;

        const result = await client.query(query, [id]);
        return result.rows[0] || null;
    } finally {
        client.release();
    }
}

/**
 * Update a preview data table
 */
export async function updatePreviewDataTable(id, updates) {
    const client = await pool.connect();
    try {
        const allowedFields = ['name', 'schema', 'logo', 'items_ids'];
        const updateFields = [];
        const values = [];
        let paramCount = 1;

        // Build dynamic update query
        for (const [key, value] of Object.entries(updates)) {
            if (allowedFields.includes(key) && value !== undefined) {
                updateFields.push(`${key} = $${paramCount}`);
                values.push(value);
                paramCount++;
            }
        }

        if (updateFields.length === 0) {
            throw new Error('No valid fields to update');
        }

        values.push(id);

        const query = `
            UPDATE preview_data_table
            SET ${updateFields.join(', ')}, updated_at = NOW()
            WHERE id = $${paramCount}
            RETURNING id, name, schema, logo, items_ids, created_at, updated_at
        `;

        const result = await client.query(query, values);
        return result.rows[0] || null;
    } finally {
        client.release();
    }
}

/**
 * Delete a preview data table
 */
export async function deletePreviewDataTable(id) {
    const client = await pool.connect();
    try {
        const query = `
            DELETE FROM preview_data_table
            WHERE id = $1
            RETURNING id, name
        `;

        const result = await client.query(query, [id]);
        return result.rows[0] || null;
    } finally {
        client.release();
    }
}

/**
 * Add items to a preview data table
 */
export async function addItemsToPreview(id, itemIds) {
    const client = await pool.connect();
    try {
        const query = `
            UPDATE preview_data_table
            SET items_ids = array_cat(items_ids, $1), updated_at = NOW()
            WHERE id = $2
            RETURNING id, name, items_ids
        `;

        const result = await client.query(query, [itemIds, id]);
        return result.rows[0] || null;
    } finally {
        client.release();
    }
}

/**
 * Remove items from a preview data table
 */
export async function removeItemsFromPreview(id, itemIds) {
    const client = await pool.connect();
    try {
        const query = `
            UPDATE preview_data_table
            SET items_ids = array_remove(items_ids, $1), updated_at = NOW()
            WHERE id = $2
            RETURNING id, name, items_ids
        `;

        const result = await client.query(query, [itemIds, id]);
        return result.rows[0] || null;
    } finally {
        client.release();
    }
}

/**
 * Get job files data for preview (with results)
 * @deprecated Use getJobFilesForPreviewPaginated for better performance
 */
export async function getJobFilesForPreview(itemIds) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT jf.id, jf.filename, jf.result, jf.processing_status,
                   jf.created_at, j.name as job_name, jf.extraction_time_seconds, jf.ai_processing_time_seconds,
                   jf.admin_verified, jf.review_status
            FROM job_files jf
            JOIN jobs j ON jf.job_id = j.id
            WHERE jf.id = ANY($1)
            ORDER BY jf.created_at DESC
        `;

        const result = await client.query(query, [itemIds]);
        return result.rows;
    } finally {
        client.release();
    }
}

/**
 * Get paginated job files data for preview (with results)
 * @param {string[]} itemIds - Array of job file IDs
 * @param {number} page - Page number (1-indexed)
 * @param {number} pageSize - Number of items per page
 * @param {string} searchTerm - Optional search term to filter by filename or result content
 * @returns {Promise<{files: any[], total: number}>}
 */
export async function getJobFilesForPreviewPaginated(itemIds, page = 1, pageSize = 20, searchTerm = null) {
    const client = await pool.connect();
    try {
        const offset = (page - 1) * pageSize;
        let whereClause = 'WHERE jf.id = ANY($1)';
        const params = [itemIds];
        let paramCount = 1;

        // Add search filter if provided
        if (searchTerm && searchTerm.trim()) {
            paramCount++;
            whereClause += ` AND (
                jf.filename ILIKE $${paramCount} OR
                jf.result::text ILIKE $${paramCount}
            )`;
            params.push(`%${searchTerm.trim()}%`);
        }

        // Get total count
        const countQuery = `
            SELECT COUNT(*) as total
            FROM job_files jf
            JOIN jobs j ON jf.job_id = j.id
            ${whereClause}
        `;
        const countResult = await client.query(countQuery, params);
        const total = parseInt(countResult.rows[0].total, 10);

        // Get paginated files
        paramCount++;
        const query = `
            SELECT jf.id, jf.filename, jf.result, jf.processing_status,
                   jf.created_at, j.name as job_name, jf.extraction_time_seconds, jf.ai_processing_time_seconds,
                   jf.admin_verified, jf.review_status
            FROM job_files jf
            JOIN jobs j ON jf.job_id = j.id
            ${whereClause}
            ORDER BY jf.created_at DESC
            LIMIT $${paramCount} OFFSET $${paramCount + 1}
        `;

        params.push(pageSize, offset);
        const result = await client.query(query, params);

        return {
            files: result.rows,
            total: total,
            page: page,
            pageSize: pageSize
        };
    } finally {
        client.release();
    }
}

// Expands a preview's files into one row per RECORD, entirely in Postgres:
//   - V2 files: unnest each slug→array element that has a section_result_id.
//   - V1 files: the whole result is a single record (slug NULL).
//   - eff_slug: the V2 slug, else a shape-inferred type for V1 well logs.
// $1 = item ids. jsonb inputs are guarded so non-object/non-array results don't error.
export const RECORD_EXPAND_CTE = `
WITH expanded AS (
    SELECT jf.id AS file_id, jf.filename, jf.created_at, jf.processing_status,
           jf.admin_verified, jf.review_status, j.name AS job_name,
           rec.slug, rec.idx, rec.record
    FROM job_files jf
    JOIN jobs j ON jf.job_id = j.id
    CROSS JOIN LATERAL (
        SELECT ee.key AS slug, (ord - 1)::int AS idx, vv AS record
        FROM jsonb_each(jf.result) ee
        CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(ee.value) = 'array' THEN ee.value ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS arr(vv, ord)
        WHERE jsonb_typeof(vv) = 'object' AND vv ? 'section_result_id'
        UNION ALL
        SELECT NULL::text AS slug, 0 AS idx, jf.result AS record
        WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_each(jf.result) e2
            CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(e2.value) = 'array' THEN e2.value ELSE '[]'::jsonb END
            ) v2
            WHERE jsonb_typeof(v2) = 'object' AND v2 ? 'section_result_id'
        )
    ) rec
    WHERE jf.id = ANY($1)
      AND jf.result IS NOT NULL
      AND jsonb_typeof(jf.result) = 'object'
),
typed AS (
    SELECT *,
        COALESCE(slug,
            CASE WHEN record ? 'formations' OR record ? 'casing'
                      OR record ? 'perforation_intervals' OR record ? 'pluggings'
                      OR record ? 'shows_depths' OR record ? 'true_depth'
                      OR record ? 'measured_depth'
                 THEN 'mgs_well_log' END) AS eff_slug
    FROM expanded
)`;

/**
 * Record-aware, SQL-paginated preview data. A "row" is a RECORD (V2 files
 * contribute many; V1 files one). Pagination, counts, search and the type
 * breakdown all run in Postgres — the app never loads every result into memory.
 *
 * Each row keeps the old file-row shape (frontend spreads `row.result`) but
 * `result` is the single record, plus `slug` + `section_result_id` + unique `id`.
 * `slug='untyped'` filters the no-type bucket. `slugs` is the full type
 * distribution for the rail.
 */
export async function getRecordsForPreviewPaginated(
    itemIds,
    page = 1,
    pageSize = 20,
    searchTerm = null,
    slug = null,
    fileId = null,
) {
    if (!itemIds || itemIds.length === 0) {
        return { jobFiles: [], total: 0, page, pageSize, slugs: [] };
    }
    const client = await pool.connect();
    try {
        const offset = (page - 1) * pageSize;
        const searchParam = searchTerm && searchTerm.trim() ? `%${searchTerm.trim()}%` : null;

        // Page rows + filtered total (one scan via COUNT(*) OVER()).
        const pageRes = await client.query(
            `${RECORD_EXPAND_CTE}
             SELECT file_id, filename, created_at, processing_status,
                    admin_verified, review_status, job_name, eff_slug, idx, record,
                    COUNT(*) OVER() AS total_count
             FROM typed
             WHERE ($3::text IS NULL
                    OR ($3 = 'untyped' AND eff_slug IS NULL)
                    OR ($3 <> 'untyped' AND eff_slug = $3))
               AND ($4::uuid IS NULL OR file_id = $4::uuid)
               AND ($2::text IS NULL OR filename ILIKE $2 OR record::text ILIKE $2)
             ORDER BY created_at DESC, file_id, idx
             LIMIT $5 OFFSET $6`,
            [itemIds, searchParam, slug || null, fileId || null, pageSize, offset],
        );

        // Full type distribution (independent of the active slug/file filter).
        // LEFT JOIN document_types to carry each type's configured identifier
        // dot-paths so the frontend can label record rows by the right field
        // (NULL for untyped / unconfigured types → frontend heuristic fallback).
        const slugRes = await client.query(
            `${RECORD_EXPAND_CTE}
             SELECT typed.eff_slug AS slug, COUNT(*)::int AS count,
                    dt.identifier_fields AS identifier_fields
             FROM typed
             LEFT JOIN document_types dt ON dt.slug = typed.eff_slug
             GROUP BY typed.eff_slug, dt.identifier_fields
             ORDER BY count DESC`,
            [itemIds],
        );

        const jobFiles = pageRes.rows.map((r) => ({
            id: r.record?.section_result_id || `${r.file_id}:${r.eff_slug ?? 'untyped'}:${r.idx}`,
            file_id: r.file_id,
            filename: r.filename,
            job_name: r.job_name,
            created_at: r.created_at,
            processing_status: r.processing_status,
            admin_verified: r.admin_verified,
            review_status: r.review_status,
            slug: r.eff_slug ?? null,
            section_result_id: r.record?.section_result_id ?? null,
            result: r.record,
        }));

        const total = pageRes.rows[0] ? parseInt(pageRes.rows[0].total_count, 10) : 0;
        const slugs = slugRes.rows.map((s) => ({
            slug: s.slug ?? null,
            count: s.count,
            identifier_fields: Array.isArray(s.identifier_fields) ? s.identifier_fields : null,
        }));

        return { jobFiles, total, page, pageSize, slugs };
    } finally {
        client.release();
    }
}

/**
 * All records of a given type across a preview's files — for the GIS CSV export.
 * Reuses RECORD_EXPAND_CTE (same V1/V2 + slug-filter semantics as the paginated
 * data endpoint) but drops pagination and selects only the record payload.
 *
 * Scoped to one preview's files (a bounded set), so the caller can stream the
 * CSV response row-by-row without an unbounded scan of the whole table.
 *
 * Each returned record is augmented with `_src_file` (source filename) and
 * `_file_id` (job_files id) so the GIS export can surface a path back to the
 * original document. The column builder treats these as internal and exposes
 * them explicitly as `src_file` / `file_id` (see gisCsvExport).
 *
 * @param {string[]} itemIds - the preview's job file ids
 * @param {string} slug - document type slug ('untyped' = the no-type bucket)
 * @returns {Promise<Array<Object>>} record objects, in stable display order
 */
export async function getAllRecordsForSlug(itemIds, slug) {
    if (!itemIds || itemIds.length === 0) return [];
    const client = await pool.connect();
    try {
        const res = await client.query(
            `${RECORD_EXPAND_CTE}
             SELECT record || jsonb_build_object('_src_file', filename, '_file_id', file_id) AS record
             FROM typed
             WHERE ($2::text IS NULL
                    OR ($2 = 'untyped' AND eff_slug IS NULL)
                    OR ($2 <> 'untyped' AND eff_slug = $2))
             ORDER BY created_at DESC, file_id, idx`,
            [itemIds, slug || null],
        );
        return res.rows.map((r) => r.record);
    } finally {
        client.release();
    }
}

/**
 * Per-file summary for the "by file" lens: each file with its record count,
 * a by-type breakdown ("34 well logs, 4 aquifer tests"), and review status.
 * V1 types are shape-inferred; unrecognized records fall under slug=null.
 */
export async function getFilesSummaryForPreview(
    itemIds,
    page = 1,
    pageSize = 20,
    searchTerm = null,
) {
    if (!itemIds || itemIds.length === 0) {
        return { files: [], total: 0, page, pageSize };
    }
    const client = await pool.connect();
    try {
        const offset = (page - 1) * pageSize;
        const searchParam = searchTerm && searchTerm.trim() ? `%${searchTerm.trim()}%` : null;
        const where = `WHERE jf.id = ANY($1) AND ($2::text IS NULL OR jf.filename ILIKE $2)`;

        // Paginate FILES in SQL; only the page's results are loaded + flattened.
        const countRes = await client.query(
            `SELECT COUNT(*)::int AS total FROM job_files jf ${where}`,
            [itemIds, searchParam],
        );
        const total = countRes.rows[0]?.total ?? 0;

        const res = await client.query(
            `SELECT jf.id, jf.filename, jf.created_at, jf.processing_status,
                    jf.admin_verified, jf.review_status, jf.result, j.name AS job_name
             FROM job_files jf
             JOIN jobs j ON jf.job_id = j.id
             ${where}
             ORDER BY jf.created_at DESC
             LIMIT $3 OFFSET $4`,
            [itemIds, searchParam, pageSize, offset],
        );

        const files = res.rows.map((f) => {
            const { records } = flattenRecords(f.result);
            const counts = new Map();
            let count = 0;
            for (const { slug: recSlug, record } of records) {
                if (!record || typeof record !== 'object') continue;
                count++;
                const eff = recSlug || inferSlugFromShape(record) || '__untyped__';
                counts.set(eff, (counts.get(eff) || 0) + 1);
            }
            const byType = [...counts.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([s, c]) => ({ slug: s === '__untyped__' ? null : s, count: c }));
            return {
                id: f.id,
                filename: f.filename,
                job_name: f.job_name,
                created_at: f.created_at,
                processing_status: f.processing_status,
                admin_verified: f.admin_verified,
                review_status: f.review_status,
                total_records: count,
                by_type: byType,
            };
        });

        return { files, total, page, pageSize };
    } finally {
        client.release();
    }
}

/**
 * Get available job files for adding to previews
 */
export async function getAvailableJobFiles(limit = 50) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT jf.id, jf.filename, jf.processing_status, jf.created_at,
                   j.name as job_name, j.id as job_id, jf.extraction_time_seconds, jf.ai_processing_time_seconds
            FROM job_files jf
            JOIN jobs j ON jf.job_id = j.id
            WHERE jf.processing_status = 'completed'
            AND jf.result IS NOT NULL
            ORDER BY jf.created_at DESC
            LIMIT $1
        `;

        const result = await client.query(query, [limit]);
        return result.rows;
    } finally {
        client.release();
    }
}

/**
 * Get previews that contain a specific file
 */
export async function getPreviewsForFile(fileId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT id, name, created_at
            FROM preview_data_table
            WHERE $1 = ANY(items_ids)
            ORDER BY created_at DESC
        `;

        const result = await client.query(query, [fileId]);
        return result.rows;
    } finally {
        client.release();
    }
}

/**
 * Check if a file is already in a specific preview
 */
export async function isFileInPreview(itemId, previewId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT EXISTS(
                SELECT 1 FROM preview_data_table 
                WHERE id = $1 AND $2 = ANY(items_ids)
            ) as exists
        `;

        const result = await client.query(query, [previewId, itemId]);
        return result.rows[0].exists;
    } finally {
        client.release();
    }
}

/**
 * Get summary statistics for all items in a preview (for QA stats calculation)
 * Returns counts without fetching full result data
 */
export async function getPreviewStatistics(itemIds) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE jf.admin_verified = true) as human_verified,
                COUNT(*) FILTER (WHERE jf.admin_verified = false AND jf.review_status = 'reviewed') as reviewed,
                COUNT(*) FILTER (WHERE jf.admin_verified = false AND jf.review_status = 'approved') as approved,
                COUNT(*) FILTER (WHERE jf.admin_verified = false AND jf.review_status = 'in_review') as in_review,
                COUNT(*) FILTER (WHERE jf.admin_verified = false AND jf.review_status = 'pending') as pending,
                COUNT(*) FILTER (WHERE jf.admin_verified = false AND jf.review_status = 'rejected') as rejected
            FROM job_files jf
            WHERE jf.id = ANY($1)
        `;

        const result = await client.query(query, [itemIds]);
        
        if (result.rows.length === 0) {
            return {
                total: 0,
                humanVerified: 0,
                reviewed: 0,
                approved: 0,
                inReview: 0,
                pending: 0,
                rejected: 0,
            };
        }

        const row = result.rows[0];
        const total = parseInt(row.total, 10);
        const humanVerified = parseInt(row.human_verified, 10);
        const reviewed = parseInt(row.reviewed, 10);
        const approved = parseInt(row.approved, 10);
        const inReview = parseInt(row.in_review, 10);
        const pending = parseInt(row.pending, 10);
        const rejected = parseInt(row.rejected, 10);

        // Calculate percentages and quality score
        const humanVerifiedPercentage = total > 0 
            ? Math.round((humanVerified / total) * 100) 
            : 0;

        // Quality score: Human Verified = 100%, Reviewed/Approved = 80%, In Review = 50%, Pending = 30%, Rejected = 0%
        const qualityScore = total > 0
            ? Math.round(
                (humanVerified * 100 +
                 (reviewed + approved) * 80 +
                 inReview * 50 +
                 pending * 30 +
                 rejected * 0) /
                total
            )
            : 0;

        return {
            total,
            humanVerified,
            reviewed,
            approved,
            inReview,
            pending,
            rejected,
            humanVerifiedPercentage,
            qualityScore,
            allVerified: humanVerified === total,
        };
    } finally {
        client.release();
    }
}
