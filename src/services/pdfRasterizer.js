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
 * Rasterize a PDF that already lives on disk.
 *
 * Prefer this over `rasterizePdf` whenever the source is remote (S3): the
 * caller can stream bytes straight to a temp file instead of materialising
 * the whole PDF on the heap. pdftoppm reads from a path either way, so the
 * intermediate Buffer buys nothing — on a 183 MB PDF it is the difference
 * between ~0 and 183 MB of heap per call, which is what OOM-killed the
 * container when the page rail requested thumbnails concurrently.
 *
 * @param {string} pdfPath                  Path to an existing PDF file.
 * @param {Object} [options]
 * @param {number} [options.widthPx=768]
 * @param {number} [options.jpegQuality=75]
 * @param {number} [options.firstPage]      1-indexed; default = whole doc start
 * @param {number} [options.lastPage]       1-indexed; default = whole doc end
 * @param {(page: { pageNumber: number, jpeg: Buffer, byteLength: number }) => Promise<void>} [options.onPage]
 *        If supplied, each page is handed over and then dropped, so peak
 *        memory stays at one JPEG rather than the whole document. The
 *        returned array is empty in this mode.
 *
 * @returns {Promise<Array<{ pageNumber: number, jpeg: Buffer, byteLength: number }>>}
 *          Sorted ascending by pageNumber. Empty when `onPage` is used.
 */
export async function rasterizePdfFile(pdfPath, options = {}) {
    const ok = await isRasterizerAvailable();
    if (!ok) {
        throw new Error(
            'pdftoppm is not available on PATH. Install poppler-utils (e.g. `brew install poppler` on macOS, `apt-get install poppler-utils` on Debian/Ubuntu).'
        );
    }

    const opts = { ...DEFAULT_OPTIONS, ...options };
    const { onPage } = opts;

    // Output goes to its own directory so we never re-read the input PDF
    // (or anything else the caller happens to keep next to it).
    const outputDir = makeTempDir();

    try {
        const startedAt = Date.now();
        const filenames = await runPdftoppm(pdfPath, outputDir, opts);
        const renderMs = Date.now() - startedAt;

        if (filenames.length === 0) {
            throw new Error('pdftoppm produced no output pages');
        }

        const pages = [];
        for (const name of filenames) {
            const pageNumber = extractPageNumber(name);
            const filePath = path.join(outputDir, name);
            const jpeg = fs.readFileSync(filePath);
            const page = { pageNumber, jpeg, byteLength: jpeg.length };

            if (onPage) {
                await onPage(page);
                // Release both the buffer and the file as we go: a 400-page
                // document should not cost 400 JPEGs of resident memory.
                fs.rmSync(filePath, { force: true });
            } else {
                pages.push(page);
            }
        }

        // Useful telemetry for classifier callers; not on the return shape
        // because we don't want to leak it into persisted JSON unintentionally.
        console.log(
            `🖼️  rasterized ${filenames.length} page(s) at ${opts.widthPx}px wide, q=${opts.jpegQuality} in ${renderMs}ms (avg ${Math.round(renderMs / filenames.length)}ms/page)`
        );

        return pages;
    } finally {
        cleanupTempDir(outputDir);
    }
}

/**
 * Rasterize a PDF buffer to JPEG buffers, one per page.
 *
 * @param {Buffer} pdfBuffer
 * @param {Object} [options]  Same options as `rasterizePdfFile`.
 *
 * @returns {Promise<Array<{ pageNumber: number, jpeg: Buffer, byteLength: number }>>}
 *          Sorted ascending by pageNumber.
 *
 * Memory note: holds all page JPEGs in memory at once (plus the incoming
 * PDF buffer). For our typical page sizes (~30-80 KB at 768px wide, q=75)
 * and biggest expected PDFs (~200 pages), peak memory is ~6-16 MB.
 * Comfortable for in-pipeline callers that already hold the PDF. Callers
 * fetching from S3 should use `rasterizePdfFile` instead and never build
 * the buffer at all.
 */
export async function rasterizePdf(pdfBuffer, options = {}) {
    if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
        throw new Error('rasterizePdf requires a non-empty Buffer');
    }

    const tempDir = makeTempDir();
    const pdfPath = path.join(tempDir, 'input.pdf');

    try {
        fs.writeFileSync(pdfPath, pdfBuffer);
        return await rasterizePdfFile(pdfPath, options);
    } finally {
        cleanupTempDir(tempDir);
    }
}

export default {
    rasterizePdf,
    rasterizePdfFile,
    isRasterizerAvailable,
};
