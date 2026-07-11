import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    applyOps,
    checkInvariants,
    findGroupItemSchema,
    correctSamplesDeterministically,
    snapLithologyTops,
    dropEvidenceContradictingMerges,
    type RefinementOp,
} from '../depthRefinementService.ts';
import type { DepthGeometry } from '../depthGeometryService.ts';

// ── fixtures ────────────────────────────────────────────────────────────────
// Lithology rows mirroring the pilot's over-segmented extraction (job/file
// 58432d8e): one row per transcript line, tops rounded or shifted.

const op = (partial: Partial<RefinementOp> & { op: RefinementOp['op'] }): RefinementOp => ({
    row: null,
    rows: null,
    depth_ft: null,
    evidence: 'test evidence',
    item: null,
    ...partial,
});

function lithRows(): Record<string, unknown>[] {
    return [
        { depth_from_ft: 0, depth_to_ft: 5, description_raw: 'Aggregate Base and Clayey Gravel', uscs_symbol: 'GC', eob: false },
        { depth_from_ft: 5, depth_to_ft: 10, description_raw: 'moist to wet, brown, Sandy Fat Clay with scattered', uscs_symbol: 'CH', eob: false },
        { depth_from_ft: 10, depth_to_ft: 25, description_raw: 'fragments', uscs_symbol: 'CH', eob: false },
        { depth_from_ft: 25, depth_to_ft: 40, description_raw: 'dark grayish brown to black Sandy silt', uscs_symbol: 'MH', eob: false },
        { depth_from_ft: 40, depth_to_ft: 45, description_raw: 'gray vesicular Basalt', uscs_symbol: 'RK', eob: false },
        { depth_from_ft: 40, depth_to_ft: 45.5, description_raw: 'gray vesicular Basalt (continued)', uscs_symbol: 'RK', eob: false },
        { depth_from_ft: 45.5, depth_to_ft: 45.5, description_raw: 'Bottom of hole at 45.5 feet.', uscs_symbol: null, eob: true },
    ];
}

function sampleRows(): Record<string, unknown>[] {
    return [
        { sample_id: 'RS-1', depth_ft: 10, sample_type: 'RS' },
        { sample_id: 'SPT-2', depth_ft: 10, sample_type: 'SPT' },
        { sample_id: 'RS-2', depth_ft: 10, sample_type: 'RS' },
        { sample_id: 'SPT-5', depth_ft: 25, sample_type: 'SPT' },
    ];
}

// ── original-index semantics (the user-flagged trap) ────────────────────────

describe('applyOps — original-index semantics', () => {
    it('delete_row 3 + set_depth row 4: the set targets ORIGINAL row 4, not the shifted one', () => {
        // 6 samples; delete original row 3; set_depth on original row 4 —
        // after a sequential/JSON-Patch reading, "row 4" would hit original
        // row 5. Here it must hit the row that was row 4 before the delete.
        const rows = [
            { sample_id: 'A-1', depth_ft: 1, sample_type: null },
            { sample_id: 'A-2', depth_ft: 2, sample_type: null },
            { sample_id: 'A-3', depth_ft: 3, sample_type: null },
            { sample_id: 'A-4', depth_ft: 4, sample_type: null },
            { sample_id: 'A-5', depth_ft: 5, sample_type: null },
            { sample_id: 'A-6', depth_ft: 6, sample_type: null },
        ];
        const { rows: out } = applyOps('samples_collected', rows, [
            op({ op: 'delete_row', row: 3 }),
            op({ op: 'set_depth', row: 4, depth_ft: 4.9 }),
        ]);
        expect(out.map((r) => r.sample_id)).toEqual(['A-1', 'A-2', 'A-3', 'A-5', 'A-6']);
        expect(out.find((r) => r.sample_id === 'A-5')!.depth_ft).toBe(4.9); // original row 4
        expect(out.find((r) => r.sample_id === 'A-6')!.depth_ft).toBe(6);   // untouched
    });

    it('merge_rows [1,2] + set_top row 3 still targets original row 3', () => {
        const { rows: out } = applyOps('lithology_intervals', lithRows(), [
            op({ op: 'merge_rows', rows: [1, 2] }),
            op({ op: 'set_top', row: 3, depth_ft: 26.2 }),
        ]);
        const mh = out.find((r) => r.uscs_symbol === 'MH')!;
        expect(mh.depth_from_ft).toBe(26.2);
        // merged CH row keeps first row's fields, texts joined
        const ch = out.find((r) => r.uscs_symbol === 'CH')!;
        expect(ch.description_raw).toBe('moist to wet, brown, Sandy Fat Clay with scattered fragments');
        expect(out.filter((r) => r.uscs_symbol === 'CH')).toHaveLength(1);
    });
});

