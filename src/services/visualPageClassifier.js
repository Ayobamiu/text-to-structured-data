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
import {
    buildPageClassificationMessages,
    buildPageClassificationResponseFormat,
} from '../config/openaiPrompts.ts';

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

let _openaiClient = null;
function openai() {
    if (_openaiClient) return _openaiClient;
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is required for the visual page classifier');
    }
    _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _openaiClient;
}

async function classifyOnePage({
    pageNumber,
    jpegBuffer,
    documentTypes,
    options,
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
                messages: buildPageClassificationMessages(
                    pageNumber,
                    dataUrl,
                    options.detail,
                    documentTypes
                ),
                response_format: buildPageClassificationResponseFormat(documentTypes),
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
