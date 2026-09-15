import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

// server.js starts the API when it is imported, so its delete handlers can't
// be exercised in isolation. This guards their wiring instead: deleting a job
// file must clear EVERY queue row for it. removeFileFromProcessing only
// deletes 'processing' rows, and a 'queued' row left behind became a ghost the
// worker failed on after every restart.
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

function routeSource(registration: string) {
    const start = source.indexOf(registration);
    expect(start, `${registration} not found in server.js`).toBeGreaterThan(-1);
    const nextRoute = source.indexOf('\napp.', start + registration.length);
    return source.slice(start, nextRoute === -1 ? undefined : nextRoute);
}

describe.each([
    'app.delete("/files/:fileId"',
    'app.delete("/files"',
])('%s', (registration) => {
    it('removes every queue row for the deleted file', () => {
        const handler = routeSource(registration);
        expect(handler).toContain('DELETE FROM job_files');
        expect(handler).toContain('queueService.removeFileFromQueue(fileId)');
        expect(handler).not.toContain('removeFileFromProcessing');
    });
});
