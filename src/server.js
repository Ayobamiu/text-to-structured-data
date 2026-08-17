import express from "express";
import multer from "multer";
import axios from "axios";
import OpenAI from "openai";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import S3Service from "./s3Service.js";
import pool, {
    testConnection,
    createJob,
    addFileToJob,
    getJobStatus,
    getJobDetailsWithSummary,
    getJobOrganizationId,
    updateFileExtractionStatus,
    updateFileProcessingStatus,
    updateJobStatus,
    updateJobConfig,
    listJobs,
    getJobFileStats,
    getJobFilesByStatus,
    listJobsByOrganizations,
    getFileResult,
    getSystemStats,
    updateFileUploadStatus,
    updateFileS3Info,
    getAllFiles,
    updateFileVerification,
    updateFileReviewStatus,
    bulkUpdateFileReviewStatus,
    bulkUpdateFileVerification,
    updateFileDetectedSections,
    userHasJobAccess,
    getFileSkinnyRow,
} from "./database.js";
import { getUserById } from "./database/users.js";
import { getUserOrganizations } from "./database/userOrganizationMemberships.js";
import { getUserOrganizationIds, getUserFirstOrganizationId, requireUserFirstOrganizationId } from "./utils/organizationHelpers.js";
import { checkJobAccess, checkFileAccess } from "./utils/accessControl.js";
import { initializeDatabase } from "./database/init.js";
import queueService from "./queue.js";
import authRoutes from "./routes/auth.js";
import organizationRoutes from "./routes/organizations.js";
import previewRoutes, { setWebSocketInstance } from "./routes/previews.js";
import demoRoutes from "./routes/demo.js";
import { applyServicesToPreview } from "./services/postProcessing/applyToFiles.ts";
import { getService, listServices } from "./services/postProcessing/index.ts";
import mgsRoutes from "./routes/mgs.js";
import healthRoutes from "./routes/health.js";
import { authenticateToken, optionalAuth, securityHeaders, requireRole } from "./middleware/auth.js";
import { rateLimitConfig } from "./auth.js";
import logger from "./utils/logger.js";
import { processWithOpenAI } from "./utils/openaiProcessor.js";
import ExtractionService from "./services/extractionService.js";
import {
    resolveSectionIndex,
    sliceSectionMarkdown,
} from "./services/sectionReprocessService.js";
import {
    runSectionReextraction,
    enqueueSectionReextraction,
    computePendingSectionIndices,
    recomputeFileReviewStatus,
    cleanupOrphanSectionRows,
    TEXT_REEXTRACT_FLAG,
    withSreexRun,
} from "./services/sectionReextractService.ts";
import groqService from "./services/groqService.js";
import { recordCorrections } from "./services/correctionsService.js";
import { getPdfPageCount } from "./utils/pdfUtils.js";
import { computeFlags } from "./services/constraintsService.js";
import { decrementTotal } from "./database/jobFileStats.js";
import {
    PROCESSING_METHODS,
    DEFAULT_MODELS,
    ALL_PROCESSING_METHODS,
    isValidModel,
    getModelsForMethod,
    getDefaultModel
} from "./config/processingConfig.js";
import dns from 'dns';
// Set default result order to IPv4 first to avoid Railway IPv6 issues
dns.setDefaultResultOrder('ipv4first');

dotenv.config();

// CORS / Socket.IO allowed origins (extend with CORS_ORIGINS=comma,separated,urls)
// If the API is down (e.g. 502 from Railway), the edge response often has no CORS headers;
// the browser then reports "blocked by CORS" even though the real issue is the gateway error.
const corsOrigins = [
    'http://localhost:3001',
    'http://localhost:3002',
    'http://localhost:8080',
    'https://workspace.coreextract.app',
    'https://coreextract.app',
    'https://www.coreextract.app',
    ...(process.env.CORS_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
];

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: corsOrigins,
        methods: ['GET', 'POST'],
        credentials: true
    }
});

// Set WebSocket instance for preview routes
setWebSocketInstance(io);

// Behind Railway / reverse proxy: trust first proxy so req.ip resolves correctly
app.set('trust proxy', 1);

// CORS configuration (must be before security middleware)
app.use(cors({
    origin: corsOrigins,
    credentials: true,
    // PATCH required for registry admin (document type updates) from browser preflight.
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 200 // Some legacy browsers (IE11, various SmartTVs) choke on 204
}));

// Security middleware
app.use(helmet());
app.use(securityHeaders);
// app.use(rateLimit(rateLimitConfig));

const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Flask service URL
const PADDLEOCR_FLASK_URL = process.env.PADDLEOCR_FLASK_URL || "http://localhost:5002";

// Initialize S3 service
const s3Service = new S3Service();

// Initialize extraction service
const extractionService = new ExtractionService(s3Service);

// Authentication routes
app.use('/auth', express.json());
app.use('/auth', authRoutes);

// Organization routes
app.use('/organizations', express.json());
app.use('/organizations', organizationRoutes);

// Preview routes
app.use('/previews', express.json());
app.use('/previews', previewRoutes);

// Public self-serve demo (no JWT). JSON is applied inside the router after
// the multipart upload route so multer can read the body first.
app.use('/demo', demoRoutes);

app.use('/mgs', express.json());
app.use('/mgs', authenticateToken, mgsRoutes);

// Health check routes (no auth required)
app.use('/', healthRoutes);

// Socket.IO connection handling
io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);

    // Join job room for real-time updates
    socket.on('join-job', (jobId) => {
        socket.join(`job-${jobId}`);
        logger.info(`Client ${socket.id} joined job room: job-${jobId}`);
    });

    // Leave job room
    socket.on('leave-job', (jobId) => {
        socket.leave(`job-${jobId}`);
        logger.info(`Client ${socket.id} left job room: job-${jobId}`);
    });

    socket.on('disconnect', () => {
        logger.info(`Client disconnected: ${socket.id}`);
    });

    // Handle events from worker process — convert to standardized patch format
    socket.on('file-status-update', (data) => {
        logger.info(`Received file-status-update from worker:`, data);
        const { jobId, fileId, message, timestamp, error, ...patch } = data;
        // Include message in the patch so the client can display live notifications
        if (message) patch._message = message;

        // Terminal status (completed/failed): emit full skinny row so the client
        // gets flags, model, has_result, previews — everything that changed.
        const isTerminal = patch.processing_status === 'completed' || patch.processing_status === 'failed';
        if (isTerminal) {
            emitFileFullPatch(jobId, fileId, { ...patch, has_result: patch.processing_status === 'completed' });
        } else {
            emitFilePatch(jobId, fileId, patch);
        }
        logger.info(`Broadcasted file-status-update to job-${jobId}`);
    });

    socket.on('job-status-update', (data) => {
        logger.info(`Received job-status-update from worker:`, data);
        // Broadcast to all clients in the job room
        io.to(`job-${data.jobId}`).emit('job-status-update', data);
        logger.info(`Broadcasted job-status-update to job-${data.jobId}`);
    });

    // Curated processing-timeline events from the worker → relay to the job room.
    socket.on('file-processing-event', (data) => {
        if (!data?.jobId) return;
        io.to(`job-${data.jobId}`).emit('file-processing-event', data);
    });

    // QA job progress from the worker → relay to the job room.
    socket.on('qa-progress-event', (data) => {
        if (!data?.jobId) return;
        io.to(`job-${data.jobId}`).emit('qa-progress-event', data);
    });

    // Directed re-extraction progress from the worker → relay to the job room.
    socket.on('reextract-progress-event', (data) => {
        if (!data?.jobId) return;
        io.to(`job-${data.jobId}`).emit('reextract-progress-event', data);
    });

    // Section re-extraction (Save & Re-extract `sreex` jobs) progress from
    // the worker → relay to the job room.
    socket.on('section-reextract-progress-event', (data) => {
        if (!data?.jobId) return;
        io.to(`job-${data.jobId}`).emit('section-reextract-progress-event', data);
    });

    // Post-processing backfill (`psvc:<requestId>` jobs) progress from the
    // worker → relay to the job room.
    socket.on('postprocess-progress-event', (data) => {
        if (!data?.jobId) return;
        io.to(`job-${data.jobId}`).emit('postprocess-progress-event', data);
    });
});


/**
 * Phase 2: Standardized file-status-update emitter.
 * Every emit now uses this helper so the client receives a consistent shape:
 *   { jobId, fileId, patch: { ...changedColumns }, version: ISO string }
 *
 * `patch` contains only the columns that actually changed — the client
 * merges them into its local row without refetching.
 */
function emitFilePatch(jobId, fileId, patch) {
    const version = new Date().toISOString();
    io.to(`job-${jobId}`).emit('file-status-update', {
        jobId,
        fileId,
        patch,
        version,
    });
}

/**
 * Emit a *complete* skinny-row patch after a terminal status change
 * (completed / failed). Re-reads the row from DB so the client gets
 * every derived field (flags, has_result, model, previews, etc.)
 * without needing a full page refresh.
 *
 * Falls back to a minimal patch if the DB read fails.
 */
async function emitFileFullPatch(jobId, fileId, fallbackPatch = {}) {
    try {
        const row = await getFileSkinnyRow(fileId);
        if (row) {
            // Remove heavy/redundant fields the client already has
            const { id, job_id, job_name, job_extraction_mode, ...patch } = row;
            emitFilePatch(jobId, fileId, patch);
        } else {
            emitFilePatch(jobId, fileId, fallbackPatch);
        }
    } catch (err) {
        console.warn(`⚠️ emitFileFullPatch failed for ${fileId}:`, err.message);
        emitFilePatch(jobId, fileId, fallbackPatch);
    }
}

// Apply JSON parsing only to specific routes (not multipart routes)
app.use('/jobs', express.json());
app.use('/queue', express.json());
app.use('/registry', express.json());
app.use('/system-stats', express.json());
app.use('/test-db', express.json());
app.use('/test-redis', express.json());
app.use('/test-s3', express.json());
app.use('/storage-stats', express.json());
// 2mb: section edits (POST /files/:id/sections/save-and-reextract) send the
// edited `sections` array, which exceeds the 100kb default on large files
// (hundreds of sections). The full detected_sections metadata is no longer
// round-tripped (server merges sections in), so this stays well-bounded.
// Result-data edits use the per-record PATCH endpoint and stay small.
app.use('/files', express.json({ limit: '2mb' }));

// Health check
app.get("/health", (req, res) => {
    res.json({ status: "healthy", service: "ai-extractor" });
});

