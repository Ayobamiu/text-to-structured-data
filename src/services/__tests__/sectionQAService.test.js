import { describe, it, expect } from 'vitest';
import {
    schemaToFieldHints,
    schemaToPromptBlock,
    buildQAHintsBlock,
    buildSectionQASystemPrompt,
    buildSectionQAResponseFormat,
    buildGroupQACachedSystemPrompt,
    buildGroupQASharedUserText,
    buildGroupQAGroupInstruction,
    buildGroupQAResponseFormat,
} from '../../config/openaiPrompts.ts';
import {
    isNoOpFinding,
    qaValuesEqual,
    readFieldPath,
    verifyFindingAgainstRecord,
    splitSchemaIntoGroups,
    partitionGroupsForBatching,
    resolveSchemaForPath,
    extractEnumValues,
    coerceToEnum,
    deriveQualityFromFindings,
    buildFindingsSummary,
} from '../sectionQAService.js';

describe('schemaToFieldHints', () => {
    it('classifies objects, arrays, and scalars into the hint block', () => {
        const schema = {
            type: 'object',
            properties: {
                permit_number: { type: ['string', 'null'] },
                site_identification: {
                    type: 'object',
                    properties: { boring_well_id: { type: 'string' }, county: { type: 'string' } },
                },
                lithology_intervals: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: { depth_from_ft: { type: 'number' }, primary_material: { type: 'string' } },
                    },
                },
            },
        };
        const hints = schemaToFieldHints(schema);

        expect(hints).toContain('Objects:');
        expect(hints).toContain('site_identification: boring_well_id, county');
        expect(hints).toContain('Arrays (count rows carefully):');
        expect(hints).toContain('lithology_intervals: each row has depth_from_ft, primary_material');
        expect(hints).toContain('Scalars: permit_number');
    });

    it('infers object/array kind when an explicit type is absent', () => {
        const schema = {
            properties: {
                meta: { properties: { firm_name: {} } },          // object, no type
                rows: { items: { properties: { a: {}, b: {} } } }, // array, no type
            },
        };
        const hints = schemaToFieldHints(schema);
        expect(hints).toContain('meta: firm_name');
        expect(hints).toContain('rows: each row has a, b');
    });

    it('handles an array of primitives without item properties', () => {
        const schema = { properties: { tags: { type: 'array', items: { type: 'string' } } } };
        expect(schemaToFieldHints(schema)).toContain('tags: array of values');
    });

    it('parses a JSON string schema', () => {
        const json = JSON.stringify({ properties: { api_number: { type: 'string' } } });
        expect(schemaToFieldHints(json)).toContain('Scalars: api_number');
    });

    it('returns empty string for missing/invalid/empty schemas', () => {
        expect(schemaToFieldHints(null)).toBe('');
        expect(schemaToFieldHints('not json')).toBe('');
        expect(schemaToFieldHints({})).toBe('');
        expect(schemaToFieldHints({ properties: {} })).toBe('');
    });
});

describe('schemaToPromptBlock', () => {
    const smallSchema = {
        type: 'object',
        properties: {
            well_installed: { type: 'boolean' },
            site_identification: {
                type: 'object',
                properties: { boring_well_id: { type: 'string' } },
            },
        },
    };

    it('inlines the full schema (with real types) when small enough', () => {
        const block = schemaToPromptBlock(smallSchema);
        expect(block).toContain('"type": "boolean"');
        expect(block).toContain('well_installed');
        expect(block).toContain('Schema (types/enums are authoritative');
    });

    it('falls back to the compact field-hint block when the schema is too large', () => {
        // Pad the schema past the size guard with a large enum so the fallback kicks in.
        const bigSchema = {
            type: 'object',
            properties: {
                ...smallSchema.properties,
                padded_field: { type: 'string', enum: Array.from({ length: 2000 }, (_, i) => `value_${i}`) },
            },
        };
        const block = schemaToPromptBlock(bigSchema);
        expect(block).toContain('Schema fields (use EXACTLY these field paths in issues)');
        expect(block).not.toContain('"enum"');
    });

    it('returns empty string for missing/invalid schemas', () => {
        expect(schemaToPromptBlock(null)).toBe('');
        expect(schemaToPromptBlock('not json')).toBe('');
        expect(schemaToPromptBlock({})).toBe('');
    });
});

