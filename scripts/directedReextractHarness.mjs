#!/usr/bin/env node
/**
 * Directed group re-extraction harness — DRY RUN.
 *
 * Runs runDirectedReextraction (vision re-read of 1..3 groups + diff/patch
 * against the current record + QA-style verification) on a real section and
 * prints the staged findings and token cost per group.
 *
 * NOTHING IS SAVED. This never calls saveDirectedReextractionFindings and
 * never touches directed_reextraction_requests — it reads the DB, reads S3,
 * calls OpenAI, prints a report. Pass --save-json to dump the raw result.
 *
 * Usage (from ai/, needs .env: DB + S3 + OPENAI_API_KEY):
 *   node scripts/directedReextractHarness.mjs --section <sectionResultId> --groups samples_collected
 *   node scripts/directedReextractHarness.mjs --file <fileId> --groups lithology_intervals,samples_collected \
 *       --prompt "Most rows are missing; the table continues on page 2."
 *   node scripts/directedReextractHarness.mjs ... --pages 4,5 --mode patch --model gpt-4.1
 *
 * --mode auto|full|patch (default auto: arrays ≥ threshold rows → patch).
 * Each run costs real tokens (one vision call per group on up to 4 pages).
 */
import dotenv from 'dotenv'; dotenv.config();
import pg from 'pg';
import fs from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name, dflt = null) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] != null ? args[i + 1] : dflt;
};
const SECTION = argOf('section', null);
const FILE = argOf('file', null);
const GROUPS = (argOf('groups', null) ?? argOf('group', null))
    ?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const PROMPT = argOf('prompt', null);
const PAGES = argOf('pages', null)?.split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isInteger) ?? null;
const MODE = argOf('mode', 'auto');
const MODEL = argOf('model', null); // null → service default
const SAVE_JSON = argOf('save-json', null);

if (!GROUPS?.length || (!SECTION && !FILE)) {
    console.error('Usage: --groups <a,b> and one of --section <sectionResultId> | --file <fileId> [--prompt "..."] [--pages 4,5] [--mode auto|full|patch] [--model gpt-4.1] [--save-json out.json]');
    process.exit(1);
}

const pool = new pg.Pool({
    connectionString: process.env.DEV_DATABASE_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 2,
});

// ── locate the file + section ──────────────────────────────────────────────
const fileSql = FILE
    ? `SELECT id, filename, s3_key, result, detected_sections FROM job_files WHERE id = $1`
    : `SELECT id, filename, s3_key, result, detected_sections FROM job_files
       WHERE detected_sections::text LIKE $1 LIMIT 1`;
const fileRow = (await pool.query(fileSql, [FILE ?? `%${SECTION}%`])).rows[0];
if (!fileRow) {
    console.error(`No file found for ${FILE ? `id ${FILE}` : `section ${SECTION}`}`);
    process.exit(1);
}

const sections = fileRow.detected_sections?.sections ?? [];
const section = SECTION
    ? sections.find((s) => s.section_result_id === SECTION)
    : sections.find((s) => {
        const arr = fileRow.result?.[s.document_type_slug];
        return Array.isArray(arr) && arr.some((r) => r?.section_result_id === s.section_result_id
            && GROUPS.every((g) => Object.prototype.hasOwnProperty.call(r, g)));
    });
if (!section) {
    console.error(`No matching section${SECTION ? ` '${SECTION}'` : ` with group(s) ${GROUPS.join(', ')}`} in ${fileRow.filename}`);
    process.exit(1);
}

const slug = section.document_type_slug;
const record = (fileRow.result?.[slug] ?? []).find((r) => r?.section_result_id === section.section_result_id);
if (!record) {
    console.error(`Section ${section.section_result_id} has no extraction record in the envelope`);
    process.exit(1);
}

const pageNumbers = PAGES ?? (section.extraction_pages ?? []).slice(0, 4);
console.log(`📄 ${fileRow.filename}`);
console.log(`   section=${section.section_result_id} slug=${slug} groups=${GROUPS.join(', ')} mode=${MODE}`);
console.log(`   pages=[${pageNumbers.join(', ')}]${PROMPT ? `\n   prompt: ${PROMPT}` : ''}`);
for (const g of GROUPS) {
    const v = record[g];
    console.log(`   current '${g}': ${Array.isArray(v) ? `${v.length} row(s)` : JSON.stringify(v)?.slice(0, 100)}`);
}

// ── run (no persistence) ──────────────────────────────────────────────────
const { runDirectedReextraction } = await import('../src/services/directedReextractionService.ts');
const S3Service = (await import('../src/s3Service.js')).default;

const pdfBuffer = await new S3Service().downloadFile(fileRow.s3_key);
const started = Date.now();
const result = await runDirectedReextraction({
    sectionResultId: section.section_result_id,
    slug,
    groups: GROUPS,
    pageNumbers,
    operatorPrompt: PROMPT,
    extractionRecord: record,
    pdfBuffer,
    requestedMode: MODE,
    ...(MODEL ? { model: MODEL } : {}),
});
const secs = ((Date.now() - started) / 1000).toFixed(1);

// ── report ────────────────────────────────────────────────────────────────
console.log(`\n🧾 model=${result.model} pages=[${result.renderedPages.join(', ')}] in ${secs}s total`);
for (const gr of result.groupResults) {
    const t = gr.tokens ?? {};
    console.log(
        `\n── '${gr.group}' [${gr.modeUsed}] ${((gr.durationMs || 0) / 1000).toFixed(1)}s ` +
        `tokens: prompt=${t.prompt_tokens ?? '?'} completion=${t.completion_tokens ?? '?'}` +
        (gr.error ? `\n   ❌ ${gr.error}` : ''),
    );
    if (gr.error) continue;
    if (gr.modeUsed === 'full') {
        console.log(`   model re-read: ${Array.isArray(gr.newValue) ? `${gr.newValue.length} row(s)` : JSON.stringify(gr.newValue)?.slice(0, 100)}`);
    }
    if (gr.suppressedDeletes) {
        console.log(`   ⚠️ ${gr.suppressedDeletes} delete_row(s) suppressed (suspected under-emission)`);
    }
    console.log(`   ${gr.findings.length} staged finding(s):`);
    for (const f of gr.findings) {
        const bits = [
            `     [${f.severity}] ${f.issue_type} ${f.field}`,
            f.row_index != null ? `row=${f.row_index}` : null,
            f.row_value ? `row_value=${f.row_value.slice(0, 90)}` : null,
            f.corrected_value !== undefined && f.corrected_value !== null
                ? `corrected=${JSON.stringify(f.corrected_value).slice(0, 90)}`
                : null,
        ].filter(Boolean);
        console.log(bits.join(' '));
        console.log(`        ${f.explanation}`);
    }
    if (gr.findings.length === 0) {
        console.log('     (re-read matches the current extraction)');
    }
}

if (SAVE_JSON) {
    fs.writeFileSync(SAVE_JSON, JSON.stringify(result, null, 2));
    console.log(`\n💾 full result → ${SAVE_JSON}`);
}

console.log('\nDRY RUN — nothing was saved.');
await pool.end();
