/**
 * Preview Data Table API Routes
 * Handles CRUD operations for preview data tables
 */

import express from 'express';
import pool from '../database.js';
import multer from 'multer';
import S3Service from '../s3Service.js';
import {
    createPreviewDataTable,
    getPreviewDataTables,
    getPreviewDataTableById,
    updatePreviewDataTable,
    deletePreviewDataTable,
    addItemsToPreview,
    removeItemsFromPreview,
    getJobFilesForPreview,
    getJobFilesForPreviewPaginated,
    getRecordsForPreviewPaginated,
    getFilesSummaryForPreview,
    getAvailableJobFiles,
    getPreviewsForFile,
    isFileInPreview,
    getPreviewStatistics
} from '../database/previewDataTable.js';
import mgsDataService from '../services/mgsDataService.js';
import { isV2Envelope, mapRecords, readField } from '../utils/resultEnvelope.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import {
    extractPreviewClientMeta,
    upsertPreviewSession,
    insertPreviewAnalyticsEvents,
    getPreviewAnalyticsReport,
} from '../database/previewAnalytics.js';

const router = express.Router();

// WebSocket instance will be set by the main server
let io = null;

export const setWebSocketInstance = (socketInstance) => {
    io = socketInstance;
};

// Configure multer for logo uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/svg+xml', 'image/gif'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only image files (JPEG, PNG, SVG, GIF) are allowed'), false);
        }
    }
});

const s3Service = new S3Service();

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
 * GET /previews/:id/statistics
 * Get summary statistics for all items in a preview (not paginated)
 */
router.get('/:id/statistics', async (req, res) => {
    try {
        const { id } = req.params;
        const preview = await getPreviewDataTableById(id);

        if (!preview) {
            return res.status(404).json({
                success: false,
                message: 'Preview not found'
            });
        }

        // Get statistics for all items
        const statistics = await getPreviewStatistics(preview.items_ids || []);

        res.json({
            success: true,
            data: statistics
        });
    } catch (error) {
        console.error('Error fetching preview statistics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch preview statistics',
            error: error.message
        });
    }
});

/**
 * GET /previews/:id/data
 * Get preview data with job files results (paginated)
 * Query params: page (default: 1), pageSize (default: 20), search (optional)
 */
