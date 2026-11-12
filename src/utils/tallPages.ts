/**
 * Tall-page tiling for OCR.
 *
 * Electric / combo well logs are often one continuous strip: the 2026-11-12
 * demo file "DEERE 7A" is a single 565 x 14,378 pt page (~16 ft). OCR treats
 * a page that shape as one chart and returns a caption, so the header (operator,
 * well, API, location, depths) never reaches extraction.
 *
 * tileTallPages() rewrites each strip page as a run of ordinary-shaped pages
 * (tiles, top to bottom, slightly overlapping). The source page is embedded
 * once and drawn offset onto each tile, so a scanned image is not duplicated
 * per tile. mergeTiledExtraction() folds the OCR result back to one entry per
 * source page, so callers keep seeing the page numbering they sent.
 */

import { PDFDocument } from 'pdf-lib';

/** Pages longer than this (long side / short side) get tiled. Legal is 1.65. */
export const TALL_PAGE_ASPECT = 2.0;
/** Target tile shape (long / short), about US Letter. */
export const TILE_ASPECT = 1.3;
/** Upper bound on tiles per page; past it, tiles get taller instead. */
export const MAX_TILES_PER_PAGE = 12;
/** Fraction of a tile repeated at the top of the next, so a cut line can't eat text. */
export const TILE_OVERLAP = 0.05;

export interface TilePlan {
  /** Distance from the top of the page to the top of each tile, in points. */
  offsets: number[];
  /** Length of every tile along the long axis, in points. */
  tileLength: number;
}

/**
 * Where to cut a page of `length` (long axis) by `breadth` (short axis).
 * Returns null when the page is not a strip.
 */
export function planTiles(
  breadth: number,
  length: number,
  opts: { tallAspect?: number; tileAspect?: number; maxTiles?: number; overlap?: number } = {}
): TilePlan | null {
  const tallAspect = opts.tallAspect ?? TALL_PAGE_ASPECT;
  const tileAspect = opts.tileAspect ?? TILE_ASPECT;
  const maxTiles = opts.maxTiles ?? MAX_TILES_PER_PAGE;
  const overlap = opts.overlap ?? TILE_OVERLAP;
  if (!(breadth > 0) || !(length > 0) || length / breadth <= tallAspect) return null;

  let tileLength = breadth * tileAspect;
  // Enough tiles to cover the page with the requested overlap…
  let count = Math.ceil((length - tileLength * overlap) / (tileLength * (1 - overlap)));
  // …but never more than maxTiles: lengthen the tiles instead.
  if (count > maxTiles) {
    count = maxTiles;
    tileLength = length / (count - (count - 1) * overlap);
  }
  if (count <= 1) return null;
  // Spread the tiles evenly so the last one ends exactly at the bottom.
  const step = (length - tileLength) / (count - 1);
  const offsets = Array.from({ length: count }, (_, i) => i * step);
  return { offsets, tileLength };
}

export interface TiledPageInfo {
  /** 1-based page number in the PDF that was passed in. */
  sourcePage: number;
  /** 1-based page numbers of this page's tiles in the output PDF. */
  outputPages: number[];
}

export interface TileResult {
  tiled: boolean;
  buffer: Buffer;
  /** One entry per input page, in order (untiled pages map to one output page). */
  pageMap: TiledPageInfo[];
  /** Input pages that were split. */
  tiledPages: number[];
}

/**
 * Split strip pages into tiles. Returns the input untouched (tiled: false)
 * when no page needs it. Pages with a non-zero /Rotate are left alone.
 */
