import axios from 'axios';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import queueService from './queue.js';
import {
    getJobStatus,
    updateFileExtractionStatus,
    updateFileProcessingStatus,
    updateJobStatus
} from './database.js';
import S3Service from './s3Service.js';

dotenv.config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const FLASK_URL = process.env.FLASK_URL || "http://localhost:5001";
const WORKER_INTERVAL_MS = parseInt(process.env.WORKER_INTERVAL_MS || '5000'); // Poll every 5 seconds
const MAX_RETRIES = parseInt(process.env.WORKER_MAX_RETRIES || '3');

class FileProcessorWorker {
    constructor() {
        this.isRunning = false;
        this.processedCount = 0;
        this.errorCount = 0;
        this.startTime = new Date();
        this.s3Service = new S3Service();
    }
    async start() {
        if (this.isRunning) {
            console.log('Worker is already running.');
            return;
        }

        this.isRunning = true;
        console.log('🚀 Starting File Processor Worker...');

        // Test connections
        await this.testConnections();

        console.log('✅ Worker started successfully');
        this.pollQueue();
    }
    async stop() {
        if (!this.isRunning) {
            console.log('Worker is not running.');
            return;
        }

        this.isRunning = false;
        console.log('🛑 Stopping File Processor Worker...');
        this.logWorkerStats();

        // Disconnect from Redis
        await queueService.disconnect();
    }

    async testConnections() {
        // Test Redis connection
        const isRedisConnected = await queueService.testConnection();
        if (!isRedisConnected) {
            throw new Error('Redis connection failed. Worker cannot start.');
        }

        // Test S3 connection
        if (this.s3Service.isCloudStorageEnabled()) {
            const s3Connection = await this.s3Service.testConnection();
            if (!s3Connection.connected) {
                console.warn('⚠️ S3 connection failed, but worker will continue');
            }
        }

        console.log('✅ All connections tested successfully');
    }

    logWorkerStats() {
        const durationMs = new Date().getTime() - this.startTime.getTime();
        const durationSeconds = Math.floor(durationMs / 1000);
        console.log('📊 Worker Statistics:');
        console.log(`   - Processed: ${this.processedCount} files`);
        console.log(`   - Errors: ${this.errorCount}`);
        console.log(`   - Duration: ${durationSeconds} seconds`);
    }

