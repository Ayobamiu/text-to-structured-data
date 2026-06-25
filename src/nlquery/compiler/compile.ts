/**
 * compiler — FilterSpec → parameterized, scoped, read-only SQL over
 * extracted_records. This is the safety boundary: the model's FilterSpec is
 * untrusted, so every value is bound as a parameter and every field name is
 * resolved against the catalog (unknown fields are rejected). Tenancy scope and
 * a row LIMIT are always injected here, never trusted to the model.
 *
 * Field resolution:
 *   - a promoted column (county, latitude, depth_bottom, …) → the typed column
 *   - any other catalog field                               → (data ->> $key)::cast
 * The JSON key is itself bound as a parameter, so field names can't inject SQL.
 */

import type { FilterSpec, SlugCatalog, CompiledQuery, QueryScope, Condition, FieldType, Op } from '../types.ts';
import { PROMOTED_COLUMNS, toPromotedColumn } from '../promoted.ts';

export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 5000;

const DEFAULT_PROJECTION = [
    'record_label', 'county', 'state', 'latitude', 'longitude',
    'event_date', 'depth_top', 'depth_bottom',
];

const SQL_OP: Record<Exclude<Op, 'in' | 'is_null' | 'not_null'>, string> = {
    eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE',
};

const castFor = (t: FieldType): string =>
    t === 'number' || t === 'integer' ? '::numeric'
        : t === 'boolean' ? '::boolean'
            : t === 'date' ? '::date'
                : ''; // text

export class CompileError extends Error {}

/** Escape LIKE/ILIKE wildcards so a value is matched literally (used for case-insensitive equality). */
const escapeLikeLiteral = (v: unknown): string => String(v).replace(/[\\%_]/g, (m) => `\\${m}`);

/** Coerce a bound value to the resolved field type, so a string "8000" from the
 *  model still binds correctly against a numeric column. */
function coerceValue(type: FieldType, v: unknown): unknown {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map((x) => coerceValue(type, x));
    if (type === 'number' || type === 'integer') {
        const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
        return Number.isFinite(n) ? n : v;
    }
    if (type === 'boolean') {
        if (typeof v === 'boolean') return v;
        const s = String(v).trim().toLowerCase();
        if (['true', '1', 'yes', 'y'].includes(s)) return true;
        if (['false', '0', 'no', 'n'].includes(s)) return false;
        return v;
    }
    if (type === 'date') return String(v);
    return typeof v === 'string' ? v : String(v);
}

