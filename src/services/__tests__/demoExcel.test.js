import { describe, it, expect } from 'vitest';
import { flattenScalars, listDemoRecords, writeDemoWorkbook, humanizeKey } from '../demoExcel.js';

describe('demoExcel', () => {
    it('humanizes keys without inventing values', () => {
        expect(humanizeKey('lithology_intervals')).toBe('Lithology Intervals');
        expect(humanizeKey('spt')).toBe('SPT');
    });

    it('flattens nested scalars and leaves blanks empty', () => {
        const flat = flattenScalars({
            site_identification: {
                boring_well_id: 'B-1',
                latitude_dd: null,
                coordinate_method: 'GPS',
            },
            lithology_intervals: [{ depth_from_ft: 0 }],
            extraction_metadata: { extraction_confidence: 0.9 },
        });
        expect(flat['Site Identification / Boring Well ID']).toBe('B-1');
        expect(flat['Site Identification / Latitude Dd']).toBe('');
        expect(flat['Site Identification / Coordinate Method']).toBe('GPS');
        expect(Object.keys(flat).some((k) => k.toLowerCase().includes('lithology'))).toBe(false);
        expect(Object.keys(flat).some((k) => k.toLowerCase().includes('extraction'))).toBe(false);
    });

    it('lists V2 envelope records', () => {
        const records = listDemoRecords({
            borehole_log: [{ section_result_id: 'a', site_identification: { boring_well_id: 'B-1' } }],
        });
        expect(records).toHaveLength(1);
        expect(records[0].slug).toBe('borehole_log');
    });

    it('writes a workbook buffer with a lithology sheet', async () => {
        const buf = await writeDemoWorkbook({
            borehole_log: [{
                section_result_id: 'a',
                site_identification: { boring_well_id: 'B-1', coordinate_method: null },
                lithology_intervals: [
                    { depth_from_ft: 0, depth_to_ft: 4, primary_material: 'sand' },
                ],
            }],
        }, { filename: 'log.pdf' });
        expect(Buffer.isBuffer(buf)).toBe(true);
        expect(buf.length).toBeGreaterThan(100);
    });
});
