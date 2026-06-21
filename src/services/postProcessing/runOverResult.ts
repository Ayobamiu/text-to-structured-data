/**
 * Run config-resolved post-processing services over a single in-memory result
 * envelope (the auto-run path, used by PostProcessingServicesStage during file
 * processing — before the result is even written to job_files).
 *
 * Unlike applyToFiles.ts (the backfill path, which loads stored records by id and
 * targets ONE slug), this works on a freshly-extracted envelope that may contain
 * MULTIPLE slugs, and resolves enabled services PER slug (job override -> slug
 * default). It returns the enriched envelope + collected side effects; it performs
 * NO writes — the caller persists side effects and the merged result.
 *
 * Reuses: resultEnvelope flatten/merge, the runner, and resolvePostProcessing.
 */

import { flattenRecords, inferSlugFromShape } from '../../utils/resultEnvelope.js';
import { runServices, type RunSummary } from './runner.ts';
import { mergeUpdatedRecordsIntoResult } from './applyToFiles.ts';
import { resolvePostProcessing, type ServiceConfigEntry } from './resolvePostProcessing.ts';
import type { PostProcessingService, RecordObject, SideEffect } from './types.ts';

/** Effective slug of a record: its envelope slug, else shape-inferred (V1). */
function effSlug(slug: string | null, record: RecordObject): string | null {
    return slug || inferSlugFromShape(record) || null;
}

export interface RunOverResultArgs {
    /** The extraction result envelope (V1 flat or V2 per-section). */
    result: unknown;
    /** Owning job_files id (for side-table foreign keys). */
    fileId: string | null;
    /** Per-job overrides (jobs.processing_config.postProcessing). */
    jobOverrides?: ServiceConfigEntry[];
    /** Per-document-type defaults, keyed by slug (document_types.post_processing_defaults). */
    slugDefaultsBySlug?: Record<string, ServiceConfigEntry[]>;
    /** Registered services, in run order. */
    registry: PostProcessingService[];
    /** Injected dependencies passed to each service (e.g. googleApiKey). */
    deps?: Record<string, unknown>;
    /** Re-run even if provenance shows already applied. */
    force?: boolean;
}

export interface RunOverResultOut {
    result: unknown;
    sideEffects: SideEffect[];
    summary: RunSummary;
    recordsProcessed: number;
    /** Distinct slugs that had at least one enabled service. */
    slugsRun: string[];
}

export async function runConfiguredServicesOverResult({
    result,
    fileId,
    jobOverrides = [],
    slugDefaultsBySlug = {},
    registry,
    deps = {},
    force = false,
}: RunOverResultArgs): Promise<RunOverResultOut> {
    const out: RunOverResultOut = {
        result,
        sideEffects: [],
        summary: {},
        recordsProcessed: 0,
        slugsRun: [],
    };

    const { records } = flattenRecords(result as object) as {
        isV2: boolean;
        records: Array<{ slug: string | null; index: number; record: RecordObject }>;
    };
    if (records.length === 0) return out;

    // Group records by effective slug so each slug resolves its own enabled set.
    const bySlug = new Map<string, RecordObject[]>();
    for (const r of records) {
        const slug = effSlug(r.slug, r.record) ?? 'untyped';
        if (!bySlug.has(slug)) bySlug.set(slug, []);
        bySlug.get(slug)!.push(r.record);
    }

    const updatedById = new Map<string, RecordObject>();
    let updatedV1: RecordObject | undefined;

    for (const [slug, slugRecords] of bySlug) {
        const realSlug = slug === 'untyped' ? null : slug;
        const { services, optionsByService } = resolvePostProcessing({
            slug: realSlug,
            slugDefaults: slugDefaultsBySlug[slug],
            jobOverrides,
            registry,
        });
        if (services.length === 0) continue;

        out.slugsRun.push(slug);
        const run = await runServices({
            records: slugRecords,
            services,
            slugOf: () => realSlug,
            fileId,
            optionsByService,
            deps,
            force,
        });

        out.recordsProcessed += slugRecords.length;
        for (const se of run.sideEffects) out.sideEffects.push(se);
        mergeSummary(out.summary, run.summary);

        for (const rec of run.records) {
            if (rec.section_result_id) updatedById.set(rec.section_result_id, rec);
            else updatedV1 = rec; // V1 single-record envelope
        }
    }

    if (updatedById.size > 0 || updatedV1) {
        const { result: newResult } = mergeUpdatedRecordsIntoResult(result, updatedById, updatedV1);
        out.result = newResult;
    }

    return out;
}

/** Merge two run summaries (accumulate counts per service/status). */
function mergeSummary(into: RunSummary, add: RunSummary): void {
    for (const [name, counts] of Object.entries(add)) {
        into[name] = into[name] || { applied: 0, skipped: 0, error: 0 };
        for (const [status, n] of Object.entries(counts)) {
            into[name][status as keyof typeof counts] += n;
        }
    }
}

export default { runConfiguredServicesOverResult };
