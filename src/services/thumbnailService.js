/**
 * Page thumbnail cache.
 *
 * Thumbnails are immutable derived assets: for a given (PDF, page, width,
 * quality) the JPEG never changes. So we render each document once, store the
 * JPEGs in S3, and serve every later request straight from there. The request
 * path never touches the source PDF.
 *
 * This replaces the original design, which downloaded the entire PDF into a
 * heap Buffer on *every* thumbnail request and rasterised a single page from
 * it. On a 183 MB report with a ~360-page rail firing concurrent requests,
 * that allocated multiple GB at once and OOM-killed the container (Railway
 * SIGKILL → 502s that surface in the browser as bogus CORS errors, because an
 * edge 502 carries no Access-Control-Allow-Origin header).
 *
 * Three properties do the real work here:
 *
 *   1. Cache first — steady state is one small S3 GET, zero rendering.
 *   2. Whole-document fill — a miss renders the entire PDF in ONE pdftoppm
 *      pass, not one page. Spawn + parse dominate the cost, so N pages cost
 *      roughly the same as one, and the download happens once instead of N
 *      times. This doubles as the backfill path for already-ingested files.
 *   3. Bounded + deduped — concurrent requests for the same document share a
 *      single in-flight render, and renders are capped globally. A hundred
 *      simultaneous rail requests collapse into one download and one render.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { rasterizePdfFile } from './pdfRasterizer.js';

const THUMBNAIL_PREFIX = 'thumbnails';

// Snap requests onto a ladder. Without this, an arbitrary `?width=` would key
// its own cache entry and trigger a fresh whole-document render — an easy way
// for a client to reintroduce the original problem one pixel at a time.
const WIDTH_LADDER = [128, 256, 512, 1024, 2048];
const QUALITY_LADDER = [60, 75, 90];

// Renders are the expensive, memory-hungry step; keep a hard global ceiling.
const MAX_CONCURRENT_RENDERS = Math.max(1, parseInt(process.env.THUMBNAIL_RENDER_CONCURRENCY, 10) || 2);
// Uploads are tiny but numerous — a little parallelism keeps a 400-page fill
// from taking minutes, without holding many JPEGs at once.
const MAX_CONCURRENT_UPLOADS = Math.max(1, parseInt(process.env.THUMBNAIL_UPLOAD_CONCURRENCY, 10) || 8);

/** Snap a requested value up to the nearest ladder entry (capped at the top). */
function snap(value, ladder, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return ladder.find((step) => step >= n) ?? ladder[ladder.length - 1];
}

/**
 * Normalise the query parameters into the small set of variants we actually
 * cache. Callers should use the returned values for both the cache key and
 * the render, so the two can never disagree.
 */
export function normalizeThumbnailRequest({ width, quality } = {}) {
    return {
        width: snap(width, WIDTH_LADDER, 512),
        quality: snap(quality, QUALITY_LADDER, 75),
    };
}

/**
 * Cache keys hang off the *source S3 key*, not the file id. Upload keys
 * already carry a timestamp + nonce (`..._1784729256501_e5n1vw1ah3m.pdf`), so
 * re-uploading a document lands on a fresh prefix and stale thumbnails can
 * never be served for new content. No invalidation logic required.
 */
function cacheNamespace(sourceS3Key) {
    return crypto.createHash('sha1').update(sourceS3Key).digest('hex').slice(0, 16);
}

export function thumbnailKey(sourceS3Key, pageNumber, width, quality) {
    return `${THUMBNAIL_PREFIX}/${cacheNamespace(sourceS3Key)}/p${pageNumber}_w${width}_q${quality}.jpg`;
}

/**
 * Written once a document is fully rendered at a given variant. Lets a request
 * for an out-of-range page answer 404 immediately instead of re-rendering the
 * whole document every time someone asks for page 9999.
 */
function manifestKey(sourceS3Key, width, quality) {
    return `${THUMBNAIL_PREFIX}/${cacheNamespace(sourceS3Key)}/manifest_w${width}_q${quality}.json`;
}

export async function readThumbnailManifest(s3, sourceS3Key, width, quality) {
    const obj = await s3.getObjectStream(manifestKey(sourceS3Key, width, quality));
    if (!obj) return null;

    try {
        const chunks = [];
        for await (const chunk of obj.body) chunks.push(chunk);
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        // A corrupt manifest should degrade to "not generated yet", never break
        // the request — the worst case is one extra render.
        return null;
    }
}

// ---------------------------------------------------------------------------
// Concurrency control
// ---------------------------------------------------------------------------

