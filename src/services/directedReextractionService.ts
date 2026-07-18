/**
 * Directed group re-extraction — operator-triggered repair tool.
 *
 * Productizes the manual workflow that reliably beats the pipeline when a
 * group comes out wrong (screenshot the page → "extract samples_collected" →
 * copy the result in): pixels + narrow scope + explicit direction.
 *
 * Two per-group modes (auto-selected by array size, operator-overridable):
 *
 *  - FULL: the model re-emits the group's entire value under a strict
 *    sub-schema; we diff it against the current record. Best for small,
 *    empty, or mostly-wrong groups — exhaustiveness is the point.
 *  - PATCH: a grouped-QA-style call (same system prompt / shared user text /
 *    response format as section QA's per-group calls) with the operator note
 *    steering attention; the model emits findings directly. Best for large,
 *    mostly-right arrays (fix 3 of 40 time_series_readings): output scales
 *    with defect count, not array size, and correct rows are never
 *    re-transcribed (each re-transcription is a fresh chance to misread).
 *
 * Requests ride file_processing_queue as `rex:<requestId>` — the payload
 * (groups, pages, prompt, mode) lives in directed_reextraction_requests,
 * which doubles as the audit/telemetry record of every vision repair run.
 * The worker executes runDirectedReextractionJob; progress reaches the UI
 * as `reextract-progress-event` (same relay pattern as `qa-progress-event`).
 *
 * Output NEVER writes extraction data — per-group findings ride the existing
 * QA review/apply UI, preserving the operator-review gate and audit trail.
 * Persistence is deliberately NOT saveQAFindings (that helper deletes every
 * open finding for the section): saveDirectedReextractionFindings replaces
 * only the target group's open findings and leaves the rest untouched.
 */

import OpenAI from 'openai';
import pool, { getFileResult } from '../database.js';
import S3Service from '../s3Service.js';
import { getActiveSchema, getQAHints } from './schemaRegistry.js';
import { rasterizePdf } from './pdfRasterizer.js';
import {
    qaValuesEqual,
    verifyFindingAgainstRecord,
    splitSchemaIntoGroups,
    deriveQualityFromFindings,
} from './sectionQAService.js';
import {
    buildDirectedReextractionSystemPrompt,
    buildDirectedReextractionSharedUserText,
    buildDirectedReextractionInstruction,
    buildDirectedReextractionResponseFormat,
    buildDirectedPatchInstruction,
    buildGroupQACachedSystemPrompt,
    buildGroupQASharedUserText,
    buildGroupQAResponseFormat,
} from '../config/openaiPrompts.ts';

// Same imaging config as section QA — the operator is fixing what QA-grade
// vision can read, so use QA-grade rendering.
const IMAGE_WIDTH = 1024;
const IMAGE_QUALITY = 90;
export const MAX_REEXTRACT_PAGES = 4;
export const MAX_REEXTRACT_GROUPS = 3;

// auto mode: arrays at or above this row count go to PATCH (findings
// emission); smaller groups get the FULL re-read. ~15 is where full
// re-emission's error surface (re-transcribing correct rows) starts to
// outweigh its exhaustiveness advantage.
export const PATCH_ROW_THRESHOLD = Math.max(
    2,
    parseInt(process.env.DIRECTED_REEXTRACT_PATCH_THRESHOLD || '15', 10) || 15,
);

// Default model. gpt-5.5 is what the manual ChatGPT workflow this replaces
// runs on, and what section QA already trusts to read these pages. This is an
// on-demand repair action (not a per-section bulk cost), so quality wins over
// price; override per request or via env for A/B.
const REEXTRACT_MODEL = process.env.DIRECTED_REEXTRACT_MODEL || 'gpt-5.5';
const REEXTRACT_REASONING_EFFORT = process.env.DIRECTED_REEXTRACT_REASONING_EFFORT || null;

// Within one request: first group call runs alone to warm the prompt cache
// (mirrors grouped QA), the rest fan out under this cap.
const GROUP_CONCURRENCY = 2;

const RETRY_ATTEMPTS = 3;
const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);

export type DirectedMode = 'auto' | 'full' | 'patch';

export type DirectedFinding = {
    field: string;
    issue_type: string;
    severity: 'error' | 'warning' | 'info';
    expected: string | null;
    actual: string | null;
    corrected_value?: unknown;
    row_index: number | null;
    row_value: string | null;
    explanation: string;
    _group?: string;
};

export type DirectedGroupResult = {
    group: string;
    modeUsed: 'full' | 'patch';
    findings: DirectedFinding[];
    /** Full-mode only: the value the model re-read (for telemetry/debug). */
    newValue?: unknown;
    tokens: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
    durationMs: number;
    /** Full-mode guard: delete_rows suppressed as suspected under-emission. */
    suppressedDeletes: number;
    error?: string;
};

