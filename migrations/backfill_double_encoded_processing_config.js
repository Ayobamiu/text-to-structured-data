#!/usr/bin/env node
/**
 * One-time backfill: fix double-encoded `jobs.processing_config`.
 *
 * Some jobs (created via the multipart upload path) stored processing_config as
 * a JSON STRING scalar inside the jsonb column — i.e. JSON.stringify was applied
 * twice. On read-back these decode to a JS string, so
 * `processing_config.extraction?.method` / `.processing?.method` are undefined
 * and callers silently fall back to defaults (paddleocr / gpt-4o) instead of the
 * job's intended config. The write-path bug is fixed at the source in
 * src/database.js (createJob) and src/server.js (upload endpoint); this script
 * repairs the rows already written.
 *
 * DETECTION:  jsonb_typeof(processing_config) = 'string'.
 *
 * SAFETY: a row is only rewritten when the string parses to a plain OBJECT that
 *   contains an `extraction` or `processing` key. Anything else (non-object,
 *   unparseable, or missing both keys) is reported and left untouched.
 *
 * DRY RUN by default. Pass --apply to write.
 *
 *   node migrations/backfill_double_encoded_processing_config.js           # dry run
 *   node migrations/backfill_double_encoded_processing_config.js --apply   # write
 */

import pool from '../src/database.js';

const APPLY = process.argv.includes('--apply');

function planRow(raw) {
    // For a jsonb string scalar, pg returns the inner JSON text as a JS string.
    if (typeof raw !== 'string') {
        return { safe: false, reason: `not a string scalar (got ${typeof raw})` };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return { safe: false, reason: `unparseable JSON string: ${e.message}` };
    }
    const isObject = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    if (!isObject) {
        return { safe: false, reason: `parsed to ${Array.isArray(parsed) ? 'array' : typeof parsed}, not an object` };
    }
    if (!('extraction' in parsed) && !('processing' in parsed)) {
        return { safe: false, reason: 'object lacks both extraction and processing keys' };
    }
    return { safe: true, parsed };
}

async function main() {
    console.log(`${APPLY ? '🔧 APPLY' : '🔍 DRY RUN'} — backfill double-encoded processing_config\n`);

    const q = await pool.query(`
        SELECT id, name, created_at, processing_config AS raw
        FROM jobs
        WHERE jsonb_typeof(processing_config) = 'string'
        ORDER BY created_at ASC`);

    let candidates = 0, willWrite = 0, wrote = 0, unsafe = 0;
    for (const row of q.rows) {
        candidates++;
        const plan = planRow(row.raw);
        if (!plan.safe) {
            unsafe++;
            console.log(`⚠️  ${row.id}  — ${plan.reason}`);
            continue;
        }

        const ex = plan.parsed.extraction?.method ?? '—';
        const pr = plan.parsed.processing?.method ?? '—';
        const md = plan.parsed.processing?.model ?? '—';
        console.log(`✅ ${row.id}  extraction=${String(ex).padEnd(10)} processing=${String(pr).padEnd(8)} model=${md}`);

        willWrite++;
        if (APPLY) {
            // Single stringify → proper jsonb object (not a string scalar).
            const res = await pool.query(
                `UPDATE jobs
                   SET processing_config = $1::jsonb, updated_at = NOW()
                 WHERE id = $2
                   AND jsonb_typeof(processing_config) = 'string'`,
                [JSON.stringify(plan.parsed), row.id]);
            wrote += res.rowCount;
        }
    }

    console.log(`\nString-scalar rows: ${candidates} | safe to fix: ${willWrite} | unsafe (left alone): ${unsafe}`);
    if (APPLY) console.log(`Wrote: ${wrote}`);
    else console.log(`(dry run — re-run with --apply to write)`);
    await pool.end();
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
