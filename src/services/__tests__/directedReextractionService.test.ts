import { describe, it, expect } from 'vitest';
import {
    diffGroupValue,
    rowsEqual,
    rowSimilarity,
    resolveModeForGroup,
    buildRexMode,
    parseRexMode,
    PATCH_ROW_THRESHOLD,
    type DirectedFinding,
} from '../directedReextractionService.ts';
import { verifyFindingAgainstRecord } from '../sectionQAService.js';
import {
    buildDirectedReextractionResponseFormat,
    buildDirectedReextractionSystemPrompt,
    buildDirectedReextractionSharedUserText,
    buildDirectedReextractionInstruction,
    buildDirectedPatchInstruction,
} from '../../config/openaiPrompts.ts';

// ── fixtures ────────────────────────────────────────────────────────────────

const row = (from: number, to: number, material = 'clay') => ({
    depth_from_ft: from,
    depth_to_ft: to,
    primary_material: material,
});

const byType = (findings: DirectedFinding[]) => {
    const out: Record<string, DirectedFinding[]> = {};
    for (const f of findings) (out[f.issue_type] ??= []).push(f);
    return out;
};

// ── row helpers ─────────────────────────────────────────────────────────────

describe('rowsEqual', () => {
    it('tolerates numeric formatting and case differences', () => {
        expect(rowsEqual(
            { depth_to_ft: 5.0, material: 'Clay' },
            { depth_to_ft: '5', material: 'clay' },
        )).toBe(true);
    });

    it('treats blank tokens as equal', () => {
        expect(rowsEqual({ a: null, b: 1 }, { a: 'N/A', b: 1 })).toBe(true);
    });

    it('detects a real difference', () => {
        expect(rowsEqual(row(0, 5), row(0, 6))).toBe(false);
    });
});

describe('rowSimilarity', () => {
    it('is 1 for identical rows and 0 for disjoint rows', () => {
        expect(rowSimilarity(row(0, 5), row(0, 5))).toBe(1);
        expect(rowSimilarity(row(0, 5, 'clay'), row(90, 95, 'gravel'))).toBe(0);
    });

    it('scores a partially-corrected row in between', () => {
        const score = rowSimilarity(row(0, 5, 'clay'), row(0, 6, 'clay'));
        expect(score).toBeGreaterThanOrEqual(0.5);
        expect(score).toBeLessThan(1);
    });
});

// ── array-group diffs (the samples_collected case) ─────────────────────────

