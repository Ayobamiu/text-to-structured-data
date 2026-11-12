import { describe, it, expect } from 'vitest';
import { assessDemoResult, countFilledFields } from '../demoResultQuality.ts';

// Shape of the real 2026-11-12 DEERE 7A demo result: a 16-ft log strip the
// model could not read. Only placeholders, booleans and one ID came back.
const deere = {
  remarks: null,
  spt_setup: { spt_performed: false, energy_ratio: null },
  spt_intervals: [],
  document_metadata: { client: null, document_type: ['unknown'] },
  well_construction: { well_installed: false, casing_to_ft: null },
  extraction_metadata: {
    flags: ['no_coordinates', 'no_spt_data'],
    scan_quality: 'digital_native',
    extraction_confidence: 0.95,
  },
  lithology_intervals: [],
  site_identification: { boring_well_id: 'RECON', coordinate_source: 'not_present', state: null },
  drilling_and_personnel: { depth_reference: 'unknown', drilling_method_intervals: [] },
  section_result_id: '3b13033a-ae41-4dd0-9aaf-488ab4353891',
};

// Same day, DAILEY 3-A: a header the model could read.
const dailey = {
  remarks: 'REMARKS: ROTARY--LOG RAN FOR EVALUATION PURPOSES.',
  document_metadata: { client: 'GONSETT PETROLEUM COMPANY', log_date: '1958-04-18', firm_name: 'Birdwell' },
  well_construction: { casing_to_ft: 80, casing_from_ft: 0, casing_diameter_in: 8.625 },
  site_identification: { range: '7E', state: 'OK', county: 'Creek', section: '35', township: '19N' },
  drilling_and_personnel: { total_depth_ft: 2700, drilling_method: 'rotary' },
};

describe('assessDemoResult', () => {
  it('flags the unreadable DEERE log as thin', () => {
    expect(countFilledFields(deere)).toBe(1);
    expect(assessDemoResult([{ data: deere }]).quality).toBe('thin');
  });

  it('passes the readable DAILEY log', () => {
    expect(assessDemoResult([{ data: dailey }]).quality).toBe('ok');
  });

  it('treats no records, or only placeholders, as empty', () => {
    expect(assessDemoResult([]).quality).toBe('empty');
    expect(assessDemoResult([{ data: { a: 'unknown', b: null, c: false } }]).quality).toBe('empty');
  });

  it('ignores run metadata', () => {
    expect(countFilledFields({ extraction_metadata: { a: 'x', b: 1 }, section_result_id: 'abc' })).toBe(0);
  });
});
