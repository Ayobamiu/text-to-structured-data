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
import { getActiveSchema } from './schemaRegistry.js';
import {
    buildSectionQASystemPrompt,
    buildSectionQAUserText,
    buildSectionQAResponseFormat,
} from '../config/openaiPrompts.ts';

const QA_MODEL = 'gpt-4o-mini';
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

// ─── False-positive filtering ────────────────────────────────────────
// Prompts (system prompt, field hints, response schema) live in
// ../config/openaiPrompts.ts — single source of truth. This service keeps
// only the processing logic, including a last line of defence that drops
// no-op findings the model still occasionally emits.

// Strings the model uses to mean "blank/absent". Normalized away so a finding
// whose page value and extracted value are both empty is treated as a non-issue.
const EMPTY_TOKENS = new Set(['', 'null', 'n/a', 'na', 'none', 'nil', '-', '–', 'unknown', 'undefined']);

function normalizeQAValue(v) {
    if (v == null) return '';
    return String(v).trim().toLowerCase();
}

function isEmptyQAValue(v) {
    return EMPTY_TOKENS.has(normalizeQAValue(v));
}

/**
 * Equality used throughout QA comparison: case/whitespace-insensitive, treats
 * all "blank" tokens as equal, and compares numerically when both sides parse
 * as numbers (so "5.5'" == 5.5, "3.0" == "3").
 */
export function qaValuesEqual(a, b) {
    if (isEmptyQAValue(a) && isEmptyQAValue(b)) return true;
    if (normalizeQAValue(a) === normalizeQAValue(b)) return true;
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
 * Reconcile one model finding against the real extraction record.
 * Returns { keep, issue } where `issue.actual` is corrected to ground truth.
 *
 * @param {object} issue   model-emitted finding (field, issue_type, expected, actual, ...)
 * @param {object} record  the extraction record that was sent to the model
 */
export function verifyFindingAgainstRecord(issue, record) {
    // Row-count issues: nothing to substitute; just drop obvious no-ops.
    if (ROW_ISSUE_TYPES.has(issue?.issue_type)) {
        return { keep: !isNoOpFinding(issue), issue };
    }

    const realValue = readFieldPath(record, issue?.field);
    const corrected = { ...issue, actual: toActualString(realValue) };

    // No real discrepancy: the page value already matches the true extracted
    // value → the model fabricated the mismatch. Drop it.
    if (qaValuesEqual(corrected.expected, realValue)) return { keep: false, issue: corrected };
    // Both sides blank / expected == corrected actual → no-op. Drop.
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
export async function runSectionQA({ fileId, sectionResultId, slug, pageNumbers, extractionRecord, pdfBuffer }) {
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

    // Field hints come from the active schema in the registry (not hardcoded).
    // Non-fatal: if the slug isn't registered we just omit the hints.
    let activeSchema = null;
    try {
        const active = await getActiveSchema(slug);
        activeSchema = active?.schema ?? null;
    } catch (err) {
        console.warn(`⚠️ getActiveSchema('${slug}') failed for QA hints: ${err.message}`);
    }

    // Strip section_result_id from the record — not relevant for QA
    const { section_result_id: _strip, ...cleanRecord } = extractionRecord;

    const renderedPages = pages.map((p) => p.pageNumber);
    const imageBlocks = pages.map((p) => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${p.jpeg.toString('base64')}`, detail: 'high' },
    }));

    const response = await openai().chat.completions.create({
        model: QA_MODEL,
        messages: [
            {
                role: 'system',
                content: buildSectionQASystemPrompt({ schema: activeSchema, pageCount: pages.length }),
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
    });

    const result = JSON.parse(response.choices[0].message.content);

    // Verify every finding against the real extraction record: correct the
    // model's `actual` to ground truth and drop findings where the page value
    // already matches it (the model's dominant false-positive mode — it
    // fabricates `actual` to manufacture a discrepancy).
    const validIssues = [];
    for (const issue of result.issues || []) {
        const { keep, issue: verified } = verifyFindingAgainstRecord(issue, cleanRecord);
        if (keep) validIssues.push(verified);
    }

    return {
        findings: validIssues,
        overall_quality: result.overall_quality,
        summary: result.summary,
        tokens: response.usage,
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
export async function saveQAFindings({ fileId, sectionResultId, findings, overall_quality }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Delete existing OPEN findings for this section (keep dismissed ones)
        await client.query(
            `DELETE FROM section_qa_findings
             WHERE file_id = $1 AND section_result_id = $2 AND status = 'open'`,
            [fileId, sectionResultId]
        );

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
                     expected, actual, explanation, status, overall_quality, qa_model)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10)
                 ON CONFLICT (file_id, section_result_id, field_path, issue_type)
                 DO UPDATE SET
                     severity = EXCLUDED.severity,
                     expected = EXCLUDED.expected,
                     actual = EXCLUDED.actual,
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
                    finding.explanation,
                    overall_quality,
                    QA_MODEL,
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
    updateQAFindingStatus,
};
