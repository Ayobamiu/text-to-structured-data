/**
 * Section QA Service
 *
 * Post-extraction quality assurance using a vision model.
 * Shows the VLM a page image + extraction result side by side —
 * exactly what a human QA reviewer does — and asks "what's wrong?"
 *
 * Findings are stored in section_qa_findings (one row per issue).
 * Existing open findings for a section are replaced on re-run.
 * Dismissed findings are never overwritten.
 */

import OpenAI from 'openai';
import pool from '../database.js';
import { getActiveSchema, getQAHints } from './schemaRegistry.js';
import {
    buildSectionQASystemPrompt,
    buildSectionQAUserText,
    buildSectionQAResponseFormat,
    buildGroupQACachedSystemPrompt,
    buildGroupQASharedUserText,
    buildGroupQAGroupInstruction,
    buildGroupQABatchInstruction,
    buildGroupQAResponseFormat,
} from '../config/openaiPrompts.ts';

// Default QA model — overridable via env (QA_MODEL) or per-call (model arg /
// request body) so we can A/B against other vision+JSON models. gpt-4o-mini
// was too weak at cross-referencing a full extraction JSON against page
// images in one shot (missed real errors, flagged trivial fields); gpt-5.5
// supports vision input + strict structured outputs and is OpenAI's current
// flagship reasoning model. Meaningfully more expensive per call — drop back
// to a cheaper model via QA_MODEL if cost becomes the binding constraint.
const QA_MODEL = process.env.QA_MODEL || 'gpt-5.5';
const IMAGE_WIDTH = 1024; // Higher res than classifier — need to read actual values
const IMAGE_QUALITY = 90;
// Multi-page sections: cap how many page images we send to one QA call. Each
// image is ~25k input tokens at detail:'high', so this bounds cost/latency.
// Sections longer than this are QA'd on their first MAX_QA_PAGES pages.
const MAX_QA_PAGES = 4;

let _openaiClient = null;
function openai() {
    if (_openaiClient) return _openaiClient;
    _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _openaiClient;
}

// ─── Rate-limit resilience ───────────────────────────────────────────
// Running QA on many sections at once (the "QA all" flow) fans out
// N_sections × GROUP_QA_CONCURRENCY simultaneous vision calls. A burst like
// that can 429 every group of one section at the same moment, which turns
// into a thrown run ("all group QA calls failed") even though a retry a few
// seconds later succeeds — observed in production on an 8-section run.
// Two guards:
//   1. A process-wide semaphore caps concurrent QA calls across ALL in-flight
//      sections (per-section GROUP_QA_CONCURRENCY still applies beneath it).
//   2. Each call retries transient failures (429/5xx/network) with
//      exponential backoff. The slot is released while sleeping so a stalled
//      retry never starves other sections.
const QA_GLOBAL_CONCURRENCY = Math.max(1, parseInt(process.env.QA_GLOBAL_CONCURRENCY || '6', 10) || 6);
const QA_RETRY_ATTEMPTS = 3;

function makeSemaphore(max) {
    let active = 0;
    const queue = [];
    const runNext = () => {
        if (active < max && queue.length > 0) {
            active++;
            queue.shift()();
        }
    };
    return {
        async run(fn) {
            await new Promise((resolve) => { queue.push(resolve); runNext(); });
            try {
                return await fn();
            } finally {
                active--;
                runNext();
            }
        },
    };
}
const qaCallSemaphore = makeSemaphore(QA_GLOBAL_CONCURRENCY);

const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_NET_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);
function isTransientQAError(err) {
    if (!err) return false;
    if (RETRYABLE_HTTP_STATUS.has(err.status)) return true;
    if (RETRYABLE_NET_CODES.has(err.code) || RETRYABLE_NET_CODES.has(err.cause?.code)) return true;
    return /timed? ?out|connection error/i.test(err.message || '');
}

/**
 * Run one OpenAI QA call under the global semaphore, retrying transient
 * failures (up to QA_RETRY_ATTEMPTS total attempts, ~1s/4s backoff + jitter).
 * Non-transient errors (400s, parse errors) surface immediately.
 */