// ---------------------------------------------------------------------------
// Pure diff: fresh group value vs current record value → QA finding drafts
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isScalar(v: unknown): v is string | number | boolean | null {
    return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function toEvidenceString(v: unknown): string | null {
    if (v === undefined || v === null) return null;
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Tolerant row equality on the union of keys (mirrors QA's shallow check). */
export function rowsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
        if (!qaValuesEqual(toEvidenceString(a[key]), toEvidenceString(b[key]))) return false;
    }
    return true;
}

/**
 * Similarity in [0,1] between two rows: matching fields / compared fields,
 * counting only fields where at least one side has a real value. Used to pair
 * a re-read row with the existing row it corrects (vs. a genuinely new row).
 */
export function rowSimilarity(a: Record<string, unknown>, b: Record<string, unknown>): number {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    let compared = 0;
    let matched = 0;
    for (const key of keys) {
        const av = toEvidenceString(a[key]);
        const bv = toEvidenceString(b[key]);
        const aEmpty = av === null || av === '';
        const bEmpty = bv === null || bv === '';
        if (aEmpty && bEmpty) continue;
        compared += 1;
        if (qaValuesEqual(av, bv)) matched += 1;
    }
    return compared === 0 ? 0 : matched / compared;
}

const UPDATE_SIMILARITY_THRESHOLD = 0.5;

/**
 * Diff two arrays of row objects into add_row/update_row/delete_row drafts.
 *
 * Matching: exact (tolerant) content matches pair off first; remaining rows
 * pair greedily by similarity ≥ 0.5 → update_row; leftover new rows →
 * add_row (row_index = position in the fresh array, an insertion hint the UI
 * clamps safely); leftover old rows → delete_row at WARNING severity — the
 * re-extractor under-emitting must read as "verify this row", never as a
 * confident deletion.
 *
 * Under-emission guard: when the leftover-old count is large in absolute
 * terms AND exceeds everything else the diff produced, the likeliest cause
 * is the model stopping early on a long table, not phantom rows — suppress
 * the delete_rows entirely (reported via suppressedDeletes) instead of
 * flooding the review panel with deletion warnings.
 */
function diffArray(
    path: string,
    oldArr: unknown[],
    newArr: unknown[],
): { findings: DirectedFinding[]; suppressedDeletes: number } {
    const findings: DirectedFinding[] = [];

    const oldRows = oldArr.filter(isPlainObject);
    const newRows = newArr.filter(isPlainObject);
    // Arrays of scalars (rare) — treat as whole-value replacement upstream.
    if (oldRows.length !== oldArr.length || newRows.length !== newArr.length) {
        return { findings, suppressedDeletes: 0 };
    }

    const oldMatched = new Array(oldRows.length).fill(false);
    const newMatched = new Array(newRows.length).fill(false);

    // Phase 1: exact content matches (in order, each row consumed once).
    for (let i = 0; i < oldRows.length; i++) {
        for (let j = 0; j < newRows.length; j++) {
            if (newMatched[j]) continue;
            if (rowsEqual(oldRows[i], newRows[j])) {
                oldMatched[i] = true;
                newMatched[j] = true;
                break;
            }
        }
    }

    // Phase 2: greedy best-similarity pairing → update_row.
    const pairs: Array<{ i: number; j: number; score: number }> = [];
    for (let i = 0; i < oldRows.length; i++) {
        if (oldMatched[i]) continue;
        for (let j = 0; j < newRows.length; j++) {
            if (newMatched[j]) continue;
            const score = rowSimilarity(oldRows[i], newRows[j]);
            if (score >= UPDATE_SIMILARITY_THRESHOLD) pairs.push({ i, j, score });
        }
    }
    pairs.sort((a, b) => b.score - a.score);
    let updates = 0;
    for (const { i, j } of pairs) {
        if (oldMatched[i] || newMatched[j]) continue;
        oldMatched[i] = true;
        newMatched[j] = true;
        updates += 1;
        findings.push({
            field: path,
            issue_type: 'update_row',
            severity: 'error',
            expected: null,
            actual: null, // verifier freezes the real row content here (the UI's row anchor)
            row_index: i,
            row_value: JSON.stringify(newRows[j]),
            explanation: 'Directed re-extraction read this row differently on the page.',
        });
    }

    let adds = 0;
    for (let j = 0; j < newRows.length; j++) {
        if (newMatched[j]) continue;
        adds += 1;
        findings.push({
            field: path,
            issue_type: 'add_row',
            severity: 'error',
            expected: null,
            actual: null,
            row_index: j,
            row_value: JSON.stringify(newRows[j]),
            explanation: 'Row is on the page but missing from the extraction (directed re-extraction).',
        });
    }

    const unmatchedOld = oldRows.map((_, i) => i).filter((i) => !oldMatched[i]);
    const suspectedUnderEmission = unmatchedOld.length >= 3 && unmatchedOld.length > adds + updates;
    if (suspectedUnderEmission) {
        console.warn(
            `⚠️ diffArray('${path}'): ${unmatchedOld.length} old row(s) unmatched vs ` +
            `${adds} add(s) + ${updates} update(s) — suspected under-emission, suppressing delete_rows`,
        );
        return { findings, suppressedDeletes: unmatchedOld.length };
    }

    for (const i of unmatchedOld) {
        findings.push({
            field: path,
            issue_type: 'delete_row',
            severity: 'warning',
            expected: null,
            actual: null,
            row_index: i,
            row_value: null,
            explanation: 'Directed re-extraction did not find this row on the page — verify before deleting.',
        });
    }

    return { findings, suppressedDeletes: 0 };
}

/** Scalar field diff → wrong_value / missing_value / extra_value draft (or none). */
function diffScalar(path: string, oldV: unknown, newV: unknown): DirectedFinding[] {
    if (qaValuesEqual(toEvidenceString(oldV), toEvidenceString(newV))) return [];
    const oldEmpty = oldV === undefined || oldV === null || oldV === '';
    const newEmpty = newV === undefined || newV === null || newV === '';
    if (oldEmpty && newEmpty) return [];

    if (newEmpty) {
        // The re-extractor couldn't read a value the extraction has. That's a
        // "verify" signal, not a confident removal — mirror delete_row's caution.
        return [{
            field: path,
            issue_type: 'extra_value',
            severity: 'warning',
            expected: null,
            actual: null,
            corrected_value: null,
            row_index: null,
            row_value: null,
            explanation: 'Directed re-extraction could not read this value on the page — verify before clearing.',
        }];
    }

    return [{
        field: path,
        issue_type: oldEmpty ? 'missing_value' : 'wrong_value',
        severity: 'error',
        expected: toEvidenceString(newV),
        actual: null,
        corrected_value: newV as string | number | boolean,
        row_index: null,
        row_value: null,
        explanation: oldEmpty
            ? 'Value is on the page but missing from the extraction (directed re-extraction).'
            : 'Directed re-extraction read a different value on the page.',
    }];
}

/**
 * Diff the freshly re-extracted group value against the current one, emitting
 * QA-style finding drafts. Pure — exported for tests.
 *
 * Shapes:
 *  - current value null/absent, fresh value present → ONE missing_value
 *    finding on the bare group path whose corrected_value is the ENTIRE fresh
 *    value (jsonb column + the UI's setByPath both handle non-scalars) — a
 *    never-extracted group becomes a single reviewable "fill it in" fix.
 *  - array group → row-level ops via diffArray (with the under-emission guard).
 *  - object group → per-field scalar diffs, recursing into nested objects and
 *    diffing nested arrays of rows in place.
 *  - scalar group → single scalar diff.
 */
export function diffGroupValue({
    groupName,
    oldValue,
    newValue,
}: {
    groupName: string;
    oldValue: unknown;
    newValue: unknown;
}): { findings: DirectedFinding[]; suppressedDeletes: number } {
    const newEmpty = newValue === undefined || newValue === null
        || (Array.isArray(newValue) && newValue.length === 0);
    const oldMissing = oldValue === undefined || oldValue === null;

    if (newEmpty) {
        // A fresh read that produced nothing is never evidence to clear data —
        // for scalars diffScalar handles the cautious extra_value case; for
        // whole groups, bail rather than synthesize mass deletions.
        const findings = isScalar(oldValue) && isScalar(newValue ?? null)
            ? diffScalar(groupName, oldValue, newValue ?? null)
            : [];
        return { findings, suppressedDeletes: 0 };
    }

    if (oldMissing) {
        return {
            suppressedDeletes: 0,
            findings: [{
                field: groupName,
                issue_type: 'missing_value',
                severity: 'error',
                expected: null,
                actual: null,
                corrected_value: newValue,
                row_index: null,
                row_value: null,
                explanation: Array.isArray(newValue)
                    ? `Group was not extracted — directed re-extraction read ${newValue.length} row(s) on the page.`
                    : 'Group was not extracted — directed re-extraction read it on the page.',
            }],
        };
    }

    if (Array.isArray(newValue)) {
        if (!Array.isArray(oldValue)) {
            // Type mismatch (schema drift) — replace wholesale, reviewed.
            return {
                suppressedDeletes: 0,
                findings: [{
                    field: groupName,
                    issue_type: 'wrong_value',
                    severity: 'error',
                    expected: null,
                    actual: null,
                    corrected_value: newValue,
                    row_index: null,
                    row_value: null,
                    explanation: 'Directed re-extraction produced a different structure for this group.',
                }],
            };
        }
        return diffArray(groupName, oldValue, newValue);
    }

    if (isPlainObject(newValue)) {
        if (!isPlainObject(oldValue)) {
            return {
                suppressedDeletes: 0,
                findings: [{
                    field: groupName,
                    issue_type: 'wrong_value',
                    severity: 'error',
                    expected: null,
                    actual: null,
                    corrected_value: newValue,
                    row_index: null,
                    row_value: null,
                    explanation: 'Directed re-extraction produced a different structure for this group.',
                }],
            };
        }
        const findings: DirectedFinding[] = [];
        let suppressedDeletes = 0;
        const keys = new Set([...Object.keys(oldValue), ...Object.keys(newValue)]);
        for (const key of keys) {
            const path = `${groupName}.${key}`;
            const o = (oldValue as Record<string, unknown>)[key];
            const n = (newValue as Record<string, unknown>)[key];
            if (Array.isArray(n) && Array.isArray(o)) {
                const sub = diffArray(path, o, n);
                findings.push(...sub.findings);
                suppressedDeletes += sub.suppressedDeletes;
            } else if (isPlainObject(n) && isPlainObject(o)) {
                const sub = diffGroupValue({ groupName: path, oldValue: o, newValue: n });
                findings.push(...sub.findings);
                suppressedDeletes += sub.suppressedDeletes;
            } else if (isScalar(n) || n === undefined) {
                findings.push(...diffScalar(path, o, n));
            }
            // Mixed shapes (array vs scalar etc.) under an object group are
            // schema drift we don't try to auto-fix — leave to full reprocess.
        }
        return { findings, suppressedDeletes };
    }

    return { findings: diffScalar(groupName, oldValue, newValue), suppressedDeletes: 0 };
}

// ---------------------------------------------------------------------------
// Mode selection
// ---------------------------------------------------------------------------

/** Largest row-array length in a group value (top level or one level down). */
function largestRowArrayLen(value: unknown): number {
    if (Array.isArray(value)) return value.length;
    if (isPlainObject(value)) {
        let max = 0;
        for (const v of Object.values(value)) {
            if (Array.isArray(v) && v.length > max) max = v.length;
        }
        return max;
    }
    return 0;
}

/**
 * Pick the execution mode for one group. Explicit full/patch is honored;
 * auto sends large, already-populated arrays to PATCH (output ∝ defects, no
 * re-transcription of correct rows) and everything else to FULL (output ∝
 * group size, exhaustive read — the point when the group is small or empty).
 * Pure — exported for tests.
 */
export function resolveModeForGroup(requestedMode: DirectedMode, currentValue: unknown): 'full' | 'patch' {
    if (requestedMode === 'full' || requestedMode === 'patch') return requestedMode;
    return largestRowArrayLen(currentValue) >= PATCH_ROW_THRESHOLD ? 'patch' : 'full';
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

let _openaiClient: OpenAI | null = null;
function openai(): OpenAI {
    if (!_openaiClient) _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _openaiClient;
}

function isTransient(err: unknown): boolean {
    const e = err as { status?: number; message?: string };
    if (e?.status && RETRYABLE_HTTP_STATUS.has(e.status)) return true;
    return /timed? ?out|connection error/i.test(e?.message || '');
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (attempt === RETRY_ATTEMPTS || !isTransient(err)) throw err;
            const delayMs = Math.round(1000 * 4 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
            console.warn(`⚠️ ${label}: transient failure on attempt ${attempt}/${RETRY_ATTEMPTS} — retrying in ${delayMs}ms`);
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    throw lastErr;
}

type ImageBlock = {
    type: 'image_url';
    image_url: { url: string; detail: 'high' };
};

type GroupCallContext = {
    sectionResultId: string;
    cleanRecord: Record<string, unknown>;
    activeSchema: object;
    qaHints: Record<string, { priority?: string; ignore?: string[]; notes?: string }>;
    imageBlocks: ImageBlock[];
    renderedPages: number[];
    operatorPrompt: string | null;
    model: string;
    reasoningEffort: string | null;
};

/** One focused call for one group, in one mode. Never throws — errors land in the result. */
async function runGroupCall(
    ctx: GroupCallContext,
    groupName: string,
    groupSchema: Record<string, unknown>,
    modeUsed: 'full' | 'patch',
): Promise<DirectedGroupResult> {
    const startMs = Date.now();
    try {
        const reasoning = ctx.reasoningEffort
            ? { reasoning_effort: ctx.reasoningEffort as OpenAI.Chat.Completions.ChatCompletionCreateParams['reasoning_effort'] }
            : {};

        // Prompt layout mirrors grouped QA's cache discipline: everything
        // shared across a request's group calls FIRST (system → shared text →
        // images), the group-specific instruction LAST. Full and patch have
        // different prefixes (patch includes the record, QA-style), so cache
        // keys are per-mode. Full-mode calls also differ in response_format
        // per group — the message prefix still caches; the schema doesn't.
        let params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
        if (modeUsed === 'full') {
            params = {
                model: ctx.model,
                ...reasoning,
                prompt_cache_key: `rex-full-${ctx.sectionResultId}`,
                messages: [
                    { role: 'system', content: buildDirectedReextractionSystemPrompt(ctx.renderedPages.length) },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: buildDirectedReextractionSharedUserText(ctx.renderedPages) },
                            ...ctx.imageBlocks,
                            {
                                type: 'text',
                                text: buildDirectedReextractionInstruction({
                                    groupName,
                                    groupSchema,
                                    currentValue: ctx.cleanRecord[groupName],
                                    operatorPrompt: ctx.operatorPrompt,
                                }),
                            },
                        ],
                    },
                ],
                response_format: buildDirectedReextractionResponseFormat(groupName, groupSchema),
            };
        } else {
            params = {
                model: ctx.model,
                ...reasoning,
                prompt_cache_key: `rex-patch-${ctx.sectionResultId}`,
                messages: [
                    { role: 'system', content: buildGroupQACachedSystemPrompt(ctx.renderedPages.length) },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: buildGroupQASharedUserText(ctx.cleanRecord, ctx.renderedPages) },
                            ...ctx.imageBlocks,
                            {
                                type: 'text',
                                text: buildDirectedPatchInstruction({
                                    groupName,
                                    groupSchema,
                                    groupValue: ctx.cleanRecord[groupName],
                                    hint: ctx.qaHints[groupName] || null,
                                    operatorPrompt: ctx.operatorPrompt,
                                }),
                            },
                        ],
                    },
                ],
                response_format: buildGroupQAResponseFormat(),
            };
        }

        const response = await withRetry(`directed ${modeUsed} '${groupName}'`, () =>
            openai().chat.completions.create(params),
        );
        const parsed = JSON.parse(response.choices[0].message.content ?? '{}');

        let drafts: DirectedFinding[];
        let newValue: unknown;
        let suppressedDeletes = 0;

        if (modeUsed === 'full') {
            newValue = parsed[groupName];
            const diff = diffGroupValue({ groupName, oldValue: ctx.cleanRecord[groupName], newValue });
            drafts = diff.findings;
            suppressedDeletes = diff.suppressedDeletes;
        } else {
            // Patch mode: the model emitted findings. Focus guard mirrors
            // grouped QA — drop anything outside the target group.
            const inGroup = (f: string) =>
                f === groupName || f.startsWith(`${groupName}.`) || f.startsWith(`${groupName}[`);
            drafts = ((parsed.issues ?? []) as DirectedFinding[])
                .filter((issue) => inGroup(String(issue?.field ?? '')));
        }

        // Same trust layer as QA: nothing the model (or our diff) says is
        // saved until verified against the real record + schema. This freezes
        // `actual` to real row content (the UI's apply anchor), validates
        // indices, applies the enum backstop, and drops no-ops.
        const findings: DirectedFinding[] = [];
        for (const draft of drafts) {
            const { keep, issue } = verifyFindingAgainstRecord(draft, ctx.cleanRecord, ctx.activeSchema);
            if (keep) findings.push({ ...issue, _group: groupName });
        }

        console.log(
            `   Directed ${modeUsed} '${groupName}': ` +
            (modeUsed === 'full'
                ? `model returned ${Array.isArray(newValue) ? `${newValue.length} row(s)` : typeof newValue}, `
                : `model emitted ${drafts.length} issue(s), `) +
            `${findings.length} verified finding(s)` +
            (suppressedDeletes ? `, ${suppressedDeletes} delete(s) suppressed` : '') +
            ` (${response.usage?.total_tokens ?? '?'} tokens)`,
        );

        return {
            group: groupName,
            modeUsed,
            findings,
            ...(modeUsed === 'full' ? { newValue } : {}),
            tokens: response.usage ?? null,
            durationMs: Date.now() - startMs,
            suppressedDeletes,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`⚠️ Directed ${modeUsed} '${groupName}' failed: ${message}`);
        return {
            group: groupName,
            modeUsed,
            findings: [],
            tokens: null,
            durationMs: Date.now() - startMs,
            suppressedDeletes: 0,
            error: message,
        };
    }
}

