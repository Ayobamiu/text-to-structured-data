import http from 'http';
import axios from 'axios';
import dotenv from 'dotenv';
import { io } from 'socket.io-client';
import queueService from './queue.js';
import {
    getJobStatus,
    getFileById,
    updateFileExtractionStatus,
    updateFileProcessingStatus,
    updateJobStatus,
    updateFileSelectedPages,
    updateFileDetectedSections
} from './database.js';
import S3Service from './s3Service.js';
import ExtractionService from './services/extractionService.js';
import ProcessingService from './services/processingService.js';
import { deriveSelectedPagesAndMeta, resolveExtractionFlags } from './services/visualClassifierWiring.js';
import { extractAndProcessPerSection } from './services/perSectionExtractor.js';
import { buildExtractionMetadata } from './services/fileProcessingContext.js';
import { recordProcessingEvent } from './services/processingEventsService.js';
import { parseQAMode, runFileQAJob } from './services/qaJobService.js';
import { parseRexMode, runDirectedReextractionJob } from './services/directedReextractionService.ts';
import { SECTION_REEXTRACT_MODE, runSectionReextraction } from './services/sectionReextractService.ts';
import { parsePsvcMode, runPostProcessingFile } from './services/postProcessingJobService.ts';
import { isDepthGeometryEnabled, recoverDepthGeometry } from './services/depthGeometryService.ts';
import { refineExtractionData } from './services/depthRefinementService.ts';
dotenv.config();


const WORKER_INTERVAL_MS = parseInt(process.env.WORKER_INTERVAL_MS || '5000'); // Poll every 5 seconds
const MAX_RETRIES = parseInt(process.env.WORKER_MAX_RETRIES || '3');
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";

/**
 * Thrown when the visual classifier ran successfully but found no extractable
 * pages (every page is "none"). This is NOT a failure — the file simply has no
 * relevant content — so it must be marked completed-with-no-content rather than
 * retried/failed or (worst of all) extracted in full.
 */
class NoExtractableContentError extends Error {
    constructor({ detectedSections = null, classifierMeta = null } = {}) {
        super('No extractable content: classifier found no relevant pages');
        this.name = 'NoExtractableContentError';
        this.detectedSections = detectedSections;
        this.classifierMeta = classifierMeta;
    }
}

