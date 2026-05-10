#!/usr/bin/env node
/**
 * set-classifier-hints.js — set per-type classifier_hints on a document_type
 *
 * Usage:
 *   # Read hints from a JSON file
 *   node ai/scripts/set-classifier-hints.js --slug mgs_well_log --file ./hints.json
 *
 *   # Read hints from stdin
 *   cat hints.json | node ai/scripts/set-classifier-hints.js --slug mgs_well_log
 *
 *   # Show currently-stored hints (no write)
 *   node ai/scripts/set-classifier-hints.js --slug mgs_well_log --show
 *
 *   # Clear hints (write empty {})
 *   node ai/scripts/set-classifier-hints.js --slug mgs_well_log --clear
 *
 * Hints file shape (free-form; current consumers read skip_when / keep_when):
 *   {
 *     "skip_when": [
 *       "If the page title is 'Application for Permit', classify as document_type_slug='none'",
 *       "..."
 *     ],
 *     "keep_when": [
 *       "Real well logs have depth columns and lithology rows",
 *       "..."
 *     ]
 *   }
 *
 * Behaviour:
 *   - REPLACES the entire hints object (not a merge). Stale rules are dropped.
 *   - Errors loudly if the slug doesn't exist in the registry.
 *   - Bumps the schemaRegistry cache so the next classifier call sees fresh
 *     hints immediately.
 *   - Does not change the response schema, so no need to bump the
 *     classifierVersion just for editing hints (only for prompt-structure
 *     changes — which is what classifierVersion=3 already covers for
 *     "hints are now spliced in" generally).
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

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
            'Usage: node ai/scripts/set-classifier-hints.js \\',
            '  --slug <document_type_slug> \\',
            '  --file /path/to/hints.json   (or pipe JSON via stdin)',
            '',
            'Other modes:',
            '  --show    print currently-stored hints',
            '  --clear   write empty {} hints',
        ].join('\n')
    );
}

async function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => (data += chunk));
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}

async function main() {
    const args = parseArgs(process.argv);

    if (args.help) { usage(); process.exit(0); }
    if (!args.slug) { usage(); process.exit(2); }

    const { getDocumentTypeBySlug, setClassifierHints } = await import(
        '../src/services/schemaRegistry.js'
    );

    if (args.show) {
        const dt = await getDocumentTypeBySlug(args.slug);
        if (!dt) {
            console.error(`❌ document_type '${args.slug}' not found`);
            process.exit(2);
        }
        console.log(`Hints for '${args.slug}' (display_name="${dt.display_name}"):`);
        console.log(JSON.stringify(dt.classifier_hints || {}, null, 2));
        process.exit(0);
    }

    let hints;
    if (args.clear) {
        hints = {};
    } else if (args.file) {
        const filePath = path.resolve(args.file);
        if (!fs.existsSync(filePath)) {
            console.error(`❌ hints file not found: ${filePath}`);
            process.exit(2);
        }
        try {
            hints = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
            console.error(`❌ failed to parse hints JSON: ${err.message}`);
            process.exit(2);
        }
    } else {
        // Read from stdin if it's piped (not a TTY)
        if (process.stdin.isTTY) {
            usage();
            process.exit(2);
        }
        const raw = await readStdin();
        try {
            hints = JSON.parse(raw);
        } catch (err) {
            console.error(`❌ failed to parse stdin JSON: ${err.message}`);
            process.exit(2);
        }
    }

    if (!hints || typeof hints !== 'object' || Array.isArray(hints)) {
        console.error('❌ hints must be a plain JSON object');
        process.exit(2);
    }

    const result = await setClassifierHints(args.slug, hints);

    const skipCount = Array.isArray(hints.skip_when) ? hints.skip_when.length : 0;
    const keepCount = Array.isArray(hints.keep_when) ? hints.keep_when.length : 0;
    console.log(`✅ Updated classifier_hints for '${result.slug}' (skip_when=${skipCount}, keep_when=${keepCount})`);
    console.log(`   updated_at=${result.updated_at.toISOString ? result.updated_at.toISOString() : result.updated_at}`);
    process.exit(0);
}

main().catch((err) => {
    console.error('💥 set-classifier-hints failed:', err.message);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
});
