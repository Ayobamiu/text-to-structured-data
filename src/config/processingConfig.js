

/**
 * Processing Methods and Models Configuration
 * Centralized configuration for all AI processing providers
 */

import { Extend, ExtendClient } from "extend-ai";

export const PROCESSING_METHODS = {
    OPENAI: 'openai',
    QWEN: 'qwen',
    CLAUDE: 'claude',
};

export const OPENAI_MODELS = {
    // gpt-4.1 family — 32,768 output token cap, supports json_schema strict.
    // This is the default for structured extraction because dense schemas
    // (e.g. analytical_results) overflow gpt-4o's 16,384 output cap on
    // some pages.
    GPT_4_1: 'gpt-4.1',
    GPT_4_1_MINI: 'gpt-4.1-mini',
    GPT_4_1_NANO: 'gpt-4.1-nano',
    // gpt-4o family — 16,384 output token cap. Kept for backwards
    // compatibility and as the auto-retry source when these truncate.
    GPT_4O: 'gpt-4o',
    GPT_4O_2024_08_06: 'gpt-4o-2024-08-06',
    GPT_4O_MINI: 'gpt-4o-mini',
    GPT_4: 'gpt-4',
    GPT_3_5_TURBO: 'gpt-3.5-turbo'
};

export const QWEN_MODELS = {
    // Qwen-Max series (best quality)
    QWEN3_MAX: 'qwen3-max',
    QWEN3_MAX_2025_09_23: 'qwen3-max-2025-09-23',
    QWEN3_MAX_PREVIEW: 'qwen3-max-preview',
    QWEN_MAX: 'qwen-max',
    QWEN_MAX_LATEST: 'qwen-max-latest',
    QWEN_MAX_2025_01_25: 'qwen-max-2025-01-25',

    // Qwen-Plus series
    QWEN_PLUS: 'qwen-plus',
    QWEN_PLUS_LATEST: 'qwen-plus-latest',
    QWEN_PLUS_2025_01_25: 'qwen-plus-2025-01-25',

    // Qwen-Flash series (faster)
    QWEN_FLASH: 'qwen-flash',
    QWEN_FLASH_2025_07_28: 'qwen-flash-2025-07-28',

    // Qwen-Turbo series (fastest)
    QWEN_TURBO: 'qwen-turbo',
    QWEN_TURBO_LATEST: 'qwen-turbo-latest',
    QWEN_TURBO_2024_11_01: 'qwen-turbo-2024-11-01',

    // Qwen-Coder series
    QWEN3_CODER_PLUS: 'qwen3-coder-plus',
    QWEN3_CODER_PLUS_2025_07_22: 'qwen3-coder-plus-2025-07-22',
    QWEN3_CODER_FLASH: 'qwen3-coder-flash',
    QWEN3_CODER_FLASH_2025_07_28: 'qwen3-coder-flash-2025-07-28'
};

export const CLAUDE_MODELS = {
    // Claude Sonnet 4.6 — 64K output token cap via streaming.
    // Used as the escalation target for large sections that exceed
    // GPT-4.1's 32K output cap. Schema enforcement via tool_use.
    CLAUDE_SONNET_4_6: 'claude-sonnet-4-6',
};

// Arrays of all available models for easy iteration/validation
export const OPENAI_MODELS_LIST = Object.values(OPENAI_MODELS);
export const QWEN_MODELS_LIST = Object.values(QWEN_MODELS);
export const CLAUDE_MODELS_LIST = Object.values(CLAUDE_MODELS);
export const ALL_PROCESSING_METHODS = Object.values(PROCESSING_METHODS);

// Claude default options.
//
// `max_tokens` set to 64K — the primary reason for routing to Claude.
// `temperature` matches OpenAI's extraction setting (0.1).
// Streaming is required by the Anthropic SDK for large max_tokens values.
export const CLAUDE_DEFAULT_OPTIONS = {
    [CLAUDE_MODELS.CLAUDE_SONNET_4_6]: {
        temperature: 0.1,
        max_tokens: 64000,
    },
};

