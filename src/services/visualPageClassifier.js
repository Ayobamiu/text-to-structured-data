/**
 * Visual Page Classifier (Phase 1, item #2)
 *
 * Given a PDF buffer and a set of registered document_type slugs, classify
 * each page by sending its rasterised image to a small vision model. Returns
 * one classification per page, ready to be fed into the section grouper.
 *
 * Design choices worth knowing:
 *
 *   - One image per request, parallelised with a concurrency cap. Multi-image
 *     batched calls are cheaper but accuracy degrades because the model has
 *     to keep N independent classifications straight in one response. For
 *     ~$0.0001/page (gpt-4o-mini, low detail) the savings aren't worth it.
 *
 *   - "low" detail vision input by default. The classifier only needs to
 *     recognise title blocks, table headers, and document-level layout — not
 *     read body text. low-detail = 85 input tokens flat, irrespective of
 *     image dimensions. Cheap and fast.
 *
 *   - Strict structured outputs. The model can only return slugs from the
 *     registry's enum, plus 'none'. No free-text room to hallucinate a new
 *     type that the downstream extractor doesn't know about.
 *
 *   - Per-page failures don't fail the whole document. A page that fails
 *     classification is recorded as { document_type_slug: 'none',
 *     page_role: 'none', confidence: 0, error: '...' } and the section
 *     grouper treats it as a gap. The routing-review UI (item #4) will
 *     surface these.
 */

import OpenAI from 'openai';
import { rasterizePdf } from './pdfRasterizer.js';
import { computeJpegSignature, assignDuplicates, countDuplicates } from './pageDeduplicator.js';

const DEFAULT_OPTIONS = {
    model: 'gpt-4o-mini',
    detail: 'low',         // 'low' | 'high'
    concurrency: 8,        // simultaneous in-flight VLM calls
    widthPx: 768,          // passed through to rasteriser
    jpegQuality: 75,       // passed through to rasteriser
    requestTimeoutMs: 30_000,
    // Bump when the response schema or system prompt changes in a way that
    // could shift outputs.
    //   v1: original (slug + role only)
    //   v2: + page_purpose enum + dedup pointers
    //   v3: + per-document-type classifier_hints spliced into prompt (Approach B)
    // Persisted with each result so future readers can attribute behaviour
    // to a known classifier revision and re-run / diff against newer versions.
    classifierVersion: 3,
};

// Descriptive metadata only (the section grouper does NOT use page_role
// since switching to slug-only boundaries — see sectionGrouper.js header).
// Kept on the response so the routing-review UI and debug tools can display
// what the model thought.
const VALID_PAGE_ROLES = ['first', 'middle', 'last', 'standalone', 'none'];

// Drives whether a page is included in `extraction_pages` for its section.
// 'data' pages are extracted; everything else is skipped. The split between
// values is deliberately domain-agnostic so it works across all 14+ document
// types without per-type prompt engineering. Per-type overrides will land
// later via classifier_hints (Approach B).
const VALID_PAGE_PURPOSES = [
    'data',
    'reference',
    'boilerplate',
    'cover',
    'blank',
    'attachment',
    'unknown',
];

let _openaiClient = null;
function openai() {
    if (_openaiClient) return _openaiClient;
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is required for the visual page classifier');
    }
    _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _openaiClient;
}

/**
 * Build the strict JSON Schema for one page's classification, anchored on
 * the registry's slugs as a closed enum. The model literally cannot return
 * a slug we don't know about.
 */
function buildResponseSchema(documentTypes) {
    const slugEnum = [...documentTypes.map((dt) => dt.slug), 'none'];
    return {
        name: 'page_classification',
        strict: true,
        schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                document_type_slug: {
                    type: 'string',
                    enum: slugEnum,
                    description: 'Slug from the registry, or "none" if the page does not match any known type.',
                },
                page_role: {
                    type: 'string',
                    enum: VALID_PAGE_ROLES,
                    description: 'Descriptive: position of this page within its section. Used by the routing-review UI; the section grouper does not split on it.',
                },
                page_purpose: {
                    type: 'string',
                    enum: VALID_PAGE_PURPOSES,
                    description: 'Whether this page contributes extractable data. Drives section.extraction_pages: only "data" pages are extracted.',
                },
                confidence: {
                    type: 'number',
                    minimum: 0,
                    maximum: 1,
                    description: 'Calibrated confidence in the document_type_slug assignment.',
                },
                reasoning: {
                    type: 'string',
                    description: 'One short sentence explaining the classification (title block visible, table headers, blank, legend, etc.). Keep under 30 words.',
                },
            },
            required: [
                'document_type_slug',
                'page_role',
                'page_purpose',
                'confidence',
                'reasoning',
            ],
        },
    };
}

