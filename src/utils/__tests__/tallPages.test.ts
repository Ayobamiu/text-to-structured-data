import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { planTiles, tileTallPages, mergeTiledExtraction, MAX_TILES_PER_PAGE } from '../tallPages.ts';

async function makePdf(sizes: Array<[number, number]>, rotate = 0, blank = false): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const [w, h] of sizes) {
    const page = doc.addPage([w, h]);
    if (!blank) page.drawRectangle({ x: 10, y: h - 40, width: 30, height: 30 });
    if (rotate) page.setRotation({ type: 'degrees', angle: rotate } as never);
  }
  return Buffer.from(await doc.save());
}

describe('planTiles', () => {
  it('leaves ordinary pages alone (letter, legal, landscape)', () => {
    expect(planTiles(612, 792)).toBeNull();
    expect(planTiles(612, 1008)).toBeNull();
    expect(planTiles(612, 1224)).toBeNull(); // exactly 2.0
  });

  it('covers a strip top to bottom with overlapping, equal tiles', () => {
    const plan = planTiles(708, 2707)!; // DAILEY 3-A
    expect(plan.offsets[0]).toBe(0);
    const last = plan.offsets[plan.offsets.length - 1];
    expect(last + plan.tileLength).toBeCloseTo(2707, 6);
    for (let i = 1; i < plan.offsets.length; i++) {
      expect(plan.offsets[i] - plan.offsets[i - 1]).toBeLessThan(plan.tileLength); // overlap
    }
  });

  it('caps the tile count on very long strips by lengthening tiles', () => {
    const plan = planTiles(565.53, 14378.1)!; // DEERE 7A, ~16 ft
    expect(plan.offsets).toHaveLength(MAX_TILES_PER_PAGE);
    expect(plan.offsets[MAX_TILES_PER_PAGE - 1] + plan.tileLength).toBeCloseTo(14378.1, 6);
  });
});

describe('tileTallPages', () => {
  it('returns the same buffer when nothing is tall', async () => {
    const buf = await makePdf([[612, 792], [792, 612]]);
    const r = await tileTallPages(buf);
    expect(r.tiled).toBe(false);
    expect(r.buffer).toBe(buf);
    expect(r.pageMap).toEqual([
      { sourcePage: 1, outputPages: [1] },
      { sourcePage: 2, outputPages: [2] },
    ]);
  });

  it('tiles only the strip and keeps neighbours in order', async () => {
    const r = await tileTallPages(await makePdf([[612, 792], [565, 14378], [612, 792]]));
    expect(r.tiled).toBe(true);
    expect(r.tiledPages).toEqual([2]);
    expect(r.pageMap[0]).toEqual({ sourcePage: 1, outputPages: [1] });
    expect(r.pageMap[1].outputPages).toEqual(Array.from({ length: MAX_TILES_PER_PAGE }, (_, i) => i + 2));
    expect(r.pageMap[2]).toEqual({ sourcePage: 3, outputPages: [MAX_TILES_PER_PAGE + 2] });

    const out = await PDFDocument.load(r.buffer);
    expect(out.getPageCount()).toBe(MAX_TILES_PER_PAGE + 2);
    const tile = out.getPage(1).getSize();
    expect(tile.width).toBeCloseTo(565, 3);
    expect(tile.height / tile.width).toBeLessThan(2.5);
  });

  it('tiles horizontal strips along their width', async () => {
    const r = await tileTallPages(await makePdf([[3000, 600]]));
    const out = await PDFDocument.load(r.buffer);
    expect(r.tiledPages).toEqual([1]);
    const tile = out.getPage(0).getSize();
    expect(tile.height).toBeCloseTo(600, 3);
    expect(tile.width).toBeLessThan(3000);
  });

  it('copies a strip with no content stream instead of throwing', async () => {
    const r = await tileTallPages(await makePdf([[565, 14378]], 0, true));
    expect(r.tiled).toBe(false);
  });

  it('skips rotated pages', async () => {
    const r = await tileTallPages(await makePdf([[565, 14378]], 90));
    expect(r.tiled).toBe(false);
  });
});

describe('mergeTiledExtraction', () => {
  const tiling = {
    tiled: true,
    buffer: Buffer.alloc(0),
    pageMap: [
      { sourcePage: 1, outputPages: [1] },
      { sourcePage: 2, outputPages: [2, 3, 4] },
      { sourcePage: 3, outputPages: [5] },
    ],
    tiledPages: [2],
  };

  it('folds tile pages back to source pages, top to bottom', () => {
    const merged = mergeTiledExtraction(
      {
        success: true,
        pages: [
          { page_number: 1, text: 'cover' },
          { page_number: 2, text: 'LUKE OIL COMPANY  DEERE No. 7A' },
          { page_number: 3, text: '' },
          { page_number: 4, text: 'REPEAT PASS' },
          { page_number: 5, text: 'back' },
        ],
        metadata: { total_pages: 5 },
      },
      tiling
    );
    expect(merged.pages).toEqual([
      { page_number: 1, text: 'cover' },
      { page_number: 2, text: 'LUKE OIL COMPANY  DEERE No. 7A\n\nREPEAT PASS' },
      { page_number: 3, text: 'back' },
    ]);
    expect(merged.metadata).toMatchObject({
      total_pages: 3,
      tall_page_tiling: { tiled_pages: [2], tiles_per_page: { 2: 3 } },
    });
  });

  it('renumbers OCR words on untiled pages and drops them on tiled ones', () => {
    const merged = mergeTiledExtraction(
      {
        pages: [],
        ocrWords: [
          { pageNumber: 1, content: 'a' },
          { pageNumber: 3, content: 'tile' },
          { pageNumber: 5, content: 'b' },
        ],
      },
      tiling
    );
    expect(merged.ocrWords).toEqual([
      { pageNumber: 1, content: 'a' },
      { pageNumber: 3, content: 'b' },
    ]);
  });

  it('is a no-op when nothing was tiled', () => {
    const result = { pages: [{ page_number: 1, text: 'x' }] };
    expect(mergeTiledExtraction(result, { ...tiling, tiled: false })).toBe(result);
  });
});
