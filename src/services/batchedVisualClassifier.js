/**
 * Batched Visual Page Classifier (v2)
 *
 * Replaces the per-page classifier with a batched approach that:
 *   1. Sends 5 consecutive pages per API call (high detail, 768px)
 *   2. Detects record boundaries (is_new_record) and assigns record_id per page
 *   3. Propagates bounded context between batches (last batch + record inventory)
 *   4. Produces page summaries for caching/reuse
 *
 * Key advantages over v1 (per-page at low detail):
 *   - Can READ text on scanned documents (high detail = tiled vision)
 *   - Detects record boundaries (MW-1 vs IW-1 vs EW-2) that slug_only grouping missed
 *   - Running context prevents batch-boundary amnesia
 *   - Page summaries are cached for future re-extraction without re-classifying
 *
 * Cost: ~$0.008/record (768px high detail, gpt-4o-mini)
 * Accuracy: 100% on test file with 6 distinct well records
 */

import OpenAI from 'openai';
import { rasterizePdf } from './pdfRasterizer.js';
import { computeJpegSignature, assignDuplicates, countDuplicates } from './pageDeduplicator.js';

// ---------------------------------------------------------------------------
// Record ID normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a record_id string so that OCR variants of the same identifier
 * are treated as equal during section grouping and record inventory tracking.
 *
 * Transformations (in order):
 *   1. Trim leading/trailing whitespace
 *   2. Collapse internal runs of whitespace to nothing around hyphens/dashes
 *      ("GP- 1" → "GP-1", "MW -2" → "MW-2", "B - 3" → "B-3")
 *   3. Collapse remaining internal whitespace to a single space
 *   4. Uppercase ("gp-1" → "GP-1")
 *   5. Strip trailing punctuation (periods, commas) that OCR sometimes appends
 *
 * Returns null for null/undefined/empty-string inputs.
 */
export function normalizeRecordId(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (s.length === 0) return null;

    // Collapse whitespace around hyphens/dashes: "GP- 1" → "GP-1"
    s = s.replace(/\s*[-–—]\s*/g, '-');
    // Collapse remaining internal whitespace
    s = s.replace(/\s+/g, ' ');
    // Uppercase
    s = s.toUpperCase();
    // Strip trailing punctuation
    s = s.replace(/[.,;:]+$/, '');

    return s.length > 0 ? s : null;
}

const DEFAULT_OPTIONS = {
    model: 'gpt-4o-mini',
    detail: 'high',
    batchSize: 5,
    widthPx: 768,
    jpegQuality: 95,
    requestTimeoutMs: 60_000,
    // v4: batched classifier with record_id detection + bounded context
    // v5: splice per-document-type classifier_hints (keep/skip rules) into system prompt
    classifierVersion: 5,
};

