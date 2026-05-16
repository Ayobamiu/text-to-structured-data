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
