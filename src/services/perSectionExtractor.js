/**
 * Per-section extractor (Phase 1, item #3 — the v2 envelope).
 *
 * Given the visual classifier's `detected_sections` and a single completed
 * extraction (markdown + per-page text), this module fans out N AI processing
 * calls — one per section — and assembles the results into the v2 envelope:
 *
 *     {
 *       boring_log:    [ { ...section1_fields }, { ...section3_fields } ],
 *       aquifer_test:  [ { ...section2_fields } ]
 *     }
 *
 * Multi-instance handling: when one PDF has two sections of the same slug,
 * the value is always an array (entry order = appearance order in the
 * document). Per the design decision in the kickoff conversation, arrays
 * are used uniformly — even for the single-instance case — so downstream
 * consumers don't have to type-check.
 *
 * Schema source: `getActiveSchema(slug)` from the registry. The job-level
 * `schema_data` is intentionally NOT consulted here — the registry is the
 * single source of truth when the classifier is on.
 *
 * Failure semantics (per agreed spec):
 *   - missing schema for a slug          → section status = 'skipped_no_schema'
 *   - empty content (no extractable text) → section status = 'skipped_no_content'
 *   - AI call throws / returns success=false → section status = 'failed'
 *   - section had no extraction_pages    → section status = 'skipped_no_pages'
 *   - any other section's success or failure does NOT affect this one
 *
 * The caller decides what to do with the file overall:
 *   - ≥1 success                       → file = completed
 *   - 0 successes, ≥1 failure          → file = failed
 *   - 0 sections with any pages at all → file = completed (empty result)
 *
 * Concurrency: sections run in parallel (Promise.all). For a typical 3-section
 * PDF the wall-clock cost is ~1× a single AI call instead of 3×. Tune via
 * `maxConcurrency` if a doc explodes into many sections.
 */

import { v4 as uuidv4 } from 'uuid';
import { getActiveSchema as defaultGetActiveSchema } from './schemaRegistry.js';

const DEFAULT_MAX_CONCURRENCY = 6;

/**
 * @param {Object} args
 * @param {Object} args.detectedSections     The classifier output blob (same
 *                                            shape as `job_files.detected_sections`).
 * @param {Array<{page_number:number, text?:string, markdown?:string}>} args.pages
 *                                            Per-page extraction output.
 * @param {Object} args.processingService    Live ProcessingService instance.
 * @param {string} args.processingMethod     'openai' | 'qwen'.
 * @param {Object} args.processingOptions    Options forwarded to processingService.
 * @param {number} [args.maxConcurrency]     Parallelism cap, default 6.
 * @param {(slug: string) => Promise<Object|null>} [args.getActiveSchema]
 *                                            Schema resolver. Defaults to the
 *                                            schemaRegistry export. Override
 *                                            in tests so we can drive the
 *                                            orchestrator without a DB.
 *
 * @returns {Promise<{
 *   resultEnvelope: Record<string, Array<Object>>,
 *   sectionResults: Array<{
 *     section_index: number,
 *     slug: string,
 *     page_range: [number, number],
 *     extraction_pages: number[],
 *     status: 'success'|'failed'|'skipped_no_schema'|'skipped_no_content'|'skipped_no_pages',
 *     error?: string,
 *     duration_ms?: number,
 *     ai_metadata?: Object
 *   }>,
 *   totalAiTimeSeconds: number,
 *   anySuccess: boolean,
 *   schemasUsed: Record<string, { version: number, schemaId: string }>
 * }>}
 */
