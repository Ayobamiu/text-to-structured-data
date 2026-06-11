#!/usr/bin/env node
/**
 * One-time backfill: seed `section_qa_runs` from existing `section_qa_findings`.
 *
 * Before this feature, the only trace of a QA run was its findings. So for any
 * section that already has findings, we know QA ran — synthesize a run record
 * from those findings (overall_quality + qa_model carried from a finding,
 * findings_count = number of findings, last_qa_at = latest finding timestamp).
 *
 * Sections that were QA'd CLEAN before this change left no findings and so
 * cannot be recovered — they'll simply show "Run QA" until QA'd again. Going
 * forward, saveQAFindings records every run (incl. clean) so this gap closes.
 *
 * DRY RUN by default. Pass --apply to write.
 *   node migrations/backfill_section_qa_runs.js           # dry run
 *   node migrations/backfill_section_qa_runs.js --apply   # write
 */

import pool from '../src/database.js';

const APPLY = process.argv.includes('--apply');

async function main() {
    console.log(`${APPLY ? '🔧 APPLY' : '🔍 DRY RUN'} — backfill section_qa_runs from section_qa_findings\n`);

    // One synthesized run per (file_id, section_result_id) that has findings.
    const q = await pool.query(`
        SELECT
            file_id,
            section_result_id,
            COUNT(*)                                              AS findings_count,
            MAX(updated_at)                                       AS last_qa_at,
            (ARRAY_AGG(overall_quality ORDER BY updated_at DESC)
                FILTER (WHERE overall_quality IS NOT NULL))[1]    AS overall_quality,
            (ARRAY_AGG(qa_model ORDER BY updated_at DESC)
                FILTER (WHERE qa_model IS NOT NULL))[1]           AS qa_model
        FROM section_qa_findings
        GROUP BY file_id, section_result_id
    `);

    // Skip rows already present in section_qa_runs (idempotent re-runs).
    const existing = await pool.query(`SELECT file_id, section_result_id FROM section_qa_runs`);
    const have = new Set(existing.rows.map((r) => `${r.file_id}:${r.section_result_id}`));

    let willWrite = 0, wrote = 0, skipped = 0;
    for (const row of q.rows) {
        const key = `${row.file_id}:${row.section_result_id}`;
        if (have.has(key)) { skipped++; continue; }
        willWrite++;
        console.log(`✅ ${row.section_result_id}  findings=${row.findings_count}  quality=${row.overall_quality ?? '—'}`);
        if (APPLY) {
            await pool.query(
                `INSERT INTO section_qa_runs
                    (file_id, section_result_id, overall_quality, summary, findings_count, qa_model, last_qa_at, created_at, updated_at)
                 VALUES ($1, $2, $3, NULL, $4, $5, $6, $6, NOW())
                 ON CONFLICT (file_id, section_result_id) DO NOTHING`,
                [row.file_id, row.section_result_id, row.overall_quality, Number(row.findings_count), row.qa_model, row.last_qa_at]
            );
            wrote++;
        }
    }

    console.log(`\nSections with findings: ${q.rows.length} | to backfill: ${willWrite} | already had a run: ${skipped}`);
    if (APPLY) console.log(`Wrote: ${wrote}`);
    else console.log(`(dry run — re-run with --apply to write)`);
    await pool.end();
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
