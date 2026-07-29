/**
 * Section Reprocess Service
 *
 * Helpers for reprocessing a SINGLE section of a file and for slicing a
 * section's markdown out of the file's pages. Extracted so the section
 * endpoints in server.js stay small and the alignment math lives in one place.
 *
 * Two page representations exist in the system:
 *   - job_files.pages  → [{ page_number, text }]  (text IS markdown). This is
 *     what the AI pipeline consumes and what we slice for the markdown view.
 *   - selected_pages    → [originalPdfPage, …] aligned 1:1 with pages[] when the
 *     file was extracted from a SUBSET of the PDF. When absent, pages[].page_number
 *     is already the original PDF page number.
 *
 * A section's `extraction_pages` are always ORIGINAL PDF page numbers.
 */

/** Find a section's index in detected_sections by its section_result_id. */
export function resolveSectionIndex(detectedSections, sectionResultId) {
    const sections = detectedSections?.sections;
    if (!Array.isArray(sections)) return -1;
    return sections.findIndex((s) => s?.section_result_id === sectionResultId);
}

/**
 * Map a section's original `extraction_pages` to the file's stored page text.
 * Returns { markdown, pages } where pages is [{ page_number, markdown }] for just
 * this section (page_number is the ORIGINAL pdf page), and markdown is those
 * concatenated. Pure — no IO.
 */
export function sliceSectionMarkdown({ pages, selectedPages, extractionPages }) {
    const pagesArr = Array.isArray(pages) ? pages : [];
    const exPages = Array.isArray(extractionPages) ? extractionPages : [];

    const textForOriginal = (orig) => {
        if (Array.isArray(selectedPages) && selectedPages.length > 0) {
            const i = selectedPages.indexOf(orig);
            return i >= 0 ? (pagesArr[i]?.text ?? pagesArr[i]?.markdown ?? '') : '';
        }
        const p = pagesArr.find(
            (pg) => pg?.page_number === orig,
        );
        return p?.text ?? p?.markdown ?? '';
    };

    const sectionPages = exPages.map((orig) => ({
        page_number: orig,
        markdown: String(textForOriginal(orig) || ''),
    }));
    const markdown = sectionPages
        .map((p) => p.markdown)
        .filter((t) => t && t.trim())
        .join('\n\n');

    return { markdown, pages: sectionPages };
}

/**
 * Re-OCR a set of original PDF pages and merge the fresh text into the file's
 * aligned pages/selected_pages arrays (REPLACING existing text for those pages,
 * inserting any that weren't present). Returns the new arrays; does not persist.
 *
 * @returns {Promise<{ success:boolean, error?:string, pages?:object[],
 *   selectedPages?:number[]|null, pagesWithoutText?:number[] }>}
 */
export async function reextractSectionText({
    extractionService,
    file,
    pages,
    selectedPages,
    pageNumbers,
    exMethod,
    exOptions,
}) {
    const targets = [...new Set(pageNumbers)].filter((p) => typeof p === 'number');
    if (targets.length === 0) {
        return { success: true, pages, selectedPages, pagesWithoutText: [] };
    }
    targets.sort((a, b) => a - b);

    const scoped = await extractionService.extractScopedText(
        file.filename,
        file.s3_key,
        exMethod,
        exOptions,
        targets,
    );
    if (!scoped.success) {
        return { success: false, error: scoped.error || 'scoped extraction failed' };
    }

    // Returned pages are numbered 1..k within the filtered PDF → map back to the
    // original page via targets[n-1]. A page can yield several chunks; concat.
    const textByOriginal = new Map();
    for (const pg of scoped.pages || []) {
        const n = typeof pg.page_number === 'number' ? pg.page_number : null;
        if (!n || n < 1 || n > targets.length) continue;
        const orig = targets[n - 1];
        const txt = (pg.text ?? pg.markdown ?? '').toString();
        textByOriginal.set(orig, (textByOriginal.get(orig) || '') + txt);
    }

    const pagesWithoutText = [];
    const aligned = Array.isArray(selectedPages) && selectedPages.length > 0;

    if (aligned) {
        // Rebuild from existing (orig ↔ text), replace/insert targets, re-sort,
        // re-sequence page_number 1..N (mirrors save-and-reextract).
        const merged = selectedPages.map((orig, i) => ({
            orig,
            text: (pages?.[i]?.text ?? pages?.[i]?.markdown ?? '').toString(),
        }));
        const byOrig = new Map(merged.map((m) => [m.orig, m]));
        for (const orig of targets) {
            const text = textByOriginal.get(orig) || '';
            if (!text.trim()) pagesWithoutText.push(orig);
            if (byOrig.has(orig)) byOrig.get(orig).text = text;
            else {
                const entry = { orig, text };
                merged.push(entry);
                byOrig.set(orig, entry);
            }
        }
        merged.sort((a, b) => a.orig - b.orig);
        return {
            success: true,
            pagesWithoutText,
            selectedPages: merged.map((m) => m.orig),
            pages: merged.map((m, i) => ({ page_number: i + 1, text: m.text })),
        };
    }

    // No selected_pages: pages[].page_number is already the original page number.
    const next = (Array.isArray(pages) ? pages : []).map((p) => ({ ...p }));
    const byNum = new Map(next.map((p) => [p.page_number, p]));
    for (const orig of targets) {
        const text = textByOriginal.get(orig) || '';
        if (!text.trim()) pagesWithoutText.push(orig);
        if (byNum.has(orig)) byNum.get(orig).text = text;
        else {
            const entry = { page_number: orig, text };
            next.push(entry);
            byNum.set(orig, entry);
        }
    }
    next.sort((a, b) => (a.page_number ?? 0) - (b.page_number ?? 0));
    return { success: true, pages: next, selectedPages: selectedPages ?? null, pagesWithoutText };
}

