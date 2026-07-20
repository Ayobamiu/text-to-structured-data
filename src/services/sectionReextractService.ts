/**
 * Section re-extraction — the extraction half of "Save & Re-extract",
 * shared by the HTTP endpoints (sync legacy path) and the worker (queued
 * `sreex` jobs, the default path for the routing UI).
 *
 * Job state lives in `detected_sections` itself, NOT a request table:
 * "what needs extraction" is exactly `section_result_id == null &&
 * !superseded_by`, and the save endpoint persists the edited sections
 * BEFORE anything is enqueued. That makes the job:
 *   - idempotent      (re-running extracts only still-null sections),
 *   - crash-resumable (each finished section persists incrementally),
 *   - edit-tolerant   (the worker re-reads the latest sections at run time,
 *                      so edits made while queued are honored).
 *
 * Incremental persistence: as each section finishes (they run in parallel
 * inside extractAndProcessPerSection), its record is merged into the result
 * envelope and its section_result_id written to detected_sections, then a
 * file patch is emitted — so finished sections pop into the UI live while
 * the rest still cook. Writes are serialized through a promise chain.
 *
 * The file's processing_status is NEVER flipped to 'processing' here: the
 * rest of the envelope stays valid throughout, and blanking the Results tab
 * for a partial re-extract was exactly the UX this service replaces.
 *
 * Queue: rides file_processing_queue as mode `sreex` (same share-the-queue
 * trick as QA `qa:*` and directed rex `rex:<id>`). Progress reaches the UI
 * as `section-reextract-progress-event` (same relay pattern as
 * `qa-progress-event`); data updates ride the normal file-patch channel.
 */

import pool, {
    updateFileDetectedSections,
    updateFilePages,
    updateFileSelectedPages,
    updateFileProcessingStatus,
} from '../database.js';
import queueService from '../queue.js';

export const SECTION_REEXTRACT_MODE = 'sreex';

type AnyRecord = Record<string, any>;

export interface SectionReextractProgress {
    phase: 'started' | 'section' | 'done' | 'failed';
    completed: number;
    total: number;
    section_index?: number;
    slug?: string;
    status?: string;
    error?: string;
}

export interface RunSectionReextractionArgs {
    fileId: string;
    /** ExtractionService instance (server and worker each own one). */
    extractionService: AnyRecord;
    /** ProcessingService instance. */
    processingService: AnyRecord;
    /** File-patch channel: (patch) => void. Server binds emitFilePatch;
     *  the worker emits `file-status-update` over its socket (the server
     *  converts that to the same patch shape). Never include
     *  processing_status here. */
    emitPatch?: ((patch: AnyRecord) => void) | null;
    /** Progress channel for the `section-reextract-progress-event` relay. */
    onProgress?: ((evt: SectionReextractProgress) => void) | null;
}

export interface RunSectionReextractionResult {
    status: 'success' | 'no_sections' | 'failed';
    sectionIndices: number[];
    sectionResults: AnyRecord[];
    pagesWithoutText: number[];
    detectedSections: AnyRecord | null;
    result: AnyRecord | null;
    reviewStatus: string | null;
    error?: string;
}

/**
 * Indices of sections that need extraction: no extraction record yet and
 * not superseded (superseded sections never extract — their canonical twin
 * carries the data).
 */
export function computePendingSectionIndices(sections: AnyRecord[] | null | undefined): number[] {
    if (!Array.isArray(sections)) return [];
    return sections
        .map((s, i) => (s?.section_result_id == null && !s?.superseded_by ? i : -1))
        .filter((i) => i >= 0);
}

/**
 * Rebuild the V2 envelope by section_result_id: walk sections in document
 * order, pick each live section's record from the new-records map first,
 * then the old envelope. Sections with a null id (still extracting / failed)
 * and superseded sections contribute nothing.
 */
