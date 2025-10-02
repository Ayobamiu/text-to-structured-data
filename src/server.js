import express from "express";
import multer from "multer";
import axios from "axios";
import OpenAI from "openai";
import dotenv from "dotenv";
import S3Service from "./s3Service.js";

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

// Main extraction endpoint
app.post("/extract", upload.single("file"), async (req, res) => {
    let s3FileInfo = null;

    try {
        console.log("=== EXTRACT ENDPOINT CALLED ===");
        console.log(`Request method: ${req.method}`);
        console.log(`Request files: ${req.file ? req.file.originalname : 'none'}`);
        console.log(`Request body keys: ${Object.keys(req.body)}`);

        const { schema, schemaName } = req.body;

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

        // Step 0: Upload file to S3 (if enabled)
        if (s3Service.isCloudStorageEnabled()) {
            console.log("Step 0: Uploading file to S3...");
            try {
                const jobId = `extract_${Date.now()}_${Math.random().toString(36).substring(2)}`;
                s3FileInfo = await s3Service.uploadFile(req.file, jobId);
                console.log(`✅ File uploaded to S3: ${s3FileInfo.s3Key}`);
            } catch (s3Error) {
                console.warn(`⚠️ S3 upload failed, continuing with local processing: ${s3Error.message}`);
            }
        }

        // Step 1: Extract text from PDF using Flask service
        console.log("Step 1: Calling Flask service for text extraction...");
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

        // Step 2: Process with OpenAI
        console.log("Step 2: Processing with OpenAI...");
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

        console.log("Sending response to client...");
        res.json({
            success: true,
            data: extractedData,
            metadata: {
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
        res.status(500).json({
            success: false,
            error: error.message,
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