/**
 * Rebuild the V2 result envelope after re-extracting a subset of sections,
 * pairing records to sections by section_result_id. Lifted from the
 * reextract-sections endpoint so single-section reprocess reuses identical
 * logic. Pure — returns the new blobs; caller persists.
 *
 * DEPRECATED (no runtime callers). Every re-extraction path now runs through
 * sectionReextractService, whose `rebuildEnvelopeById` does the same job over
 * the full section list instead of an index-paired subset. Kept — not
 * deleted — until the sync fallbacks on save-and-reextract / reextract-sections
 * / section reprocess are dropped, since a rollback to those handlers would
 * need it back.
 *
 * @returns {{ mergedResult:object, updatedDetectedSections:object,
 *   sectionResults:object[] }}
 */
export function rebuildEnvelopeForSections({ file, perSection, sectionIndices }) {
    // 1. Index NEW records by section_result_id
    const newRecordById = new Map();
    const slugCounters = {};
    for (let pi = 0; pi < perSection.sectionResults.length; pi++) {
        const sr = perSection.sectionResults[pi];
        if (sr.status !== 'success' || !sr.section_result_id) continue;
        const slug = sr.slug;
        const slugArr = perSection.resultEnvelope[slug];
        if (!slugArr) continue;
        if (slugCounters[slug] == null) slugCounters[slug] = 0;
        const record = slugArr[slugCounters[slug]++];
        if (record) newRecordById.set(sr.section_result_id, { slug, record });
    }

    // 2. Index OLD records by section_result_id
    const oldRecordById = new Map();
    const existingResult = file.result || {};
    for (const [slug, arr] of Object.entries(existingResult)) {
        if (!Array.isArray(arr)) continue;
        for (const rec of arr) {
            if (rec?.section_result_id) oldRecordById.set(rec.section_result_id, { slug, record: rec });
        }
    }

    // 3. Write new section_result_ids back to detected_sections
    const updatedDetectedSections = JSON.parse(JSON.stringify(file.detected_sections));
    for (let pi = 0; pi < perSection.sectionResults.length; pi++) {
        const sr = perSection.sectionResults[pi];
        const originalIndex = sectionIndices[pi];
        if (sr.status === 'success' && sr.section_result_id) {
            updatedDetectedSections.sections[originalIndex].section_result_id = sr.section_result_id;
        }
    }
    updatedDetectedSections.edits = [];

    // 4. Walk ALL sections in order, pick record by ID (new wins over old)
    const mergedResult = {};
    for (const section of updatedDetectedSections.sections) {
        const slug = section.document_type_slug;
        const id = section.section_result_id;
        if (!slug) continue;
        if (!mergedResult[slug]) mergedResult[slug] = [];
        const newEntry = id ? newRecordById.get(id) : null;
        const oldEntry = id ? oldRecordById.get(id) : null;
        if (newEntry) mergedResult[slug].push(newEntry.record);
        else if (oldEntry) mergedResult[slug].push(oldEntry.record);
    }

    return {
        mergedResult,
        updatedDetectedSections,
        sectionResults: perSection.sectionResults.map((sr, pi) => ({
            ...sr,
            section_index: sectionIndices[pi],
        })),
    };
}

export default {
    resolveSectionIndex,
    sliceSectionMarkdown,
    reextractSectionText,
    rebuildEnvelopeForSections,
};
