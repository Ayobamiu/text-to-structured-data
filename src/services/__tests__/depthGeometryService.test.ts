import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    isDepthGeometryEnabled,
    recoverDepthGeometry,
    remapGeometryPages,
    filterGeometryPages,
    type OcrWord,
    type DepthGeometry,
} from '../depthGeometryService.ts';

// ── fixture builders ────────────────────────────────────────────────────────
// Geometry mirrors the validated BoreDM/Louis pilot log ("SH 5 MP 5.9 Slide",
// spike repo borehole-depth-spike/): page-1 ruler ticks 5/10/15 at Y
// 793/1056/1318 fit depth = 0.01904*Y - 10.09, which put RS-1 at 9.2 ft,
// (GC) at 1.3 ft and (CH) at 10.2 ft. The assertions below are those numbers.

function word(content: string, page: number, yc: number, xc: number): OcrWord {
    return {
        content,
        pageNumber: page,
        boundingBox: { top: yc - 5, bottom: yc + 5, left: xc - 15, right: xc + 15 },
    };
}

const DEPTH_X = 155; // DEPTH header + tick column
const TYPE_X = 205;  // TYPE header + sample-id column
const DESC_X = 438;  // material description column (USCS codes)

// Page with a MATERIAL DESCRIPTION header → exercises the primary transcript
// path. Same ruler fit as pilotPage1 (ticks 5/10/15 at Y 793/1056/1318 →
// depth = 0.01905*Y - 10.108). Line depths anchor at the words' TOP edge
// (word() builds top = yc - 5), so lines at yc 583/635/1055 → 0.9/1.9/9.9 ft.
// Neighbour headers bound the column on BOTH sides by their edges:
// LITHOLOGY (xc 366, right edge 381) and LL (xc 980, left edge 965).
// "(GC)" sits inside a description line to prove the transcript is
// preferred over USCS contacts; the word at x 420 (left of the old
// centre-minus-pad bound) proves edge-to-edge coverage.
const MAT_X = 630;
const DESCH_X = 730;
function descPage(): OcrWord[] {
    return [
        word('DEPTH', 1, 460, DEPTH_X),
        word('TYPE', 1, 460, TYPE_X),
        word('5', 1, 793, DEPTH_X),
        word('10', 1, 1056, DEPTH_X),
        word('15', 1, 1318, DEPTH_X),
        word('LITHOLOGY', 1, 460, 366), // left neighbour → left edge of the band
        word('MATERIAL', 1, 460, MAT_X),
        word('DESCRIPTION', 1, 460, DESCH_X),
        word('LL', 1, 460, 980), // right neighbour → right edge of the band
        // un-coded surfacing layer starting at the column's left rule, well
        // left of the MATERIAL header (the job 9cdfe109 truncation case)
        word("0.5'", 1, 583, 420),
        word('Aggregate', 1, 583, 650),
        word('Base', 1, 583, 700),
        // coded layer — "(GC)" rides along in the transcript line
        word('Clayey', 1, 635, 650),
        word('Gravel', 1, 635, 705),
        word('(GC)', 1, 635, 760),
        // deeper layer
        word('Fat', 1, 1055, 650),
        word('Clay', 1, 1055, 690),
    ];
}

function pilotPage1(): OcrWord[] {
    return [
        word('DEPTH', 1, 460, DEPTH_X),
        word('TYPE', 1, 460, TYPE_X),
        word('5', 1, 793, DEPTH_X),
        word('10', 1, 1056, DEPTH_X),
        word('15', 1, 1318, DEPTH_X),
        word('RS-1', 1, 1015.74, TYPE_X),
        word('(GC)', 1, 601, DESC_X),
        word('(CH)', 1, 1068, DESC_X),
    ];
}

function pilotPage2(): OcrWord[] {
    return [
        word('DEPTH', 2, 460, DEPTH_X),
        word('TYPE', 2, 460, TYPE_X),
        // single tick — calibration must reuse page 1's slope
        word('25', 2, 703, DEPTH_X),
        // "(CH) ... (continued)" carryover label at page top → must be filtered
        word('(CH)', 2, 452, DESC_X),
        word('(continued)', 2, 471, DESC_X),
        word('(MH)', 2, 767, DESC_X),
        word('SPT-5', 2, 637.54, TYPE_X),
    ];
}

// ── isDepthGeometryEnabled ──────────────────────────────────────────────────

