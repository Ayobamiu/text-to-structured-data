import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// worker.js has no exports and starts polling as soon as it is imported, so
// this suite boots the real module against an in-memory queue and drives it
// through its poll loop. Every dependency is stubbed: nothing here touches a
// database, S3, OpenAI or the network.

const h = vi.hoisted(() => {
    process.env.WORKER_INTERVAL_MS = '1';
    process.env.WORKER_MAX_RETRIES = '3';

    const JOB = 'c0ffee00-0000-4000-8000-0000000000aa';

    type Row = {
        fileId: string;
        jobId: string;
        status: 'queued' | 'processing';
        mode: string;
        retries: number;
        seq: number;
        claimedSeq: number;
        // Retries are scheduled seconds out; nothing delayed is claimable here.
        delayed: boolean;
    };

    const state = {
        rows: [] as Row[],
        jobFiles: new Set<string>(),
        failExistenceCheck: new Set<string>(),
        claims: [] as string[],
        events: [] as { fileId: string; phase?: string }[],
        idlePolls: 0,
        parked: false,
        seq: 0,
    };

    const addRow = (fileId: string) =>
        state.rows.push({
            fileId, jobId: JOB, status: 'queued', mode: 'normal', retries: 0,
            seq: ++state.seq, claimedSeq: 0, delayed: false,
        });

    const queue = {
        testConnection: async () => true,
        requeueStaleProcessingFiles: async () => [],
        isQueuePaused: async () => false,
        heartbeat: async () => true,
        markFileAsProcessing: async () => {},
        getNextFile: async () => {
            if (state.parked) return new Promise<never>(() => {});
            const next = state.rows
                .filter((r) => r.status === 'queued' && !r.delayed)
                .sort((a, b) => a.seq - b.seq)[0];
            if (!next) {
                state.idlePolls++;
                return null;
            }
            next.status = 'processing';
            next.claimedSeq = ++state.seq;
            state.claims.push(next.fileId);
            return {
                fileId: next.fileId, jobId: next.jobId, priority: 0, retries: next.retries,
                status: next.status, mode: next.mode, timestamp: 0,
            };
        },
        // Same shape as queue.js: read the claimed row's retries, INSERT a new row.
        retryFile: vi.fn(async (fileId: string, jobId: string, _priority: number, mode: string) => {
            const claimed = state.rows
                .filter((r) => r.fileId === fileId && r.status === 'processing')
                .sort((a, b) => b.claimedSeq - a.claimedSeq)[0];
            const retries = claimed?.retries ?? 0;
            if (retries >= 3) return false;
            state.rows.push({
                fileId, jobId, status: 'queued', mode, retries: retries + 1,
                seq: ++state.seq, claimedSeq: 0, delayed: true,
            });
            return true;
        }),
        removeFileFromProcessing: vi.fn(async (fileId: string) => {
            state.rows = state.rows.filter((r) => !(r.fileId === fileId && r.status === 'processing'));
        }),
        removeFileFromQueue: vi.fn(async (fileId: string) => {
            const before = state.rows.length;
            state.rows = state.rows.filter((r) => r.fileId !== fileId);
            return before - state.rows.length;
        }),
        jobFileExists: vi.fn(async (fileId: string) => {
            if (state.failExistenceCheck.has(fileId)) throw new Error('Connection terminated unexpectedly');
            return state.jobFiles.has(fileId);
        }),
    };

    const database = {
        getFileById: vi.fn(async (fileId: string) =>
            state.jobFiles.has(fileId) ? { id: fileId, job_id: JOB, filename: `${fileId}.pdf` } : null
        ),
        // Like the real helper, an UPDATE that matches no job_files row throws.
        updateFileExtractionStatus: vi.fn(async (fileId: string, ..._rest: unknown[]) => {
            if (!state.jobFiles.has(fileId)) throw new Error('File not found');
            return { id: fileId };
        }),
        // processFile loads the job with a raw query. Failing it sends a file
        // that still exists down the ordinary error path.
        pool: {
            connect: async () => ({
                query: async () => {
                    throw new Error('job lookup failed (test stub)');
                },
                release() {},
            }),
        },
    };

    return { JOB, state, addRow, queue, database };
});

