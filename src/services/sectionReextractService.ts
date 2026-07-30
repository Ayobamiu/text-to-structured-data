/**
 * Section re-extraction — the extraction half of "Save & Re-extract",
 * shared by the HTTP endpoints (sync legacy path) and the worker (queued
 * `sreex` jobs, the default path for the routing UI).
 *
 * Job state lives in `detected_sections` itself, NOT a request table. Two
 * independent per-section markers say what a section still owes:
 *   - `section_result_id == null && !superseded_by` → needs AI extraction
 *   - `needs_text_reextract === true`               → needs its pages re-OCR'd
 * The endpoints persist the edited sections BEFORE anything is enqueued.
 * Single-section reprocess ("Re-run Text Extraction" / "Re-run AI
 * Processing") is just those two markers set on one section, which is why it
 * needs no mode of its own. That makes the job:
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

/** Per-section marker: re-OCR this section's extraction_pages before extracting.
 *  Set by "Reprocess section → Re-run Text Extraction"; cleared by the job once
 *  the fresh text is persisted. */
export const TEXT_REEXTRACT_FLAG = 'needs_text_reextract';

export interface SectionReextractProgress {
    phase: 'started' | 'section' | 'done' | 'failed';
    completed: number;
    total: number;
    section_index?: number;
    slug?: string;
    /** 'success' | 'error' from extraction, or 'text_reextracted' for a
     *  section whose only work was a re-OCR. */
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
    /** Sections whose pages were force re-OCR'd this run. */
    textReextractIndices: number[];
    sectionResults: AnyRecord[];
    pagesWithoutText: number[];
    detectedSections: AnyRecord | null;
    result: AnyRecord | null;
    reviewStatus: string | null;
    error?: string;
}

// ── Run marker ──────────────────────────────────────────────────────────
// Progress used to live only in socket events, so the UI lost it on every
// remount (tab switch, pane toggle, reload) and had nothing to re-read.
// The marker makes a run part of the file's persisted state, exactly like
// the pending set itself: it rides the existing file-patch channel and the
// initial file load, so the client re-derives progress instead of
// remembering it. No request table, no new endpoint (2026-07-29).
//
// It answers only the two questions the pending set can't:
//   - is a run actually in flight? (15% of files carry idle pending
//     sections, so "something is null" is not the same as "a job is running")
//   - how many sections did it START with? (so the bar reads 3/7 rather
//     than counting down from an unknown total)

export const SREEX_RUN_KEY = 'sreex_run';

export type SreexRunOrigin = 'save' | 'reprocess' | 'reextract';

export interface SreexRun {
    section_indices: number[];
    total: number;
    started_at: string;
    origin: SreexRunOrigin;
    finished_at?: string | null;
    error?: string | null;
}

export interface SreexRunProgress {
    total: number;
    done: number;
    doneIndices: number[];
    pendingIndices: number[];
    /** Every section resolved, or the worker explicitly finished/failed. */
    finished: boolean;
    error: string | null;
    origin: SreexRunOrigin;
    startedAt: string;
}

/**
 * Stamp a run marker onto a detected_sections blob. Pure — returns a copy;
 * the caller persists it in the same write that marks the sections pending,
 * so the marker and the pending set can never disagree.
 */
export function withSreexRun(
    detectedSections: AnyRecord,
    sectionIndices: number[],
    origin: SreexRunOrigin,
): AnyRecord {
    const run: SreexRun = {
        section_indices: [...sectionIndices],
        total: sectionIndices.length,
        started_at: new Date().toISOString(),
        origin,
        finished_at: null,
        error: null,
    };
    return { ...detectedSections, [SREEX_RUN_KEY]: run };
}

/**
 * Mark the run finished (or failed). Pure. Kept rather than deleted so the
 * card can show a terminal state; the client drops it on dismiss.
 */
export function finishSreexRun(detectedSections: AnyRecord, error: string | null = null): AnyRecord {
    const run = detectedSections?.[SREEX_RUN_KEY];
    if (!run) return detectedSections;
    return {
        ...detectedSections,
        [SREEX_RUN_KEY]: { ...run, finished_at: new Date().toISOString(), error: error ?? null },
    };
}

/**
 * Finalize a run by file id, for callers that don't hold the blob — the
 * worker's catch, where runSectionReextraction threw before it could
 * finalize. Without this the card would sit spinning until the client's
 * "nothing pending" fallback caught it.
 */
export async function finalizeSreexRunById(fileId: string, error: string | null = null): Promise<AnyRecord | null> {
    const row = await pool.query(`SELECT detected_sections FROM job_files WHERE id = $1`, [fileId]);
    const detected = parseMaybeJson(row.rows[0]?.detected_sections);
    if (!detected?.[SREEX_RUN_KEY]) return null;
    const finalized = finishSreexRun(detected, error);
    await updateFileDetectedSections(fileId, finalized);
    return finalized;
}

/**
 * Re-derive progress from persisted state alone — the whole point of the
 * marker. A section counts as done once it has an id (or was superseded
 * mid-run); `finished` also goes true when nothing is left pending, so a
 * worker that died without finalizing can't strand the card forever.
 *
 * Mirrored on the web side (sreexRun.ts) — keep the two in step.
 */
