import axios from 'axios';
import dotenv from 'dotenv';
import { io } from 'socket.io-client';
import queueService from './queue.js';
import {
    getJobStatus,
    updateFileExtractionStatus,
    updateFileProcessingStatus,
    updateJobStatus
} from './database.js';
import S3Service from './s3Service.js';
import ExtractionService from './services/extractionService.js';
import ProcessingService from './services/processingService.js';

dotenv.config();


const WORKER_INTERVAL_MS = parseInt(process.env.WORKER_INTERVAL_MS || '5000'); // Poll every 5 seconds
const MAX_RETRIES = parseInt(process.env.WORKER_MAX_RETRIES || '3');
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";

class FileProcessorWorker {
    constructor() {
        this.isRunning = false;
        this.processedCount = 0;
        this.errorCount = 0;
        this.startTime = new Date();
        this.s3Service = new S3Service();
        this.extractionService = new ExtractionService();
        this.processingService = new ProcessingService();

        // Initialize Socket.IO client for WebSocket events
        this.socket = io(SERVER_URL, {
            transports: ['websocket', 'polling'],
        });

        this.socket.on('connect', () => {
            console.log('🔌 Worker connected to server:', this.socket.id);
        });

        this.socket.on('disconnect', () => {
            console.log('🔌 Worker disconnected from server');
        });
    }

    // Helper method to emit WebSocket events
    emitFileStatusUpdate(jobId, fileId, extractionStatus, processingStatus, message, error = null) {
        if (this.socket && this.socket.connected) {
            this.socket.emit('file-status-update', {
                jobId,
                fileId,
                extraction_status: extractionStatus,
                processing_status: processingStatus,
                message,
                error,
                timestamp: new Date().toISOString()
            });
            console.log(`📡 Emitted file-status-update: ${fileId} - ${extractionStatus}/${processingStatus}`);
        }
    }

