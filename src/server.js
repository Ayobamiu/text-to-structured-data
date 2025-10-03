import express from "express";
import multer from "multer";
import axios from "axios";
import OpenAI from "openai";
import dotenv from "dotenv";
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
    getFileResult,
    getSystemStats
} from "./database.js";
import queueService from "./queue.js";

dotenv.config();

const app = express();
const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Flask service URL
const FLASK_URL = process.env.FLASK_URL || "http://localhost:5001";

// Initialize S3 service
const s3Service = new S3Service();

app.use(express.json());

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
app.get("/jobs", async (req, res) => {
    try {
        const { limit = 10, offset = 0 } = req.query;
        const jobs = await listJobs(parseInt(limit), parseInt(offset));
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
app.get("/jobs/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const job = await getJobStatus(id);

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

// Get file result
app.get("/files/:id/result", async (req, res) => {
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
app.post("/jobs/:id/files", upload.array("files", 10), async (req, res) => {
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
app.get("/jobs/:id/files", async (req, res) => {
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

// Main extraction endpoint
app.post("/extract", upload.single("file"), async (req, res) => {
    let job = null;
    let fileRecord = null;
    let s3FileInfo = null;

    try {
        console.log("=== EXTRACT ENDPOINT CALLED ===");
        console.log(`Request method: ${req.method}`);
        console.log(`Request files: ${req.file ? req.file.originalname : 'none'}`);
        console.log(`Request body keys: ${Object.keys(req.body)}`);

        const { schema, schemaName, jobName } = req.body;

        if (!req.file) {
            console.error("No file provided in request");
            return res.status(400).json({ error: "No file provided" });
        }

        if (!schema) {
            console.error("No schema provided in request");
            return res.status(400).json({ error: "No schema provided" });
        }

        console.log(`Processing file: ${req.file.originalname}`);
        console.log(`Schema name: ${schemaName || 'default'}`);

        // Step 0: Create job in database
        console.log("Step 0: Creating job in database...");
        job = await createJob(jobName, schema, schemaName);
        console.log(`✅ Job created: ${job.id}`);

        // Step 1: Upload file to S3 (if enabled)
        if (s3Service.isCloudStorageEnabled()) {
            console.log("Step 1: Uploading file to S3...");
            try {
                s3FileInfo = await s3Service.uploadFile(req.file, job.id);
                console.log(`✅ File uploaded to S3: ${s3FileInfo.s3Key}`);
            } catch (s3Error) {
                console.warn(`⚠️ S3 upload failed, continuing with local processing: ${s3Error.message}`);
            }
        }

        // Step 2: Add file record to database
        console.log("Step 2: Adding file record to database...");
        fileRecord = await addFileToJob(
            job.id,
            req.file.originalname,
            req.file.size,
            s3FileInfo?.s3Key || null,
            s3FileInfo?.fileHash || null
        );
        console.log(`✅ File record created: ${fileRecord.id}`);

        // Step 3: Update file extraction status to processing
        await updateFileExtractionStatus(fileRecord.id, 'processing');

        // Step 4: Extract text from PDF using Flask service
        console.log("Step 4: Calling Flask service for text extraction...");
        const FormData = (await import('form-data')).default;
        const fs = (await import('fs')).default;

        const formData = new FormData();
        formData.append("file", fs.createReadStream(req.file.path), {
            filename: req.file.originalname,
            contentType: req.file.mimetype,
        });

        console.log(`Sending request to Flask service: ${FLASK_URL}/extract`);
        const flaskResponse = await axios.post(`${FLASK_URL}/extract`, formData, {
            headers: {
                ...formData.getHeaders(),
            },
        });

        console.log("Flask response received successfully");
        console.log(`Flask response success: ${flaskResponse.data.success}`);

        if (!flaskResponse.data.success) {
            throw new Error(`Flask extraction failed: ${flaskResponse.data.error}`);
        }

        const extractedText = flaskResponse.data.data.pages.map((page) => page.text).join("\n\n");
        console.log(`Extracted text length: ${extractedText.length} characters`);

        // Step 5: Update file extraction status to completed
        await updateFileExtractionStatus(
            fileRecord.id,
            'completed',
            extractedText,
            flaskResponse.data.data.tables || null
        );

        // Step 6: Update file processing status to processing
        await updateFileProcessingStatus(fileRecord.id, 'processing');

        // Step 7: Process with OpenAI
        console.log("Step 7: Processing with OpenAI...");
        const response = await openai.chat.completions.create({
            model: "gpt-4o-2024-08-06",
            messages: [
                {
                    role: "system",
                    content: "You are an expert at structured data extraction. Extract data from the provided text according to the given schema.",
                },
                {
                    role: "user",
                    content: `Extract data from the following text and return it in the schema format:\n\n${extractedText}`,
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

        console.log("OpenAI response received successfully");
        const extractedData = JSON.parse(response.choices[0].message.content);
        console.log("Data extraction completed successfully");

        // Step 8: Update file processing status to completed
        await updateFileProcessingStatus(fileRecord.id, 'completed', extractedData);

        // Step 9: Update job status to completed
        await updateJobStatus(job.id, 'completed');

        console.log("Sending response to client...");
        res.json({
            success: true,
            data: extractedData,
            metadata: {
                jobId: job.id,
                fileId: fileRecord.id,
                filename: req.file.originalname,
                textLength: extractedText.length,
                pagesProcessed: flaskResponse.data.data.metadata.total_pages,
                s3Storage: s3FileInfo ? {
                    s3Key: s3FileInfo.s3Key,
                    fileUrl: s3FileInfo.fileUrl,
                    storageType: s3FileInfo.storageType,
                    fileHash: s3FileInfo.fileHash,
                    expiresAt: s3FileInfo.expiresAt
                } : null
            },
        });

    } catch (error) {
        console.error("Extraction error:", error.message);
        console.error("Error stack:", error.stack);

        // Update file and job status to failed
        if (fileRecord) {
            if (fileRecord.extraction_status === 'processing') {
                await updateFileExtractionStatus(fileRecord.id, 'failed', null, null, error.message);
            } else if (fileRecord.processing_status === 'processing') {
                await updateFileProcessingStatus(fileRecord.id, 'failed', null, error.message);
            }
        }

        if (job) {
            await updateJobStatus(job.id, 'failed');
        }

        res.status(500).json({
            success: false,
            error: error.message,
            jobId: job?.id || null,
            fileId: fileRecord?.id || null
        });
    } finally {
        // Clean up uploaded file
        if (req.file) {
            console.log(`Cleaning up uploaded file: ${req.file.path}`);
            const fs = (await import('fs')).default;
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Error deleting file:', err);
                else console.log('File cleaned up successfully');
            });
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`AI Extractor server running on port ${PORT}`);
    console.log(`Flask service URL: ${FLASK_URL}`);
});
