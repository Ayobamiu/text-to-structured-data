/**
 * Preview Data Table API Routes
 * Handles CRUD operations for preview data tables
 */

import express from 'express';
import {
    createPreviewDataTable,
    getPreviewDataTables,
    getPreviewDataTableById,
    updatePreviewDataTable,
    deletePreviewDataTable,
    addItemsToPreview,
    removeItemsFromPreview,
    getJobFilesForPreview,
    getAvailableJobFiles
} from '../database/previewDataTable.js';

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

export default router;