describe('buildQAHintsBlock', () => {
    it('renders priority, ignore, and notes per group', () => {
        const block = buildQAHintsBlock({
            lithology_intervals: { priority: 'critical', notes: 'Verify every depth against the log column.' },
            document_metadata: { priority: 'low', ignore: ['total_pages', 'page_number'] },
        });
        expect(block).toContain('PER-GROUP REVIEW PRIORITY');
        expect(block).toContain('lithology_intervals: priority=critical — Verify every depth against the log column.');
        expect(block).toContain('document_metadata: priority=low — never flag: total_pages, page_number');
    });

    it('parses a JSON string', () => {
        const block = buildQAHintsBlock(JSON.stringify({ foo: { priority: 'high' } }));
        expect(block).toContain('foo: priority=high');
    });

    it('returns empty string for null/empty/invalid hints', () => {
        expect(buildQAHintsBlock(null)).toBe('');
        expect(buildQAHintsBlock({})).toBe('');
        expect(buildQAHintsBlock('not json')).toBe('');
    });
});

describe('buildSectionQASystemPrompt', () => {
    it('splices qa_hints guidance and full-schema types into the prompt', () => {
        const prompt = buildSectionQASystemPrompt({
            schema: { type: 'object', properties: { well_installed: { type: 'boolean' } } },
            qaHints: { well_construction: { priority: 'critical' } },
        });
        expect(prompt).toContain('"type": "boolean"');
        expect(prompt).toContain('Boolean representation');
        expect(prompt).toContain('well_construction: priority=critical');
        expect(prompt).toContain('Organize findings into `groups`');
    });
});

describe('buildSectionQAResponseFormat', () => {
    it('produces a strict json_schema with groups of issues (not a flat issues list)', () => {
        const format = buildSectionQAResponseFormat();
        const schema = format.json_schema.schema;
        expect(schema.required).toEqual(['summary', 'groups', 'overall_quality']);
        expect(schema.properties.groups.type).toBe('array');
        const groupItem = schema.properties.groups.items;
        expect(groupItem.required).toEqual(['group', 'issues']);
        expect(groupItem.properties.issues.items.properties.issue_type.enum).toContain('wrong_value');
    });
});

describe('isNoOpFinding', () => {
    it('drops findings where page and extraction are both empty (the "Null" FP class)', () => {
        // Real false positives seen on file a21300ce — survived the old
        // `expected !== actual` check because "Null" !== null.
        expect(isNoOpFinding({ expected: 'Null', actual: null })).toBe(true);
        expect(isNoOpFinding({ expected: 'null', actual: 'null' })).toBe(true);
        expect(isNoOpFinding({ expected: 'N/A', actual: null })).toBe(true);
        expect(isNoOpFinding({ expected: 'Unknown', actual: null })).toBe(true);
        expect(isNoOpFinding({ expected: '', actual: null })).toBe(true);
        expect(isNoOpFinding({ expected: null, actual: null })).toBe(true);
    });

    it('drops findings equal after normalization', () => {
        expect(isNoOpFinding({ expected: 'Asphalt', actual: 'asphalt' })).toBe(true);
        expect(isNoOpFinding({ expected: ' 3 ', actual: '3' })).toBe(true);
    });

    it('keeps real discrepancies', () => {
        expect(isNoOpFinding({ expected: 'Ottawa', actual: null })).toBe(false);        // real miss
        expect(isNoOpFinding({ expected: 'Steel', actual: 'PVC' })).toBe(false);          // real wrong value
        expect(isNoOpFinding({ expected: '5', actual: '8' })).toBe(false);                // wrong number
        expect(isNoOpFinding({ expected: null, actual: 'Hallucinated' })).toBe(false);    // extra_value
    });
});

