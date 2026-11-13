/**
 * agent persistence — conversations + messages (see migrations/add_conversations.ts).
 *
 * A conversation is keyed by (org_id, user_id, scope_hash): re-entering the same
 * scope resumes the same conversation rather than forking a new one. org_id is
 * ALWAYS server-derived (never trusted to the caller) — see resolveOrgId.
 *
 * messages.result_summary stores only the bounded {mode, rowCount, sample≤5 rows}
 * the model was shown — never the full detail rowset — so history stays cheap.
 */

import pool from '../../database.js';
import type { QueryScope, FilterSpec } from '../types.ts';

interface Queryable {
    query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export interface ConversationRow {
    id: string;
    org_id: string;
    user_id: string | null;
    slug: string;
    scope_hash: string;
    scope: QueryScope;
    scope_label: string;
    title: string | null;
}

export interface MessageRow {
    id: string;
    conversation_id: string;
    role: 'user' | 'assistant';
    content: string | null;
    filter_spec: FilterSpec | null;
    query_hash: string | null;
    result_summary: unknown;
    rendered_view: boolean;
    error: string | null;
    created_at: string;
}

/**
 * Derive the org_id that owns a resolved scope, straight from extracted_records
 * (which already carries org_id per row). Mirrors the scope predicates the
 * compiler applies — never trust a client-supplied org_id.
 * Throws if the scope spans 0 or >1 orgs (refuses an ambiguous/unscoped conversation).
 */
export async function resolveOrgId(scope: QueryScope, slug: string, deps: { db?: Queryable } = {}): Promise<string> {
    const db = deps.db ?? (pool as unknown as Queryable);
    const where: string[] = ['slug = $1'];
    const params: unknown[] = [slug];

    if (scope.jobId) { params.push(scope.jobId); where.push(`job_id = $${params.length}`); }
    if (scope.fileIds && scope.fileIds.length) { params.push(scope.fileIds); where.push(`file_id = ANY($${params.length})`); }
    if (scope.previewId) { params.push(scope.previewId); where.push(`file_id IN (SELECT unnest(items_ids) FROM preview_data_table WHERE id = $${params.length})`); }
    if (scope.recordUids && scope.recordUids.length) { params.push(scope.recordUids); where.push(`record_uid = ANY($${params.length})`); }

    const res = await db.query(`SELECT DISTINCT org_id FROM extracted_records WHERE ${where.join(' AND ')} LIMIT 2`, params);
    const orgIds = res.rows.map((r) => String(r.org_id)).filter(Boolean);
    if (orgIds.length === 0) throw new Error('resolveOrgId: no projected rows in scope — cannot determine org (project the scope first)');
    if (orgIds.length > 1) throw new Error('resolveOrgId: scope spans multiple orgs — refusing an ambiguous conversation');
    return orgIds[0];
}

export interface GetOrCreateArgs {
    orgId: string;
    userId?: string | null;
    slug: string;
    scopeHash: string;
    scope: QueryScope;
    scopeLabel: string;
    deps?: { db?: Queryable };
}

/** Resume the conversation for this (org, user, scope) if one exists, else create it. */
export async function getOrCreateConversation(args: GetOrCreateArgs): Promise<ConversationRow> {
    const { orgId, userId = null, slug, scopeHash, scope, scopeLabel } = args;
    const db = args.deps?.db ?? (pool as unknown as Queryable);

    const existing = await db.query(
        `SELECT id, org_id, user_id, slug, scope_hash, scope, scope_label, title
         FROM conversations
         WHERE org_id = $1 AND scope_hash = $2 AND (user_id = $3 OR ($3 IS NULL AND user_id IS NULL))
         ORDER BY created_at DESC LIMIT 1`,
        [orgId, scopeHash, userId],
    );
    if (existing.rows.length > 0) return existing.rows[0] as unknown as ConversationRow;

    const created = await db.query(
        `INSERT INTO conversations (org_id, user_id, slug, scope_hash, scope, scope_label)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, org_id, user_id, slug, scope_hash, scope, scope_label, title`,
        [orgId, userId, slug, scopeHash, JSON.stringify(scope), scopeLabel],
    );
    return created.rows[0] as unknown as ConversationRow;
}

/** Look up the conversation for (org, user, scope) WITHOUT creating one (panel open). */
export async function findConversation(
    args: { orgId: string; userId?: string | null; scopeHash: string; deps?: { db?: Queryable } },
): Promise<ConversationRow | null> {
    const { orgId, userId = null, scopeHash } = args;
    const db = args.deps?.db ?? (pool as unknown as Queryable);
    const res = await db.query(
        `SELECT id, org_id, user_id, slug, scope_hash, scope, scope_label, title
         FROM conversations
         WHERE org_id = $1 AND scope_hash = $2 AND (user_id = $3 OR ($3 IS NULL AND user_id IS NULL))
         ORDER BY created_at DESC LIMIT 1`,
        [orgId, scopeHash, userId],
    );
    return (res.rows[0] as unknown as ConversationRow) ?? null;
}

export interface AppendMessageArgs {
    conversationId: string;
    role: 'user' | 'assistant';
    content?: string | null;
    filterSpec?: FilterSpec | null;
    queryHash?: string | null;
    resultSummary?: unknown;
    renderedView?: boolean;
    error?: string | null;
    deps?: { db?: Queryable };
}

export async function appendMessage(args: AppendMessageArgs): Promise<MessageRow> {
    const db = args.deps?.db ?? (pool as unknown as Queryable);
    const res = await db.query(
        `INSERT INTO messages (conversation_id, role, content, filter_spec, query_hash, result_summary, rendered_view, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, conversation_id, role, content, filter_spec, query_hash, result_summary, rendered_view, error, created_at`,
        [
            args.conversationId, args.role, args.content ?? null,
            args.filterSpec ? JSON.stringify(args.filterSpec) : null,
            args.queryHash ?? null,
            args.resultSummary !== undefined ? JSON.stringify(args.resultSummary) : null,
            args.renderedView ?? false,
            args.error ?? null,
        ],
    );
    await db.query(`UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`, [args.conversationId]);
    return res.rows[0] as unknown as MessageRow;
}

/** Most recent messages, oldest-first — bounded history for the agent loop. */
export async function getRecentMessages(conversationId: string, limit = 20, deps: { db?: Queryable } = {}): Promise<MessageRow[]> {
    const db = deps.db ?? (pool as unknown as Queryable);
    const res = await db.query(
        `SELECT id, conversation_id, role, content, filter_spec, query_hash, result_summary, rendered_view, error, created_at
         FROM (
             SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2
         ) recent ORDER BY created_at ASC`,
        [conversationId, limit],
    );
    return res.rows as unknown as MessageRow[];
}

/** The last FilterSpec issued in this conversation (for follow-up composition), or undefined. */
export async function getLastFilterSpec(conversationId: string, deps: { db?: Queryable } = {}): Promise<FilterSpec | undefined> {
    const db = deps.db ?? (pool as unknown as Queryable);
    const res = await db.query(
        `SELECT filter_spec FROM messages
         WHERE conversation_id = $1 AND filter_spec IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        [conversationId],
    );
    const spec = (res.rows[0] as { filter_spec?: FilterSpec } | undefined)?.filter_spec;
    return spec ?? undefined;
}