    emitJobStatusUpdate(jobId, status, message) {
        if (this.socket && this.socket.connected) {
            this.socket.emit('job-status-update', {
                jobId,
                status,
                message,
                timestamp: new Date().toISOString()
            });
            console.log(`📡 Emitted job-status-update: ${jobId} - ${status}`);
        }
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
                // Check if queue is paused
                const isPaused = await queueService.isQueuePaused();
                if (isPaused) {
                    console.log('⏸️ Queue is paused, waiting...');
                    await new Promise(resolve => setTimeout(resolve, WORKER_INTERVAL_MS));
                    continue;
                }

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
        const { fileId, jobId, retries, mode = 'normal' } = queueItem;
        console.log(`🔄 Processing file: ${fileId} (attempt ${retries + 1}, mode: ${mode})`);

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

            let extractionResult;

            if (mode === 'reprocess') {
                // Reprocessing mode: Skip extraction, use existing text/markdown
                console.log(`🔄 Reprocessing mode: Using existing extracted data for ${file.filename}`);

                // Emit WebSocket event for reprocessing start
                this.emitFileStatusUpdate(
                    jobId,
                    file.id,
                    file.extraction_status || 'completed',
                    'processing',
                    `Starting reprocessing for ${file.filename}`
                );

                // Use existing extracted data
                extractionResult = {
                    success: true,
                    text: file.extracted_text || '',
                    tables: file.extracted_tables || [],
                    markdown: file.markdown || '',
                    pages: file.pages || []
                };

                console.log(`✅ Using existing extracted data for ${file.filename}`);
            } else {
                // Normal mode: Extract text from file
                console.log(`📄 Stage 1: Extracting text from ${file.filename}`);
                await updateFileExtractionStatus(file.id, 'processing');

                // Emit WebSocket event for Stage 1 start
                this.emitFileStatusUpdate(
                    jobId,
                    file.id,
                    'processing',
                    file.processing_status || 'pending',
                    `Starting text extraction for ${file.filename}`
                );

                // Get extraction method from job processing config
                const extractionMethod = job.processing_config?.extraction?.method || 'mineru';
                const extractionOptions = job.processing_config?.extraction?.options || {};

                extractionResult = await this.extractTextFromFile(file, extractionMethod, extractionOptions);

                if (!extractionResult.success) {
                    throw new Error(`Extraction failed: ${extractionResult.error}`);
                }

                // Update extraction status
                await updateFileExtractionStatus(
                    file.id,
                    'completed',
                    extractionResult.text,
                    extractionResult.tables,
                    extractionResult.markdown,
                    extractionResult.pages
                );
                console.log(`✅ File ${file.filename} extraction completed`);

                // Emit WebSocket event for Stage 1 completion
                this.emitFileStatusUpdate(
                    jobId,
                    file.id,
                    'completed',
                    file.processing_status || 'pending',
                    `Text extraction completed for ${file.filename}`
                );
            }

            // Check if this is a text-only extraction job
            if (job.extraction_mode === 'text_only') {
                console.log(`📝 Text-only mode: Skipping AI processing for ${file.filename}`);

                // Mark processing as completed without AI processing
                await updateFileProcessingStatus(file.id, 'completed', null, null, {
                    mode: 'text_only',
                    extracted_text: extractionResult.text,
                    extracted_tables: extractionResult.tables,
                    markdown: extractionResult.markdown,
                    pages: extractionResult.pages
                });

                // Emit WebSocket event for completion
                this.emitFileStatusUpdate(
                    jobId,
                    file.id,
                    'completed',
                    'completed',
                    `Text extraction completed for ${file.filename} (text-only mode)`
                );

                this.processedCount++;

                // Remove from processing
                await queueService.removeFileFromProcessing(file.id);
                console.log(`🗑️ File ${file.id} processing completed (text-only)`);

                return; // Skip AI processing
            }

            // Stage 2: Process with OpenAI (only for full_extraction mode)
            console.log(`🤖 Stage 2: Processing extracted data with OpenAI`);
            await updateFileProcessingStatus(file.id, 'processing');

            // Emit WebSocket event for Stage 2 start
            this.emitFileStatusUpdate(
                jobId,
                file.id,
                'completed',
                'processing',
                `Starting AI processing for ${file.filename}`
            );
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

            console.log('🔍 Processed schemaData:', schemaData);

            // Validate schema structure
            if (!schemaData || !schemaData.schema) {
                throw new Error(`Missing schema in job data. Got: ${JSON.stringify(schemaData)}`);
            }

            // Get processing method and model from job processing config
            const processingMethod = job.processing_config?.processing?.method || 'openai';
            const processingModel = job.processing_config?.processing?.model || 'gpt-4o';
            const processingOptions = job.processing_config?.processing?.options || {};

            // Merge model into options
            const finalProcessingOptions = {
                model: processingModel,
                ...processingOptions
            };

            const processingResult = await this.processingService.processText(
                extractionResult.markdown,
                schemaData,
                processingMethod,
                finalProcessingOptions
            );

            if (processingResult.success) {
                await updateFileProcessingStatus(file.id, 'completed', processingResult.data, null, processingResult.metadata);
                console.log(`✅ File ${file.filename} processing completed successfully`);

                // Emit WebSocket event for Stage 2 completion
                this.emitFileStatusUpdate(
                    jobId,
                    file.id,
                    'completed',
                    'completed',
                    `AI processing completed for ${file.filename}`
                );

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
                    await updateFileExtractionStatus(fileId, 'pending', null, null, null, null, error.message);

                    // Emit WebSocket event for retry
                    this.emitFileStatusUpdate(
                        jobId,
                        fileId,
                        'pending',
                        'pending',
                        `Retrying file processing (attempt ${retries + 1}/${MAX_RETRIES})`,
                        error.message
                    );
                } else {
                    // Max retries reached
                    await updateFileExtractionStatus(fileId, 'failed', null, null, null, null, error.message);
                    await queueService.removeFileFromProcessing(fileId);

                    // Emit WebSocket event for failure
                    this.emitFileStatusUpdate(
                        jobId,
                        fileId,
                        'failed',
                        'failed',
                        `File processing failed after ${MAX_RETRIES} attempts`,
                        error.message
                    );
                }
            } else {
                console.error(`❌ Max retries reached for file ${fileId}. Marking as failed.`);
                await updateFileExtractionStatus(fileId, 'failed', null, null, null, null, error.message);
                await queueService.removeFileFromProcessing(fileId);

                // Emit WebSocket event for failure
                this.emitFileStatusUpdate(
                    jobId,
                    fileId,
                    'failed',
                    'failed',
                    `File processing failed after ${MAX_RETRIES} attempts`,
                    error.message
                );
            }
        }
    }

    async extractTextFromFile(file, method = 'mineru', options = {}) {
        try {
            console.log(`📄 Extracting text from: ${file.filename} using ${method}`);
            // Check if file is stored in S3
            if (file.s3_key && this.s3Service.isCloudStorageEnabled()) {
                return await this.extractFromS3File(file, method, options);
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

    async extractFromS3File(file, method = 'mineru', options = {}) {
        try {
            console.log(`📄 Processing S3 file: ${file.s3_key} with ${method}`);

            // Download file from S3
            const fileBuffer = await this.s3Service.downloadFile(file.s3_key);

            // Create temporary file
            const fs = (await import('fs')).default;
            const path = (await import('path')).default;
            const tempPath = path.join('uploads', `temp_${file.id}_${Date.now()}`);

            fs.writeFileSync(tempPath, fileBuffer);

            try {
                // Use extraction service with specified method
                const extractionResult = await this.extractionService.extractText(
                    tempPath,
                    file.filename,
                    method,
                    options
                );

                return extractionResult;

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
