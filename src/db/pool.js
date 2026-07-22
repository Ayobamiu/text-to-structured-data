/**
 * The single Postgres connection pool for this process.
 *
 * Every module MUST import this pool (directly or via database.js) instead of
 * creating its own `new Pool(...)`. We connect through Supabase's Supavisor
 * pooler in session mode, where the server-side budget is small (pool_size,
 * typically 15) and SHARED across every process: ai-api, ai-worker, local
 * dev, and one-off scripts. Before this module existed the process ran three
 * independent pools (database.js max 20, users.js max 20, jobFileStats.js
 * default 10) — a combined burst ceiling of ~50 sessions per process, which
 * blew through the pooler cap under load (EMAXCONNSESSION).
 *
 * PG_POOL_MAX tunes the per-process cap. Defaults to 6 so api (6) + worker
 * (6) stay under a pool_size of 15 with headroom for dev/scripts. Suggested
 * production values: ai-api PG_POOL_MAX=6, ai-worker PG_POOL_MAX=4.
 */

import pg from 'pg';
import dotenv from 'dotenv';
import { resolvePgPoolConfig, getDatabaseUrl } from '../utils/pgConnection.js';

// Only load .env file in development
if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
}

const { Pool } = pg;

const defaultDbUrl = 'postgresql://postgres:password@localhost:5432/batch_processor';

const poolMax = Number.parseInt(process.env.PG_POOL_MAX || '', 10);

// Database connection pool (IPv4 + TLS SNI when needed — see resolvePgPoolConfig)
const pool = new Pool(
    await resolvePgPoolConfig(getDatabaseUrl(defaultDbUrl), {
        max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 6,
        // Supabase session pooler (5432) can drop idle TLS sessions; recycle
        // before that happens so we don't hit ssl/tls alert bad_record_mac.
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 10000,
        maxLifetimeSeconds: 300,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
    })
);

// Idle clients emit 'error' when the pooler/network kills the TLS socket.
// Without a listener, Node treats that as an unhandled error and crashes
// (nodemon: "app crashed"). Log and let pg discard the dead client.
pool.on('error', (err) => {
    console.error(
        '⚠️ Unexpected idle Postgres client error (pool will replace the connection):',
        err.code || err.message
    );
});

export default pool;
