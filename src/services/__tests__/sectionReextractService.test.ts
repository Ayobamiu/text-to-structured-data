import { describe, it, expect } from 'vitest';
import {
    computePendingSectionIndices,
    computeTextReextractIndices,
    computeTouchedSectionIndices,
    rebuildEnvelopeById,
    indexRecordsById,
    SECTION_REEXTRACT_MODE,
    TEXT_REEXTRACT_FLAG,
} from '../sectionReextractService.ts';

describe('computePendingSectionIndices', () => {
    it('picks sections with null section_result_id that are not superseded', () => {
        const sections = [
            { section_result_id: 'a' },
            { section_result_id: null },
            { section_result_id: null, superseded_by: 'a' },
            {},
            { section_result_id: 'b', superseded_by: 'a' },
        ];
        expect(computePendingSectionIndices(sections)).toEqual([1, 3]);
    });

    it('handles empty / missing input', () => {
        expect(computePendingSectionIndices([])).toEqual([]);
        expect(computePendingSectionIndices(null)).toEqual([]);
        expect(computePendingSectionIndices(undefined)).toEqual([]);
    });
});

describe('computeTextReextractIndices', () => {
    it('picks sections flagged for re-OCR, ignoring superseded ones', () => {
        const sections = [
            { section_result_id: 'a' },
            { section_result_id: 'b', [TEXT_REEXTRACT_FLAG]: true },
            { section_result_id: 'c', [TEXT_REEXTRACT_FLAG]: false },
            { section_result_id: null, [TEXT_REEXTRACT_FLAG]: true },
            { section_result_id: 'e', [TEXT_REEXTRACT_FLAG]: true, superseded_by: 'a' },
        ];
        expect(computeTextReextractIndices(sections)).toEqual([1, 3]);
    });

    it('handles empty / missing input', () => {
        expect(computeTextReextractIndices([])).toEqual([]);
        expect(computeTextReextractIndices(null)).toEqual([]);
        expect(computeTextReextractIndices(undefined)).toEqual([]);
    });
});

describe('computeTouchedSectionIndices', () => {
    it('unions the AI-pending and re-OCR sets in document order', () => {
        const sections = [
            { section_result_id: 'a', [TEXT_REEXTRACT_FLAG]: true }, // OCR only
            { section_result_id: 'b' },                              // nothing
            { section_result_id: null },                             // AI only
            { section_result_id: null, [TEXT_REEXTRACT_FLAG]: true },// both — counted once
        ];
        expect(computeTouchedSectionIndices(sections)).toEqual([0, 2, 3]);
    });

    it('is empty when nothing is marked — the job short-circuits', () => {
        expect(computeTouchedSectionIndices([{ section_result_id: 'a' }])).toEqual([]);
    });

    it('a text-only reprocess still yields work (regression: total would be 0)', () => {
        const sections = [{ section_result_id: 'a', [TEXT_REEXTRACT_FLAG]: true }];
        expect(computePendingSectionIndices(sections)).toEqual([]);
        expect(computeTouchedSectionIndices(sections)).toEqual([0]);
    });
});

describe('indexRecordsById', () => {
    it('indexes v2 envelope records by section_result_id', () => {
        const env = {
            borehole_log: [
                { section_result_id: 'a', depth: 10 },
                { depth: 20 }, // legacy record without id — not indexed
            ],
            aquifer_test: [{ section_result_id: 'b', rate: 3 }],
            not_an_array: 'ignored',
        };
        const byId = indexRecordsById(env);
        expect(byId.size).toBe(2);
        expect(byId.get('a')).toEqual({ slug: 'borehole_log', record: { section_result_id: 'a', depth: 10 } });
        expect(byId.get('b')?.slug).toBe('aquifer_test');
        expect(indexRecordsById(null).size).toBe(0);
    });
});

describe('rebuildEnvelopeById', () => {
    const oldRecs = indexRecordsById({
        borehole_log: [
            { section_result_id: 'old-1', v: 'old1' },
            { section_result_id: 'old-2', v: 'old2' },
        ],
    });

    it('prefers new records, falls back to old, keeps document order', () => {
        const sections = [
            { document_type_slug: 'borehole_log', section_result_id: 'new-1' }, // re-extracted
            { document_type_slug: 'borehole_log', section_result_id: 'old-2' }, // untouched
        ];
        const newRecs = new Map([
            ['new-1', { slug: 'borehole_log', record: { section_result_id: 'new-1', v: 'NEW' } }],
        ]);
        const env = rebuildEnvelopeById(sections, newRecs, oldRecs);
        expect(env.borehole_log.map((r: any) => r.v)).toEqual(['NEW', 'old2']);
    });

    it('drops superseded sections and null-id (still extracting) sections', () => {
        const sections = [
            { document_type_slug: 'borehole_log', section_result_id: 'old-1', superseded_by: 'x' },
            { document_type_slug: 'borehole_log', section_result_id: null },
            { document_type_slug: 'borehole_log', section_result_id: 'old-2' },
        ];
        const env = rebuildEnvelopeById(sections, new Map(), oldRecs);
        expect(env.borehole_log.map((r: any) => r.v)).toEqual(['old2']);
    });

    it('incremental merge: sections fill in one at a time in document order', () => {
        // Simulates the per-completion writes: two pending sections resolve
        // out of order (index 2 finishes before index 0).
        const sections: any[] = [
            { document_type_slug: 'borehole_log', section_result_id: null },
            { document_type_slug: 'borehole_log', section_result_id: 'old-2' },
            { document_type_slug: 'aquifer_test', section_result_id: null },
        ];
        const newRecs = new Map<string, { slug: string; record: any }>();

        // aquifer section (index 2) completes first
        sections[2].section_result_id = 'new-aq';
        newRecs.set('new-aq', { slug: 'aquifer_test', record: { section_result_id: 'new-aq', rate: 5 } });
        let env = rebuildEnvelopeById(sections, newRecs, oldRecs);
        expect(env.borehole_log.map((r: any) => r.section_result_id)).toEqual(['old-2']);
        expect(env.aquifer_test.map((r: any) => r.section_result_id)).toEqual(['new-aq']);

        // borehole section (index 0) completes second — lands BEFORE old-2
        sections[0].section_result_id = 'new-bh';
        newRecs.set('new-bh', { slug: 'borehole_log', record: { section_result_id: 'new-bh', v: 'NEW' } });
        env = rebuildEnvelopeById(sections, newRecs, oldRecs);
        expect(env.borehole_log.map((r: any) => r.section_result_id)).toEqual(['new-bh', 'old-2']);
    });

    it('emits an empty slug array when every section of a slug is pending', () => {
        const sections = [{ document_type_slug: 'borehole_log', section_result_id: null }];
        const env = rebuildEnvelopeById(sections, new Map(), new Map());
        expect(env.borehole_log).toEqual([]);
    });
});

describe('SECTION_REEXTRACT_MODE', () => {
    it('is a stable queue-mode string distinct from qa:/rex: prefixes', () => {
        expect(SECTION_REEXTRACT_MODE).toBe('sreex');
    });
});
