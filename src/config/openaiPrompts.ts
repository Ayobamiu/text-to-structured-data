/**
 * Central registry of OpenAI chat-completion prompts and response_format
 * payloads. Import from here instead of inlining strings at call sites.
 */

import OpenAI from 'openai';

/** Shared alias — use on every response_format export and builder return. */
export type OpenAIResponseFormat =
    OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'];

// ---------------------------------------------------------------------------
// Document structured extraction (strict json_schema)
// ---------------------------------------------------------------------------

export const DOCUMENT_EXTRACTION_SYSTEM_PROMPT =
    'You are an expert at structured data extraction from documents. ' +
    'Extract data ACCURATELY and EXHAUSTIVELY according to the provided JSON schema. ' +
    'When the source contains repeating structures (tables, lists, rows, line items), ' +
    'you MUST emit one schema item per source row — do not summarise, sample, truncate, ' +
    'or stop early. Iterate through every row top-to-bottom before closing the array. ' +
    'Never invent rows that are not present in the source; if a cell is missing, omit it ' +
    "or use the schema's null-equivalent. Counts in metadata (e.g. total_rows, " +
    'total_items) must match the actual number of items you emitted.';

const DOCUMENT_EXTRACTION_USER_INSTRUCTION =
    'Extract structured data from this document according to the provided schema. ' +
    'Repeat the same emission pattern for EVERY row/item that appears in the source — ' +
    'do not stop after the first few. ' +
    'When in doubt about how many rows the source contains, count <tr>, list items, ' +
    'or line breaks before answering.';

export const DOCUMENT_EXTRACTION_DEFAULT_SCHEMA_NAME = 'data_extraction';

export function buildDocumentExtractionUserContent(text: string): string {
    return `${DOCUMENT_EXTRACTION_USER_INSTRUCTION}\n\nDOCUMENT:\n\n${text}`;
}

export function buildDocumentExtractionMessages(
    text: string
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return [
        { role: 'system', content: DOCUMENT_EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: buildDocumentExtractionUserContent(text) },
    ];
}

export type NormalizedExtractionSchema = {
    schemaName: string;
    schema: Record<string, unknown>;
};

export function normalizeExtractionSchemaData(
    schemaData: unknown
): NormalizedExtractionSchema {
    let parsed: Record<string, unknown> =
        typeof schemaData === 'object' && schemaData !== null
            ? (schemaData as Record<string, unknown>)
            : {};

    if (typeof schemaData === 'string') {
        try {
            parsed = JSON.parse(schemaData) as Record<string, unknown>;
        } catch (parseError) {
            const msg = parseError instanceof Error ? parseError.message : String(parseError);
            throw new Error(`Invalid schema data: ${msg}`);
        }
    }

    let schema = parsed.schema;
    if (typeof schema === 'string') {
        try {
            schema = JSON.parse(schema);
        } catch (parseError) {
            const msg = parseError instanceof Error ? parseError.message : String(parseError);
            throw new Error(`Invalid nested schema: ${msg}`);
        }
    }

    if (!schema || typeof schema !== 'object') {
        throw new Error(
            `Missing schema in processing data. Got: ${JSON.stringify(parsed)}`
        );
    }

    return {
        schemaName:
            (typeof parsed.schemaName === 'string' && parsed.schemaName) ||
            DOCUMENT_EXTRACTION_DEFAULT_SCHEMA_NAME,
        schema: schema as Record<string, unknown>,
    };
}

/**
 * Strict json_schema response_format for document extraction.
 * Schema body comes from the registry / job at runtime.
 */
export function buildStrictJsonSchemaResponseFormat(
    name: string,
    schema: Record<string, unknown>,
    strict = true
): OpenAIResponseFormat {
    const response_format: OpenAIResponseFormat = {
        type: 'json_schema',
        json_schema: {
            name,
            strict,
            schema,
        },
    };
    return response_format;
}

export function buildDocumentExtractionResponseFormat(
    schemaData: unknown
): OpenAIResponseFormat {
    const { schemaName, schema } = normalizeExtractionSchemaData(schemaData);
    return buildStrictJsonSchemaResponseFormat(schemaName, schema, true);
}

// ---------------------------------------------------------------------------
// Visual page classifier (vision + strict json_schema)
// ---------------------------------------------------------------------------

export const PAGE_CLASSIFICATION_RESPONSE_NAME = 'page_classification';

export const PAGE_CLASSIFICATION_PAGE_ROLES = [
    'first',
    'middle',
    'last',
    'standalone',
    'none',
] as const;

export const PAGE_CLASSIFICATION_PAGE_PURPOSES = [
    'data',
    'reference',
    'boilerplate',
    'cover',
    'blank',
    'attachment',
    'unknown',
] as const;

