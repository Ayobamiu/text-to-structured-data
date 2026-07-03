/**
 * Depth-geometry recovery for borehole-style logs.
 *
 * Problem: on these logs the depth column is a graphical ruler labeled only
 * every 5 ft; samples and lithology contacts are positioned *spatially*
 * against it. Extend's markdown flattens the depth column into one merged
 * rowspan cell, so the only depth numbers that reach the extraction model
 * are the 5-ft gridline labels — depths come out rounded (or dropped).
 *
 * Fix (validated on the BoreDM/Louis pilot log, see the spike repo
 * `borehole-depth-spike/`, branch `spike/borehole-depth-geometry-recovery`):
 * Extend can return word-level OCR geometry. Per page we linear-fit
 * `depth = m*Y + b` from the DEPTH-column tick words (0.00 ft residual on
 * the pilot file), then recover:
 *   - sample/test depths from the sample-id words in the TYPE column, and
 *   - a depth-tagged transcript of the MATERIAL DESCRIPTION column: each line
 *     of description text tagged with the measured depth it sits at
 *     (plus USCS-code positions as secondary evidence; see RecoveredContact).
 *
 * The recovered geometry is NOT fed into the extraction prompt — earlier
 * appendix-injection designs made the extraction model misread the hints
 * under load (see DEPTH_GEOMETRY_HANDOFF.md for the failure history). It is
 * consumed AFTER extraction by depthRefinementService: a focused second-pass
 * model call that reconciles the extracted rows with these measurements via
 * validated operations. Validated accuracy on the pilot: samples exact,
 * layer boundaries within ±0.2 ft of the drawn stratification lines.
 *
 * Everything here FAILS OPEN: if the page has no recognizable ruler the
 * recovery returns nothing and extraction proceeds exactly as before.
 */

export interface OcrWord {
    content?: string;
    pageNumber?: number;
    boundingBox?: { top: number; bottom: number; left: number; right: number };
}

export interface RecoveredSample {
    id: string;
    depth: number;
    page: number;
}

/**
 * A line of the MATERIAL DESCRIPTION column, transcribed at its true measured
 * depth. This is the primary (scalable) lithology signal: rather than pattern-
 * matching USCS codes, we hand the model the description text tagged with the
 * ruler-measured depth of each line and let it aggregate the lines into layers
 * (grouping continuations, dropping legend/boilerplate) itself.
 */
export interface RecoveredLine {
    text: string;
    depth: number;
    page: number;
}

/**
 * Measured position of a USCS group symbol ("(GC)", "(CH)", …). Secondary
 * lithology evidence: blind to un-coded layers (e.g. an "Aggregate Base"
 * surfacing top with no `(XX)` code), so never the primary signal — but it
 * confirms coded-layer tops and is the only lithology signal on formats
 * with no locatable MATERIAL/DESCRIPTION header.
 */
export interface RecoveredContact {
    code: string;
    top: number;
    page: number;
}

export interface DepthGeometry {
    samples: RecoveredSample[];
    /** Primary lithology signal — description lines tagged with measured depth. */
    lithologyLines: RecoveredLine[];
    /** Secondary lithology evidence; see {@link RecoveredContact}. */
    contacts: RecoveredContact[];
    calibrated_pages: number;
}

// Ruler tick labels: 1-3 digit multiples of 5 (5, 10, … 995). The x-band
// around the DEPTH header is the real guard against grabbing other numbers.
const TICK_RE = /^\d{1,3}$/;
const isTick = (s: string): boolean => TICK_RE.test(s) && +s % 5 === 0 && +s > 0;

// Sample/test designators seen in the TYPE column. RS/SPT/RC validated on
// the pilot (ITD) log; SS/ST are the common ASTM split-spoon/Shelby codes.
const SAMPLE_RE = /^(RS|SPT|RC|SS|ST)-?\d+$/i;
const isSampleId = (s: string): boolean => SAMPLE_RE.test(s.replace(/\s/g, ''));

// Header words that mark the wide free-text lithology column. Used to locate
// the description band for the (primary) depth-tagged transcript.
const DESC_HDR_RE = /^(MATERIAL|DESCRIPTION)$/i;