describe('qaValuesEqual', () => {
    it('compares numerically and tolerates unit/format noise', () => {
        expect(qaValuesEqual('5.5', "5.5'")).toBe(true);
        expect(qaValuesEqual('3.0', '3')).toBe(true);
        expect(qaValuesEqual('5.0', '5.5')).toBe(false);
        expect(qaValuesEqual('Null', null)).toBe(true);
        expect(qaValuesEqual('0', null)).toBe(false); // page "0" vs extraction null is a real miss
    });

    it('treats yes/no-style labels as boolean synonyms against real booleans', () => {
        // The exact false-positive class reported: extraction is correctly
        // `false`, but the model transcribes a page label as "Yes"/"No" —
        // should be recognised as the same value, not a textual mismatch.
        expect(qaValuesEqual('Yes', true)).toBe(true);
        expect(qaValuesEqual('No', false)).toBe(true);
        expect(qaValuesEqual('checked', true)).toBe(true);
        expect(qaValuesEqual('unchecked', false)).toBe(true);
        expect(qaValuesEqual('x', true)).toBe(true);
        expect(qaValuesEqual(true, 'true')).toBe(true);
    });

    it('keeps a real boolean discrepancy', () => {
        expect(qaValuesEqual('Yes', false)).toBe(false);
        expect(qaValuesEqual('No', true)).toBe(false);
        expect(qaValuesEqual('checked', 'false')).toBe(false);
    });
});

describe('readFieldPath', () => {
    const rec = { a: { b: 1 }, rows: [{ x: 'sand' }, { x: null }] };
    it('resolves dotted and bracketed paths', () => {
        expect(readFieldPath(rec, 'a.b')).toBe(1);
        expect(readFieldPath(rec, 'rows[0].x')).toBe('sand');
        expect(readFieldPath(rec, 'rows[1].x')).toBe(null);
    });
    it('returns undefined for missing paths', () => {
        expect(readFieldPath(rec, 'a.z')).toBe(undefined);
        expect(readFieldPath(rec, 'rows[9].x')).toBe(undefined);
        expect(readFieldPath(null, 'a.b')).toBe(undefined);
    });
});

