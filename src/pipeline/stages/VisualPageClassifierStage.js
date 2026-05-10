import { PipelineStage } from '../PipelineStage.js';
import { getDocumentTypesBySlugs } from '../../services/schemaRegistry.js';
import { classifyPdf } from '../../services/visualPageClassifier.js';
import {
    groupIntoSections,
    deriveFileStatus,
    getGrouperMetadata,
} from '../../services/sectionGrouper.js';

/**
 * VisualPageClassifierStage (Phase 1, item #2)
 *
 * Runs BEFORE extraction (different from FormationPageDetectionPreStage which
 * runs AFTER extraction). The whole point is to classify pages from their
 * rendered images so the existing extraction step can later be scoped to
 * just the pages that matter.
 *
 * This turn's wiring is intentionally minimal:
 *   - Stage is added but NOT yet inserted into the worker pipeline.
 *   - Behaviour change is gated by `processingConfig.useVisualClassifier`.
 *   - Output is persisted to job_files.detected_sections; no other column or
 *     code path is changed.
 *
 * The next turn (item #3) is what teaches the worker to read
 * detected_sections and skip OCR for pages outside any section.
 */
export class VisualPageClassifierStage extends PipelineStage {
    constructor(options = {}) {
        super('visual_page_classifier', {
            enabled: options.enabled !== false,
            required: false,           // Optional — failure should not fail the file
            retryable: true,
            ...options,
        });

        this.s3Service = options.s3Service || null; // Required at execute time
        this.classifierOptions = options.classifierOptions || {};
        this.persistResult = options.persistResult !== false; // Allow tests / dry-runs to skip the DB write
    }

    /**
     * Only run when:
     *   - The job's processing_config opts in via useVisualClassifier=true.
     *   - The file has an s3_key (we need a PDF to rasterise).
     *   - We have an S3 service injected.
     *   - There is at least one registered document_type to classify against.
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
        // Validation (unknown slugs error loudly) happens in the registry helper.
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

        const detectedSections = {
            classifier: classification.classifier,
            grouper: getGrouperMetadata(),
            // Provenance for the slug enum used at classification time. Lets a
            // future debugger understand "model returned slug X — was X even
            // in the candidate set on this run?"
            candidate_slugs: documentTypes.map((dt) => dt.slug),
            pages: classification.pages,
            sections,
            status,
        };

        if (this.persistResult) {
            await this.#persistDetectedSections(context.fileId, detectedSections);
        }

        const sectionSummary = sections
            .map((s) => {
                const skipBreakdown = s.skipped_pages.length
                    ? ` skip(${s.skipped_pages.length})`
                    : '';
                return `${s.document_type_slug}[${s.page_range[0]}-${s.page_range[1]}] extract(${s.extraction_pages.length})${skipBreakdown}@${s.confidence.toFixed(2)}`;
            })
            .join(', ') || '(none)';

        const totalExtractPages = sections.reduce((n, s) => n + s.extraction_pages.length, 0);
        const totalSkipPages = sections.reduce((n, s) => n + s.skipped_pages.length, 0);
        console.log(
            `🧩 VisualPageClassifierStage: ${sections.length} section(s), file_status=${status}, extract=${totalExtractPages}, skip=${totalSkipPages} — ${sectionSummary}`
        );

        return {
            ...context,
            detectedSections,
            visualPageClassifier: {
                success: true,
                sectionCount: sections.length,
                extractionPageCount: totalExtractPages,
                skippedPageCount: totalSkipPages,
                fileStatus: status,
            },
        };
    }

    handleError(error, context) {
        // Optional stage — never fail the file because the classifier failed.
        // The downstream extractor falls back to its existing behaviour
        // (OCR everything) when detected_sections is missing.
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
