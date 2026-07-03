/**
 * Depth refinement — a focused second-pass reconciliation between extracted
 * rows and the depths measured from document geometry (depthGeometryService).
 *
 * Why this exists: injecting measured depths into the EXTRACTION prompt made
 * the extraction model misread them under load (one-interval-per-line,
 * depth-as-bottom, frame-fitting — see DEPTH_GEOMETRY_HANDOFF.md). Extraction
 * already gets the STRUCTURE right on its own; only the numbers are
 * approximate (rounded to the ruler's 5-ft gridlines) with occasional
 * merged/duplicated layers. So instead of hints-at-extraction-time, we run a
 * small second call AFTER extraction: the refiner sees the extracted rows and
 * the measured evidence, and proposes a minimal set of correction OPERATIONS.
 * Code — not the model — applies the ops and enforces invariants.
 *
 * Safety model (fail open at every layer):
 *  - refiner errors / no evidence / no rows  → original rows untouched
 *  - ops that fail validation (bad index, conflicts, missing identity
 *    fields)                                  → ALL ops discarded, original kept
 *  - refined rows that violate invariants (non-monotonic tops, out of
 *    range, lost sample ids)                  → ALL ops discarded, original kept
 *  - an empty ops list is a valid, expected refiner answer
 *
 * Index semantics (the subtle bit): every `row` in an op refers to the row's
 * position in the ORIGINAL array exactly as numbered in the prompt. Apply is
 * plan-then-mutate — ops never see each other's effects, so a delete of row 3
 * followed by set_depth on row 4 still targets the original row 4. New rows
 * carry their own depth and are placed by sorting on it, never by index.
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import type { DepthGeometry } from './depthGeometryService.ts';
import { buildDocumentExtractionResponseFormat } from '../config/openaiPrompts.ts';

dotenv.config();

// ── types ───────────────────────────────────────────────────────────────────

export interface RefinementOp {
    op: 'set_top' | 'set_depth' | 'add_row' | 'delete_row' | 'merge_rows';
    row: number | null;
    rows: number[] | null;
    depth_ft: number | null;
    evidence: string;
    item: Record<string, unknown> | null;
}

export interface RefinementReport {
    group: string;
    path: string;
    status: 'refined' | 'no_ops' | 'skipped' | 'rejected' | 'error';
    ops_proposed: number;
    ops_applied: number;
    changes: string[];
    reason?: string;
    model?: string;
}

interface GroupConfig {
    /** field holding the row's authoritative depth (its top, for intervals) */
    depthField: string;
    /** interval bottoms exist and must be recomputed from the next row's top */
    recomputeBottoms: boolean;
    bottomField?: string;
    /** boolean field marking the end-of-boring row (from == to, stays last) */
    eobField?: string;
    /** ops the refiner may propose for this group */
    allowedOps: RefinementOp['op'][];
    /** fields an add_row item must carry to be applied */
    identityFields: string[];
    /** render the measured evidence block; '' skips refinement */
    renderEvidence: (geometry: DepthGeometry) => string;
    /** group-specific instruction lines appended to the shared ones */
    instructions: string[];
}

