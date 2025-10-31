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
import S3Service from "./s3Service.js";
import pool, {
    testConnection,
    createJob,
    addFileToJob,
    getJobStatus,
    updateFileExtractionStatus,
    updateFileProcessingStatus,
    updateJobStatus,
    listJobs,
    getJobFileStats,
    getJobFilesByStatus,
    listJobsByOrganizations,
    getFileResult,
    getSystemStats,
    updateFileUploadStatus,
    updateFileS3Info,
    getAllFiles,
    updateFileVerification
} from "./database.js";
import { getUserById } from "./database/users.js";
import { getUserOrganizations } from "./database/userOrganizationMemberships.js";
import { initializeDatabase } from "./database/init.js";
import queueService from "./queue.js";
import authRoutes from "./routes/auth.js";
import organizationRoutes from "./routes/organizations.js";
import previewRoutes, { setWebSocketInstance } from "./routes/previews.js";
import healthRoutes from "./routes/health.js";
import { authenticateToken, optionalAuth, securityHeaders, requireRole } from "./middleware/auth.js";
import { rateLimitConfig } from "./auth.js";
import logger from "./utils/logger.js";
import { processWithOpenAI } from "./utils/openaiProcessor.js";
import ExtractionService from "./services/extractionService.js";

dotenv.config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: [
            'http://localhost:3001',
            'http://localhost:3002',
            'http://localhost:8080',
            'https://workspace.coreextract.app'
        ],
        methods: ['GET', 'POST'],
        credentials: true
    }
});

// Set WebSocket instance for preview routes
setWebSocketInstance(io);

