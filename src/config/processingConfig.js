/**
 * Processing Methods and Models Configuration
 * Centralized configuration for all AI processing providers
 */

export const PROCESSING_METHODS = {
    OPENAI: 'openai',
    QWEN: 'qwen'
};

export const OPENAI_MODELS = {
    GPT_4O: 'gpt-4o',
    GPT_4O_2024_08_06: 'gpt-4o-2024-08-06',
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

// Arrays of all available models for easy iteration/validation
export const OPENAI_MODELS_LIST = Object.values(OPENAI_MODELS);
export const QWEN_MODELS_LIST = Object.values(QWEN_MODELS);
export const ALL_PROCESSING_METHODS = Object.values(PROCESSING_METHODS);

// Default models for each method
export const DEFAULT_MODELS = {
    [PROCESSING_METHODS.OPENAI]: OPENAI_MODELS.GPT_4O,
    [PROCESSING_METHODS.QWEN]: QWEN_MODELS.QWEN3_MAX
};

// Default options for OpenAI models
export const OPENAI_DEFAULT_OPTIONS = {
    [OPENAI_MODELS.GPT_4O]: {
        temperature: 0.1,
        max_tokens: 4000
    },
    [OPENAI_MODELS.GPT_4O_2024_08_06]: {
        temperature: 0.1,
        max_tokens: 4000
    },
    [OPENAI_MODELS.GPT_4]: {
        temperature: 0.1,
        max_tokens: 4000
    },
    [OPENAI_MODELS.GPT_3_5_TURBO]: {
        temperature: 0.2,
        max_tokens: 3000
    }
};

// Default options for Qwen models
export const QWEN_DEFAULT_OPTIONS = {
    // Qwen-Max series (best quality)
    [QWEN_MODELS.QWEN3_MAX]: {
        temperature: 0.1,
        top_p: 0.8,
        max_tokens: 2000
    },
    [QWEN_MODELS.QWEN_MAX]: {
        temperature: 0.1,
        top_p: 0.8,
        max_tokens: 2000
    },
    // Qwen-Plus series
    [QWEN_MODELS.QWEN_PLUS]: {
        temperature: 0.1,
        top_p: 0.8,
        max_tokens: 2000
    },
    // Qwen-Flash series (faster)
    [QWEN_MODELS.QWEN_FLASH]: {
        temperature: 0.2,
        top_p: 0.8,
        max_tokens: 1500
    },
    // Qwen-Turbo series (fastest)
    [QWEN_MODELS.QWEN_TURBO]: {
        temperature: 0.2,
        top_p: 0.8,
        max_tokens: 1500
    },
    // Qwen-Coder series
    [QWEN_MODELS.QWEN3_CODER_PLUS]: {
        temperature: 0.1,
        top_p: 0.8,
        max_tokens: 2000
    },
    [QWEN_MODELS.QWEN3_CODER_FLASH]: {
        temperature: 0.2,
        top_p: 0.8,
        max_tokens: 1500
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
        return OPENAI_DEFAULT_OPTIONS[model] || OPENAI_DEFAULT_OPTIONS[DEFAULT_MODELS[PROCESSING_METHODS.OPENAI]];
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

export default {
    PROCESSING_METHODS,
    OPENAI_MODELS,
    QWEN_MODELS,
    OPENAI_MODELS_LIST,
    QWEN_MODELS_LIST,
    ALL_PROCESSING_METHODS,
    DEFAULT_MODELS,
    OPENAI_DEFAULT_OPTIONS,
    QWEN_DEFAULT_OPTIONS,
    getModelsForMethod,
    getDefaultModel,
    getDefaultOptions,
    isValidModel
};

