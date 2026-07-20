import { describe, it, expect } from 'vitest';
import {
    applyApproveSection,
    applyChangeSectionSlug,
    applySplitSection,
    applyMergeSections,
    applyAttachPages,
    getMemberPages,
} from '../sectionRoutingEdits.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type PageOpts = {
    purpose?: string;
    confidence?: number;
    role?: string | null;
    duplicate_of?: number | null;
};

function page(
    n: number,
    slug: string,
    { purpose = 'data', confidence = 0.9, role = null, duplicate_of = null }: PageOpts = {}
) {
    return {
        page_number: n,
        document_type_slug: slug,
        page_purpose: purpose,
        page_role: role,
        confidence,
        duplicate_of,
    };
}

// Loosely typed on purpose: sections are plain JSON blobs and the tests
// poke at optional fields (member_pages, superseded_by) freely.
function section(overrides: Record<string, unknown> = {}): any {
    return {
        document_type_slug: 'borehole_log',
        page_range: [1, 2],
        page_count: 2,
        extraction_pages: [1, 2],
        skipped_pages: [],
        page_roles: [null, null],
        page_purposes: ['data', 'data'],
        confidence: 0.9,
        min_page_confidence: 0.9,
        status: 'auto_approved',
        threshold_used: 0.75,
        section_result_id: 'sr-existing',
        ...overrides,
    };
}

/**
 * A 7-page file: borehole_log on pp 1–2, aquifer_test on pp 4–6,
 * a free 'none' page 3 and a free appendix figure page 7.
 */
function makeBlob() {
    return {
        status: 'auto_approved',
        pages: [
            page(1, 'borehole_log'),
            page(2, 'borehole_log'),
            page(3, 'none', { purpose: 'blank' }),
            page(4, 'aquifer_test'),
            page(5, 'aquifer_test'),
            page(6, 'aquifer_test'),
            page(7, 'none', { purpose: 'figure', confidence: 0.5 }),
        ],
        sections: [
            section({
                document_type_slug: 'borehole_log',
                member_pages: [1, 2],
                page_range: [1, 2],
                extraction_pages: [1, 2],
            }),
            section({
                document_type_slug: 'aquifer_test',
                member_pages: [4, 5, 6],
                page_range: [4, 6],
                page_count: 3,
                extraction_pages: [4, 5, 6],
                page_roles: [null, null, null],
                page_purposes: ['data', 'data', 'data'],
                section_result_id: 'sr-aquifer',
            }),
        ],
    };
}

/** Same file but sections lack member_pages (pre-v4 legacy blob). */
function makeLegacyBlob() {
    const blob = makeBlob();
    for (const s of blob.sections) delete s.member_pages;
    return blob;
}

// ---------------------------------------------------------------------------
// getMemberPages
// ---------------------------------------------------------------------------