export type RegistryDocumentType = {
    slug: string;
    display_name: string;
    description?: string;
    classifier_hints?: {
        skip_when?: string[];
        keep_when?: string[];
    };
};

const PAGE_CLASSIFICATION_SYSTEM_INTRO = [
    'You are a document-page classifier for a geological/environmental document extraction pipeline.',
    '',
    'You will see ONE page from a multi-page PDF. For each page identify three things:',
    '  1. document_type_slug — which type of document this page belongs to (or "none")',
    '  2. page_role — where the page sits within its section (descriptive metadata)',
    '  3. page_purpose — whether this page actually contributes extractable data',
    '',
    'Available document types:',
];

const PAGE_CLASSIFICATION_SYSTEM_RULES = [
    '  - none: this page does not match any of the above types',
    '',
    'page_role values (descriptive only — do not affect section boundaries):',
    '  - "first": page contains the title block / form header that opens a section.',
    '  - "middle": continuation page of a section.',
    '  - "last": final page of a section (totals, signatures, "End of Report").',
    '  - "standalone": single-page section (form fits on one page).',
    '  - "none": page is "none"-typed.',
    '',
    'page_purpose values (this drives whether the page is extracted):',
    '  - "data": page contains extractable fields, table rows, or measurement values that would be captured into a structured database. Filled-in form values, completed log tables, populated detail records.',
    '  - "reference": reference material identical across all instances of this document type — legends, abbreviation keys, USCS classification charts, lithology pattern guides. No document-specific data.',
    '  - "boilerplate": standardized text not specific to this document — disclaimers, limitations, terms of service, signature blocks, certifications.',
    '  - "cover": title page, section divider, or appendix marker. No extractable fields beyond names/dates already on every other page.',
    '  - "blank": blank page or only header/footer visible.',
    '  - "attachment": map, graph, photograph, or other non-tabular visual that the structured-data extractor cannot process.',
    '  - "unknown": you cannot determine the purpose. Pages classified as document_type_slug="none" should always have page_purpose="unknown".',
    '',
    'Confidence: be conservative. Only score above 0.85 when the page clearly carries a recognisable title block or table header for the chosen document type. Below 0.6 when guessing from layout alone.',
    '',
    'Purpose conservatism: be aggressive about marking pages as non-data. False positives (calling a legend page "data") waste extraction money on pages with no real fields. False negatives (calling a real form "reference") get caught by humans in routing review and are cheaper to fix.',
];

export function buildPageClassificationJsonSchema(
    documentTypes: RegistryDocumentType[]
): Record<string, unknown> {
    const slugEnum = [...documentTypes.map((dt) => dt.slug), 'none'];
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            document_type_slug: {
                type: 'string',
                enum: slugEnum,
                description:
                    'Slug from the registry, or "none" if the page does not match any known type.',
            },
            page_role: {
                type: 'string',
                enum: [...PAGE_CLASSIFICATION_PAGE_ROLES],
                description:
                    'Descriptive: position of this page within its section. Used by the routing-review UI; the section grouper does not split on it.',
            },
            page_purpose: {
                type: 'string',
                enum: [...PAGE_CLASSIFICATION_PAGE_PURPOSES],
                description:
                    'Whether this page contributes extractable data. Drives section.extraction_pages: only "data" pages are extracted.',
            },
            confidence: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                description:
                    'Calibrated confidence in the document_type_slug assignment.',
            },
            reasoning: {
                type: 'string',
                description:
                    'One short sentence explaining the classification (title block visible, table headers, blank, legend, etc.). Keep under 30 words.',
            },
        },
        required: [
            'document_type_slug',
            'page_role',
            'page_purpose',
            'confidence',
            'reasoning',
        ],
    };
}

export function buildPageClassificationResponseFormat(
    documentTypes: RegistryDocumentType[]
): OpenAIResponseFormat {
    return buildStrictJsonSchemaResponseFormat(
        PAGE_CLASSIFICATION_RESPONSE_NAME,
        buildPageClassificationJsonSchema(documentTypes),
        true
    );
}

export function buildPageClassificationSystemPrompt(
    documentTypes: RegistryDocumentType[]
): string {
    const lines = [...PAGE_CLASSIFICATION_SYSTEM_INTRO];
    for (const dt of documentTypes) {
        const desc = dt.description ? ` — ${dt.description}` : '';
        lines.push(`  - ${dt.slug} (${dt.display_name})${desc}`);

        const hints = dt.classifier_hints || {};
        const skipWhen = Array.isArray(hints.skip_when) ? hints.skip_when : [];
        const keepWhen = Array.isArray(hints.keep_when) ? hints.keep_when : [];
        if (skipWhen.length > 0) {
            lines.push(`      Skip rules for ${dt.slug} (override generic guidance below):`);
            for (const rule of skipWhen) lines.push(`        • ${rule}`);
        }
        if (keepWhen.length > 0) {
            lines.push(`      Keep rules for ${dt.slug}:`);
            for (const rule of keepWhen) lines.push(`        • ${rule}`);
        }
    }
    lines.push(...PAGE_CLASSIFICATION_SYSTEM_RULES);
    return lines.join('\n');
}

