/**
 * scope resolver — turn a user-supplied data context into concrete query scope.
 *
 * Scope is STRUCTURAL, not semantic: the user clicks a known thing (preview, job,
 * file, record, slug, section) and that maps deterministically to a predicate over
 * extracted_records. No AI here — AI is invoked only for the question.
 *
 * Scope is by REFERENCE, so it never drifts:
 *   - preview → compiled as a subquery over preview_data_table.items_ids (which ARE
 *     job_files ids), so editing the preview updates the scope automatically
 *   - file / job / record → real columns on extracted_records, already live
 *
 * Returns a stable scopeHash (the durable identity of the scope, for resuming a
 * conversation) and a deterministic natural-language label.
 */

import { createHash } from 'node:crypto';
import pool from '../../database.js';
import type { QueryScope } from '../types.ts';

interface Queryable {
    query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export interface ScopeInput {
    fileId?: string;
    jobId?: string;
    slug?: string;
    previewId?: string;
    recordId?: string;
    sectionKey?: string;
}

export interface ResolvedScope {
    slug: string;
    /** What the compiler applies (by reference). */
    scope: QueryScope;
    /** Concrete current member files — for on-demand projection (ensureProjected). */
    memberFileIds: string[];
    /** Deterministic natural-language description, e.g. "Borehole logs under the 'Sara V1' preview". */
    label: string;
    /** Stable identity of the scope (resume the same conversation on the same click). */
    scopeHash: string;
    recordCount: number;
}

const shortId = (id: string) => `${id.slice(0, 8)}…`;
const humanize = (s: string) => s.replace(/_/g, ' ');

/** sha256 of the canonical (sorted, undefined-stripped) reference descriptor. */
function hashScope(desc: Record<string, unknown>): string {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(desc).sort()) if (desc[k] !== undefined && desc[k] !== null) sorted[k] = desc[k];
    return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

export async function resolveScope(input: ScopeInput, deps: { db?: Queryable } = {}): Promise<ResolvedScope> {
    const db = deps.db ?? (pool as unknown as Queryable);

    if (!input.slug && !input.fileId && !input.jobId && !input.previewId && !input.recordId) {
        throw new Error('provide at least one of: slug, file_id, job_id, preview, record');
    }

    // --- Build the by-reference scope + resolve the concrete member files (for projection). ---
    const scope: QueryScope = {};
    let memberFileIds: string[] = [];
    let containerPhrase = '';

    if (input.previewId) {
        const pr = await db.query(`SELECT name, items_ids FROM preview_data_table WHERE id = $1`, [input.previewId]);
        const row = pr.rows[0] as { name?: string; items_ids?: string[] } | undefined;
        if (!row) throw new Error(`preview ${input.previewId} not found`);
        scope.previewId = input.previewId;                       // compiled as a subquery (by reference)
        memberFileIds = (row.items_ids ?? []).map(String);
        containerPhrase = `under the "${row.name ?? shortId(input.previewId)}" preview`;
    } else if (input.fileId) {
        scope.fileIds = [input.fileId];
        memberFileIds = [input.fileId];
        const f = await db.query(`SELECT filename FROM job_files WHERE id = $1`, [input.fileId]);
        containerPhrase = `in ${(f.rows[0] as { filename?: string })?.filename ?? shortId(input.fileId)}`;
    } else if (input.jobId) {
        scope.jobId = input.jobId;
        const jf = await db.query(`SELECT id::text AS id FROM job_files WHERE job_id = $1`, [input.jobId]);
        memberFileIds = jf.rows.map((r) => String(r.id));
        const jn = await db.query(`SELECT name FROM jobs WHERE id = $1`, [input.jobId]);
        containerPhrase = `in job "${(jn.rows[0] as { name?: string })?.name ?? shortId(input.jobId)}"`;
    }

    if (input.recordId) {
        scope.recordUids = [input.recordId];
        // The record's file (for projection) — known once projected; UI also passes file_id.
        const rf = await db.query(
            `SELECT DISTINCT file_id::text AS file_id FROM extracted_records WHERE record_uid = $1`,
            [input.recordId],
        );
        const fid = (rf.rows[0] as { file_id?: string })?.file_id;
        if (fid && !memberFileIds.includes(fid)) memberFileIds.push(fid);
        containerPhrase = `· record ${shortId(input.recordId)}`;
    }

    if (input.sectionKey) scope.sectionKey = input.sectionKey;

    // --- Slug: explicit, else infer from the projected rows of the member files. ---
    const ctx: string[] = [];
    const ctxParams: unknown[] = [];
    if (memberFileIds.length) { ctx.push(`file_id = ANY($${ctxParams.length + 1}::uuid[])`); ctxParams.push(memberFileIds); }
    if (input.jobId && !memberFileIds.length) { ctx.push(`job_id = $${ctxParams.length + 1}`); ctxParams.push(input.jobId); }
    if (scope.recordUids) { ctx.push(`record_uid = ANY($${ctxParams.length + 1})`); ctxParams.push(scope.recordUids); }
    const ctxSql = ctx.length ? ` AND ${ctx.join(' AND ')}` : '';

    let slug = input.slug;
    if (!slug) {
        const res = await db.query(`SELECT DISTINCT slug FROM extracted_records WHERE 1=1${ctxSql}`, ctxParams);
        const slugs = res.rows.map((r) => String(r.slug));
        if (slugs.length === 0) throw new Error('could not infer slug — no projected rows for this scope. Pass slug= (files may need projecting).');
        if (slugs.length > 1) throw new Error(`multiple slugs in scope (${slugs.join(', ')}). Pass slug= to disambiguate.`);
        slug = slugs[0];
    }

    // --- Count records (the section rows) in scope. ---
    const sectionForCount = input.sectionKey || '_root';
    const countRes = await db.query(
        `SELECT count(*)::int AS n FROM extracted_records WHERE slug = $${ctxParams.length + 1} AND section_key = $${ctxParams.length + 2}${ctxSql}`,
        [...ctxParams, slug, sectionForCount],
    );
    const recordCount = Number(countRes.rows[0]?.n ?? 0);

    // --- Deterministic NL label, from document_types.display_name. ---
    const dnRes = await db.query(`SELECT display_name FROM document_types WHERE slug = $1`, [slug]);
    const displayName = (dnRes.rows[0] as { display_name?: string })?.display_name ?? slug;
    let base = displayName;
    if (input.sectionKey) base = `${humanize(input.sectionKey)} in ${displayName}`;
    if (input.recordId) base = `This ${displayName} record`;
    const label = [base, containerPhrase].filter(Boolean).join(' ').trim();

    // --- Stable scope identity. ---
    const scopeHash = hashScope({
        previewId: input.previewId, jobId: input.jobId, fileId: input.fileId,
        recordId: input.recordId, slug, sectionKey: input.sectionKey,
    });

    return { slug, scope, memberFileIds, label, scopeHash, recordCount };
}

export default resolveScope;