export function rebuildEnvelopeById(
    sections: AnyRecord[],
    newRecordById: Map<string, { slug: string; record: AnyRecord }>,
    oldRecordById: Map<string, { slug: string; record: AnyRecord }>,
): AnyRecord {
    const merged: AnyRecord = {};
    for (const section of sections) {
        const slug = section?.document_type_slug;
        const id = section?.section_result_id;
        if (!slug || section?.superseded_by) continue;
        if (!merged[slug]) merged[slug] = [];
        const entry = (id && newRecordById.get(id)) || (id && oldRecordById.get(id)) || null;
        if (entry) merged[slug].push(entry.record);
    }
    return merged;
}

/** Index a V2 envelope's records by their section_result_id. */
export function indexRecordsById(
    envelope: AnyRecord | null | undefined,
): Map<string, { slug: string; record: AnyRecord }> {
    const byId = new Map<string, { slug: string; record: AnyRecord }>();
    if (envelope && typeof envelope === 'object') {
        for (const [slug, arr] of Object.entries(envelope)) {
            if (!Array.isArray(arr)) continue;
            for (const rec of arr) {
                if (rec?.section_result_id) byId.set(rec.section_result_id, { slug, record: rec });
            }
        }
    }
    return byId;
}

/**
 * Enqueue a section re-extraction job for the file. Deduped: if a `sreex`
 * item is already queued for this file, this is a no-op (the queued run
 * re-reads detected_sections at run time, so it picks the new edits up).
 * Returns true when a new queue item was created.
 */
export async function enqueueSectionReextraction(fileId: string, jobId: string): Promise<boolean> {
    const existing = await pool.query(
        `SELECT id FROM file_processing_queue
         WHERE file_id = $1 AND mode = $2 AND status = 'queued'
         LIMIT 1`,
        [fileId, SECTION_REEXTRACT_MODE],
    );
    if (existing.rows.length > 0) {
        console.log(`⏭️ sreex already queued for file ${fileId} — dedupe`);
        return false;
    }
    await queueService.addFileToQueue(fileId, jobId, 0, SECTION_REEXTRACT_MODE);
    return true;
}

/**
 * Recompute + persist the file-level review_status rollup from
 * section_verifications vs the envelope's record count.
 * (Moved from server.js so worker-run re-extraction can refresh it too.)
 */
export async function recomputeFileReviewStatus(fileId: string, client: AnyRecord = pool): Promise<string> {
    const [verRows, totalRow] = await Promise.all([
        client.query(`SELECT status FROM section_verifications WHERE file_id = $1`, [fileId]),
        client.query(
            `SELECT COALESCE(SUM(jsonb_array_length(v)), 0)::int AS total
             FROM job_files, jsonb_each(result) AS kv(k, v)
             WHERE id = $1 AND jsonb_typeof(result) = 'object'`,
            [fileId],
        ),
    ]);
    const statuses = verRows.rows.map((r: AnyRecord) => r.status);
    const totalSections = totalRow.rows[0]?.total ?? 0;
    let fileReviewStatus = 'pending';
    if (statuses.length > 0) {
        if (statuses.every((s: string) => s === 'approved') && statuses.length >= totalSections) {
            fileReviewStatus = 'approved';
        } else if (statuses.some((s: string) => s === 'rejected')) {
            fileReviewStatus = 'rejected';
        } else if (statuses.some((s: string) => s === 'approved' || s === 'in_review')) {
            fileReviewStatus = 'in_review';
        }
    }
    await client.query(
        `UPDATE job_files SET review_status = $1, updated_at = NOW() WHERE id = $2`,
        [fileReviewStatus, fileId],
    );
    return fileReviewStatus;
}

/**
 * Delete verification / QA rows keyed to section_result_ids that no longer
 * exist on the file (section deleted or re-extracted under a new id).
 * (Moved from server.js — see recomputeFileReviewStatus.)
 */