export function buildPageClassificationUserText(pageNumber: number): string {
    return `Classify page ${pageNumber}.`;
}

type ImageDetail = NonNullable<
    Extract<
        OpenAI.Chat.Completions.ChatCompletionContentPartImage,
        { type: 'image_url' }
    >['image_url']['detail']
>;

export function buildPageClassificationUserContent(
    pageNumber: number,
    dataUrl: string,
    detail: ImageDetail
): OpenAI.Chat.Completions.ChatCompletionContentPart[] {
    return [
        { type: 'text', text: buildPageClassificationUserText(pageNumber) },
        { type: 'image_url', image_url: { url: dataUrl, detail } },
    ];
}

export function buildPageClassificationMessages(
    pageNumber: number,
    dataUrl: string,
    detail: ImageDetail,
    documentTypes: RegistryDocumentType[]
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return [
        {
            role: 'system',
            content: buildPageClassificationSystemPrompt(documentTypes),
        },
        {
            role: 'user',
            content: buildPageClassificationUserContent(pageNumber, dataUrl, detail),
        },
    ];
}

// ---------------------------------------------------------------------------
// Section QA — post-extraction vision review (vision + strict json_schema)
// ---------------------------------------------------------------------------
// Shows the model a section's page image(s) alongside its extraction JSON and
// asks "what's wrong?". Field hints are derived from the active schema so any
// registered document type works without code changes.

export const SECTION_QA_RESPONSE_NAME = 'extraction_qa_review';

export const SECTION_QA_ISSUE_TYPES = [
    'wrong_value',
    'missing_value',
    'extra_value',
    'missing_rows',
    'extra_rows',
    'wrong_count',
    'formatting',
    // Actionable row-level ops — use these instead of missing_rows/extra_rows/
    // wrong_count whenever the specific row and its content/index can be
    // identified. The count-only types remain for when only the count is
    // known to be wrong but the specific row can't be reconstructed.
    'add_row',
    'update_row',
    'delete_row',
] as const;

export const SECTION_QA_SEVERITIES = ['error', 'warning', 'info'] as const;

const SECTION_QA_ISSUE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['field', 'issue_type', 'severity', 'expected', 'actual', 'corrected_value', 'row_index', 'row_value', 'explanation'],
    properties: {
        field: {
            type: 'string',
            description:
                'Dot-path with array indices for scalar issue types. E.g., "lithology_intervals[0].depth_to_ft". EXCEPTION for add_row/update_row/delete_row: use the BARE array path with NO index — e.g. "lithology_intervals", never "lithology_intervals[3]". The row position goes in row_index, not in field.',
        },
        issue_type: {
            type: 'string',
            enum: [...SECTION_QA_ISSUE_TYPES],
        },
        severity: {
            type: 'string',
            enum: [...SECTION_QA_SEVERITIES],
        },
        expected: {
            type: ['string', 'null'],
            description:
                'EVIDENCE, not necessarily the answer: a VERBATIM quote of text visible on the page that shows something is wrong. Never a placeholder like "Unknown"/"N/A"/"Null" or a guess like "1 or more rows". Null only for hallucinated values (issue_type=extra_value). May be a marker/label rather than a literal value — see corrected_value for the actual typed answer.',
        },
        actual: {
            type: ['string', 'null'],
            description:
                'The value actually present in the provided extraction JSON at this field. Null if the JSON field is genuinely null/absent.',
        },
        corrected_value: {
            type: ['string', 'number', 'boolean', 'null'],
            description:
                'THE ANSWER: the value that should replace `actual`, in the EXACT type the schema declares for this field — a boolean field gets the literal true/false, a number field gets a number, a string field gets the correct string. Never a description or the words "Yes"/"No" for a boolean field. Null ONLY when issue_type="extra_value" (remove, do not replace) or for row-level issue types (missing_rows/extra_rows/wrong_count/add_row/update_row/delete_row) — those use row_index/row_value instead.',
        },
        row_index: {
            type: ['integer', 'null'],
            description:
                'Only for delete_row/update_row (required — which array item, 0-indexed) and optionally add_row (insertion position; null means append at the end). Null for every other issue_type.',
        },
        row_value: {
            type: ['string', 'null'],
            description:
                'Only for add_row/update_row: a JSON-ENCODED STRING (use JSON.stringify semantics) of the full row object, using EXACTLY the field names from the array\'s item schema. Only include fields you can actually verify from the page — omit fields you cannot read rather than guessing. Null for every other issue_type, including delete_row.',
        },
        explanation: {
            type: 'string',
            description: 'Why this is an issue. Max 25 words.',
        },
    },
};

