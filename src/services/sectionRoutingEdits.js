/**
 * Routing-review edits (Phase 1, item #4).
 *
 * Pure helpers that take a `detected_sections` blob (the JSON shape persisted
 * on `job_files.detected_sections` — see add_detected_sections_to_job_files.js
 * for the schema) and apply one of the human-routing-review actions:
 *
 *   - approveSection({ index })             → flip `pending_review` → `approved`
 *   - changeSectionSlug({ index, slug, ... }) → re-route a section to a different
 *                                                document type. Implicit approval.
 *   - splitSection({ index, atPage })       → split one section into two at the
 *                                                given page boundary. Implicit
 *                                                approval of both halves.
 *   - mergeSections({ indexA, indexB })     → merge two sections. They do NOT
 *                                                need to be page-adjacent: merging
 *                                                a log (pp 2–3) with its appendix
 *                                                figure (p 7) yields one section
 *                                                whose member_pages are [2,3,7].
 *   - attachPages({ index, pageNumbers })   → pull free pages (pages in no
 *                                                section, e.g. classified 'none')
 *                                                into an existing section.
 *
 * Page membership:
 *   `member_pages` (sorted original-PDF page numbers) is the source of truth
 *   for which pages a section owns. `page_range` is DERIVED display metadata
 *   ([min, max] span) and, since sections may be non-contiguous, two sections'
 *   ranges may interleave — never answer "does page P belong to section S?"
 *   with a range check; use `getMemberPages(section)`. Legacy sections
 *   (pre-member_pages blobs) fall back to expanding page_range, which is
 *   exact for them because they were always contiguous.
 *
 * All helpers:
 *   - Are pure: clone the input, never mutate it in place.
 *   - Recompute `blob.status` via `deriveFileStatus(blob.sections)`.
 *   - Append an entry to `blob.edits[]` so we have a per-file audit trail of
 *     human routing interventions (`{ kind, ts, ...detail }`).
 *
 * The endpoints in server.js validate auth + slug existence and persist the
 * returned blob via `updateFileDetectedSections`. Per-section extraction is
 * gated downstream by `flattenExtractionPages({ includePendingReview: false })`,
 * so flipping a section to `'approved'` is what makes it eligible for the
 * next reprocess pass. (Auto re-extraction on approval is a future iteration;
 * today the operator triggers reprocess after approving.)
 */

import { deriveFileStatus } from './sectionGrouper.js';

const VALID_SLUG = /^[a-z][a-z0-9_]{0,99}$/;
const EXTRACTABLE_PURPOSE = 'data';

/**
 * The section's member pages, sorted ascending. Falls back to expanding
 * `page_range` for legacy sections that predate explicit membership
 * (those were always contiguous, so the expansion is exact).
 */
export function getMemberPages(section) {
    if (Array.isArray(section?.member_pages) && section.member_pages.length > 0) {
        return [...section.member_pages].sort((a, b) => a - b);
    }
    const range = section?.page_range;
    if (!Array.isArray(range) || range.length !== 2) return [];
    const [start, end] = range;
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return [];
    const pages = [];
    for (let p = start; p <= end; p++) pages.push(p);
    return pages;
}

/**
 * Effective page purpose: a human override (set by attachPages) wins over
 * what the classifier said.
 */
function effectivePurpose(page) {
    return page.page_purpose_override ?? page.page_purpose ?? 'unknown';
}

/**
 * Approve a `pending_review` section.
 * Idempotent: a section already in `auto_approved` or `approved` is returned
 * unchanged (no audit entry written for a no-op).
 */
export function applyApproveSection(detectedSections, { index }) {
    const blob = cloneBlob(detectedSections);
    const section = requireSection(blob, index);

    if (section.status === 'approved' || section.status === 'auto_approved') {
        return blob;
    }

    section.status = 'approved';
    blob.status = deriveFileStatus(blob.sections);
    appendEdit(blob, { kind: 'approve', section_index: index });
    return blob;
}

/**
 * Re-route a section to a different document type slug.
 *
 * @param {Object} args
 * @param {number} args.index           Section index in blob.sections.
 * @param {string} args.slug            New document_type_slug. Caller is
 *                                       expected to have validated against
 *                                       the registry already.
 * @param {number} [args.threshold]     The new slug's
 *                                       routing_confidence_threshold (so
 *                                       the section's `threshold_used`
 *                                       reflects the new type). Optional;
 *                                       falls back to the section's existing
 *                                       threshold_used.
 *
 * Notes:
 *   - The change implicitly approves the section (operator picked the slug
 *     by hand, so we don't make them double-tap an "approve" afterwards).
 *   - Per-page `document_type_slug` for pages inside this section's range
 *     is also rewritten so downstream consumers (the routing panel, future
 *     analytics) see a consistent picture.
 */