// Default models for each method.
//
// OpenAI default switched from gpt-4o (16k output cap) to gpt-4.1 (32k
// output cap) on 2026-05-13 after analytical_results table extractions
// were consistently hitting gpt-4o's hard output cap, producing truncated
// JSON and `Unexpected end of JSON input` failures. gpt-4.1 also supports
// the same json_schema strict response_format and is cheaper per token.
export const DEFAULT_MODELS = {
    [PROCESSING_METHODS.OPENAI]: OPENAI_MODELS.GPT_4_1,
    [PROCESSING_METHODS.QWEN]: QWEN_MODELS.QWEN3_MAX,
    [PROCESSING_METHODS.CLAUDE]: CLAUDE_MODELS.CLAUDE_SONNET_4_6,
};

// Default options for OpenAI models.
//
// `max_tokens` here MUST match the model's actual max output cap. Previously
// the gpt-4o entries set 4000 — but that value was never forwarded to the
// API call (silent option drop), so the runtime was using OpenAI's model
// default (16384). Raising the configured value to each model's true cap
// makes the config truthful AND ensures we don't accidentally tighten the
// cap for dense outputs like table extractions.
//
// `temperature` is intentionally low (0.1) for structured extraction —
// reduces output-length variance and the risk of hitting the output cap.
export const OPENAI_DEFAULT_OPTIONS = {
    [OPENAI_MODELS.GPT_4_1]: {
        temperature: 0.1,
        max_tokens: 32768
    },
    [OPENAI_MODELS.GPT_4_1_MINI]: {
        temperature: 0.1,
        max_tokens: 32768
    },
    [OPENAI_MODELS.GPT_4_1_NANO]: {
        temperature: 0.1,
        max_tokens: 32768
    },
    [OPENAI_MODELS.GPT_4O]: {
        temperature: 0.1,
        max_tokens: 16384
    },
    [OPENAI_MODELS.GPT_4O_2024_08_06]: {
        temperature: 0.1,
        max_tokens: 16384
    },
    [OPENAI_MODELS.GPT_4O_MINI]: {
        temperature: 0.1,
        max_tokens: 16384
    },
    [OPENAI_MODELS.GPT_4]: {
        temperature: 0.1,
        max_tokens: 8192
    },
    [OPENAI_MODELS.GPT_3_5_TURBO]: {
        temperature: 0.2,
        max_tokens: 4096
    }
};

/**
 * For automatic truncation recovery: when a 16k-cap model emits
 * finish_reason='length' the processor retries the same prompt against
 * a model with a larger output cap (32k). Map the source model to its
 * upgrade target. Returns null if no upgrade is available (e.g. we're
 * already on a 32k model).
 *
 * Tier-preserving where possible: gpt-4o-mini upgrades to gpt-4.1-mini
 * so cost characteristics stay similar.
 */
export function getOpenAIUpgradeModel(model) {
    switch (model) {
        case OPENAI_MODELS.GPT_4O:
        case OPENAI_MODELS.GPT_4O_2024_08_06:
        case OPENAI_MODELS.GPT_4:
            return OPENAI_MODELS.GPT_4_1;
        case OPENAI_MODELS.GPT_4O_MINI:
            return OPENAI_MODELS.GPT_4_1_MINI;
        case OPENAI_MODELS.GPT_3_5_TURBO:
            return OPENAI_MODELS.GPT_4_1;
        default:
            return null;
    }
}