// Findings are grouped by top-level schema field-group (e.g.
// "lithology_intervals", "document_metadata") instead of one flat list. This
// keeps the per-call cost the same as a single flat pass (one call, same page
// images) while letting per-group qa_hints priority/ignore guidance organize
// the model's attention — a group marked "critical" gets real scrutiny, a
// "low" priority group (often administrative fields like total_pages) gets a
// glance instead of dominating the findings list.
export const SECTION_QA_RESPONSE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'groups', 'overall_quality'],
    properties: {
        summary: {
            type: 'string',
            description:
                'One sentence: how many issues, what kind. E.g., "2 errors found in lithology depths."',
        },
        groups: {
            type: 'array',
            description:
                'One entry per top-level schema field-group where you found at least one issue. Omit groups with zero issues — do not include empty-issues entries.',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['group', 'issues'],
                properties: {
                    group: {
                        type: 'string',
                        description:
                            'The top-level schema property name this group of issues belongs to (e.g. "lithology_intervals", "site_identification"). Must match a real top-level property in the provided schema.',
                    },
                    issues: {
                        type: 'array',
                        description: 'Discrepancies found within this field-group.',
                        items: SECTION_QA_ISSUE_SCHEMA,
                    },
                },
            },
        },
        overall_quality: {
            type: 'string',
            enum: ['perfect', 'good', 'acceptable', 'poor'],
            description: 'perfect=no issues. good=info/warning only. acceptable=1-2 errors. poor=3+ errors.',
        },
    },
};

export function buildSectionQAResponseFormat(): OpenAIResponseFormat {
    return buildStrictJsonSchemaResponseFormat(
        SECTION_QA_RESPONSE_NAME,
        SECTION_QA_RESPONSE_SCHEMA,
        true
    );
}

// ---------------------------------------------------------------------------
// Per-group Section QA — one call per top-level schema group
// ---------------------------------------------------------------------------
// Instead of reviewing the whole record in one pass (where the model's
// attention spreads thin and large schemas had to be truncated out of the
// prompt), each top-level schema group (lithology_intervals,
// samples_collected, ...) gets its own call carrying that group's FULL
// sub-schema — enums and types always visible, no size guard needed — plus
// the group's extracted data and the page images.

export const GROUP_QA_RESPONSE_NAME = 'extraction_group_qa_review';

// Same issue shape as the whole-record review, minus the groups wrapper —
// each call already IS one group.
export const GROUP_QA_RESPONSE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'issues'],
    properties: {
        summary: {
            type: 'string',
            description: 'One sentence: how many issues in this group, what kind.',
        },
        issues: {
            type: 'array',
            description: 'Discrepancies found within this field-group. Empty array if it is extracted correctly.',
            items: SECTION_QA_ISSUE_SCHEMA,
        },
    },
};

export function buildGroupQAResponseFormat(): OpenAIResponseFormat {
    return buildStrictJsonSchemaResponseFormat(
        GROUP_QA_RESPONSE_NAME,
        GROUP_QA_RESPONSE_SCHEMA,
        true
    );
}

// Prompt-caching layout: OpenAI bills cached input ~10x cheaper when requests
// share an identical token PREFIX. A section's N group calls therefore put
// everything shared FIRST (generic system prompt → full record → page images)
// and the group-specific instruction LAST — calls 2..N pay the cached rate on
// the expensive image tokens instead of full price N times.

/**
 * Generic system prompt shared verbatim by every group call in a section —
 * contains NO group-specific content so the cache prefix stays identical.
 * The group's schema, data, and hints arrive in the trailing user-message
 * part (buildGroupQAGroupInstruction).
 */