export function applyChangeSectionSlug(detectedSections, { index, slug, threshold }) {
    if (!slug || typeof slug !== 'string' || !VALID_SLUG.test(slug)) {
        throw new Error(`Invalid slug '${slug}'`);
    }

    const blob = cloneBlob(detectedSections);
    const section = requireSection(blob, index);
    const oldSlug = section.document_type_slug;

    if (oldSlug === slug) {
        // No-op slug change still counts as a deliberate approval.
        if (section.status !== 'approved' && section.status !== 'auto_approved') {
            section.status = 'approved';
            blob.status = deriveFileStatus(blob.sections);
            appendEdit(blob, { kind: 'change_slug', section_index: index, from: oldSlug, to: slug });
        }
        return blob;
    }

    section.document_type_slug = slug;
    if (threshold != null && Number.isFinite(Number(threshold))) {
        section.threshold_used = Number(threshold);
    }
    section.status = 'approved';
    // Different slug = different schema → old extraction is invalid.
    section.section_result_id = null;

    // Rewrite per-page slugs by MEMBERSHIP, not range: a non-contiguous
    // section's range may span pages that belong to another section.
    const members = new Set(getMemberPages(section));
    for (const p of blob.pages || []) {
        if (typeof p.page_number === 'number' && members.has(p.page_number)) {
            p.document_type_slug = slug;
        }
    }

    blob.status = deriveFileStatus(blob.sections);
    appendEdit(blob, { kind: 'change_slug', section_index: index, from: oldSlug, to: slug });
    return blob;
}

/**
 * Split a section into two at `atPage`. The first half takes the member
 * pages below `atPage`, the second the member pages at/above it. For a
 * contiguous section this is the classic [start, atPage-1] / [atPage, end]
 * split; for a non-contiguous one it splits by position in the member list
 * (so splitting [2,3,7] at 7 peels the appendix page off into its own
 * section).
 *
 * Both halves inherit the original slug + threshold_used and are marked
 * `'approved'` (the act of splitting is itself a human routing decision).
 *
 * Throws if `atPage` would leave either half empty.
 */
