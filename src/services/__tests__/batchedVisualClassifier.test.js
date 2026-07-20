import { describe, it, expect } from 'vitest';
import { deriveSectionsFromClassification, normalizeRecordId } from '../batchedVisualClassifier.js';

describe('deriveSectionsFromClassification', () => {
    it('groups consecutive same-slug same-record_id pages into one section', () => {
        const pages = [
            { page_number: 2, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'MW-1', confidence: 0.9, summary: 'Page 2' },
            { page_number: 3, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: false, record_id: 'MW-1', confidence: 0.9, summary: 'Page 3' },
        ];
        const sections = deriveSectionsFromClassification(pages);
        expect(sections).toHaveLength(1);
        expect(sections[0].record_id).toBe('MW-1');
        expect(sections[0].extraction_pages).toEqual([2, 3]);
        expect(sections[0].page_range).toEqual([2, 3]);
    });

    it('splits sections when record_id changes within same slug', () => {
        const pages = [
            { page_number: 2, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'MW-1', confidence: 0.9, summary: '' },
            { page_number: 3, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: false, record_id: 'MW-1', confidence: 0.9, summary: '' },
            { page_number: 4, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'IW-1', confidence: 0.9, summary: '' },
            { page_number: 5, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'IW-2', confidence: 0.9, summary: '' },
        ];
        const sections = deriveSectionsFromClassification(pages);
        expect(sections).toHaveLength(3);
        expect(sections[0].record_id).toBe('MW-1');
        expect(sections[0].extraction_pages).toEqual([2, 3]);
        expect(sections[1].record_id).toBe('IW-1');
        expect(sections[1].extraction_pages).toEqual([4]);
        expect(sections[2].record_id).toBe('IW-2');
        expect(sections[2].extraction_pages).toEqual([5]);
    });

    it('does NOT split when is_new_record=true but record_id matches current section', () => {
        // This handles the batch-boundary noise case: model says "new" but the
        // record_id is actually the same (e.g., page 13 says is_new_record=true
        // for EW-2 when page 12 was already EW-2 analytical_results).
        const pages = [
            { page_number: 12, document_type_slug: 'analytical_results', page_purpose: 'data', is_new_record: true, record_id: 'EW-2', confidence: 0.9, summary: '' },
            { page_number: 13, document_type_slug: 'analytical_results', page_purpose: 'data', is_new_record: true, record_id: 'EW-2', confidence: 0.9, summary: '' },
        ];
        const sections = deriveSectionsFromClassification(pages);
        expect(sections).toHaveLength(1);
        expect(sections[0].record_id).toBe('EW-2');
        expect(sections[0].extraction_pages).toEqual([12, 13]);
    });

    it('splits on slug change even if record_id is the same', () => {
        const pages = [
            { page_number: 7, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'EW-1', confidence: 0.9, summary: '' },
            { page_number: 10, document_type_slug: 'analytical_results', page_purpose: 'data', is_new_record: true, record_id: 'EW-1', confidence: 0.9, summary: '' },
        ];
        const sections = deriveSectionsFromClassification(pages);
        expect(sections).toHaveLength(2);
        expect(sections[0].document_type_slug).toBe('borehole_log');
        expect(sections[1].document_type_slug).toBe('analytical_results');
    });

    it('skips leading "none" pages (before first section)', () => {
        const pages = [
            { page_number: 1, document_type_slug: 'none', page_purpose: 'cover', is_new_record: true, record_id: null, confidence: 0.9, summary: '' },
            { page_number: 2, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'MW-1', confidence: 0.9, summary: '' },
        ];
        const sections = deriveSectionsFromClassification(pages);
        expect(sections).toHaveLength(1);
        expect(sections[0].record_id).toBe('MW-1');
    });

    it('absorbs mid-section "none" gap pages without splitting', () => {
        // Pages 2,3 are MW-1 data, page 4 is "none" (blank), page 5 is MW-1 data again.
        // The gap should NOT split into two sections — it should produce one section
        // with page 4 in skipped_pages.
        const pages = [
            { page_number: 2, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'MW-1', confidence: 0.95, summary: '' },
            { page_number: 3, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: false, record_id: 'MW-1', confidence: 0.95, summary: '' },
            { page_number: 4, document_type_slug: 'none', page_purpose: 'blank', is_new_record: false, record_id: null, confidence: 0.9, summary: '' },
            { page_number: 5, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: false, record_id: 'MW-1', confidence: 0.95, summary: '' },
        ];
        const sections = deriveSectionsFromClassification(pages);
        expect(sections).toHaveLength(1);
        expect(sections[0].record_id).toBe('MW-1');
        expect(sections[0].extraction_pages).toEqual([2, 3, 5]);
        expect(sections[0].skipped_pages).toEqual([
            { page_number: 4, reason: 'gap_absorbed' },
        ]);
        expect(sections[0].page_range).toEqual([2, 5]);
        // Explicit membership includes the absorbed gap page.
        expect(sections[0].member_pages).toEqual([2, 3, 4, 5]);
    });

    it('emits member_pages on every section', () => {
        const pages = [
            { page_number: 2, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'MW-1', confidence: 0.9, summary: '' },
            { page_number: 3, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: false, record_id: 'MW-1', confidence: 0.9, summary: '' },
            { page_number: 4, document_type_slug: 'aquifer_test', page_purpose: 'data', is_new_record: true, record_id: 'MW-1', confidence: 0.9, summary: '' },
        ];
        const sections = deriveSectionsFromClassification(pages);
        expect(sections.map((s) => s.member_pages)).toEqual([[2, 3], [4]]);
        expect(sections.map((s) => s.page_count)).toEqual([2, 1]);
    });

    it('"none" pages between DIFFERENT sections still split correctly', () => {
        // Pages 2,3 are MW-1, page 4 is "none", page 5 is IW-1 (different record)
        // The gap is a real boundary — should produce two sections.
        const pages = [
            { page_number: 2, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'MW-1', confidence: 0.95, summary: '' },
            { page_number: 3, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: false, record_id: 'MW-1', confidence: 0.95, summary: '' },
            { page_number: 4, document_type_slug: 'none', page_purpose: 'blank', is_new_record: false, record_id: null, confidence: 0.9, summary: '' },
            { page_number: 5, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'IW-1', confidence: 0.95, summary: '' },
        ];
        const sections = deriveSectionsFromClassification(pages);
        expect(sections).toHaveLength(2);
        expect(sections[0].record_id).toBe('MW-1');
        expect(sections[0].extraction_pages).toEqual([2, 3]);
        expect(sections[1].record_id).toBe('IW-1');
        expect(sections[1].extraction_pages).toEqual([5]);
    });

    it('handles the full 13-page test file correctly', () => {
        // Simulates the ground-truth result from the prototype
        const pages = [
            { page_number: 1, document_type_slug: 'none', page_purpose: 'cover', is_new_record: true, record_id: null, confidence: 0.9, summary: '' },
            { page_number: 2, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'MW-1', confidence: 0.95, summary: '' },
            { page_number: 3, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: false, record_id: 'MW-1', confidence: 0.95, summary: '' },
            { page_number: 4, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'IW-1', confidence: 0.95, summary: '' },
            { page_number: 5, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'IW-2', confidence: 0.95, summary: '' },
            { page_number: 6, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'IW-3', confidence: 0.9, summary: '' },
            { page_number: 7, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'EW-1', confidence: 0.9, summary: '' },
            { page_number: 8, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'EW-2', confidence: 0.9, summary: '' },
            { page_number: 9, document_type_slug: 'analytical_results', page_purpose: 'data', is_new_record: true, record_id: 'MW-1', confidence: 0.85, summary: '' },
            { page_number: 10, document_type_slug: 'analytical_results', page_purpose: 'data', is_new_record: false, record_id: 'EW-1', confidence: 0.85, summary: '' },
            { page_number: 11, document_type_slug: 'analytical_results', page_purpose: 'data', is_new_record: false, record_id: 'EW-1', confidence: 0.95, summary: '' },
            { page_number: 12, document_type_slug: 'analytical_results', page_purpose: 'data', is_new_record: true, record_id: 'EW-2', confidence: 0.95, summary: '' },
            { page_number: 13, document_type_slug: 'analytical_results', page_purpose: 'data', is_new_record: false, record_id: 'EW-2', confidence: 0.95, summary: '' },
        ];

        const sections = deriveSectionsFromClassification(pages);

        // Should produce 9 sections (6 borehole + 3 analytical)
        expect(sections).toHaveLength(9);

        // Borehole logs
        expect(sections[0]).toMatchObject({ document_type_slug: 'borehole_log', record_id: 'MW-1', extraction_pages: [2, 3] });
        expect(sections[1]).toMatchObject({ document_type_slug: 'borehole_log', record_id: 'IW-1', extraction_pages: [4] });
        expect(sections[2]).toMatchObject({ document_type_slug: 'borehole_log', record_id: 'IW-2', extraction_pages: [5] });
        expect(sections[3]).toMatchObject({ document_type_slug: 'borehole_log', record_id: 'IW-3', extraction_pages: [6] });
        expect(sections[4]).toMatchObject({ document_type_slug: 'borehole_log', record_id: 'EW-1', extraction_pages: [7] });
        expect(sections[5]).toMatchObject({ document_type_slug: 'borehole_log', record_id: 'EW-2', extraction_pages: [8] });

        // Analytical results
        expect(sections[6]).toMatchObject({ document_type_slug: 'analytical_results', record_id: 'MW-1', extraction_pages: [9] });
        expect(sections[7]).toMatchObject({ document_type_slug: 'analytical_results', record_id: 'EW-1', extraction_pages: [10, 11] });
        expect(sections[8]).toMatchObject({ document_type_slug: 'analytical_results', record_id: 'EW-2', extraction_pages: [12, 13] });
    });

    it('assigns auto_approved status when confidence meets threshold', () => {
        const pages = [
            { page_number: 2, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'MW-1', confidence: 0.9, summary: '' },
        ];
        const thresholdsBySlug = new Map([['borehole_log', 0.75]]);
        const sections = deriveSectionsFromClassification(pages, { thresholdsBySlug });
        expect(sections[0].status).toBe('auto_approved');
    });

    it('assigns pending_review status when confidence is below threshold', () => {
        const pages = [
            { page_number: 2, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: true, record_id: 'MW-1', confidence: 0.5, summary: '' },
        ];
        const thresholdsBySlug = new Map([['borehole_log', 0.75]]);
        const sections = deriveSectionsFromClassification(pages, { thresholdsBySlug });
        expect(sections[0].status).toBe('pending_review');
    });

    it('skips non-data pages from extraction_pages', () => {
        const pages = [
            { page_number: 1, document_type_slug: 'borehole_log', page_purpose: 'cover', is_new_record: true, record_id: 'MW-1', confidence: 0.9, summary: '' },
            { page_number: 2, document_type_slug: 'borehole_log', page_purpose: 'data', is_new_record: false, record_id: 'MW-1', confidence: 0.9, summary: '' },
            { page_number: 3, document_type_slug: 'borehole_log', page_purpose: 'reference', is_new_record: false, record_id: 'MW-1', confidence: 0.9, summary: '' },
        ];
        const sections = deriveSectionsFromClassification(pages);
        expect(sections).toHaveLength(1);
        expect(sections[0].extraction_pages).toEqual([2]);
        expect(sections[0].skipped_pages).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// normalizeRecordId
// ---------------------------------------------------------------------------

describe('normalizeRecordId', () => {
    it('trims whitespace', () => {
        expect(normalizeRecordId('  MW-1  ')).toBe('MW-1');
    });

    it('collapses whitespace around hyphens', () => {
        expect(normalizeRecordId('GP- 1')).toBe('GP-1');
        expect(normalizeRecordId('MW -2')).toBe('MW-2');
        expect(normalizeRecordId('B - 3')).toBe('B-3');
    });

    it('uppercases', () => {
        expect(normalizeRecordId('gp-1')).toBe('GP-1');
        expect(normalizeRecordId('mw-2a')).toBe('MW-2A');
    });

    it('strips trailing punctuation', () => {
        expect(normalizeRecordId('MW-1.')).toBe('MW-1');
        expect(normalizeRecordId('GP-2,')).toBe('GP-2');
    });

    it('handles en-dash and em-dash as hyphens', () => {
        expect(normalizeRecordId('MW–1')).toBe('MW-1');
        expect(normalizeRecordId('GP—2')).toBe('GP-2');
    });

    it('returns null for null/undefined/empty', () => {
        expect(normalizeRecordId(null)).toBeNull();
        expect(normalizeRecordId(undefined)).toBeNull();
        expect(normalizeRecordId('')).toBeNull();
        expect(normalizeRecordId('   ')).toBeNull();
    });

    it('preserves multi-part identifiers', () => {
        expect(normalizeRecordId('EW-1A-DEEP')).toBe('EW-1A-DEEP');
        expect(normalizeRecordId('mw - 1a - deep')).toBe('MW-1A-DEEP');
    });
});
