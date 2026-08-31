/**
 * Backfill: populate extracted_records for a slug by running the project_records
 * service over existing job_files. Dry-run by default (writes NOTHING); pass
 * --apply to persist.
 *
 * effSlug() inside applyServicesToPreview filters candidates to the requested
 * slug (envelope slug OR shape-inferred), so we hand it every file with a result
 * object and let it select the matching records.
 *
 * Usage:
 *   npx tsx migrations/backfill_extracted_records.ts                 # dry-run mgs_well_log
 *   npx tsx migrations/backfill_extracted_records.ts mgs_well_log --apply
 */

import pool from '../src/database.js';
import { applyServicesToPreview } from '../src/services/postProcessing/applyToFiles.ts';
import projectRecords from '../src/services/postProcessing/services/projectRecords.ts';

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const slug = args.find((a) => !a.startsWith('--')) || 'mgs_well_log';

    const client = await pool.connect();
    let ids: string[];
    try {
        const res = await client.query(
            `SELECT id::text AS id FROM job_files WHERE result IS NOT NULL AND jsonb_typeof(result) = 'object'`,
        );
        ids = res.rows.map((r: { id: string }) => r.id);
    } finally {
        client.release();
    }

    console.log(`[backfill] slug=${slug} apply=${apply} candidate_files=${ids.length}`);
    const out = await applyServicesToPreview({
        itemIds: ids,
        slug,
        services: [projectRecords],
        apply,
    });
    console.log('[backfill] result:', JSON.stringify({
        apply: out.apply,
        filesScanned: out.filesScanned,
        recordsMatched: out.recordsMatched,
        projectionRows: out.sideEffects,
        summary: out.summary,
    }, null, 2));
}

main()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((e) => { console.error('💥 backfill failed:', e); process.exit(1); });
