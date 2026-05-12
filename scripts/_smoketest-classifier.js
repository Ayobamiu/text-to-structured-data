#!/usr/bin/env node
/**
 * Smoke test for the visual page classifier components.
 *
 * Tests:
 *   1. Section grouper logic (pure, no external deps)
 *   2. Rasterizer on a synthetic 3-page PDF (no LLM, no OPENAI_API_KEY needed)
 *
 * Does NOT call the OpenAI vision API (costs money + needs real-content test PDFs).
 * For end-to-end validation against real PDFs, use ai/scripts/classify-pdf.js.
 *
 * Run: node ai/scripts/_smoketest-classifier.js
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { rasterizePdf, isRasterizerAvailable } from '../src/services/pdfRasterizer.js';
import {
    groupIntoSections,
    deriveFileStatus,
    getGrouperMetadata,
    flattenExtractionPages,
} from '../src/services/sectionGrouper.js';
import {
    computeJpegSignature,
    assignDuplicates,
    countDuplicates,
} from '../src/services/pageDeduplicator.js';
import { extractAndProcessPerSection } from '../src/services/perSectionExtractor.js';
import { resolveExtractionFlags } from '../src/services/visualClassifierWiring.js';

let failures = 0;

function assert(cond, msg) {
    if (cond) {
        console.log(`  ✓ ${msg}`);
    } else {
        failures++;
        console.error(`  ✗ ${msg}`);
    }
}

function deepEqualJSON(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Test 1: section grouper (slug-only boundary strategy) ──────────────────
console.log('\n[1] Section grouper — slug-only strategy');

{
    // Single section, three pages, all confident.
    const pages = [
        { page_number: 1, document_type_slug: 'mgs_well_log', page_role: 'first', confidence: 0.95 },
        { page_number: 2, document_type_slug: 'mgs_well_log', page_role: 'middle', confidence: 0.9 },
        { page_number: 3, document_type_slug: 'mgs_well_log', page_role: 'last', confidence: 0.92 },
    ];
    const sections = groupIntoSections(pages);
    assert(sections.length === 1, 'one section');
    assert(sections[0].document_type_slug === 'mgs_well_log', 'correct slug');
    assert(deepEqualJSON(sections[0].page_range, [1, 3]), 'correct page range');
    assert(sections[0].page_count === 3, 'correct page count');
    assert(sections[0].status === 'auto_approved', 'auto_approved at default threshold (0.75)');
    assert(deriveFileStatus(sections) === 'auto_approved', 'file status auto_approved');
}

{
    // Same slug across pages — even with role chaos that the OLD grouper
    // would have split into many sections — now collapses to one.
    // This is the new behaviour: slug-only boundaries, role is metadata.
    const pages = [
        { page_number: 1, document_type_slug: 'boring_log', page_role: 'first', confidence: 0.9 },
        { page_number: 2, document_type_slug: 'boring_log', page_role: 'last', confidence: 0.9 },
        { page_number: 3, document_type_slug: 'boring_log', page_role: 'first', confidence: 0.9 },
        { page_number: 4, document_type_slug: 'boring_log', page_role: 'last', confidence: 0.9 },
    ];
    const sections = groupIntoSections(pages);
    assert(sections.length === 1, 'same-slug run collapses to ONE section regardless of role chain');
    assert(deepEqualJSON(sections[0].page_range, [1, 4]), 'covers full page range');
    assert(deepEqualJSON(sections[0].page_roles, ['first', 'last', 'first', 'last']), 'roles preserved as metadata');
}

{
    // Regression: real output from 17378_WF.PDF. Old grouper produced 6
    // sections from 8 same-slug pages. New grouper produces 1.
    const pages = [
        { page_number: 1, document_type_slug: 'none', page_role: 'none', confidence: 0.95 },
        { page_number: 2, document_type_slug: 'mgs_well_log', page_role: 'first', confidence: 0.90 },
        { page_number: 3, document_type_slug: 'mgs_well_log', page_role: 'first', confidence: 0.95 },
        { page_number: 4, document_type_slug: 'mgs_well_log', page_role: 'first', confidence: 0.95 },
        { page_number: 5, document_type_slug: 'mgs_well_log', page_role: 'last',  confidence: 0.95 },
        { page_number: 6, document_type_slug: 'mgs_well_log', page_role: 'last',  confidence: 0.90 },
        { page_number: 7, document_type_slug: 'mgs_well_log', page_role: 'last',  confidence: 0.90 },
        { page_number: 8, document_type_slug: 'mgs_well_log', page_role: 'middle', confidence: 0.90 },
        { page_number: 9, document_type_slug: 'mgs_well_log', page_role: 'middle', confidence: 0.85 },
    ];
    const sections = groupIntoSections(pages);
    assert(sections.length === 1, 'real-PDF regression: 1 section (was 6 with old role-aware grouper)');
    assert(deepEqualJSON(sections[0].page_range, [2, 9]), 'covers pages 2-9');
    assert(sections[0].page_count === 8, '8-page section');
    assert(sections[0].min_page_confidence === 0.85, 'min confidence preserved');
}

{
    // 'none' page breaks runs (the only role-independent split signal left).
    const pages = [
        { page_number: 1, document_type_slug: 'mgs_well_log', page_role: 'first', confidence: 0.9 },
        { page_number: 2, document_type_slug: 'none', page_role: 'none', confidence: 0.0 },
        { page_number: 3, document_type_slug: 'mgs_well_log', page_role: 'first', confidence: 0.9 },
    ];
    const sections = groupIntoSections(pages);
    assert(sections.length === 2, 'two sections (none page breaks runs)');
}

{
    // Single 'standalone' page — no longer special-cased; just a 1-page run.
    const pages = [
        { page_number: 1, document_type_slug: 'aquifer_test', page_role: 'standalone', confidence: 0.88 },
    ];
    const sections = groupIntoSections(pages);
    assert(sections.length === 1, 'one section');
    assert(sections[0].page_count === 1, 'one page');
    assert(deepEqualJSON(sections[0].page_roles, ['standalone']), 'standalone preserved as role metadata');
}

{
    // Below threshold → pending_review.
    const pages = [
        { page_number: 1, document_type_slug: 'mgs_well_log', page_role: 'first', confidence: 0.6 },
        { page_number: 2, document_type_slug: 'mgs_well_log', page_role: 'last', confidence: 0.7 },
    ];
    const thresholds = new Map([['mgs_well_log', 0.75]]);
    const sections = groupIntoSections(pages, { thresholdsBySlug: thresholds });
    assert(sections.length === 1, 'one section below threshold');
    assert(sections[0].status === 'pending_review', 'status pending_review (min 0.6 < 0.75)');
    assert(deriveFileStatus(sections) === 'pending_review', 'file status pending_review');
}

{
    // All none → no sections, file status skipped.
    const pages = [
        { page_number: 1, document_type_slug: 'none', page_role: 'none', confidence: 0 },
        { page_number: 2, document_type_slug: 'none', page_role: 'none', confidence: 0 },
    ];
    const sections = groupIntoSections(pages);
    assert(sections.length === 0, 'no sections when all "none"');
    assert(deriveFileStatus(sections) === 'skipped', 'file status skipped');
}

{
    // Slug change still splits (the other role-independent split signal).
    const pages = [
        { page_number: 1, document_type_slug: 'boring_log', page_role: 'first', confidence: 0.9 },
        { page_number: 2, document_type_slug: 'boring_log', page_role: 'last', confidence: 0.9 },
        { page_number: 3, document_type_slug: 'aquifer_test', page_role: 'middle', confidence: 0.8 },
    ];
    const sections = groupIntoSections(pages);
    assert(sections.length === 2, 'slug change splits');
    assert(sections[1].document_type_slug === 'aquifer_test', 'second is aquifer_test');
}

{
    // Grouper metadata is self-describing and pinned to a version.
    const meta = getGrouperMetadata();
    assert(meta.strategy === 'slug_only', 'grouper strategy is slug_only');
    assert(meta.version === 3, 'grouper version is 3 (post extraction_pages addition)');
}

// ─── Test 1.5: extraction_pages + skipped_pages derivation ──────────────────
console.log('\n[1.5] Section grouper — extraction_pages + skipped_pages');

{
    // Mixed-purpose section. Only 'data' pages with no duplicate flag count
    // toward extraction; everything else is skipped with a reason.
    const pages = [
        { page_number: 1, document_type_slug: 'mgs_well_log', page_role: 'first',  page_purpose: 'data',        confidence: 0.95, duplicate_of: null },
        { page_number: 2, document_type_slug: 'mgs_well_log', page_role: 'middle', page_purpose: 'reference',   confidence: 0.92, duplicate_of: null },
        { page_number: 3, document_type_slug: 'mgs_well_log', page_role: 'middle', page_purpose: 'data',        confidence: 0.90, duplicate_of: null },
        { page_number: 4, document_type_slug: 'mgs_well_log', page_role: 'middle', page_purpose: 'boilerplate', confidence: 0.88, duplicate_of: null },
        { page_number: 5, document_type_slug: 'mgs_well_log', page_role: 'last',   page_purpose: 'data',        confidence: 0.94, duplicate_of: null },
    ];
    const sections = groupIntoSections(pages);
    assert(sections.length === 1, 'one section');
    assert(deepEqualJSON(sections[0].extraction_pages, [1, 3, 5]), 'extraction_pages = [1, 3, 5] (data pages only)');
    assert(sections[0].skipped_pages.length === 2, '2 skipped pages');
    assert(sections[0].skipped_pages[0].reason === 'reference', 'page 2 skipped reason=reference');
    assert(sections[0].skipped_pages[1].reason === 'boilerplate', 'page 4 skipped reason=boilerplate');
    assert(deepEqualJSON(sections[0].page_purposes, ['data', 'reference', 'data', 'boilerplate', 'data']), 'page_purposes parallel array preserved');
}

{
    // Duplicate signal wins over purpose. A "data" page that's a duplicate
    // of an earlier page is NOT extracted (we already have that data),
    // and skip reason is 'duplicate' (the more specific signal).
    const pages = [
        { page_number: 1, document_type_slug: 'mgs_well_log', page_role: 'first',  page_purpose: 'data', confidence: 0.95, duplicate_of: null },
        { page_number: 2, document_type_slug: 'mgs_well_log', page_role: 'middle', page_purpose: 'data', confidence: 0.92, duplicate_of: 1    },
        { page_number: 3, document_type_slug: 'mgs_well_log', page_role: 'last',   page_purpose: 'data', confidence: 0.90, duplicate_of: null },
    ];
    const sections = groupIntoSections(pages);
    assert(deepEqualJSON(sections[0].extraction_pages, [1, 3]), 'duplicate page excluded from extraction even when purpose=data');
    assert(sections[0].skipped_pages.length === 1, 'one skipped page');
    assert(sections[0].skipped_pages[0].reason === 'duplicate', 'duplicate wins over purpose');
    assert(sections[0].skipped_pages[0].duplicate_of === 1, 'duplicate_of pointer preserved');
    assert(sections[0].skipped_pages[0].page_purpose === 'data', 'original page_purpose still recorded for context');
}

{
    // Section with zero data pages — extraction_pages is empty, all skipped.
    // Section status still reflects classification confidence (not extractability).
    const pages = [
        { page_number: 1, document_type_slug: 'mgs_well_log', page_role: 'first', page_purpose: 'reference',   confidence: 0.95, duplicate_of: null },
        { page_number: 2, document_type_slug: 'mgs_well_log', page_role: 'last',  page_purpose: 'boilerplate', confidence: 0.92, duplicate_of: null },
    ];
    const sections = groupIntoSections(pages);
    assert(sections.length === 1, 'one section');
    assert(sections[0].extraction_pages.length === 0, 'no extraction pages');
    assert(sections[0].skipped_pages.length === 2, 'all pages skipped');
    assert(sections[0].status === 'auto_approved', 'section status still based on confidence, not extractability');
}

{
    // Missing page_purpose (e.g. older payloads) defaults to 'unknown'
    // → not extracted. Backwards-compatible.
    const pages = [
        { page_number: 1, document_type_slug: 'mgs_well_log', page_role: 'first', confidence: 0.9 },
    ];
    const sections = groupIntoSections(pages);
    assert(sections[0].extraction_pages.length === 0, 'missing purpose treated as non-data');
    assert(sections[0].skipped_pages[0].reason === 'unknown', 'skip reason = unknown when purpose missing');
}

// ─── Test 1.55: flattenExtractionPages (worker → extractor handoff) ─────────
console.log('\n[1.55] flattenExtractionPages — union across sections');

{
    const sections = [
        { document_type_slug: 'mgs_well_log', extraction_pages: [2, 3, 4], status: 'auto_approved' },
        { document_type_slug: 'aquifer_test',  extraction_pages: [7, 8],    status: 'auto_approved' },
    ];
    assert(deepEqualJSON(flattenExtractionPages(sections), [2, 3, 4, 7, 8]), 'union across multiple sections');
}

{
    // Non-contiguous sections produce a sorted ascending result.
    const sections = [
        { document_type_slug: 'a', extraction_pages: [10, 11], status: 'auto_approved' },
        { document_type_slug: 'b', extraction_pages: [3, 4],   status: 'auto_approved' },
    ];
    assert(deepEqualJSON(flattenExtractionPages(sections), [3, 4, 10, 11]), 'output is sorted ascending');
}

{
    // Defensive: pages that overlap across sections are de-duplicated.
    const sections = [
        { document_type_slug: 'a', extraction_pages: [1, 2, 3], status: 'auto_approved' },
        { document_type_slug: 'b', extraction_pages: [3, 4, 5], status: 'auto_approved' },
    ];
    assert(deepEqualJSON(flattenExtractionPages(sections), [1, 2, 3, 4, 5]), 'overlapping pages de-duplicated');
}

{
    // Empty / missing inputs → empty list.
    assert(deepEqualJSON(flattenExtractionPages([]), []), 'empty section list → empty pages');
    assert(deepEqualJSON(flattenExtractionPages(null), []), 'null section list → empty pages');
    assert(deepEqualJSON(flattenExtractionPages([{ extraction_pages: [], status: 'auto_approved' }]), []), 'all-empty extraction_pages → empty pages');
}

{
    // Default (since the routing-review UI shipped): pending_review sections
    // are held back; only 'auto_approved' and 'approved' (post human-review)
    // sections contribute pages.
    const sections = [
        { document_type_slug: 'a', extraction_pages: [1, 2], status: 'auto_approved' },
        { document_type_slug: 'b', extraction_pages: [5],    status: 'pending_review' },
        { document_type_slug: 'c', extraction_pages: [9],    status: 'approved' },
    ];
    assert(
        deepEqualJSON(flattenExtractionPages(sections), [1, 2, 9]),
        'default skips pending_review but keeps auto_approved + approved'
    );
}

{
    // Explicit includePendingReview=true: opt-in escape hatch for backfills /
    // smoke tests that intentionally want to ignore the review gate.
    const sections = [
        { document_type_slug: 'a', extraction_pages: [1, 2], status: 'auto_approved' },
        { document_type_slug: 'b', extraction_pages: [5],    status: 'pending_review' },
    ];
    assert(
        deepEqualJSON(
            flattenExtractionPages(sections, { includePendingReview: true }),
            [1, 2, 5]
        ),
        'includePendingReview=true overrides the gate'
    );
}

// ─── Test 1.6: pageDeduplicator ──────────────────────────────────────────────
console.log('\n[1.6] Page deduplicator');

{
    // Identical buffers → identical signatures.
    const a = Buffer.from('hello-world-jpeg-bytes');
    const b = Buffer.from('hello-world-jpeg-bytes');
    const c = Buffer.from('different-bytes');
    assert(computeJpegSignature(a) === computeJpegSignature(b), 'identical buffers → identical signatures');
    assert(computeJpegSignature(a) !== computeJpegSignature(c), 'different buffers → different signatures');
    assert(/^[a-f0-9]{32}$/.test(computeJpegSignature(a)), 'signature is 32-char lowercase hex (MD5)');
}

{
    // assignDuplicates: first occurrence wins; subsequent identical
    // signatures point at the first.
    const pages = [
        { page_number: 1, dupe_signature: 'aaa' },
        { page_number: 2, dupe_signature: 'bbb' },
        { page_number: 3, dupe_signature: 'aaa' }, // dupe of 1
        { page_number: 4, dupe_signature: 'ccc' },
        { page_number: 5, dupe_signature: 'aaa' }, // dupe of 1 (not of 3)
        { page_number: 6, dupe_signature: 'bbb' }, // dupe of 2
    ];
    const annotated = assignDuplicates(pages);
    assert(annotated[0].duplicate_of === null, 'p1 is canonical');
    assert(annotated[1].duplicate_of === null, 'p2 is canonical');
    assert(annotated[2].duplicate_of === 1, 'p3 → p1');
    assert(annotated[3].duplicate_of === null, 'p4 is canonical');
    assert(annotated[4].duplicate_of === 1, 'p5 → p1 (first occurrence wins, not p3)');
    assert(annotated[5].duplicate_of === 2, 'p6 → p2');
    assert(countDuplicates(annotated) === 3, '3 duplicates total');
}

{
    // Pages without dupe_signature are treated as unique.
    const pages = [
        { page_number: 1, dupe_signature: 'aaa' },
        { page_number: 2 }, // no signature
        { page_number: 3, dupe_signature: 'aaa' },
    ];
    const annotated = assignDuplicates(pages);
    assert(annotated[1].duplicate_of === null, 'no-signature page treated as unique');
    assert(annotated[2].duplicate_of === 1, 'p3 still matches p1');
}

// ─── Test 2: rasterizer + dedup roundtrip on a synthetic PDF ────────────────
console.log('\n[2] Rasterizer + dedup roundtrip (synthetic 4-page PDF, page 4 = page 2)');

{
    const available = await isRasterizerAvailable();
    assert(available, 'pdftoppm available on PATH');

    // Build a 4-page PDF where pages 2 and 4 have IDENTICAL content. Their
    // rasterised JPEGs should be byte-identical (pdftoppm + libjpeg are
    // deterministic), and the deduplicator should flag page 4 as a duplicate
    // of page 2.
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    function drawSyntheticPage(pageDoc, label) {
        pageDoc.drawText(label, {
            x: 50,
            y: 720,
            size: 36,
            font,
            color: rgb(0, 0, 0),
        });
        pageDoc.drawText('lorem ipsum dolor sit amet '.repeat(20), {
            x: 50,
            y: 660,
            size: 12,
            font,
            color: rgb(0.1, 0.1, 0.1),
            maxWidth: 500,
        });
    }

    drawSyntheticPage(pdfDoc.addPage([612, 792]), 'Page 1 — unique');
    drawSyntheticPage(pdfDoc.addPage([612, 792]), 'Page 2 — will repeat');
    drawSyntheticPage(pdfDoc.addPage([612, 792]), 'Page 3 — unique');
    drawSyntheticPage(pdfDoc.addPage([612, 792]), 'Page 2 — will repeat'); // identical to page 2

    const pdfBytes = await pdfDoc.save();
    const pdfBuffer = Buffer.from(pdfBytes);

    const pages = await rasterizePdf(pdfBuffer, { widthPx: 768, jpegQuality: 75 });
    assert(pages.length === 4, 'rasterized 4 pages');
    assert(pages.every((p) => Buffer.isBuffer(p.jpeg)), 'each page is a Buffer');
    assert(pages.every((p) => p.jpeg[0] === 0xff && p.jpeg[1] === 0xd8), 'each buffer starts with JPEG magic bytes');

    // Compute signatures + assign duplicate_of, simulating what the
    // classifier does internally.
    const withSignatures = pages.map((p) => ({
        page_number: p.pageNumber,
        dupe_signature: computeJpegSignature(p.jpeg),
    }));
    const annotated = assignDuplicates(withSignatures);

    console.log(
        `  → signatures: ${withSignatures.map((p) => `p${p.page_number}=${p.dupe_signature.slice(0, 8)}…`).join(', ')}`
    );

    assert(withSignatures[1].dupe_signature === withSignatures[3].dupe_signature, 'pages 2 and 4 have identical signatures (deterministic raster)');
    assert(withSignatures[0].dupe_signature !== withSignatures[1].dupe_signature, 'pages 1 and 2 have different signatures');
    assert(annotated[3].duplicate_of === 2, 'page 4 flagged as duplicate of page 2');
    assert(annotated[0].duplicate_of === null && annotated[1].duplicate_of === null && annotated[2].duplicate_of === null, 'pages 1-3 are canonical');
    assert(countDuplicates(annotated) === 1, 'exactly 1 duplicate detected end-to-end');
}

// ─── Test 3: per-section extractor (v2 envelope assembly) ───────────────────
console.log('\n[3] Per-section extractor — v2 envelope assembly');

// Tiny fakes so we can drive the orchestrator without a DB or OpenAI.
function fakeProcessingService({ failingSlugs = new Set(), throwingSlugs = new Set() } = {}) {
    return {
        async processText(text, schemaInfo) {
            const slug = schemaInfo?.documentTypeSlug;
            if (throwingSlugs.has(slug)) throw new Error(`boom: ${slug}`);
            if (failingSlugs.has(slug)) {
                return { success: false, error: `forced failure: ${slug}` };
            }
            // Echo back something the test can recognise per slug.
            return {
                success: true,
                data: {
                    slug,
                    text_length: text.length,
                    sample: text.slice(0, 24),
                },
                metadata: { processing_time_seconds: 0.01 },
            };
        },
    };
}

function makeFakeGetActiveSchema(registered) {
    // `registered` is a Map<slug, version> — registered schemas only.
    return async (slug) => {
        if (!registered.has(slug)) return null;
        return {
            schemaName: `${slug}_extraction`,
            schema: { type: 'object', properties: {} },
            promptHints: {},
            version: registered.get(slug),
            documentTypeSlug: slug,
            displayName: slug,
            defaultExtractor: 'openai',
            schemaId: `fake-${slug}`,
        };
    };
}

function makePages(numPages) {
    return Array.from({ length: numPages }, (_, i) => ({
        page_number: i + 1,
        text: `# Page ${i + 1} content with some real-ish words to extract`,
    }));
}

{
    // Single section, single slug → envelope = { slug: [{...}] }
    const result = await extractAndProcessPerSection({
        detectedSections: {
            sections: [
                { document_type_slug: 'mgs_well_log', page_range: [2, 4], extraction_pages: [2, 3, 4] },
            ],
        },
        pages: makePages(5),
        processingService: fakeProcessingService(),
        getActiveSchema: makeFakeGetActiveSchema(new Map([['mgs_well_log', 1]])),
    });
    assert(deepEqualJSON(Object.keys(result.resultEnvelope), ['mgs_well_log']), 'envelope has one slug key');
    assert(Array.isArray(result.resultEnvelope.mgs_well_log), 'value is an array');
    assert(result.resultEnvelope.mgs_well_log.length === 1, 'one instance');
    assert(result.sectionResults[0].status === 'success', 'section status = success');
    assert(result.anySuccess === true, 'anySuccess = true');
    assert(result.schemasUsed.mgs_well_log.version === 1, 'schemasUsed records version 1');
}

{
    // Multi-instance same slug → envelope value is a 2-element array, in
    // document order (section_index ascending).
    const result = await extractAndProcessPerSection({
        detectedSections: {
            sections: [
                { document_type_slug: 'boring_log', page_range: [1, 2], extraction_pages: [1, 2] },
                { document_type_slug: 'boring_log', page_range: [5, 6], extraction_pages: [5, 6] },
            ],
        },
        pages: makePages(8),
        processingService: fakeProcessingService(),
        getActiveSchema: makeFakeGetActiveSchema(new Map([['boring_log', 2]])),
    });
    assert(result.resultEnvelope.boring_log.length === 2, 'multi-instance same-slug → array length 2');
    assert(result.resultEnvelope.boring_log[0].sample.startsWith('# Page 1'), 'first instance from pages 1-2');
    assert(result.resultEnvelope.boring_log[1].sample.startsWith('# Page 5'), 'second instance from pages 5-6 (document order preserved)');
    assert(result.sectionResults.length === 2, 'two section_results');
    assert(result.schemasUsed.boring_log.version === 2, 'schemasUsed records the active version');
}

{
    // Multi-slug → multiple keys in the envelope, each an array.
    const result = await extractAndProcessPerSection({
        detectedSections: {
            sections: [
                { document_type_slug: 'boring_log',  page_range: [1, 2], extraction_pages: [1, 2] },
                { document_type_slug: 'aquifer_test', page_range: [3, 4], extraction_pages: [3, 4] },
            ],
        },
        pages: makePages(5),
        processingService: fakeProcessingService(),
        getActiveSchema: makeFakeGetActiveSchema(new Map([['boring_log', 1], ['aquifer_test', 1]])),
    });
    assert(deepEqualJSON(Object.keys(result.resultEnvelope).sort(), ['aquifer_test', 'boring_log']), 'envelope has both slug keys');
    assert(result.resultEnvelope.boring_log.length === 1 && result.resultEnvelope.aquifer_test.length === 1, 'each slug has its own array');
}

{
    // Section with NO registered schema → status = skipped_no_schema, NOT in envelope.
    // Other sections' success should be unaffected.
    const result = await extractAndProcessPerSection({
        detectedSections: {
            sections: [
                { document_type_slug: 'boring_log',  page_range: [1, 2], extraction_pages: [1, 2] },
                { document_type_slug: 'lab_qc',      page_range: [4, 4], extraction_pages: [4]    },
            ],
        },
        pages: makePages(5),
        processingService: fakeProcessingService(),
        getActiveSchema: makeFakeGetActiveSchema(new Map([['boring_log', 1]])), // lab_qc NOT registered
    });
    assert(result.resultEnvelope.boring_log?.length === 1, 'boring_log section still succeeded');
    assert(!('lab_qc' in result.resultEnvelope), 'unschemed slug missing from envelope');
    const labQc = result.sectionResults.find((r) => r.slug === 'lab_qc');
    assert(labQc.status === 'skipped_no_schema', 'unschemed section status = skipped_no_schema');
    assert(typeof labQc.error === 'string' && labQc.error.includes('lab_qc'), 'error message names the missing slug');
    assert(result.anySuccess === true, 'anySuccess true because boring_log succeeded');
}

{
    // Section with empty extraction_pages → skipped_no_pages.
    const result = await extractAndProcessPerSection({
        detectedSections: {
            sections: [
                { document_type_slug: 'boring_log', page_range: [1, 2], extraction_pages: [] },
            ],
        },
        pages: makePages(5),
        processingService: fakeProcessingService(),
        getActiveSchema: makeFakeGetActiveSchema(new Map([['boring_log', 1]])),
    });
    assert(result.sectionResults[0].status === 'skipped_no_pages', 'empty extraction_pages → skipped_no_pages');
    assert(Object.keys(result.resultEnvelope).length === 0, 'envelope is empty');
    assert(result.anySuccess === false, 'anySuccess false');
}

{
    // AI returns success=false → status = failed; other sections still complete.
    const result = await extractAndProcessPerSection({
        detectedSections: {
            sections: [
                { document_type_slug: 'good_slug', page_range: [1, 1], extraction_pages: [1] },
                { document_type_slug: 'bad_slug',  page_range: [2, 2], extraction_pages: [2] },
            ],
        },
        pages: makePages(3),
        processingService: fakeProcessingService({ failingSlugs: new Set(['bad_slug']) }),
        getActiveSchema: makeFakeGetActiveSchema(new Map([['good_slug', 1], ['bad_slug', 1]])),
    });
    assert(result.resultEnvelope.good_slug?.length === 1, 'good_slug succeeded');
    assert(!('bad_slug' in result.resultEnvelope), 'bad_slug NOT in envelope');
    assert(result.sectionResults.find((r) => r.slug === 'bad_slug').status === 'failed', 'bad_slug status = failed');
    assert(result.anySuccess === true, 'anySuccess true because good_slug succeeded');
}

{
    // processText THROWS (network error etc.) → caught and recorded as failed.
    const result = await extractAndProcessPerSection({
        detectedSections: {
            sections: [
                { document_type_slug: 'throwy', page_range: [1, 1], extraction_pages: [1] },
            ],
        },
        pages: makePages(2),
        processingService: fakeProcessingService({ throwingSlugs: new Set(['throwy']) }),
        getActiveSchema: makeFakeGetActiveSchema(new Map([['throwy', 1]])),
    });
    assert(result.sectionResults[0].status === 'failed', 'thrown error → status = failed');
    assert(result.sectionResults[0].error === 'boom: throwy', 'thrown error.message captured');
    assert(result.anySuccess === false, 'anySuccess false');
}

{
    // All sections failed/skipped → anySuccess = false. Caller decides what
    // to do (the worker throws so the file is marked failed).
    const result = await extractAndProcessPerSection({
        detectedSections: {
            sections: [
                { document_type_slug: 'unknown_a', page_range: [1, 1], extraction_pages: [1] },
                { document_type_slug: 'unknown_b', page_range: [2, 2], extraction_pages: [2] },
            ],
        },
        pages: makePages(3),
        processingService: fakeProcessingService(),
        getActiveSchema: makeFakeGetActiveSchema(new Map()), // none registered
    });
    assert(result.anySuccess === false, 'anySuccess false when nothing succeeded');
    assert(Object.keys(result.resultEnvelope).length === 0, 'envelope is empty');
    assert(result.sectionResults.every((r) => r.status === 'skipped_no_schema'), 'every section skipped');
}

// ─── Test 4: resolveExtractionFlags (two-flag split + backward compat) ─────
console.log('\n[4] resolveExtractionFlags — flag combinations');

{
    // Both off (legacy).
    const r = resolveExtractionFlags({});
    assert(r.useClassifier === false, 'empty config → classifier off');
    assert(r.usePerSection === false, 'empty config → per-section off');
}

{
    // Null / undefined config.
    const r = resolveExtractionFlags(null);
    assert(r.useClassifier === false && r.usePerSection === false, 'null config → both off');
}

{
    // Backward compat: old job with only useVisualClassifier=true (no usePerSectionExtraction key).
    // Should be treated as both on.
    const r = resolveExtractionFlags({ useVisualClassifier: true });
    assert(r.useClassifier === true, 'backcompat: classifier on');
    assert(r.usePerSection === true, 'backcompat: per-section on (inferred from useVisualClassifier)');
}

{
    // Explicit VPC-only: useVisualClassifier=true, usePerSectionExtraction=false.
    const r = resolveExtractionFlags({ useVisualClassifier: true, usePerSectionExtraction: false });
    assert(r.useClassifier === true, 'VPC-only: classifier on');
    assert(r.usePerSection === false, 'VPC-only: per-section explicitly off');
}

{
    // Both on (explicit).
    const r = resolveExtractionFlags({ useVisualClassifier: true, usePerSectionExtraction: true });
    assert(r.useClassifier === true, 'both-on: classifier on');
    assert(r.usePerSection === true, 'both-on: per-section on');
}

{
    // Invalid combo: per-section on but VPC off. resolveExtractionFlags reports
    // what it's told; the UI prevents this, but the backend is permissive.
    const r = resolveExtractionFlags({ useVisualClassifier: false, usePerSectionExtraction: true });
    assert(r.useClassifier === false, 'invalid combo: classifier off');
    assert(r.usePerSection === true, 'invalid combo: per-section on (backend is permissive)');
}

// ─── Test 4.5: flattenExtractionPages VPC-only mode ───────────────────────
console.log('\n[4.5] flattenExtractionPages — VPC-only mode (includePendingReview)');

{
    // In VPC-only mode, pending_review sections SHOULD be included because
    // there's no per-section review gate to recover them.
    const sections = [
        { document_type_slug: 'a', extraction_pages: [1, 2], status: 'auto_approved' },
        { document_type_slug: 'b', extraction_pages: [5, 6], status: 'pending_review' },
        { document_type_slug: 'c', extraction_pages: [9],    status: 'approved' },
    ];
    // VPC-only mode: includePendingReview=true
    assert(
        deepEqualJSON(
            flattenExtractionPages(sections, { includePendingReview: true }),
            [1, 2, 5, 6, 9]
        ),
        'VPC-only mode includes pending_review sections in page set'
    );
    // Per-section mode: default (includePendingReview=false)
    assert(
        deepEqualJSON(
            flattenExtractionPages(sections),
            [1, 2, 9]
        ),
        'per-section mode excludes pending_review sections'
    );
}

console.log('');
if (failures === 0) {
    console.log('✅ all smoke tests passed');
    process.exit(0);
} else {
    console.error(`❌ ${failures} smoke test(s) failed`);
    process.exit(1);
}