/**
 * Run a directed re-extraction of 1..MAX_REEXTRACT_GROUPS groups and
 * synthesize verified findings per group. Does NOT persist anything — pair
 * with saveDirectedReextractionFindings (the worker job does both).
 *
 * `onGroupDone` (optional, awaited) fires as each group finishes, in
 * completion order — the worker uses it to save + emit incrementally so one
 * group's failure never loses another's findings.
 */
export async function runDirectedReextraction({
    sectionResultId,
    slug,
    groups,
    pageNumbers,
    operatorPrompt = null,
    extractionRecord,
    pdfBuffer,
    model = REEXTRACT_MODEL,
    requestedMode = 'auto',
    reasoningEffort = REEXTRACT_REASONING_EFFORT,
    onGroupDone = null,
}: {
    sectionResultId: string;
    slug: string;
    groups: string[];
    pageNumbers: number[];
    operatorPrompt?: string | null;
    extractionRecord: Record<string, unknown>;
    pdfBuffer: Buffer;
    model?: string;
    requestedMode?: DirectedMode;
    reasoningEffort?: string | null;
    onGroupDone?: ((result: DirectedGroupResult) => Promise<void> | void) | null;
}): Promise<{
    groupResults: DirectedGroupResult[];
    renderedPages: number[];
    model: string;
}> {
    if (!Array.isArray(groups) || groups.length === 0) {
        throw new Error('At least one group is required');
    }
    if (groups.length > MAX_REEXTRACT_GROUPS) {
        throw new Error(`At most ${MAX_REEXTRACT_GROUPS} groups per request (got ${groups.length})`);
    }

    const active = (await getActiveSchema(slug)) as { schema?: object } | null;
    const activeSchema = active?.schema ?? null;
    if (!activeSchema) {
        throw new Error(`No active schema registered for document type '${slug}'`);
    }
    const schemaGroups = splitSchemaIntoGroups(activeSchema) as Array<{ name: string; schema: object }>;
    const groupSchemas = new Map<string, Record<string, unknown>>();
    for (const name of groups) {
        const g = schemaGroups.find((s) => s.name === name);
        if (!g) throw new Error(`'${name}' is not a top-level group of the '${slug}' schema`);
        groupSchemas.set(name, g.schema as Record<string, unknown>);
    }

    const wantedPages = [...new Set(pageNumbers)]
        .filter((n) => Number.isInteger(n) && n > 0)
        .sort((a, b) => a - b);
    if (!wantedPages.length) {
        throw new Error('No valid pages to re-extract from');
    }
    // Explicit failure beats silently discarding the operator's selection.
    if (wantedPages.length > MAX_REEXTRACT_PAGES) {
        throw new Error(`At most ${MAX_REEXTRACT_PAGES} pages per request (got ${wantedPages.length})`);
    }

    // Pages can be non-contiguous; rasterize the span, keep the wanted ones.
    const rendered = await rasterizePdf(pdfBuffer, {
        firstPage: wantedPages[0],
        lastPage: wantedPages[wantedPages.length - 1],
        widthPx: IMAGE_WIDTH,
        jpegQuality: IMAGE_QUALITY,
    });
    const wanted = new Set(wantedPages);
    const pages = (rendered as Array<{ pageNumber: number; jpeg: Buffer }>)
        .filter((p) => wanted.has(p.pageNumber))
        .sort((a, b) => a.pageNumber - b.pageNumber);
    if (!pages.length) {
        throw new Error(`Could not rasterize pages ${wantedPages.join(', ')} — are they within the PDF?`);
    }

    let qaHints: GroupCallContext['qaHints'] = {};
    try {
        qaHints = ((await getQAHints(slug)) || {}) as GroupCallContext['qaHints'];
    } catch (err) {
        console.warn(`⚠️ getQAHints('${slug}') failed: ${(err as Error).message}`);
    }

    const { section_result_id: _strip, ...cleanRecord } = extractionRecord as Record<string, unknown> & {
        section_result_id?: string;
    };
    const renderedPages = pages.map((p) => p.pageNumber);
    const ctx: GroupCallContext = {
        sectionResultId,
        cleanRecord,
        activeSchema,
        qaHints,
        imageBlocks: pages.map((p) => ({
            type: 'image_url' as const,
            image_url: { url: `data:image/jpeg;base64,${p.jpeg.toString('base64')}`, detail: 'high' as const },
        })),
        renderedPages,
        operatorPrompt,
        model,
        reasoningEffort,
    };

    const plan = groups.map((name) => ({
        name,
        schema: groupSchemas.get(name)!,
        mode: resolveModeForGroup(requestedMode, cleanRecord[name]),
    }));

    console.log(
        `🎯 Directed re-extraction: section ${sectionResultId?.substring(0, 8)}... ` +
        plan.map((p) => `'${p.name}'(${p.mode})`).join(', ') +
        ` pages=[${renderedPages.join(', ')}] model=${model}` +
        (operatorPrompt ? ' (operator-prompted)' : ''),
    );

    const runOne = async (p: typeof plan[number]) => {
        const result = await runGroupCall(ctx, p.name, p.schema, p.mode);
        if (onGroupDone) {
            try {
                await onGroupDone(result);
            } catch (err) {
                console.warn(`⚠️ onGroupDone('${p.name}') failed: ${(err as Error).message}`);
            }
        }
        return result;
    };

    // First group alone (warms the prompt cache), the rest bounded-parallel —
    // same discipline as grouped QA.
    const [first, ...rest] = plan;
    const groupResults: DirectedGroupResult[] = [await runOne(first)];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(GROUP_CONCURRENCY, rest.length) }, async () => {
        while (true) {
            const i = cursor++;
            if (i >= rest.length) return;
            groupResults[i + 1] = await runOne(rest[i]);
        }
    });
    await Promise.all(workers);

    return { groupResults, renderedPages, model };
}