describe('verifyFindingAgainstRecord', () => {
    // Real fabrication cases observed across the 3 test runs on file a21300ce.
    const record = {
        lithology_intervals: [
            { depth_to_ft: 5.5, primary_material: 'sand', description_raw: 'Wet @ 5.5/E.O.B. @ 5.5\'' },
            { depth_to_ft: 7 },
        ],
        samples_collected: [{ depth_ft: 4.25 }],
        well_construction: { casing_length_ft: null, well_installed: false },
    };

    it('drops a boolean finding where the page label is a yes/no synonym of the real value', () => {
        // extraction is correctly `false`; model transcribed the page's "No" label
        // as expected="No" — same value, not a real discrepancy.
        const r = verifyFindingAgainstRecord(
            { field: 'well_construction.well_installed', issue_type: 'wrong_value', expected: 'No', actual: 'true' },
            record,
        );
        expect(r.keep).toBe(false);
    });

    it('drops fabricated actual when page already matches the true value', () => {
        // model said extraction=null but it is really "sand"; page="sand" => no discrepancy
        const r = verifyFindingAgainstRecord(
            { field: 'lithology_intervals[0].primary_material', issue_type: 'missing_value', expected: 'sand', actual: null },
            record,
        );
        expect(r.keep).toBe(false);
    });

    it('drops fabricated numeric actual (model said 5.0, real 5.5, page 5.5)', () => {
        const r = verifyFindingAgainstRecord(
            { field: 'lithology_intervals[0].depth_to_ft', issue_type: 'wrong_value', expected: '5.5', actual: '5.0' },
            record,
        );
        expect(r.keep).toBe(false);
    });

    it('keeps a genuine discrepancy and corrects actual to ground truth', () => {
        // model said extraction=null, really 4.25; page=4.5 => genuine, but actual must be fixed
        const r = verifyFindingAgainstRecord(
            { field: 'samples_collected[0].depth_ft', issue_type: 'wrong_value', expected: '4.5', actual: null },
            record,
        );
        expect(r.keep).toBe(true);
        expect(r.issue.actual).toBe('4.25');
    });

    it('keeps a real missing value (extraction null, page has a value)', () => {
        const r = verifyFindingAgainstRecord(
            { field: 'well_construction.casing_length_ft', issue_type: 'missing_value', expected: '3', actual: null },
            record,
        );
        expect(r.keep).toBe(true);
        expect(r.issue.actual).toBe(null);
    });

    it('leaves row-count issues to the no-op check (no value substitution)', () => {
        const r = verifyFindingAgainstRecord(
            { field: 'spt_intervals', issue_type: 'missing_rows', expected: '2 rows', actual: '0' },
            record,
        );
        expect(r.keep).toBe(true);
    });

    describe('corrected_value (typed answer, distinct from evidence-quote expected)', () => {
        // The exact case reported: a boring log's last row has the note "EOB =
        // 68.0 FEET" (evidence), the boolean `eob` field is really false, and
        // the correct replacement is the literal boolean true — not the
        // evidence text itself.
        const eobRecord = { lithology_intervals: [{ eob: false }] };

        it('keeps a genuine boolean mismatch when corrected_value disagrees with the real value', () => {
            const r = verifyFindingAgainstRecord(
                {
                    field: 'lithology_intervals[0].eob',
                    issue_type: 'wrong_value',
                    expected: 'EOB = 68.0 FEET',
                    actual: 'false',
                    corrected_value: true,
                },
                eobRecord,
            );
            expect(r.keep).toBe(true);
            expect(r.issue.actual).toBe('false');
        });

        it('drops the finding when corrected_value already matches the real value', () => {
            const r = verifyFindingAgainstRecord(
                {
                    field: 'lithology_intervals[0].eob',
                    issue_type: 'wrong_value',
                    expected: 'EOB = 68.0 FEET',
                    actual: 'true',
                    corrected_value: true,
                },
                { lithology_intervals: [{ eob: true }] },
            );
            expect(r.keep).toBe(false);
        });

        it('does not fall back to string-matching evidence text against the real value when corrected_value is present', () => {
            // If this used the old expected-vs-real string comparison, "EOB = 68.0
            // FEET" vs `false` would (correctly, but only by luck) not match. Prove
            // the new path takes the typed-value branch by using an evidence quote
            // that WOULD spuriously equal the real value under string comparison.
            const r = verifyFindingAgainstRecord(
                {
                    field: 'lithology_intervals[0].eob',
                    issue_type: 'wrong_value',
                    expected: 'false', // would match qaValuesEqual('false', false) — but corrected_value must win
                    actual: 'false',
                    corrected_value: true,
                },
                eobRecord,
            );
            expect(r.keep).toBe(true);
        });

        it('treats corrected_value=null as intentional for extra_value (hallucination removal)', () => {
            const record = { remarks: 'Hallucinated remark' };
            const r = verifyFindingAgainstRecord(
                { field: 'remarks', issue_type: 'extra_value', expected: null, actual: 'Hallucinated remark', corrected_value: null },
                record,
            );
            expect(r.keep).toBe(true);
        });

        it('drops extra_value when the field is already empty (nothing to remove)', () => {
            const r = verifyFindingAgainstRecord(
                { field: 'remarks', issue_type: 'extra_value', expected: null, actual: null, corrected_value: null },
                { remarks: null },
            );
            expect(r.keep).toBe(false);
        });

        it('falls back to legacy string comparison when corrected_value is omitted (older QA runs)', () => {
            const r = verifyFindingAgainstRecord(
                { field: 'lithology_intervals[0].eob', issue_type: 'wrong_value', expected: 'true', actual: 'false' },
                eobRecord,
            );
            // No corrected_value provided → legacy path: qaValuesEqual('true', false) is false, so kept.
            expect(r.keep).toBe(true);
        });
    });

    describe('structured row ops (add_row / update_row / delete_row)', () => {
        // The real case: well SAB-12's lithology_intervals row 0 was fabricated
        // from a bare depth tick with no supporting page content.
        const record = {
            lithology_intervals: [
                { depth_from_ft: 0, depth_to_ft: 10, primary_material: 'sand', description_raw: 'invented' },
                { depth_from_ft: 10, depth_to_ft: 68, primary_material: 'sand', description_raw: 'Fine brown SAND' },
            ],
        };

        it('keeps a valid delete_row and reports the deleted row as actual', () => {
            const r = verifyFindingAgainstRecord(
                { field: 'lithology_intervals', issue_type: 'delete_row', row_index: 0, row_value: null, expected: null, actual: null },
                record,
            );
            expect(r.keep).toBe(true);
            expect(JSON.parse(r.issue.actual)).toEqual(record.lithology_intervals[0]);
        });

        it('drops delete_row when row_index is out of range (hallucinated index)', () => {
            const r = verifyFindingAgainstRecord(
                { field: 'lithology_intervals', issue_type: 'delete_row', row_index: 9, row_value: null },
                record,
            );
            expect(r.keep).toBe(false);
        });

        it('drops delete_row when the target field is not actually an array', () => {
            const r = verifyFindingAgainstRecord(
                { field: 'lithology_intervals[0].primary_material', issue_type: 'delete_row', row_index: 0, row_value: null },
                record,
            );
            expect(r.keep).toBe(false);
        });

        it('keeps a valid update_row when the proposed row differs from the real one', () => {
            const r = verifyFindingAgainstRecord(
                {
                    field: 'lithology_intervals',
                    issue_type: 'update_row',
                    row_index: 1,
                    row_value: JSON.stringify({ depth_from_ft: 10, depth_to_ft: 70, primary_material: 'sand' }),
                },
                record,
            );
            expect(r.keep).toBe(true);
        });

        it('drops update_row as a no-op when the proposed row already matches the real one', () => {
            const r = verifyFindingAgainstRecord(
                {
                    field: 'lithology_intervals',
                    issue_type: 'update_row',
                    row_index: 1,
                    row_value: JSON.stringify(record.lithology_intervals[1]),
                },
                record,
            );
            expect(r.keep).toBe(false);
        });

        it('keeps a valid add_row for genuinely new content', () => {
            const r = verifyFindingAgainstRecord(
                {
                    field: 'lithology_intervals',
                    issue_type: 'add_row',
                    row_index: null,
                    row_value: JSON.stringify({ depth_from_ft: 68, depth_to_ft: 70, primary_material: 'clay' }),
                },
                record,
            );
            expect(r.keep).toBe(true);
        });

        it('drops add_row when the proposed row duplicates an existing item', () => {
            const r = verifyFindingAgainstRecord(
                {
                    field: 'lithology_intervals',
                    issue_type: 'add_row',
                    row_index: null,
                    row_value: JSON.stringify(record.lithology_intervals[0]),
                },
                record,
            );
            expect(r.keep).toBe(false);
        });

        it('drops row ops with malformed row_value JSON instead of throwing', () => {
            const r = verifyFindingAgainstRecord(
                { field: 'lithology_intervals', issue_type: 'update_row', row_index: 0, row_value: '{not json' },
                record,
            );
            expect(r.keep).toBe(false);
        });

        // Real bug found in production: a real run reported 5 fabricated rows
        // (overall_quality="poor", summary described them) but findings_count
        // was 0 — every one got silently dropped. Root cause: the model gave
        // "lithology_intervals[3]" (bracketed, like scalar findings) instead
        // of the bare array path, so the array never resolved and every
        // finding failed the isArray check.
        it('resolves the array even when the model brackets an index onto field (real production bug)', () => {
            const r = verifyFindingAgainstRecord(
                { field: 'lithology_intervals[0]', issue_type: 'delete_row', row_index: 0, row_value: null },
                record,
            );
            expect(r.keep).toBe(true);
            expect(JSON.parse(r.issue.actual)).toEqual(record.lithology_intervals[0]);
        });

        it('tolerates row_index arriving as a numeric string instead of a real integer', () => {
            const r = verifyFindingAgainstRecord(
                { field: 'lithology_intervals', issue_type: 'delete_row', row_index: '0', row_value: null },
                record,
            );
            expect(r.keep).toBe(true);
            // The coerced integer must flow through for persistence, not the raw string.
            expect(r.issue.row_index).toBe(0);
        });

        it('coerces a numeric-string row_index for add_row without dropping the finding', () => {
            const r = verifyFindingAgainstRecord(
                {
                    field: 'lithology_intervals',
                    issue_type: 'add_row',
                    row_index: '1',
                    row_value: JSON.stringify({ depth_from_ft: 68, depth_to_ft: 70, primary_material: 'clay' }),
                },
                record,
            );
            expect(r.keep).toBe(true);
            expect(r.issue.row_index).toBe(1);
        });
    });
});