export function computeSreexRunProgress(
    detectedSections: AnyRecord | null | undefined,
): SreexRunProgress | null {
    const run = detectedSections?.[SREEX_RUN_KEY] as SreexRun | undefined;
    if (!run || !Array.isArray(run.section_indices)) return null;

    const sections = Array.isArray(detectedSections?.sections) ? detectedSections!.sections : [];
    const doneIndices: number[] = [];
    const pendingIndices: number[] = [];
    for (const i of run.section_indices) {
        const section = sections[i];
        // A section deleted mid-run leaves nothing to wait for.
        if (!section) continue;
        // Two kinds of outstanding work, and a text-only reprocess has the
        // second WITHOUT the first: the section keeps its id while its pages
        // are re-OCR'd, so id-alone would report it done before it started.
        const awaitingAi = section.section_result_id == null && !section.superseded_by;
        const awaitingText = section[TEXT_REEXTRACT_FLAG] === true;
        if (awaitingAi || awaitingText) pendingIndices.push(i);
        else doneIndices.push(i);
    }

    return {
        total: typeof run.total === 'number' ? run.total : run.section_indices.length,
        done: doneIndices.length,
        doneIndices,
        pendingIndices,
        finished: Boolean(run.finished_at) || pendingIndices.length === 0,
        error: run.error ?? null,
        origin: run.origin ?? 'save',
        startedAt: run.started_at,
    };
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
 * Indices of sections whose pages must be re-OCR'd before extraction — the
 * "Re-run Text Extraction" half of single-section reprocess. Independent of
 * the AI-pending set: a section can need only the re-OCR (keeps its record),
 * only extraction, or both.
 */
export function computeTextReextractIndices(sections: AnyRecord[] | null | undefined): number[] {
    if (!Array.isArray(sections)) return [];
    return sections
        .map((s, i) => (s?.[TEXT_REEXTRACT_FLAG] === true && !s?.superseded_by ? i : -1))
        .filter((i) => i >= 0);
}

/**
 * Every section this job will touch, in document order — the AI-pending set
 * plus the re-OCR set. Drives the progress denominator so a text-only
 * reprocess still reports 0/1 → 1/1 rather than 0/0.
 */
export function computeTouchedSectionIndices(sections: AnyRecord[] | null | undefined): number[] {
    const union = new Set([
        ...computePendingSectionIndices(sections),
        ...computeTextReextractIndices(sections),
    ]);
    return [...union].sort((a, b) => a - b);
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
 * re-reads detected_sections at run time, so it picks up markers set after
 * it was enqueued — a second Save, or a reprocess on another section, folds
 * into the pending run). Returns true when a new queue item was created.
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
    const textReextractIndices = computeTextReextractIndices(detectedSections.sections);
    const touchedIndices = computeTouchedSectionIndices(detectedSections.sections);
    if (touchedIndices.length === 0) {
        return {
            status: 'no_sections',
            sectionIndices: [],
            textReextractIndices: [],
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

    progress({ phase: 'started', completed: 0, total: touchedIndices.length });

    // ── Page text: backfill + forced re-OCR ────────────────────────────
    // Two reasons a page needs OCR before extraction can run:
    //   1. BACKFILL — a page a reviewer newly assigned to a section has no
    //      stored text (`selected_pages[i]` is the original PDF page whose
    //      text lives at `pages[i]`), so per-section extraction would skip it
    //      for "no content".
    //   2. FORCED — the operator asked for "Re-run Text Extraction" on a
    //      section, so its pages are re-OCR'd even though text already exists.
    // Both are the same operation on different page sets, so they run as ONE
    // scoped extraction through reextractSectionText (which replaces existing
    // page text in place and inserts missing pages, aligned or not).
    let effectivePages = filePages;
    let effectiveSelectedPages = selectedPages;
    let pagesWithoutText: number[] = [];

    const pagesToOcr = new Set<number>();
    // Forced: every page of every section flagged for re-OCR.
    for (const i of textReextractIndices) {
        for (const p of (detectedSections.sections[i].extraction_pages || [])) {
            if (typeof p === 'number') pagesToOcr.add(p);
        }
    }
    // Backfill: pages of pending sections with no stored text. Only
    // determinable when selected_pages exists — without it, pages[] is keyed
    // by original page number and nothing is "missing" by construction.
    if (Array.isArray(effectiveSelectedPages)) {
        const haveText = new Set(effectiveSelectedPages);
        for (const i of sectionIndices) {
            for (const p of (detectedSections.sections[i].extraction_pages || [])) {
                if (typeof p === 'number' && !haveText.has(p)) pagesToOcr.add(p);
            }
        }
    }

    if (pagesToOcr.size > 0) {
        const targets = [...pagesToOcr].sort((a, b) => a - b);
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
            `🔎 Scoped text extraction for ${targets.length} page(s) ` +
            `[${targets.join(', ')}] via ${exMethod} ` +
            `(${textReextractIndices.length} section(s) forced, rest backfill)`,
        );

        const { reextractSectionText } = await import('./sectionReprocessService.js');
        const re = await reextractSectionText({
            extractionService,
            file,
            pages: effectivePages,
            selectedPages: effectiveSelectedPages,
            pageNumbers: targets,
            exMethod,
            exOptions,
        });
        if (!re.success) {
            throw new Error(
                `Could not extract text for page(s) [${targets.join(', ')}]: ${re.error}`,
            );
        }

        // Every success path in reextractSectionText returns pages; the
        // fallback only satisfies its optional JSDoc type.
        effectivePages = re.pages ?? effectivePages;
        effectiveSelectedPages = re.selectedPages ?? null;
        pagesWithoutText = re.pagesWithoutText || [];

        // Persist the enriched text at the source (not a read-time patch).
        await updateFilePages(fileId, effectivePages);
        if (Array.isArray(effectiveSelectedPages)) {
            await updateFileSelectedPages(fileId, effectiveSelectedPages);
        }

        if (pagesWithoutText.length > 0) {
            console.log(
                `⚠️ No extractable text for page(s) [${pagesWithoutText.join(', ')}] — ` +
                `their section(s) may report no content`,
            );
        }
    }

    // Clone once — every downstream write (cleared re-OCR markers, new
    // section ids, consumed edits) lands on this copy.
    let finalDetectedSections = JSON.parse(JSON.stringify(detectedSections));
    let completedCount = 0;

    // The re-OCR is done and persisted, so drop the markers now: a crash
    // between here and the AI pass must not re-bill the OCR on resume.
    if (textReextractIndices.length > 0) {
        for (const i of textReextractIndices) {
            delete finalDetectedSections.sections[i][TEXT_REEXTRACT_FLAG];
        }
        await updateFileDetectedSections(fileId, finalDetectedSections);

        // Sections whose ONLY work was the re-OCR are finished here — they
        // keep their existing record and never enter the AI pass.
        for (const i of textReextractIndices) {
            if (sectionIndices.includes(i)) continue;
            completedCount += 1;
            progress({
                phase: 'section',
                completed: completedCount,
                total: touchedIndices.length,
                section_index: i,
                slug: finalDetectedSections.sections[i]?.document_type_slug,
                status: 'text_reextracted',
            });
        }
    }

    if (sectionIndices.length === 0) {
        // Text-only reprocess: fresh page text is persisted and no record
        // changes, so the envelope and review rollup stay as they were.
        finalDetectedSections = finishSreexRun(finalDetectedSections);
        await updateFileDetectedSections(fileId, finalDetectedSections);
        patch({ detected_sections: finalDetectedSections });
        progress({ phase: 'done', completed: completedCount, total: touchedIndices.length });
        console.log(
            `✅ Section text re-extraction completed for file ${file.filename}: ` +
            `${textReextractIndices.length} section(s), no AI pass needed`,
        );
        return {
            status: 'success',
            sectionIndices: [],
            textReextractIndices,
            sectionResults: [],
            pagesWithoutText,
            detectedSections: finalDetectedSections,
            result: parseMaybeJson(file.result),
            reviewStatus: null,
        };
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

    const oldRecordById = indexRecordsById(parseMaybeJson(file.result));
    const newRecordById = new Map<string, { slug: string; record: AnyRecord }>();

    // Sections run in parallel; incremental writes are serialized through
    // this chain so result/detected_sections updates never interleave.
    let writeChain: Promise<void> = Promise.resolve();

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
                total: touchedIndices.length,
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
        finalDetectedSections = finishSreexRun(finalDetectedSections, firstError);
        await updateFileDetectedSections(fileId, finalDetectedSections);
        patch({ detected_sections: finalDetectedSections });
        progress({
            phase: 'failed', completed: completedCount, total: touchedIndices.length, error: firstError,
        });
        return {
            status: 'failed',
            sectionIndices,
            textReextractIndices,
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
    finalDetectedSections = finishSreexRun(finalDetectedSections);
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
    progress({ phase: 'done', completed: completedCount, total: touchedIndices.length });

    console.log(
        `✅ Section re-extraction completed for file ${file.filename}: ` +
        `${perSection.sectionResults.filter((r: AnyRecord) => r.status === 'success').length} succeeded`,
    );

    return {
        status: 'success',
        sectionIndices,
        textReextractIndices,
        sectionResults: perSection.sectionResults,
        pagesWithoutText,
        detectedSections: finalDetectedSections,
        result: mergedResult,
        reviewStatus,
    };
}

export default {
    SECTION_REEXTRACT_MODE,
    SREEX_RUN_KEY,
    withSreexRun,
    finishSreexRun,
    finalizeSreexRunById,
    computeSreexRunProgress,
    TEXT_REEXTRACT_FLAG,
    computePendingSectionIndices,
    computeTextReextractIndices,
    computeTouchedSectionIndices,
    rebuildEnvelopeById,
    indexRecordsById,
    enqueueSectionReextraction,
    recomputeFileReviewStatus,
    cleanupOrphanSectionRows,
    runSectionReextraction,
};
