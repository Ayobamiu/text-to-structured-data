/**
 * orchestrator — the thin, safety-bearing seam between the tools.
 *
 *   buildCatalog → translate (NL → FilterSpec) → compile (FilterSpec → SQL)
 *   → execute (READ ONLY, scoped, timed-out) → format (+ echo the filter back)
 *
 * The model only ever produced a FilterSpec; the SQL is parameterized and the
 * org/job scope + read-only + row LIMIT are enforced here, never by the model.
 */

import pool from '../../database.js';
import buildCatalog from '../catalog/buildCatalog.ts';
import translate, { type TranslateDeps } from '../translator/translate.ts';
import compile from '../compiler/compile.ts';
import formatRows, { describeSpec, type FormattedResult } from '../formatter/format.ts';
import type { FilterSpec, SlugCatalog, QueryScope } from '../types.ts';

interface Queryable {
    query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export interface RunQueryArgs {
    question: string;
    slug: string;
    scope?: QueryScope;
    /** Injected for tests: a pre-built catalog, a translator stub, a db. */
    deps?: {
        catalog?: SlugCatalog;
        translate?: TranslateDeps;
        db?: Queryable;
    };
}

export interface RunQueryResult {
    spec: FilterSpec;
    sql: string;
    params: unknown[];
    /** The interpreted-filter echo shown to the user above the table. */
    interpreted: string;
    result: FormattedResult;
}

/** Run the compiled query inside a READ ONLY transaction with a statement timeout. */
async function executeReadOnly(db: Queryable, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    // pool exposes connect(); a stub may just expose query().
    const anyDb = db as unknown as { connect?: () => Promise<Queryable & { release: () => void }> };
    if (!anyDb.connect) {
        const res = await db.query(sql, params);
        return res.rows;
    }
    const client = await anyDb.connect();
    try {
        await client.query('BEGIN TRANSACTION READ ONLY');
        await client.query("SET LOCAL statement_timeout = '15s'");
        const res = await client.query(sql, params);
        await client.query('COMMIT');
        return res.rows;
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw e;
    } finally {
        client.release();
    }
}

export async function runQuery({ question, slug, scope = {}, deps = {} }: RunQueryArgs): Promise<RunQueryResult> {
    const catalog = deps.catalog ?? (await buildCatalog(slug, { db: deps.db as never }));
    const spec = await translate(question, catalog, deps.translate);
    const { sql, params } = compile(spec, catalog, scope);
    const db = (deps.db ?? (pool as unknown as Queryable));
    const rows = await executeReadOnly(db, sql, params);
    const result = formatRows(rows, spec);
    return { spec, sql, params, interpreted: describeSpec(spec), result };
}

export default runQuery;
