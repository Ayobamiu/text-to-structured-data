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
import {
    testConnection,
    createJob,
    addFileToJob,
    getJobStatus,
    updateFileExtractionStatus,
    updateFileProcessingStatus,
    updateJobStatus,
    listJobs,
    listJobsByOrganizations,
    getFileResult,
    getSystemStats
} from "./database.js";
import { getUserById } from "./database/users.js";
import { getUserOrganizations } from "./database/userOrganizationMemberships.js";
import queueService from "./queue.js";
import authRoutes from "./routes/auth.js";
import organizationRoutes from "./routes/organizations.js";
import { authenticateToken, optionalAuth, securityHeaders } from "./middleware/auth.js";
import { rateLimitConfig } from "./auth.js";

dotenv.config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:8080'],
        methods: ['GET', 'POST'],
        credentials: true
    }
});

// CORS configuration (must be before security middleware)
app.use(cors({
    origin: ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:8080'],
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

// Authentication routes
app.use('/auth', express.json());
app.use('/auth', authRoutes);

// Organization routes
app.use('/organizations', express.json());
app.use('/organizations', organizationRoutes);

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Join job room for real-time updates
    socket.on('join-job', (jobId) => {
        socket.join(`job-${jobId}`);
        console.log(`📋 Client ${socket.id} joined job room: job-${jobId}`);
    });

    // Leave job room
    socket.on('leave-job', (jobId) => {
        socket.leave(`job-${jobId}`);
        console.log(`📋 Client ${socket.id} left job room: job-${jobId}`);
    });

    socket.on('disconnect', () => {
        console.log(`🔌 Client disconnected: ${socket.id}`);
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
        res.json({
            status: "success",
            message: `File ${fileId} removed from queue`
        });
    } catch (error) {
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

// Add files to existing job
app.post("/jobs/:id/files", authenticateToken, upload.array("files", 10), async (req, res) => {
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
            if (s3Service.isCloudStorageEnabled()) {
                try {
                    s3FileInfo = await s3Service.uploadFile(file, jobId);
                } catch (s3Error) {
                    console.warn(`⚠️ S3 upload failed for ${file.originalname}: ${s3Error.message}`);
                }
            }

            // Add file record to database
            const fileRecord = await addFileToJob(
                jobId,
                file.originalname,
                file.size,
                s3FileInfo?.s3Key || null,
                s3FileInfo?.fileHash || null
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

// Async function to process files in the background
async function processFilesAsync(job, files, schema, schemaName) {
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
                const FormData = (await import('form-data')).default;

                const formData = new FormData();
                formData.append("file", fs.createReadStream(file.path), {
                    filename: file.originalname,
                    contentType: file.mimetype,
                });

                console.log(`Sending request to Flask service: ${FLASK_URL}/extract`);
                const flaskResponse = await axios.post(`${FLASK_URL}/extract`, formData, {
                    headers: {
                        ...formData.getHeaders(),
                    },
                    timeout: 600000, // 10 minutes timeout for large files
                });

                console.log(`Flask response received for ${file.originalname}`);
                console.log(`Flask response success: ${flaskResponse.data.success}`);

                if (!flaskResponse.data.success) {
                    throw new Error(`Flask extraction failed: ${flaskResponse.data.error}`);
                }

                // Extract document data from Flask response
                const documentData = flaskResponse.data.data;
                const markdown = documentData.markdown || "";
                const rawText = documentData.full_text || "";
                const pages = documentData.pages || [];
                const tables = documentData.tables || [];

                console.log(`Document structure: ${pages.length} pages, ${tables.length} tables, ${rawText.length} chars raw text, ${markdown.length} chars markdown`);

                // Use markdown if available, otherwise fallback to raw_text, then concatenated page text
                const extractedText = markdown || rawText || pages.map((page) => page.text).join("\n\n");
                console.log(`Using ${markdown ? 'markdown' : rawText ? 'raw_text' : 'concatenated pages'} - length: ${extractedText.length} characters`);

                // Step 3: Update file extraction status to completed
                await updateFileExtractionStatus(
                    fileRecord.id,
                    'completed',
                    extractedText,
                    tables || null,
                    markdown || null
                );

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
                const contentForAI = markdown || extractedText;
                console.log(`Using ${markdown ? 'markdown' : 'extracted text'} for OpenAI processing (${contentForAI.length} characters)`);

                const response = await openai.chat.completions.create({
                    model: "gpt-4o-2024-08-06",
                    messages: [
                        {
                            role: "system",
                            content: "You are an expert at structured data extraction from documents. Extract data accurately according to the provided schema, paying attention to document structure, tables, and contextual relationships.",
                        },
                        {
                            role: "user",
                            content: `Extract structured data from this document according to the provided schema:\n\n${contentForAI}`,
                        },
                    ],
                    response_format: {
                        type: "json_schema",
                        json_schema: {
                            name: schemaName || "data_extraction",
                            schema: JSON.parse(schema),
                        },
                    },
                });

                console.log(`OpenAI response received for ${file.originalname}`);
                const extractedData = JSON.parse(response.choices[0].message.content);
                console.log(`OpenAI processing completed for ${file.originalname}`);

                // Step 6: Update file processing status to completed
                await updateFileProcessingStatus(fileRecord.id, 'completed', extractedData);

                // Emit file processing completed event
                io.to(`job-${job.id}`).emit('file-status-update', {
                    jobId: job.id,
                    fileId: fileRecord.id,
                    filename: file.originalname,
                    extraction_status: 'completed',
                    processing_status: 'completed',
                    message: `Successfully processed ${file.originalname}`,
                    result: extractedData
                });

                console.log(`✅ Successfully processed ${file.originalname}`);

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

                // Update file status to failed
                if (fileRecord.extraction_status === 'processing') {
                    await updateFileExtractionStatus(fileRecord.id, 'failed', null, null, fileError.message);
                } else if (fileRecord.processing_status === 'processing') {
                    await updateFileProcessingStatus(fileRecord.id, 'failed', null, fileError.message);
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
app.post("/extract", authenticateToken, upload.array("files", 10), async (req, res) => {
    let job = null;
    const fileRecords = [];
    const processedFiles = [];

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

        const { schema, schemaName, jobName } = req.body;

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

        job = await createJob(jobName, schema, schemaName, req.user.id, organizationId);
        console.log(`✅ Job created: ${job.id}`);

        // Step 1: Create file records immediately for better UX
        console.log("Step 1: Creating file records...");
        const fileRecords = [];
        const initialFileData = [];

        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];

            // Upload to S3 first (if enabled)
            let s3FileInfo = null;
            if (s3Service.isCloudStorageEnabled()) {
                try {
                    s3FileInfo = await s3Service.uploadFile(file, job.id);
                    console.log(`✅ File uploaded to S3: ${s3FileInfo.s3Key}`);
                } catch (s3Error) {
                    console.warn(`⚠️ S3 upload failed, continuing with local processing: ${s3Error.message}`);
                }
            }

            // Create file record
            const fileRecord = await addFileToJob(
                job.id,
                file.originalname,
                file.size,
                s3FileInfo?.s3Key || null,
                s3FileInfo?.fileHash || null
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
        processFilesAsync(job, req.files, schema, schemaName).catch(error => {
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`AI Extractor server running on port ${PORT}`);
    console.log(`Flask service URL: ${FLASK_URL}`);
    console.log(`🔌 Socket.IO server ready for connections`);
});
