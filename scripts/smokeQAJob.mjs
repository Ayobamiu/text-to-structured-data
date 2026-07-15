/**
 * One-shot smoke test for worker-based QA jobs.
 *
 * Enqueues a section-scoped QA job (same call the HTTP endpoint makes),
 * joins the job's socket room like a browser client, and prints every
 * qa-progress-event until the job completes.
 *
 * Usage: node scripts/smokeQAJob.mjs <fileId>
 */
import { io } from 'socket.io-client';

const fileId = process.argv[2];
if (!fileId) {
    console.error('usage: node scripts/smokeQAJob.mjs <fileId>');
    process.exit(1);
}

const { collectQARecords, buildQAMode, getActiveQAJobs } = await import('../src/services/qaJobService.js');
const { default: queueService } = await import('../src/queue.js');

// Only never-QA'd sections: the run is additive (no open findings replaced).
const { file, records } = await collectQARecords({ fileId, scope: 'remaining' });
// Smallest section by page count — cheapest smoke test.
const target = [...records]
    .filter((r) => r.pageNumbers.length > 0)
    .sort((a, b) => a.pageNumbers.length - b.pageNumbers.length)[0];
console.log(`file: ${file.filename} (job ${file.job_id})`);
console.log(`target section: ${target.sectionResultId} (${target.slug}, pages ${target.pageNumbers.join(',')})`);

const active = await getActiveQAJobs(fileId);
if (active.length) {
    console.error('active QA jobs already exist, aborting:', active);
    process.exit(1);
}

const socket = io('http://localhost:3000', { transports: ['websocket', 'polling'] });
socket.on('connect', () => {
    console.log('socket connected, joining job room');
    socket.emit('join-job', file.job_id);
});
socket.on('qa-progress-event', (evt) => {
    const { findings, ...rest } = evt;
    console.log('qa-progress-event:', JSON.stringify({ ...rest, findings: findings ? `[${findings.length} findings]` : undefined }));
    if (evt.fileId === fileId && (evt.status === 'done' || evt.status === 'failed')) {
        console.log('SMOKE-TEST-COMPLETE:', evt.status);
        socket.disconnect();
        process.exit(evt.status === 'done' ? 0 : 1);
    }
});

await new Promise((r) => setTimeout(r, 1500)); // let the socket join first
const mode = buildQAMode({ scope: 'section', sectionResultId: target.sectionResultId });
await queueService.addFileToQueue(fileId, file.job_id, 0, mode);
console.log(`enqueued: mode=${mode}`);

setTimeout(() => {
    console.error('TIMEOUT waiting for QA job to complete');
    process.exit(1);
}, 5 * 60 * 1000);