// ── the pilot's real correction, end to end through applyOps ────────────────

describe('applyOps — pilot scenario', () => {
    it('splits merged surfacing via add_row + set_top, dedups the page-break layer, recomputes bottoms', () => {
        const { rows: out } = applyOps('lithology_intervals', lithRows(), [
            // surfacing hidden inside row 0 → its own layer; GC top corrected
            op({ op: 'add_row', item: { description_raw: 'Aggregate Base', depth_from_ft: 0, uscs_symbol: null, eob: false } }),
            op({ op: 'set_top', row: 0, depth_ft: 1.3 }),
            op({ op: 'set_top', row: 1, depth_ft: 10.2 }),
            op({ op: 'merge_rows', rows: [1, 2] }),
            op({ op: 'set_top', row: 3, depth_ft: 26.2 }),
            op({ op: 'set_top', row: 4, depth_ft: 38.2 }),
            op({ op: 'delete_row', row: 5 }), // "(continued)" duplicate
        ]);
        expect(out.map((r) => `${r.depth_from_ft}-${r.depth_to_ft}`)).toEqual([
            '0-1.3',       // added surfacing, placed by depth sort, bottom = next top
            '1.3-10.2',    // GC
            '10.2-26.2',   // CH (merged)
            '26.2-38.2',   // MH
            '38.2-45.5',   // RK — bottom = EOB depth
            '45.5-45.5',   // EOB pinned last, from == to
        ]);
        checkInvariants('lithology_intervals', lithRows(), out, []);
    });

    it('add_row is shaped onto the group template (missing fields become null)', () => {
        const { rows: out } = applyOps('lithology_intervals', lithRows(), [
            op({ op: 'add_row', item: { description_raw: 'Aggregate Base', depth_from_ft: 0 } }),
            op({ op: 'set_top', row: 0, depth_ft: 1.3 }), // the layer it was split from
        ]);
        const added = out[0];
        expect(added.description_raw).toBe('Aggregate Base');
        expect(added).toHaveProperty('uscs_symbol', null);
        expect(added.depth_to_ft).toBe(1.3); // recomputed from next top
    });

    it('corrects sample depths and restores a dropped sample', () => {
        const { rows: out } = applyOps('samples_collected', sampleRows(), [
            op({ op: 'set_depth', row: 0, depth_ft: 9.2 }),
            op({ op: 'set_depth', row: 1, depth_ft: 10.8 }),
            op({ op: 'add_row', item: { sample_id: 'RC-1', depth_ft: 43 } }),
        ]);
        expect(out.map((r) => `${r.sample_id}@${r.depth_ft}`)).toEqual([
            'RS-1@9.2', 'SPT-2@10.8', 'RS-2@10', 'SPT-5@25', 'RC-1@43',
        ]);
    });
});

// ── validation failures (all must throw → caller fails open) ────────────────

describe('applyOps — op validation', () => {
    it('rejects conflicting ops on the same row', () => {
        expect(() => applyOps('samples_collected', sampleRows(), [
            op({ op: 'delete_row', row: 1 }),
            op({ op: 'set_depth', row: 1, depth_ft: 10.8 }),
        ])).toThrow(/targeted by both/);
    });

    it('allows set_top on a merge survivor but not on an absorbed row', () => {
        expect(() => applyOps('lithology_intervals', lithRows(), [
            op({ op: 'merge_rows', rows: [1, 2] }),
            op({ op: 'set_top', row: 1, depth_ft: 10.2 }),
        ])).not.toThrow();
        expect(() => applyOps('lithology_intervals', lithRows(), [
            op({ op: 'merge_rows', rows: [1, 2] }),
            op({ op: 'set_top', row: 2, depth_ft: 10.2 }),
        ])).toThrow(/targeted by both/);
    });

    it('rejects out-of-range rows, non-consecutive merges, ops not allowed for the group', () => {
        expect(() => applyOps('samples_collected', sampleRows(), [
            op({ op: 'set_depth', row: 99, depth_ft: 1 }),
        ])).toThrow(/outside/);
        expect(() => applyOps('lithology_intervals', lithRows(), [
            op({ op: 'merge_rows', rows: [1, 3] }),
        ])).toThrow(/consecutive/);
        expect(() => applyOps('samples_collected', sampleRows(), [
            op({ op: 'merge_rows', rows: [0, 1] }),
        ])).toThrow(/not allowed/);
    });

    it('rejects add_row without identity fields', () => {
        expect(() => applyOps('lithology_intervals', lithRows(), [
            op({ op: 'add_row', item: { description_raw: 'Fill' } }), // no depth_from_ft
        ])).toThrow(/identity field/);
        expect(() => applyOps('samples_collected', sampleRows(), [
            op({ op: 'add_row', item: { depth_ft: 43 } }), // no sample_id
        ])).toThrow(/identity field/);
    });
});

