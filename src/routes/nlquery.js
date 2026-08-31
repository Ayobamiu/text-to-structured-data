import express from 'express';
import pool from '../database.js';
import runQuery from '../nlquery/orchestrator/runQuery.ts';
import resolveScope from '../nlquery/scope/resolveScope.ts';
import buildCatalog from '../nlquery/catalog/buildCatalog.ts';
import formatRows from '../nlquery/formatter/format.ts';
import runAgentTurn from '../nlquery/agent/runAgentTurn.ts';
import {
    resolveOrgId,
    getOrCreateConversation,
    findConversation,
    getRecentMessages,
    getLastFilterSpec,
} from '../nlquery/agent/persistence.ts';
import { getUserOrganizationIds } from '../utils/organizationHelpers.js';
import { checkJobAccess, checkFileAccess } from '../utils/accessControl.js';

const router = express.Router();

/**
 * POST /nlquery
 * Body: { question: string, slug?: string, jobId?: string }
 * Returns: { interpreted, spec, columns, rows, rowCount, csv }
 *
 * Translates a natural-language question into a constrained FilterSpec (via Claude),
 * compiles it to scoped, read-only SQL over extracted_records, and returns a table
 * plus the interpreted-filter echo so the user can see exactly what was searched.
 *
 * Tenancy: org scope is ALWAYS derived from the authenticated caller (req.user), never
 * from the request body — RLS is off, so this server-side scope is the only tenancy guard.
 * If jobId is given, membership is checked explicitly before the job is used to scope the query.
 */
router.post('/', async (req, res) => {
    try {
        const { question, slug = 'mgs_well_log', jobId } = req.body || {};
        if (!question || typeof question !== 'string') {
            return res.status(400).json({ status: 'error', message: 'question (string) is required' });
        }

        const organizationIds = await getUserOrganizationIds(req.user);
        if (organizationIds.length === 0) {
            return res.status(400).json({ status: 'error', message: 'User must be part of an organization' });
        }

        if (jobId) {
            const hasAccess = await checkJobAccess(jobId, req.user, res);
            if (!hasAccess) return; // checkJobAccess already sent the 403/500
        }

        const scope = { orgId: organizationIds };
        if (jobId) scope.jobId = jobId;

        const { spec, interpreted, result } = await runQuery({ question, slug, scope });

        return res.json({
            status: 'success',
            data: {
                interpreted,
                spec,
                columns: result.columns,
                rows: result.rows,
                rowCount: result.rowCount,
                csv: result.csv,
            },
        });
    } catch (error) {
        console.error('nlquery error:', error);
        return res.status(500).json({ status: 'error', message: error?.message || 'query failed' });
    }
});

// ──────────────────────────────────────────────────────────────────────────
// Conversational agent (chat) — see ai/src/nlquery/agent/runAgentTurn.ts.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Map a request body's `{ slug, scope:{...} }` to a resolved scope, then enforce
 * tenancy: the scope's REAL org (derived from the data rows, never the body) must
 * be one the caller belongs to. Returns the bits the chat routes need, or null if
 * a response was already sent (access denied / bad input).
 *
 * This is the only tenancy guard for chat — RLS is off — so it mirrors the existing
 * one-shot route: org is server-derived, job/file membership is checked explicitly.
 */
async function prepareChatScope(req, res, body) {
    const slug = typeof body?.slug === 'string' ? body.slug : undefined;
    const s = body?.scope || {};
    const input = {
        slug,
        fileId: s.fileId,
        jobId: s.jobId,
        previewId: s.previewId,
        recordId: s.recordId,
        sectionKey: s.sectionKey,
    };
    if (!input.slug && !input.fileId && !input.jobId && !input.previewId && !input.recordId) {
        res.status(400).json({ status: 'error', message: 'a scope (slug, fileId, jobId, previewId or recordId) is required' });
        return null;
    }

    const organizationIds = await getUserOrganizationIds(req.user);
    if (organizationIds.length === 0) {
        res.status(400).json({ status: 'error', message: 'User must be part of an organization' });
        return null;
    }

    // Explicit membership checks for the references the caller named (defense in depth;
    // each sends its own 403/404 on failure).
    if (input.jobId) {
        const ok = await checkJobAccess(input.jobId, req.user, res);
        if (!ok) return null;
    }
    if (input.fileId) {
        const ok = await checkFileAccess(input.fileId, req.user, res);
        if (!ok) return null;
    }

    let resolved;
    try {
        resolved = await resolveScope(input);
    } catch (e) {
        res.status(400).json({ status: 'error', message: e?.message || 'could not resolve scope' });
        return null;
    }

    // The org that actually owns the data in scope (from extracted_records, not the body).
    // The caller must belong to it — this also covers previewId/recordId, which have no
    // direct access-control helper above.
    let dataOrgId;
    try {
        dataOrgId = await resolveOrgId(resolved.scope, resolved.slug);
    } catch (e) {
        res.status(409).json({ status: 'error', message: e?.message || 'no data in scope yet' });
        return null;
    }
    if (!organizationIds.map(String).includes(String(dataOrgId))) {
        res.status(403).json({ status: 'error', message: 'You do not have access to the data in this scope' });
        return null;
    }

    return { resolved, dataOrgId, userId: req.user?.id ?? null };
}

