/**
 * Section Grouper (Phase 1, item #2)
 *
 * Turns per-page classifications from the visual classifier into a list of
 * sections — contiguous runs of pages with the same document_type_slug.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  Boundary strategy: 'slug_only' (current default; see history note below)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Sections form on exactly two signals, both deterministic:
 *
 *   1. A page with slug 'none' breaks the current run. Two slugged sections
 *      separated by a 'none' page are NOT merged.
 *
 *   2. A change of slug between adjacent pages starts a new section.
 *
 * That's it. page_role is recorded per page as descriptive metadata but is
 * NOT used to draw section boundaries.
 *
 * Why we removed role from boundary logic (history):
 *   The earlier version split sections on `page_role === 'first'` (and
 *   closed them on `'last'`, and treated `'standalone'` as its own section).
 *   In practice, single-page VLM calls cannot reliably assign role: the
 *   model sees each page in isolation and guesses from per-page visual
 *   cues like "title block visible → first" or "signature line → last",
 *   without sequence awareness. On a real 9-page MGS document we saw a
 *   `[first, first, first, last, last, last, middle, middle]` chain that
 *   fragmented one logical run into 6 sections.
 *
 *   Slug-only boundaries can OVER-merge — e.g. two consecutive distinct
 *   well log reports of the same type get glued into one section. That's
 *   a tractable problem for the per-section extractor downstream, where it
 *   has *all the OCR'd text on every page* and can split on title-block
 *   detection with much better signal than a low-res VLM glance.
 *
 *   Over-fragmenting is the worse failure mode (it forces extra extractor
 *   calls and confuses the routing-review UI), so we trade accepting some
 *   over-merge to eliminate over-fragment. Confirmed with stakeholder.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Section confidence:
 *
 *   - confidence = mean of per-page confidences (the headline number).
 *   - min_page_confidence = lowest per-page confidence in the section (used
 *     by the routing review threshold — a section is only as trustworthy as
 *     its weakest page).
 *
 * Status assignment:
 *
 *   - 'auto_approved' if min_page_confidence >= the document_type's
 *     routing_confidence_threshold.
 *   - 'pending_review' otherwise.
 *
 *   The routing-review UI (Phase 1, item #4) is what flips 'pending_review'
 *   → 'approved' once a human signs off. Per-section extraction (item #3)
 *   only runs on 'auto_approved' or 'approved'.
 */

const DEFAULT_THRESHOLD = 0.75;
// strategy v3: still slug-only boundaries; now also derives per-section
// extraction_pages and skipped_pages from page_purpose + duplicate_of
// (approach A + C). Boundary logic itself unchanged from v2.
const STRATEGY_VERSION = 3;
const STRATEGY_NAME = 'slug_only';

// A page is included in the extractor's working set only when both:
//   1. The classifier marked it page_purpose='data', AND
//   2. The deduplicator did not mark it as a copy of an earlier page.
// Anything else is recorded in `skipped_pages` with a reason so the
// routing-review UI can show humans what we're dropping and why.
const EXTRACTABLE_PURPOSE = 'data';

function avg(nums) {
    if (nums.length === 0) return 0;
    let sum = 0;
    for (const n of nums) sum += n;
    return sum / nums.length;
}

function minOrZero(nums) {
    if (nums.length === 0) return 0;
    let m = nums[0];
    for (const n of nums) if (n < m) m = n;
    return m;
}

function buildSkipEntry(page) {
    // Duplicate is the more specific signal; surface it first so the
    // routing-review UI can link directly to the canonical page. The page's
    // declared purpose is still useful context, so include it as a
    // sub-field rather than swallowing it.
    if (page.duplicate_of != null) {
        return {
            page_number: page.page_number,
            reason: 'duplicate',
            duplicate_of: page.duplicate_of,
            page_purpose: page.page_purpose ?? 'unknown',
        };
    }
    return {
        page_number: page.page_number,
        reason: page.page_purpose ?? 'unknown',
    };
}

/**
 * Group classifications into sections.
 *
 * @param {Array} pages
 *   From classifyPdf().pages — sorted ascending by page_number. Each page
 *   may have page_purpose (from the VLM) and duplicate_of (from pageDeduplicator).
 *   Both are optional; missing values are treated as 'unknown' and `null`.
 * @param {Object} [opts]
 * @param {Map<string, number>} [opts.thresholdsBySlug]
 *   slug -> routing_confidence_threshold (from document_types).
 *   Falls back to DEFAULT_THRESHOLD when slug isn't in the map.
 *
 * @returns {Array<{
 *   document_type_slug: string,
 *   page_range: [number, number],
 *   page_count: number,
 *   extraction_pages: number[],
 *   skipped_pages: Array<{ page_number, reason, duplicate_of?, page_purpose? }>,
 *   page_roles: string[],
 *   page_purposes: string[],
 *   confidence: number,
 *   min_page_confidence: number,
 *   status: 'auto_approved' | 'pending_review',
 *   threshold_used: number
 * }>}
 */
