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

const QA_MODEL = 'gpt-4o-mini';
const IMAGE_WIDTH = 1024; // Higher res than classifier — need to read actual values
const IMAGE_QUALITY = 90;

let _openaiClient = null;
function openai() {
    if (_openaiClient) return _openaiClient;
    _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _openaiClient;
}

// ─── Schema field hints per slug ────────────────────────────────────
// Helps the VLM use the correct field paths.
// These are loaded from the schema registry at runtime for integration;
// for now a static map covers the main document types.

const SCHEMA_FIELD_HINTS = {
    borehole_log: `
Schema fields for borehole_log (use EXACTLY these field paths in issues):
  Objects:
    site_identification: boring_well_id, site_name, site_address, county, state, ground_elevation_ft, toc_elevation_ft, latitude_dd, longitude_dd
    document_metadata: firm_name, client, log_date, job_number, project_number, page_number, total_pages, document_type (array)
    drilling_and_personnel: drilling_method, total_depth_ft, contractor, date_start, date_end, geologist_logged_by, borehole_diameter_in
    well_construction: well_installed (bool), casing_diameter_in, screen_from_ft, screen_to_ft, filter_pack_material, grout_type
    field_screening: pid_instrument, max_reading_ppm, pid_trace_present (bool)
    spt_setup: spt_performed (bool), sampler_type, hammer_weight_lb
  Arrays (count rows carefully):
    lithology_intervals: each row has depth_from_ft, depth_to_ft, primary_material, uscs_symbol, description_raw, color_description, consistency_density
    spt_intervals: each row has test_depth_ft, n_value, blows_2nd_6in, blows_3rd_6in
    groundwater_observations: each has depth_ft, observation_type, measurement_date
    samples_collected: sample records`,

    aquifer_test: `
Schema fields for aquifer_test (use EXACTLY these field paths in issues):
  Objects:
    document_metadata: firm_name, project_name, project_number, client, document_type (array)
    test_setup: control_well_id, well_number, test_type, well_depth_ft, swl_ft, test_start_date, pumping_rates_gpm (array)
    calculated_parameters: transmissivity_ft2_day, hydraulic_conductivity_ft_day, storativity, analysis_method, aquifer_type
  Arrays:
    observation_wells: each has well_id, distance_from_pw_ft, swl_ft
    pumping_steps: each has step_number, pumping_rate_gpm, duration_min
    time_series_readings: each has elapsed_time, water_level_ft, drawdown_ft, phase
    datalogger_panels: each has well_id, logger_model, readings (nested array)`,

    mgs_well_log: `
Schema fields for mgs_well_log (use EXACTLY these field paths in issues):
  Scalars: permit_number, api_number, county, well_number, lease_name, completion_date, true_depth, measured_depth, elevation, elevation_datum, status, well_type, deviation, target_zone, deepest_formation, acidized, fractured, h2s_present, injection_well, number_of_plugs, workovers, issues, land_use_type, type_fluid_injected, latitude, longitude
  Arrays:
    formations: each has from, to, formation
    casing: each has type, size, Interval, cement_type, bags_of_cement
    pluggings: each has type, depth, details, interval, plugging_date, bag_of_cements
    shows_depths: each has depth, formation, oil_or_gas
    perforation_intervals: each has from, to`,
};

// ─── System prompt ──────────────────────────────────────────────────

function buildSystemPrompt(slug) {
    const fieldHints = SCHEMA_FIELD_HINTS[slug] || '';

    return `You are a document extraction QA reviewer. Compare a source document page image against its structured extraction result and flag discrepancies.

You will receive:
1. An IMAGE of one page from a PDF document
2. A JSON extraction result produced by an AI from that page

Your task: Check every meaningful field against what's visible on the page. Flag:
- WRONG VALUES: field value doesn't match what's on the page
- MISSING VALUES: field is null but data is clearly visible on the page
- EXTRA VALUES: field has a value not present on the page (hallucination)
- MISSING ROWS: array has fewer items than rows visible on the page
- EXTRA ROWS: array has more items than rows on the page

Rules:
- Only flag issues you can VERIFY by looking at the page image. Don't guess.
- Enum normalization is expected — "hollow_stem_auger" for "Hollow Stem Auger" is correct. Only flag if the MEANING differs.
- Date format differences (2024-01-15 vs 01/15/2024) are "info" severity, not errors.
- Count table rows carefully before flagging missing/extra rows.
- If the extraction is correct, return an empty issues array.
- Be specific: use exact field paths with array indices (e.g., "lithology_intervals[2].primary_material").
- Do NOT flag issues where expected equals actual — that is not an error.
${fieldHints}`;
}

// ─── Response schema ─────────────────────────────────────────────────

const QA_RESPONSE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'issues', 'overall_quality'],
    properties: {
        summary: {
            type: 'string',
            description: 'One sentence: how many issues, what kind. E.g., "2 errors found in lithology depths."',
        },
        issues: {
            type: 'array',
            description: 'All discrepancies between page image and extraction. Empty array if extraction is correct.',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['field', 'issue_type', 'severity', 'expected', 'actual', 'explanation'],
                properties: {
                    field: {
                        type: 'string',
                        description: 'Dot-path with array indices. E.g., "lithology_intervals[0].depth_to_ft"',
                    },
                    issue_type: {
                        type: 'string',
                        enum: ['wrong_value', 'missing_value', 'extra_value', 'missing_rows', 'extra_rows', 'wrong_count', 'formatting'],
                    },
                    severity: {
                        type: 'string',
                        enum: ['error', 'warning', 'info'],
                    },
                    expected: {
                        type: ['string', 'null'],
                        description: 'Quote exact text from page. Null for hallucinated values.',
                    },
                    actual: {
                        type: ['string', 'null'],
                        description: 'The extracted value. Null if field is missing.',
                    },
                    explanation: {
                        type: 'string',
                        description: 'Why this is an issue. Max 25 words.',
                    },
                },
            },
        },
        overall_quality: {
            type: 'string',
            enum: ['perfect', 'good', 'acceptable', 'poor'],
            description: 'perfect=no issues. good=info/warning only. acceptable=1-2 errors. poor=3+ errors.',
        },
    },
};

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

    // Use the first extraction page — that's the primary data page
    const pageNumber = pageNumbers[0];

    const pages = await rasterizePdf(pdfBuffer, {
        firstPage: pageNumber,
        lastPage: pageNumber,
        widthPx: IMAGE_WIDTH,
        jpegQuality: IMAGE_QUALITY,
    });

    if (!pages.length) {
        throw new Error(`Could not rasterize page ${pageNumber} for QA`);
    }

    const imageDataUrl = `data:image/jpeg;base64,${pages[0].jpeg.toString('base64')}`;

    // Strip section_result_id from the record — not relevant for QA
    const { section_result_id: _strip, ...cleanRecord } = extractionRecord;

    const response = await openai().chat.completions.create({
        model: QA_MODEL,
        messages: [
            { role: 'system', content: buildSystemPrompt(slug) },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `Review this extraction result against the source page.\n\nEXTRACTION RESULT:\n${JSON.stringify(cleanRecord, null, 2)}`,
                    },
                    {
                        type: 'image_url',
                        image_url: { url: imageDataUrl, detail: 'high' },
                    },
                ],
            },
        ],
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'extraction_qa_review',
                strict: true,
                schema: QA_RESPONSE_SCHEMA,
            },
        },
    });

    const result = JSON.parse(response.choices[0].message.content);

    // Filter out nonsense: issues where expected === actual
    const validIssues = result.issues.filter(issue => issue.expected !== issue.actual);

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
