/**
 * translator — natural-language question + catalog → FilterSpec (NOT SQL).
 *
 * The model is given the slug's field catalog and a strict output schema, and
 * returns a structured FilterSpec. The compiler (separately tested) turns that
 * into safe SQL. Keeping the model's output to a constrained spec — never raw
 * SQL — is the security boundary.
 *
 * Uses Claude via the official SDK (claude-opus-4-8) with output_config.format
 * so the response is guaranteed to match the FilterSpec shape.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { FilterSpec, SlugCatalog, Op } from '../types.ts';

export const TRANSLATOR_MODEL = 'claude-opus-4-8';

const OPS: Op[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'like', 'ilike', 'is_null', 'not_null'];

/** The strict JSON schema the model must emit (a FilterSpec without slug — we inject slug). */
const FILTER_SPEC_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        section: { type: 'string', description: "'_root' for the record header, or an array-section name." },
        where: {
            type: 'array',
            description: 'Filter conditions, ANDed together.',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    field: { type: 'string', description: 'A field name or promoted column from the catalog.' },
                    op: { type: 'string', enum: OPS },
                    value: {
                        anyOf: [
                            { type: 'string' }, { type: 'number' }, { type: 'boolean' },
                            { type: 'array', items: { type: 'string' } },
                        ],
                        description: 'Omit for is_null/not_null. Array for in. Dates as YYYY-MM-DD.',
                    },
                },
                required: ['field', 'op'],
            },
        },
        geo: {
            type: 'object',
            additionalProperties: false,
            description: 'Set only for "within N miles of LAT, LON" style questions.',
            properties: {
                withinMiles: { type: 'number' },
                lat: { type: 'number' },
                lon: { type: 'number' },
            },
            required: ['withinMiles', 'lat', 'lon'],
        },
        limit: { type: 'integer' },
    },
    required: ['section', 'where'],
} as const;

function catalogText(catalog: SlugCatalog): string {
    const promoted = catalog.fields.filter((f) => f.promotedColumn);
    const byPromoted = new Set(promoted.map((f) => f.name.toLowerCase()));
    const plain = catalog.fields.filter((f) => !byPromoted.has(f.name.toLowerCase()));
    const line = (f: { name: string; type: string; section: string; description?: string }) =>
        `- ${f.name} (${f.type}, section=${f.section})${f.description ? ` — ${f.description}` : ''}`;
    return [
        `Promoted/typed columns (prefer these for filtering; they are fast & typed):`,
        ...promoted.map(line),
        ``,
        `Other fields (queried inside the JSON payload):`,
        ...plain.slice(0, 120).map(line),
    ].join('\n');
}

const SYSTEM = `You translate a natural-language question about geological/environmental records into a structured FilterSpec.

Rules:
- Only use field names that appear in the provided catalog. Never invent fields.
- Prefer promoted/typed columns (county, latitude, longitude, event_date, depth_top, depth_bottom, record_label) when they fit.
- "deeper than N feet" / "total depth over N" → { field: "depth_bottom", op: "gt", value: N }.
- "completed/logged after YEAR" → { field: "event_date", op: "gt", value: "YEAR-01-01" } (dates as YYYY-MM-DD).
- "in <County> County" → { field: "county", op: "eq", value: "<County>" }.
- Free-text contains → use "ilike" with %term% (e.g. lease name containing "smith" → { field:"lease_name", op:"ilike", value:"%smith%" }).
- A yes/no attribute named as a noun/adjective maps to that boolean field = true, NOT a text search. E.g. "injection wells" → { field:"injection_well", op:"eq", value:true }; "H2S present" → { field:"h2s_present", op:"eq", value:true }; "fractured wells" → { field:"fractured", op:"eq", value:true }. Only do this when such a boolean field exists in the catalog.
- "within N miles of LAT, LON" → set geo, not a where condition.
- Default section to "_root" unless the question is clearly about an array section (e.g. lithology, samples, perforations).
- Return ONLY the structured object.`;

export interface TranslateDeps {
    /** Override the model call (for tests). Returns the raw JSON string. */
    complete?: (args: { system: string; user: string; schema: object }) => Promise<string>;
    apiKey?: string;
    model?: string;
}

async function defaultComplete(
    { system, user, schema }: { system: string; user: string; schema: object },
    apiKey: string,
    model: string,
): Promise<string> {
    const client = new Anthropic({ apiKey });
    const res = await client.messages.create({
        model,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: user }],
        // Constrain the response to the FilterSpec shape.
        output_config: { format: { type: 'json_schema', schema } },
    } as Anthropic.MessageCreateParamsNonStreaming);
    const block = res.content.find((b) => b.type === 'text');
    return block && 'text' in block ? block.text : '{}';
}

export async function translate(nl: string, catalog: SlugCatalog, deps: TranslateDeps = {}): Promise<FilterSpec> {
    const model = deps.model ?? TRANSLATOR_MODEL;
    const apiKey = deps.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    const complete = deps.complete ?? ((args) => defaultComplete(args, apiKey, model));

    const user = [
        `Document type: ${catalog.slug}`,
        `Sections: ${catalog.sections.map((s) => `${s.key}(${s.kind})`).join(', ')}`,
        ``,
        catalogText(catalog),
        ``,
        `Question: ${nl}`,
    ].join('\n');

    const raw = await complete({ system: SYSTEM, user, schema: FILTER_SPEC_SCHEMA });

    let parsed: Partial<FilterSpec>;
    try {
        parsed = JSON.parse(raw) as Partial<FilterSpec>;
    } catch {
        throw new Error(`translator: model did not return valid JSON: ${raw.slice(0, 200)}`);
    }

    // Inject the slug server-side — the model never chooses the table.
    return {
        slug: catalog.slug,
        section: parsed.section || '_root',
        where: parsed.where ?? [],
        geo: parsed.geo,
        orderBy: parsed.orderBy,
        limit: parsed.limit,
    };
}

export default translate;
