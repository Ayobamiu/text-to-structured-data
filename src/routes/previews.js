/**
 * Preview Data Table API Routes
 * Handles CRUD operations for preview data tables
 */

import express from 'express';
import pool from '../database.js';
import {
    createPreviewDataTable,
    getPreviewDataTables,
    getPreviewDataTableById,
    updatePreviewDataTable,
    deletePreviewDataTable,
    addItemsToPreview,
    removeItemsFromPreview,
    getJobFilesForPreview,
    getAvailableJobFiles,
    getPreviewsForFile,
    isFileInPreview
} from '../database/previewDataTable.js';
import mgsDataService from '../services/mgsDataService.js';

const router = express.Router();

/**
 * GET /previews
 * Get all preview data tables
 */
router.get('/', async (req, res) => {
    try {
        const previews = await getPreviewDataTables();

        res.json({
            success: true,
            data: previews
        });
    } catch (error) {
        console.error('Error fetching previews:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch previews',
            error: error.message
        });
    }
});

/**
 * GET /previews/:id
 * Get a specific preview data table by ID
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const preview = await getPreviewDataTableById(id);

        if (!preview) {
            return res.status(404).json({
                success: false,
                message: 'Preview not found'
            });
        }

        res.json({
            success: true,
            data: preview
        });
    } catch (error) {
        console.error('Error fetching preview:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch preview',
            error: error.message
        });
    }
});

/**
 * GET /previews/:id/data
 * Get preview data with job files results
 */
router.get('/:id/data', async (req, res) => {
    try {
        const { id } = req.params;
        const preview = await getPreviewDataTableById(id);

        if (!preview) {
            return res.status(404).json({
                success: false,
                message: 'Preview not found'
            });
        }

        // Get job files data
        const jobFiles = await getJobFilesForPreview(preview.items_ids);

        res.json({
            success: true,
            data: {
                preview,
                jobFiles
            }
        });
    } catch (error) {
        console.error('Error fetching preview data:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch preview data',
            error: error.message
        });
    }
});

/**
 * POST /previews
 * Create a new preview data table
 */
router.post('/', async (req, res) => {
    try {
        const { name, schema } = req.body;

        if (!name || !schema) {
            return res.status(400).json({
                success: false,
                message: 'Name and schema are required'
            });
        }

        const preview = await createPreviewDataTable(name, schema);

        res.status(201).json({
            success: true,
            data: preview
        });
    } catch (error) {
        console.error('Error creating preview:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create preview',
            error: error.message
        });
    }
});

/**
 * PUT /previews/:id
 * Update a preview data table
 */
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const preview = await updatePreviewDataTable(id, updates);

        if (!preview) {
            return res.status(404).json({
                success: false,
                message: 'Preview not found'
            });
        }

        res.json({
            success: true,
            data: preview
        });
    } catch (error) {
        console.error('Error updating preview:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update preview',
            error: error.message
        });
    }
});

/**
 * DELETE /previews/:id
 * Delete a preview data table
 */
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const preview = await deletePreviewDataTable(id);

        if (!preview) {
            return res.status(404).json({
                success: false,
                message: 'Preview not found'
            });
        }

        res.json({
            success: true,
            message: 'Preview deleted successfully',
            data: preview
        });
    } catch (error) {
        console.error('Error deleting preview:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete preview',
            error: error.message
        });
    }
});

/**
 * POST /previews/:id/items
 * Add items to a preview data table
 */
router.post('/:id/items', async (req, res) => {
    try {
        const { id } = req.params;
        const { itemIds } = req.body;

        if (!itemIds || !Array.isArray(itemIds)) {
            return res.status(400).json({
                success: false,
                message: 'itemIds must be an array'
            });
        }

        const preview = await addItemsToPreview(id, itemIds);

        if (!preview) {
            return res.status(404).json({
                success: false,
                message: 'Preview not found'
            });
        }

        res.json({
            success: true,
            data: preview
        });
    } catch (error) {
        console.error('Error adding items to preview:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add items to preview',
            error: error.message
        });
    }
});

/**
 * DELETE /previews/:id/items/:itemId
 * Remove an item from a preview data table
 */
