/**
 * runAgentTurn — the conversational agent (§13 of the NL-query handoff).
 *
 * ONE tool-calling model is the router: it decides per turn whether to just chat,
 * call query_generator (a data question), or emit render_view (the user wants the
 * detail table/CSV for the last query). There is no separate intent classifier.
 *
 * Grounding: the model only ever sees the SUMMARY (+ ≤5 sample rows) a query
 * produced — never the full row list — and is instructed to narrate only from
 * that. Detail rows are fetched on render_view but never echoed back into the
 * model's context.
 *
 * Tenancy: org/job/file/preview scope is fixed for the whole conversation (it's
 * the conversation's resolved scope) and is injected here, never chosen by the
 * model and never re-derived from anything the model says.
 */

import Anthropic from '@anthropic-ai/sdk';
import pool from '../../database.js';
import buildCatalog from '../catalog/buildCatalog.ts';
import generateQuery from '../query/generate.ts';
import type { QueryScope, FilterSpec } from '../types.ts';
import compile from '../compiler/compile.ts';
import { describeSpec } from '../formatter/format.ts';
import { appendMessage, getRecentMessages, getLastFilterSpec, type MessageRow } from './persistence.ts';

export const AGENT_MODEL = 'claude-sonnet-4-6';

interface Queryable {
    query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

const TOOLS: Anthropic.Tool[] = [
    {
        name: 'query_generator',
        description:
            'Answer a data question over the records in scope. Pass the user\'s question verbatim (or your ' +
            'paraphrase of a follow-up). Scope/org/slug are fixed for this conversation and injected automatically ' +
            '— never ask the user for them. Returns a summary (row/aggregate count) and up to 5 sample rows.',
        input_schema: {
            type: 'object',
            properties: {
                question: { type: 'string', description: 'The data question, in natural language.' },
            },
            required: ['question'],
        },
    },
    {
        name: 'render_view',
        description:
            'Signal that the user wants to SEE the full result of the last query_generator call as a table/CSV ' +
            '(e.g. "show me all of them", "export this", "give me the list"). Call this with no further analysis — ' +
            'the UI renders the detail rows; you do not receive them.',
        input_schema: { type: 'object', properties: {}, required: [] },
    },
];

const SYSTEM = `You are a data assistant answering questions about geological/environmental well records, scoped to one fixed context for this entire conversation.

Hard rules:
- Answer data questions ONLY using what query_generator returns (the summary count/aggregate + sample rows). Never invent values, never estimate beyond what was returned.
- A query returning 0 rows is a valid, answerable result — say so plainly ("no records match X").
- If the data is partially null/missing (e.g. most sample rows have no county), mention that as a data-quality caveat rather than ignoring it.
- Use query_generator for ANY question about the records in scope, including follow-ups ("of those, how many...", "and deeper than...") — pass your best paraphrase of the question; the tool keeps track of the previous filter for you.
- Use render_view only when the user explicitly asks to see/export the full list, not after every query_generator call.
- For pure chat (greetings, clarifying questions about what you can do) just reply — no tool call.
- Keep answers short and concrete: lead with the number/finding, then at most one caveat.`;

export interface TurnDeps {
    catalog?: Awaited<ReturnType<typeof buildCatalog>>;
    db?: Queryable;
    apiKey?: string;
    model?: string;
    /** Override the model call (for tests). */
    createMessage?: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
}

export interface TurnResult {
    reply: string;
    /** Set if query_generator ran this turn. */
    filterSpec?: FilterSpec;
    queryHash?: string;
    resultSummary?: {
        mode: 'list' | 'aggregate';
        /** list mode: matching record count. aggregate mode: undefined — see summaryRows for the rollup values. */
        rowCount?: number;
        /** aggregate mode: the rollup rows (count/avg/sum/... per group). */
        summaryRows?: Record<string, unknown>[];
        sample: Record<string, unknown>[];
    };
    /** True if the model asked to render the detail view (caller fetches + shows it). */
    renderView?: boolean;
    detail?: { sql: string; params: unknown[] };
}

function historyToMessages(history: MessageRow[]): Anthropic.MessageParam[] {
    return history.map((m) => ({
        role: m.role,
        content: m.content ?? (m.result_summary ? JSON.stringify(m.result_summary) : ''),
    }));
}

export interface RunAgentTurnArgs {
    conversationId: string;
    question: string;
    slug: string;
    scope: QueryScope;
    scopeHash: string;
    deps?: TurnDeps;
}

export async function runAgentTurn(args: RunAgentTurnArgs): Promise<TurnResult> {
    const { conversationId, question, slug, scope, scopeHash, deps = {} } = args;
    const db = deps.db ?? (pool as unknown as Queryable);
    const catalog = deps.catalog ?? (await buildCatalog(slug, { db: deps.db as never }));

    await appendMessage({ conversationId, role: 'user', content: question, deps: { db } });
    const history = await getRecentMessages(conversationId, 20, { db });

    const client = new Anthropic({ apiKey: deps.apiKey ?? process.env.ANTHROPIC_API_KEY });
    const createMessage = deps.createMessage ?? ((p) => client.messages.create(p) as Promise<Anthropic.Message>);
    const model = deps.model ?? AGENT_MODEL;

    const messages: Anthropic.MessageParam[] = historyToMessages(history.slice(0, -1));
    messages.push({ role: 'user', content: question });

    // The conversation's last FilterSpec (across turns) — the real follow-up mechanism.
    // The model is told the tool "remembers"; this is what makes that true rather than
    // relying on the model perfectly restating prior conditions in its tool-call text.
    let lastSpec = await getLastFilterSpec(conversationId, { db });
    let lastDetail: TurnResult['detail'];
    if (lastSpec) lastDetail = compile(lastSpec, catalog, scope);

    let turnFilterSpec: FilterSpec | undefined;
    let turnQueryHash: string | undefined;
    let turnSummary: TurnResult['resultSummary'];
    let turnDetail: TurnResult['detail'] = lastDetail;
    let renderView = false;

    // Persist the assistant turn and shape the result — reads the turn state at call time.
    const finalize = async (reply: string): Promise<TurnResult> => {
        await appendMessage({
            conversationId,
            role: 'assistant',
            content: reply,
            filterSpec: turnFilterSpec ?? null,
            queryHash: turnQueryHash ?? null,
            resultSummary: turnSummary ?? null,
            renderedView: renderView,
            deps: { db },
        });
        return { reply, filterSpec: turnFilterSpec, queryHash: turnQueryHash, resultSummary: turnSummary, renderView, detail: turnDetail };
    };

    // Tool-use loop: the model may call query_generator and/or render_view before replying in text.
    for (let i = 0; i < 4; i++) {
        const res = await createMessage({
            model,
            max_tokens: 1024,
            system: SYSTEM,
            tools: TOOLS,
            messages,
        });

        const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (toolUses.length === 0) {
            const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
            return finalize(text?.text ?? '');
        }

        messages.push({ role: 'assistant', content: res.content });
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const use of toolUses) {
            if (use.name === 'query_generator') {
                const q = (use.input as { question: string }).question;
                const gen = await generateQuery({
                    question: q, slug, scope, scopeHash,
                    priorSpec: turnFilterSpec ?? lastSpec, // prefer this turn's own chain, else the conversation's last spec
                    deps: { catalog },
                });
                const sres = await db.query(gen.summary.sql, gen.summary.params);
                let sample: Record<string, unknown>[] = [];
                if (gen.mode === 'list' && sres.rows.length > 0) {
                    const dres = await db.query(gen.detail.sql, gen.detail.params);
                    sample = dres.rows.slice(0, 5);
                }
                turnFilterSpec = gen.filterSpec;
                turnQueryHash = gen.queryHash;
                turnDetail = gen.detail;
                turnSummary = gen.mode === 'aggregate'
                    ? { mode: gen.mode, summaryRows: sres.rows.slice(0, 15), sample }
                    : { mode: gen.mode, rowCount: Number((sres.rows[0] as { count?: number })?.count ?? 0), sample };

                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: use.id,
                    content: JSON.stringify({ interpreted: gen.interpreted, mode: gen.mode, summary: sres.rows.slice(0, 15), sample }),
                });
            } else if (use.name === 'render_view') {
                renderView = true;
                const shownSpec = turnFilterSpec ?? lastSpec;
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: use.id,
                    content: turnDetail
                        ? `render_view acknowledged — the UI is now showing the detail table for: ${describeSpec(shownSpec!)}. ` +
                          `Describe it as exactly this query's results, nothing else — do not reference any other topic from earlier in the conversation.`
                        : 'No prior query in this conversation to render.',
                });
            } else {
                toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: `Unknown tool ${use.name}`, is_error: true });
            }
        }
        messages.push({ role: 'user', content: toolResults });
    }

    // Tool budget exhausted without the model settling on a text answer. Rather than
    // throw an internal error at the user, force one final reply with NO tools available
    // so the model must summarize from what it already gathered this turn.
    const finalRes = await createMessage({ model, max_tokens: 1024, system: SYSTEM, messages });
    const finalText = finalRes.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    return finalize(
        finalText ||
            'I wasn’t able to fully work through that one — could you rephrase it or narrow it down a bit?',
    );
}

export default runAgentTurn;