// ── invariant gate ──────────────────────────────────────────────────────────

describe('checkInvariants', () => {
    it('throws when refined tops are not strictly increasing', () => {
        const bad = lithRows().slice(0, 3);
        bad[1].depth_from_ft = 12;
        bad[2].depth_from_ft = 12;
        expect(() => checkInvariants('lithology_intervals', lithRows(), bad, []))
            .toThrow(/strictly increasing/);
    });

    it('throws when a sample id vanishes without an explicit delete, passes with one', () => {
        const refined = sampleRows().slice(1); // RS-1 silently gone
        expect(() => checkInvariants('samples_collected', sampleRows(), refined, []))
            .toThrow(/lost without an explicit delete/);
        expect(() => checkInvariants('samples_collected', sampleRows(), refined, [
            op({ op: 'delete_row', row: 0 }),
        ])).not.toThrow();
    });

    it('throws on absurd depths', () => {
        const bad = [{ depth_from_ft: -50, depth_to_ft: 5, description_raw: 'x', eob: false }];
        expect(() => checkInvariants('lithology_intervals', bad, bad, [])).toThrow(/out of range/);
    });
});

// ── deterministic corrections ───────────────────────────────────────────────
// Geometry mirrors the pilot (file 9cdfe109) after the evidence-quality
// fixes: full-text lines at top-edge depths.

const pilotGeometry: DepthGeometry = {
    samples: [
        { id: 'RS-1', depth: 9.2, page: 1 },
        { id: 'SPT-2', depth: 10.8, page: 1 },
        { id: 'SPT-2', depth: 13.7, page: 1 },
        { id: 'RC-1', depth: 43, page: 3 },
    ],
    lithologyLines: [
        { text: "0.7' Plantmix over 0.4' Aggregate Base", depth: 0, page: 1 },
        { text: '(GC) Loose to medium dense, slightly moist, brown, Clayey Gravel with', depth: 1.2, page: 1 },
        { text: "Grinding on boulder from 4.5' to 6.0'", depth: 4.5, page: 1 },
        { text: '(CH) Soft to stiff, very moist to wet, brown, Sandy Fat Clay with scattered', depth: 10, page: 1 },
        { text: '(RK) Hard, strong, dark gray vesicular Basalt', depth: 38, page: 2 },
        { text: 'Bottom of hole at 45.5 feet.', depth: 45.6, page: 3 },
    ],
    contacts: [],
    calibrated_pages: 3,
};

describe('correctSamplesDeterministically', () => {
    it('sets depths by id (duplicates in document order), adds missing, never deletes', () => {
        const rows = [
            { sample_id: 'SPT-2', depth_ft: 10, sample_type: null },   // 1st SPT-2 → 10.8
            { sample_id: 'SPT-2', depth_ft: 15, sample_type: null },   // 2nd SPT-2 → 13.7
            { sample_id: 'GHOST-9', depth_ft: 99, sample_type: null }, // not measured → untouched, kept
        ];
        const { rows: out, changes } = correctSamplesDeterministically(rows, pilotGeometry);
        expect(out.map((r) => `${r.sample_id}@${r.depth_ft}`)).toEqual([
            'RS-1@9.2',      // added, inserted by depth
            'SPT-2@10.8',
            'SPT-2@13.7',
            'RC-1@43',       // added, inserted by depth
            'GHOST-9@99',    // never deleted
        ]);
        expect(changes).toHaveLength(4); // 2 sets + 2 adds
        // added rows are template-shaped
        expect(out[0]).toHaveProperty('sample_type', null);
    });

    it('reports no changes when everything already matches', () => {
        const rows = pilotGeometry.samples.map((s) => ({ sample_id: s.id, depth_ft: s.depth }));
        const { changes } = correctSamplesDeterministically(rows, pilotGeometry);
        expect(changes).toEqual([]);
    });

    it('an added row is never re-matched by a later measured sample with the same id', () => {
        // baseline has NO SPT-2 rows; both measured SPT-2s must be added as
        // separate rows (live bug: the 10.8 add got overwritten to 13.7)
        const rows = [{ sample_id: 'RS-1', depth_ft: 5, sample_type: null }];
        const { rows: out } = correctSamplesDeterministically(rows, pilotGeometry);
        expect(out.map((r) => `${r.sample_id}@${r.depth_ft}`)).toEqual([
            'RS-1@9.2', 'SPT-2@10.8', 'SPT-2@13.7', 'RC-1@43',
        ]);
    });
});

