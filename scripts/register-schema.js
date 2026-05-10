#!/usr/bin/env node
/**
 * register-schema.js — CLI to seed the schema registry
 *
 * Usage:
 *   node ai/scripts/register-schema.js \
 *     --slug boring_log \
 *     --display-name "Boring Log" \
 *     --schema /absolute/path/to/schema.json \
 *     [--description "..."] \
 *     [--default-extractor extendai] \
 *     [--routing-confidence 0.8] \
 *     [--draft]
 *
 * The --schema file may be in either of two shapes:
 *   1. A wrapper object: { "schemaName": "...", "schema": {...} }
 *      — same shape that's stored in jobs.schema_data today.
 *   2. A raw OpenAI-strict JSON Schema body (top-level "type", "properties").
 *
 * Behaviour:
 *   - Extracts x-system-role / x-guidelines / x-validators from the schema
 *     root into prompt_hints.system_role / .guidelines / .validators.
 *   - Walks the schema tree and pulls x-locators / x-rules / x-instructions
 *     / x-date-formats out from per-property nodes into
 *     prompt_hints.field_hints[<schema_path>] — the schema body stored in
 *     `schemas.json_schema` is left clean (free of x-* keys).
 *   - Registers the document_type if it doesn't exist (idempotent on slug).
 *   - Inserts a new schema version. By default this becomes the current
 *     active version for the document_type. Pass --draft to register the
 *     version without promoting it.
 *
 * No existing data is modified. Existing jobs.schema_data on jobs continues
 * to be the source of truth for today's pipeline; the registry runs in
 * parallel until Phase 1 wires it into the worker.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { extractHintsAndClean } from '../src/utils/schemaHintsExtract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = next;
            i++;
        }
    }
    return args;
}

function usage() {
    console.error(
        [
            'Usage: node ai/scripts/register-schema.js \\',
            '  --slug <document_type_slug> \\',
            '  --display-name "<Display Name>" \\',
            '  --schema /path/to/schema.json \\',
            '  [--description "..."] \\',
            '  [--default-extractor extendai] \\',
            '  [--routing-confidence 0.8] \\',
            '  [--draft]',
        ].join('\n')
    );
}

async function main() {
    const args = parseArgs(process.argv);

    if (args.help) {
        usage();
        process.exit(0);
    }
    if (!args.slug || !args['display-name'] || !args.schema) {
        usage();
        process.exit(2);
    }

    const schemaPath = path.resolve(args.schema);
    if (!fs.existsSync(schemaPath)) {
        console.error(`❌ Schema file not found: ${schemaPath}`);
        process.exit(2);
    }

    let schemaFile;
    try {
        schemaFile = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    } catch (err) {
        console.error(`❌ Failed to parse schema JSON: ${err.message}`);
        process.exit(2);
    }

    // Accept either { schemaName, schema } wrapper or a raw schema body.
    let schemaName = null;
    let rawSchema;
    if (
        schemaFile &&
        typeof schemaFile === 'object' &&
        typeof schemaFile.schema === 'object' &&
        schemaFile.schema !== null
    ) {
        schemaName = schemaFile.schemaName || schemaFile.name || null;
        rawSchema = schemaFile.schema;
    } else {
        rawSchema = schemaFile;
    }

    if (!rawSchema || typeof rawSchema !== 'object' || !rawSchema.type) {
        console.error(
            '❌ Schema body must be an object with a top-level "type" (looks like the file is neither a {schemaName,schema} wrapper nor a raw JSON Schema body).'
        );
        process.exit(2);
    }

    const { cleanedSchema, promptHints } = extractHintsAndClean(rawSchema);

    // Late dynamic imports so --help and arg validation don't trigger a DB
    // connection.
    const { registerDocumentType, registerSchema } = await import(
        '../src/services/schemaRegistry.js'
    );

    console.log(`📌 Ensuring document_type '${args.slug}' is registered...`);
    const dtResult = await registerDocumentType({
        slug: args.slug,
        displayName: args['display-name'],
        description: args.description || null,
        defaultExtractor: args['default-extractor'] || 'extendai',
        routingConfidenceThreshold:
            args['routing-confidence'] !== undefined
                ? Number(args['routing-confidence'])
                : 0.75,
    });
    console.log(
        dtResult.created
            ? `✅ Created document_type ${dtResult.id} (${dtResult.slug})`
            : `✅ Reusing existing document_type ${dtResult.id} (${dtResult.slug})`
    );

    const setActive = !args.draft;
    console.log(
        `📌 Registering schema version (${setActive ? 'active' : 'draft'}) for '${args.slug}'...`
    );
    const result = await registerSchema({
        documentTypeSlug: args.slug,
        jsonSchema: cleanedSchema,
        promptHints,
        schemaName,
        notes: `Imported from ${schemaPath}`,
        setActive,
    });

    const fieldHintCount = Object.keys(promptHints.field_hints || {}).length;
    console.log(
        `✅ Registered schema id=${result.schemaId} version=${result.version} status=${result.status}`
    );
    console.log(
        `   prompt_hints: system_role=${
            promptHints.system_role ? '✓' : '✗'
        }, guidelines=${(promptHints.guidelines || []).length}, validators=${
            (promptHints.validators || []).length
        }, field_hints=${fieldHintCount} field(s)`
    );

    process.exit(0);
}

main().catch((err) => {
    console.error('💥 register-schema failed:', err.message);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
});