// ─── Per-group QA + schema-aware verification ────────────────────────

// Mini version of the borehole_log schema, shaped like the real one
// (anyOf-nullable fields, enum on sample_type).
const MINI_SCHEMA = {
    type: 'object',
    properties: {
        samples_collected: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    sample_id: { type: 'string' },
                    sample_type: {
                        type: 'string',
                        enum: ['mw_groundwater', 'vas_collection', 'soil_split_spoon', 'soil_shelby', 'soil_grab', 'rock_core', 'unknown'],
                    },
                    depth_ft: { type: 'number' },
                },
                required: ['sample_id', 'sample_type', 'depth_ft'],
                additionalProperties: false,
            },
        },
        drilling_and_personnel: {
            type: 'object',
            properties: {
                drilling_method: {
                    anyOf: [
                        { type: 'string', enum: ['hollow_stem_auger', 'direct_push', 'rotary', 'unknown'] },
                        { type: 'null' },
                    ],
                },
            },
        },
        remarks: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
};

describe('splitSchemaIntoGroups', () => {
    it('returns one group per top-level property with its sub-schema', () => {
        const groups = splitSchemaIntoGroups(MINI_SCHEMA);
        expect(groups.map((g) => g.name)).toEqual(['samples_collected', 'drilling_and_personnel', 'remarks']);
        expect(groups[0].schema.items.properties.sample_type.enum).toContain('mw_groundwater');
    });

    it('parses a JSON string and tolerates missing/invalid schemas', () => {
        expect(splitSchemaIntoGroups(JSON.stringify(MINI_SCHEMA)).length).toBe(3);
        expect(splitSchemaIntoGroups(null)).toEqual([]);
        expect(splitSchemaIntoGroups('not json')).toEqual([]);
        expect(splitSchemaIntoGroups({})).toEqual([]);
    });
});