describe('snapLithologyTops', () => {
    it('snaps each row to its matching line by normalized prefix (either direction), in order', () => {
        const rows = [
            // row longer than line (extraction concatenated wrapped lines)
            { depth_from_ft: 0, depth_to_ft: 5, description_raw: '(GC) Loose to medium dense, slightly moist, brown, Clayey Gravel with cobble and boulder size basalt rock fragments (Roadway Fill)', eob: false },
            // row shorter than line (extraction truncated)
            { depth_from_ft: 5, depth_to_ft: 25, description_raw: '(CH) Soft to stiff, very moist to wet, brown', eob: false },
            { depth_from_ft: 35, depth_to_ft: 45, description_raw: '(RK) Hard, strong, dark gray vesicular Basalt', eob: false },
        ];
        const { rows: out, changes } = snapLithologyTops(rows, pilotGeometry);
        // 3 snapped tops + the deterministically added EOB row (45.6 → stated 45.5)
        expect(out.map((r) => r.depth_from_ft)).toEqual([1.2, 10, 38, 45.5]);
        expect(changes.filter((c) => c.startsWith('snap top'))).toHaveLength(3);
    });

    it('note lines and short texts never anchor a row', () => {
        const rows = [
            // "Grinding on boulder…" line must not capture this row even though
            // the row is between GC and CH — no textual prefix relation
            { depth_from_ft: 5, depth_to_ft: 25, description_raw: '(CH) Soft to stiff, very moist to wet, brown, Sandy Fat Clay', eob: false },
            { depth_from_ft: 30, depth_to_ft: 45, description_raw: 'Fill', eob: false }, // too short to match
        ];
        const { rows: out } = snapLithologyTops(rows, pilotGeometry);
        expect(out[0].depth_from_ft).toBe(10);
        expect(out[1].depth_from_ft).toBe(30); // untouched
    });

    it('stated EOB depth beats the measured line depth (within tolerance)', () => {
        const rows = [
            { depth_from_ft: 45, depth_to_ft: 45, description_raw: 'Bottom of hole at 45.5 feet.', eob: true },
        ];
        const { rows: out, changes } = snapLithologyTops(rows, pilotGeometry);
        // snapped to measured 45.6 first, then stated 45.5 wins
        expect(out[0].depth_from_ft).toBe(45.5);
        expect(changes.some((c) => c.includes('stated EOB'))).toBe(true);
    });

    it('adds the EOB row from evidence when extraction omitted it (live bug)', () => {
        const rows = [
            { depth_from_ft: 35, depth_to_ft: 45, description_raw: '(RK) Hard, strong, dark gray vesicular Basalt', eob: false },
        ];
        const { rows: out, changes } = snapLithologyTops(rows, pilotGeometry);
        const eob = out.find((r) => r.eob === true)!;
        expect(eob).toBeTruthy();
        expect(eob.depth_from_ft).toBe(45.5); // line @45.6, stated 45.5 wins
        expect(changes.some((c) => c.includes('add EOB row'))).toBe(true);
        // and never added twice
        const again = snapLithologyTops(out, pilotGeometry);
        expect(again.rows.filter((r) => r.eob === true)).toHaveLength(1);
    });

    it('stated surfacing thickness fixes the next top when it agrees with the measurement', () => {
        const rows = [
            { depth_from_ft: 0, depth_to_ft: 5, description_raw: "0.7' Plantmix over 0.4' Aggregate Base", eob: false },
            { depth_from_ft: 5, depth_to_ft: 25, description_raw: '(GC) Loose to medium dense, slightly moist, brown, Clayey Gravel with', eob: false },
        ];
        const { rows: out } = snapLithologyTops(rows, pilotGeometry);
        // GC snapped to measured 1.2, then stated 0.7 + 0.4 = 1.1 wins (|1.1-1.2| ≤ tol)
        expect(out[0].depth_from_ft).toBe(0);
        expect(out[1].depth_from_ft).toBe(1.1);
    });

    it('splits an absorbed surface layer with a clean text cut, snaps both parts', () => {
        const rows = [
            { depth_from_ft: 0, depth_to_ft: 10, description_raw: "0.7' Plantmix over 0.4' Aggregate Base (GC) Loose to medium dense, slightly moist, brown, Clayey Gravel with cobble", uscs_symbol: 'GC', eob: false },
            { depth_from_ft: 10, depth_to_ft: 26, description_raw: '(CH) Soft to stiff, very moist to wet, brown, Sandy Fat Clay with scattered', uscs_symbol: 'CH', eob: false },
        ];
        const { rows: out, changes } = snapLithologyTops(rows, pilotGeometry);
        expect(out).toHaveLength(4); // split pair + CH + added EOB row
        expect(out[0].description_raw).toBe("0.7' Plantmix over 0.4' Aggregate Base");
        expect(out[0].depth_from_ft).toBe(0);
        expect(out[0].uscs_symbol).toBeNull(); // template row, not GC
        expect((out[1].description_raw as string).startsWith('(GC) Loose to medium dense')).toBe(true);
        expect(out[1].depth_from_ft).toBe(1.1); // snapped to 1.2, stated 0.7+0.4 wins
        expect(out[1].uscs_symbol).toBe('GC'); // kept from merged row
        expect(out[2].depth_from_ft).toBe(10);
        expect(changes.some((c) => c.includes('split absorbed'))).toBe(true);
    });

    it('does not split wrapped lines (small gap) or when the surfacing row already exists', () => {
        // gap between first two lines below the split threshold → no split
        const wrappedGeo: DepthGeometry = {
            ...pilotGeometry,
            lithologyLines: [
                { text: '(CH) Soft to stiff, very moist to wet, brown, Sandy Fat Clay with scattered', depth: 10, page: 1 },
                { text: 'subangular basalt rock fragments and cobbles', depth: 10.4, page: 1 },
            ],
        };
        const merged = [{ depth_from_ft: 10, depth_to_ft: 26, description_raw: '(CH) Soft to stiff, very moist to wet, brown, Sandy Fat Clay with scattered subangular basalt rock fragments and cobbles', eob: false }];
        expect(snapLithologyTops(merged, wrappedGeo).rows).toHaveLength(1);

        // surfacing already its own row → no second split
        const already = [
            { depth_from_ft: 0, depth_to_ft: 1.1, description_raw: "0.7' Plantmix over 0.4' Aggregate Base", eob: false },
            { depth_from_ft: 1.1, depth_to_ft: 10, description_raw: '(GC) Loose to medium dense, slightly moist, brown, Clayey Gravel with', eob: false },
        ];
        const rowsOut = snapLithologyTops(already, pilotGeometry).rows;
        expect(rowsOut.filter((r) => r.eob !== true)).toHaveLength(2); // no re-split (EOB add is separate)
    });

    it('stated thickness is ignored when it disagrees with the measurement', () => {
        const geo: DepthGeometry = {
            ...pilotGeometry,
            lithologyLines: [
                { text: "3.0' Asphalt over 3.0' Base Course of gravel", depth: 0, page: 1 },
                { text: '(CH) Soft to stiff, very moist to wet, brown, Sandy Fat Clay with scattered', depth: 10, page: 1 },
            ],
        };
        const rows = [
            { depth_from_ft: 0, depth_to_ft: 10, description_raw: "3.0' Asphalt over 3.0' Base Course of gravel", eob: false },
            { depth_from_ft: 10, depth_to_ft: 20, description_raw: '(CH) Soft to stiff, very moist to wet, brown, Sandy Fat Clay with scattered', eob: false },
        ];
        const { rows: out } = snapLithologyTops(rows, geo);
        expect(out[1].depth_from_ft).toBe(10); // stated 6.0 is 4 ft off measured 10 → rejected
    });
});

