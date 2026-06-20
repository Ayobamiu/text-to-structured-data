/**
 * Shared types for the post-processing service framework.
 *
 * A post-processing service is a small, self-contained unit that runs over an
 * extracted record AFTER extraction — to enrich it (e.g. merge external MGS
 * permit data) or derive new data from it (e.g. geocode a location into the
 * record_geocodes table). Services are toggleable per job/slug and run in a
 * defined order by the runner. "Today address, tomorrow something else."
 */

/** A record is an open bag of extracted fields; we only rely on a couple of keys. */
export type RecordObject = Record<string, unknown> & {
    section_result_id?: string;
    slug?: string | null;
    extraction_metadata?: ExtractionMetadata;
};

export interface ExtractionMetadata {
    post_processing?: ProvenanceEntry[];
    [k: string]: unknown;
}

export type ServiceStatus = 'applied' | 'skipped' | 'error';

export interface ProvenanceEntry {
    name: string;
    version: string;
    status: ServiceStatus;
    detail?: string;
    at: string;
}

/** A row destined for a side table. The runner collects these; the caller persists them. */
export interface SideEffect<Row = Record<string, unknown>> {
    table: string;
    row: Row;
}

export interface RunArgs {
    /** The record to process. The service MUST NOT mutate it in place. */
    record: RecordObject;
    slug: string | null;
    /** The owning job_files id (for side-table foreign keys). */
    fileId: string | null;
    /** Per-run options (from config or the backfill request). */
    options: Record<string, unknown>;
    /** Shared across the whole run — memoize external lookups here. */
    cache: Map<string, unknown>;
    /** Injected dependencies (DB pool, http client, sibling services) for testability. */
    deps: Record<string, unknown>;
}

export interface RunResult {
    /** Updated record, when the service enriches the record itself. */
    record?: RecordObject;
    /** Rows destined for side tables (the caller persists them). */
    sideEffects?: SideEffect[];
    status: ServiceStatus;
    /** Human-readable reason (e.g. "no permit_number", "ROOFTOP"). */
    detail?: string;
}

export interface PostProcessingService {
    /** Unique, stable service name (used in config + provenance). */
    name: string;
    /** Semver-ish; bump when behavior changes. Used for idempotency. */
    version: string;
    /** Whether the service runs for a given type. Defaults to all slugs. */
    appliesTo?: (slug: string | null) => boolean;
    /** Process ONE record. */
    run: (args: RunArgs) => Promise<RunResult>;
}