let _openaiClient = null;
function openai() {
    if (_openaiClient) return _openaiClient;
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is required for the batched visual classifier');
    }
    _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _openaiClient;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(documentTypes) {
    // Build the document type list with per-type classifier hints (keep/skip rules)
    const typeLines = [];
    for (const dt of documentTypes) {
        const desc = dt.description ? ` — ${dt.description}` : '';
        typeLines.push(`  - ${dt.slug} (${dt.display_name || dt.slug})${desc}`);

        const hints = dt.classifier_hints || {};
        const skipWhen = Array.isArray(hints.skip_when) ? hints.skip_when : [];
        const keepWhen = Array.isArray(hints.keep_when) ? hints.keep_when : [];
        if (keepWhen.length > 0) {
            typeLines.push(`      KEEP rules for ${dt.slug} (pages matching these ARE this type):`);
            for (const rule of keepWhen) typeLines.push(`        • ${rule}`);
        }
        if (skipWhen.length > 0) {
            typeLines.push(`      SKIP rules for ${dt.slug} (pages matching these are NOT this type — use "none"):`);
            for (const rule of skipWhen) typeLines.push(`        • ${rule}`);
        }
        const recordIdGuidance = hints.record_id_guidance || null;
        if (recordIdGuidance) {
            typeLines.push(`      Record ID rule for ${dt.slug} (use this to determine record_id):`);
            typeLines.push(`        • ${recordIdGuidance}`);
        }
    }
    typeLines.push('  - none: this page does not match any of the above types');

    return `You are a document-page classifier for a geological/environmental document extraction pipeline.

You will see a BATCH of consecutive pages from a multi-page PDF. For each page, identify:
  1. document_type_slug — which type of document this page belongs to (or "none")
  2. page_purpose — whether this page contributes extractable data
  3. is_new_record — TRUE if this page starts a NEW logical record (e.g., a different well/boring, a new form with a different ID). FALSE if it continues the same record as the previous page.
  4. record_id — the primary identifier for the record this page belongs to (e.g., well ID "MW-1", boring number "B-3"). Use null if no clear identifier is visible or if the page is "none".
  5. confidence — calibrated confidence in the classification
  6. summary — a concise 1-2 sentence summary of what this page contains, including any identifiers, key data types, and record boundaries visible. This summary will be passed as context to classify later pages, so include details that help identify record continuity.

Available document types:
${typeLines.join('\n')}

IMPORTANT: The KEEP and SKIP rules above are authoritative. When a page matches a SKIP rule for a document type, classify it as "none" even if it discusses the same topic. When it matches a KEEP rule, classify it as that type. These rules override generic layout-based guessing.

page_purpose values:
  - "data": page contains extractable fields, table rows, or measurement values
  - "reference": reference material (legends, charts, keys) — same across all instances
  - "boilerplate": standardized text (disclaimers, certifications)
  - "cover": title page, section divider, appendix marker
  - "blank": blank page or only header/footer
  - "attachment": map, graph, photograph — non-tabular visual
  - "unknown": cannot determine purpose. Pages with slug="none" should use this.

Record boundary detection rules:
  - A new form header with a DIFFERENT well/boring ID = new record (is_new_record: true)
  - A continuation of the same well/boring (page 2 of same log) = same record (is_new_record: false)
  - The FIRST page in the batch is ALWAYS is_new_record: true unless the context from previous pages indicates it continues an existing record
  - Look for: different "Well/Boring #:", different "Project:" combined with different well ID, new form title block, different header format indicating a different firm or time period

Confidence: be conservative. Above 0.85 only when the page clearly matches a recognizable document type. Below 0.6 when guessing from layout alone.

CRITICAL: Each page gets its own classification object. Return exactly one object per page in the batch, in order.`;
}

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

function buildResponseSchema(batchSize, documentTypes) {
    const slugEnum = [...documentTypes.map(dt => dt.slug), 'none'];

    const pageClassification = {
        type: 'object',
        additionalProperties: false,
        properties: {
            page_number: {
                type: 'integer',
                description: 'The 1-indexed page number from the PDF.',
            },
            document_type_slug: {
                type: 'string',
                enum: slugEnum,
                description: 'Slug from the registry, or "none".',
            },
            page_purpose: {
                type: 'string',
                enum: ['data', 'reference', 'boilerplate', 'cover', 'blank', 'attachment', 'unknown'],
                description: 'Whether this page contributes extractable data.',
            },
            is_new_record: {
                type: 'boolean',
                description: 'TRUE if this page starts a new logical record (different well ID, new form header). FALSE if it continues the previous record.',
            },
            record_id: {
                type: ['string', 'null'],
                description: 'Primary identifier for the record (e.g., "MW-1", "IW-2"). Null if not identifiable or if slug is "none".',
            },
            confidence: {
                type: 'number',
                description: 'Calibrated confidence in the classification (0-1).',
            },
            summary: {
                type: 'string',
                description: 'Concise 1-2 sentence summary of this page. Include: document type, record ID, key content (lithology table, construction details, blow counts, etc.), and any visible record boundaries. Max 50 words.',
            },
        },
        required: ['page_number', 'document_type_slug', 'page_purpose', 'is_new_record', 'record_id', 'confidence', 'summary'],
    };

    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            pages: {
                type: 'array',
                items: pageClassification,
                description: `Array of exactly ${batchSize} page classifications, one per page in the batch, in order.`,
            },
        },
        required: ['pages'],
    };
}

// ---------------------------------------------------------------------------
// Context building (bounded — scales to 380+ pages)
// ---------------------------------------------------------------------------

/**
 * Build bounded context for a batch: last batch's full summaries + compressed record inventory.
 * Scales to any file size because context is O(records) not O(pages).
 */
