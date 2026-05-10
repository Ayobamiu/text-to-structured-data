/**
 * Shared logic for stripping x-* extension keys out of JSON Schemas destined
 * for OpenAI structured outputs, folding them into `prompt_hints.field_hints`.
 * Used by ai/scripts/register-schema.js and HTTP registry admins.
 */

export const HINT_FIELD_KEYS = [
    'x-locators',
    'x-rules',
    'x-instructions',
    'x-date-formats',
    'x-constraints',
];

export const HINT_ROOT_KEYS = ['x-system-role', 'x-guidelines', 'x-validators'];

export function extractHintsAndClean(schemaRoot) {
    const promptHints = { field_hints: {} };

    if (!schemaRoot || typeof schemaRoot !== 'object') {
        return { cleanedSchema: schemaRoot, promptHints };
    }

    if (schemaRoot['x-system-role']) {
        promptHints.system_role = schemaRoot['x-system-role'];
    }
    if (Array.isArray(schemaRoot['x-guidelines'])) {
        promptHints.guidelines = schemaRoot['x-guidelines'];
    }
    if (Array.isArray(schemaRoot['x-validators'])) {
        promptHints.validators = schemaRoot['x-validators'];
    }

    function walk(node, currentPath) {
        if (!node || typeof node !== 'object') return node;
        if (Array.isArray(node)) return node.map((n) => walk(n, currentPath));

        const out = {};
        const fieldHint = {};

        for (const [k, v] of Object.entries(node)) {
            if (HINT_ROOT_KEYS.includes(k)) {
                continue;
            }
            if (HINT_FIELD_KEYS.includes(k)) {
                const hintKey = k.replace(/^x-/, '').replace(/-/g, '_');
                fieldHint[hintKey] = v;
                continue;
            }

            if (k === 'properties' && v && typeof v === 'object') {
                out[k] = {};
                for (const [propName, propSchema] of Object.entries(v)) {
                    const propPath = currentPath ? `${currentPath}.${propName}` : propName;
                    out[k][propName] = walk(propSchema, propPath);
                }
            } else if (k === 'items' && v && typeof v === 'object') {
                const itemPath = currentPath ? `${currentPath}[]` : '[]';
                out[k] = walk(v, itemPath);
            } else if (typeof v === 'object' && v !== null) {
                out[k] = walk(v, currentPath);
            } else {
                out[k] = v;
            }
        }

        if (Object.keys(fieldHint).length > 0 && currentPath) {
            promptHints.field_hints[currentPath] = fieldHint;
        }

        return out;
    }

    const cleanedSchema = walk(schemaRoot, '');
    return { cleanedSchema, promptHints };
}

/**
 * Normalize a JSON body into { schemaName?, rawSchema } like register-schema CLI.
 */
export function unwrapSchemaPayload(body) {
    if (!body || typeof body !== 'object') throw new Error('Schema body required');
    if (typeof body.jsonSchema === 'object' && body.jsonSchema !== null) {
        let schemaName = body.schemaName || null;
        const inner = body.jsonSchema;
        if (inner.schema && typeof inner.schema === 'object' && inner.schema !== null) {
            schemaName = schemaName || inner.schemaName || inner.name || null;
            return { schemaName, rawSchema: inner.schema };
        }
        return { schemaName, rawSchema: inner };
    }
    throw new Error('jsonSchema object is required');
}