export function buildGroupQACachedSystemPrompt(pageCount = 1): string {
    const multi = pageCount > 1;
    const pageWord = multi ? 'pages' : 'page';

    const rowRule = multi
        ? `count rows across ALL ${pageCount} page images before flagging — an array often continues from one page onto the next`
        : `count table rows carefully before flagging`;

    return `You are a document extraction QA reviewer working through ONE extraction record group by group. Each request shows you the full record and the source ${multi ? `${pageCount} page images (in order)` : 'page image'}, then names ONE group to review. Flag only real discrepancies WITHIN the named group.

SCHEMA RULES (violating these makes a finding unusable):
- The named group's schema is given in full at the end of the request. Field names, types, and enum lists in it are authoritative.
- Field paths in findings MUST start with the named group — e.g. "the_group[0].some_field" for array items or "the_group.some_field" for object members.
- When a field declares an enum, corrected_value MUST be EXACTLY one of the enum values, verbatim — never a paraphrase. If the page shows "Water sample" and the enum is ["mw_groundwater", "soil_grab", ...], pick the enum value that MEANS what the page shows (mw_groundwater), never invent "water sample".
- Types are authoritative: boolean fields get literal true/false in corrected_value, number fields get numbers.

HOW TO COMPARE (read carefully — most false reports come from skipping this):
- The extraction is given to you IN FULL. Before flagging any field, read its actual value. If it already holds the correct value, do NOT flag it.
- Every "expected" value MUST be a verbatim quote of text you can actually read on the ${pageWord}. Never invent placeholders ("Unknown", "N/A", "Null") or guesses. If you cannot read a concrete value on the ${pageWord}, do not raise the issue.
- "expected" is EVIDENCE (what the page shows); "corrected_value" is the ANSWER (the exact typed value to store, conforming to the group's schema).
- If a field is blank on the ${pageWord} AND null/empty in the extraction, that is CORRECT — do not flag it.

ROW-LEVEL FIXES (for array groups — use these instead of a vague count complaint whenever you can pin down the specific row):
- CRITICAL: for add_row/update_row/delete_row, "field" is the BARE array path (the group name) with NO index — the row's position goes in row_index.
- delete_row: a SPECIFIC row is fabricated or duplicated with no supporting page content. Set row_index to its 0-indexed position. row_value stays null.
- add_row: a SPECIFIC row is missing and you can read its content from the ${pageWord}. Set row_value to a JSON-encoded string of the row object (exact field names from the group's schema; omit fields you can't verify). row_index = insertion position if determinable, else null (append).
- update_row: an existing row is substantially wrong across multiple fields. Set row_index and row_value (corrected JSON-encoded row).
- Fall back to missing_rows/extra_rows/wrong_count ONLY when the count is wrong but the specific row can't be identified — ${rowRule}.

NOT ERRORS (never flag these):
- Enum/label normalization: "hollow_stem_auger" for "Hollow Stem Auger". Only flag if the MEANING differs.
- Number/unit formatting: 3 and 3.0 are equal; ignore trailing zeros, thousands separators, and unit suffixes when the magnitude matches.
- Date formatting (2024-01-15 vs 01/15/2024): at most "info" severity, never "error".
- Boolean representation: a boolean field's ${pageWord} value is a form label or checkbox ("Yes"/"No", "checked"/blank, "X"). Translate the label to true/false FIRST, then compare — "false" vs "No" is the SAME value.

Output rules:
- If the named group matches the ${pageWord} everywhere, return an empty issues array.
- Do NOT flag fields outside the named group — the rest of the record is context only.
- Be specific: exact field paths with array indices.`;
}

/**
 * Shared leading user-message text — identical across every group call in a
 * section (part of the cached prefix, together with the image parts the
 * caller appends right after it).
 */
export function buildGroupQASharedUserText(
    fullRecord: Record<string, unknown>,
    renderedPages: number[]
): string {
    const pagesNote = renderedPages.length > 1
        ? `pages ${renderedPages.join(', ')}, in order — data may continue across pages`
        : `page ${renderedPages[0] ?? '?'}`;
    return `SOURCE: ${pagesNote}. The image(s) follow this message.

FULL EXTRACTION RECORD (the group to review is named after the images):
${JSON.stringify(fullRecord, null, 2)}`;
}

/**
 * Trailing group-specific instruction — the ONLY part that differs between a
 * section's group calls, so it must stay last in the message content.
 *
 * @param opts.groupName   Top-level schema property name (e.g. "samples_collected")
 * @param opts.groupSchema The sub-schema for that property (object, not string)
 * @param opts.groupValue  The extracted value of that property (undefined = not extracted)
 * @param opts.hint        This group's qa_hints entry (priority/ignore/notes), if any
 */
