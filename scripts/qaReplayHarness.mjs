#!/usr/bin/env node
/**
 * QA replay harness — DRY RUN quality guardrail for QA config changes.
 *
 * Replays section QA against sections whose findings a human already
 * ACCEPTED (ground-truth true positives) and reports:
 *   - recall: which accepted findings the candidate config still produces
 *   - extras: new findings not in the accepted set (precision signal, human judges)
 *   - tokens: real cost per section (prompt/completion/cached)
 *
 * NOTHING IS SAVED. This never calls saveQAFindings (which deletes a
 * section's open findings — see QA_OVERHAUL_HANDOFF gotchas). It reads the
 * DB, reads S3, calls OpenAI, prints a report.
 *
 * The acceptance bar for any cost-reduction candidate (group batching, model
 * tiering, more skips): 100% recall on accepted critical/high findings.
 *
 * Usage (from ai/, needs .env: DB + S3 + OPENAI_API_KEY):
 *   node scripts/qaReplayHarness.mjs                     # 3 most recent sections with accepted findings
 *   node scripts/qaReplayHarness.mjs --limit 8 --since 2026-07-02
 *   node scripts/qaReplayHarness.mjs --sections <id>,<id>
 *   node scripts/qaReplayHarness.mjs --model gpt-5.5-mini            # candidate vs accepted findings
 *   node scripts/qaReplayHarness.mjs --model gpt-5.5-mini --compare  # candidate vs CURRENT config, same record
 *
 * IMPORTANT — recall-vs-accepted has a staleness hole: once a finding's fix
 * has been Applied and Saved, the error no longer exists in the record, so no
 * config can "re-find" it (recall reads 0 through no fault of the config).
 * Use plain mode only on sections whose fixes are NOT yet saved. For
 * evaluating a cost-reduction candidate, prefer --compare: it runs the
 * current config AND the candidate on the SAME record and diffs them —
 * ~2x tokens per section, but a valid comparison regardless of record state.
 *
 * Each replayed section costs real tokens (gpt-5.5 vision ≈ one production
 * QA run; --compare ≈ two) — start small.
 */
import dotenv from 'dotenv'; dotenv.config();
import pg from 'pg';

const args = process.argv.slice(2);
const argOf = (name, dflt = null) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] != null ? args[i + 1] : dflt;
};
const LIMIT = parseInt(argOf('limit', '3'), 10);
const SINCE = argOf('since', '2026-07-02');
const SECTIONS = argOf('sections', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const MODEL = argOf('model', null); // null → service default (QA_MODEL env / gpt-5.5)
const COMPARE = args.includes('--compare'); // baseline (current config) vs MODEL on the same record
if (COMPARE && !MODEL) {
    console.error('--compare needs a candidate --model to compare against the current config');
    process.exit(1);
}

const pool = new pg.Pool({
    connectionString: process.env.DEV_DATABASE_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 2,
});

// ── pick target sections (must have human-accepted findings) ──────────────
const targetSql = SECTIONS
    ? `SELECT file_id, section_result_id, count(*)::int AS accepted, max(created_at) AS latest
       FROM section_qa_findings WHERE status = 'accepted' AND section_result_id = ANY($1)
       GROUP BY 1, 2`
    : `SELECT file_id, section_result_id, count(*)::int AS accepted, max(created_at) AS latest
       FROM section_qa_findings WHERE status = 'accepted' AND created_at >= $1
       GROUP BY 1, 2 ORDER BY latest DESC LIMIT ${LIMIT}`;
const targets = (await pool.query(targetSql, [SECTIONS ?? SINCE])).rows;

if (!targets.length) {
    console.log(`No sections with accepted findings ${SECTIONS ? 'for those ids' : `since ${SINCE}`}.`);
    process.exit(0);
}

console.log(`\n🧪 QA REPLAY (DRY RUN — nothing saved) on ${targets.length} section(s)` +
    `${MODEL ? `, candidate model: ${MODEL}` : ' with current config'}\n`);

const { runSectionQA } = await import('../src/services/sectionQAService.js');
const { getFileResult } = await import('../src/database.js');
const S3Service = (await import('../src/s3Service.js')).default;
const s3 = new S3Service();

// Match keys: scalars by type+path; row ops also by the frozen row content
// (indices are meaningless across runs — content is the identity).
// Shape note: live findings from runSectionQA carry `field` (model output);
// DB rows carry `field_path`. row_value is a JSON string live, an object
// from jsonb — normalize both sides through parse→stringify.
const ROW_OPS = new Set(['add_row', 'update_row', 'delete_row']);
const normJson = (v) => {
    if (v == null) return '';
    try {
        return JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v);
    } catch {
        return String(v);
    }
};
const keyOf = (f) => {
    const path = f.field_path ?? f.field;
    const base = `${f.issue_type}|${path}`;
    if (!ROW_OPS.has(f.issue_type)) return base;
    return `${base}|${normJson(f.issue_type === 'add_row' ? f.row_value : f.actual)}`;
};

