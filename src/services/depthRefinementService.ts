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
        // The model's ONLY job is STRUCTURE — exact depths are snapped
        // deterministically afterwards (snapLithologyTops), so the prompt
        // stays focused on the judgment calls it has proven reliable at.
        instructions: [
            'Your job is the STRUCTURE of the layer list, not exact depths: exact depths are corrected ' +
            'automatically afterwards by matching each row\'s text to the evidence, and bottoms are always ' +
            'recomputed from the next layer\'s top. NEVER propose an op just to adjust a depth value; ' +
            'propose set_top only for a row whose description was paraphrased so far from the evidence ' +
            'text that automatic matching would fail, yet you can still tell which line is its top.',
            'One row = one MATERIAL, not one line of text. A row whose description merely continues the ' +
            'previous row\'s sentence — wrapped text, or added detail like colour, moisture, grain size, ' +
            'inclusions, or a parenthetical qualifier — is NOT its own layer → merge_rows with the row it ' +
            'continues (first row survives, texts join).',
            'A layer marked "(continued)" on a later page is the SAME layer; if it was extracted as an ' +
            'extra row, delete_row the duplicate.',
            'If the evidence shows a distinct material that no row has AS ITS OWN LAYER, add_row it — ' +
            'INCLUDING when its text was absorbed into another row\'s description (e.g. surfacing/pavement/' +
            'aggregate base absorbed into the first soil layer\'s description). Give the new row the ' +
            'evidence line\'s text as description_raw and the evidence depth as depth_from_ft; set fields ' +
            'you cannot know to null.',
            'Evidence lines that are notes, legends, water-level remarks, or bare depth ranges are NOT ' +
            'materials: never add a row for one. EXCEPTION: the bottom-of-hole / end-of-boring line is not ' +
            'a material but MUST exist as the final row (eob=true, depth_from = depth_to) — add_row it if ' +
            'extraction omitted it.',
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
        result = finalizeIntervalOrder(cfg, all);
    } else {
        result = alive.map((w) => w.row);
        for (const row of addedRows) insertByDepth(cfg, result, row);
    }

    recomputeBottoms(cfg, result);
    return { rows: result, changes };
}

/** Sort interval rows by top depth (stable; EOB row pinned last). */
function finalizeIntervalOrder(
    cfg: GroupConfig,
    decorated: { orig: number; row: Record<string, unknown> }[]
): Record<string, unknown>[] {
    decorated.sort((a, b) => {
        const aEob = cfg.eobField && a.row[cfg.eobField] === true;
        const bEob = cfg.eobField && b.row[cfg.eobField] === true;
        if (aEob !== bEob) return aEob ? 1 : -1;
        const ad = a.row[cfg.depthField];
        const bd = b.row[cfg.depthField];
        if (isNum(ad) && isNum(bd) && ad !== bd) return (ad as number) - (bd as number);
        return a.orig - b.orig;
    });
    return decorated.map((w) => w.row);
}

/** Insert a point row (sample) at its depth position, keeping document order. */
function insertByDepth(cfg: GroupConfig, rows: Record<string, unknown>[], row: Record<string, unknown>): void {
    const d = row[cfg.depthField];
    const at = isNum(d) ? rows.findIndex((r) => isNum(r[cfg.depthField]) && (r[cfg.depthField] as number) > (d as number)) : -1;
    if (at === -1) rows.push(row);
    else rows.splice(at, 0, row);
}

/**
 * Recompute interval bottoms mechanically: each layer runs to the next
 * layer's top; the last material layer runs to the EOB row's depth.
 */
