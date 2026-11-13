/**
 * catalog — build a SlugCatalog from the active json_schema for a document type.
 *
 * The catalog is what the translator is given as context ("here are the fields you
 * may filter on") and what the compiler validates against. It is derived from the
 * SAME schemas.json_schema that drives extraction, so it never drifts from the data.
 *
 * Section detection mirrors the projector:
 *   - object property            → an object section (its sub-fields, section=key)
 *   - array-of-object property   → an array section  (item sub-fields, section=key)
 *   - scalar top-level property   → a '_root' field
 * Promoted columns are added as first-class queryable fields and any schema field
 * that maps to one is tagged so the compiler routes it to the typed column.
 */

import pool from '../../database.js';
import type { SlugCatalog, CatalogField, CatalogSection, FieldType } from '../types.ts';
import { PROMOTED_COLUMNS, toPromotedColumn } from '../promoted.ts';

interface Queryable {
    query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

interface JsonSchemaNode {
    type?: string | string[];
    properties?: Record<string, JsonSchemaNode>;
    items?: JsonSchemaNode;
    description?: string;
}

/** Pick the meaningful (non-null) JSON type and map it to a FieldType. */
function fieldType(node: JsonSchemaNode): FieldType {
    let t = node.type;
    if (Array.isArray(t)) t = t.find((x) => x !== 'null');
    switch (t) {
        case 'number': return 'number';
        case 'integer': return 'integer';
        case 'boolean': return 'boolean';
        case 'array': return 'array';
        case 'object': return 'object';
        case 'string':
        default: return 'string';
    }
}

const baseType = (node: JsonSchemaNode): string | undefined =>
    Array.isArray(node.type) ? node.type.find((x) => x !== 'null') : node.type;

function tagPromoted(name: string): string | undefined {
    return toPromotedColumn(name) ?? undefined;
}

/** Flatten a schema's properties into sections + fields. */
function parseSchema(jsonSchema: JsonSchemaNode): { sections: CatalogSection[]; fields: CatalogField[] } {
    const sections: CatalogSection[] = [{ key: '_root', kind: 'object' }];
    const fields: CatalogField[] = [];
    const props = jsonSchema.properties ?? {};

    for (const [key, node] of Object.entries(props)) {
        const t = baseType(node);
        if (t === 'object' && node.properties) {
            sections.push({ key, kind: 'object' });
            for (const [sub, subNode] of Object.entries(node.properties)) {
                fields.push({ name: sub, type: fieldType(subNode), description: subNode.description, section: key, promotedColumn: tagPromoted(sub) });
            }
        } else if (t === 'array' && node.items && baseType(node.items) === 'object' && node.items.properties) {
            sections.push({ key, kind: 'array' });
            for (const [sub, subNode] of Object.entries(node.items.properties)) {
                fields.push({ name: sub, type: fieldType(subNode), description: subNode.description, section: key, promotedColumn: tagPromoted(sub) });
            }
        } else {
            // scalar (or array-of-scalars) top-level field → queryable on _root
            fields.push({ name: key, type: fieldType(node), description: node.description, section: '_root', promotedColumn: tagPromoted(key) });
        }
    }
    return { sections, fields };
}

export async function buildCatalog(slug: string, deps: { db?: Queryable } = {}): Promise<SlugCatalog> {
    const db = deps.db ?? (pool as unknown as Queryable);
    const res = await db.query(
        `SELECT s.version, s.json_schema
         FROM document_types dt
         JOIN schemas s ON s.id = dt.current_schema_version_id
         WHERE dt.slug = $1`,
        [slug],
    );
    const row = res.rows[0] as { version: number; json_schema: JsonSchemaNode } | undefined;
    if (!row) throw new Error(`no active schema for slug "${slug}"`);

    const { sections, fields } = parseSchema(row.json_schema);

    // Add the promoted columns as first-class queryable fields (deduped by name).
    const have = new Set(fields.map((f) => f.name.toLowerCase()));
    for (const [name, type] of Object.entries(PROMOTED_COLUMNS)) {
        if (!have.has(name)) {
            fields.push({ name, type, section: '_root', promotedColumn: name });
        }
    }

    return {
        slug,
        schemaVersion: row.version ?? null,
        sections,
        fields,
        promotedColumns: Object.keys(PROMOTED_COLUMNS),
    };
}

export default buildCatalog;