    async pollQueue() {
        while (this.isRunning) {
            try {
                const queueItem = await queueService.getNextFile();
                if (queueItem) {
                    await this.processFile(queueItem);
                } else {
                    // No files in queue, wait before checking again
                    await new Promise(resolve => setTimeout(resolve, WORKER_INTERVAL_MS));
                }
            } catch (error) {
                console.error('❌ Error polling queue:', error.message);
                this.errorCount++;

                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, WORKER_INTERVAL_MS));
            }
        }
    }

    async processFile(queueItem) {
        const { fileId, jobId, retries } = queueItem;
        console.log(`🔄 Processing file: ${fileId} (attempt ${retries + 1})`);

        try {
            // Mark file as processing
            await queueService.markFileAsProcessing(fileId);
            // Get job and file details
            const job = await getJobStatus(jobId);
            if (!job) {
                throw new Error(`Job ${jobId} not found for file ${fileId}`);
            }

            const file = job.files.find(f => f.id === fileId);
            if (!file) {
                throw new Error(`File ${fileId} not found in job ${jobId}`);
            }

            // Stage 1: Extract text from file
            console.log(`📄 Stage 1: Extracting text from ${file.filename}`);
            await updateFileExtractionStatus(file.id, 'processing');

            const extractionResult = await this.extractTextFromFile(file);

            if (!extractionResult.success) {
                throw new Error(`Extraction failed: ${extractionResult.error}`);
            }

            // Update extraction status
            await updateFileExtractionStatus(
                file.id,
                'completed',
                extractionResult.text,
                extractionResult.tables
            );
            console.log(`✅ File ${file.filename} extraction completed`);

            // Stage 2: Process with OpenAI
            console.log(`🤖 Stage 2: Processing extracted data with OpenAI`);
            await updateFileProcessingStatus(file.id, 'processing');
            // Parse schema data if it's a string
            let schemaData = job.schema_data;
            if (typeof schemaData === 'string') {
                try {
                    schemaData = JSON.parse(schemaData);
                } catch (parseError) {
                    throw new Error(`Invalid schema data: ${parseError.message}`);
                }
            }

            // Parse the nested schema string if it exists
            if (schemaData && schemaData.schema && typeof schemaData.schema === 'string') {
                try {
                    schemaData.schema = JSON.parse(schemaData.schema);
                } catch (parseError) {
                    throw new Error(`Invalid nested schema: ${parseError.message}`);
                }
            }

            const processingResult = await this.processWithOpenAI(
                extractionResult.text,
                schemaData
            );

            if (processingResult.success) {
                await updateFileProcessingStatus(file.id, 'completed', processingResult.data);
                console.log(`✅ File ${file.filename} processing completed successfully`);
                this.processedCount++;
            } else {
                throw new Error(`OpenAI processing failed: ${processingResult.error}`);
            }

            // Remove from processing
            await queueService.removeFileFromProcessing(file.id);
            console.log(`🗑️ File ${file.id} processing completed`);

        } catch (error) {
            console.error('❌ Error processing file:', error.message);
            this.errorCount++;

            // Handle retries
            if (retries < MAX_RETRIES) {
                console.log(`🔄 Retrying file ${fileId}. Attempt ${retries + 1} of ${MAX_RETRIES}`);
                const retrySuccess = await queueService.retryFile(fileId, jobId);

                if (retrySuccess) {
                    // Update status to reflect retry
                    await updateFileExtractionStatus(fileId, 'pending', null, null, error.message);
                } else {
                    // Max retries reached
                    await updateFileExtractionStatus(fileId, 'failed', null, null, error.message);
                    await queueService.removeFileFromProcessing(fileId);
                }
            } else {
                console.error(`❌ Max retries reached for file ${fileId}. Marking as failed.`);
                await updateFileExtractionStatus(fileId, 'failed', null, null, error.message);
                await queueService.removeFileFromProcessing(fileId);
            }
        }
    }

    async extractTextFromFile(file) {
        try {
            console.log(`📄 Extracting text from: ${file.filename}`);
            // Check if file is stored in S3
            if (file.s3_key && this.s3Service.isCloudStorageEnabled()) {
                return await this.extractFromS3File(file);
            } else {
                // File is not available for processing
                throw new Error('File not available for processing (not in S3)');
            }

        } catch (error) {
            console.error('❌ Text extraction error:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async extractFromS3File(file) {
        try {
            console.log(`📄 Processing S3 file: ${file.s3_key}`);

            // Download file from S3
            const fileBuffer = await this.s3Service.downloadFile(file.s3_key);

            // Create temporary file
            const fs = (await import('fs')).default;
            const path = (await import('path')).default;
            const tempPath = path.join('uploads', `temp_${file.id}_${Date.now()}`);

            fs.writeFileSync(tempPath, fileBuffer);

            try {
                // Use Flask service for PDF processing
                const FormData = (await import('form-data')).default;
                const formData = new FormData();
                formData.append("file", fs.createReadStream(tempPath), {
                    filename: file.filename,
                    contentType: "application/pdf",
                });

                console.log(`🌐 Calling Flask service: ${FLASK_URL}/extract`);
                const response = await axios.post(`${FLASK_URL}/extract`, formData, {
                    headers: {
                        ...formData.getHeaders(),
                    },
                    timeout: 60000 // 60 second timeout for PDF processing
                });
                if (!response.data.success) {
                    throw new Error(`Flask extraction failed: ${response.data.error}`);
                }

                // Extract text from Flask response
                const extractedText = response.data.data.pages.map((page) => page.text).join("\n\n");
                console.log(`📝 Extracted ${extractedText.length} characters from PDF`);

                // Extract tables if available
                let extractedTables = null;
                if (response.data.data.tables && response.data.data.tables.length > 0) {
                    extractedTables = response.data.data.tables;
                    console.log(`📊 Extracted ${extractedTables.length} tables from PDF`);
                }

                return {
                    success: true,
                    text: extractedText,
                    tables: extractedTables
                };

            } finally {
                // Clean up temporary file
                try {
                    fs.unlinkSync(tempPath);
                } catch (cleanupError) {
                    console.warn('⚠️ Failed to clean up temporary file:', cleanupError.message);
                }
            }

        } catch (error) {
            console.error('❌ S3 file extraction error:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }
    async processWithOpenAI(text, schemaData) {
        try {
            console.log('🤖 Processing with OpenAI...');

            const response = await openai.chat.completions.create({
                model: "gpt-4o-2024-08-06",
                messages: [
                    {
                        role: "system",
                        content: "You are an expert at structured data extraction. Extract data from the provided text according to the given schema.",
                    },
                    {
                        role: "user",
                        content: `Extract data from the following text and return it in the schema format:\n\n${text}`,
                    },
                ],
                response_format: {
                    type: "json_schema",
                    json_schema: {
                        name: schemaData.schemaName || "data_extraction",
                        schema: schemaData.schema,
                    },
                },
            });

            const extractedData = JSON.parse(response.choices[0].message.content);
            console.log('✅ OpenAI processing completed');
            return {
                success: true,
                data: {
                    extracted_data: extractedData,
                    text_length: text.length,
                    processing_time: new Date().toISOString()
                }
            };

        } catch (error) {
            console.error('❌ OpenAI processing error:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    await worker.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    await worker.stop();
    process.exit(0);
});

const worker = new FileProcessorWorker();
worker.start().catch(error => {
    console.error('💥 Worker failed to start:', error);
    process.exit(1);
});
