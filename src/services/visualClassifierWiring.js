import { VisualPageClassifierStage } from '../pipeline/stages/VisualPageClassifierStage.js';
import { flattenExtractionPages } from './sectionGrouper.js';

/**
 * Visual Page Classifier wiring helpers (Phase 1, item #2).
 *
 * Single source of truth for "which pages should the extractor see?" so both
 * the worker (queued path) and the in-process /extract handler stay aligned.
 *
 * The module:
 *   1. Decides whether to run the classifier (gated by feature flag + has-S3-PDF)
 *   2. Runs it (persists detected_sections to job_files itself, via the stage)
 *   3. Translates classifier output → a flat list of page numbers for the
 *      extractor's existing `selectedPages` plumbing
 *   4. Returns provenance metadata so callers can fold it into
 *      `extraction_metadata.visual_page_classifier` for visibility
 *
 * Failure semantics: every edge case falls back to "extract the whole file".
 * The classifier is optional — losing it should never fail a file.
 */

/**
 * @param {Object}   args
 * @param {Object}   args.file               File row. Needs: id, filename,
 *                                           s3_key, optionally selected_pages
 *                                           (array | JSON string), job_id,
 *                                           storage_type.
 * @param {Object}   args.jobProcessingConfig Parsed processing_config from
 *                                            the job.
 * @param {Object}   args.s3Service          Live S3Service instance.
 * @returns {Promise<{
 *   selectedPages: number[]|null,
 *   classifierMeta: Object|null,
 *   detectedSections: Object|null
 * }>}
 *
 *   selectedPages
 *     - manual file selected_pages if set (precedence #1)
 *     - classifier-derived list if useVisualClassifier=true and the run
 *       produced ≥1 extractable page
 *     - null otherwise (= extract whole file)
 *
 *   classifierMeta
 *     - null if the classifier did not run (manual selection, flag off,
 *       gating failed, etc.)
 *     - object describing what happened when it did run, including a
 *       fall_back/fall_back_reason field when the run succeeded but yielded
 *       no extractable pages. Callers should fold this into
 *       extraction_metadata.visual_page_classifier.
 *
 *   detectedSections
 *     - null when the classifier did not run, or ran and produced no usable
 *       sections (in which case the caller should NOT attempt per-section
 *       extraction — fall back to the v1 single-schema path).
 *     - the classifier output object (same shape as `job_files.detected_sections`)
 *       when the run succeeded with ≥1 extractable page. Per-section extraction
 *       consumes this directly so the caller doesn't have to re-fetch from
 *       the DB.
 */
export async function deriveSelectedPagesAndMeta({ file, jobProcessingConfig, s3Service }) {
    // (1) Manual selection wins. Tolerate string-encoded JSON because some
    // file rows pass through with selected_pages as a TEXT column value.
    let manual = file?.selected_pages;
    if (typeof manual === 'string') {
        try { manual = JSON.parse(manual); } catch { manual = null; }
    }
    if (Array.isArray(manual) && manual.length > 0) {
        console.log(`📄 Using manual selected_pages for ${file.filename}: ${manual.join(', ')}`);
        return { selectedPages: manual, classifierMeta: null, detectedSections: null };
    }

    // (2) Visual classifier, gated by feature flag.
    if (jobProcessingConfig?.useVisualClassifier !== true) {
        return { selectedPages: null, classifierMeta: null, detectedSections: null };
    }

    const classifierResult = await runVisualClassifier({ file, jobProcessingConfig, s3Service });
    if (!classifierResult || !classifierResult.detectedSections) {
        return { selectedPages: null, classifierMeta: null, detectedSections: null };
    }

    const sections = classifierResult.detectedSections.sections || [];
    // Permissive default: include pending_review sections too. There is no
    // routing-review UI yet (Phase 1 item #4); excluding pending_review
    // would silently drop those pages forever. Tighten this once the UI lands.
    const pages = flattenExtractionPages(sections, { includePendingReview: true });

    if (pages.length === 0) {
        console.warn(
            `⚠️ Visual classifier returned no extractable pages for ${file.filename} ` +
            `(${sections.length} section(s)) — falling back to full document`
        );
        return {
            selectedPages: null,
            // Even though we're falling back to the v1 path on selection, we
            // still surface detectedSections so downstream callers can see
            // the (empty) routing decision in the UI.
            detectedSections: classifierResult.detectedSections,
            classifierMeta: {
                ran: true,
                fell_back: true,
                fell_back_reason: 'no_extractable_pages',
                section_count: sections.length,
                file_status: classifierResult.detectedSections.status,
                classifier: classifierResult.detectedSections.classifier,
            },
        };
    }

    const totalPages = classifierResult.detectedSections.pages?.length || pages.length;
    console.log(
        `📄 Using visual-classifier-derived pages for ${file.filename}: ` +
        `${pages.length}/${totalPages} (${pages.join(', ')})`
    );

    return {
        selectedPages: pages,
        detectedSections: classifierResult.detectedSections,
        classifierMeta: {
            ran: true,
            fell_back: false,
            section_count: sections.length,
            file_status: classifierResult.detectedSections.status,
            extraction_pages: pages,
            total_pages: totalPages,
            classifier: classifierResult.detectedSections.classifier,
        },
    };
}

/**
 * Run the VisualPageClassifierStage directly (without going through a full
 * pipeline runner). The stage handles its own DB persistence of
 * detected_sections and degrades gracefully on failure.
 *
 * @returns {Promise<Object|null>} Stage result with `detectedSections` on
 *   success, or `null` when the stage chose not to run / failed silently.
 */
export async function runVisualClassifier({ file, jobProcessingConfig, s3Service }) {
    const stage = new VisualPageClassifierStage({ s3Service });
    const stageContext = {
        fileId: file.id,
        jobId: file.job_id ?? null,
        filename: file.filename,
        fileInfo: {
            id: file.id,
            filename: file.filename,
            job_id: file.job_id ?? null,
            s3_key: file.s3_key,
            storage_type: file.storage_type || 's3',
        },
        processingConfig: jobProcessingConfig || {},
    };

    if (!stage.shouldRun(stageContext)) {
        console.log(`ℹ️ Visual classifier did not run for ${file.filename} (gating conditions not met)`);
        return null;
    }

    try {
        stage.validate(stageContext);
        const result = await stage.execute(stageContext);
        if (!result?.detectedSections) {
            console.warn(`⚠️ Visual classifier returned no detected_sections for ${file.filename}`);
            return null;
        }
        return result;
    } catch (error) {
        // Stage's own handleError logs; we don't rethrow because the
        // classifier is optional — falling back to full-document extraction
        // is always preferable to failing the whole file.
        stage.handleError(error, stageContext);
        return null;
    }
}

export default {
    deriveSelectedPagesAndMeta,
    runVisualClassifier,
};
