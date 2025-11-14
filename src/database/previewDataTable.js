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
export async function isFileInPreview(fileId, previewId) {
    const client = await pool.connect();
    try {
        const query = `
            SELECT EXISTS(
                SELECT 1 FROM preview_data_table 
                WHERE id = $1 AND $2 = ANY(items_ids)
            ) as exists
        `;

        const result = await client.query(query, [previewId, fileId]);
        return result.rows[0].exists;
    } finally {
        client.release();
    }
}