export function applySplitSection(detectedSections, { index, atPage }) {
    if (!Number.isInteger(atPage) || atPage < 1) {
        throw new Error(`Invalid atPage '${atPage}' — must be a positive integer`);
    }

    const blob = cloneBlob(detectedSections);
    const section = requireSection(blob, index);
    const members = getMemberPages(section);

    const firstPages = members.filter((p) => p < atPage);
    const secondPages = members.filter((p) => p >= atPage);
    if (firstPages.length === 0 || secondPages.length === 0) {
        throw new Error(
            `atPage ${atPage} does not split section pages [${members.join(', ')}] ` +
            `into two non-empty halves`
        );
    }

    const allPages = Array.isArray(blob.pages) ? blob.pages : [];
    const first = buildSectionFromPages(allPages, firstPages, section);
    const second = buildSectionFromPages(allPages, secondPages, section);

    blob.sections.splice(index, 1, first, second);
    blob.status = deriveFileStatus(blob.sections);
    appendEdit(blob, { kind: 'split', section_index: index, at_page: atPage });
    return blob;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function cloneBlob(blob) {
    if (!blob || typeof blob !== 'object') {
        throw new Error('detected_sections is missing or invalid');
    }
    return JSON.parse(JSON.stringify(blob));
}

function requireSection(blob, index) {
    if (!Array.isArray(blob.sections)) {
        throw new Error('detected_sections.sections is missing');
    }
    if (!Number.isInteger(index) || index < 0 || index >= blob.sections.length) {
        throw new Error(
            `Section index ${index} is out of range (0..${blob.sections.length - 1})`
        );
    }
    return blob.sections[index];
}

function appendEdit(blob, entry) {
    if (!Array.isArray(blob.edits)) blob.edits = [];
    blob.edits.push({ ...entry, ts: new Date().toISOString() });
}

/**
 * Rebuild a section's derived fields from the blob.pages entries whose
 * page_number is in `memberPages` (explicit list — NOT a range: member
 * pages may be non-contiguous). Mirrors the logic in sectionGrouper.flush()
 * so rebuilt sections look indistinguishable from grouper-produced ones,
 * plus the explicit `member_pages` field.
 */
function buildSectionFromPages(allPages, memberPages, proto) {
    if (!Array.isArray(memberPages) || memberPages.length === 0) {
        throw new Error('Cannot build a section from an empty page list');
    }
    const member_pages = [...new Set(memberPages)].sort((a, b) => a - b);
    const memberSet = new Set(member_pages);
    const inSection = allPages
        .filter((p) => typeof p?.page_number === 'number' && memberSet.has(p.page_number))
        .sort((a, b) => a.page_number - b.page_number);

    const extraction_pages = [];
    const skipped_pages = [];
    const page_roles = [];
    const page_purposes = [];
    const confidences = [];

    for (const p of inSection) {
        const purpose = effectivePurpose(p);
        const isData = purpose === EXTRACTABLE_PURPOSE;
        const isDuplicate = p.duplicate_of != null;

        if (isData && !isDuplicate) {
            extraction_pages.push(p.page_number);
        } else if (isDuplicate) {
            skipped_pages.push({
                page_number: p.page_number,
                reason: 'duplicate',
                duplicate_of: p.duplicate_of,
                page_purpose: purpose,
            });
        } else {
            skipped_pages.push({ page_number: p.page_number, reason: purpose });
        }

        page_roles.push(p.page_role ?? null);
        page_purposes.push(purpose);
        confidences.push(typeof p.confidence === 'number' ? p.confidence : 0);
    }

    const confidence = confidences.length
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : 0;
    const minConfidence = confidences.length ? Math.min(...confidences) : 0;

    return {
        document_type_slug: proto.document_type_slug,
        member_pages,
        // Derived [min, max] span — display/sort only. May interleave with
        // other sections' spans once sections are non-contiguous.
        page_range: [member_pages[0], member_pages[member_pages.length - 1]],
        // Count of member pages, NOT the span width.
        page_count: member_pages.length,
        extraction_pages,
        skipped_pages,
        page_roles,
        page_purposes,
        confidence: Number(confidence.toFixed(4)),
        min_page_confidence: Number(minConfidence.toFixed(4)),
        // Splitting/merging is an explicit human decision: new sections come
        // out 'approved' so they're eligible for extraction without a
        // separate approve step.
        status: 'approved',
        threshold_used: proto.threshold_used,
        // New section has no extraction result yet — signals "needs extraction".
        section_result_id: null,
    };
}

/**
 * Merge two sections into one. The resulting section inherits sectionA's
 * slug and threshold_used (sectionA is the "anchor" the operator chose to
 * expand).
 *
 * The sections do NOT need to be page-adjacent: merging a log section
 * (pp 2–3) with its appendix figure section (p 7) is the intended gesture
 * for non-contiguous documents. The merged section's member_pages are the
 * UNION of both sections' member pages — pages in the gap between them are
 * untouched and stay with whatever section they belong to (or none).
 *
 * The merged section is marked `'approved'` (merging is a deliberate
 * human routing decision).
 *
 * @param {Object} detectedSections  The full detected_sections blob.
 * @param {Object} args
 * @param {number} args.indexA       Index of the anchor section (its slug
 *                                   and threshold are inherited).
 * @param {number} args.indexB       Index of the section to merge in.
 *                                   Any index ≠ indexA.
 * @param {string} [args.slug]      Optional slug override for the merged
 *                                   section. Defaults to sectionA's slug.
 */
export function applyMergeSections(detectedSections, { indexA, indexB, slug }) {
    if (!Number.isInteger(indexA) || !Number.isInteger(indexB)) {
        throw new Error('indexA and indexB must be integers');
    }
    if (indexA === indexB) {
        throw new Error('Cannot merge a section with itself');
    }

    const blob = cloneBlob(detectedSections);
    const secA = requireSection(blob, indexA);
    const secB = requireSection(blob, indexB);

    if (secA.superseded_by || secB.superseded_by) {
        throw new Error('Cannot merge a superseded section');
    }

    const pagesA = getMemberPages(secA);
    const pagesB = getMemberPages(secB);
    const overlap = pagesA.filter((p) => pagesB.includes(p));
    if (overlap.length > 0) {
        // Disjoint membership is an invariant; overlap means a corrupt blob.
        throw new Error(
            `Sections ${indexA} and ${indexB} both claim page(s) ${overlap.join(', ')} — ` +
            `refusing to merge a corrupt blob`
        );
    }

    const allPages = Array.isArray(blob.pages) ? blob.pages : [];
    const mergedPages = [...pagesA, ...pagesB];

    // Use the resolved slug (override or inherit from the anchor section)
    const proto = {
        ...secA,
        document_type_slug: slug || secA.document_type_slug,
    };

    const merged = buildSectionFromPages(allPages, mergedPages, proto);

    // Replace both sections with the merged one. Remove the higher index
    // first so the lower index stays valid; insert at the lower index —
    // the merged section starts at the earlier section's first page, so
    // ordering by start page is preserved.
    const hi = Math.max(indexA, indexB);
    const lo = Math.min(indexA, indexB);
    blob.sections.splice(hi, 1);
    blob.sections.splice(lo, 1, merged);
    blob.status = deriveFileStatus(blob.sections);
    appendEdit(blob, {
        kind: 'merge',
        section_index_a: indexA,
        section_index_b: indexB,
        merged_slug: merged.document_type_slug,
        merged_page_range: merged.page_range,
        merged_member_pages: merged.member_pages,
    });

    return blob;
}

/**
 * Attach free pages to an existing section. "Free" = pages that belong to
 * no section (typically classified slug 'none' — an appendix figure the
 * grouper had nothing to do with). This is the primary gesture for wiring
 * an appendix page to its log when the appendix never formed a section of
 * its own (when it did, use merge instead).
 *
 * Attached pages get `page_purpose_override: 'data'` (default) so they
 * actually land in extraction_pages — the classifier usually marked such
 * pages 'figure'/'supporting', which would otherwise silently exclude them
 * from extraction, making the attach pointless. Pass
 * `markAsData: false` to attach without the override (page kept for
 * provenance/display but not extracted).
 *
 * The section is rebuilt (member_pages union), marked 'approved', and its
 * section_result_id cleared — signalling "needs (re-)extraction".
 *
 * @param {Object} detectedSections  The full detected_sections blob.
 * @param {Object} args
 * @param {number} args.index          Target section index.
 * @param {number[]} args.pageNumbers  Original-PDF page numbers to attach.
 * @param {boolean} [args.markAsData=true]
 */
export function applyAttachPages(detectedSections, { index, pageNumbers, markAsData = true }) {
    if (!Array.isArray(pageNumbers) || pageNumbers.length === 0 ||
        !pageNumbers.every((p) => Number.isInteger(p) && p >= 1)) {
        throw new Error('pageNumbers must be a non-empty array of positive integers');
    }

    const blob = cloneBlob(detectedSections);
    const section = requireSection(blob, index);

    if (section.superseded_by) {
        throw new Error('Cannot attach pages to a superseded section');
    }

    const allPages = Array.isArray(blob.pages) ? blob.pages : [];
    const knownPages = new Set(
        allPages.map((p) => p?.page_number).filter((n) => typeof n === 'number')
    );
    const unknown = pageNumbers.filter((p) => !knownPages.has(p));
    if (unknown.length > 0) {
        throw new Error(`Page(s) ${unknown.join(', ')} not found in this file's classified pages`);
    }

    // A page may belong to at most one section — reject pages already owned
    // (including by superseded sections: their pages are spoken for as
    // provenance of the canonical twin). Use merge to combine sections.
    const owned = new Set();
    for (const s of blob.sections) {
        for (const p of getMemberPages(s)) owned.add(p);
    }
    const taken = pageNumbers.filter((p) => owned.has(p));
    if (taken.length > 0) {
        throw new Error(
            `Page(s) ${taken.join(', ')} already belong to a section — ` +
            `merge sections instead of attaching`
        );
    }

    const attachSet = new Set(pageNumbers);
    for (const p of allPages) {
        if (typeof p?.page_number !== 'number' || !attachSet.has(p.page_number)) continue;
        // Keep the routing panel's per-page picture consistent with the
        // section the page now belongs to.
        p.document_type_slug = section.document_type_slug;
        if (markAsData) {
            p.page_purpose_override = EXTRACTABLE_PURPOSE;
        }
    }

    const rebuilt = buildSectionFromPages(
        allPages,
        [...getMemberPages(section), ...pageNumbers],
        section
    );
    blob.sections.splice(index, 1, rebuilt);
    blob.status = deriveFileStatus(blob.sections);
    appendEdit(blob, {
        kind: 'attach_pages',
        section_index: index,
        page_numbers: [...pageNumbers].sort((a, b) => a - b),
        mark_as_data: markAsData !== false,
    });

    return blob;
}

export default {
    applyApproveSection,
    applyChangeSectionSlug,
    applySplitSection,
    applyMergeSections,
    applyAttachPages,
    getMemberPages,
};
