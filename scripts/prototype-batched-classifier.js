/**
 * Prototype: Batched Visual Page Classifier with Running Summaries
 *
 * Tests the new classification approach on a known 13-page file that contains
 * 6 distinct well records (MW-1, IW-1, IW-2, IW-3, EW-1, EW-2).
 *
 * The current per-page classifier groups all 7 data pages into ONE section
 * because they share the same slug. This prototype sends pages in batches of 5,
 * with running summaries propagated between batches, so the model can:
 *   - Detect record boundaries (new form headers, different well IDs)
 *   - Assign a record_id per page
 *   - Produce a compact summary for use as context in subsequent batches
 *
 * Usage:
 *   node --experimental-vm-modules scripts/prototype-batched-classifier.js
 *
 * Output:
 *   scripts/output/batched-classifier-result.json
 */

import OpenAI from 'openai';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { rasterizePdf } from '../src/services/pdfRasterizer.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// --- Config ---
const BATCH_SIZE = 5;
const MODEL = 'gpt-4o-mini';
const RASTER_WIDTH = parseInt(process.env.RASTER_WIDTH || '768', 10);
const JPEG_QUALITY = parseInt(process.env.JPEG_QUALITY || '75', 10);
const DETAIL = 'high'; // keeping high detail, testing 512px width
const S3_KEY = 'jobs/a9773e37-1a04-4424-97b7-3589677db7d3/0001_American Hydrogeology Corporation- Boring Well Logs and Data Summaries_1780194221603_sdwtlikylia.pdf';
const BUCKET = process.env.S3_BUCKET_NAME || 'core-extract-document-extractor-files';

