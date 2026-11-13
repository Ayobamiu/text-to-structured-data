/**
 * Migration: conversations + messages — persistence for the NL-query conversational agent.
 *
 * A conversation is anchored to a resolved scope (scope_hash/scope/scope_label, from
 * resolveScope) so it can be resumed on the same click without re-resolving, and so
 * follow-ups can pull the last FilterSpec without replaying full history.
 *
 * org_id is NOT NULL — server-derived tenancy, never trusted to the client (RLS is off;
 * see ai/src/routes/nlquery.js). user_id is nullable: CLI/service usage may have no
 * authenticated user yet.
 *
 * messages.result_summary stores ONLY the bounded summary (+ ≤5 sample rows) the model
 * was shown — never full detail rows — so conversation history stays cheap to replay.
 *
 * Idempotent (CREATE ... IF NOT EXISTS). Run: `npx tsx migrations/add_conversations.ts`.
 */

import pool from '../src/database.js';

export default async function addConversations(): Promise<void> {
    const client = await pool.connect();
    try {
        console.log('Creating conversations + messages...');

        await client.query(`
            CREATE TABLE IF NOT EXISTS conversations (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                org_id          UUID NOT NULL,
                user_id         UUID REFERENCES users(id),
                slug            TEXT NOT NULL,
                scope_hash      TEXT NOT NULL,
                scope           JSONB NOT NULL,
                scope_label     TEXT NOT NULL,
                title           TEXT,
                last_message_at TIMESTAMPTZ,
                created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                content         TEXT,
                filter_spec     JSONB,
                query_hash      TEXT,
                result_summary  JSONB,
                rendered_view   BOOLEAN NOT NULL DEFAULT false,
                error           TEXT,
                created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_org ON conversations (org_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations (user_id, created_at DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_scope_hash ON conversations (scope_hash)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, created_at)`);

        console.log('✅ conversations + messages ready');
    } finally {
        client.release();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    addConversations()
        .then(() => { console.log('🎉 Migration completed'); process.exit(0); })
        .catch((e) => { console.error('💥 Migration failed:', e); process.exit(1); });
}