// Default options for Qwen models
export const QWEN_DEFAULT_OPTIONS = {
    // Qwen-Max series (best quality) - increased max_tokens for complex schemas
    [QWEN_MODELS.QWEN3_MAX]: {
        temperature: 0.1,
        top_p: 0.8,
        max_tokens: 8000 // Increased from 2000 to handle large/complex schemas
    },
    [QWEN_MODELS.QWEN_MAX]: {
        temperature: 0.1,
        top_p: 0.8,
        max_tokens: 8000 // Increased from 2000
    },
    // Qwen-Plus series
    [QWEN_MODELS.QWEN_PLUS]: {
        temperature: 0.1,
        top_p: 0.8,
        max_tokens: 6000 // Increased from 2000
    },
    // Qwen-Flash series (faster)
    [QWEN_MODELS.QWEN_FLASH]: {
        temperature: 0.2,
        top_p: 0.8,
        max_tokens: 4000 // Increased from 1500
    },
    // Qwen-Turbo series (fastest)
    [QWEN_MODELS.QWEN_TURBO]: {
        temperature: 0.2,
        top_p: 0.8,
        max_tokens: 4000 // Increased from 1500
    },
    // Qwen-Coder series
    [QWEN_MODELS.QWEN3_CODER_PLUS]: {
        temperature: 0.1,
        top_p: 0.8,
        max_tokens: 6000 // Increased from 2000
    },
    [QWEN_MODELS.QWEN3_CODER_FLASH]: {
        temperature: 0.2,
        top_p: 0.8,
        max_tokens: 4000 // Increased from 1500
    }
};

/**
 * Get all models for a specific processing method
 * @param {string} method - Processing method ('openai' | 'qwen')
 * @returns {Array<string>} List of available models
 */
export function getModelsForMethod(method) {
    switch (method) {
        case PROCESSING_METHODS.OPENAI:
            return OPENAI_MODELS_LIST;
        case PROCESSING_METHODS.QWEN:
            return QWEN_MODELS_LIST;
        case PROCESSING_METHODS.CLAUDE:
            return CLAUDE_MODELS_LIST;
        default:
            return [];
    }
}

/**
 * Get default model for a processing method
 * @param {string} method - Processing method ('openai' | 'qwen')
 * @returns {string} Default model name
 */
export function getDefaultModel(method) {
    return DEFAULT_MODELS[method] || null;
}

/**
 * Get default options for a model
 * @param {string} method - Processing method ('openai' | 'qwen')
 * @param {string} model - Model name
 * @returns {Object|null} Default options for the model
 */
export function getDefaultOptions(method, model) {
    if (method === PROCESSING_METHODS.OPENAI) {
        if (OPENAI_DEFAULT_OPTIONS[model]) return OPENAI_DEFAULT_OPTIONS[model];
        // Prefix fallback so future dated snapshots (e.g. gpt-4.1-2025-04-14)
        // pick up the family's defaults instead of falling back to the
        // global default (which would be wrong for a small/mini model).
        if (typeof model === 'string') {
            if (model.startsWith('gpt-4.1-mini')) return OPENAI_DEFAULT_OPTIONS[OPENAI_MODELS.GPT_4_1_MINI];
            if (model.startsWith('gpt-4.1-nano')) return OPENAI_DEFAULT_OPTIONS[OPENAI_MODELS.GPT_4_1_NANO];
            if (model.startsWith('gpt-4.1')) return OPENAI_DEFAULT_OPTIONS[OPENAI_MODELS.GPT_4_1];
            if (model.startsWith('gpt-4o-mini')) return OPENAI_DEFAULT_OPTIONS[OPENAI_MODELS.GPT_4O_MINI];
            if (model.startsWith('gpt-4o')) return OPENAI_DEFAULT_OPTIONS[OPENAI_MODELS.GPT_4O];
        }
        return OPENAI_DEFAULT_OPTIONS[DEFAULT_MODELS[PROCESSING_METHODS.OPENAI]];
    } else if (method === PROCESSING_METHODS.QWEN) {
        // Try exact match first
        if (QWEN_DEFAULT_OPTIONS[model]) {
            return QWEN_DEFAULT_OPTIONS[model];
        }

        // Fallback based on model prefix
        if (model.startsWith('qwen3-max') || model.startsWith('qwen-max')) {
            return QWEN_DEFAULT_OPTIONS[QWEN_MODELS.QWEN3_MAX] || QWEN_DEFAULT_OPTIONS[QWEN_MODELS.QWEN_MAX];
        } else if (model.startsWith('qwen-plus')) {
            return QWEN_DEFAULT_OPTIONS[QWEN_MODELS.QWEN_PLUS];
        } else if (model.startsWith('qwen-flash')) {
            return QWEN_DEFAULT_OPTIONS[QWEN_MODELS.QWEN_FLASH];
        } else if (model.startsWith('qwen-turbo')) {
            return QWEN_DEFAULT_OPTIONS[QWEN_MODELS.QWEN_TURBO];
        } else if (model.startsWith('qwen3-coder')) {
            return QWEN_DEFAULT_OPTIONS[QWEN_MODELS.QWEN3_CODER_PLUS];
        }

        // Default fallback
        return QWEN_DEFAULT_OPTIONS[DEFAULT_MODELS[PROCESSING_METHODS.QWEN]];
    } else if (method === PROCESSING_METHODS.CLAUDE) {
        if (CLAUDE_DEFAULT_OPTIONS[model]) return CLAUDE_DEFAULT_OPTIONS[model];
        // Prefix fallback for future Claude model snapshots
        if (typeof model === 'string' && model.startsWith('claude-sonnet')) {
            return CLAUDE_DEFAULT_OPTIONS[CLAUDE_MODELS.CLAUDE_SONNET_4_6];
        }
        return CLAUDE_DEFAULT_OPTIONS[DEFAULT_MODELS[PROCESSING_METHODS.CLAUDE]];
    }

    return null;
}

