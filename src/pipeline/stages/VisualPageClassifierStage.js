import { PipelineStage } from '../PipelineStage.js';
import { getDocumentTypesBySlugs } from '../../services/schemaRegistry.js';
import { classifyPdf } from '../../services/visualPageClassifier.js';
import { classifyPdfBatched, deriveSectionsFromClassification } from '../../services/batchedVisualClassifier.js';
import {
    groupIntoSections,
    deriveFileStatus,
    getGrouperMetadata,
} from '../../services/sectionGrouper.js';

/**
 * VisualPageClassifierStage (Phase 1, item #2 — v2 batched)
 *
 * Runs BEFORE extraction. Classifies pages from their rendered images so the
 * extraction step can be scoped to just the pages that matter.
 *
 * v2 (batched classifier):
 *   - Sends pages in batches of 5 at high detail (768px, q=95)
 *   - Detects record boundaries and assigns record_id per page
 *   - Uses bounded context (last batch + record inventory) between batches
 *   - Produces per-page summaries for future re-use
 *   - Falls back to v1 (per-page, low detail) if batched classifier fails
 *
 * Behaviour change gated by `processingConfig.useVisualClassifier`.
 * Output persisted to job_files.detected_sections.
 */
export class VisualPageClassifierStage extends PipelineStage {
    constructor(options = {}) {
        super('visual_page_classifier', {
            enabled: options.enabled !== false,
            required: false,           // Optional — failure should not fail the file
            retryable: true,
            ...options,
        });

        this.s3Service = options.s3Service || null;
        this.classifierOptions = options.classifierOptions || {};
        this.persistResult = options.persistResult !== false;
    }

    /**
     * Only run when:
     *   - The job's processing_config opts in via useVisualClassifier=true.
     *   - The file has an s3_key (we need a PDF to rasterise).
     *   - We have an S3 service injected.
     */
    shouldRun(context) {
        if (!super.shouldRun(context)) return false;

        const flag = context.processingConfig?.useVisualClassifier === true;
        if (!flag) return false;

        const fileInfo = context.fileInfo || {};
        if (!fileInfo.s3_key) return false;

        if (!this.s3Service) return false;

        return true;
    }

    validate(context) {
        if (!context.fileId) throw new Error('VisualPageClassifierStage: fileId is required in context');
        if (!context.fileInfo?.s3_key) throw new Error('VisualPageClassifierStage: fileInfo.s3_key is required');
        if (!this.s3Service) throw new Error('VisualPageClassifierStage: s3Service must be injected at construction');
    }

    async execute(context) {
        // Per-job slug restriction. Empty array / undefined → all active types.
        const requestedSlugs = Array.isArray(context.processingConfig?.documentTypeSlugs)
            ? context.processingConfig.documentTypeSlugs
            : [];

        const documentTypes = await getDocumentTypesBySlugs(requestedSlugs);
        if (documentTypes.length === 0) {
            console.warn('⚠️  VisualPageClassifierStage: no registered document_types in registry; skipping');
            return {
                ...context,
                visualPageClassifier: {
                    skipped: true,
                    reason: 'no_registered_document_types',
                },
            };
        }

        if (requestedSlugs.length > 0) {
            console.log(
                `🎯 VisualPageClassifierStage: classifying against ${documentTypes.length} restricted type(s): ${documentTypes.map((d) => d.slug).join(', ')}`
            );
        }

        const s3Key = context.fileInfo.s3_key;
        console.log(`🧠 VisualPageClassifierStage: downloading PDF ${s3Key} for classification`);
        const pdfBuffer = await this.s3Service.downloadFile(s3Key);

        // Use batched classifier (v2) — falls back to v1 on failure
        let detectedSections;
        try {
            detectedSections = await this.#runBatchedClassifier(pdfBuffer, documentTypes, context);
        } catch (batchedErr) {
            console.warn(
                `⚠️  Batched classifier failed, falling back to per-page classifier: ${batchedErr.message}`
            );
            detectedSections = await this.#runLegacyClassifier(pdfBuffer, documentTypes, context);
        }

        if (this.persistResult) {
            await this.#persistDetectedSections(context.fileId, detectedSections);
        }

        const sections = detectedSections.sections || [];
        const totalExtractPages = sections.reduce((n, s) => n + (s.extraction_pages?.length || 0), 0);
        const totalSkipPages = sections.reduce((n, s) => n + (s.skipped_pages?.length || 0), 0);

        const sectionSummary = sections
            .map((s) => {
                const recId = s.record_id ? `[${s.record_id}]` : '';
                const skipBreakdown = (s.skipped_pages?.length || 0) > 0
                    ? ` skip(${s.skipped_pages.length})`
                    : '';
                return `${s.document_type_slug}${recId}[${s.page_range[0]}-${s.page_range[1]}] extract(${s.extraction_pages?.length || 0})${skipBreakdown}@${s.confidence.toFixed(2)}`;
            })
            .join(', ') || '(none)';

        console.log(
            `🧩 VisualPageClassifierStage: ${sections.length} section(s), file_status=${detectedSections.status}, extract=${totalExtractPages}, skip=${totalSkipPages} — ${sectionSummary}`
        );

        return {
            ...context,
            detectedSections,
            visualPageClassifier: {
                success: true,
                sectionCount: sections.length,
                extractionPageCount: totalExtractPages,
                skippedPageCount: totalSkipPages,
                fileStatus: detectedSections.status,
            },
        };
    }