export async function cleanupOrphanSectionRows(fileId: string, currentIds: (string | null)[]): Promise<number> {
    const ids = (currentIds || []).filter(Boolean);
    const where = `file_id = $1 AND NOT (section_result_id = ANY($2::uuid[]))`;
    const [ver, runs, findings] = await Promise.all([
        pool.query(`DELETE FROM section_verifications WHERE ${where}`, [fileId, ids]),
        pool.query(`DELETE FROM section_qa_runs WHERE ${where}`, [fileId, ids]),
        pool.query(`DELETE FROM section_qa_findings WHERE ${where}`, [fileId, ids]),
    ]);
    const removed = (ver.rowCount || 0) + (runs.rowCount || 0) + (findings.rowCount || 0);
    if (removed > 0) {
        console.log(
            `🧹 Removed ${ver.rowCount} verification / ${runs.rowCount} QA-run / ` +
            `${findings.rowCount} QA-finding row(s) orphaned on file ${fileId}`,
        );
    }
    return removed;
}

function parseMaybeJson(value: unknown): AnyRecord | null {
    if (value == null) return null;
    if (typeof value === 'object') return value as AnyRecord;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Run section re-extraction for every pending section on the file.
 * Reads all state from the DB (detected_sections must already be saved).
 */
export async function runSectionReextraction({
    fileId,
    extractionService,
    processingService,
    emitPatch = null,
    onProgress = null,
}: RunSectionReextractionArgs): Promise<RunSectionReextractionResult> {
    const progress = (evt: SectionReextractProgress) => {
        try {
            onProgress?.(evt);
        } catch { /* progress must never break extraction */ }
    };
    const patch = (p: AnyRecord) => {
        try {
            emitPatch?.(p);
        } catch { /* patches must never break extraction */ }
    };

    // ── Load state ──────────────────────────────────────────────────────
    const fileRow = await pool.query(
        `SELECT id, job_id, filename, s3_key, selected_pages, detected_sections,
                result, extraction_metadata, pages
         FROM job_files WHERE id = $1`,
        [fileId],
    );
    if (fileRow.rows.length === 0) {
        throw new Error(`File ${fileId} not found`);
    }
    const file = fileRow.rows[0];
    const detectedSections = parseMaybeJson(file.detected_sections);
    if (!detectedSections || !Array.isArray(detectedSections.sections)) {
        throw new Error(`File ${fileId} has no detected_sections`);
    }

    const sectionIndices = computePendingSectionIndices(detectedSections.sections);
    if (sectionIndices.length === 0) {
        return {
            status: 'no_sections',
            sectionIndices: [],
            sectionResults: [],
            pagesWithoutText: [],
            detectedSections,
            result: parseMaybeJson(file.result),
            reviewStatus: null,
        };
    }

    const filePages = Array.isArray(file.pages) ? file.pages : parseMaybeJson(file.pages);
    if (!filePages || !Array.isArray(filePages) || filePages.length === 0) {
        throw new Error('File has no extracted pages — run extraction first');
    }

    const jobRow = await pool.query(`SELECT processing_config FROM jobs WHERE id = $1`, [file.job_id]);
    if (jobRow.rows.length === 0) {
        throw new Error('Job not found');
    }
    // Some jobs persisted processing_config double-encoded (a JSON string in
    // the jsonb column) — normalize so method/options resolve.
    const jobProcessingConfig = parseMaybeJson(jobRow.rows[0].processing_config) || {};
    const processingMethod = jobProcessingConfig.processing?.method || 'openai';
    const processingOptions = jobProcessingConfig.processing?.options || {};

    let selectedPages: number[] | null = Array.isArray(file.selected_pages)
        ? file.selected_pages
        : (parseMaybeJson(file.selected_pages) as number[] | null);

    progress({ phase: 'started', completed: 0, total: sectionIndices.length });

    // ── Text backfill for newly-assigned pages ─────────────────────────
    // `selected_pages[i]` is the original PDF page number whose text lives at
    // `pages[i]`. A page a reviewer newly assigned to a section has no stored
    // text, so per-section extraction would skip it for "no content". Extract
    // just those pages from the original PDF and merge at the source.
    let effectivePages = filePages;
    let effectiveSelectedPages = selectedPages;
    const pagesWithoutText: number[] = [];

    if (Array.isArray(effectiveSelectedPages)) {
        const haveText = new Set(effectiveSelectedPages);
        const neededPages = new Set<number>();
        for (const i of sectionIndices) {
            for (const p of (detectedSections.sections[i].extraction_pages || [])) {
                neededPages.add(p);
            }
        }
        const missingPages = [...neededPages]
            .filter((p) => typeof p === 'number' && !haveText.has(p))
            .sort((a, b) => a - b);

        if (missingPages.length > 0) {
            // Use the method the file was ACTUALLY extracted with, so the new
            // pages' text matches the existing pages. Default extendai (the
            // S3-native extractor) rather than paddleocr, which needs a
            // running local service.
            const existingMeta = parseMaybeJson(file.extraction_metadata) || {};
            const exMethod = existingMeta.extraction_method
                || jobProcessingConfig.extraction?.method
                || 'extendai';
            const exOptions = jobProcessingConfig.extraction?.options || {};
            console.log(
                `🔎 ${missingPages.length} newly-assigned page(s) lack stored text ` +
                `[${missingPages.join(', ')}] — scoped re-extract via ${exMethod}`,
            );

            const scoped = await extractionService.extractScopedText(
                file.filename, file.s3_key, exMethod, exOptions, missingPages,
            );
            if (!scoped.success) {
                throw new Error(
                    `Could not extract text for newly assigned page(s) ` +
                    `[${missingPages.join(', ')}]: ${scoped.error}`,
                );
            }

            // Returned pages are numbered 1..k within the filtered PDF; map
            // back via missingPages[n-1]. A page can yield several chunks.
            const textByOriginal = new Map<number, string>();
            for (const pg of (scoped.pages || [])) {
                const n = typeof pg.page_number === 'number' ? pg.page_number : null;
                if (!n || n < 1 || n > missingPages.length) continue;
                const orig = missingPages[n - 1];
                const txt = (pg.text ?? pg.markdown ?? '').toString();
                textByOriginal.set(orig, (textByOriginal.get(orig) || '') + txt);
            }

            const merged = effectiveSelectedPages.map((orig: number, i: number) => ({
                orig,
                text: (effectivePages[i]?.text ?? effectivePages[i]?.markdown ?? '').toString(),
            }));
            for (const orig of missingPages) {
                const text = textByOriginal.get(orig) || '';
                if (!text.trim()) pagesWithoutText.push(orig);
                merged.push({ orig, text });
            }
            merged.sort((a, b) => a.orig - b.orig);
            effectiveSelectedPages = merged.map((m) => m.orig);
            effectivePages = merged.map((m, i) => ({ page_number: i + 1, text: m.text }));

            // Persist the enriched text at the source (not a read-time patch).
            await updateFilePages(fileId, effectivePages);
            await updateFileSelectedPages(fileId, effectiveSelectedPages);

            if (pagesWithoutText.length > 0) {
                console.log(
                    `⚠️ No extractable text for page(s) [${pagesWithoutText.join(', ')}] — ` +
                    `their section(s) may report no content`,
                );
            }
        }
    }

    // ── Per-section extraction with incremental persistence ────────────
    const partialSections = {
        ...detectedSections,
        sections: sectionIndices.map((i) => detectedSections.sections[i]),
    };

    const { extractAndProcessPerSection } = await import('./perSectionExtractor.js');

    console.log(
        `🔄 Section re-extraction for file ${file.filename}: ` +
        `${sectionIndices.length} section(s) [${sectionIndices.join(', ')}]`,
    );

    const finalDetectedSections = JSON.parse(JSON.stringify(detectedSections));
    const oldRecordById = indexRecordsById(parseMaybeJson(file.result));
    const newRecordById = new Map<string, { slug: string; record: AnyRecord }>();

    // Sections run in parallel; incremental writes are serialized through
    // this chain so result/detected_sections updates never interleave.
    let writeChain: Promise<void> = Promise.resolve();
    let completedCount = 0;

    const perSection = await extractAndProcessPerSection({
        detectedSections: partialSections,
        pages: effectivePages,
        processingService,
        processingMethod,
        processingOptions,
        selectedPages: effectiveSelectedPages,
        onSectionComplete: (info: AnyRecord) => {
            completedCount += 1;
            const originalIndex = sectionIndices[info.section_index];
            progress({
                phase: 'section',
                completed: completedCount,
                total: sectionIndices.length,
                section_index: originalIndex,
                slug: info.slug,
                status: info.status,
            });
            if (info.status !== 'success' || !info.section_result_id || info.data === undefined) {
                return;
            }
            // Land this section's result now: new id into detected_sections,
            // record into the envelope, patch out to clients.
            writeChain = writeChain.then(async () => {
                newRecordById.set(info.section_result_id, {
                    slug: info.slug,
                    record: { section_result_id: info.section_result_id, ...info.data },
                });
                finalDetectedSections.sections[originalIndex].section_result_id = info.section_result_id;
                const envelope = rebuildEnvelopeById(
                    finalDetectedSections.sections, newRecordById, oldRecordById,
                );
                await pool.query(
                    `UPDATE job_files SET result = $1, updated_at = NOW() WHERE id = $2`,
                    [envelope, fileId],
                );
                await updateFileDetectedSections(fileId, finalDetectedSections);
                patch({ result: envelope, detected_sections: finalDetectedSections });
            }).catch((err: Error) => {
                console.error(`⚠️ incremental section write failed: ${err.message}`);
            });
        },
    });

    await writeChain;

    if (!perSection.anySuccess) {
        const firstError = perSection.sectionResults.find((r: AnyRecord) => r.error)?.error
            || 'No section produced a result';
        progress({
            phase: 'failed', completed: completedCount, total: sectionIndices.length, error: firstError,
        });
        return {
            status: 'failed',
            sectionIndices,
            sectionResults: perSection.sectionResults,
            pagesWithoutText,
            detectedSections: finalDetectedSections,
            result: null,
            reviewStatus: null,
            error: firstError,
        };
    }

    // ── Finalize ────────────────────────────────────────────────────────
    // Edits were consumed by this pass (same semantics as the old endpoint).
    finalDetectedSections.edits = [];
    await updateFileDetectedSections(fileId, finalDetectedSections);

    const mergedResult = rebuildEnvelopeById(
        finalDetectedSections.sections, newRecordById, oldRecordById,
    );

    const existingMeta = parseMaybeJson(file.extraction_metadata) || {};
    const finalMetadata = {
        ...existingMeta,
        result_envelope: 'v2',
        section_results: perSection.sectionResults.map((sr: AnyRecord, pi: number) => ({
            ...sr,
            section_index: sectionIndices[pi],
        })),
    };

    await (updateFileProcessingStatus as (...args: any[]) => Promise<unknown>)(
        fileId, 'completed', mergedResult, null, finalMetadata,
        perSection.totalAiTimeSeconds || null,
    );

    // Sections deleted, superseded, or re-extracted under a new id leave
    // verification/QA rows keyed to the old id — drop those and refresh the
    // file-level review rollup.
    await cleanupOrphanSectionRows(
        fileId,
        finalDetectedSections.sections
            .filter((s: AnyRecord) => !s.superseded_by)
            .map((s: AnyRecord) => s.section_result_id)
            .filter(Boolean),
    );
    const reviewStatus = await recomputeFileReviewStatus(fileId);

    patch({
        result: mergedResult,
        detected_sections: finalDetectedSections,
        review_status: reviewStatus,
    });
    progress({ phase: 'done', completed: completedCount, total: sectionIndices.length });

    console.log(
        `✅ Section re-extraction completed for file ${file.filename}: ` +
        `${perSection.sectionResults.filter((r: AnyRecord) => r.status === 'success').length} succeeded`,
    );

    return {
        status: 'success',
        sectionIndices,
        sectionResults: perSection.sectionResults,
        pagesWithoutText,
        detectedSections: finalDetectedSections,
        result: mergedResult,
        reviewStatus,
    };
}

export default {
    SECTION_REEXTRACT_MODE,
    computePendingSectionIndices,
    rebuildEnvelopeById,
    indexRecordsById,
    enqueueSectionReextraction,
    recomputeFileReviewStatus,
    cleanupOrphanSectionRows,
    runSectionReextraction,
};