router.get('/:id/data', async (req, res) => {
    try {
        const { id } = req.params;
        const { page = '1', pageSize = '20', search = null, slug = null, fileId = null } = req.query;

        const preview = await getPreviewDataTableById(id);

        if (!preview) {
            return res.status(404).json({
                success: false,
                message: 'Preview not found'
            });
        }

        // Parse pagination params
        const pageNum = parseInt(page, 10) || 1;
        const pageSizeNum = parseInt(pageSize, 10) || 20;
        
        // Validate pagination params
        if (pageNum < 1) {
            return res.status(400).json({
                success: false,
                message: 'Page must be greater than 0'
            });
        }
        if (pageSizeNum < 1 || pageSizeNum > 100) {
            return res.status(400).json({
                success: false,
                message: 'Page size must be between 1 and 100'
            });
        }

        // Get paginated data — one row per RECORD (V2-aware; V1 files = one record).
        const result = await getRecordsForPreviewPaginated(
            preview.items_ids || [],
            pageNum,
            pageSizeNum,
            search || null,
            slug || null,
            fileId || null
        );

        res.json({
            success: true,
            data: {
                preview,
                jobFiles: result.jobFiles,
                slugs: result.slugs,
                pagination: {
                    total: result.total,
                    page: result.page,
                    pageSize: result.pageSize,
                    totalPages: Math.ceil(result.total / result.pageSize)
                }
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
 * GET /previews/:id/files
 * "By file" lens: one row per file with a by-type record summary + review status.
 */
router.get('/:id/files', async (req, res) => {
    try {
        const { id } = req.params;
        const { page = '1', pageSize = '20', search = null } = req.query;

        const preview = await getPreviewDataTableById(id);
        if (!preview) {
            return res.status(404).json({ success: false, message: 'Preview not found' });
        }

        const pageNum = Math.max(parseInt(page, 10) || 1, 1);
        const pageSizeNum = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);

        const result = await getFilesSummaryForPreview(
            preview.items_ids || [],
            pageNum,
            pageSizeNum,
            search || null
        );

        res.json({
            success: true,
            data: {
                preview,
                files: result.files,
                pagination: {
                    total: result.total,
                    page: result.page,
                    pageSize: result.pageSize,
                    totalPages: Math.ceil(result.total / result.pageSize)
                }
            }
        });
    } catch (error) {
        console.error('Error fetching preview files:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch preview files',
            error: error.message
        });
    }
});

/**
 * POST /previews
 * Create a new preview data table
 */
router.post('/', upload.single('logo'), async (req, res) => {
    try {
        const { name, schema } = req.body;
        const logoFile = req.file;

        if (!name || !schema) {
            return res.status(400).json({
                success: false,
                message: 'Name and schema are required'
            });
        }

        let logoUrl = null;

        // Upload logo to S3 if provided
        if (logoFile) {
            try {
                logoUrl = await s3Service.uploadLogo(logoFile.buffer, logoFile.originalname);
            } catch (error) {
                console.error('Error uploading logo:', error);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload logo',
                    error: error.message
                });
            }
        }

        const preview = await createPreviewDataTable(name, schema, logoUrl);

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
router.put('/:id', upload.single('logo'), async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        const logoFile = req.file;

        // Upload logo to S3 if provided
        if (logoFile) {
            try {
                const logoUrl = await s3Service.uploadLogo(logoFile.buffer, logoFile.originalname);
                updates.logo = logoUrl;
            } catch (error) {
                console.error('Error uploading logo:', error);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload logo',
                    error: error.message
                });
            }
        }

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

        // Emit WebSocket event for preview update
        if (io) {
            // Get job IDs for the added files to emit to the correct rooms
            const client = await pool.connect();
            try {
                const jobQuery = `
                    SELECT DISTINCT job_id 
                    FROM job_files 
                    WHERE id = ANY($1)
                `;
                const jobResult = await client.query(jobQuery, [itemIds]);

                // Emit to all relevant job rooms
                jobResult.rows.forEach(row => {
                    io.to(`job-${row.job_id}`).emit('preview-updated', {
                        previewId: id,
                        previewName: preview.name,
                        addedFileIds: itemIds,
                        message: `Files added to preview "${preview.name}"`,
                        updated_at: new Date().toISOString()
                    });
                });
            } finally {
                client.release();
            }
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
            // Read permit_number from the first record (works for V1 flat and V2 envelope)
            const permitNumber = readField(fileResult, 'permit_number');
            if (!fileResult || !permitNumber) {
                return res.status(400).json({
                    success: false,
                    message: 'No permit number found in file result'
                });
            }

            // Extract MGS data using the permit number
            const mgsData = await mgsDataService.getMGSDataByPermitNumber(permitNumber);

            if (!mgsData) {
                return res.status(404).json({
                    success: false,
                    message: 'No MGS data found for this permit number'
                });
            }

            // Merge MGS data into every record (V1: one flat object, V2: each envelope entry)
            const updatedResult = mapRecords(fileResult, (record) =>
                mgsDataService.mergeMGSData(record, mgsData)
            );

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

// Bulk enrich multiple files with MGS data
router.post('/files/bulk/enrich-with-mgs', async (req, res) => {
    try {
        const { fileIds } = req.body;
        console.log('🔍 Bulk MGS enrichment request:', { fileIds, count: fileIds?.length });

        if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
            console.log('❌ Invalid fileIds:', fileIds);
            return res.status(400).json({
                success: false,
                message: 'File IDs array is required'
            });
        }

        const client = await pool.connect();

        try {
            const results = [];
            let successCount = 0;
            let errorCount = 0;

            for (const fileId of fileIds) {
                console.log(`🔄 Processing file ${fileId}...`);
                try {
                    // Get file result to extract permit number
                    const fileResultQuery = `
                        SELECT jf.result, jf.id, jf.filename
                        FROM job_files jf
                        WHERE jf.id = $1
                    `;
                    const fileResult = await client.query(fileResultQuery, [fileId]);

                    if (fileResult.rows.length === 0) {
                        console.log(`❌ File ${fileId} not found`);
                        results.push({
                            fileId: fileId,
                            success: false,
                            error: 'File not found'
                        });
                        errorCount++;
                        continue;
                    }

                    const fileData = fileResult.rows[0];
                    const resultData = fileData.result;
                    console.log(`📄 File ${fileId} result data:`, resultData ? 'exists' : 'null');

                    // Read permit_number from first record (V1 or V2)
                    const permitNum = readField(resultData, 'permit_number');
                    if (!resultData || !permitNum) {
                        console.log(`⚠️ File ${fileId} has no permit number, skipping MGS enrichment`);
                        results.push({
                            fileId: fileId,
                            filename: fileData.filename,
                            success: true,
                            skipped: true,
                            reason: 'No permit number found - skipped MGS enrichment'
                        });
                        successCount++;
                        continue;
                    }

                    console.log(`🔍 Looking up MGS data for permit: ${permitNum}`);
                    // Get MGS data
                    const mgsData = await mgsDataService.getMGSDataByPermitNumber(permitNum);

                    if (!mgsData) {
                        console.log(`⚠️ No MGS data found for permit: ${permitNum}, skipping`);
                        results.push({
                            fileId: fileId,
                            filename: fileData.filename,
                            success: true,
                            skipped: true,
                            reason: `No MGS data found for permit number: ${permitNum}`
                        });
                        successCount++;
                        continue;
                    }

                    console.log(`✅ Found MGS data for ${fileId}:`, Object.keys(mgsData));
                    // Merge MGS data into every record (V1 or V2)
                    const updatedResult = mapRecords(resultData, (record) =>
                        mgsDataService.mergeMGSData(record, mgsData)
                    );

                    // Update the file result
                    const updateQuery = `
                        UPDATE job_files 
                        SET result = $1, updated_at = NOW()
                        WHERE id = $2
                        RETURNING id, filename
                    `;
                    const updateResult = await client.query(updateQuery, [JSON.stringify(updatedResult), fileId]);

                    results.push({
                        fileId: fileId,
                        filename: updateResult.rows[0].filename,
                        success: true,
                        mgsData: mgsData
                    });
                    successCount++;
                    console.log(`✅ Successfully updated file ${fileId}`);

                } catch (fileError) {
                    console.error(`❌ Error processing file ${fileId}:`, fileError);
                    results.push({
                        fileId: fileId,
                        success: false,
                        error: fileError.message
                    });
                    errorCount++;
                }
            }

            console.log(`📊 Bulk MGS enrichment complete: ${successCount} successful, ${errorCount} failed`);
            res.json({
                success: true,
                message: `Processed ${fileIds.length} files: ${successCount} successful, ${errorCount} failed`,
                results: results,
                summary: {
                    total: fileIds.length,
                    successful: successCount,
                    failed: errorCount,
                    skipped: results.filter(r => r.skipped).length
                }
            });

        } finally {
            client.release();
        }
    } catch (error) {
        console.error('❌ Error in bulk MGS enrichment:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to enrich files with MGS data',
            error: error.message
        });
    }
});

/**
 * POST /previews/:id/analytics/events
 * Public — record preview visitor activity (no auth on preview links).
 */
router.post('/:id/analytics/events', async (req, res) => {
    try {
        const { id: previewId } = req.params;
        const { clientSessionId, events } = req.body || {};

        if (!clientSessionId || typeof clientSessionId !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'clientSessionId is required',
            });
        }

        if (!Array.isArray(events) || events.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'events must be a non-empty array',
            });
        }

        if (events.length > 25) {
            return res.status(400).json({
                success: false,
                message: 'Maximum 25 events per request',
            });
        }

        const preview = await getPreviewDataTableById(previewId);
        if (!preview) {
            return res.status(404).json({
                success: false,
                message: 'Preview not found',
            });
        }

        const meta = extractPreviewClientMeta(req);
        const sessionId = await upsertPreviewSession(
            previewId,
            clientSessionId.slice(0, 64),
            meta,
        );

        const inserted = await insertPreviewAnalyticsEvents({
            previewId,
            sessionId,
            events,
        });

        res.status(201).json({
            success: true,
            data: { sessionId, inserted },
        });
    } catch (error) {
        console.error('Error recording preview analytics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to record analytics',
            error: error.message,
        });
    }
});

/**
 * GET /previews/:id/analytics
 * Admin — monitoring dashboard data for a preview link.
 */
router.get(
    '/:id/analytics',
    authenticateToken,
    requireRole('admin'),
    async (req, res) => {
        try {
            const { id: previewId } = req.params;
            const preview = await getPreviewDataTableById(previewId);

            if (!preview) {
                return res.status(404).json({
                    success: false,
                    message: 'Preview not found',
                });
            }

            const report = await getPreviewAnalyticsReport(previewId, {
                days: req.query.days,
                sessionLimit: req.query.sessionLimit,
                eventLimit: req.query.eventLimit,
            });

            res.json({
                success: true,
                data: {
                    preview: {
                        id: preview.id,
                        name: preview.name,
                    },
                    ...report,
                },
            });
        } catch (error) {
            console.error('Error fetching preview analytics:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch preview analytics',
                error: error.message,
            });
        }
    },
);

export default router;