// ── schema fragment lookup ──────────────────────────────────────────────────

describe('findGroupItemSchema', () => {
    it('finds the group item schema nested under borehole_log items', () => {
        const schema = {
            type: 'object',
            properties: {
                borehole_log: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            lithology_intervals: {
                                type: 'array',
                                items: { type: 'object', properties: { depth_from_ft: { type: 'number' } } },
                            },
                        },
                    },
                },
            },
        };
        const item = findGroupItemSchema(schema, 'lithology_intervals');
        expect(item).toBeTruthy();
        expect((item as any).properties.depth_from_ft).toBeTruthy();
        expect(findGroupItemSchema(schema, 'samples_collected')).toBeNull();
    });
});

describe('splitAbsorbedSurfacing — USCS backfill', () => {
    it('fills the soil part\'s uscs_symbol from its opening "(XX)" when the merged row had none', () => {
        const rows = [
            { depth_from_ft: 0, depth_to_ft: 10, description_raw: "0.7' Plantmix over 0.4' Aggregate Base (GC) Loose to medium dense, slightly moist, brown, Clayey Gravel with cobble", uscs_symbol: null, uscs_source: 'not_present', eob: false },
        ];
        const { rows: out } = snapLithologyTops(rows, pilotGeometry);
        const soil = out.find((r) => (r.description_raw as string || '').startsWith('(GC)'))!;
        expect(soil.uscs_symbol).toBe('GC');
        expect(soil.uscs_source).toBe('inline_parenthetical');
    });
});

