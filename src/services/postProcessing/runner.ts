/**
 * Post-processing runner — pure orchestration.
 *
 * Given a list of records and an ordered list of services, runs each enabled
 * service over each record in order, applies record enrichments, collects side
 * effects (rows for side tables), and stamps provenance onto each record's
 * extraction_metadata.post_processing[]. It performs NO database writes — the
 * caller persists updated records + side effects in a transaction. Services do
 * their own (injected, mockable) I/O. This keeps the runner unit-testable.
 *
 * Idempotency: a record already carrying a provenance entry for {name, version}
 * is skipped unless `force` is set. Side tables should additionally upsert by a
 * stable key so re-runs never duplicate rows.
 */

import type {
    PostProcessingService,
    ProvenanceEntry,
    RecordObject,
    ServiceStatus,
    SideEffect,
} from './types.ts';

const PROV_KEY = 'post_processing';

function provenanceList(record: RecordObject): ProvenanceEntry[] {
    const meta = record && record.extraction_metadata;
    return meta && Array.isArray(meta[PROV_KEY]) ? (meta[PROV_KEY] as ProvenanceEntry[]) : [];
}

function alreadyApplied(record: RecordObject, name: string, version: string): boolean {
    return provenanceList(record).some((p) => p && p.name === name && p.version === version);
}

/** Return a new record with a provenance entry appended (does not mutate input). */
function withProvenance(record: RecordObject, entry: ProvenanceEntry): RecordObject {
    const meta = { ...(record.extraction_metadata || {}) };
    meta[PROV_KEY] = [...provenanceList(record), entry];
    return { ...record, extraction_metadata: meta };
}

export interface RunServicesArgs {
    /** records to process (each should carry section_result_id + a slug) */
    records?: RecordObject[];
    /** ordered, already filtered to "enabled" */
    services?: PostProcessingService[];
    /** how to read a record's slug (default: record.slug) */
    slugOf?: (record: RecordObject) => string | null;
    fileId?: string | null;
    /** injected dependencies passed to each service */
    deps?: Record<string, unknown>;
    /** per-service options keyed by service name */
    optionsByService?: Record<string, Record<string, unknown>>;
    /** re-run even if provenance shows it already applied */
    force?: boolean;
}

export type RunSummary = Record<string, Record<ServiceStatus, number>>;

export interface RunServicesResult {
    records: RecordObject[];
    sideEffects: SideEffect[];
    summary: RunSummary;
}

export async function runServices({
    records = [],
    services = [],
    slugOf = (r) => (r ? r.slug ?? null : null),
    fileId = null,
    deps = {},
    optionsByService = {},
    force = false,
}: RunServicesArgs): Promise<RunServicesResult> {
    const cache = new Map<string, unknown>(); // shared across the run for memoizing lookups
    const sideEffects: SideEffect[] = [];
    const summary: RunSummary = {};
    for (const s of services) summary[s.name] = { applied: 0, skipped: 0, error: 0 };

    const outRecords: RecordObject[] = [];
    for (const original of records) {
        let record = original;
        const slug = slugOf(record);

        for (const service of services) {
            const applies = service.appliesTo ? service.appliesTo(slug) : true;
            if (!applies) {
                summary[service.name].skipped++;
                continue;
            }
            if (!force && alreadyApplied(record, service.name, service.version)) {
                summary[service.name].skipped++;
                continue;
            }

            let result;
            try {
                result = await service.run({
                    record,
                    slug,
                    fileId,
                    options: optionsByService[service.name] || {},
                    cache,
                    deps,
                });
            } catch (err) {
                summary[service.name].error++;
                record = withProvenance(record, {
                    name: service.name,
                    version: service.version,
                    status: 'error',
                    detail: err instanceof Error ? err.message : String(err),
                    at: new Date().toISOString(),
                });
                continue;
            }

            const status: ServiceStatus = result && result.status ? result.status : 'skipped';
            if (result && result.record) record = result.record;
            if (result && Array.isArray(result.sideEffects)) {
                for (const se of result.sideEffects) sideEffects.push(se);
            }
            summary[service.name][status] = (summary[service.name][status] || 0) + 1;

            record = withProvenance(record, {
                name: service.name,
                version: service.version,
                status,
                detail: result && result.detail ? result.detail : undefined,
                at: new Date().toISOString(),
            });
        }

        outRecords.push(record);
    }

    return { records: outRecords, sideEffects, summary };
}

export default { runServices };
