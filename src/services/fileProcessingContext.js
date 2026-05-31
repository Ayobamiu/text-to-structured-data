/**
 * FileProcessingContext — single source of truth for one file's processing run.
 *
 * Eliminates state duplication across the 5 mode branches in worker.js and
 * the parallel path in server.js. Created once per file, populated progressively,
 * and passed to every step. No instance-variable stash, no re-parsing config,
 * no cross-file leakage.
 *
 * Usage:
 *   const ctx = createFileProcessingContext({ file, job, mode });
 *   // ctx.jobProcessingConfig, ctx.usePerSection, ctx.extractionMethod, etc.
 *   // are all resolved once and available for the entire processing run.
 */

import { resolveExtractionFlags } from './visualClassifierWiring.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a FileProcessingContext from the raw DB records.
 *
 * Parses job.processing_config exactly once, resolves all flags and options,
 * and initializes output fields to null/defaults.
 *
 * @param {Object}  args
 * @param {Object}  args.file   DB file row (from getFileById). Must have: id, filename, job_id,
 *                              s3_key, selected_pages (parsed array or null).
 * @param {Object}  args.job    DB job row. Must have: id, processing_config, schema_data.
 * @param {string}  [args.mode] 'normal' | 'reprocess' | 'extraction-only' | 'both' | 'force-full'
 * @returns {FileProcessingContext}
 */
export function createFileProcessingContext({ file, job, mode = 'normal' }) {
    if (!file || !file.id) throw new Error('createFileProcessingContext: file with id is required');
    if (!job || !job.id) throw new Error('createFileProcessingContext: job with id is required');

    // ── Parse config exactly once ───────────────────────────────────────────
    let jobProcessingConfig = job.processing_config;
    if (typeof jobProcessingConfig === 'string') {
        try {
            jobProcessingConfig = JSON.parse(jobProcessingConfig);
        } catch (e) {
            console.warn(`⚠️ Failed to parse processing_config for job ${job.id}: ${e.message}`);
            jobProcessingConfig = null;
        }
    }
    jobProcessingConfig = jobProcessingConfig || {};

    // ── Resolve extraction config ───────────────────────────────────────────
    const extractionConfig = jobProcessingConfig.extraction || {};
    const extractionMethod = extractionConfig.method || 'paddleocr';
    const extractionOptions = extractionConfig.options || {};

    // ── Resolve feature flags ───────────────────────────────────────────────
    const { useClassifier, usePerSection } = resolveExtractionFlags(jobProcessingConfig);
    const usePageDetection = jobProcessingConfig.usePageDetection !== false; // default true

    // ── Resolve AI processing config ────────────────────────────────────────
    const processingConfig = jobProcessingConfig.processing || {};
    const processingMethod = processingConfig.method || 'openai';
    const processingModel = processingConfig.model || 'gpt-4o';
    const processingOptions = {
        model: processingModel,
        ...(processingConfig.options || {}),
    };

    // ── Resolve selected pages (manual override) ────────────────────────────
    let manualSelectedPages = file.selected_pages;
    if (typeof manualSelectedPages === 'string') {
        try {
            manualSelectedPages = JSON.parse(manualSelectedPages);
        } catch {
            manualSelectedPages = null;
        }
    }
    if (!Array.isArray(manualSelectedPages) || manualSelectedPages.length === 0) {
        manualSelectedPages = null;
    }

    // ── Assemble context ────────────────────────────────────────────────────
    return {
        // Identity
        fileId: file.id,
        jobId: job.id || file.job_id,
        filename: file.filename,
        mode,

        // Config (parsed once, read many)
        jobProcessingConfig,
        extractionMethod,
        extractionOptions,
        useClassifier,
        usePerSection,
        usePageDetection,
        processingMethod,
        processingModel,
        processingOptions,

        // Page namespace
        selectedPages: manualSelectedPages,
        selectedPagesSource: manualSelectedPages ? 'manual' : null,

        // Classifier (set by runExtraction or loaded from DB in reprocess)
        classifierMeta: null,
        detectedSections: null,
        classifierFailed: false,

        // Extraction output (set by runExtraction or loaded from DB)
        extractionResult: null,
        extractionMetadata: null,
        pageCount: null,
        pagesToStore: null,

        // Pre-processing (set by runPreProcessing)
        confidentHits: [],
        preProcessingMetadata: {},

        // Records (loaded once, available throughout)
        file,
        job,
    };
}

// ---------------------------------------------------------------------------
// Metadata builder
// ---------------------------------------------------------------------------

/**
 * Build the extraction_metadata object from the context's extraction result.
 *
 * Replaces the 3 identical inline blocks in worker.js and the 1 in server.js.
 * Pure computation — no side effects, no DB writes.
 *
 * @param {Object}  args
 * @param {Object}  args.extractionResult  The raw extraction service output.
 * @param {Object|null} args.classifierMeta  Visual classifier provenance (optional).
 * @param {number|null} args.pageCount       Resolved page count.
 * @returns {Object}  The extraction_metadata object ready for DB storage.
 */