// Description-band geometry (all in OCR pixels):
const HEADER_ROW_PX = 30;       // words within this Y of the desc header = same header row
const MIN_COL_GAP_PX = 40;      // a header word this far from the desc header (by centre) = another column
const COL_EDGE_PAD_PX = 6;      // step just inside a neighbouring header's edge
const DESC_LEFT_PAD_PX = 50;    // fallback left bound when no left-neighbour header exists
const DESC_DEFAULT_WIDTH_PX = 250; // fallback right bound when no right-neighbour header exists
const HEADER_CLEARANCE_PX = 10; // content must sit below the header by this much
const LINE_GROUP_PX = 12;       // words within this Y are the same transcript line
const MIN_LINE_DEPTH_FT = -0.3; // lines above ground surface are header-block text, not log content

// USCS group symbols as printed in material descriptions: "(GC)", "(CH)", …
// (secondary evidence — see RecoveredContact).
const USCS_RE = /^\((GC|GP|GW|GM|SC|SP|SW|SM|CL|CH|ML|MH|OL|OH|PT|RK)\)[,.]?$/;

// A code word within this many pixels (vertically) of a "*contin*" word is a
// "(continued)" carryover label on a page break, not a new layer.
const CONTINUED_WINDOW_PX = 25;

// Column band half-widths around the located header words.
const DEPTH_BAND_PX = 35;
const TYPE_BAND_PX = 45;

interface Word {
    t: string;
    yc: number;
    xc: number;
    /** bounding-box edges — column bounds use x0/x1, line depth uses top */
    x0: number;
    x1: number;
    top: number;
    page: number;
}

interface Tick {
    d: number;
    yc: number;
}

/** Least-squares linear fit depth = m*Y + b over the ruler tick words. */
function fitTicks(ticks: Tick[]): { m: number; b: number } {
    const n = ticks.length;
    const sy = ticks.reduce((a, t) => a + t.yc, 0);
    const sd = ticks.reduce((a, t) => a + t.d, 0);
    const syy = ticks.reduce((a, t) => a + t.yc * t.yc, 0);
    const syd = ticks.reduce((a, t) => a + t.yc * t.d, 0);
    const m = (n * syd - sy * sd) / (n * syy - sy * sy);
    return { m, b: (sd - m * sy) / n };
}

/**
 * Reconstruct the MATERIAL DESCRIPTION column as depth-tagged lines.
 *
 * Locate the description column from its header (MATERIAL/DESCRIPTION), bound it
 * on the right by the nearest neighbouring header (the first lab column), then
 * group the column's words into visual lines and tag each with its measured
 * depth. The model aggregates these lines into layers — no USCS-code matching,
 * so un-coded surfacing/pavement layers survive as their own line.
 *
 * Returns [] (fail open) when the description header isn't found on this page.
 */
function recoverDescriptionLines(W: Word[], depthAt: (y: number) => number, page: number): RecoveredLine[] {
    const descHdrs = W.filter((w) => DESC_HDR_RE.test(w.t));
    if (descHdrs.length === 0) return [];

    const descMinXc = Math.min(...descHdrs.map((w) => w.xc));
    const descMaxXc = Math.max(...descHdrs.map((w) => w.xc));
    const headerYc = descHdrs.reduce((a, w) => a + w.yc, 0) / descHdrs.length;
    const headerRow = W.filter((w) => Math.abs(w.yc - headerYc) < HEADER_ROW_PX);

    // The column spans the whole gap between its neighbouring columns: from
    // the RIGHT EDGE of the nearest header on the left to the LEFT EDGE of
    // the nearest header on the right. Bounding off the desc header's own
    // centre truncated wide columns — the header is centred over the column,
    // but description text starts at the column's left rule (job 9cdfe109:
    // "0.7' Plantmix over 0.4' " was cut off "… Aggregate Base").
    const leftNeighborX1 = headerRow
        .filter((w) => w.xc < descMinXc - MIN_COL_GAP_PX)
        .reduce<number | null>((max, w) => (max == null || w.x1 > max ? w.x1 : max), null);
    const rightNeighborX0 = headerRow
        .filter((w) => w.xc > descMaxXc + MIN_COL_GAP_PX)
        .reduce<number | null>((min, w) => (min == null || w.x0 < min ? w.x0 : min), null);
    const leftBound = leftNeighborX1 != null ? leftNeighborX1 + COL_EDGE_PAD_PX : descMinXc - DESC_LEFT_PAD_PX;
    const rightBound = rightNeighborX0 != null ? rightNeighborX0 - COL_EDGE_PAD_PX : descMaxXc + DESC_DEFAULT_WIDTH_PX;
    const headerBottom = Math.max(...descHdrs.map((w) => w.yc)) + HEADER_CLEARANCE_PX;

    const content = W
        .filter((w) => w.t && w.xc >= leftBound && w.xc <= rightBound && w.yc > headerBottom)
        .sort((a, b) => a.yc - b.yc);

    interface Line { yc: number; words: Word[]; }
    const lines: Line[] = [];
    for (const w of content) {
        const L = lines.find((l) => Math.abs(l.yc - w.yc) < LINE_GROUP_PX);
        if (L) L.words.push(w);
        else lines.push({ yc: w.yc, words: [w] });
    }

    // Depth = the line's TOP edge, not its vertical centre. A description
    // line starts just below its drawn contact, so the top edge is the
    // physically correct anchor — centre-anchoring carried a systematic
    // +0.2 ft bias (measured 10.25/26.22/38.22 vs true 10/26/38 on the
    // pilot; top-edge measures 10.05/26.02/38.01).
    return lines.map((L) => ({
        text: L.words.sort((a, b) => a.xc - b.xc).map((w) => w.t).join(' '),
        depth: depthAt(Math.min(...L.words.map((w) => w.top))),
        page,
    }));
}

