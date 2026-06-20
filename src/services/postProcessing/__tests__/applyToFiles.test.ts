import { describe, it, expect } from 'vitest';
import { mergeUpdatedRecordsIntoResult } from '../applyToFiles.ts';
import type { RecordObject } from '../types.ts';

describe('mergeUpdatedRecordsIntoResult', () => {
    it('replaces V2 records by section_result_id, leaving others untouched', () => {
        const result = {
            borehole_log: [
                { section_result_id: 'a', x: 1 },
                { section_result_id: 'b', x: 2 },
            ],
            aquifer_test: [{ section_result_id: 'c', y: 9 }],
        };
        const updated = new Map<string, RecordObject>([['a', { section_result_id: 'a', x: 100, geocoded: true }]]);
        const { result: out, updatedCount } = mergeUpdatedRecordsIntoResult(result, updated) as {
            result: typeof result; updatedCount: number;
        };
        expect(updatedCount).toBe(1);
        expect(out.borehole_log[0]).toMatchObject({ x: 100, geocoded: true });
        expect(out.borehole_log[1]).toMatchObject({ x: 2 }); // untouched
        expect(out.aquifer_test[0]).toMatchObject({ y: 9 }); // other slug untouched
    });

    it('does not mutate the input envelope', () => {
        const result = { borehole_log: [{ section_result_id: 'a', x: 1 }] };
        const updated = new Map<string, RecordObject>([['a', { section_result_id: 'a', x: 2 }]]);
        mergeUpdatedRecordsIntoResult(result, updated);
        expect(result.borehole_log[0].x).toBe(1);
    });

    it('replaces a V1 single-record result via updatedV1', () => {
        const result = { permit_number: '17378', county: 'Allegan', formations: [{ d: 1 }] }; // V1 flat record
        const updatedV1: RecordObject = { permit_number: '17378', county: 'Allegan', formations: [{ d: 1 }], mgs_county: 'Allegan' };
        const { result: out, updatedCount } = mergeUpdatedRecordsIntoResult(result, new Map(), updatedV1) as {
            result: RecordObject; updatedCount: number;
        };
        expect(updatedCount).toBe(1);
        expect(out.mgs_county).toBe('Allegan');
    });

    it('no-ops when nothing matches', () => {
        const result = { borehole_log: [{ section_result_id: 'a', x: 1 }] };
        const { updatedCount } = mergeUpdatedRecordsIntoResult(result, new Map());
        expect(updatedCount).toBe(0);
    });
});