// Document types available for classification
const DOCUMENT_TYPES = [
    { slug: 'borehole_log', display_name: 'Generalized borehole log schema', description: 'Boring logs, monitoring well logs, production well logs, direct push logs' },
    { slug: 'aquifer_test', display_name: 'Generalized aquifer test schema', description: 'Aquifer test reports and pump test data' },
    { slug: 'aquifer_test_data', display_name: 'Aquifer Test Data', description: 'Time-series water level data from pumping/slug tests' },
    { slug: 'analytical_results', display_name: 'Generalized analytical results', description: 'Laboratory analytical results tables' },
    { slug: 'field_sampling_forms', display_name: 'Field sampling forms', description: 'Field sampling data sheets' },
];

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- S3 client ---
const s3 = new S3Client({
    region: process.env.AWS_REGION || 'us-west-2',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// ---------------------------------------------------------------------------
// System prompt for batched classification
// ---------------------------------------------------------------------------

function buildBatchedSystemPrompt(documentTypes) {
    return `You are a document-page classifier for a geological/environmental document extraction pipeline.

You will see a BATCH of consecutive pages from a multi-page PDF. For each page, identify:
  1. document_type_slug — which type of document this page belongs to (or "none")
  2. page_purpose — whether this page contributes extractable data
  3. is_new_record — TRUE if this page starts a NEW logical record (e.g., a different well/boring, a new form with a different ID). FALSE if it continues the same record as the previous page.
  4. record_id — the primary identifier for the record this page belongs to (e.g., well ID "MW-1", boring number "B-3"). Use null if no clear identifier is visible or if the page is "none".
  5. confidence — calibrated confidence in the classification
  6. summary — a concise 1-2 sentence summary of what this page contains, including any identifiers, key data types, and record boundaries visible. This summary will be passed as context to classify later pages, so include details that help identify record continuity.

Available document types:
${documentTypes.map(dt => `  - ${dt.slug} (${dt.display_name}) — ${dt.description}`).join('\n')}
  - none: this page does not match any of the above types

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
// Response schema for batched classification
// ---------------------------------------------------------------------------

function buildBatchedResponseSchema(batchSize) {
    const slugEnum = [...DOCUMENT_TYPES.map(dt => dt.slug), 'none'];

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
// Build user message for a batch
// ---------------------------------------------------------------------------

/**
 * Build bounded context for a batch: last batch's full summaries + compressed record inventory.
 * This scales to 380+ page files because it's O(records) not O(pages).
 *
 * For a 380-page file with ~50 records, bounded context is ~60 lines of text
 * vs ~375 lines for "all summaries" mode.
 */
function buildBoundedContext(lastBatchSummaries, recordInventory) {
    if (lastBatchSummaries.length === 0 && recordInventory.length === 0) {
        return [];
    }
    // Return a special structure that buildBatchUserContent can format
    return { _bounded: true, lastBatchSummaries, recordInventory };
}

function buildBatchUserContent(pageImages, previousContext) {
    const parts = [];

    // Context from previous batches
    if (previousContext && previousContext._bounded) {
        // Bounded context mode
        const { lastBatchSummaries, recordInventory } = previousContext;
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
    } else if (Array.isArray(previousContext) && previousContext.length > 0) {
        // Legacy "all summaries" mode
        const contextText = previousContext.map(s =>
            `Page ${s.page_number}: [${s.document_type_slug}] record_id="${s.record_id || 'none'}" — ${s.summary}`
        ).join('\n');

        parts.push({
            type: 'text',
            text: `CONTEXT FROM PREVIOUSLY CLASSIFIED PAGES:\n${contextText}\n\n---\n\nNow classify the following ${pageImages.length} page(s). Use the context above to determine if the first page continues an existing record or starts a new one.`,
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
                detail: DETAIL,
            },
        });
    }

    return parts;
}

// ---------------------------------------------------------------------------
// Classify one batch
// ---------------------------------------------------------------------------

async function classifyBatch(pageImages, previousSummaries, batchIndex) {
    const systemPrompt = buildBatchedSystemPrompt(DOCUMENT_TYPES);
    const userContent = buildBatchUserContent(pageImages, previousSummaries);
    const responseSchema = buildBatchedResponseSchema(pageImages.length);

    console.log(`\n📦 Batch ${batchIndex + 1}: pages ${pageImages[0].pageNumber}-${pageImages[pageImages.length - 1].pageNumber} (${pageImages.length} pages)`);
    const contextSize = previousSummaries?._bounded
        ? `bounded (${previousSummaries.lastBatchSummaries.length} last-batch + ${previousSummaries.recordInventory.length} records)`
        : `${Array.isArray(previousSummaries) ? previousSummaries.length : 0} previous page summaries`;
    console.log(`   Context: ${contextSize}`);

    const startMs = Date.now();

    const response = await openai.chat.completions.create({
        model: MODEL,
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
    });

    const durationMs = Date.now() - startMs;
    const content = response.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content);

    console.log(`   ✅ Completed in ${(durationMs / 1000).toFixed(2)}s`);
    console.log(`   Tokens: prompt=${response.usage?.prompt_tokens}, completion=${response.usage?.completion_tokens}, total=${response.usage?.total_tokens}`);

    // Log each page result
    for (const page of parsed.pages) {
        const marker = page.is_new_record ? '🆕' : '  ';
        const recId = page.record_id ? `[${page.record_id}]` : '[none]';
        console.log(`   ${marker} p${page.page_number}: ${page.document_type_slug} ${recId} (${page.confidence}) — ${page.summary.substring(0, 60)}`);
    }

    return {
        pages: parsed.pages,
        usage: response.usage,
        duration_ms: durationMs,
    };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    console.log('🚀 Batched Visual Page Classifier Prototype');
    console.log('============================================\n');

    // 1. Download PDF from S3
    console.log('📥 Downloading PDF from S3...');
    const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: S3_KEY });
    const s3Response = await s3.send(getCmd);
    const chunks = [];
    for await (const chunk of s3Response.Body) chunks.push(chunk);
    const pdfBuffer = Buffer.concat(chunks);
    console.log(`   File size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

    // 2. Rasterize all pages
    console.log(`\n🖼️  Rasterizing PDF pages at ${RASTER_WIDTH}px width...`);
    const allPages = await rasterizePdf(pdfBuffer, { widthPx: RASTER_WIDTH, jpegQuality: JPEG_QUALITY });
    console.log(`   ${allPages.length} pages rasterized`);

    // 3. Process in batches of BATCH_SIZE with bounded context
    // Context strategy (scalable to 380+ pages):
    //   - Last batch: full summaries (local continuity — what came immediately before)
    //   - Record inventory: compressed list of all records seen so far (global awareness)
    // This bounds context to O(records) instead of O(pages), critical for large files.
    const CONTEXT_MODE = process.env.CONTEXT_MODE || 'bounded'; // 'all' | 'bounded'
    const allResults = [];
    let allSummaries = []; // full summaries for all pages (used for output)
    let lastBatchSummaries = []; // just the last batch's summaries
    let recordInventory = []; // compressed: { record_id, slug, first_page, last_page }
    let totalTokens = { prompt: 0, completion: 0, total: 0 };
    const totalStartMs = Date.now();

    for (let i = 0; i < allPages.length; i += BATCH_SIZE) {
        const batch = allPages.slice(i, i + BATCH_SIZE);
        const batchIndex = Math.floor(i / BATCH_SIZE);

        // Build context for this batch based on mode
        let contextForBatch;
        if (CONTEXT_MODE === 'all') {
            // Original: pass ALL previous summaries (doesn't scale)
            contextForBatch = allSummaries;
        } else {
            // Bounded: last batch summaries + compressed record inventory
            contextForBatch = buildBoundedContext(lastBatchSummaries, recordInventory);
        }

        const result = await classifyBatch(batch, contextForBatch, batchIndex);

        // Accumulate results
        allResults.push(...result.pages);

        // Update full summaries (for output file)
        const batchSummaries = result.pages.map(p => ({
            page_number: p.page_number,
            document_type_slug: p.document_type_slug,
            record_id: p.record_id,
            summary: p.summary,
        }));
        allSummaries = [...allSummaries, ...batchSummaries];
        lastBatchSummaries = batchSummaries;

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
    }

    const totalDurationMs = Date.now() - totalStartMs;

    // 4. Derive sections from results (group by record_id within same slug)
    const sections = deriveSectionsFromBatchedResults(allResults);

    // 5. Build final output
    const output = {
        metadata: {
            file: '0001_American Hydrogeology Corporation- Boring Well Logs and Data Summaries.pdf',
            file_id: 'fb1eaf7d-969f-427b-bff8-fcb4b273fc7c',
            total_pages: allPages.length,
            batch_size: BATCH_SIZE,
            model: MODEL,
            detail: DETAIL,
            raster_width_px: RASTER_WIDTH,
            jpeg_quality: JPEG_QUALITY,
            total_duration_ms: totalDurationMs,
            total_tokens: totalTokens,
            batches: Math.ceil(allPages.length / BATCH_SIZE),
        },
        // Comparison: what the current classifier produced
        current_classifier_result: {
            sections: 1,
            pages_in_section: '2-8 (all 7 data pages merged as one section)',
            problem: 'MW-1, IW-1, IW-2, IW-3, EW-1, EW-2 all lumped together — extraction produces one flat object mixing all wells',
        },
        context_mode: CONTEXT_MODE,
        // New: per-page classifications with record boundaries
        page_classifications: allResults,
        // New: derived sections (grouped by record_id)
        derived_sections: sections,
        // Record inventory (compressed view of all records found)
        record_inventory: recordInventory,
        // The page summaries — reusable context for future extraction
        page_summaries: allSummaries,
    };

    // 6. Write output
    const outputPath = path.join(OUTPUT_DIR, `batched-classifier-${RASTER_WIDTH}px-q${JPEG_QUALITY}-${DETAIL}-detail.json`);
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`\n\n📄 Output written to: ${outputPath}`);

    // 7. Summary
    console.log('\n============================================');
    console.log('📊 SUMMARY');
    console.log('============================================');
    console.log(`Total pages: ${allPages.length}`);
    console.log(`Batches: ${Math.ceil(allPages.length / BATCH_SIZE)}`);
    console.log(`Total duration: ${(totalDurationMs / 1000).toFixed(2)}s`);
    console.log(`Total tokens: ${totalTokens.total} (prompt: ${totalTokens.prompt}, completion: ${totalTokens.completion})`);
    console.log(`\nDerived sections: ${sections.length}`);
    for (const section of sections) {
        console.log(`  📑 ${section.document_type_slug} [${section.record_id}] — pages ${section.page_range.join('-')} (${section.extraction_pages.length} extractable)`);
    }

    // Compare with old result
    console.log('\n--- COMPARISON ---');
    console.log('Old classifier: 1 section (pages 2-8, all wells merged)');
    console.log(`New classifier: ${sections.length} sections (records properly separated)`);
}

// ---------------------------------------------------------------------------
// Section derivation from batched results
// ---------------------------------------------------------------------------

function deriveSectionsFromBatchedResults(pageResults) {
    const sections = [];
    let currentSection = null;

    for (const page of pageResults) {
        // Skip "none" pages
        if (page.document_type_slug === 'none') {
            if (currentSection) {
                sections.push(finalizeSection(currentSection));
                currentSection = null;
            }
            continue;
        }

        // New record boundary or different slug → start new section.
        // Key logic: if the model says is_new_record=true BUT the record_id
        // and slug match the current section, it's a continuation (the model
        // was confused by the batch boundary). Only split when the record_id
        // actually DIFFERS or the slug changes.
        const sameRecordAsCurrent = currentSection &&
            currentSection.document_type_slug === page.document_type_slug &&
            page.record_id && currentSection.record_id &&
            page.record_id === currentSection.record_id;

        const shouldStartNew = (
            !currentSection ||
            currentSection.document_type_slug !== page.document_type_slug ||
            (page.record_id && currentSection.record_id && page.record_id !== currentSection.record_id) ||
            (page.is_new_record && !sameRecordAsCurrent)
        );

        if (shouldStartNew) {
            if (currentSection) {
                sections.push(finalizeSection(currentSection));
            }
            currentSection = {
                document_type_slug: page.document_type_slug,
                record_id: page.record_id,
                pages: [page],
            };
        } else {
            currentSection.pages.push(page);
            // Update record_id if this page has one and current doesn't
            if (page.record_id && !currentSection.record_id) {
                currentSection.record_id = page.record_id;
            }
        }
    }

    // Flush last section
    if (currentSection) {
        sections.push(finalizeSection(currentSection));
    }

    return sections;
}

function finalizeSection(section) {
    const pageNumbers = section.pages.map(p => p.page_number);
    const extractionPages = section.pages
        .filter(p => p.page_purpose === 'data')
        .map(p => p.page_number);

    const confidences = section.pages.map(p => p.confidence);
    const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    const minConfidence = Math.min(...confidences);

    return {
        document_type_slug: section.document_type_slug,
        record_id: section.record_id,
        page_range: [Math.min(...pageNumbers), Math.max(...pageNumbers)],
        page_count: pageNumbers.length,
        extraction_pages: extractionPages,
        confidence: Number(avgConfidence.toFixed(4)),
        min_page_confidence: Number(minConfidence.toFixed(4)),
        summaries: section.pages.map(p => p.summary),
    };
}

// --- Run ---
main().catch((err) => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