describe('isDepthGeometryEnabled', () => {
    const ENV = 'DEPTH_GEOMETRY_RECOVERY';
    let saved: string | undefined;
    beforeEach(() => { saved = process.env[ENV]; delete process.env[ENV]; });
    afterEach(() => {
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
    });

    it('is off by default', () => {
        expect(isDepthGeometryEnabled(null)).toBe(false);
        expect(isDepthGeometryEnabled({})).toBe(false);
    });

    it('turns on via job processing_config.extraction.options.depthGeometryRecovery', () => {
        expect(isDepthGeometryEnabled({ extraction: { options: { depthGeometryRecovery: true } } })).toBe(true);
        // must be boolean true, not truthy
        expect(isDepthGeometryEnabled({ extraction: { options: { depthGeometryRecovery: 'true' } } })).toBe(false);
    });

    it('env kill switch wins over job config', () => {
        process.env[ENV] = 'false';
        expect(isDepthGeometryEnabled({ extraction: { options: { depthGeometryRecovery: true } } })).toBe(false);
    });

    it('env force-on enables without job config', () => {
        process.env[ENV] = 'true';
        expect(isDepthGeometryEnabled(null)).toBe(true);
    });
});

// ── recoverDepthGeometry ────────────────────────────────────────────────────

describe('recoverDepthGeometry', () => {
    it('fails open on missing/empty/ruler-less input', () => {
        expect(recoverDepthGeometry(null)).toBeNull();
        expect(recoverDepthGeometry([])).toBeNull();
        // words but no DEPTH header → nothing calibrated
        expect(recoverDepthGeometry([word('hello', 1, 100, 50)])).toBeNull();
        // DEPTH header but <2 ticks and no global slope
        expect(recoverDepthGeometry([word('DEPTH', 1, 460, DEPTH_X), word('5', 1, 793, DEPTH_X)])).toBeNull();
    });

    it('recovers the validated pilot sample + contact depths on page 1', () => {
        const geo = recoverDepthGeometry(pilotPage1());
        expect(geo).not.toBeNull();
        expect(geo!.calibrated_pages).toBe(1);
        expect(geo!.samples).toEqual([{ id: 'RS-1', depth: 9.2, page: 1 }]);
        // no MATERIAL/DESCRIPTION header on this fixture → transcript empty,
        // so the deprecated USCS-contact fallback is what's populated
        expect(geo!.lithologyLines).toEqual([]);
        expect(geo!.contacts).toEqual([
            { code: 'GC', top: 1.3, page: 1 },
            { code: 'CH', top: 10.2, page: 1 },
        ]);
    });

    it('recovers a depth-tagged description transcript (primary lithology path)', () => {
        const geo = recoverDepthGeometry(descPage())!;
        expect(geo.calibrated_pages).toBe(1);
        // one line per material row, depth = the line's TOP edge, in order —
        // full text edge-to-edge (incl. the "0.5'" word left of the header)
        // and the un-coded surfacing layer USCS matching missed
        expect(geo.lithologyLines).toEqual([
            { text: "0.5' Aggregate Base", depth: 0.9, page: 1 },
            { text: 'Clayey Gravel (GC)', depth: 1.9, page: 1 },
            { text: 'Fat Clay', depth: 9.9, page: 1 },
        ]);
        // the USCS "(GC)" is still picked up as secondary-evidence contact
        // (contacts keep centre anchoring: 2.0)
        expect(geo.contacts).toEqual([{ code: 'GC', top: 2, page: 1 }]);
    });

    it('drops cross-page verbatim boilerplate (keep first) and above-surface lines', () => {
        // legend above 0 ft on page 1, repeated verbatim on page 2 in-range;
        // a real layer line is unique per page and survives
        const page2 = [
            word('DEPTH', 2, 460, DEPTH_X),
            word('25', 2, 703, DEPTH_X),
            word('LITHOLOGY', 2, 460, 366),
            word('MATERIAL', 2, 460, MAT_X),
            word('DESCRIPTION', 2, 460, DESCH_X),
            word('LL', 2, 460, 980),
            word('(Stratification', 2, 520, 650),
            word('lines)', 2, 520, 760),
            word('Silty', 2, 700, 650),
            word('Sand', 2, 700, 710),
        ];
        const page1 = [
            ...descPage(),
            word('(Stratification', 1, 490, 650), // depth ≈ -0.87 → above surface
            word('lines)', 1, 490, 760),
        ];
        const geo = recoverDepthGeometry([...page1, ...page2])!;
        const texts = geo.lithologyLines.map((l) => `${l.page}:${l.text}`);
        expect(texts).not.toContain('1:(Stratification lines)'); // above surface
        expect(texts).not.toContain('2:(Stratification lines)'); // verbatim repeat of page 1
        expect(texts).toContain('2:Silty Sand');
    });

    it('reuses the global slope on a single-tick page and filters "(continued)" labels', () => {
        const geo = recoverDepthGeometry([...pilotPage1(), ...pilotPage2()]);
        expect(geo).not.toBeNull();
        expect(geo!.calibrated_pages).toBe(2);
        // the page-2 "(CH) (continued)" carryover must NOT appear as a contact
        const page2Codes = geo!.contacts.filter((c) => c.page === 2).map((c) => c.code);
        expect(page2Codes).toEqual(['MH']);
        // (MH) at Y=767 with slope reuse lands near the true ~26.1-26.2 ft
        const mh = geo!.contacts.find((c) => c.code === 'MH')!;
        expect(mh.top).toBeGreaterThan(25.8);
        expect(mh.top).toBeLessThan(26.5);
        // SPT-5 recovered on the slope-reused page too (true ≈ 23.7)
        const spt5 = geo!.samples.find((s) => s.id === 'SPT-5')!;
        expect(spt5.page).toBe(2);
        expect(spt5.depth).toBeGreaterThan(23.4);
        expect(spt5.depth).toBeLessThan(24.0);
    });

    it('ignores numbers outside the DEPTH column band and non-multiples of 5', () => {
        const words = [
            ...pilotPage1(),
            word('12', 1, 900, DEPTH_X),   // in band but not a multiple of 5 → not a tick
            word('20', 1, 900, DESC_X),    // multiple of 5 but in the description column → not a tick
        ];
        const geo = recoverDepthGeometry(words)!;
        // calibration unchanged → RS-1 still exactly 9.2
        expect(geo.samples[0].depth).toBe(9.2);
    });
});

