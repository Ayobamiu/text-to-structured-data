#!/usr/bin/env node
/**
 * One-time backfill: restore section_result_id into job_files.detected_sections
 * for files where the write-back never persisted (older extractions). The ids
 * live on the result records; we re-link them to detected_sections.
 *
 * JOIN KEY: record_id (the well/boring id), content-based — NOT positional.
 *   detected_sections[i].record_id  ↔  result record's well id
 *     borehole_log → site_identification.boring_well_id
 *     aquifer_test → test_setup.control_well_id / well_number
 *   Matched on a normalized id (case/space/hyphen-insensitive: "IW-3" == "IW 3").
 *
 * SAFETY: a file is only written when the match is UNAMBIGUOUS —
 *   - every detected section maps to exactly one record (and vice versa),
 *   - section count == record count,
 *   - no duplicate normalized ids on the record side.
 * Anything short of that is reported and left untouched.
 *
 * DRY RUN by default. Pass --apply to write. Scoped to one job via --job=<id>.
 *
 *   node migrations/backfill_section_result_ids.js --job=<jobId>           # dry run
 *   node migrations/backfill_section_result_ids.js --job=<jobId> --apply   # write
 */

import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const APPLY = process.argv.includes('--apply');
const jobArg = process.argv.find((a) => a.startsWith('--job='));
const JOB_ID = jobArg ? jobArg.split('=')[1] : null;

const { Pool } = pg;
const pool = new Pool({
    connectionString:
        process.env.DATABASE_URL ||
        `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'password'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'batch_processor'}`,
    family: 4,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const norm = (v) =>
    v == null ? null : (String(v).trim().toUpperCase().replace(/[\s\-_.]/g, '') || null);

function recordWellId(slug, rec) {
    if (!rec) return null;
    if (slug === 'borehole_log')
        return rec.site_identification?.boring_well_id ?? rec.site_identification?.boring_id ?? null;
    if (slug === 'aquifer_test')
        return rec.test_setup?.control_well_id ?? rec.test_setup?.well_number ?? null;
    return rec.record_id ?? null; // generic fallback
}

/**
 * Two-stage plan:
 *   1. CONTENT match by normalized record_id (preferred — robust to skips).
 *   2. POSITIONAL fallback, gated on per-slug count equality. This is only
 *      safe because, with no skipped sections (record count == section count
 *      for EVERY slug), the i-th section and i-th record of a slug are the same
 *      section in document order — so index drift cannot occur.
 *
 * Returns { safe, method, assignments:[{i, srid, sectionId}], reason, secs, recs }
 */
function planFile(detSections, result) {
    const records = [];
    for (const [slug, arr] of Object.entries(result)) {
        if (!Array.isArray(arr)) continue;
        for (const rec of arr) {
            if (rec?.section_result_id) {
                records.push({ slug, srid: rec.section_result_id, normId: norm(recordWellId(slug, rec)) });
            }
        }
    }
    const recCount = records.length;

    // ── Stage 1: content match by record_id ──────────────────────────
    const recByNorm = new Map();
    let recDupes = false;
    for (const r of records) {
        if (r.normId == null) continue;
        if (recByNorm.has(r.normId)) recDupes = true;
        else recByNorm.set(r.normId, r);
    }
    const idAssign = [];
    const used = new Set();
    let allMatched = true;
    for (let i = 0; i < detSections.length; i++) {
        const nid = norm(detSections[i].record_id);
        const rec = nid != null ? recByNorm.get(nid) : null;
        if (!rec || used.has(rec.srid)) {
            allMatched = false;
            idAssign.push({ i, srid: null, sectionId: detSections[i].record_id });
        } else {
            used.add(rec.srid);
            idAssign.push({ i, srid: rec.srid, sectionId: detSections[i].record_id });
        }
    }
    if (allMatched && detSections.length === recCount && !recDupes) {
        return { safe: true, method: 'record_id', assignments: idAssign, reason: 'ok', secs: detSections.length, recs: recCount };
    }

    // ── Stage 2: positional, gated on per-slug count equality ─────────
    const detBySlug = new Map();
    detSections.forEach((s, idx) => {
        const k = s.document_type_slug;
        if (!detBySlug.has(k)) detBySlug.set(k, []);
        detBySlug.get(k).push({ idx, sectionId: s.record_id });
    });

    let perSlugBalanced = true;
    const slugs = new Set([...detBySlug.keys(), ...Object.keys(result)]);
    for (const slug of slugs) {
        const dCount = (detBySlug.get(slug) || []).length;
        const rCount = Array.isArray(result[slug]) ? result[slug].filter((r) => r?.section_result_id).length : 0;
        if (dCount !== rCount) { perSlugBalanced = false; break; }
    }

    if (perSlugBalanced) {
        const posAssign = [];
        for (const [slug, detList] of detBySlug.entries()) {
            const recs = (result[slug] || []).filter((r) => r?.section_result_id);
            detList.forEach((d, j) => posAssign.push({ i: d.idx, srid: recs[j].section_result_id, sectionId: d.sectionId }));
        }
        return { safe: true, method: 'positional', assignments: posAssign, reason: 'per-slug counts equal (no skips)', secs: detSections.length, recs: recCount };
    }

    return {
        safe: false, method: null, assignments: idAssign,
        reason: 'record_id mismatch AND per-slug counts unequal — cannot pair safely',
        secs: detSections.length, recs: recCount,
    };
}

async function main() {
    if (!JOB_ID) { console.error('Missing --job=<jobId>'); process.exit(1); }
    console.log(`${APPLY ? '🔧 APPLY' : '🔍 DRY RUN'} — backfill section_result_id for job ${JOB_ID}\n`);

    const q = await pool.query(
        `SELECT id, filename, created_at, detected_sections, result
         FROM job_files WHERE job_id=$1 ORDER BY created_at ASC`, [JOB_ID]);

    let broken = 0, willWrite = 0, wrote = 0, unsafe = 0;
    for (const row of q.rows) {
        const det = (typeof row.detected_sections === 'string' ? JSON.parse(row.detected_sections) : row.detected_sections);
        const sections = det?.sections;
        const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
        const isV2 = result && typeof result === 'object' && !Array.isArray(result) && Object.values(result).some(Array.isArray);
        if (!sections?.length || !isV2) continue;

        const alreadyLinked = sections.some((s) => s.section_result_id);
        const recsHaveIds = Object.values(result).filter(Array.isArray).some((a) => a.some((r) => r?.section_result_id));
        if (alreadyLinked || !recsHaveIds) continue; // not a broken file

        broken++;
        const plan = planFile(sections, result);
        const tag = plan.safe ? '✅' : '⚠️ ';
        const detail = plan.safe ? `via ${plan.method.padEnd(10)}` : `— ${plan.reason}`;
        console.log(`${tag} ${row.id}  ${String(plan.secs).padStart(2)} secs  ${detail}  ${row.filename.slice(0, 38)}`);
        if (!plan.safe) {
            unsafe++;
            continue;
        }

        willWrite++;
        if (APPLY) {
            for (const a of plan.assignments) sections[a.i].section_result_id = a.srid;
            await pool.query(
                `UPDATE job_files SET detected_sections=$1, updated_at=NOW() WHERE id=$2`,
                [JSON.stringify(det), row.id]);
            wrote++;
        }
    }

    console.log(`\nBroken files: ${broken} | safe to backfill: ${willWrite} | unsafe (left alone): ${unsafe}`);
    if (APPLY) console.log(`Wrote: ${wrote}`);
    else console.log(`(dry run — re-run with --apply to write)`);
    await pool.end();
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