describe('splitAbsorbedSurfacing — coexistence with a model-added surfacing row', () => {
    it('trims the still-merged row instead of creating a second surfacing row', () => {
        const rows = [
            { depth_from_ft: 0, depth_to_ft: null, description_raw: "0.7' Plantmix over 0.4' Aggregate Base", uscs_symbol: null, eob: false }, // model-added
            { depth_from_ft: 0, depth_to_ft: 10, description_raw: "0.7' Plantmix over 0.4' Aggregate Base (GC) Loose to medium dense, slightly moist, brown, Clayey Gravel with cobble", uscs_symbol: null, eob: false },
            { depth_from_ft: 10, depth_to_ft: 26, description_raw: '(CH) Soft to stiff, very moist to wet, brown, Sandy Fat Clay with scattered', uscs_symbol: 'CH', eob: false },
        ];
        const { rows: out } = snapLithologyTops(rows, pilotGeometry);
        const surfacings = out.filter((r) => normLike(r.description_raw as string) === normLike("0.7' Plantmix over 0.4' Aggregate Base"));
        expect(surfacings).toHaveLength(1); // no duplicate
        const soil = out.find((r) => (r.description_raw as string || '').startsWith('(GC)'))!;
        expect(soil.depth_from_ft).toBe(1.1); // trimmed + snapped + stated thickness
        expect(soil.uscs_symbol).toBe('GC');
    });
});