function recomputeBottoms(cfg: GroupConfig, rows: Record<string, unknown>[]): void {
    if (!cfg.recomputeBottoms || !cfg.bottomField) return;
    for (let i = 0; i < rows.length; i++) {
        const isEob = cfg.eobField && rows[i][cfg.eobField] === true;
        const next = rows[i + 1];
        if (isEob) {
            if (isNum(rows[i][cfg.depthField])) rows[i][cfg.bottomField] = rows[i][cfg.depthField];
        } else if (next && isNum(next[cfg.depthField])) {
            rows[i][cfg.bottomField] = next[cfg.depthField];
        }
    }
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

// ── deterministic corrections ───────────────────────────────────────────────
// The mechanical half of refinement. Model proposals showed run-to-run
// variance on exactly these joins (under-added samples, skipped set_tops,
// hallucinated duplicate deletes), so code owns them: text/id matching is
// unambiguous now that the evidence carries full line texts.

const normText = (s: unknown): string =>
    typeof s === 'string' ? s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : '';

/** Minimum normalized length before a line/description prefix match counts. */
const MIN_MATCH_CHARS = 10;
/** Stated-number overrides may adjust a measured depth by at most this much. */
const STATED_TOLERANCE_FT = 0.5;
/** End-of-boring phrases as printed on logs (with or without a stated depth). */
const EOB_RE = /bottom of (?:hole|boring)|end of boring|boring terminated|total depth/i;

/** Build an all-null row template from the union of existing rows' keys. */
function rowTemplate(rows: Record<string, unknown>[]): Record<string, unknown> {
    const t: Record<string, unknown> = {};
    for (const r of rows) for (const k of Object.keys(r)) if (!(k in t)) t[k] = null;
    return t;
}

/**
 * Samples, fully deterministic: walk the measured list (complete, document
 * order) and match each measured sample to the first unused row with the
 * same id (repeated ids match in order — same rule the document uses). Set
 * matched rows' depths; add a row for every measured sample extraction
 * dropped. NEVER deletes — duplicate rows are the QA layer's concern.
 */
export function correctSamplesDeterministically(
    rows: Record<string, unknown>[],
    geometry: DepthGeometry
): { rows: Record<string, unknown>[]; changes: string[] } {
    const cfg = GROUPS.samples_collected;
    const out = rows.map((r) => ({ ...r }));
    const changes: string[] = [];
    // track consumed rows by OBJECT identity — indices shift as rows are
    // inserted, and a freshly added row must never be re-matched by a later
    // measured sample with the same id
    const used = new Set<Record<string, unknown>>();
    const template = rowTemplate(rows);
    for (const m of geometry.samples) {
        const mid = m.id.replace(/\s/g, '').toLowerCase();
        const row = out.find((r) =>
            !used.has(r) &&
            typeof r.sample_id === 'string' &&
            (r.sample_id as string).replace(/\s/g, '').toLowerCase() === mid
        );
        if (row) {
            used.add(row);
            if (row[cfg.depthField] !== m.depth) {
                changes.push(`set depth ${m.id}: ${row[cfg.depthField]} → ${m.depth}`);
                row[cfg.depthField] = m.depth;
            }
        } else {
            const added = { ...template, sample_id: m.id, [cfg.depthField]: m.depth };
            used.add(added);
            insertByDepth(cfg, out, added);
            changes.push(`add ${m.id} @ ${m.depth}`);
        }
    }
    return { rows: out, changes };
}

/**
 * Lithology tops, deterministic: match each row to the measured description
 * line its text STARTS with (normalized prefix either way — the row's
 * description and the line derive from the same printed text) and snap the
 * row's top to that line's measured depth. Order-monotonic: rows and lines
 * are both in document order, and a line anchors at most one row — note/
 * legend lines simply never match anything. Then apply stated-number
 * overrides (numbers printed in the text beat measured values, within
 * tolerance):
 *   - an EOB row stating its own depth ("Bottom of hole at 45.5 feet");
 *   - a ground-surface row stating its thicknesses ("0.7' Plantmix over
 *     0.4' Aggregate Base" → the next layer starts at 1.1).
 *
 * Runs AFTER the model's structure pass; the caller re-sorts, recomputes
 * bottoms, and gates the result (fail open to the pre-snap rows).
 */
export function snapLithologyTops(
    rows: Record<string, unknown>[],
    geometry: DepthGeometry
): { rows: Record<string, unknown>[]; changes: string[] } {
    const cfg = GROUPS.lithology_intervals;
    let out = rows.map((r) => ({ ...r }));
    const changes: string[] = [];
    const lines = geometry.lithologyLines;

    // Deterministic split of an absorbed ground-surface layer (surfacing/
    // pavement folded into the first soil row). Runs before top-matching so
    // both parts snap to their own lines afterwards.
    out = splitAbsorbedSurfacing(cfg, out, geometry, changes);

    let from = 0; // monotonic pointer into lines
    const matched = new Set<Record<string, unknown>>();
    for (let i = 0; i < out.length; i++) {
        const nd = normText(out[i].description_raw);
        if (nd.length < MIN_MATCH_CHARS) continue;
        for (let k = from; k < lines.length; k++) {
            const nl = normText(lines[k].text);
            if (nl.length < MIN_MATCH_CHARS) continue;
            if (nd.startsWith(nl) || nl.startsWith(nd)) {
                if (out[i][cfg.depthField] !== lines[k].depth) {
                    changes.push(`snap top row ${i}: ${out[i][cfg.depthField]} → ${lines[k].depth} ("${lines[k].text.slice(0, 40)}…")`);
                    out[i][cfg.depthField] = lines[k].depth;
                }
                matched.add(out[i]);
                from = k + 1;
                break;
            }
        }
    }

    // Page-break duplicate rows: extraction sometimes re-emits a continuing
    // layer's restated description as its own row. Signature: the row's text
    // (ignoring "(continued)" markers) is identical to a row that DID match
    // an evidence line, while this row matched nothing — the measured
    // transcript defines the real layer set, so drop the echo.
    const dupKey = (r: Record<string, unknown>): string =>
        normText(r.description_raw).replace(/\bcontinued\b/g, '').trim();
    const matchedKeys = new Set([...matched].map(dupKey));
    for (let i = out.length - 1; i >= 0; i--) {
        const r = out[i];
        if (matched.has(r) || (cfg.eobField && r[cfg.eobField] === true)) continue;
        const key = dupKey(r);
        if (key.length >= MIN_MATCH_CHARS && matchedKeys.has(key)) {
            changes.push(`drop unmatched duplicate row: "${(r.description_raw as string).slice(0, 40)}…"`);
            out.splice(i, 1);
        }
    }

    // Deterministic EOB row: if the measured evidence shows an end-of-boring
    // line but extraction emitted no eob row, create it from the line (the
    // stated-depth override just below then refines its depth). Same
    // evidence-completeness principle as the sample adds.
    const eobField = cfg.eobField;
    if (eobField && !out.some((r) => r[eobField] === true)) {
        const eobLine = lines.find((l) => EOB_RE.test(l.text));
        if (eobLine) {
            out.push({
                ...rowTemplate(out),
                [eobField]: true,
                description_raw: eobLine.text,
                [cfg.depthField]: eobLine.depth,
            });
            changes.push(`add EOB row from evidence @ ${eobLine.depth}`);
        }
    }

    // Stated EOB depth beats the measured one (kills the reading tolerance
    // at the bottom of the hole).
    for (const r of out) {
        if (cfg.eobField && r[cfg.eobField] === true && typeof r.description_raw === 'string') {
            const m = (r.description_raw as string).match(
                new RegExp(`(?:${EOB_RE.source})[^\\d]{0,20}(\\d+(?:\\.\\d+)?)`, 'i')
            );
            if (m) {
                const stated = +m[1];
                const cur = r[cfg.depthField];
                if (!isNum(cur) || Math.abs(stated - (cur as number)) <= STATED_TOLERANCE_FT) {
                    if (cur !== stated) {
                        changes.push(`stated EOB depth: ${cur} → ${stated}`);
                        r[cfg.depthField] = stated;
                    }
                }
            }
        }
    }

    // Stated surfacing thickness: a ground-surface row whose text prints its
    // own thicknesses ("0.7' X over 0.4' Y") fixes the NEXT layer's top at
    // their sum — but only when that agrees with the measurement to within
    // tolerance (the stated number wins the rounding, never invents a layer).
    // top rows by MEASURED position, not array order — the caller only
    // sorts after this function returns
    const byTop = out
        .filter((r) => !(cfg.eobField && r[cfg.eobField] === true) && isNum(r[cfg.depthField]))
        .sort((a, b) => (a[cfg.depthField] as number) - (b[cfg.depthField] as number));
    const first = byTop[0];
    const next = byTop[1];
    if (first && (first[cfg.depthField] as number) <= 0.05 && typeof first.description_raw === 'string') {
        const feet = [...(first.description_raw as string).matchAll(/(\d+(?:\.\d+)?)\s*'/g)].map((m) => +m[1]);
        const sum = +feet.reduce((a, b) => a + b, 0).toFixed(2);
        if (feet.length >= 1 && sum > 0 && next && isNum(next[cfg.depthField])
            && Math.abs(sum - (next[cfg.depthField] as number)) <= STATED_TOLERANCE_FT
            && next[cfg.depthField] !== sum) {
            changes.push(`stated surfacing thickness: next top ${next[cfg.depthField]} → ${sum}`);
            next[cfg.depthField] = sum;
        }
    }

    return { rows: out, changes };
}

/**
 * Detect and split a merged ground-surface row: extraction commonly folds a
 * thin surfacing/pavement layer into the first soil layer's description, so
 * the row's text is the CONCATENATION of two measured lines that sit a
 * layer's distance apart on the ruler. All conditions are evidence-driven:
 *  - the row's text starts with line A's text and continues with line B's;
 *  - A and B are ≥ MIN_SPLIT_GAP_FT apart (wrapped lines of one layer sit
 *    ~one text-line apart and must NOT split);
 *  - no other row already carries line A as its own layer;
 *  - line B's opening words are locatable in the raw description, so the
 *    texts can be cut cleanly (no duplicated text across the two rows).
 * Fail open: any condition unmet → rows unchanged. Tops are left for the
 * prefix snap + stated-thickness override that run right after.
 */
const MIN_SPLIT_GAP_FT = 0.8;

function splitAbsorbedSurfacing(
    cfg: GroupConfig,
    rows: Record<string, unknown>[],
    geometry: DepthGeometry,
    changes: string[]
): Record<string, unknown>[] {
    const lines = geometry.lithologyLines;
    if (lines.length < 2) return rows;
    const [A, B] = lines;
    const normA = normText(A.text);
    const normB = normText(B.text);
    if (normA.length < MIN_MATCH_CHARS || normB.length < MIN_MATCH_CHARS) return rows;
    if (B.depth - A.depth < MIN_SPLIT_GAP_FT) return rows; // wrapped text, not a boundary

    // does the surfacing already exist as its own row (e.g. the model's
    // structure pass added it)? then only TRIM a still-merged row, don't
    // create a second surfacing row
    const standalone = rows.some((r) => {
        const nd = normText(r.description_raw);
        return nd.length >= MIN_MATCH_CHARS && (normA.startsWith(nd) || nd === normA);
    });

    // find the merged row: starts with A's text, continues with B's
    const idx = rows.findIndex((r) => {
        const nd = normText(r.description_raw);
        if (!nd.startsWith(normA) || nd === normA) return false;
        const rest = nd.slice(normA.length).trim();
        return rest.startsWith(normB) || (rest.length >= MIN_MATCH_CHARS && normB.startsWith(rest));
    });
    if (idx < 0) return rows;

    // locate B's opening words in the RAW description for a clean text cut
    const merged = rows[idx];
    const raw = merged.description_raw as string;
    const bWords = B.text.trim().split(/\s+/).slice(0, 4).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const m = raw.match(new RegExp(bWords.join('\\s+'), 'i'));
    if (!m || m.index == null || m.index === 0) return rows;

    const soil = { ...merged, description_raw: raw.slice(m.index).trim(), [cfg.depthField]: B.depth };
    // the soil part often opens with its printed USCS code — backfill the
    // symbol field if extraction left it empty on the merged row
    if (soil.uscs_symbol == null || soil.uscs_symbol === '') {
        const um = (soil.description_raw as string).match(/^\(([A-Z]{2,3})\)/);
        if (um) {
            soil.uscs_symbol = um[1];
            if ('uscs_source' in soil) soil.uscs_source = 'inline_parenthetical';
        }
    }
    const out = [...rows];
    if (standalone) {
        out.splice(idx, 1, soil);
        changes.push(`trimmed absorbed surface text: soil layer starts "${(soil.description_raw as string).slice(0, 30)}…" [${B.depth}]`);
    } else {
        const surfacing: Record<string, unknown> = {
            ...rowTemplate(rows),
            ...(cfg.eobField ? { [cfg.eobField]: false } : {}),
            description_raw: raw.slice(0, m.index).trim(),
            [cfg.depthField]: A.depth,
        };
        out.splice(idx, 1, surfacing, soil);
        changes.push(`split absorbed surface layer: "${surfacing.description_raw}" [${A.depth}] / "${(soil.description_raw as string).slice(0, 30)}…" [${B.depth}]`);
    }
    return out;
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

    // ── samples: fully deterministic, no model call ──────────────────
    if (group === 'samples_collected') {
        try {
            const { rows: corrected, changes } = correctSamplesDeterministically(rows, geometry);
            if (changes.length === 0) return { rows, report: { ...base, status: 'no_ops' } };
            console.log(`📐 depth refinement (${path}): deterministic — ${changes.join('; ')}`);
            return { rows: corrected, report: { ...base, status: 'refined', ops_applied: changes.length, changes } };
        } catch (err: any) {
            console.warn(`⚠️ depth refinement (${path}): deterministic correction failed — keeping rows: ${err?.message}`);
            return { rows, report: { ...base, status: 'error', reason: err?.message } };
        }
    }

    // ── lithology: model fixes STRUCTURE, then code snaps the numbers ─
    // The invariant gate runs ONCE, after the snap — never between the
    // phases: a correct structure op (e.g. adding an absorbed surfacing row
    // at the same top as the row it was split from) can legitimately tie
    // tops that only the snap separates. Fallback ladder, each rung gated:
    //   1. model structure ops + snap    2. snap only    3. original rows
    const model = args.model || DEFAULT_REFINER_MODEL;
    const itemSchema = schema ? resolveGroupItemSchema(schema, group) : null;

    let ops: RefinementOp[] = [];
    let callError: string | null = null;
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
        ops = ((JSON.parse(content || '{}').ops || []) as RefinementOp[])
            // per-op anyOf shapes omit unused fields — normalize for applyOps
            .map((o) => ({ row: null, rows: null, depth_ft: null, item: null, ...(o as Partial<RefinementOp>) } as RefinementOp));
    } catch (err: any) {
        callError = err?.message || String(err);
        console.warn(`⚠️ depth refinement (${path}): refiner call failed — snapping without structure ops: ${callError}`);
    }

    const snapAndGate = (input: Record<string, unknown>[]): { rows: Record<string, unknown>[]; changes: string[] } => {
        const { rows: snapped, changes } = snapLithologyTops(input, geometry);
        const final = finalizeIntervalOrder(cfg, snapped.map((row, i) => ({ orig: i, row })));
        recomputeBottoms(cfg, final);
        checkInvariants(group, input, final, []);
        return { rows: final, changes };
    };

    // Rung 1: structure ops + snap
    if (ops.length > 0) {
        try {
            const { rows: structured, changes: modelChanges } = applyOps(group, rows, ops);
            const { rows: final, changes: snapChanges } = snapAndGate(structured);
            const changes = [...modelChanges.map((c) => `model: ${c}`), ...snapChanges.map((c) => `snap: ${c}`)];
            if (changes.length === 0) return { rows, report: { ...base, status: 'no_ops', model } };
            console.log(`📐 depth refinement (${path}): ${changes.join('; ')}`);
            return {
                rows: final,
                report: { ...base, status: 'refined', ops_proposed: ops.length, ops_applied: changes.length, changes, model },
            };
        } catch (err: any) {
            console.warn(
                `⚠️ depth refinement (${path}): structure+snap rejected (${err?.message}) — falling back to snap-only. ` +
                `Proposed: ${JSON.stringify(ops)}`
            );
        }
    }

    // Rung 2: snap only
    try {
        const { rows: final, changes: snapChanges } = snapAndGate(rows);
        if (snapChanges.length === 0) {
            return { rows, report: { ...base, status: 'no_ops', ops_proposed: ops.length, model, ...(callError ? { reason: callError } : {}) } };
        }
        const changes = snapChanges.map((c) => `snap: ${c}`);
        console.log(`📐 depth refinement (${path}): ${changes.join('; ')}`);
        return {
            rows: final,
            report: {
                ...base, status: 'refined', ops_proposed: ops.length, ops_applied: changes.length, changes, model,
                ...(ops.length > 0 ? { reason: 'structure ops rejected; snap-only applied' } : {}),
            },
        };
    } catch (err: any) {
        // Rung 3: original rows
        console.warn(`⚠️ depth refinement (${path}): snap rejected (${err?.message}) — keeping original rows`);
        return { rows, report: { ...base, status: 'rejected', ops_proposed: ops.length, reason: err?.message, model } };
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