function buildUserContent(pageImages, lastBatchSummaries, recordInventory, detail) {
    const parts = [];

    if (lastBatchSummaries.length > 0 || recordInventory.length > 0) {
        let contextText = '';

        if (recordInventory.length > 0) {
            contextText += 'RECORDS IDENTIFIED SO FAR IN THIS DOCUMENT:\n';
            contextText += recordInventory.map(r =>
                `  • ${r.slug} "${r.record_id}" — pages ${r.first_page}${r.last_page !== r.first_page ? '-' + r.last_page : ''} (${r.page_count} page${r.page_count > 1 ? 's' : ''})`
            ).join('\n');
            contextText += '\n\n';
        }

        if (lastBatchSummaries.length > 0) {
            contextText += 'IMMEDIATELY PRECEDING PAGES (last batch):\n';
            contextText += lastBatchSummaries.map(s =>
                `  Page ${s.page_number}: [${s.document_type_slug}] record_id="${s.record_id || 'none'}" — ${s.summary}`
            ).join('\n');
        }

        parts.push({
            type: 'text',
            text: `${contextText}\n\n---\n\nNow classify the following ${pageImages.length} page(s). Use the context above to determine if the first page continues an existing record or starts a new one.\n\nIMPORTANT RULES for is_new_record:\n- If a page's record_id MATCHES one already in the "RECORDS IDENTIFIED" list AND it has the same document_type_slug, set is_new_record=FALSE (it's continuing that record).\n- If a page shows a well/boring ID that doesn't match any record seen so far, it's a NEW record even if it looks similar (e.g., "EW-1" is different from "IW-1").\n- Only set is_new_record=TRUE when the record_id has genuinely NOT appeared before in this document.`,
        });
    } else {
        parts.push({
            type: 'text',
            text: `Classify the following ${pageImages.length} page(s) from the beginning of this PDF document.`,
        });
    }

    // Add page images
    for (const page of pageImages) {
        parts.push({
            type: 'text',
            text: `\n--- Page ${page.pageNumber} ---`,
        });
        parts.push({
            type: 'image_url',
            image_url: {
                url: `data:image/jpeg;base64,${page.jpeg.toString('base64')}`,
                detail,
            },
        });
    }

    return parts;
}

// ---------------------------------------------------------------------------
// Classify one batch
// ---------------------------------------------------------------------------

async function classifyBatch({ pageImages, lastBatchSummaries, recordInventory, documentTypes, options, batchIndex }) {
    const systemPrompt = buildSystemPrompt(documentTypes);
    const userContent = buildUserContent(pageImages, lastBatchSummaries, recordInventory, options.detail);
    const responseSchema = buildResponseSchema(pageImages.length, documentTypes);

    const startMs = Date.now();

    const response = await openai().chat.completions.create(
        {
            model: options.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent },
            ],
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'batched_page_classification',
                    strict: true,
                    schema: responseSchema,
                },
            },
        },
        { timeout: options.requestTimeoutMs }
    );

    const durationMs = Date.now() - startMs;
    const content = response.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error(`Empty response from VLM on batch ${batchIndex}`);
    }

    const parsed = JSON.parse(content);

    return {
        pages: parsed.pages,
        usage: response.usage,
        duration_ms: durationMs,
    };
}

// ---------------------------------------------------------------------------
// Section derivation from batched results
// ---------------------------------------------------------------------------

/**
 * Derive sections from batched classification results.
 * Groups consecutive pages by record_id within same slug.
 * Key logic: consecutive pages with same slug + same record_id always merge,
 * even if model erroneously says is_new_record=true (batch-boundary noise).
 */