/**
 * Is depth-geometry recovery enabled for this job?
 *
 * - env DEPTH_GEOMETRY_RECOVERY=false  → hard off (kill switch)
 * - env DEPTH_GEOMETRY_RECOVERY=true   → on for every job (testing)
 * - otherwise per job:                   processing_config.extraction.options
 *                                        .depthGeometryRecovery === true
 */
export function isDepthGeometryEnabled(jobProcessingConfig: any): boolean {
    const env = (process.env.DEPTH_GEOMETRY_RECOVERY || '').toLowerCase();
    if (env === 'false') return false;
    if (env === 'true') return true;
    return jobProcessingConfig?.extraction?.options?.depthGeometryRecovery === true;
}

/**
 * Recover sample depths + a depth-tagged material-description transcript from
 * Extend OCR words (with USCS-code contacts kept as a dormant fallback).
 *
 * Page numbers in the result are in the extraction response's own numbering
 * (for a page-filtered extraction that is the filtered document's 1..N —
 * same space as extractionResult.pages[].page_number). Use
 * remapGeometryPages() to translate to original PDF page numbers.
 *
 * Returns null when nothing could be calibrated/recovered (fail open).
 */
export function recoverDepthGeometry(ocrWords: OcrWord[] | null | undefined): DepthGeometry | null {
    if (!Array.isArray(ocrWords) || ocrWords.length === 0) return null;

    const words: Word[] = [];
    for (const w of ocrWords) {
        const bb = w?.boundingBox;
        if (!bb || typeof w.pageNumber !== 'number') continue;
        words.push({
            t: (w.content || '').trim(),
            yc: (bb.top + bb.bottom) / 2,
            xc: (bb.left + bb.right) / 2,
            x0: bb.left,
            x1: bb.right,
            top: bb.top,
            page: w.pageNumber,
        });
    }
    if (words.length === 0) return null;

    const pages = [...new Set(words.map((w) => w.page))].sort((a, b) => a - b);
    const samples: RecoveredSample[] = [];
    const lithologyLines: RecoveredLine[] = [];
    const contacts: RecoveredContact[] = [];
    let globalSlope: number | null = null;
    let calibratedPages = 0;

    for (const page of pages) {
        const W = words.filter((w) => w.page === page);
        const depthHdr = W.find((w) => /^DEPTH$/i.test(w.t));
        const typeHdr = W.find((w) => /^TYPE$/i.test(w.t));
        if (!depthHdr) continue; // no ruler header on this page — skip

        let ticks: Tick[] = W
            .filter((w) => isTick(w.t) && Math.abs(w.xc - depthHdr.xc) <= DEPTH_BAND_PX)
            .map((w) => ({ d: +w.t, yc: w.yc }))
            .sort((a, b) => a.yc - b.yc);
        const seen = new Set<number>();
        ticks = ticks.filter((t) => !seen.has(t.d) && !!seen.add(t.d));

        let cal: { m: number; b: number };
        if (ticks.length >= 2) {
            cal = fitTicks(ticks);
            if (globalSlope == null) cal && (globalSlope = cal.m);
        } else if (ticks.length === 1 && globalSlope != null) {
            // Continuation page with a single visible tick: reuse the slope
            // (ft-per-pixel is constant across pages of the same log).
            cal = { m: globalSlope, b: ticks[0].d - globalSlope * ticks[0].yc };
        } else {
            continue; // can't calibrate this page — skip
        }
        calibratedPages++;
        const depthAt = (y: number): number => +(cal.m * y + cal.b).toFixed(1);

        // Sample/test depths: sample-id words inside the TYPE column band.
        if (typeHdr) {
            for (const w of W) {
                if (!isSampleId(w.t) || Math.abs(w.xc - typeHdr.xc) > TYPE_BAND_PX) continue;
                samples.push({ id: w.t.replace(/\s/g, ''), depth: depthAt(w.yc), page });
            }
        }

        // Primary lithology signal: depth-tagged MATERIAL DESCRIPTION transcript.
        lithologyLines.push(...recoverDescriptionLines(W, depthAt, page));

        // Secondary evidence: USCS contact tops, minus "(continued)" labels.
        // Handed to the refinement pass alongside the description lines —
        // useful for confirming coded-layer tops, and the only lithology
        // signal on odd formats where the description header is missing.
        for (const w of W) {
            const m = w.t.match(USCS_RE);
            if (!m) continue;
            const isContinued = W.some(
                (x) => Math.abs(x.yc - w.yc) < CONTINUED_WINDOW_PX && /contin/i.test(x.t)
            );
            if (isContinued) continue;
            contacts.push({ code: m[1], top: depthAt(w.yc), page });
        }
    }

    // Transcript hygiene (lithologyLines arrive in page order here):
    //  - text repeating VERBATIM on a later page is per-page boilerplate (the
    //    "(Stratification lines represent…)" legend) or a page-break
    //    restatement of a continuing layer — keep the first occurrence only
    //    (real "(continued)" carryover lines differ by their suffix and survive);
    //  - lines above the ground surface are header-block text, not log content.
    const seenText = new Map<string, number>();
    const cleanLines = lithologyLines.filter((l) => {
        const key = l.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const firstPage = seenText.get(key);
        if (firstPage != null && firstPage !== l.page) return false;
        seenText.set(key, l.page);
        return l.depth >= MIN_LINE_DEPTH_FT;
    });

    if (calibratedPages === 0 || (samples.length === 0 && cleanLines.length === 0 && contacts.length === 0)) {
        return null; // fail open
    }

    // Document order (page, then vertical position ≈ depth).
    samples.sort((a, b) => a.page - b.page || a.depth - b.depth);
    cleanLines.sort((a, b) => a.page - b.page || a.depth - b.depth);
    contacts.sort((a, b) => a.page - b.page || a.top - b.top);
    return { samples, lithologyLines: cleanLines, contacts, calibrated_pages: calibratedPages };
}