/** A small parameter accumulator: p(value) returns its `$n` placeholder. */
class Params {
    readonly values: unknown[] = [];
    p(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}

/**
 * Resolve a field name to a SQL expression. Promoted columns become the typed
 * column; everything else becomes a bound-key data->> access cast to the catalog
 * type. Throws CompileError on an unknown field (the injection / typo guard).
 */
function fieldExpr(field: string, catalog: SlugCatalog, params: Params): { sql: string; type: FieldType } {
    const promoted = toPromotedColumn(field);
    if (promoted && promoted in PROMOTED_COLUMNS) return { sql: promoted, type: PROMOTED_COLUMNS[promoted] }; // validated identifier

    const cf = catalog.fields.find((f) => f.name.toLowerCase() === field.toLowerCase());
    if (!cf) {
        throw new CompileError(`unknown field "${field}" for slug "${catalog.slug}"`);
    }
    if (cf.promotedColumn && cf.promotedColumn in PROMOTED_COLUMNS) {
        return { sql: cf.promotedColumn, type: PROMOTED_COLUMNS[cf.promotedColumn] };
    }
    return { sql: `(data ->> ${params.p(cf.name)})${castFor(cf.type)}`, type: cf.type };
}

function conditionSql(c: Condition, catalog: SlugCatalog, params: Params): string {
    const { sql: expr, type } = fieldExpr(c.field, catalog, params);
    switch (c.op) {
        case 'is_null': return `${expr} IS NULL`;
        case 'not_null': return `${expr} IS NOT NULL`;
        case 'in': {
            if (!Array.isArray(c.value) || c.value.length === 0) {
                throw new CompileError(`"in" on "${c.field}" needs a non-empty array`);
            }
            return `${expr} = ANY(${params.p(coerceValue(type, c.value))})`;
        }
        default: {
            if (c.value === undefined || c.value === null) {
                throw new CompileError(`"${c.op}" on "${c.field}" needs a value`);
            }
            // Text equality is case-insensitive (county "Livingston" must match "LIVINGSTON").
            if (type === 'string' && (c.op === 'eq' || c.op === 'neq')) {
                const like = c.op === 'eq' ? 'ILIKE' : 'NOT ILIKE';
                return `${expr} ${like} ${params.p(escapeLikeLiteral(coerceValue('string', c.value)))} ESCAPE '\\'`;
            }
            const op = SQL_OP[c.op];
            if (!op) throw new CompileError(`unsupported op "${c.op}"`);
            return `${expr} ${op} ${params.p(coerceValue(type, c.value))}`;
        }
    }
}

/** Haversine miles ≤ radius, using the latitude/longitude promoted columns. */
function geoSql(lat: number, lon: number, miles: number, params: Params): string {
    const la = params.p(lat), lo = params.p(lon), mi = params.p(miles);
    return `latitude IS NOT NULL AND longitude IS NOT NULL AND (3958.8 * acos(LEAST(1, GREATEST(-1, ` +
        `cos(radians(${la})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${lo})) + ` +
        `sin(radians(${la})) * sin(radians(latitude)))))) <= ${mi}`;
}

function selectSql(spec: FilterSpec, catalog: SlugCatalog, params: Params): string {
    const fields = (!spec.select || spec.select === '*') ? DEFAULT_PROJECTION : spec.select;
    const cols = ['section_key', 'row_index', 'file_id'];
    for (const f of fields) {
        const { sql } = fieldExpr(f, catalog, params);
        // alias to the field name; quote to keep it a valid identifier
        cols.push(`${sql} AS "${f.toLowerCase().replace(/[^a-z0-9_]/g, '_')}"`);
    }
    cols.push('data');
    return cols.join(', ');
}

export function compile(spec: FilterSpec, catalog: SlugCatalog, scope: QueryScope = {}): CompiledQuery {
    if (spec.slug !== catalog.slug) {
        throw new CompileError(`spec slug "${spec.slug}" != catalog slug "${catalog.slug}"`);
    }
    const params = new Params();
    const section = spec.section || '_root';

    const where: string[] = [
        `slug = ${params.p(spec.slug)}`,
        `section_key = ${params.p(section)}`,
    ];
    // Tenancy scope — always applied when present.
    if (scope.orgId) where.push(`org_id = ${params.p(scope.orgId)}`);
    if (scope.jobId) where.push(`job_id = ${params.p(scope.jobId)}`);

    for (const c of spec.where ?? []) where.push(conditionSql(c, catalog, params));
    if (spec.geo) where.push(geoSql(spec.geo.lat, spec.geo.lon, spec.geo.withinMiles, params));

    const select = selectSql(spec, catalog, params);

    let orderBy = '';
    if (spec.orderBy) {
        const { sql } = fieldExpr(spec.orderBy.field, catalog, params);
        const dir = spec.orderBy.dir === 'desc' ? 'DESC' : 'ASC';
        orderBy = ` ORDER BY ${sql} ${dir} NULLS LAST`;
    }

    const limit = Math.min(spec.limit && spec.limit > 0 ? spec.limit : DEFAULT_LIMIT, MAX_LIMIT);

    const sql = `SELECT ${select} FROM extracted_records WHERE ${where.join(' AND ')}${orderBy} LIMIT ${limit}`;
    return { sql, params: params.values };
}

export default compile;
