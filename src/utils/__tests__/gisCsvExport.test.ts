import { describe, it, expect } from 'vitest';
import {
    buildIdentityColumns,
    buildColumnsFromSchema,
    augmentColumnsFromData,
    csvRowLine,
} from '../gisCsvExport.js';

describe('buildIdentityColumns', () => {
    it('leads with a unique join key (well_id = section_result_id), label, and source', () => {
        const cols = buildIdentityColumns();
        expect(cols.map((c) => c.header)).toEqual(['well_id', 'well_label', 'src_file', 'file_id']);
        // well_id reads the globally-unique section_result_id, NOT the local label.
        expect(cols[0].path).toEqual(['section_result_id']);
        expect(cols[1].path).toEqual(['site_identification', 'boring_well_id']);
    });

    it('well_id resolves to section_result_id and well_label to boring_well_id', () => {
        const cols = buildIdentityColumns();
        const rec = {
            section_result_id: 'uuid-1',
            site_identification: { boring_well_id: 'MW-1' },
            _src_file: 'doc.pdf',
            _file_id: 'file-9',
        };
        expect(csvRowLine(rec, cols)).toBe('uuid-1,MW-1,doc.pdf,file-9');
    });
});

describe('column builders no longer treat boring_well_id as the key', () => {
    it('renames boring_well_id to well_label (not well_id) and never emits section_result_id', () => {
        const records = [
            { section_result_id: 's1', site_identification: { boring_well_id: 'MW-1' }, county: 'Ottawa' },
        ];
        const cols = augmentColumnsFromData(buildColumnsFromSchema(null), records);
        const headers = cols.map((c) => c.header);
        expect(headers).toContain('well_label');
        expect(headers).not.toContain('well_id'); // join key is added explicitly via identity cols
        expect(headers).not.toContain('section_result_id'); // internal plumbing
    });

    it('does not surface the injected _src_file / _file_id as raw columns', () => {
        const records = [{ section_result_id: 's1', _src_file: 'd.pdf', _file_id: 'f1', county: 'Kent' }];
        const headers = augmentColumnsFromData([], records).map((c) => c.header);
        expect(headers).not.toContain('_src_file');
        expect(headers).not.toContain('_file_id');
        expect(headers).toContain('county');
    });
});
