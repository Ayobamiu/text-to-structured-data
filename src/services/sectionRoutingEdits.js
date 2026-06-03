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

    const [start, end] = section.page_range;
    for (const p of blob.pages || []) {
        if (
            typeof p.page_number === 'number' &&
            p.page_number >= start &&
            p.page_number <= end
        ) {
            p.document_type_slug = slug;
        }
    }

    blob.status = deriveFileStatus(blob.sections);
    appendEdit(blob, { kind: 'change_slug', section_index: index, from: oldSlug, to: slug });
    return blob;
}

/**
 * Split a section into two at `atPage`. The first half covers
 * [section.start, atPage - 1], the second [atPage, section.end].
 *
 * Both halves inherit the original slug + threshold_used and are marked
 * `'approved'` (the act of splitting is itself a human routing decision).
 *
 * Throws if `atPage` is out of range, or equals the section's first page
 * (which would produce an empty first half).
 */
export function applySplitSection(detectedSections, { index, atPage }) {
    if (!Number.isInteger(atPage) || atPage < 1) {
        throw new Error(`Invalid atPage '${atPage}' — must be a positive integer`);
    }

    const blob = cloneBlob(detectedSections);
    const section = requireSection(blob, index);
    const [start, end] = section.page_range;

    if (atPage <= start || atPage > end) {
        throw new Error(
            `atPage ${atPage} is outside section range (${start}–${end}); ` +
            `must be greater than ${start} and ≤ ${end}`
        );
    }

    const allPages = Array.isArray(blob.pages) ? blob.pages : [];
    const first = buildSectionFromPages(allPages, [start, atPage - 1], section);
    const second = buildSectionFromPages(allPages, [atPage, end], section);

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
 * Rebuild a section's derived fields from the per-page slice in
 * blob.pages that falls within [start, end]. Mirrors the logic in
 * sectionGrouper.flush() so split halves look indistinguishable from
 * sections produced by the original grouper run.
 */
function buildSectionFromPages(allPages, [start, end], proto) {
    const inRange = allPages.filter(
        (p) =>
            typeof p?.page_number === 'number' &&
            p.page_number >= start &&
            p.page_number <= end
    );

    const extraction_pages = [];
    const skipped_pages = [];
    const page_roles = [];
    const page_purposes = [];
    const confidences = [];

    for (const p of inRange) {
        const purpose = p.page_purpose ?? 'unknown';
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
        page_range: [start, end],
        page_count: end - start + 1,
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
 * Merge two adjacent sections into one. The resulting section inherits
 * the first section's slug and threshold_used (the operator chose which
 * section to expand, so the first section is the "anchor").
 *
 * Both sections must be adjacent — the first section's last page + 1 must
 * equal the second section's first page. Throws otherwise.
 *
 * The merged section is marked `'approved'` (merging is a deliberate
 * human routing decision).
 *
 * @param {Object} detectedSections  The full detected_sections blob.
 * @param {Object} args
 * @param {number} args.indexA       Index of the first section.
 * @param {number} args.indexB       Index of the second section.
 *                                   Must equal indexA + 1 (adjacent).
 * @param {string} [args.slug]      Optional slug override for the merged
 *                                   section. Defaults to sectionA's slug.
 */
export function applyMergeSections(detectedSections, { indexA, indexB, slug }) {
    if (!Number.isInteger(indexA) || !Number.isInteger(indexB)) {
        throw new Error('indexA and indexB must be integers');
    }
    if (indexB !== indexA + 1) {
        throw new Error(
            `Can only merge adjacent sections (indexB must be indexA + 1). ` +
            `Got indexA=${indexA}, indexB=${indexB}`
        );
    }

    const blob = cloneBlob(detectedSections);
    const secA = requireSection(blob, indexA);
    const secB = requireSection(blob, indexB);

    // Verify adjacency by page range
    if (secA.page_range[1] + 1 !== secB.page_range[0]) {
        throw new Error(
            `Sections are not page-adjacent: section ${indexA} ends at page ${secA.page_range[1]}, ` +
            `section ${indexB} starts at page ${secB.page_range[0]}. ` +
            `Expected a gap of exactly 1.`
        );
    }

    const allPages = Array.isArray(blob.pages) ? blob.pages : [];
    const mergedRange = [secA.page_range[0], secB.page_range[1]];

    // Use the resolved slug (override or inherit from first section)
    const proto = {
        ...secA,
        document_type_slug: slug || secA.document_type_slug,
    };

    const merged = buildSectionFromPages(allPages, mergedRange, proto);

    // Replace both sections with the merged one
    blob.sections.splice(indexA, 2, merged);
    blob.status = deriveFileStatus(blob.sections);
    appendEdit(blob, {
        kind: 'merge',
        section_index_a: indexA,
        section_index_b: indexB,
        merged_slug: merged.document_type_slug,
        merged_page_range: mergedRange,
    });

    return blob;
}

export default {
    applyApproveSection,
    applyChangeSectionSlug,
    applySplitSection,
    applyMergeSections,
};