// ── remapGeometryPages ──────────────────────────────────────────────────────

describe('remapGeometryPages', () => {
    const geo: DepthGeometry = {
        samples: [{ id: 'RS-1', depth: 9.2, page: 1 }, { id: 'SPT-5', depth: 23.7, page: 2 }],
        lithologyLines: [{ text: 'Aggregate Base', depth: 1, page: 1 }, { text: 'Fat Clay', depth: 10, page: 2 }],
        contacts: [{ code: 'GC', top: 1.3, page: 1 }, { code: 'MH', top: 26.2, page: 99 }],
        calibrated_pages: 2,
    };

    it('maps filtered page i to selectedPages[i-1] and drops out-of-range pages', () => {
        const remapped = remapGeometryPages(geo, [4, 7]);
        expect(remapped.samples).toEqual([
            { id: 'RS-1', depth: 9.2, page: 4 },
            { id: 'SPT-5', depth: 23.7, page: 7 },
        ]);
        expect(remapped.lithologyLines).toEqual([
            { text: 'Aggregate Base', depth: 1, page: 4 },
            { text: 'Fat Clay', depth: 10, page: 7 },
        ]);
        // page 99 has no mapping → dropped
        expect(remapped.contacts).toEqual([{ code: 'GC', top: 1.3, page: 4 }]);
    });

    it('is a no-op without selectedPages', () => {
        expect(remapGeometryPages(geo, null)).toBe(geo);
        expect(remapGeometryPages(geo, [])).toBe(geo);
    });
});

// ── filterGeometryPages ─────────────────────────────────────────────────────

describe('filterGeometryPages', () => {
    const geo = recoverDepthGeometry([...pilotPage1(), ...pilotPage2()])!;

    it('scopes all evidence to the given pages (section scoping for refinement)', () => {
        const p2 = filterGeometryPages(geo, [2])!;
        expect(p2.samples.map((s) => s.id)).toEqual(['SPT-5']);
        expect(p2.contacts.map((c) => c.code)).toEqual(['MH']);
        const p42 = filterGeometryPages(geo, [42])!;
        expect(p42.samples).toEqual([]);
        expect(p42.contacts).toEqual([]);
    });

    it('passes through with no filter and fails open on null geometry', () => {
        expect(filterGeometryPages(geo, null)).toBe(geo);
        expect(filterGeometryPages(geo, [])).toBe(geo);
        expect(filterGeometryPages(null, [1])).toBeNull();
    });
});