// CORS configuration (must be before security middleware)
app.use(cors({
    origin: [
        'http://localhost:3001',
        'http://localhost:3002',
        'http://localhost:8080',
        'https://workspace.coreextract.app'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
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
const FLASK_URL = process.env.FLASK_URL || "http://localhost:5001";

// Initialize S3 service
const s3Service = new S3Service();

// Initialize extraction service
const extractionService = new ExtractionService();

// Authentication routes
app.use('/auth', express.json());
app.use('/auth', authRoutes);

// Organization routes
app.use('/organizations', express.json());
app.use('/organizations', organizationRoutes);

// Preview routes
app.use('/previews', express.json());
app.use('/previews', previewRoutes);

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

    // Handle events from worker process
    socket.on('file-status-update', (data) => {
        logger.info(`Received file-status-update from worker:`, data);
        // Broadcast to all clients in the job room
        io.to(`job-${data.jobId}`).emit('file-status-update', data);
        logger.info(`Broadcasted file-status-update to job-${data.jobId}`);
    });

    socket.on('job-status-update', (data) => {
        logger.info(`Received job-status-update from worker:`, data);
        // Broadcast to all clients in the job room
        io.to(`job-${data.jobId}`).emit('job-status-update', data);
        logger.info(`Broadcasted job-status-update to job-${data.jobId}`);
    });
});


// Apply JSON parsing only to specific routes (not multipart routes)
app.use('/jobs', express.json());
app.use('/queue', express.json());
app.use('/system-stats', express.json());
app.use('/test-db', express.json());
app.use('/test-redis', express.json());
app.use('/test-s3', express.json());
app.use('/storage-stats', express.json());
app.use('/files', express.json());

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

// Redis connection test
app.get("/test-redis", async (req, res) => {
    try {
        const result = await queueService.testConnection();
        res.json({
            status: "success",
            redis: {
                connected: result,
                message: result ? "Redis connection successful" : "Redis connection failed"
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
        const client = await queueService.connect();
        const queueItems = await client.zRange(queueService.queueKey, 0, -1);
        const isInQueue = queueItems.some(item => {
            try {
                const data = JSON.parse(item);
                return data.fileId === fileId;
            } catch {
                return false;
            }
        });

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

// List jobs
app.get("/jobs", authenticateToken, async (req, res) => {
    try {
        const { limit = 10, offset = 0 } = req.query;

        // Get user's organizations using the membership system
        const userOrganizations = await getUserOrganizations(req.user.id);
        const organizationIds = userOrganizations.map(org => org.id);

        if (organizationIds.length === 0) {
            return res.json({
                status: "success",
                jobs: []
            });
        }

        // Get jobs for all organizations the user belongs to
        const jobs = await listJobsByOrganizations(parseInt(limit), parseInt(offset), organizationIds);
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

// Get job status
app.get("/jobs/:id", authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const job = await getJobStatus(id);

        if (!job) {
            return res.status(404).json({
                status: "error",
                message: "Job not found"
            });
        }

        // Check if user has access to this job's organization
        const userOrganizations = await getUserOrganizations(req.user.id);
        const userOrganizationIds = userOrganizations.map(org => org.id);

        if (job.organization_id && !userOrganizationIds.includes(job.organization_id)) {
            return res.status(403).json({
                status: "error",
                message: "Access denied to this job"
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

        // Check if user has access to this job's organization
        const job = await getJobStatus(id);
        if (!job) {
            return res.status(404).json({
                status: "error",
                message: "Job not found"
            });
        }

        const userOrganizations = await getUserOrganizations(req.user.id);
        const userOrganizationIds = userOrganizations.map(org => org.id);

        if (job.organization_id && !userOrganizationIds.includes(job.organization_id)) {
            return res.status(403).json({
                status: "error",
                message: "Access denied to this job"
            });
        }

        // Update schema in database
        const client = await pool.connect();
        try {
            const updateQuery = `
                UPDATE jobs 
                SET schema_data = $1, updated_at = NOW()
                WHERE id = $2
                RETURNING id, schema_data
            `;

            // Preserve the original structure with schemaName
            const existingJob = await getJobStatus(id);
            const schemaData = {
                schema: schema,
                schemaName: existingJob.schema_data?.schemaName || 'data_extraction'
            };

            const result = await client.query(updateQuery, [JSON.stringify(schemaData), id]);

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
                    schema: result.rows[0].schema_data
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

// Get file result
app.get("/files/:id/result", authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const file = await getFileResult(id);

        if (!file) {
            return res.status(404).json({
                status: "error",
                message: "File not found"
            });
        }

        res.json({
            status: "success",
            file
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

            // Check if user has access to this file's job organization
            const job = await getJobStatus(file.job_id);
            if (!job) {
                return res.status(404).json({
                    status: "error",
                    message: "Job not found"
                });
            }

            const userOrganizations = await getUserOrganizations(req.user.id);
            const userOrganizationIds = userOrganizations.map(org => org.id);

            if (job.organization_id && !userOrganizationIds.includes(job.organization_id)) {
                return res.status(403).json({
                    status: "error",
                    message: "Access denied to this file"
                });
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

// Update file results endpoint
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
        if (!file) {
            return res.status(404).json({
                status: "error",
                message: "File not found"
            });
        }

        // Check if user has access to this file's job organization
        const job = await getJobStatus(file.job_id);
        if (!job) {
            return res.status(404).json({
                status: "error",
                message: "Job not found"
            });
        }

        const userOrganizations = await getUserOrganizations(req.user.id);
        const userOrganizationIds = userOrganizations.map(org => org.id);

        if (job.organization_id && !userOrganizationIds.includes(job.organization_id)) {
            return res.status(403).json({
                status: "error",
                message: "Access denied to this file"
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

        // Update file results in database
        const client = await pool.connect();
        try {
            const updateQuery = `
                UPDATE job_files 
                SET result = $1, updated_at = NOW()
                WHERE id = $2
                RETURNING id, filename, result
            `;

            const updateResult = await client.query(updateQuery, [
                JSON.stringify(parsedResults),
                id
            ]);

            if (updateResult.rows.length === 0) {
                return res.status(404).json({
                    status: "error",
                    message: "File not found"
                });
            }

            const updatedFile = updateResult.rows[0];

            // Emit file update event via WebSocket
            io.to(`job-${file.job_id}`).emit('file-status-update', {
                jobId: file.job_id,
                fileId: updatedFile.id,
                filename: updatedFile.filename,
                result: parsedResults,
                message: `File results updated for ${updatedFile.filename}`,
                updated_at: new Date().toISOString()
            });

            // Create log entry for the update
            await createLogAndEmit(file.job_id, updatedFile.id, 'info', `File results updated for ${updatedFile.filename}`, updatedFile.filename);

            res.json({
                status: "success",
                message: `File results updated successfully for ${updatedFile.filename}`,
                data: {
                    fileId: updatedFile.id,
                    filename: updatedFile.filename,
                    results: parsedResults
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

        const result = await updateFileVerification(
            id,
            updateData.adminVerified !== undefined ? updateData.adminVerified : null,
            updateData.customerVerified !== undefined ? updateData.customerVerified : null
        );

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

// Add files to existing job
app.post("/jobs/:id/files", authenticateToken, upload.array("files", 20), async (req, res) => {
    try {
        const { id: jobId } = req.params;
        const { schema, schemaName } = req.body;

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({
                status: "error",
                message: "No files provided"
            });
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

            // Add file record to database
            const fileRecord = await addFileToJob(
                jobId,
                file.originalname,
                file.size,
                s3FileInfo?.s3Key || null,
                s3FileInfo?.fileHash || null,
                uploadStatus,
                uploadError,
                storageType
            );

            // Add file to processing queue
            await queueService.addFileToQueue(fileRecord.id, jobId);
            console.log(`✅ File ${fileRecord.id} added to processing queue`);

            addedFiles.push({
                id: fileRecord.id,
                filename: fileRecord.filename,
                size: fileRecord.size,
                s3Key: fileRecord.s3_key,
                fileHash: fileRecord.file_hash
            });

            // Clean up uploaded file
            const fs = (await import('fs')).default;
            fs.unlink(file.path, (err) => {
                if (err) console.error('Error deleting file:', err);
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

        // Verify job exists
        const job = await getJobStatus(jobId);
        if (!job) {
            return res.status(404).json({
                status: "error",
                message: "Job not found"
            });
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

        // Verify job exists
        const job = await getJobStatus(jobId);
        if (!job) {
            return res.status(404).json({
                status: "error",
                message: "Job not found"
            });
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

// Get all files across all jobs
app.get("/files", authenticateToken, async (req, res) => {
    try {
        const { limit = 50, offset = 0, status, jobId } = req.query;

        // Restrict by user's organizations
        const userOrganizations = await getUserOrganizations(req.user.id);
        const organizationIds = userOrganizations.map(org => org.id);

        const result = await getAllFiles(
            parseInt(limit),
            parseInt(offset),
            status || null,
            jobId || null,
            organizationIds
        );

        res.json({
            status: "success",
            files: result.files,
            total: result.total,
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

// Async function to process files in the background
async function processFilesAsync(job, files, schema, schemaName, processingConfig) {
    try {
        console.log(`🔄 Starting background processing for job ${job.id} with ${files.length} files`);

        // Emit job started event
        io.to(`job-${job.id}`).emit('job-status-update', {
            jobId: job.id,
            status: 'processing',
            message: `Processing ${files.length} files...`
        });

        // Get existing file records for this job
        const jobDetails = await getJobStatus(job.id);
        const fileRecords = jobDetails.files;

        // Process each file
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileRecord = fileRecords[i]; // Use existing file record

            try {
                console.log(`\n--- Processing file ${i + 1}/${files.length}: ${file.originalname} ---`);

                // Emit file processing started event
                io.to(`job-${job.id}`).emit('file-status-update', {
                    jobId: job.id,
                    fileId: fileRecord.id,
                    filename: file.originalname,
                    extraction_status: 'processing',
                    processing_status: 'pending',
                    message: `Starting extraction for ${file.originalname}...`
                });

                // Step 1: Update file extraction status to processing
                console.log(`Step 1: Updating extraction status for ${file.originalname}...`);
                console.log(`File record ID: ${fileRecord.id}`);
                console.log(`File path: ${file.path}`);
                const fs = (await import('fs')).default;
                console.log(`File exists: ${fs.existsSync(file.path)}`);
                await updateFileExtractionStatus(fileRecord.id, 'processing');
                console.log(`✅ Step 1 completed for ${file.originalname}`);

                // Step 2: Extract text from PDF using Flask service
                console.log(`Step 2: Calling Flask service for text extraction of ${file.originalname}...`);
                // Add extraction method from processing config
                const eToJSON = typeof processingConfig === 'string' ? JSON.parse(processingConfig) : processingConfig;
                const jobProcessingConfig = typeof job.processing_config === 'string' ? JSON.parse(job.processing_config) : job.processing_config;
                const extractionMethod = eToJSON?.extraction?.method || jobProcessingConfig?.extraction?.method || 'mineru';
                const extractionResult = await extractionService.extractText(file.path, file.originalname, extractionMethod);
                const extractionTimeSeconds = extractionResult.extraction_time_seconds || 0
                if (!extractionResult.success) {
                    throw new Error(`Extraction failed: ${extractionResult.error}`);
                }

                // Extract document data from Flask response
                const markdown = extractionResult.markdown || "";
                const rawText = extractionResult.text || "";
                const pages = extractionResult.pages || [];
                const tables = extractionResult.tables || [];

                console.log(`Document structure: ${pages.length} pages, ${tables.length} tables, ${rawText.length} chars raw text, ${markdown.length} chars markdown`);
                console.log(`Extraction completed in ${extractionTimeSeconds.toFixed(2)} seconds`);

                // Step 3: Update file extraction status to completed with timing
                await updateFileExtractionStatus(
                    fileRecord.id,
                    'completed',
                    rawText,
                    tables || null,
                    markdown || null,
                    pages || null,
                    null, // error
                    extractionTimeSeconds
                );

                // Check if this is a text-only extraction job
                if (job.extraction_mode === 'text_only') {
                    console.log(`📝 Text-only mode: Skipping AI processing for ${file.originalname}`);

                    // Mark processing as completed without AI processing
                    await updateFileProcessingStatus(fileRecord.id, 'completed', null, null, {
                        mode: 'text_only',
                        extracted_text: rawText,
                        extracted_tables: tables,
                        markdown: markdown,
                        pages: pages
                    });

                    // Emit file processing completed event
                    io.to(`job-${job.id}`).emit('file-status-update', {
                        jobId: job.id,
                        fileId: fileRecord.id,
                        filename: file.originalname,
                        extraction_status: 'completed',
                        processing_status: 'completed',
                        message: `Text extraction completed for ${file.originalname} (text-only mode)`
                    });

                    console.log(`✅ Text-only processing completed for ${file.originalname}`);
                } else {
                    // Full extraction mode - continue with AI processing
                    console.log(`🤖 Full extraction mode: Processing ${file.originalname} with AI...`);

                    // Emit extraction completed event
                    io.to(`job-${job.id}`).emit('file-status-update', {
                        jobId: job.id,
                        fileId: fileRecord.id,
                        filename: file.originalname,
                        extraction_status: 'completed',
                        processing_status: 'processing',
                        message: `Extraction completed for ${file.originalname}. Starting AI processing...`
                    });

                    // Step 4: Update file processing status to processing
                    await updateFileProcessingStatus(fileRecord.id, 'processing');

                    // Step 5: Process with OpenAI using markdown content
                    console.log(`Step 5: Processing ${file.originalname} with OpenAI using markdown content...`);

                    // Use markdown content for better AI processing
                    const contentForAI = markdown || rawText;
                    console.log(`Using ${markdown ? 'markdown' : 'extracted text'} for OpenAI processing (${contentForAI.length} characters)`);

                    // Step 5: Process with OpenAI using shared function
                    console.log(`Step 5: Processing ${file.originalname} with OpenAI using shared processor...`);

                    const processingResult = await processWithOpenAI(contentForAI, {
                        schemaName: schemaName || "data_extraction",
                        schema: typeof schema === 'string' ? JSON.parse(schema) : schema
                    });
                    const aiProcessingTimeSeconds = processingResult.metadata?.processing_time_seconds || 0;

                    if (!processingResult.success) {
                        throw new Error(`OpenAI processing failed: ${processingResult.error}`);
                    }

                    console.log(`OpenAI processing completed for ${file.originalname} in ${aiProcessingTimeSeconds.toFixed(2)} seconds`);

                    // Step 6: Update file processing status to completed with timing
                    await updateFileProcessingStatus(fileRecord.id, 'completed', processingResult.data, null, processingResult.metadata, aiProcessingTimeSeconds);

                    // Emit file processing completed event
                    io.to(`job-${job.id}`).emit('file-status-update', {
                        jobId: job.id,
                        fileId: fileRecord.id,
                        filename: file.originalname,
                        extraction_status: 'completed',
                        processing_status: 'completed',
                        message: `Successfully processed ${file.originalname}`,
                        result: processingResult.data
                    });
                }

            } catch (fileError) {
                console.error(`Error processing file ${file.originalname}:`, fileError.message);

                // Emit file error event
                io.to(`job-${job.id}`).emit('file-status-update', {
                    jobId: job.id,
                    fileId: fileRecord.id,
                    filename: file.originalname,
                    extraction_status: fileRecord.extraction_status === 'processing' ? 'failed' : fileRecord.extraction_status,
                    processing_status: fileRecord.processing_status === 'processing' ? 'failed' : fileRecord.processing_status,
                    message: `Error processing ${file.originalname}: ${fileError.message}`,
                    error: fileError.message
                });

                // Update file status to failed with timing
                if (fileRecord.extraction_status === 'processing') {
                    // Calculate partial extraction time if extraction was started
                    const partialExtractionTime = 0
                    await updateFileExtractionStatus(fileRecord.id, 'failed', null, null, null, null, fileError.message, partialExtractionTime);
                } else if (fileRecord.processing_status === 'processing') {
                    // Calculate partial AI processing time if AI processing was started
                    const partialAiProcessingTime = 0;
                    await updateFileProcessingStatus(fileRecord.id, 'failed', null, fileError.message, null, partialAiProcessingTime);
                }
            } finally {
                // Clean up uploaded file
                console.log(`Cleaning up uploaded file: ${file.path}`);
                const fs = (await import('fs')).default;
                fs.unlink(file.path, (err) => {
                    if (err) console.error('Error deleting file:', err);
                    else console.log('File cleaned up successfully');
                });
            }
        }

        // Update job status based on results
        const updatedJobDetails = await getJobStatus(job.id);
        const completedFiles = updatedJobDetails.files.filter(f => f.processing_status === 'completed').length;
        const jobStatus = completedFiles === files.length ? 'completed' :
            completedFiles > 0 ? 'partial' : 'failed';

        await updateJobStatus(job.id, jobStatus);

        // Emit job completion event
        io.to(`job-${job.id}`).emit('job-status-update', {
            jobId: job.id,
            status: jobStatus,
            message: `Job completed: ${completedFiles}/${files.length} files processed successfully`,
            completedFiles,
            totalFiles: files.length
        });

        console.log(`\n=== BACKGROUND PROCESSING COMPLETE ===`);
        console.log(`Job ID: ${job.id}`);
        console.log(`Files processed: ${completedFiles}/${files.length}`);
        console.log(`Job status: ${jobStatus}`);

    } catch (error) {
        console.error("Background processing error:", error.message);

        // Emit job error event
        io.to(`job-${job.id}`).emit('job-status-update', {
            jobId: job.id,
            status: 'failed',
            message: `Job failed: ${error.message}`,
            error: error.message
        });

        // Update job status to failed
        await updateJobStatus(job.id, 'failed');
    }
}

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

        const { schema, schemaName, jobName, extractionMode = 'full_extraction', processingConfig } = req.body;

        if (!req.files || req.files.length === 0) {
            console.error("No files provided in request");
            return res.status(400).json({ error: "No files provided" });
        }

        if (!schema) {
            console.error("No schema provided in request");
            return res.status(400).json({ error: "No schema provided" });
        }

        console.log(`Processing ${req.files.length} files`);
        console.log(`Schema name: ${schemaName || 'default'}`);

        // Step 0: Create job in database
        console.log("Step 0: Creating job in database...");
        // Get user's organizations using the membership system
        const userOrganizations = await getUserOrganizations(req.user.id);
        const organizationId = userOrganizations.length > 0 ? userOrganizations[0].id : null;

        if (!organizationId) {
            console.error("❌ User has no organizations");
            return res.status(400).json({
                error: "User must be part of an organization to create jobs"
            });
        }

        // Set default processing config if not provided
        const defaultProcessingConfig = {
            extraction: { method: 'mineru', options: {} },
            processing: { method: 'openai', model: 'gpt-4o', options: {} }
        };

        const finalProcessingConfig = processingConfig || defaultProcessingConfig;

        job = await createJob(jobName, schema, schemaName, req.user.id, organizationId, extractionMode, finalProcessingConfig);
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

            // Create file record
            const fileRecord = await addFileToJob(
                job.id,
                file.originalname,
                file.size,
                s3FileInfo?.s3Key || null,
                s3FileInfo?.fileHash || null,
                uploadStatus,
                uploadError,
                storageType
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
                s3Storage: s3FileInfo ? {
                    s3Key: s3FileInfo.s3Key,
                    fileUrl: s3FileInfo.fileUrl,
                    storageType: s3FileInfo.storageType,
                    fileHash: s3FileInfo.fileHash,
                    expiresAt: s3FileInfo.expiresAt
                } : null
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

        // Process files asynchronously in the background
        console.log(`🚀 Starting background processing for job ${job.id} with ${req.files.length} files`);
        processFilesAsync(job, req.files, schema, schemaName, finalProcessingConfig).catch(error => {
            console.error(`❌ Background processing failed for job ${job.id}:`, error.message);
            console.error(`❌ Error stack:`, error.stack);
        });
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

        // Get file details first
        const file = await getFileResult(fileId);
        if (!file) {
            return res.status(404).json({
                status: "error",
                message: "File not found"
            });
        }

        // Check if user has access to this file's job organization
        const job = await getJobStatus(file.job_id);
        if (!job) {
            return res.status(404).json({
                status: "error",
                message: "Job not found"
            });
        }

        const userOrganizations = await getUserOrganizations(req.user.id);
        const userOrganizationIds = userOrganizations.map(org => org.id);

        if (job.organization_id && !userOrganizationIds.includes(job.organization_id)) {
            return res.status(403).json({
                status: "error",
                message: "Access denied to this file"
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

        // Get user's organizations for access control
        const userOrganizations = await getUserOrganizations(req.user.id);
        const userOrganizationIds = userOrganizations.map(org => org.id);

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

                    // Check if user has access to this file's job organization
                    const job = await getJobStatus(file.job_id);
                    if (!job) {
                        errors.push({ fileId, error: "Job not found" });
                        continue;
                    }

                    if (job.organization_id && !userOrganizationIds.includes(job.organization_id)) {
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

        // Get user's organizations for access control
        const userOrganizations = await getUserOrganizations(req.user.id);
        const userOrganizationIds = userOrganizations.map(org => org.id);

        if (userOrganizationIds.length === 0) {
            return res.status(403).json({
                status: "error",
                message: "User must be part of an organization to reprocess files"
            });
        }

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

                // Check if user has access to this file's job organization
                const job = await getJobStatus(file.job_id);
                if (!job) {
                    skippedFiles.push({
                        fileId,
                        reason: "Job not found"
                    });
                    continue;
                }

                if (job.organization_id && !userOrganizationIds.includes(job.organization_id)) {
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
                const client = await queueService.connect();
                const queueItems = await client.zRange(queueService.queueKey, 0, -1);
                const isInQueue = queueItems.some(item => {
                    try {
                        const data = JSON.parse(item);
                        return data.fileId === fileId;
                    } catch {
                        return false;
                    }
                });

                if (isInQueue) {
                    console.log(`File ${fileId} already in processing queue`);
                    skippedFiles.push({
                        fileId,
                        reason: "File already in processing queue"
                    });
                    continue;
                }

                // Check if file is currently being processed
                const isProcessing = await client.hExists(queueService.processingKey, fileId);
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
            logger.info(`Flask service URL: ${FLASK_URL}`);
            logger.info(`Socket.IO server ready for connections`);
        });
    } catch (error) {
        logger.error('Failed to start server:', error.message);
        process.exit(1);
    }
}

startServer();