    /**
     * v2: Batched classifier with record_id detection and bounded context.
     */
    async #runBatchedClassifier(pdfBuffer, documentTypes, context) {
        const classification = await classifyPdfBatched({
            pdfBuffer,
            documentTypes,
            options: this.classifierOptions,
        });

        const thresholdsBySlug = new Map(
            documentTypes.map((dt) => [
                dt.slug,
                Number(dt.routing_confidence_threshold) || 0.75,
            ])
        );

        const sections = deriveSectionsFromClassification(classification.pages, { thresholdsBySlug });
        const status = deriveFileStatus(sections);

        return {
            classifier: classification.classifier,
            // v5: sections carry explicit member_pages (non-contiguous
            // sections supported via routing edits; page_range is a derived
            // [min, max] display span from v5 on).
            grouper: { strategy: 'record_id', version: 5 },
            candidate_slugs: documentTypes.map((dt) => dt.slug),
            pages: classification.pages,
            sections,
            status,
            page_summaries: classification.pageSummaries,
            record_inventory: classification.recordInventory,
        };
    }

    /**
     * v1 fallback: Per-page classifier with slug_only grouping.
     */
    async #runLegacyClassifier(pdfBuffer, documentTypes, context) {
        const classification = await classifyPdf({
            pdfBuffer,
            documentTypes,
            options: this.classifierOptions,
        });

        const thresholdsBySlug = new Map(
            documentTypes.map((dt) => [
                dt.slug,
                Number(dt.routing_confidence_threshold) || 0.75,
            ])
        );

        const sections = groupIntoSections(classification.pages, { thresholdsBySlug });
        const status = deriveFileStatus(sections);

        return {
            classifier: classification.classifier,
            grouper: getGrouperMetadata(),
            candidate_slugs: documentTypes.map((dt) => dt.slug),
            pages: classification.pages,
            sections,
            status,
        };
    }

    handleError(error, context) {
        console.warn(`⚠️  VisualPageClassifierStage failed (non-fatal) for file ${context.fileId}: ${error.message}`);
        return {
            ...context,
            visualPageClassifier: {
                success: false,
                error: error.message,
            },
            errors: [
                ...(context.errors || []),
                {
                    stage: this.name,
                    error: error.message,
                    timestamp: new Date().toISOString(),
                    retryable: this.retryable,
                    fatal: false,
                },
            ],
        };
    }

    async #persistDetectedSections(fileId, detectedSections) {
        const { default: pool } = await import('../../database.js');
        const client = await pool.connect();
        try {
            await client.query(
                `UPDATE job_files
                 SET detected_sections = $1, updated_at = NOW()
                 WHERE id = $2`,
                [JSON.stringify(detectedSections), fileId]
            );
        } finally {
            client.release();
        }
    }
}

export default VisualPageClassifierStage;