export function groupIntoSections(pages, opts = {}) {
    const thresholdsBySlug = opts.thresholdsBySlug instanceof Map ? opts.thresholdsBySlug : new Map();
    const sections = [];

    let current = null;

    function flush() {
        if (!current) return;
        const confidence = avg(current.confidences);
        const minConfidence = minOrZero(current.confidences);
        const threshold =
            thresholdsBySlug.get(current.document_type_slug) ?? DEFAULT_THRESHOLD;

        const extraction_pages = [];
        const skipped_pages = [];
        for (const p of current.pages) {
            const isData = (p.page_purpose ?? 'unknown') === EXTRACTABLE_PURPOSE;
            const isDuplicate = p.duplicate_of != null;
            if (isData && !isDuplicate) {
                extraction_pages.push(p.page_number);
            } else {
                skipped_pages.push(buildSkipEntry(p));
            }
        }

        sections.push({
            document_type_slug: current.document_type_slug,
            page_range: [current.startPage, current.endPage],
            page_count: current.endPage - current.startPage + 1,
            extraction_pages,
            skipped_pages,
            page_roles: current.roles,
            page_purposes: current.purposes,
            confidence: Number(confidence.toFixed(4)),
            min_page_confidence: Number(minConfidence.toFixed(4)),
            status: minConfidence >= threshold ? 'auto_approved' : 'pending_review',
            threshold_used: threshold,
        });
        current = null;
    }

    for (const p of pages) {
        const slug = p.document_type_slug;

        // Rule 1: 'none' breaks runs and produces no section.
        if (!slug || slug === 'none') {
            flush();
            continue;
        }

        // Rule 2: slug change starts a new section.
        if (current && current.document_type_slug !== slug) {
            flush();
        }

        if (!current) {
            current = {
                document_type_slug: slug,
                startPage: p.page_number,
                endPage: p.page_number,
                confidences: [p.confidence ?? 0],
                roles: [p.page_role ?? null],
                purposes: [p.page_purpose ?? 'unknown'],
                pages: [p],
            };
        } else {
            current.endPage = p.page_number;
            current.confidences.push(p.confidence ?? 0);
            current.roles.push(p.page_role ?? null);
            current.purposes.push(p.page_purpose ?? 'unknown');
            current.pages.push(p);
        }
    }

    flush();

    return sections;
}

/**
 * Convenience: derive an overall file-level status from the sections.
 *
 *   - 'pending_review' if any section is pending_review.
 *   - 'auto_approved'  if all sections are auto_approved.
 *   - 'skipped'        if there are no sections at all (every page was 'none').
 */
export function deriveFileStatus(sections) {
    if (!Array.isArray(sections) || sections.length === 0) return 'skipped';
    if (sections.some((s) => s.status === 'pending_review')) return 'pending_review';
    return 'auto_approved';
}

/**
 * Self-describing metadata for the grouper run, persisted alongside
 * `classifier:` in detected_sections so that future readers (debug tools,
 * accuracy analyses, migrations) can tell which version of the grouper
 * produced any given record.
 */
export function getGrouperMetadata() {
    return {
        strategy: STRATEGY_NAME,
        version: STRATEGY_VERSION,
    };
}

/**
 * Flatten the per-section `extraction_pages` arrays into a single sorted,
 * de-duplicated list of page numbers. This is what the worker hands to the
 * extractor as `selectedPages`.
 *
 * @param {Array} sections  - Output of groupIntoSections().
 * @param {Object} [opts]
 * @param {boolean} [opts.includePendingReview=true]
 *   When true (default), pages from sections in 'pending_review' status are
 *   included. We keep the default permissive because there is no routing-
 *   review UI yet (Phase 1, item #4); excluding pending_review sections now
 *   would mean those pages would never reach the extractor and the data
 *   would be silently dropped.
 *
 *   Once the routing-review UI exists, callers should pass
 *   `includePendingReview: false` so unreviewed sections are held back
 *   until a human approves them.
 *
 * @returns {number[]} Unique page numbers, ascending.
 */
export function flattenExtractionPages(sections, opts = {}) {
    if (!Array.isArray(sections) || sections.length === 0) return [];
    const includePendingReview = opts.includePendingReview !== false;
    const pages = new Set();
    for (const s of sections) {
        if (!includePendingReview && s.status !== 'auto_approved' && s.status !== 'approved') {
            continue;
        }
        for (const p of s.extraction_pages || []) {
            pages.add(p);
        }
    }
    return [...pages].sort((a, b) => a - b);
}

export default {
    groupIntoSections,
    deriveFileStatus,
    getGrouperMetadata,
    flattenExtractionPages,
};