describe('diffGroupValue — array groups', () => {
    it('emits nothing when the re-read matches the extraction', () => {
        const rows = [row(0, 5), row(5, 12, 'sand')];
        expect(diffGroupValue({
            groupName: 'lithology_intervals',
            oldValue: rows,
            newValue: [row(0, 5), row(5, 12, 'sand')],
        }).findings).toEqual([]);
    });

    it('emits add_row for rows the extraction missed (incomplete-group case)', () => {
        const oldRows = [row(0, 5)];
        const newRows = [row(0, 5), row(5, 12, 'sand'), row(12, 20, 'gravel')];
        const { findings } = diffGroupValue({
            groupName: 'samples_collected', oldValue: oldRows, newValue: newRows,
        });
        const t = byType(findings);
        expect(t.add_row).toHaveLength(2);
        expect(t.delete_row).toBeUndefined();
        expect(t.update_row).toBeUndefined();
        // row_value carries the full row; row_index is the position hint.
        expect(JSON.parse(t.add_row[0].row_value!)).toEqual(row(5, 12, 'sand'));
        expect(t.add_row[0].row_index).toBe(1);
        expect(t.add_row[1].row_index).toBe(2);
        expect(t.add_row[0].severity).toBe('error');
    });

    it('pairs a similar row as update_row instead of delete+add', () => {
        const { findings } = diffGroupValue({
            groupName: 'lithology_intervals',
            oldValue: [row(0, 5), row(5, 12, 'sand')],
            newValue: [row(0, 5), row(5, 13, 'sand')], // corrected bottom depth
        });
        const t = byType(findings);
        expect(t.update_row).toHaveLength(1);
        expect(t.update_row[0].row_index).toBe(1);
        expect(JSON.parse(t.update_row[0].row_value!)).toEqual(row(5, 13, 'sand'));
        expect(t.add_row).toBeUndefined();
        expect(t.delete_row).toBeUndefined();
    });

    it('emits delete_row at warning severity for rows the re-read did not find', () => {
        const { findings, suppressedDeletes } = diffGroupValue({
            groupName: 'lithology_intervals',
            oldValue: [row(0, 5), row(90, 95, 'gravel')],
            newValue: [row(0, 5)],
        });
        const t = byType(findings);
        expect(suppressedDeletes).toBe(0);
        expect(t.delete_row).toHaveLength(1);
        expect(t.delete_row[0].row_index).toBe(1);
        expect(t.delete_row[0].severity).toBe('warning');
    });

    it('suppresses delete_rows when the pattern says under-emission, not phantom rows', () => {
        // 10 real rows; the model stopped after 4 and changed nothing else —
        // 6 unmatched old rows vs 0 adds/updates is a truncated read, not
        // evidence that 6 rows are fake.
        const oldRows = Array.from({ length: 10 }, (_, i) => row(i * 5, i * 5 + 5));
        const newRows = oldRows.slice(0, 4);
        const { findings, suppressedDeletes } = diffGroupValue({
            groupName: 'time_series_readings', oldValue: oldRows, newValue: newRows,
        });
        expect(findings).toEqual([]);
        expect(suppressedDeletes).toBe(6);
    });

    it('still deletes when adds/updates outweigh the removals (real correction)', () => {
        // 4 old rows; re-read keeps 1, corrects nothing, adds 5 fresh ones —
        // deletions are plausibly real (the table was misread wholesale).
        const oldRows = [row(0, 5), row(5, 10), row(10, 15), row(15, 20)];
        const newRows = [row(0, 5), ...Array.from({ length: 5 }, (_, i) => row(100 + i * 5, 105 + i * 5, 'silt'))];
        const { findings, suppressedDeletes } = diffGroupValue({
            groupName: 'lithology_intervals', oldValue: oldRows, newValue: newRows,
        });
        const t = byType(findings);
        expect(suppressedDeletes).toBe(0);
        expect(t.add_row).toHaveLength(5);
        expect(t.delete_row).toHaveLength(3);
    });

    it('never synthesizes mass deletions when the re-read comes back empty', () => {
        expect(diffGroupValue({
            groupName: 'samples_collected',
            oldValue: [row(0, 5), row(5, 12)],
            newValue: [],
        }).findings).toEqual([]);
        expect(diffGroupValue({
            groupName: 'samples_collected',
            oldValue: [row(0, 5)],
            newValue: null,
        }).findings).toEqual([]);
    });

    it('collapses a never-extracted group into ONE whole-value missing_value fix', () => {
        const fresh = [row(0, 5), row(5, 12, 'sand')];
        const { findings } = diffGroupValue({
            groupName: 'samples_collected', oldValue: null, newValue: fresh,
        });
        expect(findings).toHaveLength(1);
        expect(findings[0].issue_type).toBe('missing_value');
        expect(findings[0].field).toBe('samples_collected');
        expect(findings[0].corrected_value).toEqual(fresh);
    });
});

// ── object-group diffs ─────────────────────────────────────────────────────

