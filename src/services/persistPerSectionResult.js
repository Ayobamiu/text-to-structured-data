/**
 * Shared persistence for a successful per-section (v2 envelope) extraction.
 *
 * Three call sites run per-section extraction — the queue worker, the inline
 * `/extract` background path, and "save & re-extract". They must persist the
 * result identically; when one drifted (the inline `/extract` path skipped the
 * section_result_id write-back), routing showed sections as "needs
 * re-extraction" and QA failed with no linked section. This helper is the one
 * place that persistence happens so the paths can't diverge again.
 *
 * It does two things, in order:
 *   1. Stamps each successful section's `section_result_id` onto the matching
 *      `detected_sections.sections[section_index]`, then persists detected_sections.
 *      This is the link routing/QA use to map a section → its extraction record.
 *   2. Builds the v2 `finalMetadata` and writes the result envelope + metadata
 *      via updateFileProcessingStatus (status='completed').
 *
 * NOTE: this intentionally does NOT emit websocket/file patches or processing
 * events — those differ per call site (worker has a socket emitter; the HTTP
 * paths use emitFileFullPatch). Callers keep doing their own emit after this
 * resolves.
 */

import { updateFileDetectedSections, updateFileProcessingStatus } from '../database.js';

/**
 * @param {Object} args
 * @param {string} args.fileId
 * @param {Object} args.detectedSections   The classifier's detected_sections blob
 *                                          (mutated in place to add section_result_id,
 *                                          then persisted). Pass null to skip.
 * @param {Object} args.perSection          Return value of extractAndProcessPerSection.
 * @param {Object} [args.baseMetadata]      Existing metadata to spread under the v2 fields
 *                                          (e.g. pre-processing metadata).
 * @returns {Promise<{ finalMetadata: Object, successCount: number, failedCount: number, skippedCount: number }>}
 */
export async function persistPerSectionResult({
    fileId,
    detectedSections,
    perSection,
    baseMetadata = {},
}) {
    if (!fileId) throw new Error('persistPerSectionResult requires fileId');
    if (!perSection || !Array.isArray(perSection.sectionResults)) {
        throw new Error('persistPerSectionResult requires perSection.sectionResults');
    }

    const sectionResults = perSection.sectionResults;
    const failedCount = sectionResults.filter((r) => r.status === 'failed').length;
    const skippedCount = sectionResults.filter((r) => r.status?.startsWith('skipped_')).length;
    const successCount = sectionResults.filter((r) => r.status === 'success').length;

    // 1. Link each section to its extraction record by stamping the
    //    section_result_id back onto detected_sections, then persist.
    if (detectedSections && Array.isArray(detectedSections.sections)) {
        for (const sr of sectionResults) {
            if (sr.status === 'success' && sr.section_result_id) {
                const sec = detectedSections.sections[sr.section_index];
                if (sec) sec.section_result_id = sr.section_result_id;
            }
        }
        await updateFileDetectedSections(fileId, detectedSections);
    }

    // 2. Assemble the v2 metadata and persist the envelope.
    const finalMetadata = {
        ...baseMetadata,
        result_envelope: 'v2',
        section_results: sectionResults,
        schemas_used: perSection.schemasUsed,
        per_section_extraction: {
            section_count: sectionResults.length,
            success_count: successCount,
            failed_count: failedCount,
            skipped_count: skippedCount,
            total_ai_time_seconds: perSection.totalAiTimeSeconds,
        },
    };

    await updateFileProcessingStatus(
        fileId,
        'completed',
        perSection.resultEnvelope,
        null,
        finalMetadata,
        perSection.totalAiTimeSeconds || null,
    );

    return { finalMetadata, successCount, failedCount, skippedCount };
}

export default { persistPerSectionResult };
