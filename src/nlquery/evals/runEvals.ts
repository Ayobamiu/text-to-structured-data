/**
 * Eval loop harness — runs each sample query end-to-end (live translate → compile
 * → execute) and checks that every returned row satisfies the predicate. Prints a
 * per-query report and an N/5 tally. Iterate the translator/catalog until 5/5.
 *
 * Run: npx tsx src/nlquery/evals/runEvals.ts
 */

import pool from '../../database.js';
import runQuery from '../orchestrator/runQuery.ts';
import SAMPLE_QUERIES from './sampleQueries.ts';

async function main(): Promise<void> {
    let passed = 0;
    console.log(`\nRunning ${SAMPLE_QUERIES.length} eval queries (live)...\n`);

    for (const q of SAMPLE_QUERIES) {
        process.stdout.write(`#${q.id} "${q.question}"\n`);
        try {
            const { interpreted, sql, result } = await runQuery({ question: q.question, slug: q.slug });
            const enoughRows = result.rowCount >= q.minRows;
            const failReason = result.rowCount > 0 ? q.check(result.rows) : (q.minRows > 0 ? 'no rows returned' : null);
            const ok = enoughRows && !failReason;
            if (ok) passed++;
            console.log(`   ↳ ${interpreted}`);
            console.log(`   ↳ rows=${result.rowCount}  ${ok ? '✅ PASS' : `❌ FAIL${failReason ? ` (${failReason})` : ` (got ${result.rowCount}, need ≥${q.minRows})`}`}`);
            if (!ok) console.log(`   ↳ SQL: ${sql}`);
        } catch (e) {
            console.log(`   ↳ ❌ ERROR: ${(e as Error).message}`);
        }
        console.log('');
    }

    console.log(`\n=== ${passed}/${SAMPLE_QUERIES.length} passed ===\n`);
    await pool.end();
    process.exit(passed === SAMPLE_QUERIES.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