describe('getMemberPages', () => {
    it('returns member_pages sorted when present', () => {
        expect(getMemberPages({ member_pages: [7, 2, 3], page_range: [2, 7] })).toEqual([2, 3, 7]);
    });

    it('falls back to expanding page_range for legacy sections', () => {
        expect(getMemberPages({ page_range: [4, 6] })).toEqual([4, 5, 6]);
    });

    it('returns [] for malformed sections', () => {
        expect(getMemberPages({})).toEqual([]);
        expect(getMemberPages(null)).toEqual([]);
        expect(getMemberPages({ page_range: [6, 4] })).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// merge — adjacency no longer required
// ---------------------------------------------------------------------------

describe('applyMergeSections', () => {
    it('still merges adjacent sections (parity with old behavior)', () => {
        const blob = makeBlob();
        // Make them adjacent: borehole_log pp 1–2, aquifer_test pp 3–… — use
        // a dedicated fixture where section B starts right after A.
        blob.sections[1] = section({
            document_type_slug: 'aquifer_test',
            member_pages: [3, 4, 5, 6],
            page_range: [3, 6],
            page_count: 4,
            extraction_pages: [4, 5, 6],
        });
        const out = applyMergeSections(blob, { indexA: 0, indexB: 1 });
        expect(out.sections).toHaveLength(1);
        expect(out.sections[0].member_pages).toEqual([1, 2, 3, 4, 5, 6]);
        expect(out.sections[0].page_range).toEqual([1, 6]);
        expect(out.sections[0].document_type_slug).toBe('borehole_log');
        expect(out.sections[0].status).toBe('approved');
        expect(out.sections[0].section_result_id).toBeNull();
    });

    it('merges NON-adjacent sections without swallowing the pages in between', () => {
        const blob = makeBlob();
        // Give page 7 its own single-page section (the appendix figure).
        blob.sections.push(section({
            document_type_slug: 'borehole_log',
            member_pages: [7],
            page_range: [7, 7],
            page_count: 1,
            extraction_pages: [],
            skipped_pages: [{ page_number: 7, reason: 'figure' }],
            page_roles: [null],
            page_purposes: ['figure'],
            section_result_id: null,
        }));

        const out = applyMergeSections(blob, { indexA: 0, indexB: 2 });

        expect(out.sections).toHaveLength(2);
        const merged = out.sections[0];
        expect(merged.member_pages).toEqual([1, 2, 7]);
        expect(merged.page_range).toEqual([1, 7]); // display span
        expect(merged.page_count).toBe(3); // member count, not span width
        // Gap pages 4–6 stay with the aquifer_test section, untouched.
        expect(out.sections[1].member_pages).toEqual([4, 5, 6]);
        expect(out.sections[1].section_result_id).toBe('sr-aquifer');
        // Page 7 is purpose 'figure' → skipped, not extracted (merge does
        // not override purpose; attach does).
        expect(merged.extraction_pages).toEqual([1, 2]);
        expect(merged.skipped_pages).toEqual([{ page_number: 7, reason: 'figure' }]);
    });

    it('records an audit entry with the merged member pages', () => {
        const blob = makeBlob();
        blob.sections.push(section({
            document_type_slug: 'borehole_log',
            member_pages: [7],
            page_range: [7, 7],
        }));
        const out = applyMergeSections(blob, { indexA: 0, indexB: 2 });
        const edit = out.edits.at(-1);
        expect(edit.kind).toBe('merge');
        expect(edit.merged_member_pages).toEqual([1, 2, 7]);
    });

    it('works when indexB is before indexA (anchor keeps its slug)', () => {
        const blob = makeBlob();
        const out = applyMergeSections(blob, { indexA: 1, indexB: 0 });
        expect(out.sections).toHaveLength(1);
        expect(out.sections[0].document_type_slug).toBe('aquifer_test');
        expect(out.sections[0].member_pages).toEqual([1, 2, 4, 5, 6]);
    });

    it('merges legacy sections (no member_pages) via range fallback', () => {
        const blob = makeLegacyBlob();
        const out = applyMergeSections(blob, { indexA: 0, indexB: 1 });
        expect(out.sections[0].member_pages).toEqual([1, 2, 4, 5, 6]);
        // Page 3 ('none' blank page between them) is NOT swallowed.
        expect(out.sections[0].extraction_pages).toEqual([1, 2, 4, 5, 6]);
    });

    it('rejects self-merge, overlapping membership, and superseded sections', () => {
        const blob = makeBlob();
        expect(() => applyMergeSections(blob, { indexA: 1, indexB: 1 }))
            .toThrow(/itself/);

        const corrupt = makeBlob();
        corrupt.sections[1].member_pages = [2, 4, 5, 6]; // page 2 claimed twice
        expect(() => applyMergeSections(corrupt, { indexA: 0, indexB: 1 }))
            .toThrow(/claim page\(s\) 2/);

        const superseded = makeBlob();
        superseded.sections[1].superseded_by = 'sr-other';
        expect(() => applyMergeSections(superseded, { indexA: 0, indexB: 1 }))
            .toThrow(/superseded/);
    });
});

// ---------------------------------------------------------------------------
// attach — free pages into a section
// ---------------------------------------------------------------------------

describe('applyAttachPages', () => {
    it('attaches a free appendix page and makes it extractable by default', () => {
        const blob = makeBlob();
        const out = applyAttachPages(blob, { index: 0, pageNumbers: [7] });

        const s = out.sections[0];
        expect(s.member_pages).toEqual([1, 2, 7]);
        expect(s.page_range).toEqual([1, 7]);
        expect(s.page_count).toBe(3);
        // page_purpose_override: 'data' puts the figure page into extraction.
        expect(s.extraction_pages).toEqual([1, 2, 7]);
        expect(s.status).toBe('approved');
        expect(s.section_result_id).toBeNull();

        // Per-page picture is rewritten for the attached page only.
        const p7 = out.pages.find((p: any) => p.page_number === 7);
        expect(p7.document_type_slug).toBe('borehole_log');
        expect(p7.page_purpose_override).toBe('data');
        expect(p7.page_purpose).toBe('figure'); // classifier verdict preserved

        const edit = out.edits.at(-1);
        expect(edit.kind).toBe('attach_pages');
        expect(edit.page_numbers).toEqual([7]);
    });

    it('markAsData: false attaches without forcing extraction', () => {
        const blob = makeBlob();
        const out = applyAttachPages(blob, { index: 0, pageNumbers: [7], markAsData: false });
        const s = out.sections[0];
        expect(s.member_pages).toEqual([1, 2, 7]);
        expect(s.extraction_pages).toEqual([1, 2]);
        expect(s.skipped_pages).toEqual([{ page_number: 7, reason: 'figure' }]);
        expect(out.pages.find((p: any) => p.page_number === 7).page_purpose_override).toBeUndefined();
    });

    it('rejects pages already owned by a section (range interleave-safe)', () => {
        const blob = makeBlob();
        expect(() => applyAttachPages(blob, { index: 0, pageNumbers: [5] }))
            .toThrow(/already belong/);
        // Ownership check must also see legacy (range-only) sections.
        const legacy = makeLegacyBlob();
        expect(() => applyAttachPages(legacy, { index: 0, pageNumbers: [5] }))
            .toThrow(/already belong/);
    });

    it('rejects unknown pages and bad input', () => {
        const blob = makeBlob();
        expect(() => applyAttachPages(blob, { index: 0, pageNumbers: [99] }))
            .toThrow(/not found/);
        expect(() => applyAttachPages(blob, { index: 0, pageNumbers: [] }))
            .toThrow(/non-empty/);
        expect(() => applyAttachPages(blob, { index: 0, pageNumbers: [0] }))
            .toThrow(/non-empty|positive/);
    });
});

// ---------------------------------------------------------------------------
// split — member-list semantics
// ---------------------------------------------------------------------------

describe('applySplitSection', () => {
    it('splits a contiguous section at a boundary (parity with old behavior)', () => {
        const blob = makeBlob();
        const out = applySplitSection(blob, { index: 1, atPage: 5 });
        expect(out.sections).toHaveLength(3);
        expect(out.sections[1].member_pages).toEqual([4]);
        expect(out.sections[2].member_pages).toEqual([5, 6]);
        expect(out.sections[1].page_range).toEqual([4, 4]);
        expect(out.sections[2].page_range).toEqual([5, 6]);
        for (const s of [out.sections[1], out.sections[2]]) {
            expect(s.status).toBe('approved');
            expect(s.section_result_id).toBeNull();
        }
    });

    it('peels the appendix page off a non-contiguous section', () => {
        const blob = makeBlob();
        blob.sections[0] = section({
            document_type_slug: 'borehole_log',
            member_pages: [1, 2, 7],
            page_range: [1, 7],
            page_count: 3,
            extraction_pages: [1, 2, 7],
        });
        const out = applySplitSection(blob, { index: 0, atPage: 7 });
        expect(out.sections[0].member_pages).toEqual([1, 2]);
        expect(out.sections[1].member_pages).toEqual([7]);
        // The gap pages 4–6 belong to aquifer_test and are untouched.
        expect(out.sections[2].member_pages).toEqual([4, 5, 6]);
    });

    it('rejects a split that leaves an empty half', () => {
        const blob = makeBlob();
        expect(() => applySplitSection(blob, { index: 0, atPage: 1 })).toThrow(/non-empty/);
        expect(() => applySplitSection(blob, { index: 0, atPage: 3 })).toThrow(/non-empty/);
    });
});

// ---------------------------------------------------------------------------
// changeSlug — membership-aware page rewrite
// ---------------------------------------------------------------------------

describe('applyChangeSectionSlug', () => {
    it('only rewrites slugs of MEMBER pages of a non-contiguous section', () => {
        const blob = makeBlob();
        blob.sections[0] = section({
            document_type_slug: 'borehole_log',
            member_pages: [1, 2, 7],
            page_range: [1, 7], // span covers 4–6 which belong to aquifer_test
            page_count: 3,
            extraction_pages: [1, 2, 7],
        });

        const out = applyChangeSectionSlug(blob, { index: 0, slug: 'well_record', threshold: 0.8 });

        const slugsByPage = Object.fromEntries(
            out.pages.map((p: any) => [p.page_number, p.document_type_slug])
        );
        expect(slugsByPage[1]).toBe('well_record');
        expect(slugsByPage[2]).toBe('well_record');
        expect(slugsByPage[7]).toBe('well_record');
        // Gap pages untouched — the old range loop would have clobbered these.
        expect(slugsByPage[4]).toBe('aquifer_test');
        expect(slugsByPage[5]).toBe('aquifer_test');
        expect(slugsByPage[6]).toBe('aquifer_test');
        expect(out.sections[0].section_result_id).toBeNull();
    });

    it('legacy section (no member_pages) keeps old range behavior', () => {
        const blob = makeLegacyBlob();
        const out = applyChangeSectionSlug(blob, { index: 1, slug: 'well_record', threshold: 0.75 });
        const slugsByPage = Object.fromEntries(
            out.pages.map((p: any) => [p.page_number, p.document_type_slug])
        );
        expect(slugsByPage[4]).toBe('well_record');
        expect(slugsByPage[5]).toBe('well_record');
        expect(slugsByPage[6]).toBe('well_record');
        expect(slugsByPage[1]).toBe('borehole_log');
    });
});

// ---------------------------------------------------------------------------
// approve — untouched by this change, quick regression check
// ---------------------------------------------------------------------------

describe('applyApproveSection', () => {
    it('flips pending_review to approved and recomputes file status', () => {
        const blob = makeBlob();
        blob.sections[0].status = 'pending_review';
        blob.status = 'pending_review';
        const out = applyApproveSection(blob, { index: 0 });
        expect(out.sections[0].status).toBe('approved');
        expect(out.status).toBe('auto_approved');
    });
});