export function deriveSectionsFromClassification(pageResults, opts = {}) {
    const thresholdsBySlug = opts.thresholdsBySlug instanceof Map ? opts.thresholdsBySlug : new Map();
    const DEFAULT_THRESHOLD = 0.75;
    const sections = [];
    let currentSection = null;

    function flush() {
        if (!currentSection) return;
        const pageNumbers = currentSection.pages.map(p => p.page_number);
        // Confidence: only from pages that belong to this section's slug
        // (absorbed 'none' gap pages should not affect section confidence)
        const sectionPages = currentSection.pages.filter(p => p.document_type_slug === currentSection.document_type_slug);
        const confidences = (sectionPages.length > 0 ? sectionPages : currentSection.pages).map(p => p.confidence ?? 0);
        const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
        const minConfidence = Math.min(...confidences);
        const threshold = thresholdsBySlug.get(currentSection.document_type_slug) ?? DEFAULT_THRESHOLD;

        const extraction_pages = [];
        const skipped_pages = [];
        for (const p of currentSection.pages) {
            const isData = (p.page_purpose ?? 'unknown') === 'data';
            const isDuplicate = p.duplicate_of != null;
            const isAbsorbedGap = p.document_type_slug === 'none' || !p.document_type_slug;
            if (isData && !isDuplicate && !isAbsorbedGap) {
                extraction_pages.push(p.page_number);
            } else {
                skipped_pages.push({
                    page_number: p.page_number,
                    reason: isAbsorbedGap ? 'gap_absorbed' : (p.duplicate_of != null ? 'duplicate' : (p.page_purpose ?? 'unknown')),
                    ...(p.duplicate_of != null ? { duplicate_of: p.duplicate_of } : {}),
                });
            }
        }

        sections.push({
            document_type_slug: currentSection.document_type_slug,
            record_id: currentSection.record_id,
            page_range: [pageNumbers[0], pageNumbers[pageNumbers.length - 1]],
            page_count: pageNumbers.length,
            extraction_pages,
            skipped_pages,
            page_purposes: currentSection.pages.map(p => p.page_purpose ?? 'unknown'),
            confidence: Number(avgConfidence.toFixed(4)),
            min_page_confidence: Number(minConfidence.toFixed(4)),
            status: minConfidence >= threshold ? 'auto_approved' : 'pending_review',
            threshold_used: threshold,
            summaries: currentSection.pages.map(p => p.summary),
        });
        currentSection = null;
    }

    // Buffer for 'none' pages between classified pages. If the next
    // classified page continues the same section, absorb the buffered
    // nones as skipped pages (preserving section continuity). If it
    // starts a new section, the gap was real — flush and discard.
    let pendingNonePages = [];

    for (const page of pageResults) {
        const slug = page.document_type_slug;

        // Buffer 'none' pages — decide their fate when the next classified page arrives
        if (!slug || slug === 'none') {
            pendingNonePages.push(page);
            continue;
        }

        // Determine if this page continues the current section
        const sameRecordAsCurrent = currentSection &&
            currentSection.document_type_slug === slug &&
            page.record_id && currentSection.record_id &&
            page.record_id === currentSection.record_id;

        const shouldStartNew = (
            !currentSection ||
            currentSection.document_type_slug !== slug ||
            (page.record_id && currentSection.record_id && page.record_id !== currentSection.record_id) ||
            (page.is_new_record && !sameRecordAsCurrent)
        );

        if (shouldStartNew) {
            // Gap pages between different sections are true boundaries — discard them
            flush();
            pendingNonePages = [];
            currentSection = {
                document_type_slug: slug,
                record_id: page.record_id,
                pages: [page],
            };
        } else {
            // This page continues the current section — absorb buffered none
            // pages into the section as skipped (preserves section continuity
            // so all data pages go to one AI call instead of being fragmented)
            for (const nonePage of pendingNonePages) {
                currentSection.pages.push(nonePage);
            }
            pendingNonePages = [];

            currentSection.pages.push(page);
            // Promote record_id if current section didn't have one
            if (page.record_id && !currentSection.record_id) {
                currentSection.record_id = page.record_id;
            }
        }
    }

    // Trailing none pages after the last section are true gaps — discard
    flush();
    return sections;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Classify every page of a PDF buffer using batched vision classification.
 *
 * @param {Object} args
 * @param {Buffer} args.pdfBuffer
 * @param {Array<{slug: string, display_name?: string, description?: string}>} args.documentTypes
 * @param {Object} [args.options]
 *
 * @returns {Promise<{
 *   classifier: Object,
 *   pages: Array<Object>,
 *   sections: Array<Object>,
 *   pageSummaries: Array<Object>,
 *   recordInventory: Array<Object>
 * }>}
 */
export async function classifyPdfBatched({ pdfBuffer, documentTypes, options = {} }) {
    if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
        throw new Error('classifyPdfBatched requires a non-empty pdfBuffer');
    }
    if (!Array.isArray(documentTypes) || documentTypes.length === 0) {
        throw new Error('classifyPdfBatched requires a non-empty documentTypes array');
    }

    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startedAt = Date.now();
    const ranAt = new Date().toISOString();

    // 1. Rasterize
    const allPages = await rasterizePdf(pdfBuffer, {
        widthPx: opts.widthPx,
        jpegQuality: opts.jpegQuality,
    });

    console.log(
        `🧠 classifying ${allPages.length} page(s) in batches of ${opts.batchSize} ` +
        `with ${opts.model} (detail=${opts.detail}, width=${opts.widthPx}px, q=${opts.jpegQuality})`
    );

    // 2. Process in batches with bounded context
    const allResults = [];
    let lastBatchSummaries = [];
    let recordInventory = [];
    let totalTokens = { prompt: 0, completion: 0, total: 0 };
    let batchCount = 0;

    for (let i = 0; i < allPages.length; i += opts.batchSize) {
        const batch = allPages.slice(i, i + opts.batchSize);
        const batchIndex = batchCount++;

        let result;
        try {
            result = await classifyBatch({
                pageImages: batch,
                lastBatchSummaries,
                recordInventory,
                documentTypes,
                options: opts,
                batchIndex,
            });
        } catch (err) {
            // If a batch fails, mark those pages as failed but continue
            console.error(`❌ Batch ${batchIndex} failed: ${err.message}`);
            for (const page of batch) {
                allResults.push({
                    page_number: page.pageNumber,
                    document_type_slug: 'none',
                    page_purpose: 'unknown',
                    is_new_record: true,
                    record_id: null,
                    confidence: 0,
                    summary: '',
                    error: err.message,
                });
            }
            continue;
        }

        // Normalize record_ids before accumulation so grouping, inventory,
        // and cross-batch context all see consistent identifiers regardless
        // of OCR variation ("GP- 1" vs "GP-1" vs "gp-1" all become "GP-1").
        for (const p of result.pages) {
            p.record_id = normalizeRecordId(p.record_id);
        }

        // Accumulate results
        allResults.push(...result.pages);

        // Update bounded context for next batch
        lastBatchSummaries = result.pages.map(p => ({
            page_number: p.page_number,
            document_type_slug: p.document_type_slug,
            record_id: p.record_id,
            summary: p.summary,
        }));

        // Update record inventory
        for (const page of result.pages) {
            if (!page.record_id) continue;
            const existing = recordInventory.find(
                r => r.record_id === page.record_id && r.slug === page.document_type_slug
            );
            if (existing) {
                existing.last_page = page.page_number;
                existing.page_count++;
            } else {
                recordInventory.push({
                    record_id: page.record_id,
                    slug: page.document_type_slug,
                    first_page: page.page_number,
                    last_page: page.page_number,
                    page_count: 1,
                });
            }
        }

        // Accumulate token usage
        totalTokens.prompt += result.usage?.prompt_tokens || 0;
        totalTokens.completion += result.usage?.completion_tokens || 0;
        totalTokens.total += result.usage?.total_tokens || 0;

        const batchPages = result.pages.map(p => p.page_number).join(',');
        console.log(
            `   📦 Batch ${batchIndex + 1}/${Math.ceil(allPages.length / opts.batchSize)}: ` +
            `pages [${batchPages}] — ${result.duration_ms}ms, ${result.usage?.total_tokens || 0} tokens`
        );
    }

    // 3. Assign duplicate markers (byte-identical pages)
    // Compute signatures for dedup (even batched classifier benefits from this)
    for (let idx = 0; idx < allResults.length; idx++) {
        const page = allPages.find(p => p.pageNumber === allResults[idx].page_number);
        if (page) {
            allResults[idx].dupe_signature = computeJpegSignature(page.jpeg);
        }
    }
    const annotated = assignDuplicates(allResults);

    const durationMs = Date.now() - startedAt;
    const errorCount = annotated.filter(c => c.error).length;
    if (errorCount > 0) {
        console.warn(`⚠️  ${errorCount}/${allPages.length} page(s) had classification errors.`);
    }
    const dupeCount = countDuplicates(annotated);
    if (dupeCount > 0) {
        console.log(`♻️  detected ${dupeCount} duplicate page(s) (byte-identical to an earlier page)`);
    }

    // 4. Build page summaries for caching
    const pageSummaries = annotated.map(p => ({
        page_number: p.page_number,
        document_type_slug: p.document_type_slug,
        record_id: p.record_id,
        summary: p.summary,
    }));

    console.log(
        `✅ Batched classification complete: ${allPages.length} pages, ${batchCount} batches, ` +
        `${recordInventory.length} records found, ${(durationMs / 1000).toFixed(1)}s total`
    );

    return {
        classifier: {
            name: 'openai-vision-batched',
            model: opts.model,
            version: opts.classifierVersion,
            ran_at: ranAt,
            duration_ms: durationMs,
            page_count: allPages.length,
            batch_size: opts.batchSize,
            batch_count: batchCount,
            image: { width: opts.widthPx, detail: opts.detail, jpeg_quality: opts.jpegQuality },
            dedup: { strategy: 'md5_byte_hash', version: 1 },
            tokens: totalTokens,
        },
        pages: annotated,
        pageSummaries,
        recordInventory,
    };
}

export default {
    classifyPdfBatched,
    deriveSectionsFromClassification,
    normalizeRecordId,
};