/** Up to 4 scope-aware starter questions, derived deterministically from the catalog. */
function buildStarters(catalog, resolved) {
    const starters = ['Summarize what’s in this data', 'Show me all the records'];
    const fields = catalog?.fields ?? [];

    // A good group-by column (categorical-ish) if the schema has one.
    const GROUPABLE = /county|type|status|class|formation|aquifer|township|method|use|material/i;
    const groupField = fields.find((f) => GROUPABLE.test(f.name) && (f.type === 'string' || f.promotedColumn));
    if (groupField) starters.push(`Count by ${groupField.name.replace(/_/g, ' ')}`);

    // A numeric field for an aggregate, if distinct from the group-by.
    const numField = fields.find(
        (f) => (f.type === 'number' || f.type === 'integer') && f.name !== groupField?.name,
    );
    if (numField && starters.length < 4) starters.push(`What’s the average ${numField.name.replace(/_/g, ' ')}?`);

    return starters.slice(0, 4);
}

/**
 * GET /nlquery/chat — load the conversation for a scope (history + starters) without
 * creating one. Drives the chat panel's initial render. Same scope params as POST.
 * Query: slug, fileId, jobId, previewId, recordId, sectionKey
 */
router.get('/chat', async (req, res) => {
    try {
        const prepared = await prepareChatScope(req, res, { slug: req.query.slug, scope: req.query });
        if (!prepared) return; // response already sent
        const { resolved, dataOrgId, userId } = prepared;

        const existing = await findConversation({
            orgId: dataOrgId,
            userId,
            scopeHash: resolved.scopeHash,
        });
        const messages = existing ? await getRecentMessages(existing.id, 50) : [];
        const catalog = await buildCatalog(resolved.slug);

        return res.json({
            status: 'success',
            data: {
                conversationId: existing?.id ?? null,
                slug: resolved.slug,
                scopeLabel: resolved.label,
                recordCount: resolved.recordCount,
                starters: buildStarters(catalog, resolved),
                messages: messages.map((m) => ({
                    id: m.id,
                    role: m.role,
                    content: m.content,
                    resultSummary: m.result_summary,
                    renderedView: m.rendered_view,
                    createdAt: m.created_at,
                })),
            },
        });
    } catch (error) {
        console.error('nlquery chat history error:', error);
        return res.status(500).json({ status: 'error', message: error?.message || 'failed to load chat' });
    }
});

/**
 * POST /nlquery/chat — one conversational turn.
 * Body: { question: string, slug?: string, scope: { fileId?, jobId?, previewId?, recordId?, sectionKey? } }
 * Returns: { conversationId, reply, resultSummary?, renderView, view? }
 *   - view is set only when the agent asked to render the detail table:
 *     { interpreted, columns, rows, rowCount, csv }
 */
router.post('/chat', async (req, res) => {
    try {
        const { question } = req.body || {};
        if (!question || typeof question !== 'string') {
            return res.status(400).json({ status: 'error', message: 'question (string) is required' });
        }

        const prepared = await prepareChatScope(req, res, req.body);
        if (!prepared) return; // response already sent
        const { resolved, dataOrgId, userId } = prepared;

        const conversation = await getOrCreateConversation({
            orgId: dataOrgId,
            userId,
            slug: resolved.slug,
            scopeHash: resolved.scopeHash,
            scope: resolved.scope,
            scopeLabel: resolved.label,
        });

        const result = await runAgentTurn({
            conversationId: conversation.id,
            question,
            slug: resolved.slug,
            scope: resolved.scope,
            scopeHash: resolved.scopeHash,
        });

        // If the agent asked to render the detail table, run it now and shape columns/rows/csv.
        let view;
        if (result.renderView && result.detail) {
            const dres = await pool.query(result.detail.sql, result.detail.params);
            const spec = result.filterSpec ?? (await getLastFilterSpec(conversation.id));
            const formatted = formatRows(dres.rows, spec ?? { slug: resolved.slug, where: [] });
            view = {
                interpreted: formatted.explainerText,
                columns: formatted.columns,
                rows: formatted.rows,
                rowCount: formatted.rowCount,
                csv: formatted.csv,
            };
        }

        return res.json({
            status: 'success',
            data: {
                conversationId: conversation.id,
                reply: result.reply,
                resultSummary: result.resultSummary ?? null,
                renderView: !!result.renderView,
                view: view ?? null,
            },
        });
    } catch (error) {
        console.error('nlquery chat error:', error);
        return res.status(500).json({ status: 'error', message: error?.message || 'chat turn failed' });
    }
});

export default router;
