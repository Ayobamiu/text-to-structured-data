import { describe, it, expect } from 'vitest';
import {
    applyOps,
    checkInvariants,
    findGroupItemSchema,
    type RefinementOp,
} from '../depthRefinementService.ts';

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
