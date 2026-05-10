#!/usr/bin/env node
/**
 * classify-pdf.js — CLI to run the visual page classifier on a local PDF
 *
 * Usage:
 *   node ai/scripts/classify-pdf.js \
 *     --file /path/to/document.pdf \
 *     [--types slug1,slug2]   (restrict to subset; default = all registered types) \
 *     [--model gpt-4o-mini] \
 *     [--detail low|high] \
 *     [--concurrency 8] \
 *     [--width 768] \
 *     [--quality 75] \
 *     [--first 1] [--last 10] \
 *     [--out /path/to/output.json] \
 *     [--no-persist]
 *
 * What it does:
 *   1. Reads the registered document_types from the schema registry.
 *   2. Rasterises every page of the input PDF.
 *   3. Calls the vision classifier on each page (parallel, concurrency-capped).
 *   4. Groups consecutive same-type pages into sections.
 *   5. Prints a compact summary to stdout.
 *   6. (Optionally) writes the full result JSON to --out.
 *   7. Does NOT touch the database — this is purely for eyeballing the
 *      classifier's behaviour on real PDFs before flipping the worker flag.
 *
 * Cost reference (for a 200-page PDF with default settings):
 *   - gpt-4o-mini, low detail: ~$0.02-0.05 total.
 *   - Latency: ~10-30s end-to-end at concurrency=8.
 *
 * Note: requires OPENAI_API_KEY in ai/.env and pdftoppm on $PATH.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = next;
            i++;
        }
    }
    return args;
}

function usage() {
    console.error(
        [
            'Usage: node ai/scripts/classify-pdf.js \\',
            '  --file /path/to/document.pdf \\',
            '  [--types slug1,slug2]   (default = all registered types) \\',
            '  [--model gpt-4o-mini] \\',
            '  [--detail low|high] \\',
            '  [--concurrency 8] \\',
            '  [--width 768] \\',
            '  [--quality 75] \\',
            '  [--first 1] [--last 10] \\',
            '  [--out /path/to/output.json] \\',
            '  [--no-persist]',
        ].join('\n')
    );
}

function fmtPct(n) {
    return (n * 100).toFixed(1) + '%';
}

async function main() {
    const args = parseArgs(process.argv);

    if (args.help) { usage(); process.exit(0); }
    if (!args.file) { usage(); process.exit(2); }

    const pdfPath = path.resolve(args.file);
    if (!fs.existsSync(pdfPath)) {
        console.error(`❌ File not found: ${pdfPath}`);
        process.exit(2);
    }
    const pdfBuffer = fs.readFileSync(pdfPath);
    console.log(`📂 ${pdfPath} (${pdfBuffer.length.toLocaleString()} bytes)`);

    // Late dynamic imports so --help doesn't open a DB connection.
    const { getDocumentTypesBySlugs } = await import('../src/services/schemaRegistry.js');
    const { classifyPdf } = await import('../src/services/visualPageClassifier.js');
    const { groupIntoSections, deriveFileStatus, getGrouperMetadata } = await import('../src/services/sectionGrouper.js');

    // Comma-separated slug list. Empty / unset → all registered types.
    const requestedSlugs = typeof args.types === 'string'
        ? args.types.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    let documentTypes;
    try {
        documentTypes = await getDocumentTypesBySlugs(requestedSlugs);
    } catch (err) {
        console.error(`❌ ${err.message}`);
        process.exit(2);
    }
    if (documentTypes.length === 0) {
        console.error('❌ No document_types in registry. Register at least one with ai/scripts/register-schema.js first.');
        process.exit(2);
    }
    if (requestedSlugs.length > 0) {
        console.log(`🎯 Restricted to ${documentTypes.length} type(s): ${documentTypes.map((d) => d.slug).join(', ')}`);
    } else {
        console.log(`📚 All registered document types: ${documentTypes.map((d) => d.slug).join(', ')}`);
    }

    const classifierOptions = {};
    if (args.model) classifierOptions.model = args.model;
    if (args.detail) classifierOptions.detail = args.detail;
    if (args.concurrency) classifierOptions.concurrency = Number(args.concurrency);
    if (args.width) classifierOptions.widthPx = Number(args.width);
    if (args.quality) classifierOptions.jpegQuality = Number(args.quality);
    if (args.first) classifierOptions.firstPage = Number(args.first);
    if (args.last) classifierOptions.lastPage = Number(args.last);

    const result = await classifyPdf({
        pdfBuffer,
        documentTypes,
        options: classifierOptions,
    });

    const thresholdsBySlug = new Map(
        documentTypes.map((dt) => [dt.slug, Number(dt.routing_confidence_threshold) || 0.75])
    );
    const sections = groupIntoSections(result.pages, { thresholdsBySlug });
    const fileStatus = deriveFileStatus(sections);

    console.log('');
    console.log('=== Per-page classifications ===');
    for (const p of result.pages) {
        const conf = typeof p.confidence === 'number' ? fmtPct(p.confidence) : 'n/a';
        const marker = p.error ? '✗' : (p.confidence >= 0.85 ? '✓' : '?');
        const dup = p.duplicate_of != null ? `  ↩dup-of-p${p.duplicate_of}` : '';
        console.log(
            `  ${marker} p.${String(p.page_number).padStart(3)} → ${p.document_type_slug.padEnd(20)} role=${(p.page_role || '-').padEnd(10)} purpose=${(p.page_purpose || '-').padEnd(11)} conf=${conf}${dup}${p.error ? `  err=${p.error}` : ''}`
        );
    }

    console.log('');
    console.log('=== Detected sections ===');
    if (sections.length === 0) {
        console.log('  (none — every page classified as "none")');
    } else {
        for (const s of sections) {
            console.log(
                `  ${s.document_type_slug.padEnd(20)} pages ${s.page_range[0]}-${s.page_range[1]} (${s.page_count} pg)  conf=${fmtPct(s.confidence)} (min ${fmtPct(s.min_page_confidence)})  status=${s.status}  threshold=${s.threshold_used}`
            );
            console.log(
                `    extract: [${s.extraction_pages.join(', ') || '—'}]   skip: ${s.skipped_pages.length === 0 ? '—' : s.skipped_pages.map((sp) => sp.reason === 'duplicate' ? `p${sp.page_number}=duplicate→p${sp.duplicate_of}` : `p${sp.page_number}=${sp.reason}`).join(', ')}`
            );
        }
    }

    const totalExtract = sections.reduce((n, s) => n + s.extraction_pages.length, 0);
    const totalSkip = sections.reduce((n, s) => n + s.skipped_pages.length, 0);
    console.log('');
    console.log(`Pages chosen for extraction: ${totalExtract}/${result.classifier.page_count}  (skipped ${totalSkip})`);

    console.log('');
    console.log(`=== File-level status: ${fileStatus} ===`);
    console.log(`Classifier: ${result.classifier.model} (${result.classifier.image.width}px ${result.classifier.image.detail})  duration=${result.classifier.duration_ms}ms  pages=${result.classifier.page_count}`);

    // Token / cost summary
    const totals = result.pages.reduce(
        (acc, p) => {
            if (p.tokens) {
                acc.prompt += p.tokens.prompt || 0;
                acc.completion += p.tokens.completion || 0;
            }
            return acc;
        },
        { prompt: 0, completion: 0 }
    );
    console.log(`Tokens: prompt=${totals.prompt.toLocaleString()}  completion=${totals.completion.toLocaleString()}`);

    if (args.out) {
        const outPath = path.resolve(args.out);
        fs.writeFileSync(outPath, JSON.stringify({
            classifier: result.classifier,
            grouper: getGrouperMetadata(),
            candidate_slugs: documentTypes.map((d) => d.slug),
            pages: result.pages,
            sections,
            status: fileStatus,
        }, null, 2));
        console.log(`📝 Wrote full result to ${outPath}`);
    }

    process.exit(0);
}

main().catch((err) => {
    console.error('💥 classify-pdf failed:', err.message);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
});
