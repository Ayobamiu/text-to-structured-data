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
] as const;

export const SECTION_QA_SEVERITIES = ['error', 'warning', 'info'] as const;

export const SECTION_QA_RESPONSE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'issues', 'overall_quality'],
    properties: {
        summary: {
            type: 'string',
            description:
                'One sentence: how many issues, what kind. E.g., "2 errors found in lithology depths."',
        },
        issues: {
            type: 'array',
            description:
                'All discrepancies between page image(s) and extraction. Empty array if extraction is correct.',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['field', 'issue_type', 'severity', 'expected', 'actual', 'explanation'],
                properties: {
                    field: {
                        type: 'string',
                        description: 'Dot-path with array indices. E.g., "lithology_intervals[0].depth_to_ft"',
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
                            'A VERBATIM quote of text visible on the page. Never a placeholder like "Unknown"/"N/A"/"Null" or a guess like "1 or more rows". Null only for hallucinated values (issue_type=extra_value).',
                    },
                    actual: {
                        type: ['string', 'null'],
                        description:
                            'The value actually present in the provided extraction JSON at this field. Null if the JSON field is genuinely null/absent.',
                    },
                    explanation: {
                        type: 'string',
                        description: 'Why this is an issue. Max 25 words.',
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

/**
 * System prompt for post-extraction QA. The rules are tuned to suppress the
 * common false-positive classes:
 *   1. claiming a field is null/wrong without reading the provided JSON,
 *   2. no-op findings where page and extraction are both empty,
 *   3. number/unit/date formatting differences,
 *   4. speculative/placeholder "expected" values not quoted from the page.
 *
 * @param opts.schema    Active JSON schema → field hints (optional)
 * @param opts.pageCount How many page images are attached (default 1)
 */
export function buildSectionQASystemPrompt(
    opts: { schema?: unknown; pageCount?: number } = {}
): string {
    const { schema = null, pageCount = 1 } = opts;
    const fieldHints = schemaToFieldHints(schema);
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

NOT ERRORS (never flag these):
- Enum/label normalization: "hollow_stem_auger" for "Hollow Stem Auger". Only flag if the MEANING differs.
- Number/unit formatting: 3 and 3.0 are equal; ignore trailing zeros, thousands separators (1,000 vs 1000), and unit suffixes ("5 ft" vs 5) when the magnitude matches.
- Date formatting (2024-01-15 vs 01/15/2024): at most "info" severity, never "error".

FLAG ONLY WHAT YOU CAN VERIFY ON THE ${multi ? 'PAGES' : 'PAGE'}:
- WRONG VALUES: JSON value clearly contradicts what's printed on the ${pageWord}.
- MISSING VALUES: JSON field is null/empty but a concrete value is clearly visible on the ${pageWord}.
- EXTRA VALUES: JSON has a value that is NOT present on the ${pageWord} (hallucination).
- MISSING / EXTRA ROWS: an array has fewer/more items than rows visible — ${rowRule}.

Output rules:
- If the extraction matches the ${pageWord}, return an empty issues array.
- Be specific: exact field paths with array indices (e.g., "lithology_intervals[2].primary_material").
${fieldHints}`;
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
