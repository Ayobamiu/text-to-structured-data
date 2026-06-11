#!/usr/bin/env node
/**
 * One-time backfill: repair double-encoded `jobs.processing_config`.
 *
 * The same write-path bug (a JSON STRING value being treated as if it were an
 * object) produced two corruption shapes, both fixed here:
 *
 *   PASS 1 — STRING SCALAR.  Jobs created via the multipart upload path stored
 *     processing_config as a JSON string scalar inside the jsonb column (i.e.
 *     JSON.stringify applied twice). On read-back these decode to a JS string,
 *     so processing_config.extraction?.method / .processing?.method are
 *     undefined and callers silently fall back to defaults (paddleocr / gpt-4o).
 *     Detection: jsonb_typeof(processing_config) = 'string'.
 *
 *   PASS 2 — CHAR-INDEXED OBJECT.  The PUT /jobs/:id/config merge spread the
 *     existing config (`{ ...existingConfig, ...}`) while it was still a string
 *     scalar. Spreading a string yields numeric char-index keys ({"0":"{", ...})
 *     with the real extraction/processing keys overlaid on top. The merge is
 *     already guarded (it now parses-if-string first), so this only repairs rows
 *     written before that guard existed.
 *     Detection: jsonb_typeof = 'object' AND the object has numeric-string keys.
 *
 * The write paths are fixed at the source in src/database.js (createJob) and
 * src/server.js (upload endpoint + the already-guarded config merge); this
 * script repairs rows already written.
 *
 * SAFETY: a row is only rewritten when we can derive a plain OBJECT that
 *   contains an `extraction` or `processing` key. Anything else (non-object,
 *   unparseable, or missing both keys after repair) is reported and left
 *   untouched.
 *
 * DRY RUN by default. Pass --apply to write.
 *
 *   node migrations/backfill_double_encoded_processing_config.js           # dry run
 *   node migrations/backfill_double_encoded_processing_config.js --apply   # write
 */

import pool from '../src/database.js';

const APPLY = process.argv.includes('--apply');

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const hasConfigKeys = (o) => 'extraction' in o || 'processing' in o;

// PASS 1: a jsonb string scalar comes back from pg as a JS string.
function planStringScalar(raw) {
    if (typeof raw !== 'string') {
        return { safe: false, reason: `not a string scalar (got ${typeof raw})` };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return { safe: false, reason: `unparseable JSON string: ${e.message}` };
    }
    if (!isPlainObject(parsed)) {
        return { safe: false, reason: `parsed to ${Array.isArray(parsed) ? 'array' : typeof parsed}, not an object` };
    }
    if (!hasConfigKeys(parsed)) {
        return { safe: false, reason: 'object lacks both extraction and processing keys' };
    }
    return { safe: true, parsed };
}

// PASS 2: an object polluted with numeric char-index keys from a string spread.
// The real (overlaid) extraction/processing keys are the intended values, so we
// simply drop the numeric keys. If none remain, fall back to reconstructing the
// JSON string from the char-indexed keys in order.
function planCharIndexedObject(raw) {
    if (!isPlainObject(raw)) return { skip: true };
    const keys = Object.keys(raw);
    const numericKeys = keys.filter((k) => /^\d+$/.test(k));
    if (numericKeys.length === 0) return { skip: true }; // a clean object — nothing to do

    const realKeys = keys.filter((k) => !/^\d+$/.test(k));
    const stripped = {};
    for (const k of realKeys) stripped[k] = raw[k];

    if (hasConfigKeys(stripped)) {
        return { safe: true, parsed: stripped };
    }

    // No real config keys survived — try to rebuild the original JSON string
    // from the char-indexed keys (sorted numerically) and parse it.
    const rebuilt = numericKeys
        .map(Number)
        .sort((a, b) => a - b)
        .map((i) => raw[String(i)])
        .join('');
    try {
        const parsed = JSON.parse(rebuilt);
        if (isPlainObject(parsed) && hasConfigKeys(parsed)) {
            return { safe: true, parsed };
        }
    } catch { /* fall through */ }
    return { safe: false, reason: 'numeric-key object: no real keys and could not reconstruct config' };
}

function summarize(o) {
    const ex = o.extraction?.method ?? '—';
    const pr = o.processing?.method ?? '—';
    const md = o.processing?.model ?? '—';
    return `extraction=${String(ex).padEnd(10)} processing=${String(pr).padEnd(8)} model=${md}`;
}

async function writeObject(parsed, id) {
    // Single stringify → proper jsonb object (not a string scalar).
    const res = await pool.query(
        `UPDATE jobs SET processing_config = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(parsed), id]);
    return res.rowCount;
}

async function main() {
    console.log(`${APPLY ? '🔧 APPLY' : '🔍 DRY RUN'} — repair double-encoded processing_config\n`);
    const totals = { willWrite: 0, wrote: 0, unsafe: 0 };

    // ── PASS 1: string scalars ──────────────────────────────────────────────
    console.log('Pass 1 — string scalars (jsonb_typeof = string):');
    const strs = await pool.query(`
        SELECT id, processing_config AS raw FROM jobs
        WHERE jsonb_typeof(processing_config) = 'string' ORDER BY created_at ASC`);
    for (const row of strs.rows) {
        const plan = planStringScalar(row.raw);
        if (!plan.safe) { totals.unsafe++; console.log(`  ⚠️  ${row.id}  — ${plan.reason}`); continue; }
        console.log(`  ✅ ${row.id}  ${summarize(plan.parsed)}`);
        totals.willWrite++;
        if (APPLY) totals.wrote += await writeObject(plan.parsed, row.id);
    }
    if (strs.rows.length === 0) console.log('  (none)');

    // ── PASS 2: char-indexed objects ────────────────────────────────────────
    console.log('\nPass 2 — objects polluted with numeric char-index keys:');
    const objs = await pool.query(`
        SELECT id, processing_config AS raw FROM jobs
        WHERE jsonb_typeof(processing_config) = 'object' ORDER BY created_at ASC`);
    let pass2candidates = 0;
    for (const row of objs.rows) {
        const plan = planCharIndexedObject(row.raw);
        if (plan.skip) continue;
        pass2candidates++;
        if (!plan.safe) { totals.unsafe++; console.log(`  ⚠️  ${row.id}  — ${plan.reason}`); continue; }
        console.log(`  ✅ ${row.id}  ${summarize(plan.parsed)}`);
        totals.willWrite++;
        if (APPLY) totals.wrote += await writeObject(plan.parsed, row.id);
    }
    if (pass2candidates === 0) console.log('  (none)');

    console.log(`\nSafe to fix: ${totals.willWrite} | unsafe (left alone): ${totals.unsafe}`);
    if (APPLY) console.log(`Wrote: ${totals.wrote}`);
    else console.log(`(dry run — re-run with --apply to write)`);
    await pool.end();
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