export function buildGroupQAGroupInstruction(opts: {
    groupName: string;
    groupSchema: unknown;
    groupValue?: unknown;
    hint?: { priority?: string; ignore?: string[]; notes?: string } | null;
}): string {
    const { groupName, groupSchema, groupValue = undefined, hint = null } = opts;

    const hintLines: string[] = [];
    if (hint?.priority) hintLines.push(`- Review priority for this group: ${hint.priority}.`);
    if (Array.isArray(hint?.ignore) && hint.ignore.length > 0) {
        hintLines.push(`- NEVER flag these fields: ${hint.ignore.join(', ')}.`);
    }
    if (hint?.notes) hintLines.push(`- Reviewer guidance: ${hint.notes}`);
    const hintBlock = hintLines.length > 0
        ? `\n\nREVIEWER GUIDANCE FOR THIS GROUP (authoritative):\n${hintLines.join('\n')}`
        : '';

    const groupJson = groupValue === undefined ? 'null (not extracted)' : JSON.stringify(groupValue, null, 2);

    return `REVIEW THIS GROUP NOW: "${groupName}"

THE SCHEMA FOR "${groupName}" (authoritative — field names, types, and enum lists come from here):
${JSON.stringify(groupSchema, null, 2)}

EXTRACTED "${groupName}" (the data under review — same as in the full record above):
${groupJson}

- Field paths in your findings MUST start with "${groupName}".
- For add_row/update_row/delete_row, "field" is the BARE path "${groupName}" — never "${groupName}[3]".${hintBlock}`;
}

/**
 * Turn an extraction JSON Schema into a compact field-path hint block so the
 * model uses EXACT field paths instead of hallucinating names. Walks the
 * top-level `properties`, classifying each as an object (nested `properties`),
 * an array (`items.properties`), or a scalar. Summarizes field names only —
 * never inlines the raw schema — to keep prompt tokens small.
 *
 * @param jsonSchema Active schema (object or JSON string)
 * @returns hint block, or '' when the schema has no usable properties
 */
export function schemaToFieldHints(jsonSchema: unknown): string {
    let schema: any = jsonSchema;
    if (typeof schema === 'string') {
        try { schema = JSON.parse(schema); } catch { return ''; }
    }
    const props = schema?.properties;
    if (!props || typeof props !== 'object') return '';

    const names = (obj: Record<string, unknown>) => Object.keys(obj || {});

    const objectLines: string[] = [];
    const arrayLines: string[] = [];
    const scalars: string[] = [];

    for (const [key, def] of Object.entries(props as Record<string, any>)) {
        if (!def || typeof def !== 'object') { scalars.push(key); continue; }
        const isArray = def.type === 'array' || (!def.type && !!def.items);
        const isObject = def.type === 'object' || (!def.type && !!def.properties && !isArray);

        if (isObject && def.properties) {
            objectLines.push(`    ${key}: ${names(def.properties).join(', ')}`);
        } else if (isArray) {
            const itemProps = def.items?.properties;
            arrayLines.push(
                itemProps
                    ? `    ${key}: each row has ${names(itemProps).join(', ')}`
                    : `    ${key}: array of values`,
            );
        } else {
            scalars.push(key);
        }
    }

    const parts: string[] = [];
    if (objectLines.length) parts.push('  Objects:\n' + objectLines.join('\n'));
    if (arrayLines.length) parts.push('  Arrays (count rows carefully):\n' + arrayLines.join('\n'));
    if (scalars.length) parts.push('  Scalars: ' + scalars.join(', '));
    if (!parts.length) return '';

    return `\nSchema fields (use EXACTLY these field paths in issues):\n${parts.join('\n')}`;
}

// Above this size, inlining the full schema costs more prompt tokens than the
// benefit is worth — fall back to the compact name-only hint block instead.
const MAX_FULL_SCHEMA_PROMPT_CHARS = 6000;

/**
 * Prefer handing the model the REAL JSON schema (types, enums, nullability) so
 * it can tell a boolean field from a text label instead of guessing from field
 * names alone — this is what lets it recognise that a page reading "Yes"/"No"
 * must resolve to a boolean, not a string, before comparing. Falls back to the
 * compact `schemaToFieldHints` block for schemas too large to justify the
 * token cost (e.g. multi-group schemas like borehole_log).
 *
 * @param jsonSchema Active schema (object or JSON string)
 * @returns prompt block, or '' when the schema has no usable properties
 */
export function schemaToPromptBlock(jsonSchema: unknown): string {
    let schema: any = jsonSchema;
    if (typeof schema === 'string') {
        try { schema = JSON.parse(schema); } catch { return ''; }
    }
    if (!schema || typeof schema !== 'object' || !schema.properties) return '';

    const pretty = JSON.stringify(schema, null, 2);
    if (pretty.length <= MAX_FULL_SCHEMA_PROMPT_CHARS) {
        return `\nSchema (types/enums are authoritative — use EXACT field paths, and read each field's declared type before flagging it):\n${pretty}`;
    }
    return schemaToFieldHints(schema);
}

/** Per-field-group QA guidance, keyed by top-level schema property name. See
 * ai/migrations/add_qa_hints_to_document_types.js for the authoritative shape.
 * `skip: true` excludes the group from QA entirely (no call made for it) —
 * use for pipeline-housekeeping groups like extraction_metadata. */