let activeRenders = 0;
const renderWaiters = [];

function acquireRenderSlot() {
    if (activeRenders < MAX_CONCURRENT_RENDERS) {
        activeRenders += 1;
        return Promise.resolve();
    }
    return new Promise((resolve) => renderWaiters.push(resolve));
}

function releaseRenderSlot() {
    const next = renderWaiters.shift();
    if (next) {
        next(); // hand the slot straight over; activeRenders stays the same
        return;
    }
    activeRenders -= 1;
}

/** In-flight whole-document fills, keyed by source + variant. */
const inFlight = new Map();

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

async function uploadAllPages(s3, sourceS3Key, width, quality, tempPdfPath) {
    const pending = new Set();
    const errors = [];
    let pageCount = 0;

    const enqueueUpload = (pageNumber, jpeg) => {
        let task;
        task = s3
            .uploadBuffer(
                thumbnailKey(sourceS3Key, pageNumber, width, quality),
                jpeg,
                'image/jpeg',
                { 'source-key-sha1': cacheNamespace(sourceS3Key), page: String(pageNumber) }
            )
            .catch((err) => { errors.push(err); })
            .finally(() => pending.delete(task));
        pending.add(task);
    };

    await rasterizePdfFile(tempPdfPath, {
        widthPx: width,
        jpegQuality: quality,
        onPage: async ({ pageNumber, jpeg }) => {
            // Back-pressure: never let more than N uploads (and therefore N
            // JPEGs) be alive at once.
            while (pending.size >= MAX_CONCURRENT_UPLOADS) {
                await Promise.race(pending);
            }
            pageCount = Math.max(pageCount, pageNumber);
            enqueueUpload(pageNumber, jpeg);
        },
    });

    await Promise.all(pending);
    if (errors.length > 0) {
        throw new Error(`${errors.length} thumbnail upload(s) failed; first: ${errors[0].message}`);
    }

    return pageCount;
}

async function generateWholeDocument(s3, sourceS3Key, width, quality) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coreextract-thumbs-'));
    const tempPdfPath = path.join(tempDir, 'source.pdf');
    const startedAt = Date.now();

    try {
        // Stream to disk — the PDF never lands on the heap.
        await s3.downloadToFile(sourceS3Key, tempPdfPath);

        const pageCount = await uploadAllPages(s3, sourceS3Key, width, quality, tempPdfPath);

        await s3.uploadBuffer(
            manifestKey(sourceS3Key, width, quality),
            Buffer.from(JSON.stringify({
                sourceS3Key,
                width,
                quality,
                pageCount,
                generatedAt: new Date().toISOString(),
            }), 'utf8'),
            'application/json'
        );

        console.log(
            `🗂️  thumbnail cache filled: ${pageCount} page(s) @ w${width} q${quality} for ${sourceS3Key} in ${Date.now() - startedAt}ms`
        );
        return { pageCount };
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (err) {
            console.warn(`⚠️ Failed to clean up thumbnail temp dir ${tempDir}: ${err.message}`);
        }
    }
}

/**
 * Ensure every page of `sourceS3Key` is cached at the given variant.
 *
 * Safe to call concurrently: callers racing on the same document + variant all
 * await the same underlying render. Resolves to `{ pageCount }`.
 *
 * @param {boolean} [opts.force]  Re-render even if a manifest already claims
 *        the document is cached. Used when a page object is missing despite a
 *        manifest (expired by a lifecycle rule, deleted by hand); without it
 *        the manifest short-circuit would make that page 404 forever.
 */
export async function ensureThumbnails(s3, sourceS3Key, { width, quality, force = false }) {
    const dedupeKey = `${sourceS3Key}|${width}|${quality}`;

    const existing = inFlight.get(dedupeKey);
    if (existing) return existing;

    const job = (async () => {
        await acquireRenderSlot();
        try {
            if (!force) {
                // Another request may have finished the fill while we queued
                // for a slot — re-check before paying for a render.
                const manifest = await readThumbnailManifest(s3, sourceS3Key, width, quality);
                if (manifest) return { pageCount: manifest.pageCount };
            }

            return await generateWholeDocument(s3, sourceS3Key, width, quality);
        } finally {
            releaseRenderSlot();
        }
    })().finally(() => inFlight.delete(dedupeKey));

    inFlight.set(dedupeKey, job);
    return job;
}

export default {
    normalizeThumbnailRequest,
    thumbnailKey,
    readThumbnailManifest,
    ensureThumbnails,
};