vi.mock('http', () => ({ default: { createServer: () => ({ listen: () => {} }) } }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: () => {}, emit: () => {}, connected: false }) }));
vi.mock('../queue.js', () => ({ default: h.queue }));
vi.mock('../database.js', () => ({
    default: h.database.pool,
    getJobStatus: vi.fn(),
    getFileById: h.database.getFileById,
    updateFileExtractionStatus: h.database.updateFileExtractionStatus,
    updateFileProcessingStatus: vi.fn(),
    updateJobStatus: vi.fn(),
    updateFileSelectedPages: vi.fn(),
    updateFileDetectedSections: vi.fn(),
}));
vi.mock('../s3Service.js', () => ({ default: class { isCloudStorageEnabled() { return false; } } }));
vi.mock('../services/extractionService.js', () => ({ default: class {} }));
vi.mock('../services/processingService.js', () => ({ default: class {} }));
vi.mock('../services/visualClassifierWiring.js', () => ({
    deriveSelectedPagesAndMeta: vi.fn(),
    resolveExtractionFlags: vi.fn(),
}));
vi.mock('../services/perSectionExtractor.js', () => ({ extractAndProcessPerSection: vi.fn() }));
vi.mock('../services/fileProcessingContext.js', () => ({ buildExtractionMetadata: vi.fn() }));
vi.mock('../services/processingEventsService.js', () => ({
    recordProcessingEvent: vi.fn(async (evt: { fileId: string; phase?: string }) => {
        h.state.events.push(evt);
        return null;
    }),
}));
vi.mock('../services/qaJobService.js', () => ({ parseQAMode: () => null, runFileQAJob: vi.fn() }));
vi.mock('../services/directedReextractionService.ts', () => ({
    parseRexMode: () => null,
    runDirectedReextractionJob: vi.fn(),
}));
vi.mock('../services/sectionReextractService.ts', () => ({
    SECTION_REEXTRACT_MODE: 'sreex',
    runSectionReextraction: vi.fn(),
    finalizeSreexRunById: vi.fn(),
}));
vi.mock('../services/postProcessingJobService.ts', () => ({
    parsePsvcMode: () => null,
    runPostProcessingFile: vi.fn(),
}));
vi.mock('../services/depthGeometryService.ts', () => ({
    isDepthGeometryEnabled: () => false,
    recoverDepthGeometry: vi.fn(),
}));
vi.mock('../services/depthRefinementService.ts', () => ({ refineExtractionData: vi.fn() }));

const DELETED = 'c0ffee00-0000-4000-8000-00000000000d';
const LIVE = 'c0ffee00-0000-4000-8000-00000000000a';
const FLAKY = 'c0ffee00-0000-4000-8000-00000000000f';

// Resolves once the worker has claimed `fileId` and then found nothing left to claim.
async function settleAfterClaiming(fileId: string) {
    const idleBefore = h.state.idlePolls;
    await vi.waitFor(
        () => {
            expect(h.state.claims).toContain(fileId);
            expect(h.state.idlePolls).toBeGreaterThan(idleBefore);
        },
        { timeout: 5000 }
    );
}

const firstArgs = (mock: { mock: { calls: unknown[][] } }) => mock.mock.calls.map((call) => call[0]);

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // DELETED's job_files row is gone, but three of its rows are still queued
    // (as a restart's requeue left them), ahead of a newer upload.
    h.state.jobFiles.add(LIVE);
    h.addRow(DELETED);
    h.addRow(DELETED);
    h.addRow(DELETED);
    h.addRow(LIVE);

    await import('../worker.js');
    await settleAfterClaiming(LIVE);
});

afterAll(() => {
    // Leave the poll loop waiting on a promise that never settles, so no timers outlive the suite.
    h.state.parked = true;
});

describe('worker: queue item for a deleted file', () => {
    it('removes every queue row for the file on the first claim', () => {
        expect(h.state.claims.filter((id) => id === DELETED)).toHaveLength(1);
        expect(h.state.rows.filter((r) => r.fileId === DELETED)).toEqual([]);
    });

    it('does not retry it, write its status, or record a failure event', () => {
        expect(firstArgs(h.queue.retryFile)).not.toContain(DELETED);
        expect(firstArgs(h.database.updateFileExtractionStatus)).not.toContain(DELETED);
        expect(h.state.events.filter((e) => e.fileId === DELETED)).toEqual([]);
    });

    it('lets the upload queued behind it be claimed next', () => {
        expect(h.state.claims.slice(0, 2)).toEqual([DELETED, LIVE]);
    });
});

describe('worker: failure on a file that still exists', () => {
    it('keeps the normal retry path', () => {
        expect(h.queue.retryFile).toHaveBeenCalledWith(LIVE, h.JOB, 0, 'normal');
        expect(h.database.updateFileExtractionStatus).toHaveBeenCalledWith(
            LIVE, 'pending', null, null, null, null, 'job lookup failed (test stub)'
        );
        expect(h.state.rows.filter((r) => r.fileId === LIVE && r.status === 'queued')).toHaveLength(1);
    });

    it('falls back to the retry path when the existence check itself fails', async () => {
        h.state.jobFiles.add(FLAKY);
        h.state.failExistenceCheck.add(FLAKY);
        h.addRow(FLAKY);

        await settleAfterClaiming(FLAKY);

        expect(h.queue.removeFileFromQueue).not.toHaveBeenCalledWith(FLAKY);
        expect(h.queue.retryFile).toHaveBeenCalledWith(FLAKY, h.JOB, 0, 'normal');
        expect(h.state.rows.filter((r) => r.fileId === FLAKY && r.status === 'queued')).toHaveLength(1);
    });
});
