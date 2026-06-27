/**
 * Contracts for the NL-query subsystem. These are the boundaries between the
 * independently-testable modules:
 *
 *   catalog      → SlugCatalog            (what's queryable for a slug)
 *   translator   → FilterSpec             (NL + catalog → structured query)
 *   compiler     → CompiledQuery          (FilterSpec + catalog + scope → safe SQL)
 *   formatter    → consumes query rows
 *
 * The model only ever produces a FilterSpec — never SQL.
 */

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'array' | 'object';

export interface CatalogField {
    /** Canonical field name as it appears in the data (or a promoted column name). */
    name: string;
    type: FieldType;
    description?: string;
    /** '_root' or an array section name. */
    section: string;
    /** When set, this field is queryable via a typed promoted column instead of data->>. */
    promotedColumn?: string;
}

export interface CatalogSection {
    key: string;
    kind: 'object' | 'array';
}

export interface SlugCatalog {
    slug: string;
    schemaVersion: number | null;
    sections: CatalogSection[];
    /** Everything queryable: schema fields + the promoted columns. */
    fields: CatalogField[];
    /** The typed promoted columns available on every row of this slug. */
    promotedColumns: string[];
}

export type Op =
    | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
    | 'in' | 'like' | 'ilike' | 'is_null' | 'not_null';

export interface Condition {
    /** A catalog field name or a promoted column name. */
    field: string;
    op: Op;
    /** Omitted for is_null / not_null. Array for `in`. */
    value?: unknown;
}

export interface GeoFilter {
    withinMiles: number;
    lat: number;
    lon: number;
}

export type AggFn = 'count' | 'avg' | 'sum' | 'min' | 'max';

export interface Aggregation {
    fn: AggFn;
    /** Required for avg/sum/min/max; omit for count → count(*). */
    field?: string;
    /** Output column name; defaults to e.g. "count" / "avg_depth_bottom". */
    alias?: string;
}

/** The structured query the translator emits and the compiler consumes. */
export interface FilterSpec {
    slug: string;
    /** Defaults to '_root'. */
    section?: string;
    /** Specific fields to return, or '*'/undefined for the default projection. */
    select?: string[] | '*';
    where?: Condition[];
    geo?: GeoFilter;
    orderBy?: { field: string; dir: 'asc' | 'desc' };
    limit?: number;
    /** Group-by fields (aggregate mode). */
    groupBy?: string[];
    /** Presence flips the query to aggregate mode (rollup). */
    aggregates?: Aggregation[];
}

export interface CompiledQuery {
    sql: string;
    params: unknown[];
}

/** Server-side scope, injected by the compiler — never trusted to the model. */
export interface QueryScope {
    orgId?: string | null;
    jobId?: string | null;
    /** Restrict to specific job_files (data-context scoping, e.g. "talk to file A"). */
    fileIds?: string[] | null;
    /** A preview = a saved list of files; compiled by reference (subquery) so it never drifts. */
    previewId?: string | null;
    /** Restrict to specific records (record_uid) — e.g. "talk to this one record". */
    recordUids?: string[] | null;
    /** Restrict to a section type within the records (e.g. 'lithology_intervals'); default '_root'. */
    sectionKey?: string | null;
}
