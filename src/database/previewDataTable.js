/**
 * Preview Data Table Database Functions
 * Handles CRUD operations for preview_data_table
 */

import pool from '../database.js';

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