class FileProcessorWorker {
    constructor() {
        this.isRunning = false;
        this.processedCount = 0;
        this.errorCount = 0;
        this.startTime = new Date();
        this.s3Service = new S3Service();
        this.extractionService = new ExtractionService(this.s3Service);
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

    /**
     * Emit a curated processing-timeline event: persist it (for hydration) and
     * push it live over the socket as `file-processing-event`. Never throws —
     * telemetry must not break the pipeline.
     *
     * @param {string} fileId
     * @param {string|null} jobId
     * @param {object} evt  { phase, step?, status?, progress?, message?, level?, data? }
     */
    async emitProcessingEvent(fileId, jobId, evt) {
        try {
            const saved = await recordProcessingEvent({ fileId, jobId, ...evt });
            if (this.socket && this.socket.connected) {
                this.socket.emit('file-processing-event', {
                    fileId,
                    jobId,
                    id: saved?.id,
                    seq: saved?.seq,
                    created_at: saved?.created_at || new Date().toISOString(),
                    ...evt,
                });
            }
        } catch (err) {
            console.warn(`⚠️ emitProcessingEvent failed: ${err.message}`);
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

        // Recover any files stuck in 'processing' status from a previous
        // worker crash / restart (e.g. nodemon, deploy, Ctrl-C).
        // Must run AFTER connections are verified, BEFORE polling begins.
        const requeued = await queueService.requeueStaleProcessingFiles();
        if (requeued.length > 0) {
            console.log(`🔄 Recovered ${requeued.length} file(s) from previous worker crash — they will be picked up on the next poll cycle`);
        }

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

        // Disconnect from queue database pool
        await queueService.disconnect();
    }

    async testConnections() {
        // Test queue database connection
        const isQueueConnected = await queueService.testConnection();
        if (!isQueueConnected) {
            throw new Error('Queue database connection failed. Worker cannot start.');
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

        // QA jobs share the queue but run a completely different pipeline:
        // no extraction, no status columns, no retries (a retry would re-bill
        // the whole VLM pass; transient OpenAI errors are already retried
        // inside sectionQAService's callQAWithRetry).
        const qaMode = parseQAMode(mode);
        if (qaMode) {
            return this.processQAJob(queueItem, qaMode);
        }

        // Directed group re-extraction jobs (mode `rex:<requestId>`) — same
        // share-the-queue trick as QA; the payload lives in
        // directed_reextraction_requests.
        const rexRequestId = parseRexMode(mode);
        if (rexRequestId) {
            return this.processReextractionJob(queueItem, rexRequestId);
        }

        // Section re-extraction jobs (mode `sreex` — Save & Re-extract and
        // single-section reprocess from the review UI). State lives in
        // detected_sections itself: the job re-OCRs every section marked
        // needs_text_reextract and extracts every section with a null
        // section_result_id.
        if (mode === SECTION_REEXTRACT_MODE) {
            return this.processSectionReextractJob(queueItem);
        }

        // Post-processing backfills (mode `psvc:<requestId>` — "Run service"
        // in job settings). One queue item per file so a 4000-file backfill
        // interleaves with normal processing instead of blocking it.
        const psvcRequestId = parsePsvcMode(mode);
        if (psvcRequestId) {
            return this.processPostProcessingJob(queueItem, psvcRequestId);
        }

        console.log(`🔄 Processing file: ${fileId} (attempt ${retries + 1}, mode: ${mode})`);

        // Declare confidentHits, preProcessingMetadata, usePageDetection, and jobProcessingConfig at function scope so they're accessible in all code paths
        let confidentHits = [];
        let preProcessingMetadata = {};
        let usePageDetection = true; // Default to true for backward compatibility
        let jobProcessingConfig = null; // Will be parsed from job.processing_config

        try {
            // Mark file as processing
            await queueService.markFileAsProcessing(fileId);

            // Get file details. Reprocess mode must load pages + text + markdown
            // from DB (large columns); otherwise AI runs on empty input and
            // per-section routing cannot see page-level text.
            const file = await getFileById(fileId, mode === 'reprocess');
            if (!file) {
                throw new Error(`File ${fileId} not found`);
            }

            // Parse selected_pages if available
            if (file.selected_pages && typeof file.selected_pages === 'string') {
                try {
                    file.selected_pages = JSON.parse(file.selected_pages);
                } catch (e) {
                    console.warn('⚠️ Failed to parse selected_pages:', e.message);
                    file.selected_pages = null;
                }
            }

            // Get job details separately (lightweight - no files needed)
            const jobQuery = `
                SELECT id, name, status, schema_data, schema_data_array, processing_config, extraction_mode
                FROM jobs WHERE id = $1
            `;
            const { default: pool } = await import('./database.js');
            const client = await pool.connect();
            let job;
            try {
                const jobResult = await client.query(jobQuery, [jobId]);
                if (jobResult.rows.length === 0) {
                    throw new Error(`Job ${jobId} not found for file ${fileId}`);
                }
                job = jobResult.rows[0];

                // Parse processing_config if it's a string
                if (job.processing_config && typeof job.processing_config === 'string') {
                    try {
                        job.processing_config = JSON.parse(job.processing_config);
                    } catch (parseError) {
                        console.warn('⚠️ Failed to parse processing_config in worker:', parseError.message);
                    }
                }
            } finally {
                client.release();
            }

            // Parsed processing_config — required for Stage 2 in every mode.
            // Reprocess previously never assigned this (only extraction branches did),
            // so resolveExtractionFlags(null) disabled per-section and forced v1.
            jobProcessingConfig =
                typeof job.processing_config === 'string'
                    ? JSON.parse(job.processing_config)
                    : job.processing_config || null;

            let extractionResult;
            let detectedSections = null; // Set by reprocess (from DB) or runFileExtraction (from classifier)

            if (mode === 'reprocess') {
                // Reprocessing mode: Skip extraction, use existing text/markdown
                console.log(`🔄 Reprocessing mode: Using existing extracted data for ${file.filename}`);

                // Restore per-section routing from the persisted classifier
                // output. This is what makes "Re-run AI Processing" alone
                // (without re-extracting text) take the v2 envelope path
                // instead of silently collapsing back to v1 — which is what
                // produced flat results keyed by the legacy job.schema_data
                // after a registry schema update.
                const { usePerSection } = resolveExtractionFlags(jobProcessingConfig);
                const reprocessSections =
                    file.detected_sections &&
                        Array.isArray(file.detected_sections.sections) &&
                        file.detected_sections.sections.some(
                            (s) => Array.isArray(s.extraction_pages) && s.extraction_pages.length > 0
                        )
                        ? file.detected_sections
                        : null;

                if (usePerSection && reprocessSections) {
                    detectedSections = reprocessSections;
                    console.log(
                        `🧩 Reprocess: reusing persisted detected_sections ` +
                        `(${reprocessSections.sections.length} section(s)) for per-section AI`
                    );
                } else if (usePerSection && !reprocessSections) {
                    // Per-section was requested but the file has no usable
                    // classifier output. Falling back to v1 here would write
                    // a flat result keyed by the stale job.schema_data,
                    // which is exactly the original bug. Fail loudly so the
                    // caller knows to re-run text extraction (which re-runs
                    // the visual classifier and re-populates detected_sections).
                    throw new Error(
                        `Reprocess (AI-only) requested with per-section extraction enabled, ` +
                        `but no detected_sections are stored for ${file.filename}. ` +
                        `Re-run text extraction first so the visual classifier can populate routing.`
                    );
                }

                // Emit WebSocket event for reprocessing start
                this.emitFileStatusUpdate(
                    jobId,
                    file.id,
                    file.extraction_status || 'completed',
                    'processing',
                    `Starting reprocessing for ${file.filename}`
                );

                // Use existing extracted data. file.pages is normalised to
                // an array by getFileById (handles JSONB-as-string edge case);
                // the per-section extractor needs Array.isArray(pages) === true,
                // so guard once more here.
                const reprocessPages = Array.isArray(file.pages) ? file.pages : [];

                // Rehydrate depth geometry persisted at extraction time so
                // AI-only reprocess still injects the recovered depths.
                let storedExtractionMeta = file.extraction_metadata || null;
                if (typeof storedExtractionMeta === 'string') {
                    try { storedExtractionMeta = JSON.parse(storedExtractionMeta); } catch { storedExtractionMeta = null; }
                }

                extractionResult = {
                    success: true,
                    text: file.extracted_text || '',
                    tables: Array.isArray(file.extracted_tables) ? file.extracted_tables : [],
                    markdown: file.markdown || '',
                    pages: reprocessPages,
                    ...(storedExtractionMeta?.depth_geometry ? { depthGeometry: storedExtractionMeta.depth_geometry } : {}),
                };

                console.log(
                    `✅ Using existing extracted data for ${file.filename} ` +
                    `(text: ${(extractionResult.text || '').length} chars, ` +
                    `markdown: ${(extractionResult.markdown || '').length} chars, ` +
                    `pages: ${reprocessPages.length}, ` +
                    `per-section: ${detectedSections ? 'yes' : 'no'})`
                );

            } else if (mode === 'extraction-only') {
                // Extraction-only mode: Extract text but skip AI processing
                console.log(`📄 Extraction-only mode: Extracting text from ${file.filename}`);
                this.emitFileStatusUpdate(jobId, file.id, 'processing', file.processing_status || 'pending', `Starting text extraction for ${file.filename}`);

                ({ extractionResult, detectedSections } = await this.runFileExtraction(file, jobProcessingConfig));

                this.emitFileStatusUpdate(jobId, file.id, 'completed', file.processing_status || 'pending', `Extraction completed for ${file.filename}`);
                return; // Skip AI processing

            } else if (mode === 'both' || mode === 'force-full') {
                // Both modes: Extract text and run AI processing
                console.log(`📄 ${mode} mode: Extracting text from ${file.filename}`);
                this.emitFileStatusUpdate(jobId, file.id, 'processing', file.processing_status || 'pending', `Starting text extraction for ${file.filename}`);

                ({ extractionResult, detectedSections } = await this.runFileExtraction(file, jobProcessingConfig));

                this.emitFileStatusUpdate(jobId, file.id, 'completed', file.processing_status || 'pending', `Text extraction completed for ${file.filename}`);

            } else {
                // Normal mode: Extract text from file
                console.log(`📄 Normal mode: Extracting text from ${file.filename}`);
                await updateFileExtractionStatus(file.id, 'processing');
                this.emitFileStatusUpdate(jobId, file.id, 'processing', file.processing_status || 'pending', `Starting text extraction for ${file.filename}`);

                let pagesToStore;
                let extractionMetadata;
                ({ extractionResult, pagesToStore, extractionMetadata, detectedSections } = await this.runFileExtraction(file, jobProcessingConfig));

                // Pre-processing pipeline: Run formation page detection before AI processing
                usePageDetection = jobProcessingConfig?.usePageDetection !== false;
                if (usePageDetection) {
                    try {
                        const { PreProcessingPipeline } = await import('./pipeline/PreProcessingPipeline.js');
                        const prePipeline = new PreProcessingPipeline({
                            stopOnError: false,
                            logProgress: true
                        });

                        const pagesArray = Array.isArray(pagesToStore)
                            ? pagesToStore
                            : (Array.isArray(extractionResult.pages) ? extractionResult.pages : null);

                        const prePipelineContext = {
                            fileId: file.id,
                            jobId: jobId,
                            filename: file.filename,
                            extractionStatus: 'completed',
                            fileInfo: {
                                id: file.id,
                                filename: file.filename,
                                job_id: jobId,
                                s3_key: file.s3_key,
                                storage_type: file.storage_type || 's3',
                                pages: pagesToStore
                            },
                            pages: pagesArray,
                            metadata: extractionMetadata || {}
                        };

                        const prePipelineResult = await prePipeline.execute(prePipelineContext);
                        confidentHits = prePipelineResult.confidentHits || [];
                        preProcessingMetadata = prePipelineResult.metadata || {};

                        if (confidentHits.length > 0) {
                            const breakdown = preProcessingMetadata?.data_extraction_page_detection_pre?.detectionBreakdown || {};
                            const breakdownStr = breakdown.total ?
                                `(Formation: ${breakdown.formation || 0}, LOG: ${breakdown.log || 0}, Plugging: ${breakdown.plugging || 0})` :
                                '';
                            console.log(`✅ Pre-processing: Found ${confidentHits.length} confident data extraction pages ${breakdownStr} for ${file.filename}`);
                        } else {
                            console.log(`ℹ️ Pre-processing: No confident data extraction pages found, will use full content for ${file.filename}`);
                        }
                    } catch (prePipelineError) {
                        console.error(`⚠️ Pre-processing pipeline failed (non-fatal) for ${file.filename}:`, prePipelineError.message);
                    }
                } else {
                    console.log(`ℹ️ Page detection disabled in job config - processing full document for ${file.filename}`);
                    preProcessingMetadata = { page_detection_skipped: true, reason: 'disabled_in_job_config' };
                }

                this.emitFileStatusUpdate(jobId, file.id, 'completed', file.processing_status || 'pending', `Text extraction completed for ${file.filename}`);
            }

            // Handle mode-specific AI processing logic
            if (mode === 'extraction-only') {
                // Already handled above - skip AI processing
                return;
            }

            // Check if this is a text-only extraction job
            if (job.extraction_mode === 'text_only') {
                console.log(`📝 Text-only mode: Skipping AI processing for ${file.filename}`);

                // Mark processing as completed without AI processing
                // Only store minimal metadata indicating text_only mode
                // Extraction data (text, tables, markdown, pages) is already stored via updateFileExtractionStatus
                await updateFileProcessingStatus(file.id, 'completed', null, null, {
                    mode: 'text_only'
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
            const modeDescription = mode === 'reprocess' ? 'reprocessing' :
                mode === 'both' ? 'both extraction and AI processing' :
                    mode === 'force-full' ? 'force-full reprocessing' : 'normal processing';
            console.log(`🤖 Stage 2: Processing extracted data with OpenAI (${modeDescription})`);
            await updateFileProcessingStatus(file.id, 'processing');

            // Emit WebSocket event for Stage 2 start
            this.emitFileStatusUpdate(
                jobId,
                file.id,
                'completed',
                'processing',
                `Starting AI processing for ${file.filename} (${modeDescription})`
            );

            // Get processing method and model from job processing config
            const processingMethod = job.processing_config?.processing?.method || 'openai';
            const processingModel = job.processing_config?.processing?.model || 'gpt-4o';
            const processingOptions = job.processing_config?.processing?.options || {};

            // Merge model into options
            const finalProcessingOptions = {
                model: processingModel,
                ...processingOptions
            };

            // ─────────────────────────────────────────────────────────────
            // Per-section path (v2 envelope)
            // ─────────────────────────────────────────────────────────────
            // When the visual classifier produced ≥1 section with extractable
            // pages, fan out N AI calls (one per section, each with its own
            // registry-resolved schema) and store the assembled v2 envelope.
            //
            // We only enter this branch when:
            //   - useVisualClassifier is on AND
            //   - the classifier returned a sections array AND
            //   - at least one section has extraction_pages
            //
            // Otherwise we fall through to the v1 single-schema path below.
            // ─────────────────────────────────────────────────────────────
            const { usePerSection } = resolveExtractionFlags(jobProcessingConfig);
            const hasExtractableSections = !!(
                detectedSections &&
                Array.isArray(detectedSections.sections) &&
                detectedSections.sections.some(
                    (s) => Array.isArray(s.extraction_pages) && s.extraction_pages.length > 0
                )
            );

            let v1FallbackReason = null;
            if (usePerSection && !hasExtractableSections) {
                v1FallbackReason = 'no_extractable_sections';
                console.warn(
                    `⚠️ Per-section extraction requested but no extractable sections were ` +
                    `found for ${file.filename}; falling through to v1 single-schema path. ` +
                    `This usually means the visual classifier did not run or its output is missing.`
                );
            } else if (usePerSection && hasExtractableSections && !Array.isArray(extractionResult.pages)) {
                v1FallbackReason = 'pages_not_array';
                console.warn(
                    `⚠️ Per-section extraction requested with ${detectedSections.sections.length} section(s) ` +
                    `but extractionResult.pages is ${typeof extractionResult.pages}, not an array. ` +
                    `Falling through to v1 single-schema path (this is a bug — pages should always be an array here).`
                );
            }

            if (usePerSection && hasExtractableSections && Array.isArray(extractionResult.pages)) {
                const sectionTotal = detectedSections.sections.length;
                console.log(
                    `🧩 Per-section extraction: ${sectionTotal} section(s) ` +
                    `for ${file.filename} (envelope v2)`
                );

                await this.emitProcessingEvent(file.id, file.job_id, {
                    phase: 'ai_extraction', status: 'active',
                    progress: { current: 0, total: sectionTotal },
                    message: `Extracting structured data from ${sectionTotal} section${sectionTotal === 1 ? '' : 's'}…`,
                });

                let sectionsDone = 0;
                const perSection = await extractAndProcessPerSection({
                    detectedSections,
                    pages: extractionResult.pages,
                    processingService: this.processingService,
                    processingMethod,
                    processingOptions: finalProcessingOptions,
                    selectedPages: file.selected_pages || null,
                    depthGeometry: (isDepthGeometryEnabled(jobProcessingConfig) && extractionResult.depthGeometry) || null,
                    onSectionComplete: (info) => {
                        sectionsDone += 1;
                        // Surface per-section progress + quality signals on the
                        // timeline: the completeness warning AND whether the
                        // section was escalated to Claude (so escalation is
                        // observable, not just a console log).
                        const c = info?.completeness;
                        let message;
                        let level = 'info';
                        if (info?.escalated) {
                            message = `Section ${sectionsDone} of ${sectionTotal}: escalated to Claude` +
                                (c ? ` (${c.emitted} rows${c.complete ? ', complete' : ' — verify completeness'})` : '');
                            level = c?.complete ? 'info' : 'warning';
                        } else if (c?.agreed) {
                            // Tried Claude, it agreed with OpenAI → verified, not a problem.
                            message = `Section ${sectionsDone} of ${sectionTotal}: ${c.emitted} rows verified (2 models agree)`;
                            level = 'info';
                        } else if (info?.warning) {
                            message = info.warning;
                            level = 'warning';
                        } else {
                            message = `Section ${sectionsDone} of ${sectionTotal} extracted${info?.slug ? ` (${info.slug})` : ''}`;
                        }
                        void this.emitProcessingEvent(file.id, file.job_id, {
                            phase: 'ai_extraction',
                            status: level === 'warning' ? 'info' : 'active',
                            level,
                            progress: { current: sectionsDone, total: sectionTotal },
                            message,
                            data: {
                                slug: info?.slug, record_id: info?.record_id, page_range: info?.page_range,
                                escalated: info?.escalated || false, completeness: c || null,
                            },
                        });
                    },
                });

                const failedCount = perSection.sectionResults.filter((r) => r.status === 'failed').length;
                const skippedCount = perSection.sectionResults.filter((r) => r.status?.startsWith('skipped_')).length;
                const successCount = perSection.sectionResults.filter((r) => r.status === 'success').length;

                // Sections whose pages were ALL classified non-data (attachment,
                // unknown, figure…) reach here with empty extraction_pages and
                // produce no record at all. Before, they were folded into a bare
                // "N skipped" count and vanished — a 2026-07-28 closure report
                // silently dropped two boreholes (MW-1, MW-2) that way. Name
                // them, at warning level, so the gap is visible and an operator
                // can pull the pages back in via "Include skipped pages".
                const noPageSections = perSection.sectionResults.filter(
                    (r) => r.status === 'skipped_no_pages'
                );
                if (noPageSections.length > 0) {
                    const describe = (r) => {
                        const span = Array.isArray(r.page_range) && r.page_range[0] != null
                            ? `pp ${r.page_range[0]}${r.page_range[1] !== r.page_range[0] ? `–${r.page_range[1]}` : ''}`
                            : 'unknown pages';
                        return `${r.record_id ? `${r.record_id} ` : ''}${r.slug || 'unrouted'} (${span})`;
                    };
                    await this.emitProcessingEvent(file.id, file.job_id, {
                        phase: 'ai_extraction', status: 'info', level: 'warning',
                        message: `${noPageSections.length} section${noPageSections.length === 1 ? '' : 's'} produced no record — `
                            + `every page was classified non-data: ${noPageSections.map(describe).join('; ')}`,
                        data: {
                            reason: 'no_extraction_pages',
                            sections: noPageSections.map((r) => ({
                                section_index: r.section_index, slug: r.slug,
                                record_id: r.record_id || null, page_range: r.page_range,
                            })),
                        },
                    });
                    console.warn(
                        `⚠️ ${noPageSections.length} section(s) had zero extraction pages and produced no record: `
                        + noPageSections.map(describe).join('; ')
                    );
                }

                await this.emitProcessingEvent(file.id, file.job_id, {
                    phase: 'ai_extraction', status: 'done',
                    progress: { current: sectionTotal, total: sectionTotal },
                    message: `${successCount} of ${sectionTotal} section${sectionTotal === 1 ? '' : 's'} extracted`
                        + (failedCount ? `, ${failedCount} failed` : '')
                        + (skippedCount ? `, ${skippedCount} skipped` : ''),
                    data: {
                        successCount, failedCount, skippedCount,
                        noExtractionPagesCount: noPageSections.length,
                    },
                });

                console.log(
                    `🧩 Per-section result: ${successCount} ok, ${failedCount} failed, ${skippedCount} skipped ` +
                    `(envelope keys: ${Object.keys(perSection.resultEnvelope).join(', ') || '—'})`
                );

                if (!perSection.anySuccess) {
                    // Every section failed or was skipped. Bubble up the
                    // first concrete error so the file shows a useful message.
                    const firstError = perSection.sectionResults.find((r) => r.error)?.error
                        || 'No section produced an extractable result';
                    throw new Error(`Per-section extraction failed: ${firstError}`);
                }

                // Write section_result_ids back to detected_sections so each
                // section carries a stable link to its extraction record.
                // This enables ID-based matching in split/merge/re-extract.
                for (const sr of perSection.sectionResults) {
                    if (sr.status === 'success' && sr.section_result_id) {
                        const sec = detectedSections.sections[sr.section_index];
                        if (sec) sec.section_result_id = sr.section_result_id;
                    }
                }
                await updateFileDetectedSections(file.id, detectedSections);

                const finalMetadata = {
                    ...preProcessingMetadata,
                    result_envelope: 'v2',
                    section_results: perSection.sectionResults,
                    schemas_used: perSection.schemasUsed,
                    per_section_extraction: {
                        section_count: perSection.sectionResults.length,
                        success_count: successCount,
                        failed_count: failedCount,
                        skipped_count: skippedCount,
                        total_ai_time_seconds: perSection.totalAiTimeSeconds,
                    },
                };

                await updateFileProcessingStatus(
                    file.id,
                    'completed',
                    perSection.resultEnvelope,
                    null,
                    finalMetadata,
                    perSection.totalAiTimeSeconds || null
                );
                console.log(`✅ File ${file.filename} per-section processing completed (v2 envelope)`);

                this.emitFileStatusUpdate(
                    jobId,
                    file.id,
                    'completed',
                    'completed',
                    `AI processing completed for ${file.filename} (${successCount} section(s))`
                );

                this.processedCount++;
                await queueService.removeFileFromProcessing(file.id);
                console.log(`🗑️ File ${file.id} processing completed`);
                return;
            }

            // ─────────────────────────────────────────────────────────────
            // v1 single-schema path (unchanged from before)
            // ─────────────────────────────────────────────────────────────

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

            // Validate schema structure
            if (!schemaData || !schemaData.schema) {
                throw new Error(`Missing schema in job data. Got: ${JSON.stringify(schemaData)}`);
            }

            // Use filtered markdown from confidentHits if page detection is enabled and hits are available, otherwise use full content
            let contentForAI = extractionResult.markdown;
            if (usePageDetection && confidentHits && confidentHits.length > 0 && extractionResult.pages && Array.isArray(extractionResult.pages)) {
                // Filter pages to only confidentHits and concatenate their markdown
                const filteredPages = extractionResult.pages.filter(page =>
                    confidentHits.includes(page.page_number)
                );
                const filteredMarkdown = filteredPages
                    .map(page => page.text || '')
                    .join('\n\n');

                if (filteredMarkdown.trim().length > 0) {
                    contentForAI = filteredMarkdown;
                    const breakdown = preProcessingMetadata?.data_extraction_page_detection_pre?.detectionBreakdown || {};
                    const breakdownStr = breakdown.total ?
                        `(Formation: ${breakdown.formation || 0}, LOG: ${breakdown.log || 0}, Plugging: ${breakdown.plugging || 0})` :
                        '';
                    console.log('--------------------------------------- IMPORTANT ---------------------------------------');
                    console.log(`Using filtered markdown from ${confidentHits.length} confident data extraction pages ${breakdownStr} (${contentForAI.length} characters, reduced from ${extractionResult.markdown?.length || 0})`);
                    console.log('--------------------------------------- IMPORTANT ---------------------------------------');
                } else {
                    console.log(`Filtered markdown is empty, falling back to full markdown`);
                }
            } else {
                if (!usePageDetection) {
                    console.log(`Page detection disabled - using full markdown for AI processing (${contentForAI?.length || 0} characters)`);
                } else {
                    console.log(`Using full markdown for AI processing (${contentForAI?.length || 0} characters)`);
                }
            }

            const processingResult = await this.processingService.processText(
                contentForAI,
                schemaData,
                processingMethod,
                finalProcessingOptions
            );

            if (processingResult.success) {
                // Extract ai_processing_time_seconds from metadata
                const aiProcessingTimeSeconds = processingResult.metadata?.processing_time_seconds ||
                    processingResult.metadata?.ai_processing_time_seconds ||
                    processingResult.ai_processing_time_seconds ||
                    null;

                // Depth refinement (v1 path): reconcile the extracted rows with
                // the measured geometry in a focused second pass. Mutates
                // processingResult.data in place; fails open per group (any
                // refiner error / rejected ops keeps the extracted rows).
                let depthRefinementReports = null;
                if (isDepthGeometryEnabled(jobProcessingConfig) && extractionResult.depthGeometry) {
                    depthRefinementReports = await refineExtractionData({
                        data: processingResult.data,
                        geometry: extractionResult.depthGeometry,
                        schema: schemaData,
                        model: finalProcessingOptions?.model,
                    });
                }

                // Merge pre-processing metadata with processing metadata
                const finalMetadata = {
                    ...processingResult.metadata,
                    ...preProcessingMetadata, // Include comprehensive page detection metadata
                    ...(depthRefinementReports?.length ? { depth_refinement: depthRefinementReports } : {}),
                    // Flag degraded result when per-section was requested but fell through to v1
                    ...(v1FallbackReason ? {
                        result_envelope: 'v1_fallback',
                        v1_fallback_reason: v1FallbackReason,
                        v1_fallback_schema: schemaData?.schemaName || null,
                    } : {}),
                };

                await updateFileProcessingStatus(
                    file.id,
                    'completed',
                    processingResult.data,
                    null,
                    finalMetadata,
                    aiProcessingTimeSeconds
                );
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

            await this.emitProcessingEvent(file.id, jobId, {
                phase: 'done', status: 'done', message: 'Processing complete',
            });

            // Remove from processing
            await queueService.removeFileFromProcessing(file.id);
            console.log(`🗑️ File ${file.id} processing completed`);

        } catch (error) {
            // No extractable content is a successful (empty) outcome, not a
            // failure: mark the file completed with a clear reason and skip
            // extraction/AI entirely. Never retry, never extract the full doc.
            if (error instanceof NoExtractableContentError) {
                console.log(`🚫 ${fileId}: no extractable content — marking completed (no_extractable_pages)`);
                await this.emitProcessingEvent(fileId, jobId, {
                    phase: 'skipped', status: 'done', level: 'warning',
                    message: 'No extractable content — every page classified as "none". Nothing was extracted.',
                    data: { skipped_reason: 'no_extractable_pages' },
                });
                try {
                    // Mark both columns terminal so the file doesn't linger in
                    // "processing" (normal mode set extraction_status=processing
                    // before extraction ran).
                    await updateFileExtractionStatus(fileId, 'completed');
                    await updateFileProcessingStatus(fileId, 'completed', null, null, {
                        skipped: true,
                        skipped_reason: 'no_extractable_pages',
                        visual_page_classifier: error.classifierMeta || null,
                    });
                    this.emitFileStatusUpdate(
                        jobId,
                        fileId,
                        'completed',
                        'completed',
                        `No extractable content detected for ${fileId} — nothing to extract (every page classified as "none").`
                    );
                    this.processedCount++;
                } catch (markErr) {
                    console.error(`❌ Failed to mark ${fileId} as no-content completed:`, markErr.message);
                } finally {
                    await queueService.removeFileFromProcessing(fileId);
                }
                return;
            }

            console.error('❌ Error processing file:', error.message);
            this.errorCount++;

            await this.emitProcessingEvent(fileId, jobId, {
                phase: 'failed', status: 'failed', level: 'error',
                message: error.message,
                data: { will_retry: retries < MAX_RETRIES },
            });

            // Handle retries
            if (retries < MAX_RETRIES) {
                console.log(`🔄 Retrying file ${fileId}. Attempt ${retries + 1} of ${MAX_RETRIES}`);
                const retrySuccess = await queueService.retryFile(fileId, jobId, 0, mode);

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

    /**
     * Emit a QA progress event to the server (relayed to the job room as
     * `qa-progress-event`). Not persisted — in-flight state is recoverable
     * from the queue table (see getActiveQAJobs), findings from the QA tables.
     */
    emitQAProgress(jobId, fileId, evt) {
        if (this.socket && this.socket.connected) {
            this.socket.emit('qa-progress-event', {
                jobId,
                fileId,
                timestamp: new Date().toISOString(),
                ...evt,
            });
        }
    }

    /**
     * Run a QA queue item (mode `qa:*` — see qaJobService). QA failures are
     * terminal: the job is removed from the queue without retry so a broken
     * file can't burn repeated VLM passes.
     */
    async processQAJob(queueItem, qaMode) {
        const { fileId, jobId } = queueItem;
        const { scope, sectionResultId, model } = qaMode;
        console.log(`🔍 Processing QA job: ${fileId} (scope: ${scope}${sectionResultId ? `, section: ${sectionResultId.substring(0, 8)}...` : ''})`);

        try {
            await queueService.markFileAsProcessing(fileId);

            await runFileQAJob({
                fileId,
                scope,
                sectionResultId,
                model,
                onProgress: (evt) => this.emitQAProgress(jobId, fileId, { scope, ...evt }),
            });

            this.processedCount++;
        } catch (error) {
            console.error(`❌ QA job failed for ${fileId}:`, error.message);
            this.errorCount++;
            this.emitQAProgress(jobId, fileId, {
                status: 'failed',
                ...(sectionResultId ? { sectionResultId } : {}),
                message: error.message,
            });
        } finally {
            await queueService.removeFileFromProcessing(fileId);
        }
    }

    /**
     * Emit a directed re-extraction progress event to the server (relayed to
     * the job room as `reextract-progress-event`). In-flight state is
     * recoverable from directed_reextraction_requests; findings from the QA
     * tables.
     */
    emitReextractProgress(jobId, fileId, evt) {
        if (this.socket && this.socket.connected) {
            this.socket.emit('reextract-progress-event', {
                jobId,
                fileId,
                timestamp: new Date().toISOString(),
                ...evt,
            });
        }
    }

    /**
     * Run a directed re-extraction queue item (mode `rex:<requestId>`).
     * Failures are terminal — no queue retry (transient OpenAI errors are
     * retried inside the service; a retry here would re-bill vision calls).
     * The request row records the outcome either way.
     */
    /**
     * Run a section re-extraction queue item (mode `sreex` — Save &
     * Re-extract). Idempotent and crash-resumable: state lives in
     * detected_sections (null section_result_id = pending), and each
     * finished section persists incrementally. Failures are terminal — no
     * queue retry (transient AI errors are handled inside extraction; the
     * operator can hit Save & Re-extract again, which just re-enqueues).
     *
     * Data updates ride the normal file-patch channel (`file-status-update`
     * relayed by the server as patches); progress rides
     * `section-reextract-progress-event`. processing_status is never
     * flipped — the rest of the envelope stays valid and visible.
     */
    async processSectionReextractJob(queueItem) {
        const { fileId, jobId } = queueItem;
        console.log(`🧩 Processing section re-extraction job for file ${fileId}`);

        const emitProgress = (evt) => {
            if (this.socket && this.socket.connected) {
                this.socket.emit('section-reextract-progress-event', {
                    jobId,
                    fileId,
                    ...evt,
                    timestamp: new Date().toISOString(),
                });
            }
        };

        try {
            await queueService.markFileAsProcessing(fileId);

            const outcome = await runSectionReextraction({
                fileId,
                extractionService: this.extractionService,
                processingService: this.processingService,
                emitPatch: (patch) => {
                    if (this.socket && this.socket.connected) {
                        // The server converts file-status-update into the
                        // standardized file-patch shape for job-room clients.
                        this.socket.emit('file-status-update', { jobId, fileId, ...patch });
                    }
                },
                onProgress: emitProgress,
            });

            if (outcome.status === 'failed') {
                console.error(`❌ Section re-extraction failed for file ${fileId}: ${outcome.error}`);
                this.errorCount++;
            } else {
                this.processedCount++;
            }
        } catch (error) {
            console.error(`❌ Section re-extraction job for file ${fileId} threw:`, error.message);
            this.errorCount++;
            emitProgress({ phase: 'failed', completed: 0, total: 0, error: error.message });
        } finally {
            await queueService.removeFileFromProcessing(fileId);
        }
    }

    /**
     * Run one file of a post-processing backfill (mode `psvc:<requestId>`).
     * The request row carries the payload and accumulates the summary across
     * files, so this item is just "apply the service to this one file".
     *
     * No queue retries: services hit paid APIs (geocoding), and a retry after
     * a partial apply would re-bill. A failure marks the whole request failed;
     * the remaining items short-circuit, and the operator re-runs.
     */
    async processPostProcessingJob(queueItem, requestId) {
        const { fileId, jobId } = queueItem;

        try {
            await queueService.markFileAsProcessing(fileId);

            const outcome = await runPostProcessingFile({
                requestId,
                fileId,
                onProgress: (evt) => {
                    if (this.socket && this.socket.connected) {
                        this.socket.emit('postprocess-progress-event', {
                            jobId,
                            fileId,
                            timestamp: new Date().toISOString(),
                            ...evt,
                        });
                    }
                },
            });

            if (outcome.status === 'failed') this.errorCount++;
            else this.processedCount++;
        } catch (error) {
            console.error(
                `❌ Post-processing job ${requestId.substring(0, 8)}... (file ${fileId}) threw:`,
                error.message,
            );
            this.errorCount++;
        } finally {
            await queueService.removeFileFromProcessing(fileId);
        }
    }

    async processReextractionJob(queueItem, requestId) {
        const { fileId, jobId } = queueItem;
        console.log(`🎯 Processing directed re-extraction job: ${requestId.substring(0, 8)}... (file ${fileId})`);

        try {
            await queueService.markFileAsProcessing(fileId);

            await runDirectedReextractionJob({
                requestId,
                onProgress: (evt) => this.emitReextractProgress(jobId, fileId, evt),
            });

            this.processedCount++;
        } catch (error) {
            console.error(`❌ Directed re-extraction job ${requestId.substring(0, 8)}... failed:`, error.message);
            this.errorCount++;
            // runDirectedReextractionJob already emitted 'failed' + updated the
            // request row for its own errors; this catch also covers the case
            // where the request row couldn't even be loaded.
        } finally {
            await queueService.removeFileFromProcessing(fileId);
        }
    }


    /**
     * Consolidated file extraction: resolves pages, runs extraction with
     * fallback, normalizes output, builds metadata, and persists to DB.
     *
     * Replaces the 3 near-identical extraction blocks in processFile().
     * The caller is responsible for WebSocket events and pre/post logic.
     *
     * @param {Object} file  DB file row
     * @param {Object} jobProcessingConfig  Already-parsed processing config
     * @returns {Promise<{
     *   extractionResult: Object,
     *   extractionMetadata: Object,
     *   pageCount: number|null,
     *   pagesToStore: Array|number|null,
     *   openaiFeedBlocked: string|null,
     *   openaiFeedUnblocked: string|null,
     *   detectedSections: Object|null
     * }>}
     */
    async runFileExtraction(file, jobProcessingConfig) {
        const extractionMethod = jobProcessingConfig?.extraction?.method || 'paddleocr';
        const extractionOptions = jobProcessingConfig?.extraction?.options || {};
        console.log(`📋 Using extraction method: ${extractionMethod} (from job processing config)`);

        // 1. Resolve selected pages (manual > classifier > null)
        const { useClassifier, usePerSection } = resolveExtractionFlags(jobProcessingConfig);

        // Surface the (often long) classification phase on the timeline. We emit
        // at phase granularity here; determinate batch progress/ETA is threaded
        // separately as a follow-up.
        if (useClassifier && !(Array.isArray(file.selected_pages) && file.selected_pages.length > 0)) {
            await this.emitProcessingEvent(file.id, file.job_id, {
                phase: 'classifying', status: 'active',
                message: 'Classifying pages to find the relevant sections…',
            });
        }

        const { selectedPages, classifierMeta, detectedSections, classifierFailed, noExtractableContent } = await deriveSelectedPagesAndMeta({
            file,
            jobProcessingConfig,
            s3Service: this.s3Service,
            usePerSection,
        });

        if (useClassifier && detectedSections) {
            const n = detectedSections.sections?.length ?? 0;
            await this.emitProcessingEvent(file.id, file.job_id, {
                phase: 'classifying', status: 'done',
                message: `${n} section${n === 1 ? '' : 's'} detected`,
                data: { section_count: n },
            });
        }

        // Classifier ran but found nothing to extract — skip extraction rather
        // than ingesting the entire document. Handled in processFile's catch as
        // a completed-with-no-content outcome (not a failure).
        if (noExtractableContent) {
            console.warn(
                `🚫 No extractable content for ${file.filename} — skipping extraction (no_extractable_pages)`
            );
            throw new NoExtractableContentError({ detectedSections, classifierMeta });
        }

        // Persist classifier-derived pages so the skinny list can
        // show "X of Y" in the Pages column (same as manual selection).
        if (selectedPages && selectedPages.length > 0 && !file.selected_pages) {
            await updateFileSelectedPages(file.id, selectedPages);
            file.selected_pages = selectedPages;
        }

        // When the visual classifier is explicitly enabled but failed,
        // abort rather than silently extracting every page.
        if (classifierFailed) {
            const reason = classifierMeta?.reason || 'unknown';
            const detail = classifierMeta?.error || '';
            throw new Error(
                `Visual page classifier failed for ${file.filename} ` +
                `(reason: ${reason}${detail ? ' — ' + detail : ''}). ` +
                `Aborting to prevent full-document extraction. ` +
                `Retry the file or disable the visual classifier on this job.`
            );
        }

        // 2. Run extraction with fallback
        const pageBit = Array.isArray(selectedPages) && selectedPages.length > 0
            ? `${selectedPages.length} page${selectedPages.length === 1 ? '' : 's'}`
            : 'the document';
        await this.emitProcessingEvent(file.id, file.job_id, {
            phase: 'extracting', status: 'active',
            message: `Extracting text from ${pageBit} (${extractionMethod})…`,
        });

        let extractionResult;
        const depthGeometryEnabled = isDepthGeometryEnabled(jobProcessingConfig);
        if (extractionMethod === 'extendai') {
            extractionResult = await this.extractWithExtendAI(
                file,
                depthGeometryEnabled ? { ...extractionOptions, returnOcrWords: true } : extractionOptions,
                selectedPages
            );
            if (!extractionResult.success) {
                console.log(`⚠️ ExtendAI failed: ${extractionResult.error}`);
                console.log(`🔄 Falling back to paddleocr for ${file.filename}`);
                extractionResult = await this.extractFromS3File(file, 'paddleocr', extractionOptions, selectedPages);
                if (!extractionResult.success) {
                    throw new Error(`Extraction failed after fallback: ${extractionResult.error}`);
                }
                console.log(`✅ MinerU fallback extraction successful for ${file.filename}`);
            }
        } else {
            extractionResult = await this.extractTextFromFile(file, extractionMethod, extractionOptions, selectedPages);
        }

        if (!extractionResult.success) {
            throw new Error(`Extraction failed: ${extractionResult.error}`);
        }

        await this.emitProcessingEvent(file.id, file.job_id, {
            phase: 'extracting', status: 'done',
            message: 'Text extraction complete',
        });

        // Depth-geometry recovery (borehole logs): calibrate the graphical
        // depth ruler from the OCR word geometry and recover true sample
        // depths + lithology contact tops. Fails open — when nothing can be
        // calibrated (no ruler, paddleocr fallback, words missing) the
        // geometry is simply absent and processing proceeds unchanged.
        if (depthGeometryEnabled && Array.isArray(extractionResult.ocrWords)) {
            const depthDiag = { totalPages: 0, calibratedPages: 0, pages: [] };
            const geometry = recoverDepthGeometry(extractionResult.ocrWords, { diagnostics: depthDiag });
            if (geometry) {
                extractionResult.depthGeometry = geometry;
                console.log(
                    `📐 Depth geometry recovered for ${file.filename}: ` +
                    `${geometry.samples.length} sample depth(s), ${geometry.lithologyLines.length} description line(s)` +
                    `${geometry.lithologyLines.length === 0 && geometry.contacts.length > 0 ? ` (fallback: ${geometry.contacts.length} USCS contact(s))` : ''} ` +
                    `across ${geometry.calibrated_pages} calibrated page(s)`
                );
            } else {
                // Actionable fail-open trace: instead of a flat "no ruler found",
                // report which assumption broke so a new format can be widened.
                // (no_depth_header → header vocabulary; fit_rejected → elevation
                // ruler or off-column band; no_ticks_in_band → tick interval.)
                const pagesWithHeader = depthDiag.pages.filter((p) => p.depthHeaders.length > 0).length;
                const reasonTally = depthDiag.pages
                    .filter((p) => p.reason)
                    .reduce((acc, p) => { acc[p.reason] = (acc[p.reason] || 0) + 1; return acc; }, {});
                const reasons = Object.entries(reasonTally).map(([r, n]) => `${r}×${n}`).join(', ');
                const sampleHeaders = [...new Set(
                    depthDiag.pages.flatMap((p) => p.depthHeaders)
                )].slice(0, 5);
                console.log(
                    `📐 Depth geometry enabled but nothing recoverable for ${file.filename} — ` +
                    `${depthDiag.totalPages} page(s), ${pagesWithHeader} with a DEPTH heading, 0 calibrated` +
                    `${reasons ? ` [${reasons}]` : ''}` +
                    `${sampleHeaders.length ? ` heading(s) seen: ${sampleHeaders.map((h) => `"${h}"`).join(', ')}` : ''} ` +
                    `— continuing without it`
                );
            }
        }

        // 3. Normalize output
        const pages = extractionResult.pages || [];
        const tables = extractionResult.tables || [];
        let pageCount = file.page_count || null;
        let pagesToStore = null;
        if (Array.isArray(pages) && pages.length > 0) {
            pageCount = pages.length;
            pagesToStore = pages;
        } else if (typeof pages === 'number') {
            pageCount = pages;
            pagesToStore = pages;
        }

        // 4. Build metadata
        const openaiFeedBlocked = extractionResult.openai_feed?.blocked || null;
        const openaiFeedUnblocked = extractionResult.openai_feed?.unblocked || null;
        const extractionMetadata = buildExtractionMetadata({
            extractionResult,
            classifierMeta,
            pageCount,
        });
        // Persist recovered depth geometry (small: ids + numbers, NOT the raw
        // OCR words) so AI-only reprocess can rebuild the prompt appendix
        // without re-running text extraction.
        if (extractionResult.depthGeometry) {
            extractionMetadata.depth_geometry = extractionResult.depthGeometry;
        }

        // 5. Persist to DB
        await updateFileExtractionStatus(
            file.id,
            'completed',
            extractionResult.text || null,
            Array.isArray(tables) && tables.length > 0 ? tables : null,
            extractionResult.markdown || null,
            pagesToStore,
            null, // error
            extractionResult.extraction_time_seconds || extractionResult.extractionTimeSeconds || null,
            openaiFeedBlocked,
            openaiFeedUnblocked,
            extractionMetadata,
            extractionResult.raw_data || null,
            pageCount
        );

        console.log(`✅ File ${file.filename} extraction completed and persisted`);

        return { extractionResult, extractionMetadata, pageCount, pagesToStore, openaiFeedBlocked, openaiFeedUnblocked, detectedSections };
    }

    /**
     * Extract with ExtendAI (requires S3 file)
     * @param {Object} file - File record with s3_key
     * @param {Object} options - Extraction options
     * @param {number[]} selectedPages - Optional array of page numbers to extract (1-indexed)
     * @returns {Promise<Object>} Extraction result
     */
    async extractWithExtendAI(file, options = {}, selectedPages = null) {
        try {
            if (!file.s3_key) {
                throw new Error('S3 key required for ExtendAI extraction');
            }

            // Use parameter if provided, otherwise fall back to file object
            selectedPages = selectedPages || file.selected_pages || null;
            if (selectedPages && Array.isArray(selectedPages) && selectedPages.length > 0) {
                console.log(`📄 Using selected pages for ExtendAI: ${selectedPages.join(', ')}`);
            }

            console.log(`🚀 Attempting ExtendAI extraction for ${file.filename} (S3: ${file.s3_key})`);
            return await this.extractionService.extractWithExtendAI(file.filename, file.s3_key, options, selectedPages);
        } catch (error) {
            console.error('❌ ExtendAI extraction error:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async extractTextFromFile(file, method = 'paddleocr', options = {}, selectedPages = null) {
        try {
            console.log(`📄 Extracting text from: ${file.filename} using ${method}`);

            // Handle ExtendAI extraction (requires S3)
            if (method === 'extendai') {
                return await this.extractWithExtendAI(file, options, selectedPages);
            }

            // Check if file is stored in S3
            if (file.s3_key && this.s3Service.isCloudStorageEnabled()) {
                return await this.extractFromS3File(file, method, options, selectedPages);
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

    async extractFromS3File(file, method = 'paddleocr', options = {}, selectedPages = null) {
        try {
            console.log(`📄 Processing S3 file: ${file.s3_key} with ${method}`);

            // Use parameter if provided, otherwise fall back to file object
            selectedPages = selectedPages || file.selected_pages || null;
            if (selectedPages && Array.isArray(selectedPages) && selectedPages.length > 0) {
                console.log(`📄 Using selected pages: ${selectedPages.join(', ')}`);
            }

            // For ExtendAI, use direct S3 URL (no need to download, but may need to filter pages)
            if (method === 'extendai') {
                return await this.extractWithExtendAI(file, options, selectedPages);
            }

            // For other methods, download file and use Flask service
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
                    options,
                    file.s3_key,
                    selectedPages
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

// Lightweight HTTP server so platforms like Railway can health-check the
// worker (it doesn't otherwise bind to a port and the dashboard would show
// it as offline). Also gives us a real /health endpoint for monitoring.
//
// Local dev: `.env` often sets PORT=3000 for the HTTP API while both processes
// load the same dotenv — binding worker health on PORT produced EADDRINUSE.
// On Railway, WORKER_HEALTH_PORT is optional; `$PORT` there is worker-specific.
const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT);
let healthListenPort = process.env.WORKER_HEALTH_PORT;
if (!healthListenPort && onRailway && process.env.PORT) {
    healthListenPort = process.env.PORT;
}
const HEALTH_PORT = parseInt(healthListenPort || '8080', 10);
const healthServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        const uptimeSeconds = Math.floor((Date.now() - worker.startTime.getTime()) / 1000);
        const body = {
            status: worker.isRunning ? 'healthy' : 'starting',
            service: 'ai-worker',
            socketConnected: Boolean(worker.socket && worker.socket.connected),
            processedCount: worker.processedCount,
            errorCount: worker.errorCount,
            uptimeSeconds
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

healthServer.listen(HEALTH_PORT, () => {
    console.log(`🩺 Worker health endpoint listening on :${HEALTH_PORT}/health`);
});

worker.start().catch(error => {
    console.error('💥 Worker failed to start:', error);
    process.exit(1);
});