/**
 * Validate if a model is valid for a given method
 * @param {string} method - Processing method ('openai' | 'qwen')
 * @param {string} model - Model name to validate
 * @returns {boolean} True if model is valid for the method
 */
export function isValidModel(method, model) {
    const models = getModelsForMethod(method);
    return models.includes(model);
}


/**
 * @param {Object} [options]
 * @param {boolean} [options.returnOcrWords] - Ask Extend for word-level OCR
 *   geometry (used by depth-geometry recovery; see depthGeometryService.ts).
 */
export function getExtendAIConfig(options = {}) {
    return {
        "engine": "parse_performance",
        "target": "markdown",
        "blockOptions": {
            "text": {
                "agentic": {
                    "enabled": true
                },
                "signatureDetectionEnabled": false
            },
            "tables": {
                "agentic": {
                    "enabled": true
                },
                "targetFormat": "html",
                "cellBlocksEnabled": false,
                "tableHeaderContinuationEnabled": true
            },
            "figures": {
                "enabled": true,
                "figureImageClippingEnabled": true,
                "advancedChartExtractionEnabled": false
            },
            "barcodes": {
                "readingEnabled": false,
                "imageClippingEnabled": false
            },
            "formulas": {
                "enabled": false
            },
            "keyValue": {
                "blankFieldFormattingEnabled": false
            }
        },
        "engineVersion": "2.0.0-beta",
        "advancedOptions": {
            "returnOcr": {
                "words": options.returnOcrWords === true
            },
            "pageRanges": [],
            "parallelism": 1,
            "enrichmentFormat": "xml",
            "excelParsingMode": "advanced",
            "agenticOcrEnabled": false,
            "pageBreaksEnabled": false,
            "alwaysConvertToPdf": false,
            "formattingDetection": [],
            "pageRotationEnabled": true,
            "excelSkipCalculation": true,
            "excelUseRawCellValues": false,
            "excelSkipHiddenContent": false,
            "imageConversionQuality": "medium",
            "verticalGroupingThreshold": 1
        },
        "chunkingStrategy": {
            "type": "page",
            "options": {
                "maxCharacters": 10000,
                "minCharacters": 500
            }
        }
    }
}

export default {
    PROCESSING_METHODS,
    OPENAI_MODELS,
    QWEN_MODELS,
    CLAUDE_MODELS,
    OPENAI_MODELS_LIST,
    QWEN_MODELS_LIST,
    CLAUDE_MODELS_LIST,
    ALL_PROCESSING_METHODS,
    DEFAULT_MODELS,
    OPENAI_DEFAULT_OPTIONS,
    QWEN_DEFAULT_OPTIONS,
    CLAUDE_DEFAULT_OPTIONS,
    getModelsForMethod,
    getDefaultModel,
    getDefaultOptions,
    getOpenAIUpgradeModel,
    isValidModel,
    getExtendAIConfig
};

