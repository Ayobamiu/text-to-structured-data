#!/usr/bin/env node
/**
 * Build a gold-set checklist: a stratified sample of sections, expanded to one
 * CSV row per field, for a human to mark right/wrong against the PDF.
 *
 * WHY THIS EXISTS
 * The database records only errors somebody caught (section_qa_findings). It
 * never records "a human checked this field and it was fine". Without those
 * negatives there is no denominator, so per-field ACCURACY cannot be computed
 * from production data at all — only the QA judge's precision. This produces
 * the missing negatives.
 *
 * SAMPLING
 *  - Stratified by FILE (default ≤2 sections per file). 2,933 borehole_log
 *    sections live in only 198 files; an unstratified draw would pull most of
 *    the sample from a handful of big documents and measure those documents
 *    rather than the pipeline.
 *  - Deterministic given --seed, so a re-run reproduces the same sample and a
 *    partly-filled checklist can be regenerated without losing alignment.
 *  - Defaults to sections QA never touched. This matters: a QA'd section has
 *    had its errors CORRECTED, so measuring there yields post-QA accuracy, not
 *    the raw extraction accuracy you want as a baseline. --include-qad opts in,
 *    and the qa_ran column lets the scorer split the two.
 *
 * READ-ONLY. Writes nothing to the database.
 *
 * Usage (from ai/, needs .env with DEV_DATABASE_URL or DATABASE_URL):
 *   node scripts/goldSetSample.mjs --n 60 > checklist.csv
 *   node scripts/goldSetSample.mjs --n 60 --fields all
 *   node scripts/goldSetSample.mjs --n 40 --slug borehole_log --seed 7
 *   node scripts/goldSetSample.mjs --estimate        # effort only, no CSV
 *   node scripts/goldSetSample.mjs --n 60 --write --batch b1   # seed the UI
 *
 * --write is the only mode that touches the database: it seeds gold_labels
 * with verdict NULL for the review panel to fill in. Re-running the same
 * --batch --seed is safe (ON CONFLICT DO NOTHING) and adds nothing, so a
 * partly-reviewed batch cannot be clobbered by a re-seed.
 */
import dotenv from 'dotenv'; dotenv.config({ quiet: true });
import pg from 'pg';
import { CORE_FIELDS, CORE_TABLES, EXCLUDED_PREFIXES } from './lib/goldSetFields.mjs';
import { getAtFieldPath, serializeExtractedValue } from '../src/utils/goldSetPaths.mjs';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const argOf = (n, d = null) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const SLUG = argOf('slug', 'borehole_log');
const N = Number(argOf('n', '60'));
const PER_FILE = Number(argOf('per-file', '2'));
const SEED = Number(argOf('seed', '42'));
const MODE = argOf('fields', 'core');
const INCLUDE_QAD = has('include-qad');
const ESTIMATE = has('estimate');
const WRITE = has('write');
const BATCH = argOf('batch', null);