describe('diffGroupValue — object groups', () => {
    it('emits wrong_value / missing_value with typed corrected_value', () => {
        const { findings } = diffGroupValue({
            groupName: 'well_info',
            oldValue: { well_id: 'MW-1', total_depth_ft: 60, county: null },
            newValue: { well_id: 'MW-1', total_depth_ft: 68, county: 'Kent' },
        });
        const t = byType(findings);
        expect(t.wrong_value).toHaveLength(1);
        expect(t.wrong_value[0].field).toBe('well_info.total_depth_ft');
        expect(t.wrong_value[0].corrected_value).toBe(68);
        expect(t.missing_value).toHaveLength(1);
        expect(t.missing_value[0].field).toBe('well_info.county');
        expect(t.missing_value[0].corrected_value).toBe('Kent');
    });

    it('treats an unreadable value as cautious extra_value, not silent clearing', () => {
        const { findings } = diffGroupValue({
            groupName: 'well_info',
            oldValue: { county: 'Kent' },
            newValue: { county: null },
        });
        expect(findings).toHaveLength(1);
        expect(findings[0].issue_type).toBe('extra_value');
        expect(findings[0].severity).toBe('warning');
        expect(findings[0].corrected_value).toBeNull();
    });

    it('ignores formatting-only differences (tolerant equality)', () => {
        expect(diffGroupValue({
            groupName: 'well_info',
            oldValue: { total_depth_ft: 68, flowing: false },
            newValue: { total_depth_ft: '68.0', flowing: 'No' },
        }).findings).toEqual([]);
    });

    it('diffs nested row arrays inside an object group at the right path', () => {
        const { findings } = diffGroupValue({
            groupName: 'well_construction',
            oldValue: { casings: [row(0, 20, 'steel')] },
            newValue: { casings: [row(0, 20, 'steel'), row(20, 40, 'pvc')] },
        });
        expect(findings).toHaveLength(1);
        expect(findings[0].issue_type).toBe('add_row');
        expect(findings[0].field).toBe('well_construction.casings');
    });
});

// ── mode selection ─────────────────────────────────────────────────────────

describe('resolveModeForGroup', () => {
    const bigArray = Array.from({ length: PATCH_ROW_THRESHOLD }, (_, i) => row(i, i + 1));

    it('honors explicit overrides regardless of size', () => {
        expect(resolveModeForGroup('full', bigArray)).toBe('full');
        expect(resolveModeForGroup('patch', [row(0, 5)])).toBe('patch');
    });

    it('auto: large populated arrays go to patch (output ∝ defects)', () => {
        expect(resolveModeForGroup('auto', bigArray)).toBe('patch');
    });

    it('auto: small, empty, or missing groups get the full re-read', () => {
        expect(resolveModeForGroup('auto', [row(0, 5)])).toBe('full');
        expect(resolveModeForGroup('auto', [])).toBe('full');
        expect(resolveModeForGroup('auto', null)).toBe('full');
        expect(resolveModeForGroup('auto', { name: 'MW-1' })).toBe('full');
    });

    it('auto: an object group with a large nested array goes to patch', () => {
        expect(resolveModeForGroup('auto', { readings: bigArray })).toBe('patch');
    });
});

// ── queue mode strings ─────────────────────────────────────────────────────

describe('rex mode strings', () => {
    it('round-trips a request id', () => {
        const id = 'a3b48c1e-6a51-4c22-9d51-0e5f8c6a2f11';
        expect(parseRexMode(buildRexMode(id))).toBe(id);
    });

    it('rejects non-rex modes', () => {
        expect(parseRexMode('qa:all')).toBeNull();
        expect(parseRexMode('normal')).toBeNull();
        expect(parseRexMode('rex:')).toBeNull();
        expect(parseRexMode(null)).toBeNull();
    });
});

// ── integration with the QA trust layer ────────────────────────────────────