export type QAHints = Record<
    string,
    { priority?: 'critical' | 'high' | 'normal' | 'low'; ignore?: string[]; notes?: string; skip?: boolean }
>;

/**
 * Turn a document type's qa_hints into a prompt block the model uses to
 * prioritize its attention across field-groups instead of treating every
 * field as equally important. Mirrors how classifier_hints (skip_when/
 * keep_when) is spliced into the visual classifier's prompt.
 */
export function buildQAHintsBlock(qaHints: unknown): string {
    let hints: QAHints | null = null;
    if (typeof qaHints === 'string') {
        try { hints = JSON.parse(qaHints); } catch { return ''; }
    } else if (qaHints && typeof qaHints === 'object') {
        hints = qaHints as QAHints;
    }
    if (!hints || typeof hints !== 'object') return '';

    const lines: string[] = [];
    for (const [group, hint] of Object.entries(hints)) {
        if (!hint || typeof hint !== 'object') continue;
        const bits: string[] = [];
        if (hint.priority) bits.push(`priority=${hint.priority}`);
        if (Array.isArray(hint.ignore) && hint.ignore.length > 0) {
            bits.push(`never flag: ${hint.ignore.join(', ')}`);
        }
        if (hint.notes) bits.push(hint.notes);
        if (bits.length > 0) lines.push(`  - ${group}: ${bits.join(' — ')}`);
    }
    if (lines.length === 0) return '';

    return `\n\nPER-GROUP REVIEW PRIORITY (authoritative — set by a human reviewer for this document type):\n${lines.join('\n')}\nSpend real scrutiny on "critical"/"high" groups. "low" priority groups only need a glance — don't let them crowd out issues in higher-priority groups. Never flag fields listed under "never flag" for a group.`;
}

/**
 * System prompt for post-extraction QA. The rules are tuned to suppress the
 * common false-positive classes:
 *   1. claiming a field is null/wrong without reading the provided JSON,
 *   2. no-op findings where page and extraction are both empty,
 *   3. number/unit/date formatting differences,
 *   4. speculative/placeholder "expected" values not quoted from the page,
 *   5. boolean fields compared against yes/no-style page labels as if they
 *      were text mismatches,
 *   6. a genuine finding whose replacement value can't be applied because
 *      "expected" (evidence text) isn't the same shape as the field's real
 *      type — corrected_value carries the typed answer separately.
 *
 * @param opts.schema    Active JSON schema → prompt block (optional)
 * @param opts.pageCount How many page images are attached (default 1)
 * @param opts.qaHints   Per-field-group priority/ignore guidance (optional)
 */