const totals = { accepted: 0, matched: 0, extras: 0, tokens: 0, cached: 0, candTokens: 0, candCached: 0, bySeverity: {} };
const pdfCache = new Map();

for (const t of targets) {
    const accepted = (await pool.query(
        `SELECT field_path, issue_type, severity, actual, row_value
         FROM section_qa_findings WHERE section_result_id = $1 AND status = 'accepted'`,
        [t.section_result_id]
    )).rows;

    const file = await getFileResult(t.file_id);
    if (!file?.result || !file?.s3_key) {
        console.log(`⏭️  ${t.section_result_id.slice(0, 8)}… — file missing result/s3_key, skipped`);
        continue;
    }
    let record = null, slug = null;
    for (const [s, arr] of Object.entries(file.result)) {
        if (!Array.isArray(arr)) continue;
        const found = arr.find((r) => r?.section_result_id === t.section_result_id);
        if (found) { record = found; slug = s; break; }
    }
    const pageNumbers = (file.detected_sections?.sections || [])
        .find((s) => s.section_result_id === t.section_result_id)?.extraction_pages || [];
    if (!record || !pageNumbers.length) {
        console.log(`⏭️  ${t.section_result_id.slice(0, 8)}… — no record/pages in current envelope (result may have been re-extracted), skipped`);
        continue;
    }

    if (!pdfCache.has(file.s3_key)) pdfCache.set(file.s3_key, await s3.downloadFile(file.s3_key));

    const replay = async (modelOverride) => {
        const started = Date.now();
        const qa = await runSectionQA({
            fileId: t.file_id,
            sectionResultId: t.section_result_id,
            slug,
            pageNumbers,
            extractionRecord: record,
            pdfBuffer: pdfCache.get(file.s3_key),
            ...(modelOverride ? { model: modelOverride } : {}),
        });
        return { ...qa, seconds: (Date.now() - started) / 1000 };
    };

    const label = `📄 ${t.section_result_id.slice(0, 8)}… (${slug}, ${file.filename?.slice(0, 40) || t.file_id.slice(0, 8)})`;

    if (COMPARE) {
        // Same record, two configs: the reference set is what the CURRENT
        // config finds right now — immune to the applied-fixes staleness hole.
        const base = await replay(null);
        const cand = await replay(MODEL);
        const baseKeys = new Map(base.findings.map((f) => [keyOf(f), f]));
        const candKeys = new Set(cand.findings.map((f) => keyOf(f)));
        const missed = [...baseKeys.entries()].filter(([k]) => !candKeys.has(k));
        const extras = cand.findings.filter((f) => !baseKeys.has(keyOf(f)));

        totals.accepted += base.findings.length;
        totals.matched += base.findings.length - missed.length;
        totals.extras += extras.length;
        for (const [, f] of baseKeys) {
            totals.bySeverity[f.severity] = totals.bySeverity[f.severity] || { accepted: 0, matched: 0 };
            totals.bySeverity[f.severity].accepted++;
            if (candKeys.has(keyOf(f))) totals.bySeverity[f.severity].matched++;
        }
        totals.tokens += base.tokens?.total_tokens || 0;
        totals.cached += base.tokens?.cached_tokens || 0;
        totals.candTokens += cand.tokens?.total_tokens || 0;
        totals.candCached += cand.tokens?.cached_tokens || 0;

        console.log(
            `${label}\n` +
            `   baseline (${base.model}): ${base.findings.length} finding(s), ${base.tokens?.total_tokens || 0} tokens (${base.tokens?.cached_tokens || 0} cached), ${base.seconds.toFixed(1)}s\n` +
            `   candidate (${cand.model}): ${cand.findings.length} finding(s), ${cand.tokens?.total_tokens || 0} tokens (${cand.tokens?.cached_tokens || 0} cached), ${cand.seconds.toFixed(1)}s\n` +
            `   candidate reproduced ${base.findings.length - missed.length}/${base.findings.length} of baseline` +
            `${missed.length ? ` — MISSED: ${missed.map(([, m]) => `${m.issue_type}@${m.field_path ?? m.field}[${m.severity}]`).join(', ')}` : ''}` +
            `${extras.length ? `; ${extras.length} extra(s)` : ''}`
        );
        continue;
    }

    const qa = await replay(MODEL);
    const produced = new Map(qa.findings.map((f) => [keyOf(f), f]));
    const misses = [];
    let matched = 0;
    for (const a of accepted) {
        totals.accepted++;
        totals.bySeverity[a.severity] = totals.bySeverity[a.severity] || { accepted: 0, matched: 0 };
        totals.bySeverity[a.severity].accepted++;
        if (produced.has(keyOf(a))) {
            matched++;
            totals.matched++;
            totals.bySeverity[a.severity].matched++;
        } else {
            misses.push(a);
        }
    }
    const extras = qa.findings.length - matched;
    totals.extras += Math.max(0, extras);
    totals.tokens += qa.tokens?.total_tokens || 0;
    totals.cached += qa.tokens?.cached_tokens || 0;

    console.log(
        `${label}\n` +
        `   recall ${matched}/${accepted.length} accepted` +
        `${misses.length ? ` — MISSED: ${misses.map((m) => `${m.issue_type}@${m.field_path}[${m.severity}]`).join(', ')}` : ''}\n` +
        `   ${qa.findings.length} finding(s) produced (${Math.max(0, extras)} not in accepted set), ` +
        `${qa.tokens?.total_tokens || 0} tokens (${qa.tokens?.cached_tokens || 0} cached), ${qa.seconds.toFixed(1)}s`
    );
}