export function buildExtractionMetadata({ extractionResult, classifierMeta = null, pageCount = null }) {
    if (!extractionResult) {
        throw new Error('buildExtractionMetadata: extractionResult is required');
    }

    const openaiFeedBlocked = extractionResult.openai_feed?.blocked || null;
    const openaiFeedUnblocked = extractionResult.openai_feed?.unblocked || null;

    // Build base metadata — same logic as the inline blocks
    let metadata;
    if (extractionResult.metadata) {
        metadata = {
            ...extractionResult.metadata,
            extraction_time_seconds:
                extractionResult.metadata.extraction_time_seconds ||
                extractionResult.extraction_time_seconds ||
                extractionResult.extractionTimeSeconds ||
                null,
        };
    } else {
        metadata = {
            extraction_method: extractionResult.method || null,
            extraction_time_seconds:
                extractionResult.extraction_time_seconds ||
                extractionResult.extractionTimeSeconds ||
                null,
            total_pages: pageCount || null,
            total_tables: (extractionResult.tables || []).length || null,
            text_length: (extractionResult.text || '').length || null,
            markdown_length: (extractionResult.markdown || '').length || null,
        };
    }

    // Add OpenAI feed lengths if available
    if (openaiFeedBlocked) {
        metadata.openai_feed_blocked_length = openaiFeedBlocked.length;
    }
    if (openaiFeedUnblocked) {
        metadata.openai_feed_unblocked_length = openaiFeedUnblocked.length;
    }

    // Surface visual classifier provenance
    if (classifierMeta) {
        metadata.visual_page_classifier = classifierMeta;
    }

    return metadata;
}

// ---------------------------------------------------------------------------
// Guard clauses
// ---------------------------------------------------------------------------

/**
 * Assert that the context is ready for extraction to proceed.
 * Throws if the visual classifier was enabled but failed.
 *
 * Call after selectedPages resolution (deriveSelectedPagesAndMeta).
 */
export function assertReadyForExtraction(ctx) {
    if (ctx.classifierFailed) {
        const reason = ctx.classifierMeta?.reason || 'unknown';
        const detail = ctx.classifierMeta?.error || '';
        throw new Error(
            `Visual page classifier failed for ${ctx.filename} ` +
            `(reason: ${reason}${detail ? ' — ' + detail : ''}). ` +
            `Aborting to prevent full-document extraction. ` +
            `Retry the file or disable the visual classifier on this job.`
        );
    }
}

/**
 * Assert that the context is ready for AI processing (Stage 2).
 * Throws if per-section extraction is requested but detectedSections is missing.
 *
 * This catches the case where reprocess is run without prior classifier output.
 */
export function assertReadyForAI(ctx) {
    if (ctx.usePerSection && !ctx.detectedSections) {
        throw new Error(
            `AI processing requested with per-section extraction enabled, ` +
            `but no detected_sections available for ${ctx.filename}. ` +
            `Re-run text extraction first so the visual classifier can populate routing.`
        );
    }

    if (ctx.usePerSection && ctx.detectedSections && !Array.isArray(ctx.extractionResult?.pages)) {
        throw new Error(
            `Per-section extraction requested for ${ctx.filename} but ` +
            `extractionResult.pages is ${typeof ctx.extractionResult?.pages}, not an array. ` +
            `This is a pipeline bug — pages should always be an array at this point.`
        );
    }
}

/**
 * Populate the context's extraction metadata and normalize page fields.
 *
 * Call after ctx.extractionResult is set (by runExtraction or from DB load).
 * This is the single place where pageCount/pagesToStore/extractionMetadata
 * are derived from extractionResult.
 */
export function finalizeExtractionOutput(ctx) {
    if (!ctx.extractionResult) {
        throw new Error('finalizeExtractionOutput: ctx.extractionResult must be set first');
    }

    const result = ctx.extractionResult;
    const pages = result.pages || [];

    // Resolve page count
    if (Array.isArray(pages) && pages.length > 0) {
        ctx.pageCount = pages.length;
        ctx.pagesToStore = pages;
    } else if (typeof pages === 'number') {
        ctx.pageCount = pages;
        ctx.pagesToStore = pages;
    } else {
        ctx.pageCount = ctx.file.page_count || null;
        ctx.pagesToStore = null;
    }

    // Build metadata
    ctx.extractionMetadata = buildExtractionMetadata({
        extractionResult: result,
        classifierMeta: ctx.classifierMeta,
        pageCount: ctx.pageCount,
    });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default {
    createFileProcessingContext,
    buildExtractionMetadata,
    assertReadyForExtraction,
    assertReadyForAI,
    finalizeExtractionOutput,
};
