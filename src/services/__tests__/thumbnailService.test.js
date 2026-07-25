import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';
import {
    normalizeThumbnailRequest,
    thumbnailKey,
    readThumbnailManifest,
    ensureThumbnails,
} from '../thumbnailService.js';

// Stand-in for S3Service. Backed by an in-memory map so tests never touch the
// network, and counts downloads so we can assert the storm actually collapses.
function makeFakeS3({ pageCount = 5, downloadDelayMs = 10 } = {}) {
    const store = new Map();
    const fake = {
        downloads: 0,
        store,
        async downloadToFile(key, dest) {
            fake.downloads += 1;
            await new Promise((r) => setTimeout(r, downloadDelayMs));
            return 1024;
        },
        async uploadBuffer(key, body) {
            store.set(key, Buffer.from(body));
            return key;
        },
        async getObjectStream(key) {
            if (!store.has(key)) return null;
            const b = store.get(key);
            return { body: Readable.from([b]), contentLength: b.length, etag: '"e"' };
        },
    };
    return fake;
}

// Rasterising is exercised for real elsewhere; here we only care about cache
// and concurrency behaviour, so keep it fast and deterministic.
vi.mock('../pdfRasterizer.js', () => ({
    rasterizePdfFile: vi.fn(async (pdfPath, options) => {
        for (let p = 1; p <= 5; p++) {
            await options.onPage({ pageNumber: p, jpeg: Buffer.from([0xff, 0xd8, p]), byteLength: 3 });
        }
        return [];
    }),
}));

const SOURCE = 'jobs/j1/report_1784729256501_e5n1vw1ah3m.pdf';
const VARIANT = { width: 128, quality: 75 };

describe('normalizeThumbnailRequest', () => {
    it('snaps the rail width (120) up to the nearest cached variant', () => {
        expect(normalizeThumbnailRequest({ width: 120 }).width).toBe(128);
    });

    it('snaps arbitrary widths onto the ladder so each one cannot trigger its own render', () => {
        expect(normalizeThumbnailRequest({ width: 481 }).width).toBe(512);
        expect(normalizeThumbnailRequest({ width: 129 }).width).toBe(256);
    });

    it('caps oversized requests instead of rendering at absurd sizes', () => {
        expect(normalizeThumbnailRequest({ width: 99999 }).width).toBe(2048);
    });

    it('falls back to defaults for missing or junk input', () => {
        expect(normalizeThumbnailRequest({})).toEqual({ width: 512, quality: 75 });
        expect(normalizeThumbnailRequest({ width: 'abc', quality: 'x' })).toEqual({ width: 512, quality: 75 });
    });
});

describe('thumbnailKey', () => {
    it('produces a stable, variant-scoped key', () => {
        expect(thumbnailKey(SOURCE, 7, 128, 75)).toMatch(/^thumbnails\/[0-9a-f]{16}\/p7_w128_q75\.jpg$/);
        expect(thumbnailKey(SOURCE, 7, 128, 75)).toBe(thumbnailKey(SOURCE, 7, 128, 75));
    });

    it('namespaces by source key so a re-uploaded PDF can never serve stale thumbnails', () => {
        const a = thumbnailKey('jobs/j1/report_111_aaa.pdf', 1, 128, 75);
        const b = thumbnailKey('jobs/j1/report_222_bbb.pdf', 1, 128, 75);
        expect(a).not.toBe(b);
    });

    it('separates variants', () => {
        expect(thumbnailKey(SOURCE, 1, 128, 75)).not.toBe(thumbnailKey(SOURCE, 1, 512, 75));
    });
});

describe('ensureThumbnails', () => {
    it('collapses a concurrent request storm into a single download and render', async () => {
        const s3 = makeFakeS3();

        const results = await Promise.all(
            Array.from({ length: 50 }, () => ensureThumbnails(s3, SOURCE, VARIANT))
        );

        // This is the regression that OOM-killed production: 50 concurrent rail
        // requests must not each pull the source PDF.
        expect(s3.downloads).toBe(1);
        expect(new Set(results.map((r) => r.pageCount)).size).toBe(1);
        expect(results[0].pageCount).toBe(5);
    });

    it('caches every page plus a manifest', async () => {
        const s3 = makeFakeS3();
        await ensureThumbnails(s3, SOURCE, VARIANT);

        for (let p = 1; p <= 5; p++) {
            expect(s3.store.has(thumbnailKey(SOURCE, p, 128, 75))).toBe(true);
        }
        const manifest = await readThumbnailManifest(s3, SOURCE, 128, 75);
        expect(manifest.pageCount).toBe(5);
        expect(manifest.sourceS3Key).toBe(SOURCE);
    });

    it('does not re-render once the manifest exists', async () => {
        const s3 = makeFakeS3();
        await ensureThumbnails(s3, SOURCE, VARIANT);
        expect(s3.downloads).toBe(1);

        await ensureThumbnails(s3, SOURCE, VARIANT);
        expect(s3.downloads).toBe(1);
    });

    it('rebuilds when forced, so a lost cache entry cannot 404 forever', async () => {
        const s3 = makeFakeS3();
        await ensureThumbnails(s3, SOURCE, VARIANT);
        expect(s3.downloads).toBe(1);

        // Simulate an object vanishing (lifecycle expiry / manual delete) while
        // the manifest survives. Without `force` the manifest short-circuits
        // and that page would never come back.
        s3.store.delete(thumbnailKey(SOURCE, 3, 128, 75));

        await ensureThumbnails(s3, SOURCE, { ...VARIANT, force: true });
        expect(s3.downloads).toBe(2);
        expect(s3.store.has(thumbnailKey(SOURCE, 3, 128, 75))).toBe(true);
    });

    it('renders separately per variant', async () => {
        const s3 = makeFakeS3();
        await ensureThumbnails(s3, SOURCE, { width: 128, quality: 75 });
        await ensureThumbnails(s3, SOURCE, { width: 512, quality: 75 });
        expect(s3.downloads).toBe(2);
    });

    it('releases the in-flight entry on failure so a later request can retry', async () => {
        const s3 = makeFakeS3();
        s3.downloadToFile = vi.fn().mockRejectedValueOnce(new Error('S3 down'));

        await expect(ensureThumbnails(s3, SOURCE, VARIANT)).rejects.toThrow('S3 down');

        // A failed fill must not poison the cache for subsequent callers.
        const retryS3 = makeFakeS3();
        await expect(ensureThumbnails(retryS3, SOURCE, VARIANT)).resolves.toEqual({ pageCount: 5 });
    });

    it('returns a null manifest rather than throwing when nothing is cached', async () => {
        const s3 = makeFakeS3();
        expect(await readThumbnailManifest(s3, 'jobs/j1/never_seen.pdf', 128, 75)).toBeNull();
    });
});
