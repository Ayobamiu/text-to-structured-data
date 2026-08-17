#!/usr/bin/env node
/**
 * Score a filled gold-set checklist → per-field accuracy with confidence
 * intervals. The other half of scripts/goldSetSample.mjs.
 *
 * VERDICT VOCABULARY (what the reviewer writes in the `verdict` column)
 *   correct     the extracted value matches the document — INCLUDING a
 *               correctly-empty field (page has no value, model wrote none)
 *   wrong       a value is present but does not match the document
 *   missing     the document HAS a value and the model left it blank
 *   unreadable  the source is illegible/ambiguous — the model cannot be
 *               judged. Excluded from the denominator and reported separately,
 *               because scoring it either way would misattribute a scan defect
 *               to the pipeline.
 *
 * Accuracy = correct / (correct + wrong + missing).
 *
 * Intervals are Wilson score, not normal-approximation: at n≈60 per field and
 * accuracies near 1.0 the normal approximation produces nonsense (bounds above
 * 100%). Wilson stays inside [0,1] and is honest about small n.
 *
 * Usage (from ai/):
 *   node scripts/goldSetScore.mjs --batch b1               # reviewed in the UI
 *   node scripts/goldSetScore.mjs --batch b1 --by-qa       # split QA'd vs not
 *   node scripts/goldSetScore.mjs checklist.csv            # legacy CSV fill
 *   node scripts/goldSetScore.mjs checklist.csv --min-n 30
 *
 * Scoring deliberately stays a CLI report rather than a page in the app. The
 * headline number is meaningless without its interval and its n, and a figure
 * rendered in the UI gets screenshotted and quoted as "our accuracy" — which
 * is the exact confusion (precision reported as accuracy) this whole exercise
 * exists to end.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const has = (n) => args.includes(`--${n}`);
const argOf = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const MIN_N = Number(argOf('min-n', '30'));
const BATCH = argOf('batch', null);

if (!file && !BATCH) {
    console.error(
        'usage: node scripts/goldSetScore.mjs <filled-checklist.csv> [--by-qa] [--min-n 30]\n' +
        '       node scripts/goldSetScore.mjs --batch b1 [--by-qa] [--min-n 30]'
    );
    process.exit(1);
}

/** Minimal RFC4180 parser — values contain commas and escaped quotes. */
function parseCsv(text) {
    const rows = [];
    let row = [], cur = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQ) {
            if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
            else if (c === '"') inQ = false;
            else cur += c;
        } else if (c === '"') inQ = true;
        else if (c === ',') { row.push(cur); cur = ''; }
        else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
        else if (c !== '\r') cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    const header = rows.shift();
    return rows
        .filter((r) => r.length === header.length && r.some((v) => v !== ''))
        .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

