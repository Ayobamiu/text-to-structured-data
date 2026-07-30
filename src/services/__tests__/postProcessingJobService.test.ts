import { describe, it, expect } from 'vitest';
import {
    buildPsvcMode,
    parsePsvcMode,
    emptyApplyResult,
    mergeApplyResults,
} from '../postProcessingJobService.ts';

describe('psvc mode strings', () => {
    it('round-trips a request id', () => {
        const id = 'b3f1c0de-0000-4000-8000-000000000001';
        expect(parsePsvcMode(buildPsvcMode(id))).toBe(id);
    });

    it('ignores other queue modes', () => {
        expect(parsePsvcMode('sreex')).toBeNull();
        expect(parsePsvcMode('rex:abc')).toBeNull();
        expect(parsePsvcMode('qa:file')).toBeNull();
        expect(parsePsvcMode('both')).toBeNull();
        expect(parsePsvcMode('psvc:')).toBeNull();
        expect(parsePsvcMode(null)).toBeNull();
        expect(parsePsvcMode(42)).toBeNull();
    });
});

describe('mergeApplyResults', () => {
    const fileA = {
        apply: true,
        filesScanned: 1,
        filesUpdated: 1,
        recordsMatched: 3,
        sideEffects: 3,
        summary: { geocodeLocations: { applied: 2, skipped: 1, error: 0 } },
        precisionTiers: { rooftop: 2, approximate: 1 },
    };
    const fileB = {
        apply: true,
        filesScanned: 1,
        filesUpdated: 0,
        recordsMatched: 2,
        sideEffects: 0,
        summary: { geocodeLocations: { applied: 0, skipped: 1, error: 1 } },
        precisionTiers: { rooftop: 1 },
    };

    it('accumulates counters, per-service statuses and precision tiers', () => {
        const acc = mergeApplyResults(mergeApplyResults(emptyApplyResult(true), fileA), fileB);
        expect(acc.filesScanned).toBe(2);
        expect(acc.filesUpdated).toBe(1);
        expect(acc.recordsMatched).toBe(5);
        expect(acc.sideEffects).toBe(3);
        expect(acc.summary.geocodeLocations).toEqual({ applied: 2, skipped: 2, error: 1 });
        expect(acc.precisionTiers).toEqual({ rooftop: 3, approximate: 1 });
    });

    it('does not mutate either input (the accumulator is re-read per file)', () => {
        const acc = emptyApplyResult(true);
        mergeApplyResults(acc, fileA);
        expect(acc.filesScanned).toBe(0);
        expect(acc.summary).toEqual({});
        expect(fileA.summary.geocodeLocations).toEqual({ applied: 2, skipped: 1, error: 0 });
    });

    it('picks up a service seen for the first time mid-run', () => {
        const acc = mergeApplyResults(emptyApplyResult(false), fileA);
        const withNew = mergeApplyResults(acc, {
            ...fileB,
            summary: { mgsEnrich: { applied: 4, skipped: 0, error: 0 } },
        });
        expect(withNew.summary.geocodeLocations).toEqual({ applied: 2, skipped: 1, error: 0 });
        expect(withNew.summary.mgsEnrich).toEqual({ applied: 4, skipped: 0, error: 0 });
    });

    it('keeps the accumulator apply flag, not the incoming file result', () => {
        const acc = mergeApplyResults(emptyApplyResult(false), { ...fileA, apply: true });
        expect(acc.apply).toBe(false);
    });
});