export function buildSectionQASystemPrompt(
    opts: { schema?: unknown; pageCount?: number; qaHints?: unknown } = {}
): string {
    const { schema = null, pageCount = 1, qaHints = null } = opts;
    const fieldHints = schemaToPromptBlock(schema);
    const qaHintsBlock = buildQAHintsBlock(qaHints);
    const multi = pageCount > 1;
    const pageWord = multi ? 'pages' : 'page';

    const inputDesc = multi
        ? `1. ${pageCount} IMAGES — consecutive pages of ONE document section, in order
2. A JSON extraction result produced by an AI from those pages combined`
        : `1. An IMAGE of one page from a PDF document
2. A JSON extraction result produced by an AI from that page`;

    const rowRule = multi
        ? `count rows across ALL ${pageCount} page images before flagging — a single array (e.g. lithology_intervals) often continues from one page onto the next`
        : `count table rows carefully before flagging`;

    return `You are a document extraction QA reviewer. Compare a source document ${multi ? 'section (one or more page images)' : 'page image'} against its structured extraction result and flag only real discrepancies.

You will receive:
${inputDesc}

HOW TO COMPARE (read carefully — most false reports come from skipping this):
- The extraction JSON is given to you IN FULL. Before flagging any field, locate that field in the JSON and read its actual value. Never claim a field is null, missing, or wrong without checking the JSON first — if the JSON already holds the correct value, do NOT flag it.
- Every "expected" value MUST be a verbatim quote of text you can actually read on the ${pageWord}. Never invent placeholders ("Unknown", "N/A", "Null") or guesses ("1 or more rows", "Steel?"). If you cannot read a concrete value on the ${pageWord}, do not raise the issue.
- "actual" MUST be the value really present in the JSON for that field.
- If a field is blank on the ${pageWord} AND null/empty in the extraction, that is CORRECT — do not flag it.
- Do NOT flag an issue where "expected" and "actual" mean the same thing.

CORRECTED VALUE (read this — it is not the same field as "expected"):
- "expected" is EVIDENCE: the verbatim page text that shows something is wrong. It does not have to be a value someone could paste directly into the field — for a derived/boolean field, the evidence is often a marker or note, not the literal word "true"/"false".
- "corrected_value" is the ANSWER: the actual value that should replace "actual", in the EXACT type the schema declares for that field. A boolean field's corrected_value is the JSON literal true or false — never a description, a quote, or the words "Yes"/"No". A number field's corrected_value is a number, not a string with units.
- Example: a boring log's final row has the note "EOB = 68.0 FEET" but the record's \`eob\` field (a boolean) is false. expected="EOB = 68.0 FEET" (what you read), corrected_value=true (the answer) — NOT expected="true", and NOT corrected_value="EOB = 68.0 FEET".
- Set corrected_value to null ONLY when issue_type="extra_value" (the value should be removed, not replaced) or for row-level issue types (below).

ROW-LEVEL FIXES (use these instead of a vague count complaint whenever you can pin down the specific row):
- CRITICAL: for these three types, "field" is the BARE array path with NO index (e.g. "lithology_intervals") — put the row's position in row_index instead, never as "field[3]". This is different from every other issue type, where field DOES include the index.
- delete_row: a SPECIFIC row in the array is fabricated or duplicated with no supporting page content. Set row_index to that row's 0-indexed position. row_value stays null.
- add_row: a SPECIFIC row is missing and you can read its content from the ${pageWord}. Set row_value to a JSON-encoded string of the row object (exact field names from the array's item schema; omit fields you can't verify — do not guess). row_index is the position it belongs at if you can tell (e.g. by depth order), otherwise null (append).
- update_row: an existing row's content is substantially wrong across multiple fields at once. Set row_index to that row and row_value to the corrected JSON-encoded row object.
- Fall back to missing_rows / extra_rows / wrong_count ONLY when you can tell the array's row count is wrong but cannot identify or reconstruct which specific row is at fault (e.g. a table partially obscured by damage). Example: a boring log's array has one row invented from a bare depth tick with no lithology description anywhere near it on the ${pageWord} — that is delete_row with row_index pointing at that row, NOT a vague wrong_count.

NOT ERRORS (never flag these):
- Enum/label normalization: "hollow_stem_auger" for "Hollow Stem Auger". Only flag if the MEANING differs.
- Number/unit formatting: 3 and 3.0 are equal; ignore trailing zeros, thousands separators (1,000 vs 1000), and unit suffixes ("5 ft" vs 5) when the magnitude matches.
- Date formatting (2024-01-15 vs 01/15/2024): at most "info" severity, never "error".
- Boolean representation: if the schema declares a field as boolean, its ${pageWord} value is a form label or checkbox ("Yes"/"No", "checked"/blank, "X"), never literal text. Translate the label to true/false FIRST, then compare against the JSON's true/false — do not flag "false" against "No" (or "true" against "Yes"/"checked") as a mismatch, they are the same value.

FLAG ONLY WHAT YOU CAN VERIFY ON THE ${multi ? 'PAGES' : 'PAGE'}:
- WRONG VALUES: JSON value clearly contradicts what's printed on the ${pageWord}.
- MISSING VALUES: JSON field is null/empty but a concrete value is clearly visible on the ${pageWord}.
- EXTRA VALUES: JSON has a value that is NOT present on the ${pageWord} (hallucination).
- MISSING / EXTRA ROWS: an array has fewer/more items than rows visible — ${rowRule}.

Output rules:
- Organize findings into \`groups\`: one entry per top-level schema field (e.g. "lithology_intervals", "site_identification") where you found at least one issue. Omit any group with zero issues entirely — do not emit an entry with an empty issues array.
- If the extraction matches the ${pageWord} everywhere, return an empty \`groups\` array.
- Be specific: exact field paths with array indices (e.g., "lithology_intervals[2].primary_material").
${fieldHints}${qaHintsBlock}`;
}

/**
 * User-message text for a QA call. Image content parts are appended by the
 * caller (they carry runtime JPEG buffers).
 *
 * @param record           Extraction record (already stripped of internal ids)
 * @param renderedPages     1-indexed page numbers actually attached, in order
 */
export function buildSectionQAUserText(
    record: Record<string, unknown>,
    renderedPages: number[]
): string {
    const json = JSON.stringify(record, null, 2);
    if (renderedPages.length > 1) {
        return `Review this extraction result against the source pages (pages ${renderedPages.join(', ')}, in order). The extraction covers ALL these pages — array rows may continue from one page to the next.\n\nEXTRACTION RESULT:\n${json}`;
    }
    return `Review this extraction result against the source page.\n\nEXTRACTION RESULT:\n${json}`;
}