describe('drafts survive verifyFindingAgainstRecord', () => {
    it('row findings get real row content frozen into `actual` (the UI apply anchor)', () => {
        const record = { lithology_intervals: [row(0, 5), row(5, 12, 'sand')] };
        const drafts = diffGroupValue({
            groupName: 'lithology_intervals',
            oldValue: record.lithology_intervals,
            newValue: [row(0, 5), row(5, 13, 'sand'), row(13, 20, 'gravel')],
        }).findings;
        const verified = drafts
            .map((d) => verifyFindingAgainstRecord(d, record, undefined))
            .filter((r: { keep: boolean }) => r.keep)
            .map((r: { issue: DirectedFinding }) => r.issue);

        expect(verified).toHaveLength(2);
        const update = verified.find((f) => f.issue_type === 'update_row')!;
        expect(update.actual).toBe(JSON.stringify(row(5, 12, 'sand')));
        const add = verified.find((f) => f.issue_type === 'add_row')!;
        expect(JSON.parse(add.row_value!)).toEqual(row(13, 20, 'gravel'));
    });

    it('whole-group missing_value survives verification with the array intact', () => {
        const record = { samples_collected: null };
        const fresh = [row(0, 5)];
        const [draft] = diffGroupValue({
            groupName: 'samples_collected', oldValue: null, newValue: fresh,
        }).findings;
        const { keep, issue } = verifyFindingAgainstRecord(draft, record, undefined);
        expect(keep).toBe(true);
        expect(issue.corrected_value).toEqual(fresh);
        expect(issue.actual).toBeNull();
    });

    it('a draft that matches the record after all is dropped as a no-op', () => {
        const record = { well_info: { total_depth_ft: 68 } };
        const [draft] = diffGroupValue({
            groupName: 'well_info',
            oldValue: { total_depth_ft: 60 }, // stale caller copy
            newValue: { total_depth_ft: 68 },
        }).findings;
        const { keep } = verifyFindingAgainstRecord(draft, record, undefined);
        expect(keep).toBe(false);
    });
});

// ── prompt builders ────────────────────────────────────────────────────────

describe('directed re-extraction prompts', () => {
    const groupSchema = {
        type: 'array',
        items: {
            type: 'object',
            additionalProperties: false,
            required: ['depth_from_ft'],
            properties: { depth_from_ft: { type: 'number' } },
        },
    };

    it('wraps the group sub-schema in a strict root object', () => {
        const rf = buildDirectedReextractionResponseFormat('samples_collected', groupSchema) as {
            type: string;
            json_schema: { strict: boolean; schema: Record<string, unknown> };
        };
        expect(rf.type).toBe('json_schema');
        expect(rf.json_schema.strict).toBe(true);
        expect(rf.json_schema.schema.required).toEqual(['samples_collected']);
        expect((rf.json_schema.schema.properties as Record<string, unknown>).samples_collected).toBe(groupSchema);
    });

    it('system prompt stresses exhaustive multi-page table reads', () => {
        const p = buildDirectedReextractionSystemPrompt(3);
        expect(p).toContain('EVERY row');
        expect(p).toContain('ALL 3 pages');
    });

    it('shared user text carries no group-specific content (cache prefix)', () => {
        const text = buildDirectedReextractionSharedUserText([4, 5]);
        expect(text).toContain('pages 4, 5');
        expect(text).not.toContain('samples_collected');
    });

    it('full-mode instruction carries the operator note and frames the old value as context-only', () => {
        const text = buildDirectedReextractionInstruction({
            groupName: 'samples_collected',
            groupSchema,
            currentValue: [row(0, 5)],
            operatorPrompt: 'Most rows are missing; the table continues on page 2.',
        });
        expect(text).toContain('OPERATOR NOTE');
        expect(text).toContain('Most rows are missing');
        expect(text).toContain('do NOT copy unverified values');
    });

    it('patch instruction rides the grouped-QA instruction plus the operator note', () => {
        const text = buildDirectedPatchInstruction({
            groupName: 'time_series_readings',
            groupSchema,
            groupValue: [row(0, 5)],
            hint: { priority: 'critical', notes: 'watch for merged rows' },
            operatorPrompt: 'Readings after 12:00 are missing.',
        });
        expect(text).toContain('REVIEW THIS GROUP NOW: "time_series_readings"');
        expect(text).toContain('OPERATOR NOTE');
        expect(text).toContain('Readings after 12:00 are missing.');
        expect(text).toContain('watch for merged rows');
        expect(text).toContain('row-level ops');
    });
});