export async function extractAndProcessPerSection({
    detectedSections,
    pages,
    processingService,
    processingMethod = 'openai',
    processingOptions = {},
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    getActiveSchema = defaultGetActiveSchema,
    selectedPages = null,
    onSectionComplete = null,
}) {
    if (!detectedSections || !Array.isArray(detectedSections.sections)) {
        throw new Error('extractAndProcessPerSection: detectedSections.sections must be an array');
    }
    if (!Array.isArray(pages)) {
        throw new Error('extractAndProcessPerSection: pages must be an array');
    }
    if (!processingService || typeof processingService.processText !== 'function') {
        throw new Error('extractAndProcessPerSection: processingService.processText is required');
    }

    const sections = detectedSections.sections;

    // Build page_number -> text map. Prefer page.text (mineru/extendai
    // primary content); fall back to page.markdown if a future extractor
    // only supplies markdown.
    //
    // When selectedPages is provided, the text extraction returned pages
    // numbered 1..N (sequential), but the classifier's extraction_pages
    // use original PDF page numbers. We remap: text page at index i maps
    // to selectedPages[i] (the original PDF page number).
    const pageTextMap = new Map();
    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        if (!page) continue;
        const txt = (page.text ?? page.markdown ?? '').toString();

        // Determine the key: original PDF page number
        let key;
        if (selectedPages && Array.isArray(selectedPages) && i < selectedPages.length) {
            key = selectedPages[i];
        } else if (typeof page.page_number === 'number') {
            key = page.page_number;
        } else {
            continue;
        }
        pageTextMap.set(key, txt);
    }

    // Resolve schemas in advance and only once per distinct slug. The
    // registry caches internally too, but local memoization avoids
    // duplicate cache lookups for multi-instance same-slug docs.
    const distinctSlugs = [...new Set(sections.map((s) => s.document_type_slug).filter(Boolean))];
    const schemasBySlug = new Map();
    await Promise.all(
        distinctSlugs.map(async (slug) => {
            try {
                const schema = await getActiveSchema(slug);
                schemasBySlug.set(slug, schema || null);
            } catch (err) {
                console.warn(`⚠️ getActiveSchema('${slug}') threw — treating as no-schema: ${err.message}`);
                schemasBySlug.set(slug, null);
            }
        })
    );

    // Run sections in parallel (bounded). Order of `tasks` follows section
    // order, so when we collect results we keep document order.
    const tasks = sections.map((section, index) =>
        async () => {
            const r = await runSection({
                section,
                index,
                pageTextMap,
                schemasBySlug,
                processingService,
                processingMethod,
                processingOptions,
            });
            // Fire the per-section progress callback as each finishes (sections
            // run concurrently, so this is completion order, not section order).
            if (typeof onSectionComplete === 'function') {
                try {
                    onSectionComplete({
                        section_index: r.section_index,
                        slug: r.slug,
                        record_id: r.record_id || null,
                        page_range: r.page_range,
                        status: r.status,
                        warning: r.completeness_warning || null,
                    });
                } catch { /* never let telemetry break extraction */ }
            }
            return r;
        }
    );

    const taskResults = await runWithConcurrency(tasks, maxConcurrency);

    // Build envelope + section_results metadata.
    const envelope = {};
    const sectionResults = [];
    const schemasUsed = {};
    let totalAiTimeSeconds = 0;
    let anySuccess = false;

    for (const r of taskResults) {
        sectionResults.push({
            section_index: r.section_index,
            section_result_id: r.section_result_id,
            slug: r.slug,
            record_id: r.record_id || null,
            page_range: r.page_range,
            extraction_pages: r.extraction_pages,
            status: r.status,
            error: r.error,
            duration_ms: r.duration_ms,
            ai_metadata: r.ai_metadata,
            // Large-section guardrail fields (only present when flagged)
            ...(r.large_section ? {
                large_section: true,
                estimated_input_tokens: r.estimated_input_tokens,
                content_length: r.content_length,
            } : {}),
            ...(r.response_truncated ? { response_truncated: true } : {}),
        });

        if (r.status === 'success' && r.data !== undefined) {
            anySuccess = true;
            if (!envelope[r.slug]) envelope[r.slug] = [];
            envelope[r.slug].push({ section_result_id: r.section_result_id, ...r.data });

            if (r.schema_version != null) {
                // Last writer wins — for multi-instance same-slug, all
                // sections used the same active schema so it doesn't matter.
                schemasUsed[r.slug] = {
                    version: r.schema_version,
                    schemaId: r.schema_id,
                };
            }

            const aiSeconds = r.ai_metadata?.processing_time_seconds || 0;
            totalAiTimeSeconds += aiSeconds;
        }
    }

    return {
        resultEnvelope: envelope,
        sectionResults,
        totalAiTimeSeconds,
        anySuccess,
        schemasUsed,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runSection({
    section,
    index,
    pageTextMap,
    schemasBySlug,
    processingService,
    processingMethod,
    processingOptions,
}) {
    const slug = section.document_type_slug;
    const pageRange = Array.isArray(section.page_range) && section.page_range.length === 2
        ? section.page_range
        : [section.extraction_pages?.[0] ?? null, section.extraction_pages?.at(-1) ?? null];

    const baseMeta = {
        section_result_id: uuidv4(),
        section_index: index,
        slug,
        record_id: section.record_id || null,
        page_range: pageRange,
        extraction_pages: Array.isArray(section.extraction_pages) ? section.extraction_pages : [],
    };

    if (!slug) {
        return { ...baseMeta, status: 'skipped_no_pages', error: 'Section has no document_type_slug' };
    }

    if (!Array.isArray(section.extraction_pages) || section.extraction_pages.length === 0) {
        return { ...baseMeta, status: 'skipped_no_pages' };
    }

    const schemaInfo = schemasBySlug.get(slug);
    if (!schemaInfo) {
        console.warn(`⚠️ Section ${index} (${slug}, pp ${pageRange.join('-')}): no active schema in registry — skipping`);
        return {
            ...baseMeta,
            status: 'skipped_no_schema',
            error: `No active schema registered for document type '${slug}'`,
        };
    }

    const contentForAI = section.extraction_pages
        .map((p) => pageTextMap.get(p) || '')
        .filter((t) => t.trim().length > 0)
        .join('\n\n');

    if (!contentForAI.trim()) {
        return {
            ...baseMeta,
            status: 'skipped_no_content',
            error: 'Selected pages produced no extractable text',
        };
    }

    // ── Large-section guardrails ─────────────────────────────────────
    // Estimate input token count (rough: ~4 chars per token for English).
    // Flag sections above threshold so operators can monitor truncation
    // risk without needing to inspect individual responses.
    const LARGE_SECTION_TOKEN_THRESHOLD = 25000;
    const LARGE_SECTION_PAGE_THRESHOLD = 6;
    const estimatedInputTokens = Math.ceil(contentForAI.length / 4);
    const pageCount = section.extraction_pages.length;
    const isLargeSection = estimatedInputTokens > LARGE_SECTION_TOKEN_THRESHOLD
        || pageCount > LARGE_SECTION_PAGE_THRESHOLD;

    if (isLargeSection) {
        console.warn(
            `⚠️ Section ${index} (${slug}, pp ${pageRange.join('-')}): LARGE SECTION — ` +
            `${pageCount} pages, ~${estimatedInputTokens.toLocaleString()} est. input tokens, ` +
            `${contentForAI.length.toLocaleString()} chars`
        );
    }

    // ── Route large sections to Claude ────────────────────────────────
    // When a section is flagged as large and the current method is OpenAI,
    // preemptively route to Claude Sonnet 4.6 (64K output cap) instead of
    // risking truncation on GPT-4.1's 32K cap. This avoids a wasted
    // GPT-4.1 call + retry. The fallback path in processingService still
    // exists for cases where Claude isn't configured.
    let effectiveMethod = processingMethod;
    let effectiveOptions = processingOptions;
    let routedToClaude = false;

    if (isLargeSection && processingMethod === 'openai') {
        // Only route if Claude API key is configured
        if (process.env.CLAUDE_API_KEY) {
            effectiveMethod = 'claude';
            effectiveOptions = { temperature: 0.1 };
            routedToClaude = true;
            console.log(
                `🔄 Section ${index} (${slug}, pp ${pageRange.join('-')}): ` +
                `routing to Claude (large section, ~${estimatedInputTokens.toLocaleString()} est. tokens)`
            );
        } else {
            console.warn(
                `⚠️ Section ${index} (${slug}): large section would benefit from Claude routing ` +
                `but CLAUDE_API_KEY is not set — falling back to OpenAI`
            );
        }
    }

    const startMs = Date.now();
    let aiResult;
    try {
        aiResult = await processingService.processText(
            contentForAI,
            schemaInfo, // { schemaName, schema, ... } — drop-in for processText's schemaData
            effectiveMethod,
            effectiveOptions
        );
    } catch (err) {
        return {
            ...baseMeta,
            status: 'failed',
            error: err?.message || String(err),
            duration_ms: Date.now() - startMs,
            ...(isLargeSection ? {
                large_section: true,
                estimated_input_tokens: estimatedInputTokens,
                content_length: contentForAI.length,
            } : {}),
        };
    }
    const durationMs = Date.now() - startMs;

    if (!aiResult || !aiResult.success) {
        return {
            ...baseMeta,
            status: 'failed',
            error: aiResult?.error || 'AI processing returned no data',
            duration_ms: durationMs,
            ...(isLargeSection ? {
                large_section: true,
                estimated_input_tokens: estimatedInputTokens,
                content_length: contentForAI.length,
            } : {}),
        };
    }

    // ── Truncation detection ─────────────────────────────────────────
    // Check if the AI response looks truncated (incomplete JSON structure).
    // This catches the case where max_tokens is hit on the output side.
    let responseTruncated = false;
    if (aiResult.data != null) {
        try {
            const serialized = typeof aiResult.data === 'string'
                ? aiResult.data
                : JSON.stringify(aiResult.data);
            // Quick heuristic: if the raw response text ends mid-string
            // or mid-value, JSON.stringify of the parsed result won't match.
            // A more robust check: look at finish_reason from the AI response.
            const finishReason = aiResult.metadata?.finish_reason
                ?? aiResult.metadata?.choices?.[0]?.finish_reason;
            if (finishReason === 'length') {
                responseTruncated = true;
                console.warn(
                    `⚠️ Section ${index} (${slug}): RESPONSE TRUNCATED (finish_reason=length) — ` +
                    `response likely hit max_tokens limit`
                );
            }
        } catch {
            // Serialization failed — data might already be malformed from truncation
            responseTruncated = true;
        }
    }

    console.log(
        `✅ Section ${index} (${slug}, pp ${pageRange.join('-')}, ${section.extraction_pages.length} pg): ` +
        `extracted in ${(durationMs / 1000).toFixed(2)}s ` +
        `(schema v${schemaInfo.version})`
    );

    // ── Completeness check + reactive Claude escalation ──────────────
    // Catches OpenAI structured-output partial emission: the model emits a
    // few rows of a clearly tabular page and stops early despite token
    // headroom. When that happens on an OpenAI extraction, re-extract the
    // section on Claude (better at exhaustive enumeration, larger output cap)
    // and keep whichever result has more rows. Large sections already pre-route
    // to Claude, so this only fires for the OpenAI path that came up short.
    let estimatedRows = 0;
    let emittedRows = 0;
    try {
        estimatedRows = estimateSourceRowCount(contentForAI);
        emittedRows = largestArrayLen(aiResult.data);
    } catch (warnErr) {
        console.warn(`⚠️ completeness check failed: ${warnErr.message}`);
    }
    const isUnderExtracted = (e, est) => est >= 10 && e > 0 && e * 3 < est;

    let escalatedToClaude = false;
    if (
        isUnderExtracted(emittedRows, estimatedRows) &&
        effectiveMethod === 'openai' &&
        process.env.CLAUDE_API_KEY
    ) {
        console.warn(
            `⚠️ Section ${index} (${slug}): under-extracted ${emittedRows}/~${estimatedRows} rows on OpenAI — escalating to Claude`
        );
        try {
            const claudeResult = await processingService.processText(
                contentForAI,
                schemaInfo,
                'claude',
                { temperature: 0.1 }
            );
            if (claudeResult?.success && claudeResult.data != null) {
                const claudeRows = largestArrayLen(claudeResult.data);
                if (claudeRows > emittedRows) {
                    aiResult = claudeResult;
                    emittedRows = claudeRows;
                    escalatedToClaude = true;
                    console.log(
                        `✅ Section ${index} (${slug}): Claude returned ${claudeRows} rows — using Claude result`
                    );
                } else {
                    console.warn(
                        `⚠️ Section ${index} (${slug}): Claude returned ${claudeRows} rows (≤ OpenAI's ${emittedRows}) — keeping OpenAI result`
                    );
                }
            }
        } catch (err) {
            console.warn(`⚠️ Section ${index} (${slug}): Claude escalation failed: ${err.message}`);
        }
    }

    const stillIncomplete = isUnderExtracted(emittedRows, estimatedRows);
    const completenessWarning = stillIncomplete
        ? `extracted ${emittedRows} items but source has ~${estimatedRows} repeating rows`
        : null;
    if (completenessWarning) {
        console.warn(
            `⚠️ Section ${index} (${slug}): ${completenessWarning}${escalatedToClaude ? ' (after Claude escalation)' : ''} — ` +
            `model may have stopped extracting early despite token headroom`
        );
    }

    return {
        ...baseMeta,
        status: 'success',
        duration_ms: Date.now() - startMs, // includes the escalation call when it ran
        ai_metadata: aiResult.metadata,
        data: aiResult.data,
        schema_version: schemaInfo.version,
        schema_id: schemaInfo.schemaId,
        completeness: {
            emitted: emittedRows,
            estimated: estimatedRows,
            escalated: escalatedToClaude,
            complete: !stillIncomplete,
        },
        ...(completenessWarning ? { completeness_warning: completenessWarning } : {}),
        ...(escalatedToClaude ? { escalated_to_claude: true } : {}),
        // Large-section guardrail metadata — included only when flagged so
        // the monitoring UI can surface sections at risk of truncation.
        ...(isLargeSection ? {
            large_section: true,
            estimated_input_tokens: estimatedInputTokens,
            content_length: contentForAI.length,
        } : {}),
        ...(routedToClaude ? { routed_to_claude: true } : {}),
        ...(responseTruncated ? { response_truncated: true } : {}),
    };
}

/**
 * Estimate how many repeating data rows the source page contains. Heuristic:
 * <tr> table rows (minus the header) are the strongest signal; lab-unit cells
 * (ug/L, mg/L…) back it up for analyte tables. Returns 0 when the page isn't
 * obviously tabular.
 *
 * @param {string} sourceText
 * @returns {number}
 */
export function estimateSourceRowCount(sourceText) {
    if (!sourceText || typeof sourceText !== 'string') return 0;
    const trMatches = sourceText.match(/<tr[ >]/gi);
    const trRowCount = trMatches ? Math.max(0, trMatches.length - 1) : 0;
    const unitMatches = sourceText.match(/\b(?:ug\/L|mg\/L|mg\/kg|ug\/kg|ppm|ppb)\b/gi);
    const unitRowCount = unitMatches ? unitMatches.length : 0;
    return Math.max(trRowCount, unitRowCount);
}

/**
 * Length of the largest array anywhere in the emitted data (depth-limited).
 * For the v2 envelope each section is a single object, so a shallow scan
 * captures the main repeating array (e.g. lithology_intervals).
 *
 * @param {*} data
 * @returns {number}
 */
export function largestArrayLen(data) {
    if (!data || typeof data !== 'object') return 0;
    let biggest = 0;
    const visit = (node, depth = 0) => {
        if (depth > 4 || node == null) return;
        if (Array.isArray(node)) {
            if (node.length > biggest) biggest = node.length;
            for (const v of node) visit(v, depth + 1);
        } else if (typeof node === 'object') {
            for (const v of Object.values(node)) visit(v, depth + 1);
        }
    };
    visit(data);
    return biggest;
}

/**
 * Run an array of zero-arg async task factories with bounded concurrency.
 * Returns an array of results in the same order as `tasks`.
 *
 * Doesn't short-circuit on errors — each task is responsible for catching
 * its own failures and returning a structured error result. This keeps the
 * per-section semantics ("section A's failure must not abort section B")
 * a property of the orchestrator, not each call site.
 */
async function runWithConcurrency(tasks, maxConcurrency) {
    if (tasks.length === 0) return [];
    const limit = Math.max(1, Math.min(maxConcurrency, tasks.length));
    const results = new Array(tasks.length);
    let cursor = 0;

    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= tasks.length) return;
            results[i] = await tasks[i]();
        }
    }

    await Promise.all(Array.from({ length: limit }, worker));
    return results;
}

export default {
    extractAndProcessPerSection,
};