describe('resolveSchemaForPath / extractEnumValues', () => {
    it('resolves array-item fields through bracket paths', () => {
        const s = resolveSchemaForPath(MINI_SCHEMA, 'samples_collected[0].sample_type');
        expect(extractEnumValues(s)).toContain('vas_collection');
    });

    it('unwraps anyOf-nullable enum fields (the schema convention for optional enums)', () => {
        const s = resolveSchemaForPath(MINI_SCHEMA, 'drilling_and_personnel.drilling_method');
        expect(extractEnumValues(s)).toContain('hollow_stem_auger');
    });

    it('returns null enum for non-enum fields and unresolvable paths', () => {
        expect(extractEnumValues(resolveSchemaForPath(MINI_SCHEMA, 'samples_collected[0].depth_ft'))).toBe(null);
        expect(resolveSchemaForPath(MINI_SCHEMA, 'nonexistent.path')).toBe(null);
        expect(resolveSchemaForPath(null, 'a.b')).toBe(null);
    });
});

describe('coerceToEnum', () => {
    const enums = ['hollow_stem_auger', 'direct_push', 'unknown'];
    it('passes through exact enum members', () => {
        expect(coerceToEnum('direct_push', enums)).toBe('direct_push');
    });
    it('rescues label-style near-misses via normalization', () => {
        expect(coerceToEnum('Hollow Stem Auger', enums)).toBe('hollow_stem_auger');
    });
    it('returns null for values with no legal match (never invents)', () => {
        expect(coerceToEnum('water sample', enums)).toBe(null);
        expect(coerceToEnum(null, enums)).toBe(null);
    });
});

