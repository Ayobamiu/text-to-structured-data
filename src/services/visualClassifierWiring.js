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
 * Failure semantics: when `useVisualClassifier` is on and the classifier
 * fails, `classifierFailed: true` is returned so callers can abort rather
 * than silently extracting every page of a large document.  Callers that
 * want the old "fall back to full file" behaviour can check the flag and
 * proceed anyway.
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
 *   detectedSections: Object|null,
 *   classifierFailed?: boolean,
 *   noExtractableContent?: boolean
 * }>}
 *
 *   noExtractableContent
 *     - true when the classifier ran successfully but every page is "none"
 *       (no extractable pages). Callers MUST skip extraction and mark the file
 *       as completed-with-no-content rather than extracting the whole document.
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
export async function deriveSelectedPagesAndMeta({ file, jobProcessingConfig, s3Service, usePerSection }) {
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
        // The visual classifier is explicitly enabled but produced nothing.
        // Instead of silently extracting every page (dangerous for large
        // documents — a 200-page PDF would be fully ingested into the LLM),
        // surface a classifierMeta failure object AND return selectedPages=null
        // so callers can decide whether to proceed or abort.
        const failureMeta = classifierResult?.failureMeta || {
            ran: false,
            reason: 'unknown',
        };
        console.error(
            `❌ Visual classifier FAILED for ${file.filename} — ` +
            `reason: ${failureMeta.reason || 'unknown'}` +
            (failureMeta.error ? ` — ${failureMeta.error}` : '') +
            `. Returning empty page set to prevent full-document fallback.`
        );
        return {
            selectedPages: null,
            classifierMeta: failureMeta,
            detectedSections: null,
            classifierFailed: true,
        };
    }

    const sections = classifierResult.detectedSections.sections || [];
    // In VPC-only mode (per-section off), include all sections in the page
    // set — there's no per-section review gate, so dropping pending_review
    // sections would silently shrink the page set with no recovery path.
    // When per-section IS on, honour the routing-review gate: pending_review
    // sections are held back until approved by an operator.
    const perSectionResolved = usePerSection !== undefined
        ? usePerSection
        : resolveExtractionFlags(jobProcessingConfig).usePerSection;
    const pages = flattenExtractionPages(sections, {
        includePendingReview: !perSectionResolved,
    });

    if (pages.length === 0) {
        // The classifier ran successfully and determined there is nothing worth
        // extracting (every page is "none"/boilerplate/blank). Do NOT fall back
        // to full-document extraction — that ingests an entire (possibly
        // hundreds-of-page) PDF into the LLM for no benefit. Signal callers to
        // skip extraction and mark the file as "no extractable content".
        console.warn(
            `⚠️ Visual classifier found no extractable pages for ${file.filename} ` +
            `(${sections.length} section(s)) — skipping extraction (no_extractable_pages)`
        );
        return {
            selectedPages: null,
            noExtractableContent: true,
            // Surface detectedSections so the UI can still show the (empty)
            // routing decision.
            detectedSections: classifierResult.detectedSections,
            classifierMeta: {
                ran: true,
                fell_back: false,
                skipped: true,
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
    // Diagnostic logging — print every gating check so intermittent
    // failures are diagnosable from the worker/server logs alone.
    const hasS3Key = Boolean(file?.s3_key);
    const hasS3Service = Boolean(s3Service);
    const vpcFlag = jobProcessingConfig?.useVisualClassifier;
    console.log(
        `🔍 VPC gating for ${file?.filename}: ` +
        `useVisualClassifier=${vpcFlag}, s3_key=${hasS3Key ? 'yes' : 'MISSING'}, ` +
        `s3Service=${hasS3Service ? 'yes' : 'MISSING'}, ` +
        `file.id=${file?.id || 'MISSING'}, job_id=${file?.job_id ?? 'null'}`
    );

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
        const reasons = [];
        if (!stage.enabled) reasons.push('stage disabled');
        if (vpcFlag !== true) reasons.push(`useVisualClassifier=${vpcFlag}`);
        if (!hasS3Key) reasons.push('no s3_key');
        if (!hasS3Service) reasons.push('no s3Service');
        const reasonStr = reasons.join(', ') || 'unknown';
        console.warn(`⚠️ Visual classifier gating FAILED for ${file.filename}: ${reasonStr}`);
        return { failureMeta: { ran: false, reason: 'gating_conditions_not_met', detail: reasonStr } };
    }

    console.log(`✅ VPC gating passed for ${file.filename} — running classifier...`);

    try {
        stage.validate(stageContext);
        const result = await stage.execute(stageContext);
        if (!result?.detectedSections) {
            const reason = result?.visualPageClassifier?.reason || 'no_detected_sections';
            console.warn(`⚠️ Visual classifier returned no detected_sections for ${file.filename} (${reason})`);
            return { failureMeta: { ran: true, reason, detail: result?.visualPageClassifier } };
        }
        return result;
    } catch (error) {
        console.error(`❌ Visual classifier threw for ${file.filename}: ${error.message}`);
        stage.handleError(error, stageContext);
        return { failureMeta: { ran: true, reason: 'exception', error: error.message } };
    }
}

/**
 * Resolve the two extraction-mode flags from a job's processing_config,
 * with backward compatibility: existing jobs that only have
 * useVisualClassifier=true (set before the split) are treated as
 * useVisualClassifier=true + usePerSectionExtraction=true so their
 * v2-envelope behaviour is preserved.
 *
 * @param {Object|null} processingConfig  Parsed processing_config from the job.
 * @returns {{ useClassifier: boolean, usePerSection: boolean }}
 */
export function resolveExtractionFlags(processingConfig) {
    const cfg = processingConfig || {};
    const useClassifier = cfg.useVisualClassifier === true;
    const usePerSection =
        cfg.usePerSectionExtraction !== undefined
            ? cfg.usePerSectionExtraction === true
            : useClassifier; // backward compat: old jobs implicitly had per-section on
    return { useClassifier, usePerSection };
}

export default {
    deriveSelectedPagesAndMeta,
    runVisualClassifier,
    resolveExtractionFlags,
};
