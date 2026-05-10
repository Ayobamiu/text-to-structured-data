/**
 * Page Deduplicator (Phase 1, item #2 / Approach C)
 *
 * Detects duplicate pages within a single PDF using MD5 of the rasterised
 * JPEG bytes. Pure-Node, deterministic, no external libraries.
 *
 * Strategy: byte-hash. pdftoppm is deterministic — the same PDF page
 * rasterised twice produces byte-identical JPEG output. So two pages with
 * the same MD5 are byte-identical at the pixel level. The second occurrence
 * of any signature gets `duplicate_of` pointing at the first occurrence's
 * page_number.
 *
 * What this catches:
 *   ✓ PDF-internal page duplication — the common case in legacy compilation
 *     PDFs that bundle the same lithology legend, location map, or boilerplate
 *     across multiple wells.
 *   ✓ Copy-paste duplication where the same page object is referenced twice
 *     in the PDF.
 *   ✓ Front/back of the same physical sheet when both sides scanned blank.
 *
 * What this does NOT catch:
 *   ✗ Two separate scans of the "same" physical page with even slight
 *     differences (lighting, angle, scanner DPI). Their pixels — and
 *     therefore their JPEGs — won't be byte-identical, so MD5 won't match.
 *     If this becomes a real problem in routing-review corrections, swap
 *     this implementation for a perceptual-hash one (dHash + Hamming
 *     distance < N). The public API stays the same.
 *
 * Why MD5 over a richer perceptual hash today:
 *   - Zero new dependencies (Node built-in `crypto`).
 *   - Trivial to compute (no JPEG decode, no DCT) — milliseconds for a
 *     200-page PDF.
 *   - Essentially zero false positives. MD5 collisions on real-world JPEG
 *     content do not occur in practice.
 *   - The case it misses (visual-near-dupes from re-scanning) is rare in
 *     the user's corpus — pages come from compilation PDFs, not freshly
 *     re-scanned originals.
 */

import crypto from 'crypto';

/**
 * Compute a deduplication signature for a single rasterised page.
 *
 * @param {Buffer} jpegBuffer
 * @returns {string} 32-character lowercase hex MD5
 */
export function computeJpegSignature(jpegBuffer) {
    if (!Buffer.isBuffer(jpegBuffer)) {
        throw new Error('computeJpegSignature requires a Buffer');
    }
    return crypto.createHash('md5').update(jpegBuffer).digest('hex');
}

/**
 * Walk an ordered list of page classifications and assign `duplicate_of` to
 * each. The FIRST page seen for any given signature is the canonical one
 * (`duplicate_of: null`); every subsequent page with the same signature
 * points at that page's `page_number`.
 *
 * Pure function — returns a new array; does not mutate inputs.
 *
 * @param {Array<{ page_number: number, dupe_signature?: string|null }>} pages
 *   Pages must be sorted by page_number (ascending) for "first occurrence
 *   wins" to be meaningful. Pages without a dupe_signature get
 *   `duplicate_of: null` (treat as unique).
 *
 * @returns {Array<typeof pages[number] & { duplicate_of: number | null }>}
 */
export function assignDuplicates(pages) {
    if (!Array.isArray(pages)) {
        throw new Error('assignDuplicates requires an array of pages');
    }

    const firstSeen = new Map(); // signature -> first page_number

    return pages.map((p) => {
        const sig = p.dupe_signature;
        if (!sig) {
            return { ...p, duplicate_of: null };
        }
        const first = firstSeen.get(sig);
        if (first === undefined) {
            firstSeen.set(sig, p.page_number);
            return { ...p, duplicate_of: null };
        }
        return { ...p, duplicate_of: first };
    });
}

/**
 * Convenience: count how many pages are duplicates (i.e. duplicate_of !== null).
 * Useful for telemetry / log lines.
 */
export function countDuplicates(pages) {
    if (!Array.isArray(pages)) return 0;
    let n = 0;
    for (const p of pages) if (p.duplicate_of != null) n++;
    return n;
}

export default {
    computeJpegSignature,
    assignDuplicates,
    countDuplicates,
};