// Extensible registry: to refine another group in the future, add its config
// here — the walker, apply logic, and invariant gate are group-agnostic.
const GROUPS: Record<string, GroupConfig> = {
    lithology_intervals: {
        depthField: 'depth_from_ft',
        recomputeBottoms: true,
        bottomField: 'depth_to_ft',
        eobField: 'eob',
        allowedOps: ['set_top', 'add_row', 'delete_row', 'merge_rows'],
        identityFields: ['description_raw', 'depth_from_ft'],
        renderEvidence: (g) => {
            if (!g.lithologyLines?.length) return '';
            let out =
                'Lines of MATERIAL DESCRIPTION text with the TRUE measured depth at which each line ' +
                'STARTS on the depth ruler (a layer\'s first line starts at that layer\'s top):\n';
            for (const l of g.lithologyLines) out += `- (page ${l.page}) ${l.depth} ft: ${l.text}\n`;
            if (g.contacts?.length) {
                out += 'Measured positions of USCS group symbols printed in the descriptions:\n';
                for (const c of g.contacts) out += `- (${c.code}) at ${c.top} ft (page ${c.page})\n`;
            }
            return out;
        },
        instructions: [
            'set_top corrects a layer\'s TOP depth (depth_from_ft). Bottoms are recomputed automatically ' +
            'from the next layer\'s top — NEVER propose an op to fix depth_to_ft.',
            'One row = one MATERIAL, not one line of text. A row whose description merely continues the ' +
            'previous row\'s sentence (wrapped text, added detail, "(Roadway Fill)", "fragments") is NOT ' +
            'its own layer → merge_rows with the row it continues (first row survives, texts join). ' +
            'Setting a top on such a row is wrong — merge it instead.',
            'A layer marked "(continued)" on a later page is the SAME layer; if it was extracted as an ' +
            'extra row, delete_row the duplicate.',
            'If the evidence shows a distinct material that no row has AS ITS OWN LAYER, add_row it — ' +
            'INCLUDING when its text was absorbed into another row\'s description (e.g. surfacing/pavement/' +
            'aggregate base absorbed into the first soil layer\'s description). In that case add_row the ' +
            'absorbed material starting at the absorbing row\'s current top, and set_top the absorbing row ' +
            'to the measured depth of ITS OWN material (the evidence line matching its main description). ' +
            'Set item fields you cannot know to null.',
            'Evidence lines that are notes, legends, water-level remarks, or bare depth ranges are NOT ' +
            'materials: never set a boundary at one and never add a row for one. EXCEPTION: the bottom-of-' +
            'hole / end-of-boring line is not a material but MUST exist as the final row (eob=true, ' +
            'depth_from = depth_to = the depth its own text states) — add_row it if extraction omitted it.',
            'When a row\'s own text states its depth explicitly (e.g. "Bottom of hole at 45.5 feet"), that ' +
            'stated number is authoritative over a nearby measured value.',
        ],
    },
    samples_collected: {
        depthField: 'depth_ft',
        recomputeBottoms: false,
        allowedOps: ['set_depth', 'add_row', 'delete_row'],
        identityFields: ['sample_id', 'depth_ft'],
        renderEvidence: (g) => {
            if (!g.samples?.length) return '';
            let out = 'Sample/test depths measured from the depth ruler (complete, in document order):\n';
            for (const s of g.samples) out += `- sample "${s.id}" (page ${s.page}): ${s.depth} ft\n`;
            return out;
        },
        instructions: [
            'The measured sample list is COMPLETE and authoritative: after your ops, there must be exactly ' +
            'one row per measured sample. This overrides minimality — a missing sample is an error to fix, ' +
            'not a judgment call.',
            'Match rows to measured samples by sample_id (when the same id appears more than once, match ' +
            'in document order) and set_depth each matched row to the measured value.',
            'For every measured sample with NO matching row (dropped by extraction) → add_row with the ' +
            'full item: its exact sample_id, its measured depth_ft, fields you cannot know = null. ' +
            'A row duplicating another row\'s sample → delete_row the duplicate.',
            'Never change a sample_id, and never use sample depths for anything but that sample\'s row.',
        ],
    },
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEFAULT_REFINER_MODEL = 'gpt-4.1';

// ── prompt + response schema ────────────────────────────────────────────────

/** Fields of a row worth showing the refiner (keeps the prompt small). */
const PROMPT_FIELDS: Record<string, string[]> = {
    lithology_intervals: ['depth_from_ft', 'depth_to_ft', 'description_raw', 'uscs_symbol', 'eob'],
    samples_collected: ['sample_id', 'depth_ft', 'sample_type'],
};

function renderRows(group: string, rows: Record<string, unknown>[]): string {
    const fields = PROMPT_FIELDS[group];
    return rows
        .map((r, i) => {
            const slim: Record<string, unknown> = {};
            for (const f of fields || Object.keys(r)) if (f in r) slim[f] = r[f];
            return `row ${i}: ${JSON.stringify(slim)}`;
        })
        .join('\n');
}

const OP_LEGEND: Record<string, string> = {
    set_top: 'set_top {row, depth_ft}: correct one row\'s top depth',
    set_depth: 'set_depth {row, depth_ft}: correct one row\'s depth',
    delete_row: 'delete_row {row}: remove a duplicate row',
    merge_rows: 'merge_rows {rows: [consecutive…]}: rows that are ONE entity — first survives, texts join',
    add_row: 'add_row {item}: add a row extraction missed (item = the full row object)',
};

function buildPrompt(
    group: string,
    cfg: GroupConfig,
    rows: Record<string, unknown>[],
    evidence: string,
    addRowAvailable: boolean
): string {
    const ops = cfg.allowedOps.filter((o) => o !== 'add_row' || addRowAvailable);
    return (
        `GROUP: ${group}\n\n` +
        'EXTRACTED ROWS (row numbers are PERMANENT identifiers into this exact list — every operation ' +
        'references these numbers, regardless of other operations):\n' +
        `${renderRows(group, rows)}\n\n` +
        `MEASURED EVIDENCE (from the document's depth-ruler geometry):\n${evidence}\n` +
        `AVAILABLE OPERATIONS:\n${ops.map((o) => `- ${OP_LEGEND[o]}\n`).join('')}\n` +
        'INSTRUCTIONS:\n' +
        '- The rows were extracted from a document whose depth layout may or may not have survived ' +
        'conversion to text: depths can be exact, or rounded to the ruler\'s gridlines, and boundaries ' +
        'can be correct, or occasionally merged/split/duplicated. Compare against the evidence before ' +
        'acting; if the rows already agree with the evidence, propose NO operations. An empty ops list ' +
        'is a valid and common answer.\n' +
        '- Match evidence to rows by TEXT, never by depth value alone.\n' +
        cfg.instructions.map((l) => `- ${l}\n`).join('') +
        '- Every operation must quote, in "evidence", the measured line that justifies it.\n' +
        '- Set every op field you are not using to null.\n'
    );
}

const REFINER_SYSTEM_PROMPT =
    'You are a data-refinement engine for extracted geotechnical documents. You compare rows extracted ' +
    'by another model against measurements taken from the document\'s geometry and propose the MINIMAL ' +
    'set of correction operations. You only propose an operation the measurements clearly support; when ' +
    'in doubt, propose nothing — an unnecessary operation is worse than no operation.';

/**
 * Locate the JSON-schema fragment for a group's array items anywhere inside
 * the job schema (the group's path in the schema mirrors its path in the
 * data). Returns null when not found — add_row is then rejected by the gate.
 */
export function findGroupItemSchema(schema: unknown, group: string, depth = 0): Record<string, unknown> | null {
    if (!schema || typeof schema !== 'object' || depth > 14) return null;
    const s = schema as Record<string, any>;
    const direct = s.properties?.[group];
    if (direct?.type === 'array' && direct.items && typeof direct.items === 'object') return direct.items;
    // generic descent — job schemas arrive in varying envelopes ({schema:…},
    // {schemaName, schema}, raw), so walk every object value, bounded by depth
    for (const v of Object.values(s)) {
        if (v && typeof v === 'object') {
            const hit = findGroupItemSchema(v, group, depth + 1);
            if (hit) return hit;
        }
    }
    return null;
}

/**
 * Job schemas are stored in the builder-field format, not as JSON schema —
 * the JSON schema is derived at extraction time. Derive it the same way
 * (buildDocumentExtractionResponseFormat) and search THAT for the group's
 * item schema; fall back to searching the raw input for callers that already
 * hold a JSON schema. Never throws — null just disables add_row.
 */
export function resolveGroupItemSchema(schemaData: unknown, group: string): Record<string, unknown> | null {
    try {
        const derived = buildDocumentExtractionResponseFormat(schemaData) as { json_schema?: { schema?: unknown } };
        const hit = findGroupItemSchema(derived?.json_schema?.schema, group);
        if (hit) return hit;
    } catch {
        // fall through to raw search
    }
    return findGroupItemSchema(schemaData, group);
}

/**
 * Strict structured-output schema for the ops envelope: an anyOf of per-op
 * shapes, so every op type carries EXACTLY its required fields — a set_top
 * cannot arrive without a depth, an add_row cannot arrive without an item.
 * add_row is only offered at all when the group's item schema was resolved.
 */
function buildOpsResponseFormat(cfg: GroupConfig, itemSchema: Record<string, unknown> | null) {
    const shape = (props: Record<string, unknown>) => ({
        type: 'object',
        additionalProperties: false,
        required: Object.keys(props),
        properties: props,
    });
    const opEnum = (name: string) => ({ type: 'string', enum: [name] });
    const variants: Record<string, unknown>[] = [];
    for (const op of cfg.allowedOps) {
        if (op === 'set_top' || op === 'set_depth') {
            variants.push(shape({ op: opEnum(op), row: { type: 'integer' }, depth_ft: { type: 'number' }, evidence: { type: 'string' } }));
        } else if (op === 'delete_row') {
            variants.push(shape({ op: opEnum(op), row: { type: 'integer' }, evidence: { type: 'string' } }));
        } else if (op === 'merge_rows') {
            variants.push(shape({ op: opEnum(op), rows: { type: 'array', items: { type: 'integer' } }, evidence: { type: 'string' } }));
        } else if (op === 'add_row' && itemSchema) {
            variants.push(shape({ op: opEnum(op), item: itemSchema, evidence: { type: 'string' } }));
        }
    }
    return {
        type: 'json_schema' as const,
        json_schema: {
            name: 'depth_refinement_ops',
            strict: true,
            schema: shape({ ops: { type: 'array', items: { anyOf: variants } } }),
        },
    };
}

// ── deterministic apply ─────────────────────────────────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate ops against the ORIGINAL rows (plan phase). Throws with a reason
 * on the first violation — the caller discards all ops (fail open).
 */
function validateOps(cfg: GroupConfig, ops: RefinementOp[], rowCount: number): void {
    // original index → claim kinds; a depth-set may coexist with being a
    // merge SURVIVOR (fix the top AND absorb the rows below), nothing else
    const claimed = new Map<number, { kinds: Set<string>; ops: string[] }>();
    const compatible = (kinds: Set<string>): boolean =>
        kinds.size === 1 || (kinds.size === 2 && kinds.has('set') && kinds.has('survivor'));
    const claim = (idx: number, op: string, kind: 'set' | 'survivor' | 'exclusive'): void => {
        const entry = claimed.get(idx) || { kinds: new Set<string>(), ops: [] };
        entry.kinds.add(kind);
        entry.ops.push(op);
        claimed.set(idx, entry);
        if (!compatible(entry.kinds)) {
            throw new Error(`row ${idx} targeted by both ${entry.ops[0]} and ${op}`);
        }
    };
    const inRange = (idx: unknown, op: string): number => {
        if (!isNum(idx) || !Number.isInteger(idx) || idx < 0 || idx >= rowCount) {
            throw new Error(`${op} references row ${idx} outside 0..${rowCount - 1}`);
        }
        return idx;
    };

    for (const o of ops) {
        if (!cfg.allowedOps.includes(o.op)) throw new Error(`op ${o.op} not allowed for this group`);
        switch (o.op) {
            case 'set_top':
            case 'set_depth': {
                const idx = inRange(o.row, o.op);
                if (!isNum(o.depth_ft)) throw new Error(`${o.op} on row ${idx} without a numeric depth_ft`);
                claim(idx, o.op, 'set');
                break;
            }
            case 'delete_row':
                claim(inRange(o.row, o.op), o.op, 'exclusive');
                break;
            case 'merge_rows': {
                if (!Array.isArray(o.rows) || o.rows.length < 2) {
                    throw new Error('merge_rows needs at least 2 rows');
                }
                const sorted = o.rows.map((r) => inRange(r, 'merge_rows')).sort((a, b) => a - b);
                for (let i = 1; i < sorted.length; i++) {
                    if (sorted[i] !== sorted[i - 1] + 1) throw new Error('merge_rows rows must be consecutive');
                }
                // survivor (first row) may also carry a set_top/set_depth; absorbed rows may not
                sorted.forEach((idx, i) => claim(idx, 'merge_rows', i === 0 ? 'survivor' : 'exclusive'));
                break;
            }
            case 'add_row': {
                if (!o.item || typeof o.item !== 'object') throw new Error('add_row without an item');
                for (const f of cfg.identityFields) {
                    const v = (o.item as Record<string, unknown>)[f];
                    if (v == null || v === '') throw new Error(`add_row item missing identity field ${f}`);
                }
                break;
            }
        }
    }
}

/**
 * Apply validated ops to the rows. Pure: returns new rows + human-readable
 * change log. All op indices are ORIGINAL indices (plan-then-mutate).
 */
export function applyOps(
    group: string,
    rows: Record<string, unknown>[],
    ops: RefinementOp[]
): { rows: Record<string, unknown>[]; changes: string[] } {
    const cfg = GROUPS[group];
    if (!cfg) throw new Error(`unknown group ${group}`);
    validateOps(cfg, ops, rows.length);

    const changes: string[] = [];
    // decorate with original index so every phase resolves against it
    const work: ({ orig: number; row: Record<string, unknown> } | null)[] = rows.map((r, i) => ({
        orig: i,
        row: { ...r },
    }));
    const byOrig = (idx: number) => work[idx]!; // validated in range, not yet removed

    // 1. depth corrections
    for (const o of ops) {
        if (o.op !== 'set_top' && o.op !== 'set_depth') continue;
        const t = byOrig(o.row!);
        const before = t.row[cfg.depthField];
        t.row[cfg.depthField] = o.depth_ft;
        changes.push(`${o.op} row ${o.row}: ${cfg.depthField} ${before} → ${o.depth_ft}`);
    }

    // 2. merges — survivor keeps its fields, descriptions concatenate
    for (const o of ops) {
        if (o.op !== 'merge_rows') continue;
        const sorted = [...o.rows!].sort((a, b) => a - b);
        const survivor = byOrig(sorted[0]);
        for (const idx of sorted.slice(1)) {
            const absorbed = byOrig(idx);
            const a = survivor.row.description_raw;
            const b = absorbed.row.description_raw;
            if (typeof a === 'string' && typeof b === 'string' && b.trim()) {
                survivor.row.description_raw = `${a.trim()} ${b.trim()}`;
            }
            work[idx] = null;
        }
        changes.push(`merge_rows ${sorted.join(',')} → row ${sorted[0]}`);
    }

    // 3. deletes
    for (const o of ops) {
        if (o.op !== 'delete_row') continue;
        work[o.row!] = null;
        changes.push(`delete_row ${o.row}`);
    }

    // 4. adds — shape the item onto the group's row template (union of keys),
    // so sparse items still produce fully-shaped rows
    const template: Record<string, unknown> = {};
    for (const r of rows) for (const k of Object.keys(r)) if (!(k in template)) template[k] = null;
    const addedRows: Record<string, unknown>[] = [];
    for (const o of ops) {
        if (o.op !== 'add_row') continue;
        const row = { ...template, ...o.item };
        addedRows.push(row);
        changes.push(`add_row ${cfg.depthField}=${row[cfg.depthField]}`);
    }

    // 5. ordering. Intervals sort by top depth (bottom recomputation depends
    // on it; corrected tops make the sort reliable, and the invariant gate
    // rejects any non-monotonic outcome). Point rows (samples) KEEP document
    // order — uncorrected depths may be stale, so re-sorting on them would
    // scramble the list; added rows slot in by depth instead.
    const alive = work.filter((w): w is NonNullable<typeof w> => w != null);
    let result: Record<string, unknown>[];
    if (cfg.recomputeBottoms) {
        const all = [
            ...alive.map((w) => ({ orig: w.orig, row: w.row })),
            ...addedRows.map((row, i) => ({ orig: rows.length + i, row })),
        ];
        all.sort((a, b) => {
            const aEob = cfg.eobField && a.row[cfg.eobField] === true;
            const bEob = cfg.eobField && b.row[cfg.eobField] === true;
            if (aEob !== bEob) return aEob ? 1 : -1;
            const ad = a.row[cfg.depthField];
            const bd = b.row[cfg.depthField];
            if (isNum(ad) && isNum(bd) && ad !== bd) return ad - bd;
            return a.orig - b.orig;
        });
        result = all.map((w) => w.row);
    } else {
        result = alive.map((w) => w.row);
        for (const row of addedRows) {
            const d = row[cfg.depthField];
            const at = isNum(d) ? result.findIndex((r) => isNum(r[cfg.depthField]) && (r[cfg.depthField] as number) > d) : -1;
            if (at === -1) result.push(row);
            else result.splice(at, 0, row);
        }
    }

    // 6. recompute interval bottoms mechanically: each layer runs to the next
    // layer's top; the last material layer runs to the EOB row's depth
    if (cfg.recomputeBottoms && cfg.bottomField) {
        for (let i = 0; i < result.length; i++) {
            const isEob = cfg.eobField && result[i][cfg.eobField] === true;
            const next = result[i + 1];
            if (isEob) {
                if (isNum(result[i][cfg.depthField])) result[i][cfg.bottomField] = result[i][cfg.depthField];
            } else if (next && isNum(next[cfg.depthField])) {
                result[i][cfg.bottomField] = next[cfg.depthField];
            }
        }
    }

    return { rows: result, changes };
}

// ── invariant gate ──────────────────────────────────────────────────────────

/** Post-apply sanity check. Throws with a reason on violation (fail open). */
export function checkInvariants(
    group: string,
    original: Record<string, unknown>[],
    refined: Record<string, unknown>[],
    ops: RefinementOp[]
): void {
    const cfg = GROUPS[group];
    const depths = refined
        .filter((r) => !(cfg.eobField && r[cfg.eobField] === true))
        .map((r) => r[cfg.depthField])
        .filter(isNum);
    for (const d of depths) {
        if (d < 0 || d > 20000) throw new Error(`depth ${d} out of range`);
    }
    if (cfg.recomputeBottoms) {
        for (let i = 1; i < depths.length; i++) {
            if (depths[i] <= depths[i - 1]) {
                throw new Error(`tops not strictly increasing (${depths[i - 1]} → ${depths[i]})`);
            }
        }
    }
    if (group === 'samples_collected') {
        // every original id must survive unless a delete_row explicitly targeted it
        const deleted = new Set(ops.filter((o) => o.op === 'delete_row').map((o) => o.row));
        const surviving = new Set(refined.map((r) => r.sample_id).filter(Boolean));
        original.forEach((r, i) => {
            if (r.sample_id && !deleted.has(i) && !surviving.has(r.sample_id)) {
                throw new Error(`sample id ${r.sample_id} lost without an explicit delete`);
            }
        });
    }
}

// ── orchestration ───────────────────────────────────────────────────────────

/**
 * Refine one group's rows against the measured geometry. Never throws: every
 * failure path returns the ORIGINAL rows with a report explaining why.
 */
export async function refineGroup(args: {
    group: string;
    rows: Record<string, unknown>[];
    geometry: DepthGeometry;
    schema?: unknown;
    model?: string;
    path?: string;
}): Promise<{ rows: Record<string, unknown>[]; report: RefinementReport }> {
    const { group, rows, geometry, schema, path = group } = args;
    const cfg = GROUPS[group];
    const base: RefinementReport = { group, path, status: 'skipped', ops_proposed: 0, ops_applied: 0, changes: [] };
    if (!cfg || !Array.isArray(rows) || rows.length === 0) {
        return { rows, report: { ...base, reason: 'no rows or unsupported group' } };
    }
    const evidence = cfg.renderEvidence(geometry);
    if (!evidence) return { rows, report: { ...base, reason: 'no measured evidence for this group' } };

    const model = args.model || DEFAULT_REFINER_MODEL;
    const itemSchema = schema ? resolveGroupItemSchema(schema, group) : null;

    let ops: RefinementOp[];
    try {
        const response = await openai.chat.completions.create({
            model,
            temperature: 0,
            messages: [
                { role: 'system', content: REFINER_SYSTEM_PROMPT },
                { role: 'user', content: buildPrompt(group, cfg, rows, evidence, itemSchema != null) },
            ],
            response_format: buildOpsResponseFormat(cfg, itemSchema),
        });
        const content = response.choices?.[0]?.message?.content;
        ops = (JSON.parse(content || '{}').ops || []) as RefinementOp[];
        // per-op anyOf shapes omit unused fields — normalize for applyOps
        ops = ops.map((o) => ({ row: null, rows: null, depth_ft: null, item: null, ...(o as Partial<RefinementOp>) } as RefinementOp));
    } catch (err: any) {
        console.warn(`⚠️ depth refinement (${path}): refiner call failed — keeping original rows: ${err?.message}`);
        return { rows, report: { ...base, status: 'error', reason: err?.message, model } };
    }

    if (ops.length === 0) {
        return { rows, report: { ...base, status: 'no_ops', model } };
    }

    try {
        const { rows: refined, changes } = applyOps(group, rows, ops);
        checkInvariants(group, rows, refined, ops);
        console.log(`📐 depth refinement (${path}): applied ${ops.length} op(s) — ${changes.join('; ')}`);
        return {
            rows: refined,
            report: { ...base, status: 'refined', ops_proposed: ops.length, ops_applied: ops.length, changes, model },
        };
    } catch (err: any) {
        console.warn(
            `⚠️ depth refinement (${path}): ops rejected (${err?.message}) — keeping original rows. ` +
            `Proposed: ${JSON.stringify(ops)}`
        );
        return {
            rows,
            report: { ...base, status: 'rejected', ops_proposed: ops.length, reason: err?.message, model },
        };
    }
}

/**
 * Walk an extraction result, refining every supported group found against the
 * (already page-scoped) geometry. Mutates `data` in place; returns the
 * per-group reports for persistence in extraction_metadata.
 */
export async function refineExtractionData(args: {
    data: unknown;
    geometry: DepthGeometry | null | undefined;
    schema?: unknown;
    model?: string;
}): Promise<RefinementReport[]> {
    const { data, geometry, schema, model } = args;
    if (!geometry || !data || typeof data !== 'object') return [];

    // collect host objects first so refinement never re-visits its own edits
    const hosts: { host: Record<string, unknown>; group: string; path: string }[] = [];
    const walk = (node: unknown, path: string, depth: number): void => {
        if (!node || typeof node !== 'object' || depth > 8) return;
        if (Array.isArray(node)) {
            node.forEach((el, i) => walk(el, `${path}[${i}]`, depth + 1));
            return;
        }
        const obj = node as Record<string, unknown>;
        for (const group of Object.keys(GROUPS)) {
            if (Array.isArray(obj[group]) && (obj[group] as unknown[]).length > 0) {
                hosts.push({ host: obj, group, path: path ? `${path}.${group}` : group });
            }
        }
        for (const [k, v] of Object.entries(obj)) {
            if (!(k in GROUPS)) walk(v, path ? `${path}.${k}` : k, depth + 1);
        }
    };
    walk(data, '', 0);

    const reports: RefinementReport[] = [];
    for (const { host, group, path } of hosts) {
        const { rows, report } = await refineGroup({
            group,
            rows: host[group] as Record<string, unknown>[],
            geometry,
            schema,
            model,
            path,
        });
        host[group] = rows;
        reports.push(report);
    }
    return reports;
}
