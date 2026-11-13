import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stand-in for the pg pool: records every statement and answers from a
// per-test responder, so nothing here touches a database.
const db = vi.hoisted(() => {
    type Result = { rows: Record<string, unknown>[]; rowCount?: number };
    const calls: { sql: string; params: unknown[] }[] = [];
    let respond: (sql: string, params: unknown[]) => Result = () => ({ rows: [] });
    const query = async (sql: string, params: unknown[] = []) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        calls.push({ sql: normalized, params });
        return respond(normalized, params);
    };
    return {
        calls,
        setResponder(fn: (sql: string, params: unknown[]) => Result) {
            respond = fn;
        },
        pool: { query, connect: async () => ({ query, release() {} }) },
    };
});

vi.mock('../database.js', () => ({ default: db.pool }));

import queueService from '../queue.js';

const JOB = 'b3f1c0de-0000-4000-8000-0000000000aa';
const LIVE = 'b3f1c0de-0000-4000-8000-000000000001';
const DELETED = 'b3f1c0de-0000-4000-8000-000000000002';

// file_processing_queue's columns in production, lease columns included.
const QUEUE_COLUMNS = [
    'id', 'file_id', 'job_id', 'priority', 'score', 'status', 'mode', 'retries', 'created_at',
    'updated_at', 'available_at', 'processing_started_at', 'queue_shard', 'worker_id', 'heartbeat_at',
];

function answerStaleSweep({ leaseColumns = true } = {}) {
    db.setResponder((sql) => {
        if (sql.includes('information_schema.columns')) {
            const columns = leaseColumns
                ? QUEUE_COLUMNS
                : QUEUE_COLUMNS.filter((c) => c !== 'worker_id' && c !== 'heartbeat_at');
            return { rows: columns.map((column_name) => ({ column_name })) };
        }
        if (sql.includes('to_regclass')) return { rows: [{ name: null }] };
        // Two stale rows belong to a file whose job_files row is gone...
        if (sql.startsWith('DELETE FROM file_processing_queue')) {
            return { rows: [{ file_id: DELETED }, { file_id: DELETED }] };
        }
        // ...and one to a file that still exists.
        if (sql.startsWith('UPDATE file_processing_queue')) {
            return { rows: [{ file_id: LIVE, job_id: JOB }] };
        }
        return { rows: [] };
    });
}

const statement = (prefix: string) => db.calls.findIndex((c) => c.sql.startsWith(prefix));

beforeEach(() => {
    db.calls.length = 0;
    queueService.schemaLoaded = false;
    queueService.queueShard = null;
});

describe('requeueStaleProcessingFiles', () => {
    it('deletes stale rows for deleted files instead of requeuing them', async () => {
        answerStaleSweep();

        const requeued = await queueService.requeueStaleProcessingFiles();

        expect(requeued).toEqual([{ file_id: LIVE, job_id: JOB }]);

        const drop = statement('DELETE FROM file_processing_queue');
        const requeue = statement('UPDATE file_processing_queue');
        expect(drop).toBeGreaterThan(-1);
        expect(drop).toBeLessThan(requeue);
        expect(db.calls[drop].sql).toContain("status = 'processing'");
        expect(db.calls[drop].sql).toMatch(/NOT EXISTS \(SELECT 1 FROM job_files\b/);
        expect(db.calls[requeue].sql).toMatch(/AND EXISTS \(SELECT 1 FROM job_files\b/);
    });

    it("only drops rows in this worker's shard whose lease has expired", async () => {
        queueService.queueShard = 'dev';
        answerStaleSweep();

        await queueService.requeueStaleProcessingFiles();

        const drop = db.calls[statement('DELETE FROM file_processing_queue')];
        expect(drop.sql).toContain('AND queue_shard = $1');
        expect(drop.sql).toContain("COALESCE(heartbeat_at, processing_started_at, updated_at) < NOW() - ($2 * INTERVAL '1 second')");
        expect(drop.params).toEqual(['dev', queueService.leaseStaleSeconds]);
    });

    it('touches nothing when the lease columns are missing', async () => {
        answerStaleSweep({ leaseColumns: false });

        await expect(queueService.requeueStaleProcessingFiles()).resolves.toEqual([]);

        expect(statement('DELETE FROM file_processing_queue')).toBe(-1);
        expect(statement('UPDATE file_processing_queue')).toBe(-1);
    });
});

describe('jobFileExists', () => {
    it('reports whether the job_files row is still there', async () => {
        db.setResponder((sql, params) =>
            sql === 'SELECT 1 FROM job_files WHERE id = $1' && params[0] === LIVE ? { rows: [{}] } : { rows: [] }
        );

        await expect(queueService.jobFileExists(LIVE)).resolves.toBe(true);
        await expect(queueService.jobFileExists(DELETED)).resolves.toBe(false);
    });
});

describe('removeFileFromQueue', () => {
    it("deletes the file's rows in every status and returns how many", async () => {
        db.setResponder(() => ({ rows: [], rowCount: 3 }));

        await expect(queueService.removeFileFromQueue(DELETED)).resolves.toBe(3);

        expect(db.calls).toEqual([
            { sql: 'DELETE FROM file_processing_queue WHERE file_id = $1', params: [DELETED] },
        ]);
    });
});