/**
 * Translate geometry page numbers from a page-filtered extraction (1..N of
 * the filtered document) back to original PDF page numbers, mirroring the
 * pageTextMap remap in perSectionExtractor (filtered page i → selectedPages[i-1]).
 * Entries whose page falls outside the mapping are dropped.
 */
export function remapGeometryPages(
    geometry: DepthGeometry,
    selectedPages: number[] | null | undefined
): DepthGeometry {
    if (!geometry || !Array.isArray(selectedPages) || selectedPages.length === 0) return geometry;
    const mapPage = (p: number): number | null =>
        p >= 1 && p <= selectedPages.length ? selectedPages[p - 1] : null;
    return {
        samples: geometry.samples
            .map((s) => ({ ...s, page: mapPage(s.page) }))
            .filter((s): s is RecoveredSample => s.page != null),
        lithologyLines: geometry.lithologyLines
            .map((l) => ({ ...l, page: mapPage(l.page) }))
            .filter((l): l is RecoveredLine => l.page != null),
        contacts: geometry.contacts
            .map((c) => ({ ...c, page: mapPage(c.page) }))
            .filter((c): c is RecoveredContact => c.page != null),
        calibrated_pages: geometry.calibrated_pages,
    };
}

/**
 * Restrict geometry to a set of pages (e.g. a section's extraction_pages).
 * Pass-through when no filter is given. Used to scope the evidence handed to
 * the depth-refinement pass (depthRefinementService).
 */
export function filterGeometryPages(
    geometry: DepthGeometry | null | undefined,
    pages: number[] | null | undefined
): DepthGeometry | null {
    if (!geometry) return null;
    if (!Array.isArray(pages) || pages.length === 0) return geometry;
    const inScope = (p: number): boolean => pages.includes(p);
    return {
        samples: geometry.samples.filter((s) => inScope(s.page)),
        lithologyLines: geometry.lithologyLines.filter((l) => inScope(l.page)),
        contacts: geometry.contacts.filter((c) => inScope(c.page)),
        calibrated_pages: geometry.calibrated_pages,
    };
}