// S3 connection test
app.get("/test-s3", async (req, res) => {
    try {
        const connection = await s3Service.testConnection();
        const stats = await s3Service.getStorageStats();

        res.json({
            status: "success",
            s3: connection,
            storage_stats: stats
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// S3 storage statistics
app.get("/storage-stats", async (req, res) => {
    try {
        const stats = await s3Service.getStorageStats();
        res.json({
            status: "success",
            storage: stats
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Database connection test
app.get("/test-db", async (req, res) => {
    try {
        const result = await testConnection();
        res.json({
            status: "success",
            database: result
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Queue database connection test (legacy endpoint name)
app.get("/test-redis", async (req, res) => {
    try {
        const result = await queueService.testConnection();
        res.json({
            status: "success",
            redis: {
                connected: result,
                message: result ? "Queue database connection successful" : "Queue database connection failed"
            }
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Queue statistics
app.get("/queue-stats", async (req, res) => {
    try {
        const stats = await queueService.getQueueStats();
        res.json({
            status: "success",
            queue: stats
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Queue analytics endpoint
app.get("/queue-analytics", async (req, res) => {
    try {
        const analytics = await queueService.getQueueAnalytics();
        res.json({
            status: "success",
            analytics
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Pause queue endpoint
app.post("/queue/pause", async (req, res) => {
    try {
        await queueService.pauseQueue();
        res.json({
            status: "success",
            message: "Queue paused"
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Resume queue endpoint
app.post("/queue/resume", async (req, res) => {
    try {
        await queueService.resumeQueue();
        res.json({
            status: "success",
            message: "Queue resumed"
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Clear queue endpoint
app.post("/queue/clear", async (req, res) => {
    try {
        await queueService.clearQueue();
        res.json({
            status: "success",
            message: "Queue cleared"
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Remove specific file from queue
app.delete("/queue/files/:fileId", async (req, res) => {
    try {
        const { fileId } = req.params;
        await queueService.removeFileFromQueue(fileId);

        // Also remove from processing state if it's stuck there
        try {
            await queueService.removeFileFromProcessing(fileId);
            console.log(`✅ File ${fileId} removed from processing state`);
        } catch (processingError) {
            console.warn(`⚠️ Could not remove file ${fileId} from processing state: ${processingError.message}`);
        }

        res.json({
            status: "success",
            message: `File ${fileId} removed from queue and processing state`
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Clear all stuck processing files
app.post("/queue/clear-processing", async (req, res) => {
    try {
        const clearedCount = await queueService.clearAllProcessingFiles();
        res.json({
            status: "success",
            message: `Cleared ${clearedCount} stuck processing files`,
            clearedCount
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Add specific file to queue
app.post("/queue/files/:fileId", async (req, res) => {
    try {
        const { fileId } = req.params;
        const { priority = 0 } = req.body;

        // Validate file exists and get its details
        const file = await getFileResult(fileId);
        if (!file) {
            return res.status(404).json({
                status: "error",
                message: `File ${fileId} not found`
            });
        }

        // Check if file is already completed
        if (file.processing_status === 'completed') {
            return res.status(400).json({
                status: "error",
                message: `File ${fileId} is already completed and cannot be re-queued`
            });
        }

        // Check if file is already in queue
        const isInQueue = await queueService.isFileInQueue(fileId);

        if (isInQueue) {
            return res.status(400).json({
                status: "error",
                message: `File ${fileId} is already in the queue`
            });
        }

        // Add file to queue
        await queueService.addFileToQueue(fileId, file.job_id, priority);

        res.json({
            status: "success",
            message: `File ${fileId} added to queue with priority ${priority}`,
            file: {
                id: fileId,
                filename: file.filename,
                jobId: file.job_id,
                priority: priority
            }
        });
    } catch (error) {
        console.error('❌ Error adding file to queue:', error);
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Get queue status (paused/resumed)
app.get("/queue/status", async (req, res) => {
    try {
        const isPaused = await queueService.isQueuePaused();
        res.json({
            status: "success",
            queueStatus: {
                paused: isPaused,
                status: isPaused ? "paused" : "running"
            }
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// System statistics
app.get("/system-stats", async (req, res) => {
    try {
        const stats = await getSystemStats();
        res.json({
            status: "success",
            statistics: stats
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// ── Section monitoring ─────────────────────────────────────────────────
// Returns per-section extraction stats for the monitoring UI: large
// sections, truncation events, token estimates. Queries extraction_metadata
// JSONB so no schema migration is needed.
app.get("/monitoring/sections", authenticateToken, async (req, res) => {
    try {
        const { limit = 200, jobId } = req.query;
        const organizationIds = await getUserOrganizationIds(req.user);
        if (organizationIds.length === 0) {
            return res.json({ status: "success", sections: [], summary: {} });
        }

        const client = await pool.connect();
        try {
            const orgPlaceholders = organizationIds.map((_, i) => `$${i + 1}`).join(',');
            const params = [...organizationIds];
            let jobFilter = '';
            if (jobId) {
                params.push(jobId);
                jobFilter = `AND jf.job_id = $${params.length}`;
            }
            params.push(parseInt(limit));

            // Extract section_results array elements with their parent file context
            const query = `
                SELECT
                    jf.id as file_id,
                    jf.filename,
                    jf.job_id,
                    j.name as job_name,
                    jf.page_count,
                    sr->>'slug' as slug,
                    sr->>'record_id' as record_id,
                    sr->'page_range' as page_range,
                    sr->'extraction_pages' as extraction_pages,
                    sr->>'status' as status,
                    sr->>'error' as error,
                    (sr->>'duration_ms')::int as duration_ms,
                    (sr->>'estimated_input_tokens')::int as estimated_input_tokens,
                    (sr->>'content_length')::int as content_length,
                    COALESCE((sr->>'large_section')::boolean, false) as large_section,
                    COALESCE((sr->>'response_truncated')::boolean, false) as response_truncated,
                    jsonb_array_length(sr->'extraction_pages') as section_page_count,
                    jf.created_at
                FROM job_files jf
                JOIN jobs j ON jf.job_id = j.id
                CROSS JOIN LATERAL jsonb_array_elements(jf.extraction_metadata->'section_results') sr
                WHERE j.organization_id IN (${orgPlaceholders})
                ${jobFilter}
                AND jf.extraction_metadata->'section_results' IS NOT NULL
                ORDER BY
                    COALESCE((sr->>'large_section')::boolean, false) DESC,
                    COALESCE((sr->>'response_truncated')::boolean, false) DESC,
                    (sr->>'estimated_input_tokens')::int DESC NULLS LAST,
                    jf.created_at DESC
                LIMIT $${params.length}
            `;

            const result = await client.query(query, params);

            // Build summary stats
            const sections = result.rows;
            const totalSections = sections.length;
            const largeSections = sections.filter(s => s.large_section).length;
            const truncated = sections.filter(s => s.response_truncated).length;
            const failed = sections.filter(s => s.status === 'failed').length;
            const avgTokens = totalSections > 0
                ? Math.round(sections.reduce((sum, s) => sum + (s.estimated_input_tokens || 0), 0) / totalSections)
                : 0;
            const maxTokens = Math.max(0, ...sections.map(s => s.estimated_input_tokens || 0));

            res.json({
                status: "success",
                sections,
                summary: {
                    total_sections: totalSections,
                    large_sections: largeSections,
                    truncated,
                    failed,
                    avg_estimated_tokens: avgTokens,
                    max_estimated_tokens: maxTokens,
                },
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('❌ Section monitoring error:', error.message);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// List jobs
app.get("/jobs", authenticateToken, async (req, res) => {
    try {
        const { limit = 10, offset = 0 } = req.query;

        // Get user's organization IDs (with JWT optimization)
        const organizationIds = await getUserOrganizationIds(req.user);
        console.log({ organizationIds });
        if (organizationIds.length === 0) {
            return res.json({
                status: "success",
                jobs: []
            });
        }

        // Get jobs for all organizations the user belongs to (any role: owner, admin, member, viewer)
        const jobs = await listJobsByOrganizations(
            parseInt(limit),
            parseInt(offset),
            organizationIds
        );
        res.json({
            status: "success",
            jobs
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Get job details with summary (ultra-lightweight - no files, combined response)
app.get("/jobs/:id/details", authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        // Check if user has access to this job
        const hasAccess = await checkJobAccess(id, req.user, res);
        if (!hasAccess) {
            return; // Error response already sent by checkJobAccess
        }

        // Fetch both job details and summary in a single database connection
        const result = await getJobDetailsWithSummary(id);

        if (!result.job) {
            return res.status(404).json({
                status: "error",
                message: "Job not found"
            });
        }

        res.json({
            status: "success",
            job: result.job,
            summary: result.summary
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

app.get("/jobs/:id", authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        // Check if user has access to this job
        const hasAccess = await checkJobAccess(id, req.user, res);
        if (!hasAccess) {
            return; // Error response already sent by checkJobAccess
        }

        const job = await getJobStatus(id, false); // Use lightweight by default

        if (!job) {
            return res.status(404).json({
                status: "error",
                message: "Job not found"
            });
        }

        res.json({
            status: "success",
            job
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Update job schema
app.put("/jobs/:id/schema", authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { schema } = req.body;

        // Validate schema is valid JSON
        if (!schema || typeof schema !== 'object') {
            return res.status(400).json({
                status: "error",
                message: "Invalid schema format"
            });
        }

        // Check if user has access to this job
        const hasAccess = await checkJobAccess(id, req.user, res);
        if (!hasAccess) {
            return; // Error response already sent by checkJobAccess
        }

        // Get job to ensure it exists
        const job = await getJobStatus(id);
        if (!job) {
            return res.status(404).json({
                status: "error",
                message: "Job not found"
            });
        }

        // Update schema in database
        const client = await pool.connect();
        try {
            // Preserve the original structure with schemaName
            const existingJob = await getJobStatus(id);
            const newSchemaData = {
                schema: schema,
                schemaName: existingJob.schema_data?.schemaName || 'data_extraction'
            };

            // Add new schema version to schema_data_array and update schema_data
            // Get existing schema_data_array or initialize as empty array
            const existingSchemaArray = existingJob.schema_data_array || [];

            // Check if this schema is different from the current one
            const currentSchemaStr = JSON.stringify(existingJob.schema_data);
            const newSchemaStr = JSON.stringify(newSchemaData);

            let updatedSchemaArray = [...existingSchemaArray];

            // Only add to history if it's different from current
            if (currentSchemaStr !== newSchemaStr) {
                // Add new version to the array
                updatedSchemaArray.push(newSchemaData);
            }

            const updateQuery = `
                UPDATE jobs 
                SET schema_data = $1, 
                    schema_data_array = $2,
                    updated_at = NOW()
                WHERE id = $3
                RETURNING id, schema_data, schema_data_array
            `;

            const result = await client.query(updateQuery, [
                JSON.stringify(newSchemaData),
                JSON.stringify(updatedSchemaArray),
                id
            ]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    status: "error",
                    message: "Job not found"
                });
            }

            res.json({
                status: "success",
                message: "Schema updated successfully",
                data: {
                    jobId: result.rows[0].id,
                    schema: result.rows[0].schema_data,
                    schema_data_array: result.rows[0].schema_data_array
                }
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error updating job schema:', error);
        res.status(500).json({
            status: "error",
            message: "Failed to update schema",
            error: error.message
        });
    }
});

// Update job configuration endpoint
app.put("/jobs/:id/config", authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        let { name, extraction_mode, processing_config } = req.body;

        // Parse processing_config if it's a string
        if (processing_config !== undefined && typeof processing_config === 'string') {
            try {
                processing_config = JSON.parse(processing_config);
            } catch (parseError) {
                return res.status(400).json({
                    status: "error",
                    message: "Invalid processing_config JSON string",
                    error: parseError.message
                });
            }
        }

        console.log({ name, extraction_mode, processing_config });

        // Validate input - at least one field must be provided
        if (name === undefined && extraction_mode === undefined && processing_config === undefined) {
            return res.status(400).json({
                status: "error",
                message: "At least one field (name, extraction_mode, or processing_config) must be provided"
            });
        }

        // Validate extraction_mode if provided
        if (extraction_mode !== undefined && !['full_extraction', 'text_only'].includes(extraction_mode)) {
            return res.status(400).json({
                status: "error",
                message: "Invalid extraction_mode. Must be 'full_extraction' or 'text_only'"
            });
        }

        // Validate processing_config structure if provided
        if (processing_config !== undefined) {
            if (typeof processing_config !== 'object' || processing_config === null || Array.isArray(processing_config)) {
                return res.status(400).json({
                    status: "error",
                    message: "processing_config must be an object"
                });
            }

            // Validate extraction method if provided
            if (processing_config.extraction?.method &&
                !['extendai', 'paddleocr'].includes(processing_config.extraction.method)) {
                return res.status(400).json({
                    status: "error",
                    message: "Invalid extraction.method. Must be one of: extendai, paddleocr"
                });
            }

            // Validate postProcessing overrides if provided: array of {name, enabled}.
            if (processing_config.postProcessing !== undefined) {
                if (!Array.isArray(processing_config.postProcessing)) {
                    return res.status(400).json({
                        status: "error",
                        message: "processing_config.postProcessing must be an array of { name, enabled, options? }",
                    });
                }
                const known = new Set(listServices().map((s) => s.name));
                for (const entry of processing_config.postProcessing) {
                    if (!entry || typeof entry.name !== 'string' || !known.has(entry.name)) {
                        return res.status(400).json({
                            status: "error",
                            message: `Invalid postProcessing entry. Each needs a known service "name". Available: ${[...known].join(', ') || 'none'}.`,
                        });
                    }
                    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
                        return res.status(400).json({
                            status: "error",
                            message: `postProcessing entry "${entry.name}".enabled must be a boolean.`,
                        });
                    }
                }
            }

            // Validate processing method if provided
            if (processing_config.processing?.method) {
                if (!ALL_PROCESSING_METHODS.includes(processing_config.processing.method)) {
                    return res.status(400).json({
                        status: "error",
                        message: `Invalid processing.method. Must be one of: ${ALL_PROCESSING_METHODS.join(', ')}`
                    });
                }

                // Validate model if provided
                if (processing_config.processing?.model) {
                    const method = processing_config.processing.method;
                    if (!isValidModel(method, processing_config.processing.model)) {
                        const validModels = getModelsForMethod(method);
                        return res.status(400).json({
                            status: "error",
                            message: `Invalid processing.model for ${method}. Must be one of: ${validModels.join(', ')}`
                        });
                    }
                }
            }
        }

        // Check if user has access to this job
        const hasAccess = await checkJobAccess(id, req.user, res);
        if (!hasAccess) {
            return; // Error response already sent by checkJobAccess
        }

        // Get job to ensure it exists
        const job = await getJobStatus(id);
        if (!job) {
            return res.status(404).json({
                status: "error",
                message: "Job not found"
            });
        }

        // Prepare updates object
        const updates = {};
        if (name !== undefined) updates.name = name;
        if (extraction_mode !== undefined) updates.extraction_mode = extraction_mode;
        if (processing_config !== undefined) {
            // Parse existing processing_config if it's a string (JSONB can return as string)
            let existingConfig = job.processing_config || {};
            if (typeof existingConfig === 'string') {
                try {
                    existingConfig = JSON.parse(existingConfig);
                } catch (parseError) {
                    console.warn('⚠️ Failed to parse existing processing_config, using empty object:', parseError.message);
                    existingConfig = {};
                }
            }

            // Ensure existingConfig is an object
            if (typeof existingConfig !== 'object' || existingConfig === null || Array.isArray(existingConfig)) {
                existingConfig = {};
            }

            // Merge with existing processing_config
            updates.processing_config = {
                ...existingConfig,
                ...processing_config,
                // Deep merge extraction and processing objects
                extraction: {
                    ...(existingConfig.extraction || {}),
                    ...(processing_config.extraction || {})
                },
                processing: {
                    ...(existingConfig.processing || {}),
                    ...(processing_config.processing || {})
                }
            };
        }
        console.log("updates", updates);
        // Update job configuration
        const updatedJob = await updateJobConfig(id, updates);

        res.json({
            status: "success",
            message: "Job configuration updated successfully",
            data: {
                jobId: updatedJob.id,
                name: updatedJob.name,
                extraction_mode: updatedJob.extraction_mode,
                processing_config: updatedJob.processing_config
            }
        });
    } catch (error) {
        console.error('❌ Error updating job configuration:', error.message);
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

/**
 * GET /jobs/:id/services
 * List the registered post-processing services (for the job settings UI to
 * render activation toggles). Mirrors GET /previews/services but job-scoped.
 */
app.get("/jobs/:id/services", authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const hasAccess = await checkJobAccess(id, req.user, res);
        if (!hasAccess) return;

        const services = listServices().map((s) => ({
            name: s.name,
            version: s.version,
        }));
        res.json({ status: "success", data: { services } });
    } catch (error) {
        console.error('❌ Error listing post-processing services:', error.message);
        res.status(500).json({ status: "error", message: error.message });
    }
});

/**
 * POST /jobs/:id/run-service
 * Run a post-processing service (backfill) over this job's completed files.
 * This is the operator "run now" trigger — the chosen surface is the job
 * settings page (NOT the client preview). Body: { name, slug, options?, apply?, force? }.
 * apply=false (default) is a dry-run: services execute, counts return, nothing persists.
 */
app.post("/jobs/:id/run-service", authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, slug, options = {}, apply = false, force = false } = req.body || {};

        if (!name || !slug) {
            return res.status(400).json({
                status: "error",
                message: 'Both "name" (service) and "slug" (document type) are required.',
            });
        }

        const hasAccess = await checkJobAccess(id, req.user, res);
        if (!hasAccess) return;

        const service = getService(name);
        if (!service) {
            return res.status(404).json({
                status: "error",
                message: `Unknown service "${name}". Available: ${listServices().map((s) => s.name).join(', ') || 'none'}.`,
            });
        }

        // ── Async (default for the new UI): queue one worker item per file.
        // Progress and the accumulated summary arrive as
        // `postprocess-progress-event`; GET /jobs/:id/post-processing on reload.
        if (req.body?.async === true) {
            const { enqueuePostProcessingRequest } = await import('./services/postProcessingJobService.ts');
            const { request, queued } = await enqueuePostProcessingRequest({
                jobId: id,
                service: name,
                slug,
                options,
                apply: Boolean(apply),
                force: Boolean(force),
                requestedBy: req.user?.email || req.user?.id || null,
            });
            return res.status(202).json({
                status: "queued",
                data: { requestId: request.id, totalFiles: request.total_files, queued },
            });
        }

        // ── Sync (legacy clients): scans every completed file in-request.
        // Gather this job's completed files (records only exist for completed files).
        const filesRes = await pool.query(
            `SELECT id FROM job_files WHERE job_id = $1 AND processing_status = 'completed'`,
            [id],
        );
        const itemIds = filesRes.rows.map((r) => r.id);

        const result = await applyServicesToPreview({
            itemIds,
            slug,
            services: [service],
            optionsByService: { [name]: options },
            apply: Boolean(apply),
            force: Boolean(force),
        });

        res.json({ status: "success", data: result });
    } catch (error) {
        console.error('❌ Error running post-processing service for job:', error.message);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// GET /jobs/:id/post-processing — the job's latest backfill request, so the
// settings page can show a run that is still going (or its summary) after a
// reload, when the progress events have already been missed.
app.get("/jobs/:id/post-processing", authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const hasAccess = await checkJobAccess(id, req.user, res);
        if (!hasAccess) return;

        const { getLatestPostProcessingRequest } = await import('./services/postProcessingJobService.ts');
        const request = await getLatestPostProcessingRequest(id);
        res.json({ status: "success", request: request || null });
    } catch (error) {
        console.error('❌ Error loading post-processing request:', error.message);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// Get file result
app.get("/files/:id/result", authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const file = await getFileResult(id);

        // Check if user has access to this file
        const hasAccess = await checkFileAccess(id, req.user, res);
        if (!hasAccess) {
            return; // Error response already sent by checkFileAccess
        }

        if (!file) {
            return res.status(404).json({
                status: "error",
                message: "File not found"
            });
        }

        // Attach section verifications if any exist
        const svResult = await pool.query(
            `SELECT sv.*, u.email AS verified_by_email
             FROM section_verifications sv
             LEFT JOIN users u ON sv.verified_by = u.id
             WHERE sv.file_id = $1 ORDER BY sv.created_at`,
            [id]
        );
        file.section_verifications = svResult.rows;

        res.json({
            status: "success",
            file: file
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Download file endpoint - generates signed URL for S3 files or serves local files
app.get("/files/:id/download", authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const client = await pool.connect();

        try {
            // Get file info including s3_key
            const query = `
                SELECT jf.id, jf.filename, jf.s3_key, jf.file_hash, jf.storage_type, jf.job_id
                FROM job_files jf
                WHERE jf.id = $1
            `;

            const result = await client.query(query, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    status: "error",
                    message: "File not found"
                });
            }

            const file = result.rows[0];

            // Check if user has access to this file
            const hasAccess = await checkFileAccess(id, req.user, res);
            if (!hasAccess) {
                return; // Error response already sent by checkFileAccess
            }

            // If file is stored in S3, generate signed URL
            if (file.s3_key && file.storage_type === 's3' && s3Service.isCloudStorageEnabled()) {
                try {
                    // Generate signed URL that expires in 1 hour
                    const signedUrl = await s3Service.generateSignedUrl(file.s3_key, 3600);

                    // If JSON format requested (for iframe embedding), return JSON
                    if (req.query.format === 'json' || req.headers.accept?.includes('application/json')) {
                        return res.json({
                            status: "success",
                            url: signedUrl,
                            filename: file.filename
                        });
                    }

                    // Otherwise redirect to the signed URL (for direct downloads)
                    return res.redirect(signedUrl);
                } catch (s3Error) {
                    console.error(`❌ Error generating signed URL for file ${id}:`, s3Error.message);
                    return res.status(500).json({
                        status: "error",
                        message: "Failed to generate download URL"
                    });
                }
            } else {
                // File is stored locally or S3 is not enabled
                return res.status(404).json({
                    status: "error",
                    message: "File is not available for download (not stored in S3)"
                });
            }

        } finally {
            client.release();
        }

    } catch (error) {
        console.error('❌ Error downloading file:', error.message);
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// ──────────────────────────────────────────────────────────────────────────
// Visual Page Classifier endpoints
// ──────────────────────────────────────────────────────────────────────────
//
// GET  /document-types
//   Lists active document types from the schema registry. Used by the
//   frontend to populate the "restrict classifier to" multi-select on
//   job creation / job config.
//
// GET  /files/:id/pages/:n/thumbnail.jpg
//   Renders a single PDF page from S3 to a JPEG on demand. Used by the
//   "Document routing" panel on the file detail page so each per-page row
//   can show a small preview alongside the classifier's decision.
//   Cached aggressively because output is deterministic for a given
//   file+page (same PDF bytes, same renderer, same options).

app.get("/document-types", authenticateToken, async (req, res) => {
    try {
        const { listDocumentTypes } = await import("./services/schemaRegistry.js");
        const includeDeprecated = req.query.includeDeprecated === 'true';
        const types = await listDocumentTypes({ includeDeprecated });
        res.json({
            status: "success",
            documentTypes: types.map((t) => ({
                id: t.id,
                slug: t.slug,
                display_name: t.display_name,
                description: t.description,
                default_extractor: t.default_extractor,
                routing_confidence_threshold: t.routing_confidence_threshold,
                status: t.status,
                has_classifier_hints: t.classifier_hints != null,
                has_qa_hints: t.qa_hints != null && Object.keys(t.qa_hints).length > 0,
                identifier_fields: t.identifier_fields ?? [],
            })),
        });
    } catch (error) {
        console.error('❌ Error listing document types:', error.message);
        res.status(500).json({
            status: "error",
            message: error.message,
        });
    }
});

// GET /document-types/:slug/schema
// Returns the active JSON schema for a document type — read-only, any
// authenticated user. Used by the result viewer to show field descriptions
// (e.g. on hover). Field docs aren't sensitive, so this is not admin-gated.
app.get("/document-types/:slug/schema", authenticateToken, async (req, res) => {
    try {
        const { slug } = req.params;
        const { getActiveSchema } = await import("./services/schemaRegistry.js");
        const active = await getActiveSchema(slug);
        if (!active || !active.schema) {
            return res.status(404).json({ status: 'error', message: `No active schema for '${slug}'` });
        }
        const schema = typeof active.schema === 'string' ? JSON.parse(active.schema) : active.schema;
        res.json({
            status: 'success',
            slug: active.documentTypeSlug,
            version: active.version,
            schema_name: active.schemaName,
            json_schema: schema,
        });
    } catch (error) {
        console.error('❌ Error getting document-type schema:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

const REGISTRY_SLUG_PARAM = /^[a-z][a-z0-9_]{0,99}$/;

/** Admin-only middleware pair for registry CRUD. */
function registryAdmin(req, res, next) {
    authenticateToken(req, res, () => requireRole('admin')(req, res, next));
}

function validateRegistrySlug(slug, res) {
    if (!slug || typeof slug !== 'string' || !REGISTRY_SLUG_PARAM.test(slug)) {
        res.status(400).json({
            status: 'error',
            message: 'Invalid slug. Use lowercase letters, digits, underscore; max 100 chars.',
        });
        return false;
    }
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema registry admin API (Phase 2 UI). Admin JWT only (`role === admin`).
// Powers the Document types & schemas CRUD screen in the web app.
// ─────────────────────────────────────────────────────────────────────────────

app.get("/registry/document-types/:slug/detail", registryAdmin, async (req, res) => {
    try {
        const { slug } = req.params;
        if (!validateRegistrySlug(slug, res)) return;

        const {
            getDocumentTypeDetail,
            listSchemaVersionsForSlug,
        } = await import('./services/schemaRegistry.js');

        const detail = await getDocumentTypeDetail(slug);
        if (!detail) {
            return res.status(404).json({ status: 'error', message: `Unknown document type '${slug}'` });
        }
        const versions = await listSchemaVersionsForSlug(slug);

        res.json({
            status: 'success',
            documentType: {
                slug: detail.slug,
                display_name: detail.display_name,
                description: detail.description,
                default_extractor: detail.default_extractor,
                routing_confidence_threshold: detail.routing_confidence_threshold,
                status: detail.status,
                classifier_hints: detail.classifier_hints,
                qa_hints: detail.qa_hints,
                post_processing_defaults: detail.post_processing_defaults,
                identifier_fields: detail.identifier_fields,
                created_at: detail.created_at,
                updated_at: detail.updated_at,
                current_schema_version_id: detail.current_schema_version_id,
                current_schema_version: detail.current_schema_version,
                current_schema_name: detail.current_schema_name,
                current_schema_row_status: detail.current_schema_row_status,
                version_count: Array.isArray(versions) ? versions.length : 0,
            },
            schemaVersions: versions || [],
        });
    } catch (error) {
        console.error('❌ registry detail:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.get("/registry/document-types/:slug/schemas/:version", registryAdmin, async (req, res) => {
    try {
        const { slug, version } = req.params;
        if (!validateRegistrySlug(slug, res)) return;
        const v = parseInt(version, 10);
        if (!Number.isInteger(v) || v < 1) {
            return res.status(400).json({ status: 'error', message: 'Invalid version number' });
        }

        const { getSchemaVersion } = await import('./services/schemaRegistry.js');
        const row = await getSchemaVersion(slug, v);
        if (!row) {
            return res.status(404).json({ status: 'error', message: `No schema v${v} for '${slug}'` });
        }

        res.json({
            status: 'success',
            schema: {
                schemaId: row.schemaId,
                version: row.version,
                schemaName: row.schemaName,
                status: row.status,
                schema: row.schema,
                promptHints: row.promptHints,
                documentTypeSlug: row.documentTypeSlug,
                defaultExtractor: row.defaultExtractor,
            },
        });
    } catch (error) {
        console.error('❌ registry get schema version:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.post("/registry/document-types", registryAdmin, async (req, res) => {
    try {
        const {
            slug,
            displayName,
            description = null,
            defaultExtractor = 'extendai',
            routingConfidenceThreshold = 0.75,
            initialSchema = null,
        } = req.body || {};

        console.log({ slug, displayName, description, defaultExtractor, routingConfidenceThreshold, initialSchema });

        if (!slug || !displayName) {
            return res.status(400).json({ status: 'error', message: 'slug and displayName are required' });
        }
        if (!validateRegistrySlug(slug, res)) return;

        const svc = await import('./services/schemaRegistry.js');
        const existing = await svc.getDocumentTypeBySlug(slug);
        if (existing) {
            return res.status(409).json({
                status: 'error',
                message: `Document type '${slug}' already exists`,
            });
        }

        await svc.registerDocumentType({
            slug,
            displayName,
            description,
            defaultExtractor,
            routingConfidenceThreshold: Number(routingConfidenceThreshold),
        });

        let schemaRegistered = null;
        if (initialSchema && typeof initialSchema.jsonSchema === 'object') {
            const { unwrapSchemaPayload, extractHintsAndClean } = await import('./utils/schemaHintsExtract.js');
            const wrapped = unwrapSchemaPayload({ jsonSchema: initialSchema.jsonSchema, schemaName: initialSchema.schemaName });
            const schemaName =
                wrapped.schemaName || initialSchema.schemaName || `${slug}_extraction`;
            const { cleanedSchema, promptHints } = extractHintsAndClean(wrapped.rawSchema);

            schemaRegistered = await svc.registerSchema({
                documentTypeSlug: slug,
                jsonSchema: cleanedSchema,
                promptHints,
                schemaName,
                notes: initialSchema.notes || 'Created via registry UI',
                setActive: initialSchema.setActive !== false,
            });
        }

        const detail = await svc.getDocumentTypeDetail(slug);
        res.status(201).json({
            status: 'success',
            documentType: detail,
            initialSchemaRegistered: schemaRegistered,
        });
    } catch (error) {
        console.error('❌ registry create document type:', error.message);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

app.patch("/registry/document-types/:slug", registryAdmin, async (req, res) => {
    try {
        const { slug } = req.params;
        if (!validateRegistrySlug(slug, res)) return;

        const b = req.body || {};
        const patch = {};
        if (b.displayName !== undefined) patch.displayName = b.displayName;
        if (b.description !== undefined) patch.description = b.description;
        if (b.defaultExtractor !== undefined) patch.defaultExtractor = b.defaultExtractor;
        if (b.routingConfidenceThreshold !== undefined) {
            patch.routingConfidenceThreshold = Number(b.routingConfidenceThreshold);
        }
        if (b.status !== undefined) {
            if (!['active', 'deprecated'].includes(b.status)) {
                return res.status(400).json({
                    status: 'error',
                    message: 'status must be active or deprecated',
                });
            }
            patch.status = b.status;
        }

        const { updateDocumentType } = await import('./services/schemaRegistry.js');
        const row = await updateDocumentType(slug, patch);

        res.json({ status: 'success', documentType: row });
    } catch (error) {
        console.error('❌ registry patch document type:', error.message);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

app.delete("/registry/document-types/:slug", registryAdmin, async (req, res) => {
    try {
        const { slug } = req.params;
        if (!validateRegistrySlug(slug, res)) return;

        const { deleteDocumentTypeBySlug } = await import('./services/schemaRegistry.js');
        const deleted = await deleteDocumentTypeBySlug(slug);
        if (!deleted) {
            return res.status(404).json({ status: 'error', message: `Unknown document type '${slug}'` });
        }

        res.json({ status: 'success', deleted: { slug: deleted.slug, id: deleted.id } });
    } catch (error) {
        console.error('❌ registry delete document type:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.put("/registry/document-types/:slug/classifier-hints", registryAdmin, async (req, res) => {
    try {
        const { slug } = req.params;
        if (!validateRegistrySlug(slug, res)) return;

        const hints = req.body?.hints;
        const svc = await import('./services/schemaRegistry.js');

        let row;
        if (hints === null || hints === undefined) {
            row = await svc.clearClassifierHints(slug);
        } else if (hints && typeof hints === 'object' && !Array.isArray(hints)) {
            row = await svc.setClassifierHints(slug, hints);
        } else {
            return res.status(400).json({
                status: 'error',
                message: 'body.hints must be a JSON object, or omit / null to clear',
            });
        }

        res.json({ status: 'success', classifier_hints: row.classifier_hints, updated_at: row.updated_at });
    } catch (error) {
        console.error('❌ registry classifier-hints:', error.message);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

app.put("/registry/document-types/:slug/qa-hints", registryAdmin, async (req, res) => {
    try {
        const { slug } = req.params;
        if (!validateRegistrySlug(slug, res)) return;

        const hints = req.body?.hints;
        const svc = await import('./services/schemaRegistry.js');

        let row;
        if (hints === null || hints === undefined) {
            row = await svc.clearQAHints(slug);
        } else if (hints && typeof hints === 'object' && !Array.isArray(hints)) {
            row = await svc.setQAHints(slug, hints);
        } else {
            return res.status(400).json({
                status: 'error',
                message: 'body.hints must be a JSON object, or omit / null to clear',
            });
        }

        res.json({ status: 'success', qa_hints: row.qa_hints, updated_at: row.updated_at });
    } catch (error) {
        console.error('❌ registry qa-hints:', error.message);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

/**
 * PUT /registry/document-types/:slug/identifier-fields
 * Replace the per-document-type identifier dot-paths used to label a record in
 * the preview ID column / drawer header. Body: { fields: string[] } (ordered
 * dot-paths; [] clears, falling back to the frontend heuristic).
 */
app.put("/registry/document-types/:slug/identifier-fields", registryAdmin, async (req, res) => {
    try {
        const { slug } = req.params;
        if (!validateRegistrySlug(slug, res)) return;

        const fields = req.body?.fields;
        if (!Array.isArray(fields) || !fields.every((f) => typeof f === 'string')) {
            return res.status(400).json({
                status: 'error',
                message: 'body.fields must be an array of dot-path strings (use [] to clear)',
            });
        }

        const svc = await import('./services/schemaRegistry.js');
        const row = await svc.setIdentifierFields(slug, fields.map((f) => f.trim()).filter(Boolean));
        res.json({ status: 'success', identifier_fields: row.identifier_fields, updated_at: row.updated_at });
    } catch (error) {
        console.error('❌ registry identifier-fields:', error.message);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

/**
 * GET /registry/services
 * List registered post-processing services, for the document-type Post-processing
 * tab to render its default toggles.
 */
app.get("/registry/services", registryAdmin, async (req, res) => {
    try {
        const services = listServices().map((s) => ({ name: s.name, version: s.version }));
        res.json({ status: 'success', services });
    } catch (error) {
        console.error('❌ registry services:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

/**
 * PUT /registry/document-types/:slug/post-processing-defaults
 * Replace the per-document-type post-processing defaults (services that auto-run
 * for this slug unless a job overrides them). Body: { defaults: [{name, enabled, options?}] }.
 */
app.put("/registry/document-types/:slug/post-processing-defaults", registryAdmin, async (req, res) => {
    try {
        const { slug } = req.params;
        if (!validateRegistrySlug(slug, res)) return;

        const defaults = req.body?.defaults;
        if (!Array.isArray(defaults)) {
            return res.status(400).json({
                status: 'error',
                message: 'body.defaults must be an array of { name, enabled, options? }',
            });
        }
        const known = new Set(listServices().map((s) => s.name));
        for (const entry of defaults) {
            if (!entry || typeof entry.name !== 'string' || !known.has(entry.name)) {
                return res.status(400).json({
                    status: 'error',
                    message: `Each default needs a known service "name". Available: ${[...known].join(', ') || 'none'}.`,
                });
            }
        }

        const svc = await import('./services/schemaRegistry.js');
        const row = await svc.setPostProcessingDefaults(slug, defaults);
        res.json({ status: 'success', post_processing_defaults: row.post_processing_defaults, updated_at: row.updated_at });
    } catch (error) {
        console.error('❌ registry post-processing-defaults:', error.message);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

app.post("/registry/document-types/:slug/schemas", registryAdmin, async (req, res) => {
    try {
        const { slug } = req.params;
        if (!validateRegistrySlug(slug, res)) return;

        const body = req.body || {};
        if (!body.jsonSchema || typeof body.jsonSchema !== 'object') {
            return res.status(400).json({ status: 'error', message: 'jsonSchema object is required' });
        }

        const { unwrapSchemaPayload, extractHintsAndClean } = await import('./utils/schemaHintsExtract.js');
        const { registerSchema } = await import('./services/schemaRegistry.js');

        const wrapped = unwrapSchemaPayload({
            jsonSchema: body.jsonSchema,
            schemaName: body.schemaName,
        });
        const schemaName = wrapped.schemaName || body.schemaName || `${slug}_extraction`;
        const { cleanedSchema, promptHints } = extractHintsAndClean(wrapped.rawSchema);

        const result = await registerSchema({
            documentTypeSlug: slug,
            jsonSchema: cleanedSchema,
            promptHints,
            schemaName,
            notes: body.notes || null,
            setActive: body.setActive !== false,
        });

        res.status(201).json({ status: 'success', schema: result });
    } catch (error) {
        console.error('❌ registry register schema:', error.message);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

app.post("/registry/document-types/:slug/schemas/:version/promote", registryAdmin, async (req, res) => {
    try {
        const { slug, version } = req.params;
        if (!validateRegistrySlug(slug, res)) return;
        const v = parseInt(version, 10);
        if (!Number.isInteger(v) || v < 1) {
            return res.status(400).json({ status: 'error', message: 'Invalid version' });
        }

        const { setCurrentSchemaVersion } = await import('./services/schemaRegistry.js');
        const out = await setCurrentSchemaVersion(slug, v);

        res.json({ status: 'success', promoted: out });
    } catch (error) {
        console.error('❌ registry promote schema:', error.message);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

app.get("/files/:id/pages/:n/thumbnail.jpg", authenticateToken, async (req, res) => {
    try {
        const { id, n } = req.params;
        const pageNumber = parseInt(n, 10);

        if (!Number.isInteger(pageNumber) || pageNumber < 1) {
            return res.status(400).json({ status: "error", message: "Invalid page number" });
        }

        const {
            normalizeThumbnailRequest,
            thumbnailKey,
            readThumbnailManifest,
            ensureThumbnails,
        } = await import("./services/thumbnailService.js");

        // Snap onto the cached variant ladder so arbitrary widths can't each
        // trigger their own whole-document render.
        const { width: widthPx, quality: jpegQuality } = normalizeThumbnailRequest({
            width: req.query.width,
            quality: req.query.q,
        });

        // Look up the file row (need s3_key + access check).
        const client = await pool.connect();
        let file;
        try {
            const { rows } = await client.query(
                `SELECT id, filename, s3_key, job_id, storage_type
                 FROM job_files WHERE id = $1`,
                [id]
            );
            file = rows[0];
        } finally {
            client.release();
        }

        if (!file) {
            return res.status(404).json({ status: "error", message: "File not found" });
        }

        const hasAccess = await checkFileAccess(id, req.user, res);
        if (!hasAccess) return; // checkFileAccess already wrote a response

        if (!file.s3_key) {
            return res.status(400).json({ status: "error", message: "File has no S3 key — thumbnails require S3 storage" });
        }

        const s3 = new S3Service();
        if (!s3.isCloudStorageEnabled()) {
            return res.status(503).json({ status: "error", message: "S3 storage disabled on this server" });
        }

        const cacheKey = thumbnailKey(file.s3_key, pageNumber, widthPx, jpegQuality);

        // Fast path: the thumbnail already exists. One small S3 GET, streamed
        // straight through — the source PDF is never touched.
        let cached = await s3.getObjectStream(cacheKey);

        if (!cached) {
            // Miss. If the document has already been rendered at this variant,
            // the page simply doesn't exist — answer without re-rendering.
            const manifest = await readThumbnailManifest(s3, file.s3_key, widthPx, jpegQuality);
            if (manifest && pageNumber > manifest.pageCount) {
                return res.status(404).json({ status: "error", message: `Page ${pageNumber} not found in PDF` });
            }

            // Cold cache: render the WHOLE document once. Concurrent requests
            // for this file share this single render rather than each pulling
            // their own copy of the PDF.
            //
            // A manifest that covers this page while the object itself is gone
            // means the cache lost an entry (lifecycle expiry, manual delete);
            // force a rebuild rather than 404-ing that page forever.
            const { pageCount } = await ensureThumbnails(s3, file.s3_key, {
                width: widthPx,
                quality: jpegQuality,
                force: Boolean(manifest),
            });

            if (pageNumber > pageCount) {
                return res.status(404).json({ status: "error", message: `Page ${pageNumber} not found in PDF` });
            }

            cached = await s3.getObjectStream(cacheKey);
            if (!cached) {
                return res.status(404).json({ status: "error", message: `Page ${pageNumber} not found in PDF` });
            }
        }

        // Browser cache: thumbnails are deterministic for a given file+page+options.
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'private, max-age=86400, immutable');
        if (cached.contentLength != null) res.set('Content-Length', String(cached.contentLength));
        if (cached.etag) res.set('ETag', cached.etag);

        cached.body.on('error', (err) => {
            console.error(`❌ Error streaming thumbnail ${cacheKey}:`, err.message);
            res.destroy(err);
        });
        // The page rail aborts in-flight thumbnail fetches while scrolling;
        // tear the S3 stream down with the response instead of leaking it.
        res.on('close', () => cached.body.destroy());
        cached.body.pipe(res);
    } catch (error) {
        console.error(`❌ Error rendering page thumbnail:`, error.message);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// Update file results endpoint
// Patch a single record in a V2 envelope by section_result_id.
// Replaces only the targeted record — much smaller payload than the
// full-result PUT, avoids PayloadTooLargeError on big files.
app.patch("/files/:id/result/:sectionResultId", authenticateToken, async (req, res) => {
    try {
        const { id: fileId, sectionResultId } = req.params;
        const { data: recordData } = req.body;

        if (!recordData || typeof recordData !== 'object') {
            return res.status(400).json({
                status: 'error',
                message: 'data (the updated record object) is required in the request body',
            });
        }

        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) return;

        const file = await getFileResult(fileId);
        if (!file) {
            return res.status(404).json({ status: 'error', message: 'File not found' });
        }

        const result = file.result;
        if (!result || typeof result !== 'object') {
            return res.status(400).json({ status: 'error', message: 'File has no result to patch' });
        }

        // Find and replace the record with matching section_result_id
        let found = false;
        const updatedResult = {};
        for (const [slug, arr] of Object.entries(result)) {
            if (!Array.isArray(arr)) {
                updatedResult[slug] = arr;
                continue;
            }
            updatedResult[slug] = arr.map((rec) => {
                if (rec?.section_result_id === sectionResultId) {
                    found = true;
                    // Preserve section_result_id, replace everything else
                    return { section_result_id: sectionResultId, ...recordData };
                }
                return rec;
            });
        }

        if (!found) {
            return res.status(404).json({
                status: 'error',
                message: `No record found with section_result_id '${sectionResultId}'`,
            });
        }

        // Recompute flags with the updated full result
        const flags = computeFlags({
            jobId: file.job_id,
            filename: file.filename,
            processingStatus: file.processing_status || 'completed',
            result: updatedResult,
            processingMetadata: file.processing_metadata || null,
        });

        const client = await pool.connect();
        try {
            const updateResult = await client.query(
                `UPDATE job_files
                 SET result = $1, flags = $2, updated_at = NOW()
                 WHERE id = $3
                 RETURNING id, filename, result`,
                [JSON.stringify(updatedResult), JSON.stringify(flags), fileId]
            );

            if (updateResult.rows.length === 0) {
                return res.status(404).json({ status: 'error', message: 'File not found' });
            }

            await emitFileFullPatch(file.job_id, fileId, { has_result: true, flags });

            console.log(
                `✅ Patched record ${sectionResultId.substring(0, 8)}... in file ${file.filename}`
            );

            res.json({
                status: 'success',
                fileId,
                filename: updateResult.rows[0].filename,
                sectionResultId,
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('❌ result patch:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.put("/files/:id/results", authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { results } = req.body;

        // Validate input
        if (!results) {
            return res.status(400).json({
                status: "error",
                message: "Results data is required"
            });
        }

        // Get file details first
        const file = await getFileResult(id);
        // Check if user has access to this file
        const hasAccess = await checkFileAccess(id, req.user, res);
        if (!hasAccess) {
            return; // Error response already sent by checkFileAccess
        }

        if (!file) {
            return res.status(404).json({
                status: "error",
                message: "File not found"
            });
        }

        // Validate JSON format
        let parsedResults;
        try {
            parsedResults = typeof results === 'string' ? JSON.parse(results) : results;
        } catch (err) {
            return res.status(400).json({
                status: "error",
                message: "Invalid JSON format in results"
            });
        }

        // Extract source_locations from results if present, and remove it from result
        let sourceLocations = null;
        let resultWithoutSourceLocations = parsedResults;

        if (parsedResults && typeof parsedResults === 'object' && parsedResults.source_locations !== undefined) {
            sourceLocations = parsedResults.source_locations;
            // Create a copy without source_locations
            const { source_locations, ...rest } = parsedResults;
            resultWithoutSourceLocations = rest;
            console.log(`📍 Extracted source_locations from manual result update for file ${id}`);
        }

        // Update file results in database
        const client = await pool.connect();
        try {
            // Recompute flags based on updated result
            const flags = computeFlags({
                jobId: file.job_id,
                filename: file.filename,
                processingStatus: file.processing_status || 'completed',
                result: resultWithoutSourceLocations,
                processingMetadata: file.processing_metadata || null,
            });

            const updateQuery = `
                UPDATE job_files
                SET result = $1, source_locations = $2, flags = $3, updated_at = NOW()
                WHERE id = $4
                RETURNING id, filename, result
            `;

            const updateResult = await client.query(updateQuery, [
                JSON.stringify(resultWithoutSourceLocations),
                sourceLocations ? JSON.stringify(sourceLocations) : null,
                JSON.stringify(flags),
                id
            ]);

            if (updateResult.rows.length === 0) {
                return res.status(404).json({
                    status: "error",
                    message: "File not found"
                });
            }

            const updatedFile = updateResult.rows[0];

            // Emit full row so client gets flags, model, previews, etc.
            await emitFileFullPatch(file.job_id, updatedFile.id, {
                has_result: true,
                flags,
            });

            // Fire-and-forget: log this edit to field_corrections so we have
            // a per-field audit trail (foundation for future few-shot pools,
            // fine-tuning data, and per-doc-type accuracy metrics). Never
            // block the response or fail the save on logging errors.
            //
            // Note: we diff against `file.result` (the pre-edit blob loaded
            // above) and log the path-level changes. source_locations is
            // stripped before persistence and is not part of the corrections
            // diff.
            const originalForDiff = file.result || null;
            const correctedForDiff = resultWithoutSourceLocations;
            const correctedBy = req.user?.id || null;
            const orgId = Array.isArray(req.user?.organizationIds)
                ? (req.user.organizationIds[0] || null)
                : null;
            Promise.resolve()
                .then(() => recordCorrections({
                    fileId: updatedFile.id,
                    jobId: file.job_id || null,
                    organizationId: orgId,
                    correctedBy,
                    originalResult: originalForDiff,
                    correctedResult: correctedForDiff,
                    // Fallback for v1 (flat) result paths, where the
                    // json_path itself doesn't tell us which document_type
                    // the field belongs to. v2 paths (sections.<slug>[i]....)
                    // are auto-detected and override this.
                    documentTypeSlugFallback: file.document_type_slug || null,
                }))
                .then((res) => {
                    if (res && res.written > 0) {
                        console.log(`📝 Logged ${res.written} field correction(s) for file ${updatedFile.id}`);
                    }
                })
                .catch((err) => {
                    console.warn(`⚠️ field_corrections logging failed (non-fatal) for file ${updatedFile.id}:`, err.message);
                });

            // Create log entry for the update
            // await createLogAndEmit(file.job_id, updatedFile.id, 'info', `File results updated for ${updatedFile.filename}`, updatedFile.filename);

            res.json({
                status: "success",
                message: `File results updated successfully for ${updatedFile.filename}`,
                data: {
                    fileId: updatedFile.id,
                    filename: updatedFile.filename,
                    results: parsedResults,
                    flags
                }
            });

        } finally {
            client.release();
        }

    } catch (error) {
        console.error('Error updating file results:', error);
        res.status(500).json({
            status: "error",
            message: "Failed to update file results",
            error: error.message
        });
    }
});

// Get file comments
app.get("/files/:id/comments", authenticateToken, async (req, res) => {
    try {
        const { id: fileId } = req.params;

        // Check if user has access to this file
        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) {
            return; // Error response already sent by checkFileAccess
        }

        // Get file details
        const file = await getFileResult(fileId);
        if (!file) {
            return res.status(404).json({
                status: "error",
                message: "File not found"
            });
        }

        // Get comments from database
        const client = await pool.connect();
        try {
            const query = `
                SELECT comments
                FROM job_files
                WHERE id = $1
            `;
            const result = await client.query(query, [fileId]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    status: "error",
                    message: "File not found"
                });
            }

            const comments = result.rows[0].comments || [];

            res.json({
                status: "success",
                data: {
                    comments: Array.isArray(comments) ? comments : []
                }
            });

        } finally {
            client.release();
        }

    } catch (error) {
        console.error('Error fetching file comments:', error);
        res.status(500).json({
            status: "error",
            message: "Failed to fetch comments",
            error: error.message
        });
    }
});

// Add comment to file
app.post("/files/:id/comments", authenticateToken, async (req, res) => {
    try {
        const { id: fileId } = req.params;
        const { text } = req.body;

        // Validate input
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return res.status(400).json({
                status: "error",
                message: "Comment text is required and must be a non-empty string"
            });
        }

        // Check if user has access to this file
        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) {
            return; // Error response already sent by checkFileAccess
        }

        // Get file details
        const file = await getFileResult(fileId);
        if (!file) {
            return res.status(404).json({
                status: "error",
                message: "File not found"
            });
        }

        // Get user details
        const user = await getUserById(req.user.id);
        if (!user) {
            return res.status(404).json({
                status: "error",
                message: "User not found"
            });
        }

        // Create new comment
        const newComment = {
            id: uuidv4(),
            userId: req.user.id,
            userEmail: req.user.email || user.email,
            text: text.trim(),
            createdAt: new Date().toISOString()
        };

        // Update comments in database
        const client = await pool.connect();
        try {
            // Get existing comments
            const getQuery = `
                SELECT comments
                FROM job_files
                WHERE id = $1
            `;
            const getResult = await client.query(getQuery, [fileId]);

            if (getResult.rows.length === 0) {
                return res.status(404).json({
                    status: "error",
                    message: "File not found"
                });
            }

            const existingComments = getResult.rows[0].comments || [];
            const updatedComments = Array.isArray(existingComments)
                ? [...existingComments, newComment]
                : [newComment];

            // Update comments
            const updateQuery = `
                UPDATE job_files
                SET comments = $1, updated_at = NOW()
                WHERE id = $2
                RETURNING id, filename
            `;
            const updateResult = await client.query(updateQuery, [
                JSON.stringify(updatedComments),
                fileId
            ]);

            res.json({
                status: "success",
                message: "Comment added successfully",
                data: {
                    comment: newComment
                }
            });

        } finally {
            client.release();
        }

    } catch (error) {
        console.error('Error adding file comment:', error);
        res.status(500).json({
            status: "error",
            message: "Failed to add comment",
            error: error.message
        });
    }
});

// Bulk update file review status (MUST be before /files/:id/review to avoid route conflict)
app.put("/files/bulk/review", authenticateToken, async (req, res) => {
    try {
        const { fileIds, reviewStatus, reviewNotes } = req.body;

        // Validate input
        if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
            return res.status(400).json({
                status: "error",
                message: "File IDs array is required"
            });
        }

        const validStatuses = ['pending', 'in_review', 'reviewed', 'approved', 'rejected'];
        if (!reviewStatus || !validStatuses.includes(reviewStatus)) {
            return res.status(400).json({
                status: "error",
                message: `Invalid review status. Must be one of: ${validStatuses.join(', ')}`
            });
        }

        // Get user's organization IDs for access control
        const userOrganizationIds = await getUserOrganizationIds(req.user);

        // Check access for all files
        const accessibleFileIds = [];
        const deniedFileIds = [];

        for (const fileId of fileIds) {
            try {
                const file = await getFileResult(fileId);
                if (!file) {
                    deniedFileIds.push({ fileId, error: "File not found" });
                    continue;
                }

                const hasAccess = await userHasJobAccess(
                    file.job_id,
                    req.user.email,
                    req.user.role,
                    userOrganizationIds
                );

                if (hasAccess) {
                    accessibleFileIds.push(fileId);
                } else {
                    deniedFileIds.push({ fileId, error: "Access denied" });
                }
            } catch (error) {
                deniedFileIds.push({ fileId, error: error.message });
            }
        }

        if (accessibleFileIds.length === 0) {
            return res.status(403).json({
                status: "error",
                message: "No accessible files found",
                data: { denied: deniedFileIds }
            });
        }

        // Bulk update review status
        const updatedFiles = await bulkUpdateFileReviewStatus(
            accessibleFileIds,
            reviewStatus,
            req.user.id, // reviewed_by
            reviewNotes || null
        );

        // Emit full row for each updated file so client gets flags etc.
        const jobIds = new Set();
        for (const file of updatedFiles) {
            jobIds.add(file.job_id);
            await emitFileFullPatch(file.job_id, file.id, {
                review_status: file.review_status,
                reviewed_by: file.reviewed_by,
                reviewed_at: file.reviewed_at,
            });
        }

        res.json({
            status: "success",
            message: `Review status updated for ${updatedFiles.length} file(s)`,
            data: {
                updated: updatedFiles,
                denied: deniedFileIds.length > 0 ? deniedFileIds : undefined
            }
        });

    } catch (error) {
        console.error('Error bulk updating file review status:', error);
        res.status(500).json({
            status: "error",
            message: "Failed to bulk update file review status",
            error: error.message
        });
    }
});

// Bulk update file verification status (MUST be before /files/:id/verify to avoid route conflict)
app.put("/files/bulk/verify", authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const { fileIds, adminVerified, customerVerified } = req.body;

        // Validate input
        if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
            return res.status(400).json({
                status: "error",
                message: "File IDs array is required"
            });
        }

        // Only admins can update admin_verified
        const updateData = {};
        if (req.user.role === 'admin' && adminVerified !== undefined) {
            updateData.adminVerified = adminVerified;
        }
        if (customerVerified !== undefined) {
            updateData.customerVerified = customerVerified;
        }

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({
                status: "error",
                message: "At least one verification field must be provided"
            });
        }

        // Get user's organization IDs for access control
        const userOrganizationIds = await getUserOrganizationIds(req.user);

        // Check access for all files
        const accessibleFileIds = [];
        const deniedFileIds = [];

        for (const fileId of fileIds) {
            try {
                const file = await getFileResult(fileId);
                if (!file) {
                    deniedFileIds.push({ fileId, error: "File not found" });
                    continue;
                }

                const hasAccess = await userHasJobAccess(
                    file.job_id,
                    req.user.email,
                    req.user.role,
                    userOrganizationIds
                );

                if (hasAccess) {
                    accessibleFileIds.push(fileId);
                } else {
                    deniedFileIds.push({ fileId, error: "Access denied" });
                }
            } catch (error) {
                deniedFileIds.push({ fileId, error: error.message });
            }
        }

        if (accessibleFileIds.length === 0) {
            return res.status(403).json({
                status: "error",
                message: "No accessible files found",
                data: { denied: deniedFileIds }
            });
        }

        // Bulk update verification
        const updatedFiles = await bulkUpdateFileVerification(
            accessibleFileIds,
            updateData.adminVerified !== undefined ? updateData.adminVerified : null,
            updateData.customerVerified !== undefined ? updateData.customerVerified : null
        );

        // Emit full row for each updated file so client gets flags etc.
        for (const file of updatedFiles) {
            await emitFileFullPatch(file.job_id, file.id, {
                admin_verified: file.admin_verified,
                customer_verified: file.customer_verified,
            });
        }

        res.json({
            status: "success",
            message: `Verification updated for ${updatedFiles.length} file(s)`,
            data: {
                updated: updatedFiles,
                denied: deniedFileIds.length > 0 ? deniedFileIds : undefined
            }
        });

    } catch (error) {
        console.error('Error bulk updating file verification:', error);
        res.status(500).json({
            status: "error",
            message: "Failed to bulk update file verification",
            error: error.message
        });
    }
});

// Bulk update file review and verification status (MUST be before /files/:id/review to avoid route conflict)
app.put("/files/bulk/review-and-verify", authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const { fileIds, reviewStatus, adminVerified, reviewNotes } = req.body;

        // Validate input
        if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
            return res.status(400).json({
                status: "error",
                message: "File IDs array is required"
            });
        }

        const validStatuses = ['pending', 'in_review', 'reviewed', 'approved', 'rejected'];
        if (!reviewStatus || !validStatuses.includes(reviewStatus)) {
            return res.status(400).json({
                status: "error",
                message: `Invalid review status. Must be one of: ${validStatuses.join(', ')}`
            });
        }

        if (adminVerified === undefined) {
            return res.status(400).json({
                status: "error",
                message: "adminVerified is required"
            });
        }

        // Get user's organization IDs for access control
        const userOrganizationIds = await getUserOrganizationIds(req.user);

        // Check access for all files
        const accessibleFileIds = [];
        const deniedFileIds = [];

        for (const fileId of fileIds) {
            try {
                const file = await getFileResult(fileId);
                if (!file) {
                    deniedFileIds.push({ fileId, error: "File not found" });
                    continue;
                }

                const hasAccess = await userHasJobAccess(
                    file.job_id,
                    req.user.email,
                    req.user.role,
                    userOrganizationIds
                );

                if (hasAccess) {
                    accessibleFileIds.push(fileId);
                } else {
                    deniedFileIds.push({ fileId, error: "Access denied" });
                }
            } catch (error) {
                deniedFileIds.push({ fileId, error: error.message });
            }
        }

        if (accessibleFileIds.length === 0) {
            return res.status(403).json({
                status: "error",
                message: "No accessible files found",
                data: { denied: deniedFileIds }
            });
        }

        // Bulk update both review status and verification
        const [reviewedFiles, verifiedFiles] = await Promise.all([
            bulkUpdateFileReviewStatus(
                accessibleFileIds,
                reviewStatus,
                req.user.id, // reviewed_by
                reviewNotes || null
            ),
            bulkUpdateFileVerification(
                accessibleFileIds,
                adminVerified,
                null // customerVerified - not updating this
            )
        ]);

        // Combine results - both operations should return the same files
        const updatedFiles = reviewedFiles.map(reviewedFile => {
            const verifiedFile = verifiedFiles.find(vf => vf.id === reviewedFile.id);
            return {
                ...reviewedFile,
                admin_verified: verifiedFile ? verifiedFile.admin_verified : null,
                customer_verified: verifiedFile ? verifiedFile.customer_verified : null
            };
        });

        // Emit full row for each updated file so client gets flags etc.
        for (const file of updatedFiles) {
            await emitFileFullPatch(file.job_id, file.id, {
                review_status: file.review_status,
                reviewed_by: file.reviewed_by,
                reviewed_at: file.reviewed_at,
                admin_verified: file.admin_verified,
                customer_verified: file.customer_verified,
            });
        }

        res.json({
            status: "success",
            message: `Review and verification updated for ${updatedFiles.length} file(s)`,
            data: {
                updated: updatedFiles,
                denied: deniedFileIds.length > 0 ? deniedFileIds : undefined
            }
        });

    } catch (error) {
        console.error('Error bulk updating file review and verification:', error);
        res.status(500).json({
            status: "error",
            message: "Failed to bulk update file review and verification",
            error: error.message
        });
    }
});

// Update file review status
app.put("/files/:id/review", authenticateToken, async (req, res) => {
    try {
        const { id: fileId } = req.params;
        const { reviewStatus, reviewNotes } = req.body;

        // Validate input
        const validStatuses = ['pending', 'in_review', 'reviewed', 'approved', 'rejected'];
        if (!reviewStatus || !validStatuses.includes(reviewStatus)) {
            return res.status(400).json({
                status: "error",
                message: `Invalid review status. Must be one of: ${validStatuses.join(', ')}`
            });
        }

        // Check if user has access to this file
        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) {
            return; // Error response already sent by checkFileAccess
        }

        // Get file details
        const file = await getFileResult(fileId);
        if (!file) {
            return res.status(404).json({
                status: "error",
                message: "File not found"
            });
        }

        // Update review status
        const result = await updateFileReviewStatus(
            fileId,
            reviewStatus,
            req.user.id, // reviewed_by
            reviewNotes || null
        );

        // Emit full row so client gets flags etc.
        await emitFileFullPatch(file.job_id, result.id, {
            review_status: result.review_status,
            reviewed_by: result.reviewed_by,
            reviewed_at: result.reviewed_at,
        });

        res.json({
            status: "success",
            message: "File review status updated successfully",
            data: result
        });

    } catch (error) {
        console.error('Error updating file review status:', error);
        res.status(500).json({
            status: "error",
            message: "Failed to update file review status",
            error: error.message
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Routing-review write endpoints (Phase 1, item #4)
//
// The visual classifier marks each section 'auto_approved' or 'pending_review'.
// These endpoints let an operator:
//   - approve a pending_review section,
//   - re-route it to a different document type,
//   - split it into two at a chosen page boundary.
//
// All three persist the new `detected_sections` blob on job_files and emit a
// `file-status-update` event so any open routing panel refreshes. Per-section
// extraction (worker side) gates on `flattenExtractionPages({
// includePendingReview: false })`, so flipping a section to 'approved' is what
// makes its pages eligible for the next reprocess pass.
// ─────────────────────────────────────────────────────────────────────────────

function parseSectionIndex(value, res) {
    const idx = parseInt(value, 10);
    if (!Number.isInteger(idx) || idx < 0) {
        res.status(400).json({ status: 'error', message: 'Invalid section index' });
        return null;
    }
    return idx;
}

async function loadFileWithSections(fileId, res) {
    const file = await getFileResult(fileId);
    if (!file) {
        res.status(404).json({ status: 'error', message: 'File not found' });
        return null;
    }
    if (!file.detected_sections || !Array.isArray(file.detected_sections.sections)) {
        res.status(400).json({
            status: 'error',
            message: 'File has no detected_sections (visual classifier did not run on it)',
        });
        return null;
    }
    return file;
}

function emitDetectedSectionsUpdate(file, detectedSections) {
    emitFilePatch(file.job_id, file.id, {
        detected_sections: detectedSections,
    });
}

app.post("/files/:id/sections/:index/approve", authenticateToken, async (req, res) => {
    try {
        const fileId = req.params.id;
        const index = parseSectionIndex(req.params.index, res);
        if (index === null) return;

        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) return;

        const file = await loadFileWithSections(fileId, res);
        if (!file) return;

        const { applyApproveSection } = await import('./services/sectionRoutingEdits.js');
        const updated = applyApproveSection(file.detected_sections, { index });

        await updateFileDetectedSections(fileId, updated);
        emitDetectedSectionsUpdate(file, updated);

        res.json({ status: 'success', detected_sections: updated });
    } catch (error) {
        console.error('❌ section approve:', error.message);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

app.post("/files/:id/sections/:index/change-slug", authenticateToken, async (req, res) => {
    try {
        const fileId = req.params.id;
        const index = parseSectionIndex(req.params.index, res);
        if (index === null) return;

        const slug = req.body?.slug;
        if (!slug || typeof slug !== 'string') {
            return res.status(400).json({ status: 'error', message: 'slug is required (string)' });
        }

        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) return;

        const file = await loadFileWithSections(fileId, res);
        if (!file) return;

        // Validate slug exists in registry. We don't restrict to active-only
        // here — the operator may need to route to a deprecated type for
        // historical consistency; the registry is the source of truth.
        const { getDocumentTypeBySlug } = await import('./services/schemaRegistry.js');
        const dt = await getDocumentTypeBySlug(slug);
        if (!dt) {
            return res.status(400).json({
                status: 'error',
                message: `Unknown document type '${slug}'`,
            });
        }

        const { applyChangeSectionSlug } = await import('./services/sectionRoutingEdits.js');
        const updated = applyChangeSectionSlug(file.detected_sections, {
            index,
            slug,
            threshold: dt.routing_confidence_threshold,
        });

        await updateFileDetectedSections(fileId, updated);
        emitDetectedSectionsUpdate(file, updated);

        res.json({ status: 'success', detected_sections: updated });
    } catch (error) {
        console.error('❌ section change-slug:', error.message);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

app.post("/files/:id/sections/:index/split", authenticateToken, async (req, res) => {
    try {
        const fileId = req.params.id;
        const index = parseSectionIndex(req.params.index, res);
        if (index === null) return;

        const atPage = parseInt(req.body?.atPage, 10);
        if (!Number.isInteger(atPage) || atPage < 1) {
            return res.status(400).json({
                status: 'error',
                message: 'atPage must be a positive page number',
            });
        }

        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) return;

        const file = await loadFileWithSections(fileId, res);
        if (!file) return;

        const { applySplitSection } = await import('./services/sectionRoutingEdits.js');
        const updated = applySplitSection(file.detected_sections, { index, atPage });

        await updateFileDetectedSections(fileId, updated);
        emitDetectedSectionsUpdate(file, updated);

        res.json({ status: 'success', detected_sections: updated });
    } catch (error) {
        console.error('❌ section split:', error.message);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

// Merge two sections into one. Adjacency is NOT required: merging a log
// section with its appendix-figure section yields a non-contiguous section
// (member_pages union). indexA is the anchor (slug/threshold inherited).
app.post("/files/:id/sections/merge", authenticateToken, async (req, res) => {
    try {
        const fileId = req.params.id;
        const indexA = parseInt(req.body?.indexA, 10);
        const indexB = parseInt(req.body?.indexB, 10);

        if (!Number.isInteger(indexA) || !Number.isInteger(indexB) || indexA < 0 || indexB < 0) {
            return res.status(400).json({
                status: 'error',
                message: 'indexA and indexB must be non-negative integers',
            });
        }

        const slug = req.body?.slug || undefined; // optional slug override

        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) return;

        const file = await loadFileWithSections(fileId, res);
        if (!file) return;

        const { applyMergeSections } = await import('./services/sectionRoutingEdits.js');
        const updated = applyMergeSections(file.detected_sections, { indexA, indexB, slug });

        await updateFileDetectedSections(fileId, updated);
        emitDetectedSectionsUpdate(file, updated);

        res.json({ status: 'success', detected_sections: updated });
    } catch (error) {
        console.error('❌ section merge:', error.message);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

// Attach free pages (pages in no section, e.g. classified 'none') to a
// section. The gesture for wiring an appendix page to its log when the
// appendix never formed a section of its own. Body:
//   { pageNumbers: number[], markAsData?: boolean }
app.post("/files/:id/sections/:index/attach-pages", authenticateToken, async (req, res) => {
    try {
        const fileId = req.params.id;
        const index = parseSectionIndex(req.params.index, res);
        if (index === null) return;

        const pageNumbers = req.body?.pageNumbers;
        if (!Array.isArray(pageNumbers) || pageNumbers.length === 0 ||
            !pageNumbers.every((p) => Number.isInteger(p) && p >= 1)) {
            return res.status(400).json({
                status: 'error',
                message: 'pageNumbers must be a non-empty array of positive page numbers',
            });
        }

        const markAsData = req.body?.markAsData !== false;

        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) return;

        const file = await loadFileWithSections(fileId, res);
        if (!file) return;

        const { applyAttachPages } = await import('./services/sectionRoutingEdits.js');
        const updated = applyAttachPages(file.detected_sections, { index, pageNumbers, markAsData });

        await updateFileDetectedSections(fileId, updated);
        emitDetectedSectionsUpdate(file, updated);

        res.json({ status: 'success', detected_sections: updated });
    } catch (error) {
        console.error('❌ section attach-pages:', error.message);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

// Save updated detected_sections and re-extract sections that need it.
// The client performs split/merge/slug-change locally, then sends the
// final blob here. This endpoint persists it, identifies sections with
// section_result_id === null, extracts those, and rebuilds the envelope.
app.post("/files/:id/sections/save-and-reextract", authenticateToken, async (req, res) => {
    try {
        const fileId = req.params.id;
        // Lean payload: the client sends only the edited `sections` array. All
        // other classifier metadata (pages, page_summaries, grouper, classifier,
        // record_inventory, …) is preserved server-side — it isn't user-editable
        // and shouldn't be round-tripped (smaller body, and no risk of the client
        // staling/dropping it). Back-compat: still accept a legacy full
        // { detected_sections } body.
        const incomingSections = Array.isArray(req.body?.sections)
            ? req.body.sections
            : (Array.isArray(req.body?.detected_sections?.sections)
                ? req.body.detected_sections.sections
                : null);

        if (!incomingSections) {
            return res.status(400).json({
                status: 'error',
                message: 'a sections array is required',
            });
        }

        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) return;

        const file = await loadFileWithSections(fileId, res);
        if (!file) return;

        // Merge: keep stored detected_sections metadata, replace only `sections`.
        const storedDetected =
            file.detected_sections && typeof file.detected_sections === 'object'
                ? file.detected_sections
                : {};
        const newDetectedSections = { ...storedDetected, sections: incomingSections };

        // Find sections needing extraction (section_result_id === null).
        // Superseded sections never extract — they're duplicates whose
        // canonical twin carries the data.
        const sectionIndices = newDetectedSections.sections
            .map((s, i) => (s.section_result_id == null && !s.superseded_by ? i : -1))
            .filter(i => i >= 0);

        // Save the updated detected_sections first (even if no extraction
        // needed). On the async path the run marker goes in the SAME write,
        // so the marker and the pending set can never disagree — the UI
        // re-derives progress from this blob after any remount or reload.
        const runAsync = req.body?.async === true && sectionIndices.length > 0;
        const persistedSections = runAsync
            ? withSreexRun(newDetectedSections, sectionIndices, 'save')
            : newDetectedSections;
        await updateFileDetectedSections(fileId, persistedSections);

        if (sectionIndices.length === 0) {
            // No extraction needed — but the save may have REMOVED sections
            // (delete action), so reconcile before returning: the envelope must
            // mirror the sections array, and verification/QA rows keyed to
            // dropped section_result_ids must not linger (they skew per-file
            // review counts and the review_status rollup).
            let rebuiltResult;
            // Only id-addressable envelopes can be reconciled (legacy results
            // have no section_result_id on their records — leave those alone).
            const recordById = new Map();
            for (const arr of Object.values(file.result || {})) {
                if (!Array.isArray(arr)) continue;
                for (const rec of arr) {
                    if (rec?.section_result_id) recordById.set(rec.section_result_id, rec);
                }
            }
            if (recordById.size > 0) {
                // Superseded sections keep their entry in detected_sections
                // (provenance) but their record leaves the envelope and their
                // verification/QA rows are cleaned up, same as a delete.
                const liveSections = newDetectedSections.sections
                    .filter(s => !s.superseded_by);
                const currentIds = liveSections
                    .map(s => s.section_result_id)
                    .filter(Boolean);
                const rebuilt = {};
                for (const section of liveSections) {
                    const slug = section.document_type_slug;
                    const rec = section.section_result_id
                        ? recordById.get(section.section_result_id)
                        : null;
                    if (!slug || !rec) continue;
                    if (!rebuilt[slug]) rebuilt[slug] = [];
                    rebuilt[slug].push(rec);
                }
                if (JSON.stringify(rebuilt) !== JSON.stringify(file.result || {})) {
                    await pool.query(
                        `UPDATE job_files SET result = $1, updated_at = NOW() WHERE id = $2`,
                        [rebuilt, fileId]
                    );
                    rebuiltResult = rebuilt;
                }

                await cleanupOrphanSectionRows(fileId, currentIds);
                const reviewStatus = await recomputeFileReviewStatus(fileId);
                emitFilePatch(file.job_id, fileId, {
                    detected_sections: newDetectedSections,
                    ...(rebuiltResult !== undefined ? { result: rebuiltResult } : {}),
                });
                // Refresh derived list-row fields (record_count,
                // section_review_counts, review_status) on the files table.
                await emitFileFullPatch(file.job_id, fileId, { review_status: reviewStatus });
            } else {
                emitDetectedSectionsUpdate(file, newDetectedSections);
            }
            return res.json({
                status: 'success',
                detected_sections: newDetectedSections,
                ...(rebuiltResult !== undefined ? { result: rebuiltResult } : {}),
            });
        }

        // ── Async (default for the new UI): enqueue a worker `sreex` job and
        // return immediately. The job re-reads detected_sections at run time
        // (we just persisted them), lands each section's result incrementally
        // over the file-patch channel, and reports progress as
        // `section-reextract-progress-event`. The file's processing_status is
        // NOT flipped — the rest of the envelope stays valid and visible.
        if (req.body?.async === true) {
            await enqueueSectionReextraction(fileId, file.job_id);
            emitDetectedSectionsUpdate(file, persistedSections);
            return res.status(202).json({
                status: 'queued',
                detected_sections: persistedSections,
                pending_section_indices: sectionIndices,
            });
        }

        // ── Sync (legacy clients): same engine, in-request. ────────────
        const ProcessingService = (await import('./services/processingService.js')).default;
        const outcome = await runSectionReextraction({
            fileId,
            extractionService,
            processingService: new ProcessingService(),
            emitPatch: (patch) => emitFilePatch(file.job_id, fileId, patch),
        });

        if (outcome.status === 'failed') {
            return res.status(500).json({ status: 'error', message: outcome.error });
        }

        // Refresh derived list-row fields (record_count, section_review_counts)
        await emitFileFullPatch(file.job_id, fileId, { review_status: outcome.reviewStatus });

        res.json({
            status: 'success',
            detected_sections: outcome.detectedSections,
            sectionResults: outcome.sectionResults,
            pages_without_text: outcome.pagesWithoutText,
        });
    } catch (error) {
        console.error('❌ save-and-reextract:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Re-extract specific sections (after split/merge/slug-change).
// Nulls the requested sections' ids and runs the shared re-extraction service
// over everything pending, merging results into the existing V2 envelope.
// Body: { sectionIndices: number[], async?: bool } — `async: true` queues the
// worker job and returns 202 instead of blocking for the run.
app.post("/files/:id/reextract-sections", authenticateToken, async (req, res) => {
    try {
        const fileId = req.params.id;
        const sectionIndices = req.body?.sectionIndices; // number[] — which sections to re-extract

        if (!Array.isArray(sectionIndices) || sectionIndices.length === 0) {
            return res.status(400).json({
                status: 'error',
                message: 'sectionIndices must be a non-empty array of section indices',
            });
        }

        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) return;

        const file = await loadFileWithSections(fileId, res);
        if (!file) return;

        const allSections = file.detected_sections?.sections;
        if (!Array.isArray(allSections)) {
            return res.status(400).json({
                status: 'error',
                message: 'File has no detected_sections',
            });
        }
        const invalidIndices = sectionIndices.filter(i => i < 0 || i >= allSections.length);
        if (invalidIndices.length > 0) {
            return res.status(400).json({
                status: 'error',
                message: `Invalid section indices: ${invalidIndices.join(', ')} (file has ${allSections.length} sections)`,
            });
        }

        // Mark the requested sections as needing extraction (the service
        // extracts exactly the null-section_result_id set), persist, run.
        let pendingDetected = JSON.parse(JSON.stringify(file.detected_sections));
        for (const i of sectionIndices) {
            pendingDetected.sections[i].section_result_id = null;
        }
        // Async path: stamp the run marker in the same write (see
        // save-and-reextract) so the progress card survives remounts.
        const allPending = computePendingSectionIndices(pendingDetected.sections);
        if (req.body?.async === true && allPending.length > 0) {
            pendingDetected = withSreexRun(pendingDetected, allPending, 'reextract');
        }
        await updateFileDetectedSections(fileId, pendingDetected);

        // ── Async: hand off to the worker (same job as Save & Re-extract).
        if (req.body?.async === true) {
            await enqueueSectionReextraction(fileId, file.job_id);
            emitDetectedSectionsUpdate(file, pendingDetected);
            return res.status(202).json({
                status: 'queued',
                detected_sections: pendingDetected,
                pending_section_indices: allPending,
            });
        }

        const ProcessingService = (await import('./services/processingService.js')).default;
        const outcome = await runSectionReextraction({
            fileId,
            extractionService,
            processingService: new ProcessingService(),
            emitPatch: (patch) => emitFilePatch(file.job_id, fileId, patch),
        });

        if (outcome.status === 'failed') {
            return res.status(500).json({ status: 'error', message: outcome.error });
        }

        // Refresh derived list-row fields (record_count, section_review_counts)
        await emitFileFullPatch(file.job_id, fileId, { review_status: outcome.reviewStatus });

        res.json({
            status: 'success',
            sectionResults: outcome.sectionResults,
            detected_sections: outcome.detectedSections,
        });
    } catch (error) {
        console.error('❌ section re-extract:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// GET /files/:id/sections/:sectionResultId/markdown
// Return just one section's source markdown (its extraction_pages sliced out of
// the file's stored page text, via selected_pages alignment). Powers the
// "This section" toggle on the Markdown tab.
app.get("/files/:id/sections/:sectionResultId/markdown", authenticateToken, async (req, res) => {
    try {
        const fileId = req.params.id;
        const { sectionResultId } = req.params;

        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) return;

        const file = await loadFileWithSections(fileId, res);
        if (!file) return;

        const idx = resolveSectionIndex(file.detected_sections, sectionResultId);
        if (idx < 0) {
            return res.status(404).json({ status: 'error', message: 'Section not found' });
        }
        const section = file.detected_sections.sections[idx];

        // pages is a large column omitted by getFileResult — load it directly.
        const pagesRow = await pool.query(`SELECT pages FROM job_files WHERE id = $1`, [fileId]);
        const filePages = pagesRow.rows[0]?.pages || [];

        const { markdown, pages } = sliceSectionMarkdown({
            pages: filePages,
            selectedPages: file.selected_pages || null,
            extractionPages: section.extraction_pages || [],
        });

        res.json({
            status: 'success',
            sectionResultId,
            extraction_pages: section.extraction_pages || [],
            markdown,
            pages,
        });
    } catch (error) {
        console.error('❌ section markdown:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// POST /files/:id/sections/:sectionResultId/reprocess
// Reprocess a SINGLE section: re-extract its text (re-OCR its pages), re-run AI
// on it, or both — the section-scoped analogue of POST /files/reprocess.
//
// Both halves are just per-section markers on detected_sections, which is why
// this shares the `sreex` worker job rather than owning a mode:
//   reProcessAi   → section_result_id = null   (needs extraction)
//   reExtractText → needs_text_reextract: true (needs its pages re-OCR'd)
// Body: { reExtractText?: bool, reProcessAi?: bool, async?: bool }
app.post("/files/:id/sections/:sectionResultId/reprocess", authenticateToken, async (req, res) => {
    try {
        const fileId = req.params.id;
        const { sectionResultId } = req.params;
        const reExtractText = req.body?.reExtractText === true;
        const reProcessAi = req.body?.reProcessAi === true;

        if (!reExtractText && !reProcessAi) {
            return res.status(400).json({
                status: 'error',
                message: 'At least one of reExtractText or reProcessAi must be true',
            });
        }

        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) return;

        const file = await loadFileWithSections(fileId, res);
        if (!file) return;

        const sectionIndex = resolveSectionIndex(file.detected_sections, sectionResultId);
        if (sectionIndex < 0) {
            return res.status(404).json({ status: 'error', message: 'Section not found' });
        }
        const section = file.detected_sections.sections[sectionIndex];
        const extractionPages = Array.isArray(section.extraction_pages) ? section.extraction_pages : [];

        if (reExtractText && extractionPages.length === 0) {
            return res.status(400).json({
                status: 'error',
                message: 'Section has no extraction_pages to re-extract',
            });
        }

        // Mark the work, persist, THEN queue — the job re-reads sections at run
        // time, so the markers are the entire payload.
        let marked = JSON.parse(JSON.stringify(file.detected_sections));
        if (reExtractText) marked.sections[sectionIndex][TEXT_REEXTRACT_FLAG] = true;
        if (reProcessAi) marked.sections[sectionIndex].section_result_id = null;
        // The run touches this section plus anything already pending on the
        // file; the marker lists them all so the card can name each row.
        const touchedIndices = [...new Set([
            sectionIndex,
            ...computePendingSectionIndices(marked.sections),
        ])].sort((a, b) => a - b);
        if (req.body?.async === true) {
            marked = withSreexRun(marked, touchedIndices, 'reprocess');
        }
        await updateFileDetectedSections(fileId, marked);

        console.log(
            `🔄 Section reprocess for ${file.filename}: section ${sectionIndex} ` +
            `(${section.document_type_slug})` +
            `${reExtractText ? ' +text' : ''}${reProcessAi ? ' +ai' : ''}`
        );

        // ── Async (default for the new UI): the worker runs it. ────────
        if (req.body?.async === true) {
            await enqueueSectionReextraction(fileId, file.job_id);
            emitDetectedSectionsUpdate(file, marked);
            // pending_section_indices is usually just this section, but the
            // job extracts EVERY pending section on the file — 15% of
            // completed files carry 1–4 already-pending ones (measured
            // 2026-07-28). Returned so the UI can say so rather than
            // surprising the operator with extra sections re-extracting.
            return res.status(202).json({
                status: 'queued',
                sectionResultId,
                reExtractText,
                reProcessAi,
                section_index: sectionIndex,
                pending_section_indices: computePendingSectionIndices(marked.sections),
                detected_sections: marked,
            });
        }

        // ── Sync (legacy clients): same engine, in-request. Note this now
        // also sweeps any OTHER section already pending on the file, which
        // is the same widening reextract-sections took — those sections
        // needed extracting anyway.
        const ProcessingService = (await import('./services/processingService.js')).default;
        const outcome = await runSectionReextraction({
            fileId,
            extractionService,
            processingService: new ProcessingService(),
            emitPatch: (patch) => emitFilePatch(file.job_id, fileId, patch),
        });

        if (outcome.status === 'failed') {
            return res.status(500).json({ status: 'error', message: outcome.error });
        }

        await emitFileFullPatch(file.job_id, fileId, { review_status: outcome.reviewStatus });

        console.log(`✅ Section reprocess complete for ${file.filename} (section ${sectionIndex})`);
        res.json({
            status: 'success',
            sectionResultId,
            reExtractText,
            reProcessAi,
            result: outcome.result,
            detected_sections: outcome.detectedSections,
        });
    } catch (error) {
        console.error('❌ section reprocess:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// GET /reextract-prompts?slug=<slug>
// Operator-note suggestions for the directed re-extraction modal, mined from
// past requests: same-slug notes first (failure modes repeat within a doc
// type), then most recent across all slugs.
app.get("/reextract-prompts", authenticateToken, async (req, res) => {
    try {
        const slug = typeof req.query?.slug === 'string' ? req.query.slug : '';
        const { getPromptSuggestions } = await import('./services/directedReextractionService.ts');
        const prompts = await getPromptSuggestions({ slug, limit: 8 });
        res.json({ status: 'success', prompts });
    } catch (error) {
        console.error('❌ reextract prompt suggestions:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// POST /files/:id/sections/:sectionResultId/reextract-group
// Directed group re-extraction: re-read up to 3 top-level schema groups from
// the section's page images (vision), steered by an optional operator
// prompt, and stage the differences as QA findings for review — never writes
// data directly. Queued (mode `rex:<requestId>`) and executed by the worker;
// progress arrives over Socket.IO as `reextract-progress-event`.
// Body: { groups: string[] (or group: string), prompt?: string,
//         pages?: number[], mode?: 'auto'|'full'|'patch', model?: string }
app.post("/files/:id/sections/:sectionResultId/reextract-group", authenticateToken, async (req, res) => {
    try {
        const fileId = req.params.id;
        const { sectionResultId } = req.params;

        const {
            MAX_REEXTRACT_GROUPS,
            MAX_REEXTRACT_PAGES,
            createReextractionRequest,
            getActiveReextractionRequests,
            buildRexMode,
        } = await import('./services/directedReextractionService.ts');

        // groups[] is the API; a single `group` string is accepted too.
        const rawGroups = Array.isArray(req.body?.groups)
            ? req.body.groups
            : (typeof req.body?.group === 'string' ? [req.body.group] : []);
        const groups = [...new Set(
            rawGroups.map((g) => (typeof g === 'string' ? g.trim() : '')).filter(Boolean)
        )];
        if (groups.length === 0) {
            return res.status(400).json({ status: 'error', message: "'groups' is required (1 to 3 group names)" });
        }
        if (groups.length > MAX_REEXTRACT_GROUPS) {
            return res.status(400).json({
                status: 'error',
                message: `At most ${MAX_REEXTRACT_GROUPS} groups per request — each group gets its own focused call; batching more dilutes the attention that makes this work`,
            });
        }

        const operatorPrompt = typeof req.body?.prompt === 'string' && req.body.prompt.trim()
            ? req.body.prompt.trim()
            : null;
        const model = typeof req.body?.model === 'string' && req.body.model ? req.body.model : null;
        const requestedMode = ['auto', 'full', 'patch'].includes(req.body?.mode) ? req.body.mode : 'auto';

        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) return;

        const file = await loadFileWithSections(fileId, res);
        if (!file) return;
        if (!file.s3_key) {
            return res.status(400).json({ status: 'error', message: 'File has no S3 key — re-extraction needs the original PDF' });
        }

        const sectionIndex = resolveSectionIndex(file.detected_sections, sectionResultId);
        if (sectionIndex < 0) {
            return res.status(404).json({ status: 'error', message: 'Section not found' });
        }
        const section = file.detected_sections.sections[sectionIndex];
        const slug = section.document_type_slug;
        const extractionPages = Array.isArray(section.extraction_pages) ? section.extraction_pages : [];

        // The record under repair, straight from the v2 envelope.
        const envelopeArr = file.result?.[slug];
        const record = Array.isArray(envelopeArr)
            ? envelopeArr.find((r) => r?.section_result_id === sectionResultId)
            : null;
        if (!record) {
            return res.status(404).json({ status: 'error', message: `No extraction record for section '${sectionResultId}'` });
        }

        const unknownGroups = groups.filter((g) => g === 'section_result_id' || !(g in record));
        if (unknownGroups.length) {
            return res.status(400).json({
                status: 'error',
                message: `Unknown group(s) for this section: ${unknownGroups.join(', ')}`,
            });
        }

        // Pages: any page of the PDF is allowed (the classifier may have
        // missed the page that actually holds the data — a known failure
        // mode); extraction_pages is only the default. Over-cap selections
        // fail loudly instead of being silently truncated.
        let pages;
        if (Array.isArray(req.body?.pages) && req.body.pages.length > 0) {
            pages = [...new Set(req.body.pages)]
                .filter((p) => Number.isInteger(p) && p >= 1)
                .sort((a, b) => a - b);
            if (!pages.length) {
                return res.status(400).json({ status: 'error', message: "'pages' must be positive page numbers" });
            }
            if (pages.length > MAX_REEXTRACT_PAGES) {
                return res.status(400).json({
                    status: 'error',
                    message: `At most ${MAX_REEXTRACT_PAGES} pages per request — pick the page(s) that actually hold the data`,
                });
            }
            const pcRow = await pool.query(`SELECT page_count FROM job_files WHERE id = $1`, [fileId]);
            const pageCount = pcRow.rows[0]?.page_count;
            if (Number.isInteger(pageCount) && pageCount > 0) {
                const beyond = pages.filter((p) => p > pageCount);
                if (beyond.length) {
                    return res.status(400).json({
                        status: 'error',
                        message: `Page(s) ${beyond.join(', ')} are beyond the PDF (${pageCount} pages)`,
                    });
                }
            }
        } else {
            pages = extractionPages.slice(0, MAX_REEXTRACT_PAGES);
            if (!pages.length) {
                return res.status(400).json({ status: 'error', message: 'Section has no extraction pages — specify pages explicitly' });
            }
        }

        // Dedupe: one active request per (section, group). Different groups
        // of the same section may run concurrently.
        const activeRequests = await getActiveReextractionRequests(fileId);
        const conflict = activeRequests.find(
            (r) => r.section_result_id === sectionResultId && r.groups.some((g) => groups.includes(g))
        );
        if (conflict) {
            return res.status(409).json({
                status: 'error',
                message: `A re-extraction is already ${conflict.status} for group(s) ${conflict.groups.join(', ')} of this section`,
                activeReextractions: activeRequests,
            });
        }

        const request = await createReextractionRequest({
            fileId,
            sectionResultId,
            slug,
            groups,
            pages,
            prompt: operatorPrompt,
            mode: requestedMode,
            model,
            requestedBy: req.user?.email ?? req.user?.id ?? null,
        });

        await queueService.addFileToQueue(fileId, file.job_id, 0, buildRexMode(request.id));

        // Tell the job room immediately — the worker won't emit until it
        // picks the job up on its next poll.
        io.to(`job-${file.job_id}`).emit('reextract-progress-event', {
            jobId: file.job_id,
            fileId,
            status: 'queued',
            requestId: request.id,
            sectionResultId,
            groups,
            timestamp: new Date().toISOString(),
        });

        console.log(
            `📥 Directed re-extraction queued for ${file.filename} section ${sectionIndex}: ` +
            `${groups.map((g) => `'${g}'`).join(', ')} (mode=${requestedMode}, pages=[${pages.join(', ')}])`
        );

        return res.status(202).json({
            status: 'success',
            queued: true,
            requestId: request.id,
            sectionResultId,
            groups,
            pages,
            mode: requestedMode,
        });
    } catch (error) {
        console.error('❌ directed group re-extraction enqueue:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Update file verification status
app.put("/files/:id/verify", authenticateToken, requireRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { adminVerified, customerVerified } = req.body;

        // Only admins can update admin_verified
        // Anyone can update customer_verified (for now)
        const updateData = {};
        if (req.user.role === 'admin' && adminVerified !== undefined) {
            updateData.adminVerified = adminVerified;
        }
        if (customerVerified !== undefined) {
            updateData.customerVerified = customerVerified;
        }

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({
                status: "error",
                message: "At least one verification field must be provided"
            });
        }

        // Get file info before update to get job_id
        const file = await getFileResult(id);
        if (!file) {
            return res.status(404).json({
                status: "error",
                message: "File not found"
            });
        }

        const result = await updateFileVerification(
            id,
            updateData.adminVerified !== undefined ? updateData.adminVerified : null,
            updateData.customerVerified !== undefined ? updateData.customerVerified : null
        );

        // Emit full row so client gets flags etc.
        await emitFileFullPatch(file.job_id, result.id, {
            admin_verified: result.admin_verified,
            customer_verified: result.customer_verified,
        });

        res.json({
            status: "success",
            message: "File verification updated successfully",
            data: result
        });

    } catch (error) {
        console.error('Error updating file verification:', error);
        res.status(500).json({
            status: "error",
            message: "Failed to update file verification",
            error: error.message
        });
    }
});

// ── Section QA ──────────────────────────────────────────────────────
// QA runs are queued (file_processing_queue, mode `qa:*`) and executed by
// the worker — the endpoints below validate, enqueue, and return 202.
// Progress arrives over Socket.IO as `qa-progress-event` in the job room.

/**
 * Shared enqueue path for both QA endpoints. Validates the file/scope is
 * QA-able (so callers get an immediate error, not a failed background job),
 * dedupes against already queued/running QA jobs, enqueues, and notifies
 * the job room that a QA run is queued.
 */
async function enqueueQAJob({ fileId, scope, sectionResultId = null, model = null, res }) {
    const { buildQAMode, getActiveQAJobs, collectQARecords } = await import('./services/qaJobService.js');

    // Validate now — cheap (no S3 download, no OpenAI) and gives the caller
    // an immediate 4xx instead of a silently failing background job.
    let file, records;
    try {
        ({ file, records } = await collectQARecords({ fileId, scope, sectionResultId }));
    } catch (err) {
        const notFound = /not found/i.test(err.message);
        return res.status(notFound ? 404 : 400).json({ status: 'error', message: err.message });
    }

    // scope=remaining with everything already QA'd — nothing to enqueue.
    if (!records.length) {
        return res.json({ status: 'success', queued: false, fileId, scope, sectionResultIds: [], totalSections: 0 });
    }

    // Dedupe: one QA job per (file, scope-target) at a time. A section-scoped
    // job only conflicts with itself or a whole-file job; a whole-file job
    // conflicts with any active QA on the file.
    const active = await getActiveQAJobs(fileId);
    const conflict = scope === 'section'
        ? active.find((j) => j.scope !== 'section' || j.sectionResultId === sectionResultId)
        : active[0];
    if (conflict) {
        return res.status(409).json({
            status: 'error',
            message: conflict.scope === 'section'
                ? 'QA is already running on this section'
                : 'A QA run is already queued or running for this file',
            activeQa: active,
        });
    }

    await queueService.addFileToQueue(fileId, file.job_id, 0, buildQAMode({ scope, sectionResultId, model }));

    // Tell the job room immediately — the worker won't emit until it picks
    // the job up on its next poll (up to WORKER_INTERVAL_MS later).
    const sectionResultIds = records.map((r) => r.sectionResultId);
    io.to(`job-${file.job_id}`).emit('qa-progress-event', {
        jobId: file.job_id,
        fileId,
        status: 'queued',
        scope,
        sectionResultIds,
        progress: { current: 0, total: sectionResultIds.length },
        timestamp: new Date().toISOString(),
    });

    console.log(`📥 QA job queued for ${fileId} (scope=${scope}${sectionResultId ? `, section=${sectionResultId.substring(0, 8)}...` : ''}, ${sectionResultIds.length} section(s))`);

    return res.status(202).json({
        status: 'success',
        queued: true,
        fileId,
        scope,
        sectionResultIds,
        totalSections: sectionResultIds.length,
    });
}

// POST /files/:id/sections/:sectionResultId/qa
// Queue a VLM QA run on a single section (processed by the worker).
app.post("/files/:id/sections/:sectionResultId/qa", authenticateToken, async (req, res) => {
    try {
        const { id: fileId, sectionResultId } = req.params;

        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) return;

        return await enqueueQAJob({
            fileId,
            scope: 'section',
            sectionResultId,
            model: req.body?.model || null, // optional per-request override for A/B
            res,
        });
    } catch (error) {
        console.error('❌ section QA enqueue error:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// POST /files/:id/qa
// Queue a VLM QA run on a file's sections (all, or ?scope=remaining).
app.post("/files/:id/qa", authenticateToken, async (req, res) => {
    try {
        const { id: fileId } = req.params;

        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) return;

        const scope = (req.query?.scope ?? req.body?.scope) === 'remaining' ? 'remaining' : 'all';

        return await enqueueQAJob({
            fileId,
            scope,
            model: req.body?.model || null, // optional per-request override for A/B
            res,
        });
    } catch (error) {
        console.error('❌ file QA enqueue error:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// GET /files/:id/qa-findings
// Returns all QA findings for a file, grouped by section_result_id.
app.get("/files/:id/qa-findings", authenticateToken, async (req, res) => {
    try {
        const { id: fileId } = req.params;

        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) return;

        const { getQAFindings, getQARuns } = await import('./services/sectionQAService.js');
        const { getActiveQAJobs } = await import('./services/qaJobService.js');
        const { getActiveReextractionRequests } = await import('./services/directedReextractionService.ts');
        const [grouped, qaRuns, activeQa, activeReextractions] = await Promise.all([
            getQAFindings(fileId),
            getQARuns(fileId),
            getActiveQAJobs(fileId),
            getActiveReextractionRequests(fileId),
        ]);

        res.json({ status: 'success', findings: grouped, qaRuns, activeQa, activeReextractions });
    } catch (error) {
        console.error('❌ get QA findings:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// GET /files/:id/processing-events
// Returns the curated processing timeline for a file (for hydration when a
// client opens/refreshes a file after — or during — processing).
app.get("/files/:id/processing-events", authenticateToken, async (req, res) => {
    try {
        const { id: fileId } = req.params;

        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) return;

        const { getProcessingEvents } = await import('./services/processingEventsService.js');
        const events = await getProcessingEvents(fileId);

        res.json({ status: 'success', events });
    } catch (error) {
        console.error('❌ get processing events:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// PATCH /files/:id/qa-findings/:findingId
// Update a finding's status: accepted or dismissed.
app.patch("/files/:id/qa-findings/:findingId", authenticateToken, async (req, res) => {
    try {
        const { id: fileId, findingId } = req.params;
        const { status } = req.body;

        if (!['accepted', 'dismissed'].includes(status)) {
            return res.status(400).json({ status: 'error', message: "status must be 'accepted' or 'dismissed'" });
        }

        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) return;

        const { updateQAFindingStatus } = await import('./services/sectionQAService.js');
        const updated = await updateQAFindingStatus(findingId, fileId, status);

        if (!updated) {
            return res.status(404).json({ status: 'error', message: 'Finding not found' });
        }

        res.json({ status: 'success', finding: updated });
    } catch (error) {
        console.error('❌ update QA finding:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// ── Section-level verification ───────────────────────────────────

/**
 * Recompute a file's review_status from its section_verifications rows,
 * compared against the total sections in the result envelope (sections never
 * verified have no row). Persists and returns the new status.
 */
// recomputeFileReviewStatus and cleanupOrphanSectionRows moved to
// services/sectionReextractService.ts (imported above) so worker-run
// re-extraction can use them too.

// GET  /files/:id/section-verifications
// Returns all verification rows for a file, keyed by section_result_id.
app.get("/files/:id/section-verifications", authenticateToken, async (req, res) => {
    try {
        const { id: fileId } = req.params;
        const result = await pool.query(
            `SELECT sv.*, u.email AS verified_by_email
             FROM section_verifications sv
             LEFT JOIN users u ON sv.verified_by = u.id
             WHERE sv.file_id = $1
             ORDER BY sv.created_at`,
            [fileId]
        );
        res.json({ status: "success", data: result.rows });
    } catch (error) {
        console.error('Error fetching section verifications:', error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// PUT  /files/:id/section-verifications/:sectionResultId
// Upsert a single section's verification status.
app.put("/files/:id/section-verifications/:sectionResultId", authenticateToken, async (req, res) => {
    try {
        const { id: fileId, sectionResultId } = req.params;
        const { status: verifyStatus, notes } = req.body;

        if (!['pending', 'approved', 'rejected', 'in_review'].includes(verifyStatus)) {
            return res.status(400).json({
                status: "error",
                message: "status must be one of: pending, approved, rejected, in_review",
            });
        }

        const result = await pool.query(
            `INSERT INTO section_verifications (file_id, section_result_id, status, verified_by, verified_at, notes)
             VALUES ($1, $2, $3, $4, NOW(), $5)
             ON CONFLICT (file_id, section_result_id)
             DO UPDATE SET status = $3, verified_by = $4, verified_at = NOW(), notes = COALESCE($5, section_verifications.notes), updated_at = NOW()
             RETURNING *`,
            [fileId, sectionResultId, verifyStatus, req.user.id, notes ?? null]
        );

        // Recompute file-level review_status from section verifications
        const fileReviewStatus = await recomputeFileReviewStatus(fileId);

        res.json({
            status: "success",
            data: result.rows[0],
            file_review_status: fileReviewStatus,
        });
    } catch (error) {
        console.error('Error upserting section verification:', error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// PUT  /files/:id/section-verifications-bulk
// Set the same status for multiple sections at once (e.g. approve-all).
app.put("/files/:id/section-verifications-bulk", authenticateToken, async (req, res) => {
    try {
        const { id: fileId } = req.params;
        const { sectionResultIds, status: verifyStatus, notes } = req.body;

        if (!Array.isArray(sectionResultIds) || sectionResultIds.length === 0) {
            return res.status(400).json({ status: "error", message: "sectionResultIds must be a non-empty array" });
        }
        if (!['pending', 'approved', 'rejected', 'in_review'].includes(verifyStatus)) {
            return res.status(400).json({ status: "error", message: "status must be one of: pending, approved, rejected, in_review" });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            for (const sectionResultId of sectionResultIds) {
                await client.query(
                    `INSERT INTO section_verifications (file_id, section_result_id, status, verified_by, verified_at, notes)
                     VALUES ($1, $2, $3, $4, NOW(), $5)
                     ON CONFLICT (file_id, section_result_id)
                     DO UPDATE SET status = $3, verified_by = $4, verified_at = NOW(), notes = COALESCE($5, section_verifications.notes), updated_at = NOW()`,
                    [fileId, sectionResultId, verifyStatus, req.user.id, notes ?? null]
                );
            }

            // Recompute file-level review_status (inside the transaction)
            const fileReviewStatus = await recomputeFileReviewStatus(fileId, client);

            await client.query('COMMIT');

            const updated = await pool.query(
                `SELECT sv.*, u.email AS verified_by_email
                 FROM section_verifications sv
                 LEFT JOIN users u ON sv.verified_by = u.id
                 WHERE sv.file_id = $1 ORDER BY sv.created_at`,
                [fileId]
            );

            res.json({
                status: "success",
                data: updated.rows,
                file_review_status: fileReviewStatus,
            });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error bulk-updating section verifications:', error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// Add files to existing job
app.post("/jobs/:id/files", authenticateToken, upload.array("files", 20), async (req, res) => {
    try {
        const { id: jobId } = req.params;
        const { schema, schemaName, selected_pages } = req.body;

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({
                status: "error",
                message: "No files provided"
            });
        }

        // Parse selected_pages if provided (JSON string or object)
        let selectedPagesMap = {};
        if (selected_pages) {
            try {
                selectedPagesMap = typeof selected_pages === 'string' ? JSON.parse(selected_pages) : selected_pages;
            } catch (e) {
                console.warn('Failed to parse selected_pages:', e.message);
            }
        }

        // Check if job exists
        const job = await getJobStatus(jobId);
        if (!job) {
            return res.status(404).json({
                status: "error",
                message: "Job not found"
            });
        }

        const addedFiles = [];

        for (const file of req.files) {
            // Upload to S3 if enabled
            let s3FileInfo = null;
            let uploadStatus = 'success';
            let uploadError = null;
            let storageType = 's3';

            let pageCount = null;
            const isPdf = file.mimetype === 'application/pdf' || file.originalname?.toLowerCase().endsWith('.pdf');
            const isImage = file.mimetype?.startsWith('image/') || /\.(png|jpg|jpeg|gif|bmp|tiff|tif|webp)$/i.test(file.originalname || '');

            if (s3Service.isCloudStorageEnabled()) {
                try {
                    s3FileInfo = await s3Service.uploadFile(file, jobId);
                } catch (s3Error) {
                    console.warn(`⚠️ S3 upload failed for ${file.originalname}: ${s3Error.message}`);
                    uploadStatus = 'failed';
                    uploadError = s3Error.message;
                    storageType = 'local';
                }
            } else {
                storageType = 'local';
            }

            if (isPdf) {
                pageCount = await getPdfPageCount(file.path);
            } else if (isImage) {
                // Images are treated as single-page documents
                pageCount = 1;
            }

            // Get selected pages for this file if provided
            const selectedPages = selectedPagesMap[file.originalname] || null;

            // Add file record to database
            const fileRecord = await addFileToJob(
                jobId,
                file.originalname,
                file.size,
                s3FileInfo?.s3Key || null,
                s3FileInfo?.fileHash || null,
                uploadStatus,
                uploadError,
                storageType,
                pageCount,
                selectedPages
            );

            // Add file to processing queue
            await queueService.addFileToQueue(fileRecord.id, jobId);
            console.log(`✅ File ${fileRecord.id} added to processing queue`);

            addedFiles.push({
                id: fileRecord.id,
                filename: fileRecord.filename,
                size: fileRecord.size,
                s3Key: fileRecord.s3_key,
                fileHash: fileRecord.file_hash,
                page_count: fileRecord.page_count
            });

            // Clean up uploaded file
            const fs = (await import('fs')).default;
            fs.unlink(file.path, (err) => {
                if (err) console.error('Error deleting file:', err);
            });
        }

        // Emit socket events for each newly added file to notify frontend immediately
        for (const fileRecord of addedFiles) {
            emitFilePatch(jobId, fileRecord.id, {
                _newFile: true,
                filename: fileRecord.filename,
                extraction_status: 'pending',
                processing_status: 'pending',
                size: fileRecord.size || 0,
                created_at: fileRecord.created_at || new Date().toISOString(),
            });
        }

        res.json({
            status: "success",
            message: `Added ${addedFiles.length} files to job`,
            jobId,
            files: addedFiles
        });

    } catch (error) {
        console.error("Error adding files to job:", error.message);
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// List files in a job
app.get("/jobs/:id/files", authenticateToken, async (req, res) => {
    try {
        const { id: jobId } = req.params;

        // Check if user has access to this job
        const hasAccess = await checkJobAccess(jobId, req.user, res);
        if (!hasAccess) {
            return; // Error response already sent by checkJobAccess
        }

        const job = await getJobStatus(jobId);

        if (!job) {
            return res.status(404).json({
                status: "error",
                message: "Job not found"
            });
        }

        res.json({
            status: "success",
            jobId,
            files: job.files
        });

    } catch (error) {
        console.error("Error listing job files:", error.message);
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Get job file statistics
app.get("/jobs/:id/files/stats", authenticateToken, async (req, res) => {
    try {
        const { id: jobId } = req.params;

        // Check if user has access to this job
        const hasAccess = await checkJobAccess(jobId, req.user, res);
        if (!hasAccess) {
            return; // Error response already sent by checkJobAccess
        }

        const stats = await getJobFileStats(jobId);

        res.json({
            status: "success",
            jobId,
            stats
        });

    } catch (error) {
        console.error("Error getting job file statistics:", error.message);
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Get job files by status with pagination
app.get("/jobs/:id/files/:status", authenticateToken, async (req, res) => {
    try {
        const { id: jobId, status } = req.params;
        const { limit = 50, offset = 0 } = req.query;

        // Check if user has access to this job
        const hasAccess = await checkJobAccess(jobId, req.user, res);
        if (!hasAccess) {
            return; // Error response already sent by checkJobAccess
        }

        // Validate status
        if (!['processed', 'processing', 'pending'].includes(status)) {
            return res.status(400).json({
                status: "error",
                message: "Invalid status. Must be: processed, processing, or pending"
            });
        }

        const result = await getJobFilesByStatus(
            jobId,
            status,
            parseInt(limit),
            parseInt(offset)
        );

        res.json({
            status: "success",
            jobId,
            status,
            files: result.files,
            total: result.total,
            limit: parseInt(limit),
            offset: parseInt(offset),
            pagination: {
                current: Math.floor(parseInt(offset) / parseInt(limit)) + 1,
                pageSize: parseInt(limit),
                total: result.total,
                totalPages: Math.ceil(result.total / parseInt(limit))
            }
        });

    } catch (error) {
        console.error("Error getting job files by status:", error.message);
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Get PDF page count endpoint - accepts file upload and returns page count
app.post("/pdf/page-count", authenticateToken, upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                status: "error",
                message: "No file provided"
            });
        }

        const isPdf = req.file.mimetype === 'application/pdf' ||
            req.file.originalname?.toLowerCase().endsWith('.pdf');

        if (!isPdf) {
            return res.status(400).json({
                status: "error",
                message: "File is not a PDF"
            });
        }

        const pageCount = await getPdfPageCount(req.file.path);

        if (pageCount === null) {
            return res.status(500).json({
                status: "error",
                message: "Failed to determine page count"
            });
        }

        res.json({
            status: "success",
            pageCount: pageCount
        });
    } catch (error) {
        console.error("Error getting PDF page count:", error.message);
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Get all files across all jobs
// Phase 6: supports search, filter by status, and server-side sort
app.get("/files", authenticateToken, async (req, res) => {
    try {
        const {
            limit = 50,
            offset = 0,
            status,
            jobId,
            // Phase 6 params
            search,
            extractionStatus,
            processingStatus,
            reviewStatus,
            hasResult,
            sortField,
            sortOrder,
        } = req.query;

        // Get user's organization IDs (with JWT optimization)
        const organizationIds = await getUserOrganizationIds(req.user);

        const result = await getAllFiles(
            parseInt(limit),
            parseInt(offset),
            status || null,
            jobId || null,
            organizationIds,
            false, // includeLargeColumns
            {
                search: search || null,
                extractionStatus: extractionStatus || null,
                processingStatus: processingStatus || null,
                reviewStatus: reviewStatus || null,
                hasResult: hasResult != null ? hasResult : null,
                sortField: sortField || null,
                sortOrder: sortOrder || null,
            }
        );

        res.json({
            status: "success",
            files: result.files,
            total: result.total,
            filteredTotal: result.filteredTotal,
            stats: result.stats,
            limit: parseInt(limit),
            offset: parseInt(offset),
            pagination: {
                current: Math.floor(parseInt(offset) / parseInt(limit)) + 1,
                pageSize: parseInt(limit),
                total: result.total,
                totalPages: Math.ceil(result.total / parseInt(limit))
            }
        });

    } catch (error) {
        console.error("Error fetching files:", error.message);
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

/**
 * POST /extract
 * 
 * Main document extraction endpoint. Accepts multiple files, extracts text/content,
 * and optionally processes with AI using structured schemas.
 * 
 * @route POST /extract
 * @requires Authentication (JWT token via Bearer header)
 * @contentType multipart/form-data
 * 
 * @param {File[]} files - Form data file uploads (max 20 files)
 *                         Accepts: PDF files, image files
 *                         Required: At least 1 file
 * 
 * @param {Object} schema - JSON schema object defining the structure for data extraction
 *                          Used by OpenAI for structured output
 *                          Required: true
 *                          Example: { "type": "object", "properties": {...}, "required": [...] }
 * 
 * @param {string} schemaName - Name/identifier for the schema
 *                              Used for schema versioning and tracking
 *                              Optional, defaults to 'data_extraction'
 * 
 * @param {string} jobName - Name/description for this extraction job
 *                           Optional, used for job identification and display
 * 
 * @param {string} extractionMode - Processing mode
 *                                  Options: 'extraction_only' | 'full_extraction'
 *                                  Default: 'full_extraction'
 *                                  - 'extraction_only': Extract text only, skip AI processing
 *                                  - 'full_extraction': Extract text + process with AI
 * 
 * @param {Object} processingConfig - Configuration for extraction and processing methods
 *                                    Optional, defaults provided below
 *                                    Structure: {
 *                                      extraction: {
 *                                        method: string,  // 'paddleocr' | 'extendai'
 *                                        options: Object  // Method-specific options
 *                                      },
 *                                      processing: {
 *                                        method: string,  // 'openai' | 'qwen'
 *                                        model: string,   // OpenAI: 'gpt-4o' | 'gpt-4o-2024-08-06' | etc. | Qwen: 'qwen-max' | 'qwen-plus' | etc.
 *                                        options: Object  // Processing options
 *                                      }
 *                                    }
 *                                    Default: {
 *                                      extraction: { method: 'paddleocr', options: {} },
 *                                      processing: { method: 'openai', model: 'gpt-4o', options: {} }
 *                                    }
 * 
 * @returns {Object} Response object with job ID and status
 *                   {
 *                     jobId: string,
 *                     status: string,
 *                     message: string,
 *                     files: Array<{id: string, filename: string, status: string}>
 *                   }
 * 
 * @example
 * // Using multipart/form-data with FormData
 * const formData = new FormData();
 * formData.append('files', file1);
 * formData.append('files', file2);
 * formData.append('schema', JSON.stringify(schemaObject));
 * formData.append('schemaName', 'well_log_schema');
 * formData.append('jobName', 'Batch Extraction Job');
 * formData.append('extractionMode', 'full_extraction');
 * formData.append('processingConfig', JSON.stringify({
 *   extraction: { method: 'paddleocr', options: {} },
 *   processing: { method: 'openai', model: 'gpt-4o', options: {} }
 *   // Or for Qwen:
 *   processing: { method: 'qwen', model: 'qwen-max', options: {} }
 * }));
 * 
 * @response 200 - Job created successfully, processing started
 * @response 400 - Missing required fields (files, schema) or validation error
 * @response 401 - Authentication failed (invalid/missing token)
 * @response 500 - Server error during job creation or file processing
 */
// Main extraction endpoint - Updated for multiple files
app.post("/extract", authenticateToken, upload.array("files", 20), async (req, res) => {
    let job = null;

    try {
        console.log("=== EXTRACT ENDPOINT CALLED ===");
        console.log(`Request method: ${req.method}`);
        console.log(`Request URL: ${req.url}`);
        console.log(`Request headers: ${JSON.stringify(req.headers)}`);
        console.log(`Request files: ${req.files ? req.files.length : 0} files`);
        console.log(`Request body keys: ${req.body ? Object.keys(req.body) : 'no body'}`);

        if (!req.body) {
            console.error("No request body provided");
            return res.status(400).json({ error: "No request body provided" });
        }

        let { schema, schemaName, jobName, extractionMode = 'full_extraction', processingConfig, selected_pages } = req.body;

        // In a multipart upload, processingConfig arrives as a JSON STRING form
        // field. Parse it to a real object so the default-model logic below and
        // createJob both operate on an object (prevents double-encoded storage).
        if (typeof processingConfig === 'string') {
            try {
                processingConfig = JSON.parse(processingConfig);
            } catch (parseError) {
                console.warn(`⚠️ Upload: invalid processingConfig JSON string, ignoring it: ${parseError.message}`);
                processingConfig = undefined;
            }
        }

        if (!req.files || req.files.length === 0) {
            console.error("No files provided in request");
            return res.status(400).json({ error: "No files provided" });
        }

        // Parse selected_pages if provided (JSON string or object)
        let selectedPagesMap = {};
        if (selected_pages) {
            try {
                selectedPagesMap = typeof selected_pages === 'string' ? JSON.parse(selected_pages) : selected_pages;
            } catch (e) {
                console.warn('Failed to parse selected_pages:', e.message);
            }
        }

        if (!schema) {
            console.error("No schema provided in request");
            return res.status(400).json({ error: "No schema provided" });
        }

        console.log(`Processing ${req.files.length} files`);
        console.log(`Schema name: ${schemaName || 'default'}`);

        // Step 0: Create job in database
        console.log("Step 0: Creating job in database...");
        // Get user's first organization ID (with JWT optimization)
        const organizationId = await requireUserFirstOrganizationId(req.user, res);
        if (!organizationId) {
            return; // Error response already sent by helper
        }

        // Generate job name with Groq if not provided
        // Check for undefined, null, empty string, or whitespace-only string
        let finalJobName = jobName;
        if (!finalJobName || (typeof finalJobName === 'string' && finalJobName.trim() === '')) {
            console.log("No job name provided, generating with Groq...");
            try {
                // Parse schema if it's a string
                let parsedSchema = schema;
                if (typeof schema === 'string') {
                    try {
                        parsedSchema = JSON.parse(schema);
                    } catch (parseError) {
                        console.warn("Could not parse schema as JSON, using as-is");
                        parsedSchema = schema;
                    }
                }

                const generatedName = await groqService.generateJobName(parsedSchema, schemaName);
                if (generatedName) {
                    finalJobName = generatedName;
                    console.log(`✅ Using generated job name: "${finalJobName}"`);
                } else {
                    console.log("⚠️ Groq name generation failed or unavailable, using default");
                }
            } catch (error) {
                console.error("❌ Error generating job name with Groq:", error.message);
                // Continue with default naming if Groq fails
            }
        }

        // Set default processing config if not provided
        const defaultProcessingConfig = {
            extraction: { method: 'paddleocr', options: {} },
            processing: { method: PROCESSING_METHODS.OPENAI, model: DEFAULT_MODELS[PROCESSING_METHODS.OPENAI], options: {} }
        };

        const finalProcessingConfig = processingConfig || defaultProcessingConfig;

        // Set default model if method is specified but model is not
        if (finalProcessingConfig?.processing?.method && !finalProcessingConfig?.processing?.model) {
            finalProcessingConfig.processing.model = getDefaultModel(finalProcessingConfig.processing.method);
        }

        job = await createJob(finalJobName, schema, schemaName, req.user.id, organizationId, extractionMode, finalProcessingConfig);
        console.log(`✅ Job created: ${job.id}`);

        // Step 1: Create file records immediately for better UX
        console.log("Step 1: Creating file records...");
        const fileRecords = [];
        const initialFileData = [];

        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];

            // Upload to S3 first (if enabled)
            let s3FileInfo = null;
            let uploadStatus = 'success';
            let uploadError = null;
            let storageType = 's3';

            let pageCount = null;
            const isPdf = file.mimetype === 'application/pdf' || file.originalname?.toLowerCase().endsWith('.pdf');
            const isImage = file.mimetype?.startsWith('image/') || /\.(png|jpg|jpeg|gif|bmp|tiff|tif|webp)$/i.test(file.originalname || '');

            if (s3Service.isCloudStorageEnabled()) {
                try {
                    s3FileInfo = await s3Service.uploadFile(file, job.id);
                    console.log(`✅ File uploaded to S3: ${s3FileInfo.s3Key}`);
                } catch (s3Error) {
                    console.warn(`⚠️ S3 upload failed, continuing with local processing: ${s3Error.message}`);
                    uploadStatus = 'failed';
                    uploadError = s3Error.message;
                    storageType = 'local';
                }
            } else {
                storageType = 'local';
            }

            if (isPdf) {
                pageCount = await getPdfPageCount(file.path);
            } else if (isImage) {
                // Images are treated as single-page documents
                pageCount = 1;
            }

            // Get selected pages for this file if provided
            const selectedPages = selectedPagesMap[file.originalname] || null;

            // Create file record
            const fileRecord = await addFileToJob(
                job.id,
                file.originalname,
                file.size,
                s3FileInfo?.s3Key || null,
                s3FileInfo?.fileHash || null,
                uploadStatus,
                uploadError,
                storageType,
                pageCount,
                selectedPages
            );
            console.log(`✅ File record created: ${fileRecord.id}`);

            fileRecords.push(fileRecord);

            // Add to initial response data
            initialFileData.push({
                fileId: fileRecord.id,
                filename: file.originalname,
                size: file.size,
                extraction_status: 'pending',
                processing_status: 'pending',
                page_count: fileRecord.page_count,
                s3Storage: s3FileInfo ? {
                    s3Key: s3FileInfo.s3Key,
                    fileUrl: s3FileInfo.fileUrl,
                    storageType: s3FileInfo.storageType,
                    fileHash: s3FileInfo.fileHash,
                    expiresAt: s3FileInfo.expiresAt
                } : null
            });

            // Emit socket event for each newly created file to notify frontend immediately
            emitFilePatch(job.id, fileRecord.id, {
                _newFile: true,
                filename: file.originalname,
                extraction_status: 'pending',
                processing_status: 'pending',
                size: file.size || 0,
                created_at: new Date().toISOString(),
            });
        }

        // Return jobId and file information immediately for better UX
        res.json({
            success: true,
            data: initialFileData,
            metadata: {
                jobId: job.id,
                totalFiles: req.files.length,
                successfulFiles: 0,
                failedFiles: 0,
                jobStatus: 'processing'
            },
        });

        // Enqueue each file for the worker — same dispatch as POST /jobs/:id/files.
        // The worker is the single processor: it emits the live activity-log
        // timeline (file_processing_events), drives status updates, and persists
        // per-section results. /extract used to inline-process here (bypassing the
        // worker, so it produced no activity log); that path is removed. Everything
        // the worker needs is already persisted above (job.schema_data,
        // job.processing_config, per-file s3_key/selected_pages/page_count).
        console.log(`📥 Enqueuing ${fileRecords.length} file(s) for the worker (job ${job.id})`);
        for (const fileRecord of fileRecords) {
            try {
                await queueService.addFileToQueue(fileRecord.id, job.id);
                console.log(`✅ File ${fileRecord.id} added to processing queue`);
            } catch (enqueueErr) {
                console.error(`❌ Failed to enqueue file ${fileRecord.id}: ${enqueueErr.message}`);
            }
        }
        return;

    } catch (error) {
        console.error("Extraction error:", error.message);
        console.error("Error stack:", error.stack);

        // Update job status to failed
        if (job) {
            await updateJobStatus(job.id, 'failed');
        }

        res.status(500).json({
            success: false,
            error: error.message,
            jobId: job?.id || null
        });
    }
});

// Delete single file from job
app.delete("/files/:fileId", authenticateToken, async (req, res) => {
    try {
        const { fileId } = req.params;

        // Check if user has access to this file
        const hasAccess = await checkFileAccess(fileId, req.user, res);
        if (!hasAccess) {
            return; // Error response already sent by checkFileAccess
        }

        // Get file details
        const file = await getFileResult(fileId);
        if (!file) {
            return res.status(404).json({
                status: "error",
                message: "File not found"
            });
        }

        // Delete file from database
        const client = await pool.connect();
        try {
            const deleteQuery = `
                DELETE FROM job_files
                WHERE id = $1
                RETURNING id, filename, job_id
            `;

            const deleteResult = await client.query(deleteQuery, [fileId]);

            if (deleteResult.rows.length === 0) {
                return res.status(404).json({
                    status: "error",
                    message: "File not found"
                });
            }

            const deletedFile = deleteResult.rows[0];

            // Phase 4: Decrement stats counters (best-effort)
            try {
                await decrementTotal(client, deletedFile.job_id, file.extraction_status, file.processing_status);
            } catch (statsError) {
                console.warn(`⚠️ Stats decrement failed for job ${deletedFile.job_id}:`, statsError.message);
            }

            // Remove file from processing queue if it exists
            try {
                await queueService.removeFileFromProcessing(fileId);
                console.log(`✅ File ${fileId} removed from processing queue`);
            } catch (queueError) {
                console.warn(`⚠️ Could not remove file ${fileId} from queue: ${queueError.message}`);
            }

            res.json({
                status: "success",
                message: `File ${deletedFile.filename} deleted successfully`,
                data: {
                    fileId: deletedFile.id,
                    filename: deletedFile.filename,
                    jobId: deletedFile.job_id
                }
            });

        } finally {
            client.release();
        }

    } catch (error) {
        console.error('Error deleting file:', error);
        res.status(500).json({
            status: "error",
            message: "Failed to delete file",
            error: error.message
        });
    }
});

// Delete multiple files from job
app.delete("/files", authenticateToken, async (req, res) => {
    try {
        const { fileIds } = req.body;

        if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
            return res.status(400).json({
                status: "error",
                message: "File IDs array is required"
            });
        }

        const deletedFiles = [];
        const errors = [];

        // Get user's organization IDs for access control (with JWT optimization)
        const userOrganizationIds = await getUserOrganizationIds(req.user);

        const client = await pool.connect();
        try {
            for (const fileId of fileIds) {
                try {
                    // Get file details
                    const file = await getFileResult(fileId);
                    if (!file) {
                        errors.push({ fileId, error: "File not found" });
                        continue;
                    }

                    // Check if user has access to this file's job
                    const hasAccess = await userHasJobAccess(
                        file.job_id,
                        req.user.email,
                        req.user.role,
                        userOrganizationIds
                    );

                    if (!hasAccess) {
                        errors.push({ fileId, error: "Access denied" });
                        continue;
                    }

                    // Delete file from database
                    const deleteQuery = `
                        DELETE FROM job_files 
                        WHERE id = $1
                        RETURNING id, filename, job_id
                    `;

                    const deleteResult = await client.query(deleteQuery, [fileId]);

                    if (deleteResult.rows.length > 0) {
                        const deletedFile = deleteResult.rows[0];
                        deletedFiles.push({
                            fileId: deletedFile.id,
                            filename: deletedFile.filename,
                            jobId: deletedFile.job_id
                        });

                        // Phase 4: Decrement stats counters (best-effort)
                        try {
                            await decrementTotal(client, deletedFile.job_id, file.extraction_status, file.processing_status);
                        } catch (statsError) {
                            console.warn(`⚠️ Stats decrement failed for job ${deletedFile.job_id}:`, statsError.message);
                        }

                        // Remove file from processing queue if it exists
                        try {
                            await queueService.removeFileFromProcessing(fileId);
                            console.log(`✅ File ${fileId} removed from processing queue`);
                        } catch (queueError) {
                            console.warn(`⚠️ Could not remove file ${fileId} from queue: ${queueError.message}`);
                        }
                    } else {
                        errors.push({ fileId, error: "File not found" });
                    }

                } catch (fileError) {
                    console.error(`Error deleting file ${fileId}:`, fileError.message);
                    errors.push({ fileId, error: fileError.message });
                }
            }

            res.json({
                status: "success",
                message: `Deleted ${deletedFiles.length} files successfully`,
                data: {
                    deletedFiles,
                    errors: errors.length > 0 ? errors : undefined
                }
            });

        } finally {
            client.release();
        }

    } catch (error) {
        console.error('Error deleting files:', error);
        res.status(500).json({
            status: "error",
            message: "Failed to delete files",
            error: error.message
        });
    }
});

// Reprocess files (re-run AI processing and/or extraction)
app.post("/files/reprocess", authenticateToken, async (req, res) => {
    try {
        const { fileIds, priority = 0, options = {}, processingConfig } = req.body;

        // Validate input
        if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
            return res.status(400).json({
                status: "error",
                message: "File IDs array is required"
            });
        }

        // Parse and validate options with backward compatibility
        // Support both old 'options' format and new 'processingConfig.reprocess' format
        let reprocessOptions = {};

        if (processingConfig && processingConfig.reprocess) {
            // New format: processingConfig.reprocess
            reprocessOptions = processingConfig.reprocess;
        } else {
            // Old format: direct options
            reprocessOptions = options;
        }

        const {
            reExtract = true,      // Default to true (both extraction + AI processing)
            reProcess = true,      // Default to true (both extraction + AI processing)
            forceExtraction = false, // Force extraction even if completed
            preview = false        // Return preview without queuing
        } = reprocessOptions;

        // Validate options
        if (typeof reExtract !== 'boolean' || typeof reProcess !== 'boolean' ||
            typeof forceExtraction !== 'boolean' || typeof preview !== 'boolean') {
            return res.status(400).json({
                status: "error",
                message: "Options must contain boolean values for reExtract, reProcess, forceExtraction, and preview"
            });
        }

        // Validate that at least one operation is requested
        if (!reExtract && !reProcess) {
            return res.status(400).json({
                status: "error",
                message: "At least one of reExtract or reProcess must be true"
            });
        }

        // Get user's organization IDs for access control (with JWT optimization)
        const userOrganizationIds = await getUserOrganizationIds(req.user);

        const queuedFiles = [];
        const skippedFiles = [];
        const errors = [];
        const previewData = [];

        // Process each file ID
        for (const fileId of fileIds) {
            try {
                // Get file details
                const file = await getFileResult(fileId);
                if (!file) {
                    skippedFiles.push({
                        fileId,
                        reason: "File not found"
                    });
                    continue;
                }

                // Check if user has access to this file's job
                const hasAccess = await userHasJobAccess(
                    file.job_id,
                    req.user.email,
                    req.user.role,
                    userOrganizationIds
                );

                if (!hasAccess) {
                    skippedFiles.push({
                        fileId,
                        reason: "Access denied"
                    });
                    continue;
                }

                // Determine what operations will be performed
                const willExtract = reExtract && (forceExtraction || file.extraction_status !== 'completed');
                const willProcess = reProcess && (file.extracted_text || file.markdown || willExtract);

                // Validate file can be reprocessed based on options
                if (reProcess && !willExtract && !file.extracted_text && !file.markdown) {
                    console.log(`File ${fileId} no extracted text available for AI processing`);
                    skippedFiles.push({
                        fileId,
                        reason: "No extracted text available for AI processing"
                    });
                    continue;
                }

                if (reExtract && !forceExtraction && file.extraction_status === 'completed') {
                    console.log(`File ${fileId} extraction already completed (use forceExtraction: true to override)`);
                    skippedFiles.push({
                        fileId,
                        reason: "Extraction already completed (use forceExtraction: true to override)"
                    });
                    continue;
                }

                // Create preview data
                const filePreview = {
                    fileId: file.id,
                    filename: file.filename,
                    jobId: file.job_id,
                    currentStatus: {
                        extraction: file.extraction_status,
                        processing: file.processing_status
                    },
                    operations: {
                        willExtract,
                        willProcess,
                        hasExtractedText: !!(file.extracted_text || file.markdown)
                    }
                };

                previewData.push(filePreview);

                // If preview mode, skip queuing
                if (preview) {
                    continue;
                }

                // Check if file is already in queue
                const isInQueue = await queueService.isFileInQueue(fileId);

                if (isInQueue) {
                    console.log(`File ${fileId} already in processing queue`);
                    skippedFiles.push({
                        fileId,
                        reason: "File already in processing queue"
                    });
                    continue;
                }

                // Check if file is currently being processed
                const isProcessing = await queueService.isFileProcessing(fileId);
                if (isProcessing) {
                    console.log(`File ${fileId} currently being processed`);
                    skippedFiles.push({
                        fileId,
                        reason: "File currently being processed"
                    });
                    continue;
                }

                // Determine queue mode based on operations
                let queueMode;
                if (willExtract && willProcess) {
                    queueMode = forceExtraction ? 'force-full' : 'both';
                } else if (willExtract && !willProcess) {
                    queueMode = 'extraction-only';
                } else if (!willExtract && willProcess) {
                    queueMode = 'reprocess'; // AI processing only (backward compatible)
                }

                // Reset statuses based on operations
                if (willExtract) {
                    await updateFileExtractionStatus(fileId, 'pending');
                    console.log(`File ${fileId} extraction status reset to pending`);
                }
                if (willProcess) {
                    await updateFileProcessingStatus(fileId, 'pending');
                    console.log(`File ${fileId} processing status reset to pending`);
                }

                // Add file to queue with appropriate mode
                await queueService.addFileToQueue(fileId, file.job_id, priority, queueMode);

                console.log(`File ${fileId} added to queue for reprocessing (mode: ${queueMode})`);

                queuedFiles.push({
                    fileId: file.id,
                    filename: file.filename,
                    jobId: file.job_id,
                    mode: queueMode,
                    operations: {
                        willExtract,
                        willProcess
                    }
                });

                console.log(`✅ File ${fileId} queued for reprocessing`);

            } catch (fileError) {
                console.error(`Error processing file ${fileId}:`, fileError.message);
                errors.push({
                    fileId,
                    error: fileError.message
                });
            }
        }

        // Handle preview mode
        if (preview) {
            return res.json({
                status: "success",
                message: `Preview for ${previewData.length} files`,
                data: {
                    preview: previewData,
                    skippedFiles,
                    errors,
                    summary: {
                        total: fileIds.length,
                        preview: previewData.length,
                        skipped: skippedFiles.length,
                        errors: errors.length
                    },
                    options: {
                        reExtract,
                        reProcess,
                        forceExtraction
                    }
                }
            });
        }

        res.json({
            status: "success",
            message: `Queued ${queuedFiles.length} files for reprocessing`,
            data: {
                queuedFiles,
                skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined,
                errors: errors.length > 0 ? errors : undefined,
                summary: {
                    total: fileIds.length,
                    queued: queuedFiles.length,
                    skipped: skippedFiles.length,
                    errors: errors.length
                },
                options: {
                    reExtract,
                    reProcess,
                    forceExtraction
                }
            }
        });

    } catch (error) {
        console.error('❌ Error reprocessing files:', error);
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

// Retry failed file upload
app.post("/files/:fileId/retry-upload", upload.single('file'), async (req, res) => {
    try {
        const { fileId } = req.params;
        const uploadedFile = req.file; // Optional file upload

        // Get file details
        const file = await getFileResult(fileId);
        if (!file) {
            return res.status(404).json({
                status: "error",
                message: `File ${fileId} not found`
            });
        }

        // Check if file is already successfully uploaded
        if (file.upload_status === 'success') {
            return res.status(400).json({
                status: "error",
                message: `File ${fileId} is already successfully uploaded`
            });
        }

        // Check retry limit (max 3 retries)
        const currentRetryCount = file.retry_count || 0;
        if (currentRetryCount >= 3) {
            return res.status(400).json({
                status: "error",
                message: `File ${fileId} has exceeded maximum retry attempts (3)`
            });
        }

        // Update retry count
        await updateFileUploadStatus(fileId, 'retrying', null, null, currentRetryCount + 1);

        let uploadStatus = 'success';
        let uploadError = null;
        let storageType = 's3';
        let s3FileInfo = null;

        // Try to upload to S3 if enabled
        if (s3Service.isCloudStorageEnabled()) {
            try {
                if (uploadedFile) {
                    // User provided a new file, upload it
                    console.log(`🔄 Retrying upload for file ${fileId} with new file: ${uploadedFile.originalname}`);
                    s3FileInfo = await s3Service.uploadFile(uploadedFile, file.job_id);
                    console.log(`✅ New file uploaded to S3: ${s3FileInfo.s3Key}`);

                    // Update database with S3 info
                    await updateFileS3Info(fileId, s3FileInfo.s3Key, s3FileInfo.fileHash);
                    console.log(`✅ Database updated with S3 info for file ${fileId}`);

                    // Add file back to processing queue
                    await queueService.addFileToQueue(fileId, file.job_id);
                    console.log(`✅ File ${fileId} added back to processing queue`);
                } else {
                    // No new file provided, just mark as retry attempt
                    console.log(`🔄 Retrying upload for file ${fileId} (attempt ${currentRetryCount + 1}) - no new file provided`);
                    // For now, we'll simulate a successful retry without actual upload
                    // In a real implementation, you might want to retry with the original file
                }

                await updateFileUploadStatus(fileId, 'success', null, 's3');

                res.json({
                    status: "success",
                    message: uploadedFile
                        ? `File ${fileId} successfully re-uploaded to S3`
                        : `File ${fileId} upload retry initiated`,
                    retryCount: currentRetryCount + 1,
                    newFile: uploadedFile ? {
                        originalName: uploadedFile.originalname,
                        size: uploadedFile.size,
                        s3Key: s3FileInfo?.s3Key
                    } : null
                });
            } catch (s3Error) {
                console.error(`❌ Upload retry failed for file ${fileId}:`, s3Error.message);
                await updateFileUploadStatus(fileId, 'failed', s3Error.message, 'local');

                res.status(500).json({
                    status: "error",
                    message: `Upload retry failed: ${s3Error.message}`,
                    retryCount: currentRetryCount + 1
                });
            }
        } else {
            // S3 disabled, mark as local storage
            await updateFileUploadStatus(fileId, 'success', null, 'local');

            res.json({
                status: "success",
                message: `File ${fileId} marked for local storage`,
                retryCount: currentRetryCount + 1
            });
        }
    } catch (error) {
        console.error('❌ Error retrying file upload:', error);
        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});

const PORT = process.env.PORT || 3000;

// Initialize database and start server
async function startServer() {
    try {
        // Initialize database schema
        await initializeDatabase();

        // Start the server
        server.listen(PORT, () => {
            logger.info(`AI Extractor server running on port ${PORT}`);
            logger.info(`PaddleOCR service URL: ${PADDLEOCR_FLASK_URL}`);
            logger.info(`Socket.IO server ready for connections`);
        });
    } catch (error) {
        logger.error('Failed to start server:', error.message);
        process.exit(1);
    }
}

startServer();
