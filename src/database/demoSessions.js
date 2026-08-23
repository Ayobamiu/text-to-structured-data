/**
 * Public demo session persistence.
 * Capability token is stored hashed (sha256 hex); the raw token is returned once.
 */

import crypto from 'crypto';
import pool from '../db/pool.js';

let schemaReady = false;

const DDL = `
CREATE TABLE IF NOT EXISTS demo_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash VARCHAR(64) NOT NULL,
    job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
    file_id UUID REFERENCES job_files(id) ON DELETE SET NULL,
    filename TEXT,
    page_count INTEGER,
    document_type TEXT,
    status VARCHAR(40) NOT NULL DEFAULT 'queued',
    ip_address TEXT,
    user_agent TEXT,
    lead_email TEXT,
    download_token_hash VARCHAR(64),
    download_token_expires_at TIMESTAMPTZ,
    downloaded_at TIMESTAMPTZ,
    notified_classified_at TIMESTAMPTZ,
    notified_completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);
CREATE INDEX IF NOT EXISTS idx_demo_sessions_token_hash ON demo_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_demo_sessions_ip_created ON demo_sessions (ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_demo_sessions_file_id ON demo_sessions (file_id);
`;

export function hashDemoToken(rawToken) {
    return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

export function generateDemoToken() {
    return crypto.randomBytes(32).toString('hex');
}

export async function ensureDemoSessionsTable() {
    if (schemaReady) return;
    await pool.query(DDL);
    await pool.query(`
        ALTER TABLE demo_sessions
            ADD COLUMN IF NOT EXISTS download_token_hash VARCHAR(64)
    `);
    await pool.query(`
        ALTER TABLE demo_sessions
            ADD COLUMN IF NOT EXISTS download_token_expires_at TIMESTAMPTZ
    `);
    schemaReady = true;
}

export async function createDemoSession({
    tokenHash,
    jobId,
    fileId,
    filename,
    pageCount,
    ipAddress,
    userAgent,
}) {
    await ensureDemoSessionsTable();
    const { rows } = await pool.query(
        `INSERT INTO demo_sessions (
            token_hash, job_id, file_id, filename, page_count,
            ip_address, user_agent, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')
        RETURNING *`,
        [tokenHash, jobId, fileId, filename, pageCount, ipAddress, userAgent]
    );
    return rows[0];
}

export async function getDemoSessionById(id) {
    await ensureDemoSessionsTable();
    const { rows } = await pool.query(
        `SELECT * FROM demo_sessions WHERE id = $1`,
        [id]
    );
    return rows[0] || null;
}

export async function getValidDemoSession(id, rawToken) {
    const session = await getDemoSessionById(id);
    if (!session) return null;
    if (session.expires_at && new Date(session.expires_at) < new Date()) return null;
    if (session.token_hash !== hashDemoToken(rawToken)) return null;
    return session;
}

const DOWNLOAD_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

export async function getValidDemoSessionByDownloadToken(id, rawToken) {
    const session = await getDemoSessionById(id);
    if (!session) return null;
    if (session.expires_at && new Date(session.expires_at) < new Date()) return null;
    if (!session.download_token_hash || !rawToken) return null;
    if (session.download_token_hash !== hashDemoToken(rawToken)) return null;
    if (
        session.download_token_expires_at &&
        new Date(session.download_token_expires_at) < new Date()
    ) {
        return null;
    }
    return session;
}

/** Rotate the emailed download token. Returns the raw token (shown once, in the email). */
export async function issueDemoDownloadToken(sessionId, email) {
    const raw = generateDemoToken();
    const session = await updateDemoSession(sessionId, {
        lead_email: email,
        download_token_hash: hashDemoToken(raw),
        download_token_expires_at: new Date(Date.now() + DOWNLOAD_TOKEN_TTL_MS),
    });
    return { raw, session, expiresAt: session?.download_token_expires_at };
}

/**
 * Quota is for actual extraction work, not failed attempts.
 * A session only counts if OCR/extract started or finished. Failed-before-
 * extract (or failed after) does not burn the hourly cap — otherwise a
 * downed provider locks the visitor out of retries.
 */
export async function countRecentDemoSessionsByIp(ipAddress, windowMs = 60 * 60 * 1000) {
    await ensureDemoSessionsTable();
    if (!ipAddress) return 0;
    const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n
         FROM demo_sessions ds
         LEFT JOIN job_files jf ON jf.id = ds.file_id
         WHERE ds.ip_address = $1
           AND ds.created_at > NOW() - ($2::int * INTERVAL '1 millisecond')
           AND (
             jf.extraction_status IN ('processing', 'completed')
             OR jf.processing_status IN ('processing', 'completed')
           )`,
        [ipAddress, windowMs]
    );
    return rows[0]?.n ?? 0;
}

export async function updateDemoSession(id, patch) {
    await ensureDemoSessionsTable();
    const allowed = [
        'status',
        'document_type',
        'page_count',
        'lead_email',
        'download_token_hash',
        'download_token_expires_at',
        'downloaded_at',
        'notified_classified_at',
        'notified_completed_at',
    ];
    const sets = [];
    const values = [];
    let i = 1;
    for (const [key, value] of Object.entries(patch)) {
        if (!allowed.includes(key)) continue;
        sets.push(`${key} = $${i++}`);
        values.push(value);
    }
    if (sets.length === 0) {
        return getDemoSessionById(id);
    }
    sets.push('updated_at = NOW()');
    values.push(id);
    const { rows } = await pool.query(
        `UPDATE demo_sessions SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
        values
    );
    return rows[0] || null;
}

/** Atomically claim a one-shot notify flag. Returns the row only if this caller won. */
export async function claimDemoNotify(id, column) {
    await ensureDemoSessionsTable();
    const allowed = new Set(['notified_classified_at', 'notified_completed_at']);
    if (!allowed.has(column)) return null;
    const { rows } = await pool.query(
        `UPDATE demo_sessions
         SET ${column} = NOW(), updated_at = NOW()
         WHERE id = $1 AND ${column} IS NULL
         RETURNING *`,
        [id]
    );
    return rows[0] || null;
}