// ---------------------------------------------------------------------------
// Persistence — group-scoped, never touches other groups' findings
// ---------------------------------------------------------------------------

/**
 * Replace the OPEN findings of ONE group with the directed re-extraction's
 * findings. Other groups' findings and dismissed findings are untouched
 * (deliberately narrower than saveQAFindings, which clears the section).
 * Refreshes section_qa_runs.findings_count when a run row exists; never
 * creates one — a directed re-extraction is not a section QA pass.
 */
export async function saveDirectedReextractionFindings({
    fileId,
    sectionResultId,
    groupName,
    findings,
    model = REEXTRACT_MODEL,
}: {
    fileId: string;
    sectionResultId: string;
    groupName: string;
    findings: DirectedFinding[];
    model?: string;
}): Promise<unknown[]> {
    const overallQuality = deriveQualityFromFindings(findings);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(
            `DELETE FROM section_qa_findings
             WHERE file_id = $1 AND section_result_id = $2 AND status = 'open'
               AND (field_path = $3 OR field_path LIKE $4 OR field_path LIKE $5)`,
            [fileId, sectionResultId, groupName, `${groupName}.%`, `${groupName}[%`],
        );

        const rows: unknown[] = [];
        for (const finding of findings) {
            const result = await client.query(
                `INSERT INTO section_qa_findings
                    (file_id, section_result_id, field_path, issue_type, severity,
                     expected, actual, corrected_value, row_index, row_value, explanation, status, overall_quality, qa_model)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, 'open', $12, $13)
                 ON CONFLICT (file_id, section_result_id, field_path, issue_type, row_index)
                 DO UPDATE SET
                     severity = EXCLUDED.severity,
                     expected = EXCLUDED.expected,
                     actual = EXCLUDED.actual,
                     corrected_value = EXCLUDED.corrected_value,
                     row_value = EXCLUDED.row_value,
                     explanation = EXCLUDED.explanation,
                     overall_quality = EXCLUDED.overall_quality,
                     qa_model = EXCLUDED.qa_model,
                     updated_at = NOW()
                 RETURNING *`,
                [
                    fileId,
                    sectionResultId,
                    finding.field,
                    finding.issue_type,
                    finding.severity,
                    finding.expected,
                    finding.actual,
                    finding.corrected_value !== undefined ? JSON.stringify(finding.corrected_value) : null,
                    Number.isInteger(finding.row_index) ? finding.row_index : null,
                    // Already a JSON-encoded string (or null) — ::jsonb parses it.
                    finding.row_value ?? null,
                    finding.explanation,
                    overallQuality,
                    model,
                ],
            );
            rows.push(result.rows[0]);
        }

        // Keep the run row's count honest if QA has run on this section before.
        await client.query(
            `UPDATE section_qa_runs SET
                 findings_count = (
                     SELECT COUNT(*) FROM section_qa_findings
                     WHERE file_id = $1 AND section_result_id = $2 AND status = 'open'
                 ),
                 updated_at = NOW()
             WHERE file_id = $1 AND section_result_id = $2`,
            [fileId, sectionResultId],
        );

        await client.query('COMMIT');
        return rows;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------
// Queue plumbing — requests table + rex:<requestId> mode strings
// ---------------------------------------------------------------------------

const REX_MODE_PREFIX = 'rex:';

export function buildRexMode(requestId: string): string {
    return `${REX_MODE_PREFIX}${requestId}`;
}

/** @returns the requestId, or null when the mode is not a rex mode. */
export function parseRexMode(mode: unknown): string | null {
    if (typeof mode !== 'string' || !mode.startsWith(REX_MODE_PREFIX)) return null;
    const requestId = mode.slice(REX_MODE_PREFIX.length);
    return requestId || null;
}

export type ReextractionRequestRow = {
    id: string;
    file_id: string;
    section_result_id: string;
    slug: string;
    groups: string[];
    pages: number[];
    prompt: string | null;
    mode: DirectedMode;
    model: string | null;
    status: 'queued' | 'processing' | 'completed' | 'failed';
    error: string | null;
    result: unknown;
    requested_by: string | null;
    created_at: string;
    updated_at: string;
};

export async function createReextractionRequest({
    fileId,
    sectionResultId,
    slug,
    groups,
    pages,
    prompt = null,
    mode = 'auto',
    model = null,
    requestedBy = null,
}: {
    fileId: string;
    sectionResultId: string;
    slug: string;
    groups: string[];
    pages: number[];
    prompt?: string | null;
    mode?: DirectedMode;
    model?: string | null;
    requestedBy?: string | null;
}): Promise<ReextractionRequestRow> {
    const result = await pool.query(
        `INSERT INTO directed_reextraction_requests
            (file_id, section_result_id, slug, groups, pages, prompt, mode, model, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [fileId, sectionResultId, slug, groups, pages, prompt, mode, model, requestedBy],
    );
    return result.rows[0];
}

export type PromptSuggestion = {
    prompt: string;
    uses: number;
    last_used_at: string;
    same_slug: boolean;
};

/**
 * Operator-note suggestions for the "What's wrong?" field, mined from past
 * requests (the requests table is the memory of what operators keep typing).
 * Same-slug notes rank first — failure modes repeat within a document type —
 * then recency; identical notes collapse with a usage count.
 */
export async function getPromptSuggestions({
    slug,
    limit = 8,
}: {
    slug: string;
    limit?: number;
}): Promise<PromptSuggestion[]> {
    const result = await pool.query(
        `SELECT trim(prompt) AS prompt,
                COUNT(*)::int AS uses,
                MAX(created_at) AS last_used_at,
                BOOL_OR(slug = $1) AS same_slug
         FROM directed_reextraction_requests
         WHERE prompt IS NOT NULL AND length(trim(prompt)) > 0
         GROUP BY trim(prompt)
         ORDER BY BOOL_OR(slug = $1) DESC, MAX(created_at) DESC
         LIMIT $2`,
        [slug, limit],
    );
    return result.rows;
}

/** Requests currently queued or running for a file (dedupe + UI hydration). */
export async function getActiveReextractionRequests(fileId: string): Promise<ReextractionRequestRow[]> {
    const result = await pool.query(
        `SELECT * FROM directed_reextraction_requests
         WHERE file_id = $1 AND status IN ('queued', 'processing')
         ORDER BY created_at`,
        [fileId],
    );
    return result.rows;
}

async function updateRequestStatus(
    requestId: string,
    fields: { status?: string; error?: string | null; result?: unknown },
): Promise<void> {
    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [requestId];
    if (fields.status !== undefined) {
        params.push(fields.status);
        sets.push(`status = $${params.length}`);
    }
    if (fields.error !== undefined) {
        params.push(fields.error);
        sets.push(`error = $${params.length}`);
    }
    if (fields.result !== undefined) {
        params.push(JSON.stringify(fields.result));
        sets.push(`result = $${params.length}::jsonb`);
    }
    await pool.query(
        `UPDATE directed_reextraction_requests SET ${sets.join(', ')} WHERE id = $1`,
        params,
    );
}

// ---------------------------------------------------------------------------
// Worker job — load request, run groups, save incrementally, record outcome
// ---------------------------------------------------------------------------

export type ReextractionProgressEvent = {
    status: 'started' | 'group_done' | 'done' | 'failed';
    requestId: string;
    sectionResultId: string;
    groups: string[];
    group?: string;
    modeUsed?: 'full' | 'patch';
    findings?: unknown[];
    findingsCount?: number;
    totalFindings?: number;
    failedGroups?: string[];
    message?: string;
};

/**
 * Execute one queued directed re-extraction request end-to-end (worker
 * side). Per-group failures degrade — findings from the groups that
 * succeeded are saved and reported; the request only fails wholesale when
 * setup fails or EVERY group errored.
 */
export async function runDirectedReextractionJob({
    requestId,
    onProgress = null,
}: {
    requestId: string;
    onProgress?: ((evt: ReextractionProgressEvent) => void) | null;
}): Promise<{ totalFindings: number; failedGroups: string[] }> {
    const emit = (evt: ReextractionProgressEvent) => {
        try {
            onProgress?.(evt);
        } catch (err) {
            console.warn(`⚠️ reextract progress callback failed: ${(err as Error).message}`);
        }
    };

    const reqRes = await pool.query(
        `SELECT * FROM directed_reextraction_requests WHERE id = $1`,
        [requestId],
    );
    const request: ReextractionRequestRow | undefined = reqRes.rows[0];
    if (!request) {
        throw new Error(`Directed re-extraction request ${requestId} not found`);
    }
    const base = {
        requestId,
        sectionResultId: request.section_result_id,
        groups: request.groups,
    };

    try {
        await updateRequestStatus(requestId, { status: 'processing' });

        const file = await getFileResult(request.file_id);
        if (!file) throw new Error('File not found');
        if (!file.s3_key) throw new Error('File has no S3 key');

        const record = (file.result?.[request.slug] ?? []).find(
            (r: { section_result_id?: string }) => r?.section_result_id === request.section_result_id,
        );
        if (!record) {
            throw new Error(`No extraction record for section '${request.section_result_id}'`);
        }

        const pdfBuffer = await new S3Service().downloadFile(file.s3_key);

        emit({ status: 'started', ...base });

        let totalFindings = 0;
        const { groupResults } = await runDirectedReextraction({
            sectionResultId: request.section_result_id,
            slug: request.slug,
            groups: request.groups,
            pageNumbers: request.pages,
            operatorPrompt: request.prompt,
            extractionRecord: record,
            pdfBuffer,
            requestedMode: request.mode,
            ...(request.model ? { model: request.model } : {}),
            onGroupDone: async (gr) => {
                if (gr.error) {
                    emit({ status: 'group_done', ...base, group: gr.group, modeUsed: gr.modeUsed, findingsCount: 0, message: gr.error });
                    return;
                }
                const saved = await saveDirectedReextractionFindings({
                    fileId: request.file_id,
                    sectionResultId: request.section_result_id,
                    groupName: gr.group,
                    findings: gr.findings,
                    model: request.model || undefined,
                });
                totalFindings += saved.length;
                emit({
                    status: 'group_done',
                    ...base,
                    group: gr.group,
                    modeUsed: gr.modeUsed,
                    findings: saved,
                    findingsCount: saved.length,
                });
            },
        });

        const failedGroups = groupResults.filter((g) => g.error).map((g) => g.group);
        const outcome = groupResults.map((g) => ({
            group: g.group,
            mode_used: g.modeUsed,
            findings_count: g.findings.length,
            suppressed_deletes: g.suppressedDeletes,
            duration_ms: g.durationMs,
            tokens: g.tokens,
            ...(g.error ? { error: g.error } : {}),
            ...(g.newValue !== undefined && Array.isArray(g.newValue)
                ? { reread_rows: g.newValue.length }
                : {}),
        }));

        if (failedGroups.length === request.groups.length) {
            await updateRequestStatus(requestId, {
                status: 'failed',
                error: `All groups failed: ${failedGroups.join(', ')}`,
                result: outcome,
            });
            emit({ status: 'failed', ...base, failedGroups, message: `All groups failed: ${failedGroups.join(', ')}` });
            return { totalFindings: 0, failedGroups };
        }

        await updateRequestStatus(requestId, { status: 'completed', error: null, result: outcome });
        emit({ status: 'done', ...base, totalFindings, failedGroups });
        console.log(
            `✅ Directed re-extraction ${requestId.substring(0, 8)}... complete: ` +
            `${totalFindings} finding(s) across ${request.groups.length} group(s)` +
            (failedGroups.length ? `, failed: ${failedGroups.join(', ')}` : ''),
        );
        return { totalFindings, failedGroups };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await updateRequestStatus(requestId, { status: 'failed', error: message }).catch(() => {});
        emit({ status: 'failed', ...base, message });
        throw err;
    }
}

export default {
    runDirectedReextraction,
    runDirectedReextractionJob,
    saveDirectedReextractionFindings,
    createReextractionRequest,
    getActiveReextractionRequests,
    buildRexMode,
    parseRexMode,
    diffGroupValue,
    resolveModeForGroup,
};
