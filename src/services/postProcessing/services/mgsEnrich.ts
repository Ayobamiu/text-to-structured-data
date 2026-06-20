/**
 * MGS-enrich post-processing service.
 *
 * Migrates the existing ad-hoc `/previews/file/:id/enrich-with-mgs` logic into a
 * framework service: read the record's permit_number, look up MGS data (memoized
 * per permit across the run), and merge it into the record. Output parity with
 * the old route is the goal — same lookup + same mergeMGSData().
 */

// mgsDataService is still JavaScript; import it with the .js extension.
import defaultMgsDataService from '../../mgsDataService.js';
import type { PostProcessingService, RunArgs, RunResult } from '../types.ts';

interface MgsDataServiceLike {
    getMGSDataByPermitNumber: (permit: string) => Promise<Record<string, unknown> | null>;
    mergeMGSData: (record: Record<string, unknown>, data: Record<string, unknown>) => Record<string, unknown>;
}

const mgsEnrich: PostProcessingService = {
    name: 'mgs_enrich',
    version: '1.0.0',
    appliesTo: () => true,

    async run({ record, cache, deps }: RunArgs): Promise<RunResult> {
        const mgs = ((deps && deps.mgsDataService) || defaultMgsDataService) as MgsDataServiceLike;

        // Parity with the legacy route, which read top-level permit_number.
        const permit = record && (record.permit_number as string | undefined);
        if (!permit) {
            return { status: 'skipped', detail: 'no permit_number' };
        }

        const cacheKey = `mgs:${permit}`;
        let mgsData = cache.get(cacheKey) as Record<string, unknown> | null | undefined;
        if (mgsData === undefined) {
            mgsData = await mgs.getMGSDataByPermitNumber(permit);
            cache.set(cacheKey, mgsData);
        }
        if (!mgsData) {
            return { status: 'skipped', detail: `no MGS data for permit ${permit}` };
        }

        return {
            record: mgs.mergeMGSData(record, mgsData),
            status: 'applied',
            detail: `permit ${permit}`,
        };
    },
};

export default mgsEnrich;