function buildSystemPrompt(documentTypes) {
    const lines = [
        'You are a document-page classifier for a geological/environmental document extraction pipeline.',
        '',
        'You will see ONE page from a multi-page PDF. For each page identify three things:',
        '  1. document_type_slug — which type of document this page belongs to (or "none")',
        '  2. page_role — where the page sits within its section (descriptive metadata)',
        '  3. page_purpose — whether this page actually contributes extractable data',
        '',
        'Available document types:',
    ];
    for (const dt of documentTypes) {
        const desc = dt.description ? ` — ${dt.description}` : '';
        lines.push(`  - ${dt.slug} (${dt.display_name})${desc}`);

        // Approach B: per-type guidance from document_types.classifier_hints.
        // These rules are authoritative for this slug — they override the
        // generic page_purpose definitions below when there's a conflict.
        const hints = dt.classifier_hints || {};
        const skipWhen = Array.isArray(hints.skip_when) ? hints.skip_when : [];
        const keepWhen = Array.isArray(hints.keep_when) ? hints.keep_when : [];
        if (skipWhen.length > 0) {
            lines.push(`      Skip rules for ${dt.slug} (override generic guidance below):`);
            for (const rule of skipWhen) lines.push(`        • ${rule}`);
        }
        if (keepWhen.length > 0) {
            lines.push(`      Keep rules for ${dt.slug}:`);
            for (const rule of keepWhen) lines.push(`        • ${rule}`);
        }
    }
    lines.push(
        '  - none: this page does not match any of the above types',
        '',
        'page_role values (descriptive only — do not affect section boundaries):',
        '  - "first": page contains the title block / form header that opens a section.',
        '  - "middle": continuation page of a section.',
        '  - "last": final page of a section (totals, signatures, "End of Report").',
        '  - "standalone": single-page section (form fits on one page).',
        '  - "none": page is "none"-typed.',
        '',
        'page_purpose values (this drives whether the page is extracted):',
        '  - "data": page contains extractable fields, table rows, or measurement values that would be captured into a structured database. Filled-in form values, completed log tables, populated detail records.',
        '  - "reference": reference material identical across all instances of this document type — legends, abbreviation keys, USCS classification charts, lithology pattern guides. No document-specific data.',
        '  - "boilerplate": standardized text not specific to this document — disclaimers, limitations, terms of service, signature blocks, certifications.',
        '  - "cover": title page, section divider, or appendix marker. No extractable fields beyond names/dates already on every other page.',
        '  - "blank": blank page or only header/footer visible.',
        '  - "attachment": map, graph, photograph, or other non-tabular visual that the structured-data extractor cannot process.',
        '  - "unknown": you cannot determine the purpose. Pages classified as document_type_slug="none" should always have page_purpose="unknown".',
        '',
        'Confidence: be conservative. Only score above 0.85 when the page clearly carries a recognisable title block or table header for the chosen document type. Below 0.6 when guessing from layout alone.',
        '',
        'Purpose conservatism: be aggressive about marking pages as non-data. False positives (calling a legend page "data") waste extraction money on pages with no real fields. False negatives (calling a real form "reference") get caught by humans in routing review and are cheaper to fix.',
    );
    return lines.join('\n');
}