const pool = new pg.Pool({
    connectionString: process.env.DEV_DATABASE_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

/** Deterministic PRNG (mulberry32) so --seed reproduces a sample exactly. */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const csv = (v) =>
    `"${String(v ?? '').replace(/\s*\n\s*/g, ' ⏎ ').replace(/"/g, '""')}"`;

/** Every checkable leaf path in a record, honouring the exclusion list. */
function allLeafPaths(record, prefix = '') {
    const out = [];
    for (const [k, v] of Object.entries(record)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (EXCLUDED_PREFIXES.some((p) => path === p || path.startsWith(p))) continue;
        if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...allLeafPaths(v, path));
        else if (!Array.isArray(v)) out.push(path);
    }
    return out;
}

/**
 * Seed the drawn sample into gold_labels for the review panel to fill in.
 *
 * ON CONFLICT DO NOTHING on (batch, section_result_id, field_path): re-running
 * a seed must never overwrite a verdict somebody already recorded. Adding
 * fields to a live batch is therefore safe and additive.
 */
async function writeBatch(client, rows, sample, perFileCount) {
    await client.query('BEGIN');
    try {
        await client.query(
            `INSERT INTO gold_batches
                 (batch, slug, n_sections, per_file, seed, field_mode, include_qad, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (batch) DO NOTHING`,
            [
                BATCH, SLUG, sample.length, PER_FILE, SEED, MODE, INCLUDE_QAD,
                `${sample.length} sections from ${perFileCount} files, ≤${PER_FILE}/file, ` +
                `${INCLUDE_QAD ? 'incl.' : 'excl.'} QA'd sections`,
            ]
        );

        // One multi-row INSERT per section keeps the statement small enough to
        // read in a log while still being a handful of round trips, not 2,000.
        let inserted = 0;
        for (let i = 0; i < rows.length; i += 500) {
            const chunk = rows.slice(i, i + 500);
            const values = [];
            const params = [];
            chunk.forEach((r, j) => {
                const b = j * 8;
                values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
                params.push(BATCH, r.file_id, r.job_id, r.sid, SLUG, r.field_path, r.extracted_value, r.qa_ran);
            });
            const res = await client.query(
                `INSERT INTO gold_labels
                     (batch, file_id, job_id, section_result_id, slug, field_path, extracted_value, qa_ran)
                 VALUES ${values.join(',')}
                 ON CONFLICT (batch, section_result_id, field_path) DO NOTHING`,
                params
            );
            inserted += res.rowCount;
        }

        await client.query('COMMIT');
        return inserted;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
}

async function main() {
    if (WRITE && !BATCH) {
        console.error('--write needs --batch <name> (e.g. --batch b1).');
        process.exitCode = 1;
        return;
    }
    // Pool of candidate sections. LEFT JOIN marks which ones QA has touched;
    // qa_ran is carried into the CSV either way so the scorer can split on it.
    const { rows: pool_ } = await pool.query(
        `SELECT jf.id AS file_id, jf.job_id, jf.filename,
                r.value AS record,
                (r.value->>'section_result_id') AS sid,
                (qr.section_result_id IS NOT NULL) AS qa_ran
           FROM job_files jf,
                jsonb_each(jf.result) s,
                jsonb_array_elements(s.value) r
           LEFT JOIN section_qa_runs qr
                  ON qr.section_result_id::text = (r.value->>'section_result_id')
          WHERE s.key = $1
            AND jsonb_typeof(jf.result) = 'object'
            AND jsonb_typeof(s.value) = 'array'
            AND r.value ? 'section_result_id'`,
        [SLUG]
    );

    const eligible = INCLUDE_QAD ? pool_ : pool_.filter((r) => !r.qa_ran);
    if (eligible.length === 0) {
        console.error(`No eligible sections for slug "${SLUG}".`);
        process.exitCode = 1;
        return;
    }

    // Stratify: shuffle deterministically, then take at most PER_FILE per file.
    const rand = rng(SEED);
    const shuffled = [...eligible].sort(() => rand() - 0.5);
    const perFile = new Map();
    const sample = [];
    for (const row of shuffled) {
        const used = perFile.get(row.file_id) ?? 0;
        if (used >= PER_FILE) continue;
        perFile.set(row.file_id, used + 1);
        sample.push(row);
        if (sample.length >= N) break;
    }

    const scalarFields = CORE_FIELDS[SLUG] ?? [];
    const tables = CORE_TABLES[SLUG] ?? [];

    // Expand to one row per field. Rows are built once and then either
    // printed as CSV or seeded into gold_labels — the sample a reviewer sees
    // in the UI is byte-for-byte the sample the CSV would have contained.
    const rows = [];
    let scalarChecks = 0, rowChecks = 0;
    for (const s of sample) {
        const rec = s.record;
        const paths = MODE === 'all' ? allLeafPaths(rec) : scalarFields;
        const wellId = getAtFieldPath(rec, 'site_identification.boring_well_id') ?? '';

        const push = (field_path, value) => rows.push({
            filename: s.filename,
            job_id: s.job_id,
            file_id: s.file_id,
            sid: s.sid,
            well_id: wellId,
            qa_ran: !!s.qa_ran,
            field_path,
            // NULL means blank — and blank is frequently the CORRECT answer.
            extracted_value: serializeExtractedValue(value),
        });

        for (const p of paths) {
            push(p, getAtFieldPath(rec, p));
            scalarChecks++;
        }

        for (const t of tables) {
            const arr = rec[t.path];
            if (!Array.isArray(arr)) continue;
            for (let i = 0; i < Math.min(arr.length, t.maxRows); i++) {
                for (const f of t.fields) {
                    push(`${t.path}[${i}].${f}`, arr[i]?.[f]);
                    rowChecks++;
                }
            }
        }
    }

    if (ESTIMATE) {
        const total = scalarChecks + rowChecks;
        console.log(`slug              : ${SLUG}`);
        console.log(`eligible sections : ${eligible.length}  (of ${pool_.length}; ${INCLUDE_QAD ? 'incl.' : 'excl.'} QA'd)`);
        console.log(`sampled           : ${sample.length} sections from ${perFile.size} files (≤${PER_FILE}/file)`);
        console.log(`field mode        : ${MODE}  (${MODE === 'all' ? 'every leaf' : `${scalarFields.length} core fields`})`);
        console.log(`checks            : ${scalarChecks} scalar + ${rowChecks} table = ${total}`);
        console.log(`est. review time  : ${(total * 5 / 3600).toFixed(1)}–${(total * 12 / 3600).toFixed(1)} h  (at 5–12 s/field)`);
        return;
    }

    if (WRITE) {
        const client = await pool.connect();
        try {
            const inserted = await writeBatch(client, rows, sample, perFile.size);
            const skipped = rows.length - inserted;
            console.log(
                `✅ batch "${BATCH}": ${inserted} rows seeded ` +
                `(${sample.length} sections from ${perFile.size} files, ${rows.length} checks)` +
                (skipped > 0 ? `\n   ${skipped} already existed and were left untouched.` : '')
            );
            console.log(`   Score it later with: node scripts/goldSetScore.mjs --batch ${BATCH}`);
        } finally {
            client.release();
        }
        return;
    }

    console.log([
        'filename', 'job_id', 'file_id', 'section_result_id', 'well_id', 'qa_ran',
        'field_path', 'extracted_value',
        'verdict', 'true_value', 'notes',
    ].join(','));
    for (const r of rows) {
        console.log([
            r.filename, r.job_id, r.file_id, r.sid, r.well_id, r.qa_ran ? 'yes' : 'no',
            r.field_path, r.extracted_value ?? '',
            '', '', '',
        ].map(csv).join(','));
    }

    console.error(
        `\n${sample.length} sections from ${perFile.size} files → ` +
        `${scalarChecks + rowChecks} checks. ` +
        `Fill 'verdict' with: correct | wrong | missing | unreadable\n` +
        `(put the right answer in true_value when verdict is 'wrong')\n`
    );
}

main()
    .catch((e) => { console.error('❌', e); process.exitCode = 1; })
    .finally(() => pool.end());