function normLike(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

describe('snapLithologyTops — messy-baseline hardening (live run findings)', () => {
    it('thickness override works on UNSORTED input (model-added surfacing after the soil row)', () => {
        const rows = [
            { depth_from_ft: 0, depth_to_ft: 10, description_raw: "0.7' Plantmix over 0.4' Aggregate Base (GC) Loose to medium dense, slightly moist, brown, Clayey Gravel with cobble", uscs_symbol: null, eob: false },
            { depth_from_ft: 0, depth_to_ft: null, description_raw: "0.7' Plantmix over 0.4' Aggregate Base", uscs_symbol: null, eob: false },
        ];
        const { rows: out } = snapLithologyTops(rows, pilotGeometry);
        const soil = out.find((r) => (r.description_raw as string || '').startsWith('(GC)'))!;
        expect(soil.depth_from_ft).toBe(1.1); // trimmed → snapped 1.2 → stated 1.1
    });

    it('drops an unmatched page-break duplicate row (identical text, "(continued)" variants too)', () => {
        const rows = [
            { depth_from_ft: 5, depth_to_ft: 25, description_raw: '(CH) Soft to stiff, very moist to wet, brown, Sandy Fat Clay with scattered', uscs_symbol: 'CH', eob: false },
            { depth_from_ft: 25, depth_to_ft: 26, description_raw: '(CH) Soft to stiff, very moist to wet, brown, Sandy Fat Clay with scattered', uscs_symbol: 'CH', eob: false },
            { depth_from_ft: 35, depth_to_ft: 45, description_raw: '(RK) Hard, strong, dark gray vesicular Basalt', uscs_symbol: 'RK', eob: false },
            { depth_from_ft: 45, depth_to_ft: 45.5, description_raw: '(RK) Hard, strong, dark gray vesicular Basalt (continued)', uscs_symbol: 'RK', eob: false },
        ];
        const { rows: out, changes } = snapLithologyTops(rows, pilotGeometry);
        const ch = out.filter((r) => r.uscs_symbol === 'CH');
        const rk = out.filter((r) => r.uscs_symbol === 'RK');
        expect(ch).toHaveLength(1);
        expect(ch[0].depth_from_ft).toBe(10);
        expect(rk).toHaveLength(1);
        expect(rk[0].depth_from_ft).toBe(38);
        expect(changes.filter((c) => c.includes('drop unmatched duplicate'))).toHaveLength(2);
    });

    it('keeps an unmatched row whose text is unique (paraphrased layer, no twin)', () => {
        const rows = [
            { depth_from_ft: 5, depth_to_ft: 25, description_raw: '(CH) Soft to stiff, very moist to wet, brown, Sandy Fat Clay with scattered', uscs_symbol: 'CH', eob: false },
            { depth_from_ft: 30, depth_to_ft: 33, description_raw: 'a totally paraphrased layer description with no evidence twin', uscs_symbol: null, eob: false },
        ];
        const { rows: out } = snapLithologyTops(rows, pilotGeometry);
        expect(out.filter((r) => r.uscs_symbol === null && r.eob !== true)).toHaveLength(1);
    });
});

// ── stated-depth lock (Lakeshore GP-1 live finding, 2026-07-05) ─────────────
// This format's descriptions open with explicit intervals ("0-1'", "1-10'"),
// which the baseline extraction already read exactly; measured description
// lines overshoot the drawn contact by ~0.6-0.9 ft (text sits below it).
// Without the lock, refinement REGRESSED an already-correct result.

const lakeshoreGeometry: DepthGeometry = {
    samples: [],
    lithologyLines: [
        { text: '0-1 SURFACE GRAVEL FILL', depth: 0, page: 1 },
        { text: "1-10' PRE-EXISTING SAND DISTURBED", depth: 1.6, page: 1 },
        { text: 'SAND', depth: 10.8, page: 1 }, // too short to ever match
        { text: 'LIGHT BROWN FINE SAND, MINOR COARSE', depth: 18, page: 1 },
        { text: "E.O.B. @25' (IN SAME)", depth: 25.9, page: 1 },
    ],
    contacts: [],
    calibrated_pages: 1,
};

const lakeshoreRows = () => [
    { depth_from_ft: 0, depth_to_ft: 1, description_raw: "0-1' SURFACE GRAVEL FILL", eob: false },
    { depth_from_ft: 1, depth_to_ft: 10, description_raw: "1-10' PRE-EXISTING SAND DISTURBED DURING UST REMOVAL AND TEST PIT EXCAVATION", eob: false },
    { depth_from_ft: 10, depth_to_ft: 20, description_raw: 'SAND', eob: false },
    { depth_from_ft: 20, depth_to_ft: 24, description_raw: "LIGHT BROWN FINE SAND, MINOR COARSE SAND & TRACE FINE GRAVEL. MOIST, LOOSE, NO ODORS OR STAINS. NOTICEABLY MORE MED. & COARSE SAND 21.5'-24'", eob: false },
    { depth_from_ft: 24, depth_to_ft: 25, description_raw: "E.O.B. @25' (IN SAME)", eob: true },
];

describe('snapLithologyTops — stated-depth lock', () => {
    it('locks leading "X-Y\'" rows, snaps unlocked rows, stated EOB wins past the old ±0.5 gate', () => {
        const { rows: out, changes } = snapLithologyTops(lakeshoreRows(), lakeshoreGeometry);
        expect(out.map((r) => r.depth_from_ft)).toEqual([0, 1, 10, 18, 25]);
        // row 1 matched its overshooting evidence line (1.6) but must NOT snap
        expect(changes.some((c) => c.includes('→ 1.6'))).toBe(false);
        // light-brown row's only range is MID-text ("…21.5'-24'") → not locked
        // → measured snap 20 → 18 fires (the one genuine correction)
        expect(changes.some((c) => c.startsWith('snap top row 3: 20 → 18'))).toBe(true);
        // stated "@25'" beats measured 25.9 (|0.9| > the old 0.5 tolerance)
        expect(changes.some((c) => c.includes('stated EOB depth: 25.9 → 25'))).toBe(true);
    });

    it('undoes a model set_top that moved a stated row', () => {
        const rows = lakeshoreRows();
        rows[1].depth_from_ft = 1.6; // simulate the observed set_top 1 → 1.6
        const { rows: out, changes } = snapLithologyTops(rows, lakeshoreGeometry);
        expect(out[1].depth_from_ft).toBe(1);
        expect(changes.some((c) => c.includes('stated top beats measured'))).toBe(true);
    });

    it('recognizes the E.O.B. abbreviation when adding a missing EOB row', () => {
        const rows = lakeshoreRows().filter((r) => r.eob !== true);
        const { rows: out } = snapLithologyTops(rows, lakeshoreGeometry);
        const eob = out.find((r) => r.eob === true)!;
        expect(eob).toBeTruthy();
        expect(eob.depth_from_ft).toBe(25); // line @25.9, stated @25' wins
    });

    it('pilot rows carry no leading ranges → nothing locks (no regression)', () => {
        const rows = [
            { depth_from_ft: 0, depth_to_ft: 1, description_raw: "0.7' Plantmix over 0.4' Aggregate Base", eob: false },
            { depth_from_ft: 5, depth_to_ft: 25, description_raw: '(CH) Soft to stiff, very moist to wet, brown, Sandy Fat Clay with scattered', eob: false },
        ];
        // "0.7' Plantmix over 0.4'…" is thicknesses, not a leading X-Y' range —
        // the CH row must still snap to its measured line (10)
        const { rows: out } = snapLithologyTops(rows, pilotGeometry);
        expect(out.find((r) => (r.description_raw as string).startsWith('(CH)'))!.depth_from_ft).toBe(10);
    });
});

describe('dropEvidenceContradictingMerges', () => {
    const mergeOp = (rows: number[]): RefinementOp =>
        ({ op: 'merge_rows', rows, row: null, depth_ft: null, item: null } as RefinementOp);

    it('drops a merge that absorbs a row with its own evidence line (Lakeshore live bug)', () => {
        // gpt-4.1 merged "SAND" (10-20) into "LIGHT BROWN…" (20-24) — but the
        // absorbed row anchors to its own measured line at 18 → real layer
        const out = dropEvidenceContradictingMerges([mergeOp([2, 3])], lakeshoreRows(), lakeshoreGeometry, 'test');
        expect(out).toHaveLength(0);
    });

    it('keeps a merge of a wrapped fragment with no evidence anchor of its own', () => {
        const rows = [
            { depth_from_ft: 10, depth_to_ft: 20, description_raw: '(CH) Soft to stiff, very moist to wet, brown, Sandy Fat Clay with scattered', eob: false },
            { depth_from_ft: 20, depth_to_ft: 26, description_raw: 'fragments', eob: false }, // wrapped tail — too short to anchor
        ];
        const out = dropEvidenceContradictingMerges([mergeOp([0, 1])], rows, pilotGeometry, 'test');
        expect(out).toHaveLength(1);
    });

    it('keeps a merge when both rows anchor to the SAME line (true duplicate)', () => {
        const rows = [
            { depth_from_ft: 10, depth_to_ft: 26, description_raw: '(CH) Soft to stiff, very moist to wet, brown, Sandy Fat Clay', eob: false },
            { depth_from_ft: 26, depth_to_ft: 30, description_raw: '(CH) Soft to stiff, very moist to wet, brown', eob: false },
        ];
        // both prefix-match the same CH evidence line → not contradicted
        const out = dropEvidenceContradictingMerges([mergeOp([0, 1])], rows, pilotGeometry, 'test');
        expect(out).toHaveLength(1);
    });

    it('never touches non-merge ops', () => {
        const ops = [{ op: 'set_top', row: 1, depth_ft: 5, rows: null, item: null } as RefinementOp];
        expect(dropEvidenceContradictingMerges(ops, lakeshoreRows(), lakeshoreGeometry, 'test')).toEqual(ops);
    });
});

describe('DEPTH_REFINEMENT_GUARDS kill switch', () => {
    const ENV = 'DEPTH_REFINEMENT_GUARDS';
    let saved: string | undefined;
    beforeEach(() => { saved = process.env[ENV]; delete process.env[ENV]; });
    afterEach(() => {
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
    });

    it('guards are ON by default', () => {
        const { rows: out } = snapLithologyTops(lakeshoreRows(), lakeshoreGeometry);
        expect(out.map((r) => r.depth_from_ft)).toEqual([0, 1, 10, 18, 25]);
    });

    it('=false restores pre-guard behavior: stated rows snap to measured, EOB back to ±0.5', () => {
        process.env[ENV] = 'false';
        const { rows: out } = snapLithologyTops(lakeshoreRows(), lakeshoreGeometry);
        // row 1 snaps to its overshooting line; EOB keeps measured 25.9
        // (stated 25 is outside the old ±0.5 window)
        expect(out[1].depth_from_ft).toBe(1.6);
        expect(out.find((r) => r.eob === true)!.depth_from_ft).toBe(25.9);
    });
});