describe('enum backstop in verifyFindingAgainstRecord', () => {
    // The exact reported case: sample_type extracted as "unknown", page shows
    // "Water sample 25-30'", model proposed corrected_value="water sample" —
    // which is NOT in the enum. The correction must be stripped (finding kept:
    // the discrepancy itself may be real), never surfaced as applicable.
    const record = { samples_collected: [{ sample_id: 'S-1', sample_type: 'unknown', depth_ft: 25 }] };

    it('strips an illegal enum correction but keeps the finding (real production bug)', () => {
        const r = verifyFindingAgainstRecord(
            {
                field: 'samples_collected[0].sample_type',
                issue_type: 'wrong_value',
                expected: "Water sample 25-30'",
                actual: 'unknown',
                corrected_value: 'water sample',
            },
            record,
            MINI_SCHEMA,
        );
        expect(r.keep).toBe(true);
        expect(r.issue.corrected_value).toBe(null);
    });

    it('normalizes a rescuable enum correction instead of stripping it', () => {
        const rec = { drilling_and_personnel: { drilling_method: 'unknown' } };
        const r = verifyFindingAgainstRecord(
            {
                field: 'drilling_and_personnel.drilling_method',
                issue_type: 'wrong_value',
                expected: 'Hollow Stem Auger',
                actual: 'unknown',
                corrected_value: 'Hollow Stem Auger',
            },
            rec,
            MINI_SCHEMA,
        );
        expect(r.keep).toBe(true);
        expect(r.issue.corrected_value).toBe('hollow_stem_auger');
    });

    it('leaves non-enum fields untouched by the backstop', () => {
        const rec = { samples_collected: [{ sample_id: 'S-1', sample_type: 'unknown', depth_ft: 25 }] };
        const r = verifyFindingAgainstRecord(
            { field: 'samples_collected[0].depth_ft', issue_type: 'wrong_value', expected: '30', actual: '25', corrected_value: 30 },
            rec,
            MINI_SCHEMA,
        );
        expect(r.keep).toBe(true);
        expect(r.issue.corrected_value).toBe(30);
    });

    it('strips unknown keys from row_value against the item schema', () => {
        const rec = { samples_collected: [{ sample_id: 'S-1', sample_type: 'unknown', depth_ft: 25 }] };
        const r = verifyFindingAgainstRecord(
            {
                field: 'samples_collected',
                issue_type: 'add_row',
                row_index: null,
                row_value: JSON.stringify({ sample_id: 'S-2', sample_type: 'soil_grab', depth_ft: 30, hallucinated_field: 'x' }),
            },
            rec,
            MINI_SCHEMA,
        );
        expect(r.keep).toBe(true);
        const cleaned = JSON.parse(r.issue.row_value);
        expect(cleaned).toEqual({ sample_id: 'S-2', sample_type: 'soil_grab', depth_ft: 30 });
    });
});

describe('deriveQualityFromFindings / buildFindingsSummary', () => {
    it('derives quality from verified findings, not model self-report', () => {
        expect(deriveQualityFromFindings([])).toBe('perfect');
        expect(deriveQualityFromFindings([{ severity: 'info' }, { severity: 'warning' }])).toBe('good');
        expect(deriveQualityFromFindings([{ severity: 'error' }, { severity: 'error' }])).toBe('acceptable');
        expect(deriveQualityFromFindings([{ severity: 'error' }, { severity: 'error' }, { severity: 'error' }])).toBe('poor');
    });

    it('summarizes by group', () => {
        expect(buildFindingsSummary([])).toBe('No issues found.');
        const s = buildFindingsSummary([
            { _group: 'lithology_intervals', field: 'lithology_intervals', severity: 'error' },
            { _group: 'lithology_intervals', field: 'lithology_intervals[1].depth_to_ft', severity: 'error' },
            { field: 'samples_collected[0].sample_type', severity: 'warning' },
        ]);
        expect(s).toContain('3 issue(s)');
        expect(s).toContain('lithology_intervals (2)');
        expect(s).toContain('samples_collected (1)');
    });
});