export async function tileTallPages(pdfBuffer: Buffer): Promise<TileResult> {
  const src = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const pages = src.getPages();

  const plans = pages.map((page) => {
    if (page.getRotation().angle % 360 !== 0) return null;
    const box = page.getCropBox();
    return planTiles(Math.min(box.width, box.height), Math.max(box.width, box.height));
  });

  const identityMap = pages.map((_, i) => ({ sourcePage: i + 1, outputPages: [i + 1] }));
  if (plans.every((p) => p === null)) {
    return { tiled: false, buffer: pdfBuffer, pageMap: identityMap, tiledPages: [] };
  }

  const out = await PDFDocument.create();
  const pageMap: TiledPageInfo[] = [];
  const tiledPages: number[] = [];

  for (let i = 0; i < pages.length; i++) {
    const plan = plans[i];
    const outputPages: number[] = [];
    const page = pages[i];
    const box = page.getCropBox();

    // A page with no content stream cannot be embedded, and has nothing to
    // OCR anyway: copy it as-is.
    // (pdf-lib embeds lazily and would only throw at save(), so check first.)
    let embedded: Awaited<ReturnType<PDFDocument['embedPage']>> | null = null;
    if (plan && page.node.Contents()) {
      // Embed the whole visible page once; every tile draws it shifted so
      // only its window falls inside the tile's MediaBox.
      embedded = await out.embedPage(page, {
        left: box.x,
        bottom: box.y,
        right: box.x + box.width,
        top: box.y + box.height,
      });
    }

    if (!plan || !embedded) {
      const [copied] = await out.copyPages(src, [i]);
      out.addPage(copied);
      outputPages.push(out.getPageCount());
    } else {
      tiledPages.push(i + 1);
      const vertical = box.height >= box.width;
      for (const offset of plan.offsets) {
        if (vertical) {
          const tile = out.addPage([box.width, plan.tileLength]);
          // PDF y grows upward: put (top - offset) of the page at the tile's top edge.
          tile.drawPage(embedded, { x: 0, y: plan.tileLength + offset - box.height });
        } else {
          const tile = out.addPage([plan.tileLength, box.height]);
          tile.drawPage(embedded, { x: -offset, y: 0 });
        }
        outputPages.push(out.getPageCount());
      }
    }
    pageMap.push({ sourcePage: i + 1, outputPages });
  }

  if (tiledPages.length === 0) {
    return { tiled: false, buffer: pdfBuffer, pageMap: identityMap, tiledPages: [] };
  }

  const bytes = await out.save();
  return { tiled: true, buffer: Buffer.from(bytes), pageMap, tiledPages };
}

interface ExtractedPage {
  page_number?: number;
  text?: string;
  [key: string]: unknown;
}

interface OcrWordLike {
  pageNumber?: number;
  [key: string]: unknown;
}

interface ExtractionLike {
  pages?: ExtractedPage[];
  ocrWords?: OcrWordLike[] | null;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Fold an OCR result over the tiled PDF back onto the source pages.
 *
 * - pages: one entry per source page, numbered like the input, tile texts
 *   joined top to bottom.
 * - ocrWords: words on untiled pages are renumbered; words on tiled pages are
 *   dropped (their coordinates are per tile, and depth-geometry recovery
 *   needs one coordinate space per page — it never worked on strips anyway).
 */
export function mergeTiledExtraction<T extends ExtractionLike>(result: T, tiling: TileResult): T {
  if (!tiling.tiled) return result;

  const textByOutputPage = new Map<number, string>();
  for (const page of result.pages || []) {
    if (typeof page?.page_number !== 'number') continue;
    const prev = textByOutputPage.get(page.page_number);
    const text = String(page.text ?? '');
    textByOutputPage.set(page.page_number, prev ? `${prev}\n\n${text}` : text);
  }

  const pages: ExtractedPage[] = tiling.pageMap.map((entry) => ({
    page_number: entry.sourcePage,
    text: entry.outputPages
      .map((n) => textByOutputPage.get(n) || '')
      .filter((t) => t.trim().length > 0)
      .join('\n\n'),
  }));

  const outputToSource = new Map<number, { source: number; tiled: boolean }>();
  for (const entry of tiling.pageMap) {
    const tiled = entry.outputPages.length > 1 || tiling.tiledPages.includes(entry.sourcePage);
    for (const n of entry.outputPages) outputToSource.set(n, { source: entry.sourcePage, tiled });
  }

  let ocrWords = result.ocrWords;
  if (Array.isArray(ocrWords)) {
    ocrWords = ocrWords.flatMap((w) => {
      const hit = typeof w?.pageNumber === 'number' ? outputToSource.get(w.pageNumber) : undefined;
      if (!hit || hit.tiled) return [];
      return [{ ...w, pageNumber: hit.source }];
    });
  }

  return {
    ...result,
    pages,
    ...(Array.isArray(result.ocrWords) ? { ocrWords } : {}),
    metadata: {
      ...(result.metadata || {}),
      total_pages: pages.length,
      tall_page_tiling: {
        tiled_pages: tiling.tiledPages,
        tiles_per_page: Object.fromEntries(
          tiling.pageMap
            .filter((e) => tiling.tiledPages.includes(e.sourcePage))
            .map((e) => [e.sourcePage, e.outputPages.length])
        ),
      },
    },
  };
}