/** Wilson score interval for a binomial proportion. */
function wilson(correct, n, z = 1.96) {
    if (n === 0) return [0, 0];
    const p = correct / n;
    const d = 1 + z * z / n;
    const centre = p + z * z / (2 * n);
    const spread = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

function score(rows, label) {
    const byField = new Map();
    let unreadable = 0, unscored = 0;

    for (const r of rows) {
        const v = (r.verdict || '').trim().toLowerCase();
        // A row-level path (lithology_intervals[3].depth_to_ft) is aggregated
        // under its field, not its index — otherwise every row index becomes
        // its own "field" with n=1 and no interval is computable.
        const field = (r.field_path || '').replace(/\[\d+\]/g, '[]');
        if (!field) continue;
        if (v === '') { unscored++; continue; }
        if (v === 'unreadable') { unreadable++; continue; }
        if (!['correct', 'wrong', 'missing'].includes(v)) { unscored++; continue; }

        if (!byField.has(field)) byField.set(field, { correct: 0, wrong: 0, missing: 0 });
        byField.get(field)[v]++;
    }

    const results = [...byField.entries()].map(([field, c]) => {
        const n = c.correct + c.wrong + c.missing;
        const [lo, hi] = wilson(c.correct, n);
        return { field, ...c, n, acc: n ? c.correct / n : 0, lo, hi };
    }).sort((a, b) => a.acc - b.acc);

    const tot = results.reduce((s, r) => ({
        correct: s.correct + r.correct, wrong: s.wrong + r.wrong,
        missing: s.missing + r.missing, n: s.n + r.n,
    }), { correct: 0, wrong: 0, missing: 0, n: 0 });

    console.log(`\n${'═'.repeat(96)}`);
    console.log(label);
    console.log('═'.repeat(96));
    if (tot.n === 0) { console.log('  nothing scored yet.'); return; }

    console.log(
        'field'.padEnd(44) + 'n'.padStart(5) + 'acc'.padStart(9) +
        '95% CI'.padStart(18) + '  wrong  missing'
    );
    console.log('─'.repeat(96));
    for (const r of results) {
        const thin = r.n < MIN_N ? ' ⚠' : '';
        console.log(
            r.field.padEnd(44) +
            String(r.n).padStart(5) +
            pct(r.acc).padStart(9) +
            `${pct(r.lo)}–${pct(r.hi)}`.padStart(18) +
            String(r.wrong).padStart(7) + String(r.missing).padStart(9) + thin
        );
    }
    console.log('─'.repeat(96));
    const [lo, hi] = wilson(tot.correct, tot.n);
    console.log(
        'OVERALL (field-weighted)'.padEnd(44) +
        String(tot.n).padStart(5) + pct(tot.correct / tot.n).padStart(9) +
        `${pct(lo)}–${pct(hi)}`.padStart(18) +
        String(tot.wrong).padStart(7) + String(tot.missing).padStart(9)
    );
    if (unreadable) console.log(`\n  ${unreadable} excluded as unreadable (source illegible — not a pipeline error)`);
    if (unscored) console.log(`  ${unscored} rows not yet filled in`);
    const thin = results.filter((r) => r.n < MIN_N);
    if (thin.length) {
        console.log(`\n  ⚠ ${thin.length} field(s) below n=${MIN_N} — intervals too wide to act on:`);
        console.log(`    ${thin.map((r) => r.field).join(', ')}`);
    }
}

/**
 * Read a batch out of gold_labels, shaped exactly like a parsed CSV row so
 * score() cannot tell the two sources apart. The reviewing moved into the UI;
 * the maths did not change.
 */
async function loadBatch(batch) {
    const { default: pg } = await import('pg');
    const dotenv = await import('dotenv');
    dotenv.config({ quiet: true });

    const pool = new pg.Pool({
        connectionString: process.env.DEV_DATABASE_URL || process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
    });
    try {
        const { rows } = await pool.query(
            `SELECT field_path, verdict, true_value, notes,
                    CASE WHEN qa_ran THEN 'yes' ELSE 'no' END AS qa_ran
               FROM gold_labels
              WHERE batch = $1`,
            [batch]
        );
        if (rows.length === 0) {
            console.error(`Batch "${batch}" has no rows. Seed it first:\n` +
                `  node scripts/goldSetSample.mjs --n 60 --write --batch ${batch}`);
            process.exitCode = 1;
        }
        return rows.map((r) => ({ ...r, verdict: r.verdict ?? '' }));
    } finally {
        await pool.end();
    }
}

const rows = BATCH
    ? await loadBatch(BATCH)
    : parseCsv(fs.readFileSync(file, 'utf8'));

if (has('by-qa')) {
    score(rows.filter((r) => r.qa_ran === 'no'), "RAW EXTRACTION (sections QA never touched)");
    score(rows.filter((r) => r.qa_ran === 'yes'), "POST-QA (errors already corrected — expect higher)");
} else {
    score(rows, BATCH ? `GOLD SET — batch ${BATCH}` : `GOLD SET — ${file}`);
}