describe('per-group QA prompts (prompt-caching layout)', () => {
    it('system prompt is generic — no group-specific content, so the cache prefix is identical across calls', () => {
        const prompt = buildGroupQACachedSystemPrompt(2);
        expect(prompt).toContain('corrected_value MUST be EXACTLY one of the enum values');
        expect(prompt).toContain('BARE array path');
        expect(prompt).toContain('Boolean representation');
        // The one thing it must NOT contain: any per-call group name/schema.
        // (It does contain a STATIC worked enum example — that's fine, static
        // text is identical across calls and doesn't break cache identity.)
        expect(prompt).not.toContain('samples_collected');
        expect(prompt).not.toContain('REVIEW THIS GROUP NOW');
        // Same pageCount → byte-identical output (the cacheability invariant).
        expect(buildGroupQACachedSystemPrompt(2)).toBe(prompt);
    });

    it('shared user text carries the full record and is group-agnostic', () => {
        const record = { samples_collected: [{ sample_id: 'S-1' }], remarks: 'ctx' };
        const text = buildGroupQASharedUserText(record, [209, 210]);
        expect(text).toContain('pages 209, 210');
        expect(text).toContain('"remarks": "ctx"');
        // Identical output for the same record regardless of which group is
        // being reviewed — that identity is what makes the prefix cacheable.
        expect(buildGroupQASharedUserText(record, [209, 210])).toBe(text);
        expect(text).not.toContain('REVIEW THIS GROUP');
    });

    it('group instruction (the trailing, uncached part) carries schema, enums, data, and hints', () => {
        const instruction = buildGroupQAGroupInstruction({
            groupName: 'samples_collected',
            groupSchema: MINI_SCHEMA.properties.samples_collected,
            groupValue: [{ sample_id: 'S-1' }],
            hint: { priority: 'high', notes: 'sample_id links to lab results.' },
        });
        expect(instruction).toContain('REVIEW THIS GROUP NOW: "samples_collected"');
        expect(instruction).toContain('"mw_groundwater"');
        expect(instruction).toContain('"vas_collection"');
        expect(instruction).toContain('Field paths in your findings MUST start with "samples_collected"');
        expect(instruction).toContain('BARE path "samples_collected"');
        expect(instruction).toContain('Review priority for this group: high');
        expect(instruction).toContain('sample_id links to lab results.');
    });

    it('reports "null (not extracted)" when the group is absent from the record', () => {
        const instruction = buildGroupQAGroupInstruction({
            groupName: 'spt_intervals',
            groupSchema: { type: 'array' },
            groupValue: undefined,
            hint: null,
        });
        expect(instruction).toContain('null (not extracted)');
    });

    it('group response format is a strict issues list (no groups wrapper)', () => {
        const format = buildGroupQAResponseFormat();
        const schema = format.json_schema.schema;
        expect(schema.required).toEqual(['summary', 'issues']);
        expect(schema.properties.issues.items.properties.issue_type.enum).toContain('delete_row');
    });
});

// ── partitionGroupsForBatching (cost lever: fewer prefix-sends) ────────────
describe('partitionGroupsForBatching', () => {
    const g = (name) => ({ name, schema: { type: 'array' } });
    const groups = ['lith', 'samples', 'spt', 'remarks', 'meta'].map(g);

    it('disabled → one unit per group (existing behavior)', () => {
        const units = partitionGroupsForBatching(groups, {}, { enabled: false });
        expect(units).toHaveLength(5);
        expect(units.every((u) => u.groups.length === 1)).toBe(true);
    });

    it('enabled → critical/high stay solo, the rest batch together', () => {
        const hints = { lith: { priority: 'critical' }, samples: { priority: 'high' }, spt: { priority: 'normal' } };
        const units = partitionGroupsForBatching(groups, hints, { enabled: true });
        expect(units.map((u) => u.groups.map((x) => x.name))).toEqual([
            ['lith'], ['samples'], ['spt', 'remarks', 'meta'],
        ]);
    });

    it('enabled → respects maxPerBatch chunking', () => {
        const units = partitionGroupsForBatching(groups, {}, { enabled: true, maxPerBatch: 2 });
        expect(units.map((u) => u.groups.map((x) => x.name))).toEqual([
            ['lith', 'samples'], ['spt', 'remarks'], ['meta'],
        ]);
    });

    it('enabled with all-high hints degrades to per-group calls', () => {
        const hints = Object.fromEntries(groups.map((x) => [x.name, { priority: 'high' }]));
        const units = partitionGroupsForBatching(groups, hints, { enabled: true });
        expect(units).toHaveLength(5);
    });
});