async function classifyOnePage({
    pageNumber,
    jpegBuffer,
    documentTypes,
    options,
    responseSchema,
    systemPrompt,
}) {
    const startedAt = Date.now();
    const dataUrl = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;

    // Dedup signature is computed regardless of LLM outcome so failed pages
    // can still be matched against successful ones (e.g. if pages 1 and 5
    // are byte-identical but page 5's LLM call timed out, we still know
    // they're the same image).
    const dupe_signature = computeJpegSignature(jpegBuffer);

    try {
        const response = await openai().chat.completions.create(
            {
                model: options.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: `Classify page ${pageNumber}.`,
                            },
                            {
                                type: 'image_url',
                                image_url: { url: dataUrl, detail: options.detail },
                            },
                        ],
                    },
                ],
                response_format: { type: 'json_schema', json_schema: responseSchema },
            },
            { timeout: options.requestTimeoutMs }
        );

        const content = response.choices?.[0]?.message?.content;
        if (!content) {
            throw new Error('Empty response content from VLM');
        }
        const parsed = JSON.parse(content);

        return {
            page_number: pageNumber,
            document_type_slug: parsed.document_type_slug,
            page_role: parsed.page_role,
            page_purpose: parsed.page_purpose,
            confidence: parsed.confidence,
            reasoning: parsed.reasoning,
            dupe_signature,
            classifier_ms: Date.now() - startedAt,
            tokens: {
                prompt: response.usage?.prompt_tokens ?? null,
                completion: response.usage?.completion_tokens ?? null,
                total: response.usage?.total_tokens ?? null,
            },
        };
    } catch (err) {
        return {
            page_number: pageNumber,
            document_type_slug: 'none',
            page_role: 'none',
            page_purpose: 'unknown',
            confidence: 0,
            reasoning: null,
            dupe_signature,
            error: err.message,
            classifier_ms: Date.now() - startedAt,
        };
    }
}

/**
 * Run requests with a fixed concurrency cap. Returns results in the same
 * order as inputs.
 */
async function runConcurrent(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;

    async function pump() {
        while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    }

    const runners = Array.from({ length: Math.min(limit, items.length) }, () => pump());
    await Promise.all(runners);
    return results;
}

/**
 * Classify every page of a PDF buffer.
 *
 * @param {Object} args
 * @param {Buffer} args.pdfBuffer
 * @param {Array<{slug: string, display_name: string, description?: string}>} args.documentTypes
 *        From schemaRegistry.listDocumentTypes(). Must be non-empty.
 * @param {Object} [args.options]
 *
 * @returns {Promise<{
 *   classifier: { name, model, version, ran_at, duration_ms, page_count, image: { width, detail } },
 *   pages: Array<{ page_number, document_type_slug, page_role, confidence, reasoning, classifier_ms, tokens?, error? }>
 * }>}
 */
export async function classifyPdf({ pdfBuffer, documentTypes, options = {} }) {
    if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
        throw new Error('classifyPdf requires a non-empty pdfBuffer');
    }
    if (!Array.isArray(documentTypes) || documentTypes.length === 0) {
        throw new Error('classifyPdf requires a non-empty documentTypes array');
    }

    const opts = { ...DEFAULT_OPTIONS, ...options };
    const responseSchema = buildResponseSchema(documentTypes);
    const systemPrompt = buildSystemPrompt(documentTypes);

    const startedAt = Date.now();
    const ranAt = new Date().toISOString();

    const pages = await rasterizePdf(pdfBuffer, {
        widthPx: opts.widthPx,
        jpegQuality: opts.jpegQuality,
    });

    console.log(
        `🧠 classifying ${pages.length} page(s) with ${opts.model} (detail=${opts.detail}, concurrency=${opts.concurrency})`
    );

    const classifications = await runConcurrent(pages, opts.concurrency, (page) =>
        classifyOnePage({
            pageNumber: page.pageNumber,
            jpegBuffer: page.jpeg,
            documentTypes,
            options: opts,
            responseSchema,
            systemPrompt,
        })
    );

    // Cheap, deterministic post-processing: assign duplicate_of pointers from
    // the per-page MD5 signatures collected in classifyOnePage. First
    // occurrence wins; later identical pages get duplicate_of: <first page>.
    const annotated = assignDuplicates(classifications);

    const durationMs = Date.now() - startedAt;
    const errorCount = annotated.filter((c) => c.error).length;
    if (errorCount > 0) {
        console.warn(`⚠️  ${errorCount}/${pages.length} page(s) failed classification — recorded as 'none'/'unknown'.`);
    }
    const dupeCount = countDuplicates(annotated);
    if (dupeCount > 0) {
        console.log(`♻️  detected ${dupeCount} duplicate page(s) (byte-identical to an earlier page)`);
    }

    return {
        classifier: {
            name: 'openai-vision',
            model: opts.model,
            version: opts.classifierVersion,
            ran_at: ranAt,
            duration_ms: durationMs,
            page_count: pages.length,
            image: { width: opts.widthPx, detail: opts.detail },
            // Pin the dedup strategy in the same metadata block so future
            // readers can attribute "why is duplicate_of set / not set" to a
            // known implementation (today: MD5 byte-hash; future may be pHash).
            dedup: { strategy: 'md5_byte_hash', version: 1 },
        },
        pages: annotated,
    };
}

export default {
    classifyPdf,
};