router.delete('/:id/items/:itemId', async (req, res) => {
    try {
        const { id, itemId } = req.params;

        const preview = await removeItemsFromPreview(id, itemId);

        if (!preview) {
            return res.status(404).json({
                success: false,
                message: 'Preview not found'
            });
        }

        res.json({
            success: true,
            data: preview
        });
    } catch (error) {
        console.error('Error removing item from preview:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove item from preview',
            error: error.message
        });
    }
});

/**
 * GET /previews/available-files
 * Get available job files for adding to previews
 */
router.get('/available-files', async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        const jobFiles = await getAvailableJobFiles(parseInt(limit));

        res.json({
            success: true,
            data: jobFiles
        });
    } catch (error) {
        console.error('Error fetching available files:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch available files',
            error: error.message
        });
    }
});

/**
 * GET /previews/file/:fileId
 * Get previews that contain a specific file
 */
router.get('/file/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;
        const previews = await getPreviewsForFile(fileId);

        res.json({
            success: true,
            data: previews
        });
    } catch (error) {
        console.error('Error fetching previews for file:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch previews for file',
            error: error.message
        });
    }
});

/**
 * GET /previews/:previewId/contains/:fileId
 * Check if a file is already in a specific preview
 */
router.get('/:previewId/contains/:fileId', async (req, res) => {
    try {
        const { previewId, fileId } = req.params;
        const exists = await isFileInPreview(fileId, previewId);

        res.json({
            success: true,
            data: { exists }
        });
    } catch (error) {
        console.error('Error checking if file is in preview:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check file in preview',
            error: error.message
        });
    }
});

/**
 * GET /previews/file/:fileId/schema
 * Get the schema from a file's job
 */
router.get('/file/:fileId/schema', async (req, res) => {
    try {
        const { fileId } = req.params;

        // Get the file and its job to extract the schema
        const client = await pool.connect();
        try {
            const query = `
                SELECT j.schema_data
                FROM job_files jf
                JOIN jobs j ON jf.job_id = j.id
                WHERE jf.id = $1
            `;

            const result = await client.query(query, [fileId]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'File not found'
                });
            }

            const { schema_data } = result.rows[0];

            res.json({
                success: true,
                data: {
                    schema: schema_data,
                    schemaName: 'Extracted Schema' // Default name since schema_name doesn't exist
                }
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error fetching file schema:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch file schema',
            error: error.message
        });
    }
});

/**
 * POST /previews/file/:fileId/enrich-with-mgs
 * Extract MGS data and update the file's result in one call
 */
router.post('/file/:fileId/enrich-with-mgs', async (req, res) => {
    try {
        const { fileId } = req.params;

        // Get the file's result data to extract permit number
        const client = await pool.connect();
        try {
            const query = `
                SELECT result
                FROM job_files
                WHERE id = $1
            `;

            const result = await client.query(query, [fileId]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'File not found'
                });
            }

            const { result: fileResult } = result.rows[0];

            console.log('fileResult', fileResult);
            if (!fileResult || !fileResult.permit_number) {
                return res.status(400).json({
                    success: false,
                    message: 'No permit number found in file result'
                });
            }

            // Extract MGS data using the permit number
            const mgsData = await mgsDataService.getMGSDataByPermitNumber(fileResult.permit_number);

            if (!mgsData) {
                return res.status(404).json({
                    success: false,
                    message: 'No MGS data found for this permit number'
                });
            }

            // Merge MGS data into the existing result
            const updatedResult = {
                ...fileResult,
                ...mgsData
            };

            // Update the file with merged data
            const updateQuery = `
                UPDATE job_files
                SET result = $1
                WHERE id = $2
                RETURNING id
            `;

            const updateResult = await client.query(updateQuery, [
                JSON.stringify(updatedResult),
                fileId
            ]);

            if (updateResult.rows.length === 0) {
                return res.status(500).json({
                    success: false,
                    message: 'Failed to update file with MGS data'
                });
            }

            res.json({
                success: true,
                data: {
                    fileId: updateResult.rows[0].id,
                    mgsData: mgsData,
                    message: 'File successfully enriched with MGS data'
                }
            });

        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error enriching file with MGS data:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to enrich file with MGS data',
            error: error.message
        });
    }
});

export default router;
