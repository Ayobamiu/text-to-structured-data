/**
 * NL-query CLI — for testing the scope + query pipeline without a UI.
 *
 * Usage (all key=value, all optional except you need some scope):
 *   npx tsx src/nlquery/cli.ts slug=mgs_well_log file_id=<uuid>
 *   npx tsx src/nlquery/cli.ts job_id=<uuid> query="wells deeper than 1500 feet"
 *
 * Keys: slug=  file_id=  job_id=  preview=  query=
 *   - no query=  → scope-only: the records touched by the context
 *   - with query= → scope + the translated NL filter
 *
 * Prints: the resolved scope, the interpreted filter, and a pasteable SQL string
 * (params inlined as literals). Then runs it and shows the row count + a sample,
 * so we can confirm the result is accurate.
 */

import pool from '../database.js';
import resolveScope from './scope/resolveScope.ts';
import ensureProjected from './scope/ensureProjected.ts';
import buildCatalog from './catalog/buildCatalog.ts';
import compile, { renderLiteralSql } from './compiler/compile.ts';
import generateQuery from './query/generate.ts';
import type { QueryScope } from './types.ts';

const KEYS = ['slug', 'file_id', 'job_id', 'preview', 'record', 'section', 'query', 'project'] as const;

/** Parse `key=value` argv; the query value absorbs any trailing unkeyed tokens. */
function parseArgs(argv: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    let i = 0;
    while (i < argv.length) {
        const tok = argv[i];
        const m = tok.match(/^(\w+)=(.*)$/);
        if (m && (KEYS as readonly string[]).includes(m[1])) {
            if (m[1] === 'query') {
                // absorb the rest so unquoted multi-word queries work
                const rest = argv.slice(i + 1).filter((t) => !/^\w+=/.test(t));
                out.query = [m[2], ...rest].join(' ').trim();
                break;
            }
            out[m[1]] = m[2];
        }
        i++;
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const hasQuery = !!args.query;

    const resolved = await resolveScope({
        fileId: args.file_id,
        jobId: args.job_id,
        slug: args.slug,
        previewId: args.preview,
        recordId: args.record,
        sectionKey: args.section,
    });

    // On-demand projection: project the scoped files if they aren't yet (first-time cost).
    let projectionMs = 0;
    if (args.project === 'on' && resolved.memberFileIds.length) {
        const ep = await ensureProjected({ fileIds: resolved.memberFileIds, slug: resolved.slug });
        projectionMs = ep.ms;
        console.log(`⏱  Projection: ${ep.projectedNow} file(s) projected (${ep.recordsMatched} records → ${ep.rowsWritten} rows) in ${ep.ms} ms; ${ep.alreadyProjected} already present.`);
    }

    const scope: QueryScope = resolved.scope;

    console.log('\n──────────────────────────────────────────────');
    console.log(`Scope:       ${resolved.label}  (${resolved.recordCount} records)`);
    console.log(`Scope hash:  ${resolved.scopeHash}`);

    if (!hasQuery) {
        // Scope-only: just list the records in scope.
        const catalog = await buildCatalog(resolved.slug);
        const compiled = compile({ slug: resolved.slug, section: scope.sectionKey || '_root', where: [] }, catalog, scope);
        console.log('──────────────────────────────────────────────');
        console.log('\n-- Pasteable SQL --\n');
        console.log(renderLiteralSql(compiled));
        const res = await pool.query(compiled.sql, compiled.params);
        console.log(`\n▶ Returned ${res.rows.length} rows.`);
        return;
    }

    // Data question: query_generator → summary (run + show) + detail (pasteable).
    const gen = await generateQuery({ question: args.query, slug: resolved.slug, scope, scopeHash: resolved.scopeHash });
    console.log(`Question:    ${args.query}`);
    console.log(`Interpreted: ${gen.interpreted}`);
    console.log(`Mode:        ${gen.mode}    Query hash: ${gen.queryHash}`);
    console.log('──────────────────────────────────────────────');

    // SUMMARY — always run (this is what the model would narrate).
    const tS = Date.now();
    const sres = await pool.query(gen.summary.sql, gen.summary.params);
    console.log(`\n[SUMMARY]  (${Date.now() - tS} ms)`);
    console.log(renderLiteralSql(gen.summary));
    console.table(sres.rows.slice(0, 15));

    // DETAIL — pasteable; run a small sample to confirm.
    console.log(`\n[DETAIL — for view/export]`);
    console.log(renderLiteralSql(gen.detail));
    const dres = await pool.query(gen.detail.sql, gen.detail.params);
    console.log(`▶ Detail would return ${dres.rows.length} rows` +
        (projectionMs ? ` (+ ${projectionMs} ms first-time projection).` : '.'));
}

main()
    .then(() => process.exit(0))
    .catch((e) => { console.error('CLI error:', e?.message || e); process.exit(1); });
