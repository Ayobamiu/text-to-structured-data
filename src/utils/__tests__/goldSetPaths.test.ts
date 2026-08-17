import { describe, it, expect } from 'vitest';
import {
    joinFieldPath,
    aggregateFieldPath,
    splitFieldPath,
    getAtFieldPath,
    seededLeavesUnder,
    serializeExtractedValue,
} from '../goldSetPaths.mjs';

/**
 * These cases are the contract between the seeder, the review panel's tree
 * nodes and the scorer. The web repo's TypeScript twin is pinned to the same
 * table — if one side changes, both tests fail, which is the point.
 */
const CASES: Array<{ keys: Array<string | number>; path: string }> = [
    { keys: ['document_metadata', 'log_date'], path: 'document_metadata.log_date' },
    { keys: ['well_construction', 'screen_to_ft'], path: 'well_construction.screen_to_ft' },
    { keys: ['lithology_intervals', 0, 'depth_from_ft'], path: 'lithology_intervals[0].depth_from_ft' },
    { keys: ['lithology_intervals', 12], path: 'lithology_intervals[12]' },
    { keys: ['site_identification'], path: 'site_identification' },
];

describe('joinFieldPath', () => {
    it.each(CASES)('builds $path', ({ keys, path }) => {
        expect(joinFieldPath(keys)).toBe(path);
    });

    it('treats numeric string keys as indices, matching react-json-view', () => {
        expect(joinFieldPath(['spt_intervals', '3', 'n_value'])).toBe('spt_intervals[3].n_value');
    });

    it('returns an empty path for the root', () => {
        expect(joinFieldPath([])).toBe('');
    });
});

describe('splitFieldPath', () => {
    it.each(CASES)('round-trips $path', ({ path }) => {
        expect(joinFieldPath(splitFieldPath(path))).toBe(path);
    });

    it('gives indices back as numbers', () => {
        expect(splitFieldPath('lithology_intervals[0].depth_from_ft')).toEqual([
            'lithology_intervals', 0, 'depth_from_ft',
        ]);
    });
});

describe('aggregateFieldPath', () => {
    it('collapses row indices so a table scores as one field', () => {
        expect(aggregateFieldPath('lithology_intervals[3].depth_to_ft'))
            .toBe('lithology_intervals[].depth_to_ft');
        expect(aggregateFieldPath('a[0].b[11].c')).toBe('a[].b[].c');
    });

    it('leaves scalar paths alone', () => {
        expect(aggregateFieldPath('document_metadata.log_date')).toBe('document_metadata.log_date');
    });
});

describe('getAtFieldPath', () => {
    const record = {
        document_metadata: { log_date: '1994-06-02', job_number: null },
        lithology_intervals: [
            { depth_from_ft: 0, depth_to_ft: 4.5, description: 'FILL' },
            { depth_from_ft: 4.5, depth_to_ft: 12 },
        ],
    };

    it('reads scalars and row fields', () => {
        expect(getAtFieldPath(record, 'document_metadata.log_date')).toBe('1994-06-02');
        expect(getAtFieldPath(record, 'lithology_intervals[1].depth_to_ft')).toBe(12);
    });

    it('returns undefined rather than throwing on a missing link', () => {
        expect(getAtFieldPath(record, 'well_construction.screen_to_ft')).toBeUndefined();
        expect(getAtFieldPath(record, 'lithology_intervals[9].description')).toBeUndefined();
        expect(getAtFieldPath(null, 'anything.at.all')).toBeUndefined();
    });

    it('reads a whole node, so an object or array can be judged as one', () => {
        expect(getAtFieldPath(record, 'lithology_intervals[0]')).toEqual({
            depth_from_ft: 0, depth_to_ft: 4.5, description: 'FILL',
        });
    });
});

describe('seededLeavesUnder', () => {
    // A realistic seeded section: scalars in nested objects plus a table.
    const seeded = [
        'well_construction.well_installed',
        'well_construction.screen_from_ft',
        'well_construction.screen_to_ft',
        'well_construction_notes',
        'document_metadata.log_date',
        'lithology_intervals[0].depth_from_ft',
        'lithology_intervals[0].depth_to_ft',
        'lithology_intervals[1].depth_from_ft',
        'lithology_intervals_summary',
    ];

    it('expands an object to the seeded leaves beneath it', () => {
        expect(seededLeavesUnder('well_construction', seeded)).toEqual([
            'well_construction.screen_from_ft',
            'well_construction.screen_to_ft',
            'well_construction.well_installed',
        ]);
    });

    it('does not swallow a sibling that merely shares a prefix', () => {
        // The bug this guards: `well_construction` matching
        // `well_construction_notes` would silently judge a field the reviewer
        // never looked at.
        expect(seededLeavesUnder('well_construction', seeded))
            .not.toContain('well_construction_notes');
        expect(seededLeavesUnder('lithology_intervals', seeded))
            .not.toContain('lithology_intervals_summary');
    });

    it('expands an array, and a single row of one', () => {
        expect(seededLeavesUnder('lithology_intervals', seeded)).toHaveLength(3);
        expect(seededLeavesUnder('lithology_intervals[0]', seeded)).toEqual([
            'lithology_intervals[0].depth_from_ft',
            'lithology_intervals[0].depth_to_ft',
        ]);
    });

    it('returns the leaf itself when the path IS a leaf', () => {
        expect(seededLeavesUnder('document_metadata.log_date', seeded))
            .toEqual(['document_metadata.log_date']);
    });

    it('returns nothing for a path the sample never drew', () => {
        expect(seededLeavesUnder('drilling_and_personnel', seeded)).toEqual([]);
    });

    it('treats the root as everything — judging the whole record', () => {
        expect(seededLeavesUnder('', seeded)).toHaveLength(seeded.length);
    });
});

describe('serializeExtractedValue', () => {
    it('stores blank as NULL — null, undefined and whitespace alike', () => {
        expect(serializeExtractedValue(null)).toBeNull();
        expect(serializeExtractedValue(undefined)).toBeNull();
        expect(serializeExtractedValue('')).toBeNull();
        expect(serializeExtractedValue('   ')).toBeNull();
    });

    it('keeps falsy values that are real extractions', () => {
        expect(serializeExtractedValue(0)).toBe('0');
        expect(serializeExtractedValue(false)).toBe('false');
    });

    it('stringifies nodes so a reviewer sees what was extracted', () => {
        expect(serializeExtractedValue({ a: 1 })).toBe('{"a":1}');
        expect(serializeExtractedValue([1, 2])).toBe('[1,2]');
    });
});
