/**
 * PDF Rasterizer (Phase 1, item #2)
 *
 * Renders each page of a PDF buffer to a JPEG buffer using pdftoppm
 * (poppler-utils). Used by the visual page classifier to feed page images
 * to a vision model BEFORE any OCR runs — that's the whole point of the
 * classifier-first pipeline: don't OCR pages we'll throw away.
 *
 * Why pdftoppm:
 *   - Already installed in this dev/prod environment (PaddleOCR's
 *     pdf2image is a thin wrapper around it).
 *   - Native binary, fast on 200+ page PDFs.
 *   - Robust on degraded scans where pure-JS renderers (pdfjs-dist) often
 *     produce blank/black pages.
 *
 * If pdftoppm becomes unavailable (different prod image, etc.), swap the
 * implementation here — the public API (`rasterizePdf`) is the only thing
 * callers depend on.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const DEFAULT_OPTIONS = {
    // Width target for the rasterised image. ~768px is a sweet spot for
    // gpt-4o-mini "low" detail vision input: large enough to read title
    // blocks and table headers, small enough that upload time and token
    // cost stay tiny. The classifier's job is type recognition, not
    // OCR-quality reading — we don't need 200 DPI.
    widthPx: 768,
    jpegQuality: 75,
    // First/last page bounds. null = whole document.
    firstPage: null,
    lastPage: null,
};

/**
 * Check whether pdftoppm is available on $PATH. Cached after first call.
 * Useful for the classifier to short-circuit with a clear error rather than
 * letting the spawn fail per page.
 */
let pdftoppmAvailable = null;
export async function isRasterizerAvailable() {
    if (pdftoppmAvailable !== null) return pdftoppmAvailable;
    pdftoppmAvailable = await new Promise((resolve) => {
        const child = spawn('pdftoppm', ['-v']);
        child.on('error', () => resolve(false));
        child.on('exit', (code) => resolve(code === 0 || code === 99)); // -v prints to stderr and exits 99 on some builds
    });
    return pdftoppmAvailable;
}

function makeTempDir() {
    const dir = path.join(
        os.tmpdir(),
        `coreextract-raster-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function cleanupTempDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
        console.warn(`⚠️ Failed to clean up temp dir ${dir}: ${err.message}`);
    }
}

/**
 * Spawn pdftoppm on a written PDF and produce JPEG files into outputDir.
 * Returns the list of output filenames (sorted by page number).
 *
 * pdftoppm flags:
 *   -jpeg              : output JPEG
 *   -jpegopt quality=N : JPEG quality
 *   -scale-to-x WIDTH  : target width in pixels (height auto-scaled)
 *   -scale-to-y -1     : keep aspect ratio (required when -scale-to-x set)
 *   -f / -l            : first / last page (1-indexed)
 *   -r                 : DPI (alternative to -scale-to-x; we use width)
 */
async function runPdftoppm(pdfPath, outputDir, options) {
    const args = [
        '-jpeg',
        '-jpegopt', `quality=${options.jpegQuality}`,
        '-scale-to-x', String(options.widthPx),
        '-scale-to-y', '-1',
    ];
    if (options.firstPage) {
        args.push('-f', String(options.firstPage));
    }
    if (options.lastPage) {
        args.push('-l', String(options.lastPage));
    }
    args.push(pdfPath, path.join(outputDir, 'page'));

    return new Promise((resolve, reject) => {
        const child = spawn('pdftoppm', args);
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`pdftoppm exited with code ${code}. stderr: ${stderr.trim()}`));
                return;
            }
            // Output files are page-1.jpg, page-2.jpg, ... or page-001.jpg
            // depending on poppler version (it pads to width of total pages).
            const files = fs
                .readdirSync(outputDir)
                .filter((n) => n.startsWith('page-') && n.endsWith('.jpg'))
                .sort((a, b) => extractPageNumber(a) - extractPageNumber(b));
            resolve(files);
        });
    });
}

function extractPageNumber(filename) {
    // page-1.jpg / page-001.jpg → 1
    const m = /page-(\d+)\.jpg$/.exec(filename);
    return m ? Number(m[1]) : 0;
}

/**
 * Rasterize a PDF buffer to JPEG buffers, one per page.
 *
 * @param {Buffer} pdfBuffer
 * @param {Object} [options]
 * @param {number} [options.widthPx=768]
 * @param {number} [options.jpegQuality=75]
 * @param {number} [options.firstPage]      1-indexed; default = whole doc start
 * @param {number} [options.lastPage]       1-indexed; default = whole doc end
 *
 * @returns {Promise<Array<{ pageNumber: number, jpeg: Buffer, byteLength: number }>>}
 *          Sorted ascending by pageNumber.
 *
 * Memory note: holds all page JPEGs in memory at once. For our typical
 * page sizes (~30-80 KB at 768px wide, q=75) and biggest expected PDFs
 * (~200 pages), peak memory is ~6-16 MB. Comfortable. If this ever needs
 * to handle 1000+ page PDFs, switch to a streaming/iterator API.
 */
export async function rasterizePdf(pdfBuffer, options = {}) {
    if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
        throw new Error('rasterizePdf requires a non-empty Buffer');
    }

    const ok = await isRasterizerAvailable();
    if (!ok) {
        throw new Error(
            'pdftoppm is not available on PATH. Install poppler-utils (e.g. `brew install poppler` on macOS, `apt-get install poppler-utils` on Debian/Ubuntu).'
        );
    }

    const opts = { ...DEFAULT_OPTIONS, ...options };
    const tempDir = makeTempDir();
    const pdfPath = path.join(tempDir, 'input.pdf');

    try {
        fs.writeFileSync(pdfPath, pdfBuffer);

        const startedAt = Date.now();
        const filenames = await runPdftoppm(pdfPath, tempDir, opts);
        const renderMs = Date.now() - startedAt;

        const pages = filenames.map((name) => {
            const pageNumber = extractPageNumber(name);
            const jpeg = fs.readFileSync(path.join(tempDir, name));
            return { pageNumber, jpeg, byteLength: jpeg.length };
        });

        if (pages.length === 0) {
            throw new Error('pdftoppm produced no output pages');
        }

        // Useful telemetry for classifier callers; not on the return shape
        // because we don't want to leak it into persisted JSON unintentionally.
        console.log(
            `🖼️  rasterized ${pages.length} page(s) at ${opts.widthPx}px wide, q=${opts.jpegQuality} in ${renderMs}ms (avg ${Math.round(renderMs / pages.length)}ms/page)`
        );

        return pages;
    } finally {
        cleanupTempDir(tempDir);
    }
}

export default {
    rasterizePdf,
    isRasterizerAvailable,
};