console.log(`\n══════ SUMMARY ══════`);
const refName = COMPARE ? 'baseline findings' : 'accepted findings';
console.log(`recall: ${totals.matched}/${totals.accepted} ${refName} reproduced`);
// Severity vocabulary in production data is error/warning/info.
const BAR_SEVERITIES = new Set(['error', 'critical', 'high']);
for (const [sev, v] of Object.entries(totals.bySeverity)) {
    const bar = BAR_SEVERITIES.has(sev) && v.matched < v.accepted ? '  ❌ BELOW BAR' : '';
    console.log(`  ${sev.padEnd(9)} ${v.matched}/${v.accepted}${bar}`);
}
console.log(`extras (human judges precision): ${totals.extras}`);
if (COMPARE) {
    console.log(`tokens: baseline ${totals.tokens} (${totals.cached} cached) vs candidate ${totals.candTokens} (${totals.candCached} cached)` +
        (totals.tokens > 0 ? ` — candidate is ${(100 * (1 - totals.candTokens / totals.tokens)).toFixed(0)}% cheaper on tokens` : ''));
} else {
    console.log(`tokens: ${totals.tokens} total, ${totals.cached} cached — compare configs on THIS number`);
}
console.log(`(dry run — no findings were saved)`);
await pool.end();
process.exit(0);
