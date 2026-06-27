/**
 * query_generator — question + scope → { filterSpec, summary, detail }.
 *
 * The conversational agent calls this for any data question. It:
 *   1. translates NL → FilterSpec (temp 0; composes onto priorSpec for follow-ups)
 *   2. compiles a SUMMARY query (count, or the aggregate rollup) — always run, cheap,
 *      fed to the model ("8 records…" / "avg depth 5,200ft")
 *   3. compiles a DETAIL query (the row list) — run lazily for view/export only
 *
 * The model never sees SQL and never sees the full list — only the summary (+ a
 * few sample rows the agent pulls from detail). queryHash keys per-message
 * reuse/audit; the durable identity is the scope's hash.
 */

import { createHash } from 'node:crypto';
import buildCatalog from '../catalog/buildCatalog.ts';
import { compile, compileSummary } from '../compiler/compile.ts';
import translate from '../translator/translate.ts';
import { describeSpec } from '../formatter/format.ts';
import type { FilterSpec, SlugCatalog, CompiledQuery, QueryScope } from '../types.ts';

interface Queryable {
    query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export interface GeneratedQuery {
    filterSpec: FilterSpec;
    mode: 'list' | 'aggregate';
    /** Always run; small; fed to the model. */
    summary: CompiledQuery;
    /** Run lazily (view/export only); never dumped into chat context. */
    detail: CompiledQuery;
    /** Human echo of the interpreted filter. */
    interpreted: string;
    /** hash(scopeHash + canonical filterSpec) — per-message reuse / store / audit. */
    queryHash: string;
}

export interface GenerateArgs {
    question: string;
    slug: string;
    /** Compiler scope (by reference): fileIds / previewId / jobId / recordUids / sectionKey. */
    scope: QueryScope;
    /** Stable identity of the scope (from resolveScope). */
    scopeHash: string;
    /** Previous spec, for follow-up composition. */
    priorSpec?: FilterSpec;
    deps?: {
        catalog?: SlugCatalog;
        db?: Queryable;
        translate?: Parameters<typeof translate>[2];
    };
}

/** Canonicalize a FilterSpec (sorted keys, undefined-stripped) for a stable hash. */
function canonical(spec: FilterSpec): string {
    return JSON.stringify(spec, Object.keys(spec).sort());
}

export async function generateQuery(args: GenerateArgs): Promise<GeneratedQuery> {
    const { question, slug, scope, scopeHash, priorSpec, deps = {} } = args;
    const catalog = deps.catalog ?? (await buildCatalog(slug, { db: deps.db as never }));

    const filterSpec = await translate(question, catalog, { ...deps.translate, priorSpec });
    const mode: 'list' | 'aggregate' = filterSpec.aggregates && filterSpec.aggregates.length > 0 ? 'aggregate' : 'list';

    const summary = compileSummary(filterSpec, catalog, scope);
    const detail = compile(filterSpec, catalog, scope);

    const queryHash = createHash('sha256')
        .update(`${scopeHash}|${canonical(filterSpec)}`)
        .digest('hex')
        .slice(0, 16);

    return { filterSpec, mode, summary, detail, interpreted: describeSpec(filterSpec), queryHash };
}

export default generateQuery;