async function callQAWithRetry(label, fn) {
    let lastErr;
    for (let attempt = 1; attempt <= QA_RETRY_ATTEMPTS; attempt++) {
        try {
            return await qaCallSemaphore.run(fn);
        } catch (err) {
            lastErr = err;
            if (attempt === QA_RETRY_ATTEMPTS || !isTransientQAError(err)) throw err;
            const delayMs = Math.round(1000 * 4 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
            console.warn(
                `⚠️ ${label}: transient failure on attempt ${attempt}/${QA_RETRY_ATTEMPTS} ` +
                `(${err.status || err.code || err.message}) — retrying in ${delayMs}ms`
            );
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    throw lastErr;
}

// ─── False-positive filtering ────────────────────────────────────────
// Prompts (system prompt, field hints, response schema) live in
// ../config/openaiPrompts.ts — single source of truth. This service keeps
// only the processing logic, including a last line of defence that drops
// no-op findings the model still occasionally emits.

// Strings the model uses to mean "blank/absent". Normalized away so a finding
// whose page value and extracted value are both empty is treated as a non-issue.
const EMPTY_TOKENS = new Set(['', 'null', 'n/a', 'na', 'none', 'nil', '-', '–', 'unknown', 'undefined']);

// Tokens the model uses on either side of a boolean field's comparison — form
// labels ("Yes"/"No"), checkbox transcriptions ("checked"/"x"), and the raw
// boolean/string themselves. Mirrors the client-side coercion in
// web/src/lib/jsonPath.ts (coerceExpected) so a boolean `false` compared
// against a page reading "No" is recognised as the same value instead of a
// textual mismatch.
const BOOLEAN_TRUE_TOKENS = new Set(['true', 'yes', 'y', 'checked', 'check', 'x', 'present']);
const BOOLEAN_FALSE_TOKENS = new Set(['false', 'no', 'n', 'unchecked', 'absent']);

function normalizeQAValue(v) {
    if (v == null) return '';
    return String(v).trim().toLowerCase();
}

function isEmptyQAValue(v) {
    return EMPTY_TOKENS.has(normalizeQAValue(v));
}

/** Resolve a value to a boolean when it's a real boolean or a recognised yes/no-style token; undefined otherwise. */
function toBooleanToken(v) {
    if (typeof v === 'boolean') return v;
    const s = normalizeQAValue(v);
    if (BOOLEAN_TRUE_TOKENS.has(s)) return true;
    if (BOOLEAN_FALSE_TOKENS.has(s)) return false;
    return undefined;
}

/**
 * Equality used throughout QA comparison: case/whitespace-insensitive, treats
 * all "blank" tokens as equal, treats yes/no/checked-style tokens as boolean
 * synonyms when both sides are boolean-shaped, and compares numerically when
 * both sides parse as numbers (so "5.5'" == 5.5, "3.0" == "3").
 */
export function qaValuesEqual(a, b) {
    if (isEmptyQAValue(a) && isEmptyQAValue(b)) return true;
    if (normalizeQAValue(a) === normalizeQAValue(b)) return true;

    const boolA = toBooleanToken(a);
    const boolB = toBooleanToken(b);
    if (boolA !== undefined && boolB !== undefined) return boolA === boolB;

    const na = parseFloat(a);
    const nb = parseFloat(b);
    return !Number.isNaN(na) && !Number.isNaN(nb) && na === nb;
}

/**
 * True when a finding is a no-op and should be discarded:
 *   - page value and extracted value are both empty/placeholder, OR
 *   - expected and actual are equal after normalization.
 * Catches the "expected == actual" hallucinations that the literal
 * `expected !== actual` check missed (e.g. "Null" vs null, "3.0" vs "3").
 */
export function isNoOpFinding(issue) {
    return qaValuesEqual(issue?.expected, issue?.actual);
}

// ─── Verify findings against the real extraction record ──────────────
// The model frequently MISQUOTES `actual` — it reports an extracted value that
// isn't actually in the JSON we gave it, manufacturing a fake discrepancy.
// We own the extraction record, so we don't have to trust the model's `actual`:
// resolve the field path in the real record, OVERWRITE `actual` with the truth,
// and drop the finding when the page value (`expected`) already equals it.

// Row-count issues reference the array itself, not a scalar value — skip the
// value-substitution logic for them (a "row count" can't be compared to a cell).
const ROW_ISSUE_TYPES = new Set(['missing_rows', 'extra_rows', 'wrong_count']);

// Actionable row-level ops: delete/add/update ONE specific array item.
// Distinct from ROW_ISSUE_TYPES above — those stay diagnostic-only for when
// the model can tell a count is wrong but can't identify which row is at
// fault; these carry enough (row_index/row_value) to actually apply a fix.
const STRUCTURED_ROW_ISSUE_TYPES = new Set(['add_row', 'update_row', 'delete_row']);

/** Read a dot/bracket path ("a.b[2].c") out of an object. */
export function readFieldPath(obj, path) {
    if (obj == null || !path) return undefined;
    const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = obj;
    for (const p of parts) {
        if (cur == null) return undefined;
        cur = cur[p];
    }
    return cur;
}

function toActualString(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

/**
 * Equality for a model-supplied `corrected_value` (already typed — string,
 * number, boolean, or null) against the real value read from the record.
 * Unlike `qaValuesEqual`, this trusts the types directly instead of
 * re-deriving meaning from text: a boolean `corrected_value` is compared by
 * strict identity, not by guessing whether some page-text quote means true
 * or false. Falls back to `qaValuesEqual`'s string/numeric normalization
 * only when neither side is a boolean/number (e.g. plain text fields).
 */
function correctedValueEquals(correctedValue, realValue) {
    if (correctedValue === null && realValue == null) return true;
    if (typeof correctedValue === 'boolean' || typeof realValue === 'boolean') {
        return correctedValue === realValue;
    }
    if (typeof correctedValue === 'number' && typeof realValue === 'number') {
        return correctedValue === realValue;
    }
    return qaValuesEqual(correctedValue, realValue);
}

// ─── Schema-aware helpers (per-group QA + enum backstop) ─────────────

/**
 * Split an extraction schema into its top-level groups, one per property.
 * Each group's sub-schema is small enough to inline verbatim into a prompt
 * (enums included) — this is what fixes the "model never saw the enum"
 * failure mode the whole-record prompt had for large schemas.
 *
 * @param {object|string|null} jsonSchema  Active schema (object or JSON string)
 * @returns {Array<{ name: string, schema: object }>}
 */
export function splitSchemaIntoGroups(jsonSchema) {
    let schema = jsonSchema;
    if (typeof schema === 'string') {
        try { schema = JSON.parse(schema); } catch { return []; }
    }
    const props = schema?.properties;
    if (!props || typeof props !== 'object') return [];
    return Object.entries(props)
        .filter(([, def]) => def && typeof def === 'object')
        .map(([name, def]) => ({ name, schema: def }));
}

/** Unwrap anyOf wrappers (the schemas use anyOf:[{type:X},{type:null}] for nullables). */
function unwrapAnyOf(schema) {
    if (schema?.anyOf && Array.isArray(schema.anyOf)) {
        // Prefer the non-null member — that's where properties/items/enum live.
        return schema.anyOf.find((m) => m && m.type !== 'null') ?? schema.anyOf[0];
    }
    return schema;
}

/**
 * Walk a dot/bracket path ("samples_collected[0].sample_type") through a JSON
 * Schema and return the sub-schema for that field, or null when the path
 * doesn't resolve. Numeric segments step into `items`.
 */
export function resolveSchemaForPath(rootSchema, path) {
    let schema = rootSchema;
    if (typeof schema === 'string') {
        try { schema = JSON.parse(schema); } catch { return null; }
    }
    if (!schema || !path) return null;

    const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = schema;
    for (const p of parts) {
        cur = unwrapAnyOf(cur);
        if (!cur || typeof cur !== 'object') return null;
        if (/^\d+$/.test(p)) {
            cur = cur.items;
        } else {
            cur = cur.properties?.[p];
        }
        if (!cur) return null;
    }
    return unwrapAnyOf(cur) ?? null;
}

/** Pull the enum list off a field schema (handles anyOf-wrapped enums). Null if not an enum field. */
export function extractEnumValues(fieldSchema) {
    const s = unwrapAnyOf(fieldSchema);
    return Array.isArray(s?.enum) ? s.enum : null;
}

/**
 * Enum backstop: a corrected_value for an enum-typed field must be one of the
 * declared values. Try a light normalization ("Hollow Stem Auger" →
 * "hollow_stem_auger") to rescue near-misses; return null when no legal value
 * matches — better to show a finding without a one-click fix than an
 * applicable-but-illegal one ("water sample" is not a sample_type).
 */
export function coerceToEnum(candidate, enumValues) {
    if (candidate == null || !Array.isArray(enumValues)) return null;
    if (enumValues.includes(candidate)) return candidate;
    const norm = String(candidate).trim().toLowerCase().replace(/[\s-]+/g, '_');
    return enumValues.find((v) => String(v).toLowerCase() === norm) ?? null;
}

/** Shallow key-by-key equality for two plain row objects (order-independent, tolerant like qaValuesEqual). */
function rowsShallowEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
        if (!qaValuesEqual(toActualString(a[key]), toActualString(b[key]))) return false;
    }
    return true;
}

/**
 * Verify a delete_row/add_row/update_row finding against the real array.
 * Never trusts the model's row_index/row_value blindly:
 *   - the target field must resolve to a real array, or the finding is dropped
 *   - row_index (delete_row/update_row) must be a valid in-range integer
 *   - row_value (add_row/update_row) must parse as JSON
 *   - update_row is dropped as a no-op when the proposed row already matches
 *   - add_row is dropped when the proposed row is a near-duplicate of an
 *     existing item (the model re-adding something that's already there)
 */
function verifyStructuredRowFinding(issue, record, rootSchema = null) {
    // The model is instructed to give the BARE array path for row-level
    // findings (row_index carries the position), but — same lesson as
    // verifyFindingAgainstRecord not trusting `actual` — don't assume it
    // always complies. Strip a trailing "[N]" so "lithology_intervals[3]"
    // still resolves to the array instead of resolving to the row object at
    // index 3 and silently failing the isArray check.
    const arrayPath = String(issue?.field ?? '').replace(/\[\d+\]$/, '');
    const array = readFieldPath(record, arrayPath);
    if (!Array.isArray(array)) {
        return { keep: false, issue }; // target isn't really an array — nothing to act on
    }

    let rowValue;
    if (issue.row_value != null) {
        try {
            rowValue = JSON.parse(issue.row_value);
        } catch {
            return { keep: false, issue }; // malformed JSON — can't verify or apply it
        }
        // Schema guard: drop keys the array's item schema doesn't declare, so
        // an applied row can't violate additionalProperties:false downstream.
        if (rootSchema && rowValue && typeof rowValue === 'object' && !Array.isArray(rowValue)) {
            const itemSchema = resolveSchemaForPath(rootSchema, `${arrayPath}[0]`);
            const allowed = itemSchema?.properties;
            if (allowed && typeof allowed === 'object') {
                for (const key of Object.keys(rowValue)) {
                    if (!(key in allowed)) delete rowValue[key];
                }
                issue = { ...issue, row_value: JSON.stringify(rowValue) };
            }
        }
    }

    const issueType = issue.issue_type;

    if (issueType === 'delete_row' || issueType === 'update_row') {
        // Tolerate a numeric string in case row_index doesn't come back as a
        // real integer (schema declares integer, but don't take that for
        // granted any more than we take any other model output for granted).
        const rawIndex = issue.row_index;
        const idx =
            typeof rawIndex === 'string' && /^\d+$/.test(rawIndex)
                ? Number(rawIndex)
                : rawIndex;
        if (!Number.isInteger(idx) || idx < 0 || idx >= array.length) {
            return { keep: false, issue }; // hallucinated index
        }
        // Persist the coerced integer, not whatever raw shape row_index
        // arrived in (e.g. a numeric string) — saveQAFindings only accepts a
        // real integer for the row_index column.
        const corrected = { ...issue, row_index: idx, actual: toActualString(array[idx]) };
        if (issueType === 'update_row') {
            if (rowValue === undefined || rowsShallowEqual(rowValue, array[idx])) {
                return { keep: false, issue: corrected }; // no-op: proposed row already matches
            }
        }
        return { keep: true, issue: corrected };
    }

    // add_row
    if (rowValue === undefined || rowValue === null || typeof rowValue !== 'object' || Array.isArray(rowValue)) {
        return { keep: false, issue }; // no usable row content to add
    }
    if (array.some((item) => rowsShallowEqual(rowValue, item))) {
        return { keep: false, issue }; // model re-proposed a row that's already there
    }
    // row_index is an optional insertion HINT for add_row — coerce a numeric
    // string but don't drop the finding over it; null (append) is a safe
    // fallback rather than a reason to discard an otherwise-valid finding.
    const rawAddIndex = issue.row_index;
    const addIndex =
        typeof rawAddIndex === 'string' && /^\d+$/.test(rawAddIndex)
            ? Number(rawAddIndex)
            : rawAddIndex;
    return {
        keep: true,
        issue: {
            ...issue,
            row_index: Number.isInteger(addIndex) ? addIndex : null,
            actual: null,
        },
    };
}

/**
 * Reconcile one model finding against the real extraction record.
 * Returns { keep, issue } where `issue.actual` is corrected to ground truth.
 *
 * @param {object} issue       model-emitted finding (field, issue_type, expected, actual, corrected_value, ...)
 * @param {object} record      the extraction record that was sent to the model
 * @param {object} [rootSchema] active extraction schema — enables the enum
 *                              backstop (an illegal corrected_value for an
 *                              enum field is normalized or stripped) and
 *                              row_value key validation.
 */
export function verifyFindingAgainstRecord(issue, record, rootSchema = null) {
    // Actionable row-level ops: delete/add/update a specific array item.
    if (STRUCTURED_ROW_ISSUE_TYPES.has(issue?.issue_type)) {
        return verifyStructuredRowFinding(issue, record, rootSchema);
    }

    // Row-count issues: nothing to substitute; just drop obvious no-ops.
    if (ROW_ISSUE_TYPES.has(issue?.issue_type)) {
        return { keep: !isNoOpFinding(issue), issue };
    }

    const realValue = readFieldPath(record, issue?.field);
    const corrected = { ...issue, actual: toActualString(realValue) };

    // Enum backstop: never surface an applicable correction that the schema
    // forbids. "water sample" is not a legal sample_type — normalize it to a
    // declared enum value when possible, otherwise strip the correction and
    // keep the finding as informational (the discrepancy itself may be real).
    if (rootSchema && corrected.corrected_value != null) {
        const enumValues = extractEnumValues(resolveSchemaForPath(rootSchema, issue?.field));
        if (enumValues) {
            corrected.corrected_value = coerceToEnum(corrected.corrected_value, enumValues);
        }
    }

    // corrected_value is a typed answer (or an intentional null for
    // extra_value) — compare it directly against the real value instead of
    // string-coercing `expected`. This is what lets a boolean finding whose
    // `expected` is evidence text (e.g. "EOB = 68.0 FEET") rather than a
    // literal true/false still be verified and applied correctly.
    // NOTE: read from `corrected`, not `issue` — the enum backstop above may
    // have normalized or stripped an illegal correction, and the comparison
    // must see the backstopped value (a stripped correction falls through to
    // the legacy evidence-based comparison below).
    const hasCorrectedValue = corrected.corrected_value !== undefined;
    if (hasCorrectedValue && (corrected.corrected_value !== null || issue?.issue_type === 'extra_value')) {
        if (correctedValueEquals(corrected.corrected_value, realValue)) {
            return { keep: false, issue: corrected };
        }
        return { keep: true, issue: corrected };
    }

    // Legacy fallback: no usable corrected_value (older QA runs from before
    // this field existed, or the model omitted it) — fall back to comparing
    // the raw evidence quote against the real value.
    if (qaValuesEqual(corrected.expected, realValue)) return { keep: false, issue: corrected };
    if (isNoOpFinding(corrected)) return { keep: false, issue: corrected };

    return { keep: true, issue: corrected };
}

// ─── Core QA function ────────────────────────────────────────────────

/**
 * Run VLM QA on a single section.
 *
 * @param {object} params
 * @param {string} params.fileId
 * @param {string} params.sectionResultId
 * @param {string} params.slug           document_type_slug
 * @param {number[]} params.pageNumbers  extraction_pages for this section
 * @param {object} params.extractionRecord  the record from result envelope
 * @param {Buffer} params.pdfBuffer      raw PDF bytes (caller provides to avoid re-download)
 * @returns {Promise<{ findings: object[], overall_quality: string, summary: string, tokens: object }>}
 */
export async function runSectionQA({ fileId, sectionResultId, slug, pageNumbers, extractionRecord, pdfBuffer, model = QA_MODEL, batchGroups = null }) {
    const { rasterizePdf } = await import('./pdfRasterizer.js');

    // Pick the pages to QA: dedupe, sort, and cap at MAX_QA_PAGES so a long
    // section doesn't blow up cost/latency. extraction_pages can be
    // non-contiguous, so we rasterize the spanning range then keep the wanted
    // ones (pdftoppm only accepts a contiguous first..last range).
    const wantedPages = [...new Set(pageNumbers)]
        .filter((n) => Number.isInteger(n) && n > 0)
        .sort((a, b) => a - b)
        .slice(0, MAX_QA_PAGES);

    if (!wantedPages.length) {
        throw new Error('No valid pages to QA');
    }

    const rendered = await rasterizePdf(pdfBuffer, {
        firstPage: wantedPages[0],
        lastPage: wantedPages[wantedPages.length - 1],
        widthPx: IMAGE_WIDTH,
        jpegQuality: IMAGE_QUALITY,
    });

    const wanted = new Set(wantedPages);
    const pages = rendered
        .filter((p) => wanted.has(p.pageNumber))
        .sort((a, b) => a.pageNumber - b.pageNumber);

    if (!pages.length) {
        throw new Error(`Could not rasterize pages ${wantedPages.join(', ')} for QA`);
    }

    // Field hints + per-field-group review priority both come from the
    // registry (not hardcoded). Non-fatal: if the slug isn't registered, or
    // has no qa_hints set, QA just falls back to its generic prompt.
    let activeSchema = null;
    let qaHints = null;
    try {
        const active = await getActiveSchema(slug);
        activeSchema = active?.schema ?? null;
    } catch (err) {
        console.warn(`⚠️ getActiveSchema('${slug}') failed for QA prompt: ${err.message}`);
    }
    try {
        qaHints = await getQAHints(slug);
    } catch (err) {
        console.warn(`⚠️ getQAHints('${slug}') failed: ${err.message}`);
    }

    // Strip section_result_id from the record — not relevant for QA
    const { section_result_id: _strip, ...cleanRecord } = extractionRecord;

    const renderedPages = pages.map((p) => p.pageNumber);
    const imageBlocks = pages.map((p) => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${p.jpeg.toString('base64')}`, detail: 'high' },
    }));

    // Per-group review: one call per top-level schema group, each carrying
    // that group's FULL sub-schema (enums always visible — the whole-record
    // prompt had to truncate large schemas, which is how illegal enum
    // corrections like sample_type="water sample" slipped through). Falls
    // back to the legacy whole-record call when no schema is registered.
    const groups = splitSchemaIntoGroups(activeSchema);
    if (groups.length > 0) {
        return runGroupedQA({
            groups,
            qaHints: qaHints || {},
            activeSchema,
            cleanRecord,
            imageBlocks,
            renderedPages,
            pageCount: pages.length,
            sectionResultId,
            model,
            batchGroups,
        });
    }

    const response = await callQAWithRetry('QA (legacy whole-record)', () => openai().chat.completions.create({
        model,
        messages: [
            {
                role: 'system',
                content: buildSectionQASystemPrompt({ schema: activeSchema, pageCount: pages.length, qaHints }),
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: buildSectionQAUserText(cleanRecord, renderedPages) },
                    ...imageBlocks,
                ],
            },
        ],
        response_format: buildSectionQAResponseFormat(),
    }));

    const result = JSON.parse(response.choices[0].message.content);

    // Response is grouped by top-level schema field-group (see
    // buildSectionQAResponseFormat) so per-group qa_hints priority can steer
    // the model's attention within a single call. Flatten back to one issues
    // list — downstream verification/persistence doesn't need the grouping.
    const flatIssues = [];
    for (const g of result.groups || []) {
        for (const issue of g.issues || []) {
            flatIssues.push({ ...issue, _group: g.group });
        }
    }

    // Verify every finding against the real extraction record: correct the
    // model's `actual` to ground truth and drop findings where the page value
    // already matches it (the model's dominant false-positive mode — it
    // fabricates `actual` to manufacture a discrepancy).
    const validIssues = [];
    for (const issue of flatIssues) {
        const { keep, issue: verified } = verifyFindingAgainstRecord(issue, cleanRecord);
        if (keep) validIssues.push(verified);
    }

    if (flatIssues.length > 0) {
        const byGroup = new Map();
        for (const issue of flatIssues) byGroup.set(issue._group, (byGroup.get(issue._group) || 0) + 1);
        console.log(
            `   QA groups for ${sectionResultId?.substring(0, 8)}...: ` +
            [...byGroup.entries()].map(([g, n]) => `${g}(${n})`).join(', ')
        );
    }

    return {
        findings: validIssues,
        overall_quality: result.overall_quality,
        summary: result.summary,
        tokens: response.usage,
        model, // the model actually used (for storage + A/B reporting)
    };
}

// ─── Per-group QA orchestration ──────────────────────────────────────

/** Run up to `limit` async workers over `items`; results in input order. */
async function mapConcurrent(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    async function pump() {
        while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => pump()));
    return results;
}

/**
 * Derive overall_quality from the VERIFIED findings instead of trusting the
 * model's self-report — a model can claim "poor, 5 errors" while every one of
 * its findings gets dropped in verification, leaving quality and count
 * contradicting each other in the UI.
 */
export function deriveQualityFromFindings(findings) {
    if (!findings || findings.length === 0) return 'perfect';
    const errors = findings.filter((f) => f.severity === 'error').length;
    if (errors === 0) return 'good';
    return errors <= 2 ? 'acceptable' : 'poor';
}

/** One-line summary computed from verified findings, grouped by field-group. */
export function buildFindingsSummary(findings) {
    if (!findings || findings.length === 0) return 'No issues found.';
    const byGroup = new Map();
    for (const f of findings) {
        const g = f._group || String(f.field || '').split(/[.[]/)[0] || 'record';
        byGroup.set(g, (byGroup.get(g) || 0) + 1);
    }
    const parts = [...byGroup.entries()].map(([g, n]) => `${g} (${n})`);
    return `${findings.length} issue(s): ${parts.join(', ')}`;
}

// How many group calls run in parallel per section. Each call re-sends the
// page images, so this bounds burst token throughput, not total cost.
const GROUP_QA_CONCURRENCY = 3;

// Group batching (cost lever): the shared prefix (system → record → images)
// is ~83% of a section's prompt spend and OpenAI's cache retains big
// image-bearing prefixes unreliably (measured 0-60% hit rate on identical
// prefixes) — so the deterministic saving is sending the prefix FEWER times.
// critical/high-priority groups keep their own focused call; everything else
// is reviewed in shared batch calls of up to QA_BATCH_MAX_GROUPS.
const QA_BATCH_MAX_GROUPS = Math.max(2, parseInt(process.env.QA_BATCH_MAX_GROUPS || '8', 10) || 8);
const SOLO_PRIORITIES = new Set(['critical', 'high']);

/**
 * Partition reviewable groups into call "units": [{ groups: [...] }, ...].
 * Disabled → one unit per group (today's behavior). Enabled → groups whose
 * qa_hints priority is critical/high stay solo (focused attention); the rest
 * are chunked into batches of up to maxPerBatch, preserving schema order.
 * Pure — exported for tests.
 */
export function partitionGroupsForBatching(groups, qaHints = {}, { enabled = false, maxPerBatch = QA_BATCH_MAX_GROUPS } = {}) {
    if (!enabled) return groups.map((g) => ({ groups: [g] }));
    const units = [];
    let batch = [];
    for (const g of groups) {
        if (SOLO_PRIORITIES.has(qaHints[g.name]?.priority)) {
            units.push({ groups: [g] });
        } else {
            batch.push(g);
            if (batch.length >= maxPerBatch) { units.push({ groups: batch }); batch = []; }
        }
    }
    if (batch.length === 1) units.push({ groups: batch });      // lone leftover: same as solo
    else if (batch.length > 1) units.push({ groups: batch });
    return units;
}

/**
 * One QA call per schema group. Skips groups whose qa_hints entry sets
 * skip:true (e.g. extraction_metadata — pipeline housekeeping). A single
 * failed group call degrades to a warning instead of failing the section;
 * the run only throws when EVERY call failed.
 *
 * Cost: every call shares an identical prefix (generic system prompt → full
 * record → page images) with only the group instruction differing at the
 * tail, so OpenAI's automatic prompt caching bills the expensive image
 * tokens at the cached rate (~10x cheaper) for every call after the first.
 * The first call runs ALONE to warm the cache — concurrent identical-prefix
 * requests all miss it because the cache is written only after a request
 * finishes processing.
 */
async function runGroupedQA({ groups, qaHints, activeSchema, cleanRecord, imageBlocks, renderedPages, pageCount, sectionResultId, model, batchGroups = null }) {
    const toReview = groups.filter((g) => qaHints[g.name]?.skip !== true);
    const skipped = groups.length - toReview.length;

    // Switch: explicit per-call option (harness A/B) wins; otherwise the
    // QA_GROUP_BATCHING env var. Default off until validated per doc type.
    const batching = batchGroups != null ? batchGroups === true : process.env.QA_GROUP_BATCHING === 'true';
    const units = partitionGroupsForBatching(toReview, qaHints, { enabled: batching });

    console.log(
        `🔍 Per-group QA for ${sectionResultId?.substring(0, 8)}...: ` +
        `${toReview.length} group(s) in ${units.length} call(s)${batching ? ' [batched]' : ''}` +
        `${skipped > 0 ? ` (${skipped} skipped via qa_hints)` : ''} with ${model}`
    );

    const startedAt = Date.now();
    const totalTokens = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 };
    const failures = [];

    // Shared prefix — built ONCE, byte-identical across every group call.
    const systemPrompt = buildGroupQACachedSystemPrompt(pageCount);
    const sharedUserParts = [
        { type: 'text', text: buildGroupQASharedUserText(cleanRecord, renderedPages) },
        ...imageBlocks,
    ];

    async function qaOneUnit(unit) {
        const names = unit.groups.map((g) => g.name);
        const label = names.join('+');
        try {
            const instruction = unit.groups.length === 1
                ? buildGroupQAGroupInstruction({
                    groupName: unit.groups[0].name,
                    groupSchema: unit.groups[0].schema,
                    groupValue: cleanRecord[unit.groups[0].name],
                    hint: qaHints[unit.groups[0].name] || null,
                })
                : buildGroupQABatchInstruction({
                    groups: unit.groups.map((g) => ({
                        name: g.name,
                        schema: g.schema,
                        value: cleanRecord[g.name],
                        hint: qaHints[g.name] || null,
                    })),
                });

            const response = await callQAWithRetry(`QA call '${label}'`, () => openai().chat.completions.create({
                model,
                // All calls of one section share a byte-identical prefix
                // (system prompt → record → page images). OpenAI routes
                // requests to prompt-cache shards by prefix hash + this key;
                // without it, the concurrent fan-out lands on different
                // shards and misses (observed: 0-60% cached vs ~85% possible).
                prompt_cache_key: `section-qa-${sectionResultId}`,
                messages: [
                    { role: 'system', content: systemPrompt },
                    {
                        role: 'user',
                        content: [
                            ...sharedUserParts,
                            // Unit-specific instruction LAST — everything
                            // before this point is the shared cache prefix.
                            { type: 'text', text: instruction },
                        ],
                    },
                ],
                response_format: buildGroupQAResponseFormat(),
            }));

            totalTokens.prompt_tokens += response.usage?.prompt_tokens || 0;
            totalTokens.completion_tokens += response.usage?.completion_tokens || 0;
            totalTokens.total_tokens += response.usage?.total_tokens || 0;
            totalTokens.cached_tokens += response.usage?.prompt_tokens_details?.cached_tokens || 0;
            // Per-call breakdown: prompt − cached on a post-warm-up call ≈ the
            // instruction (sub-schema) size; cached ≈ shared-prefix credit.
            // This is the data that decides which cost lever matters per
            // section shape (prefix caching vs batching vs tiering).
            console.log(
                `      qa-call group='${label}' prompt=${response.usage?.prompt_tokens || 0} ` +
                `cached=${response.usage?.prompt_tokens_details?.cached_tokens || 0} ` +
                `completion=${response.usage?.completion_tokens || 0}`
            );

            const result = JSON.parse(response.choices[0].message.content);
            // Focus guard: this call reviews ONLY the unit's groups — drop
            // anything the model flagged outside them (it sees the full
            // record as context and occasionally wanders).
            const inUnit = (f) => names.some((n) => f === n || f.startsWith(`${n}.`) || f.startsWith(`${n}[`));
            return (result.issues || [])
                .filter((issue) => inUnit(String(issue?.field || '')))
                .map((issue) => {
                    const root = String(issue?.field || '').split(/[.[]/)[0];
                    return { ...issue, _group: root };
                });
        } catch (err) {
            console.warn(`⚠️ QA call failed for '${label}': ${err.message}`);
            failures.push(label);
            return [];
        }
    }

    // Warm the cache with the first unit alone, then fan out the rest.
    const [firstUnit, ...restUnits] = units;
    const firstIssues = firstUnit ? await qaOneUnit(firstUnit) : [];
    const restIssues = await mapConcurrent(restUnits, GROUP_QA_CONCURRENCY, qaOneUnit);
    const perGroupIssues = [firstIssues, ...restIssues];

    if (failures.length === units.length && units.length > 0) {
        throw new Error(`All ${units.length} QA calls failed (${failures.join(', ')})`);
    }

    // Same verification as always — nothing the model says is trusted until
    // it's been checked against the real record and (now) the real schema.
    const validIssues = [];
    for (const issue of perGroupIssues.flat()) {
        const { keep, issue: verified } = verifyFindingAgainstRecord(issue, cleanRecord, activeSchema);
        if (keep) validIssues.push(verified);
    }

    const overall_quality = deriveQualityFromFindings(validIssues);
    const summary = buildFindingsSummary(validIssues);

    console.log(
        `   Per-group QA done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ` +
        `${validIssues.length} finding(s), quality=${overall_quality}, ${totalTokens.total_tokens} tokens ` +
        `(${totalTokens.cached_tokens} cached)` +
        (failures.length ? `, failed groups: ${failures.join(', ')}` : '')
    );

    return {
        findings: validIssues,
        overall_quality,
        summary,
        tokens: totalTokens,
        model,
    };
}

// ─── DB persistence ──────────────────────────────────────────────────

/**
 * Save QA findings to DB.
 * Replaces existing OPEN findings for the section.
 * Never overwrites dismissed findings.
 *
 * @param {object} params
 * @param {string} params.fileId
 * @param {string} params.sectionResultId
 * @param {object[]} params.findings
 * @param {string} params.overall_quality
 * @returns {Promise<object[]>} the saved finding rows
 */
export async function saveQAFindings({ fileId, sectionResultId, findings, overall_quality, summary = null, qaModel = QA_MODEL, tokens = null }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Delete existing OPEN findings for this section (keep dismissed ones)
        await client.query(
            `DELETE FROM section_qa_findings
             WHERE file_id = $1 AND section_result_id = $2 AND status = 'open'`,
            [fileId, sectionResultId]
        );

        // Record the run itself (incl. clean passes) so the UI can tell a
        // QA'd-clean section from a never-QA'd one across reloads. Token
        // telemetry (add_tokens_to_section_qa_runs migration) is written only
        // when the column exists — code deployed before the migration must
        // not break QA saves (the ON CONFLICT incident of 2026-07-11 was
        // exactly this class of code/DB skew).
        const withTokens = await sectionQARunsHasTokensColumn(client);
        if (withTokens) {
            await client.query(
                `INSERT INTO section_qa_runs
                    (file_id, section_result_id, overall_quality, summary, findings_count, qa_model, tokens, last_qa_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW(), NOW())
                 ON CONFLICT (file_id, section_result_id)
                 DO UPDATE SET
                     overall_quality = EXCLUDED.overall_quality,
                     summary = EXCLUDED.summary,
                     findings_count = EXCLUDED.findings_count,
                     qa_model = EXCLUDED.qa_model,
                     tokens = EXCLUDED.tokens,
                     last_qa_at = NOW(),
                     updated_at = NOW()`,
                [fileId, sectionResultId, overall_quality, summary, findings.length, qaModel, tokens ? JSON.stringify(tokens) : null]
            );
        } else {
            await client.query(
                `INSERT INTO section_qa_runs
                    (file_id, section_result_id, overall_quality, summary, findings_count, qa_model, last_qa_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
                 ON CONFLICT (file_id, section_result_id)
                 DO UPDATE SET
                     overall_quality = EXCLUDED.overall_quality,
                     summary = EXCLUDED.summary,
                     findings_count = EXCLUDED.findings_count,
                     qa_model = EXCLUDED.qa_model,
                     last_qa_at = NOW(),
                     updated_at = NOW()`,
                [fileId, sectionResultId, overall_quality, summary, findings.length, qaModel]
            );
        }

        if (findings.length === 0) {
            await client.query('COMMIT');
            return [];
        }

        // Insert new findings
        const rows = [];
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
                    // row_value is already a JSON-encoded string per the model's
                    // response schema (see SECTION_QA_ISSUE_SCHEMA) — pass it
                    // through as-is and let ::jsonb parse it. Do NOT
                    // JSON.stringify it again, that would double-encode it into
                    // an escaped string literal instead of a real jsonb object.
                    finding.row_value ?? null,
                    finding.explanation,
                    overall_quality,
                    qaModel,
                ]
            );
            rows.push(result.rows[0]);
        }

        await client.query('COMMIT');
        return rows;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Cached once per process: does section_qa_runs have the tokens column yet?
// (See the migration-tolerance note in saveQAFindings.)
let _tokensColumnPresent = null;
async function sectionQARunsHasTokensColumn(client) {
    if (_tokensColumnPresent !== null) return _tokensColumnPresent;
    try {
        const r = await client.query(
            `SELECT 1 FROM information_schema.columns
             WHERE table_name = 'section_qa_runs' AND column_name = 'tokens'`
        );
        _tokensColumnPresent = r.rows.length > 0;
        if (!_tokensColumnPresent) {
            console.warn('⚠️ section_qa_runs.tokens column missing — run migrations/add_tokens_to_section_qa_runs.js to enable QA cost telemetry');
        }
    } catch {
        _tokensColumnPresent = false;
    }
    return _tokensColumnPresent;
}

/**
 * Get all QA findings for a file, grouped by section_result_id.
 */
export async function getQAFindings(fileId) {
    const result = await pool.query(
        `SELECT * FROM section_qa_findings
         WHERE file_id = $1
         ORDER BY created_at DESC`,
        [fileId]
    );

    // Group by section_result_id
    const grouped = {};
    for (const row of result.rows) {
        const id = row.section_result_id;
        if (!grouped[id]) grouped[id] = [];
        grouped[id].push(row);
    }
    return grouped;
}

/**
 * Get the QA-run record for each section of a file, keyed by section_result_id.
 * Present for every section QA has run on (including clean, zero-finding runs).
 */
export async function getQARuns(fileId) {
    const result = await pool.query(
        `SELECT section_result_id, overall_quality, summary, findings_count, qa_model, last_qa_at
         FROM section_qa_runs
         WHERE file_id = $1`,
        [fileId]
    );
    const bySection = {};
    for (const row of result.rows) {
        bySection[row.section_result_id] = row;
    }
    return bySection;
}

/**
 * Update a single finding's status (accepted / dismissed).
 */
export async function updateQAFindingStatus(findingId, fileId, status) {
    const result = await pool.query(
        `UPDATE section_qa_findings
         SET status = $1, updated_at = NOW()
         WHERE id = $2 AND file_id = $3
         RETURNING *`,
        [status, findingId, fileId]
    );
    return result.rows[0] || null;
}

export default {
    runSectionQA,
    saveQAFindings,
    getQAFindings,
    getQARuns,
    updateQAFindingStatus,
};
