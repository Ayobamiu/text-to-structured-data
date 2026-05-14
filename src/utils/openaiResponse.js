/**
 * Specific error type for `finish_reason='length'` truncations. Callers
 * can `instanceof`-check this to decide whether to auto-retry with a
 * larger-output-cap model. All other failure modes (refusal, empty
 * content, parse error, etc.) throw a plain `Error` because they are
 * not recoverable by retrying with the same prompt.
 */
export class OpenAiTruncationError extends Error {
    constructor(message, info = {}) {
        super(message);
        this.name = 'OpenAiTruncationError';
        this.model = info.model;
        this.finish_reason = info.finish_reason;
        this.completion_tokens = info.completion_tokens;
        this.prompt_tokens = info.prompt_tokens;
        this.total_tokens = info.total_tokens;
        this.preview = info.preview;
    }
}

/**
 * Defensive parser for OpenAI Chat Completions responses that use the
 * structured-output (`response_format: json_schema`) flow.
 *
 * Why this exists
 * ---------------
 * The naive `JSON.parse(response.choices[0].message.content)` pattern
 * silently turns several distinct OpenAI failure modes into the same
 * opaque `Unexpected end of JSON input` error:
 *
 *   1. `finish_reason === 'length'` — the model hit the output token cap
 *      mid-JSON and the content is truncated. This is the dominant
 *      production failure on dense table pages where the JSON output
 *      is long. Old logs show this as "OpenAI processing error:
 *      Unexpected end of JSON input" with no other context.
 *
 *   2. `message.refusal` — the model refused (safety / policy). In this
 *      case `content` is `null` and the refusal text lives on
 *      `message.refusal`. Naive `JSON.parse(null)` returns `null`, which
 *      then bubbles up as a "successful" extraction of `null`. Worse
 *      than the truncation case.
 *
 *   3. Empty `content` — transient API hiccup or a content-filter
 *      stopping the response. `JSON.parse('')` throws "Unexpected end
 *      of JSON input" too, indistinguishable from #1.
 *
 *   4. Genuine parse error on a non-truncated response — the model
 *      somehow produced invalid JSON (rare with strict json_schema
 *      mode, but possible). The naked `JSON.parse` error doesn't tell
 *      you what the model actually returned.
 *
 * The Qwen processor (`services/qwenProcessor.js`) already implements
 * this defensive shape for DashScope's OpenAI-compatible API. This
 * helper is the same pattern, hoisted to a shared utility so both the
 * legacy `utils/openaiProcessor.js` and the active per-section path in
 * `services/processingService.js` use one source of truth.
 *
 * @param {Object} response The raw OpenAI Chat Completions response.
 * @param {string} [model]  Model name, used only in error messages.
 * @returns {*} The parsed JSON value.
 * @throws {Error} With a specific, actionable message describing the
 *                 actual failure mode.
 */
export function parseOpenAiStructuredResponse(response, model = 'unknown') {
    const choice = response?.choices?.[0];
    if (!choice) {
        throw new Error(
            `OpenAI returned no choices in the response (model: ${model})`
        );
    }

    const message = choice.message || {};
    const finishReason = choice.finish_reason;
    const usage = response?.usage || {};
    const usageStr = usage.total_tokens != null
        ? `${usage.total_tokens} total tokens (prompt: ${usage.prompt_tokens ?? '?'}, completion: ${usage.completion_tokens ?? '?'})`
        : 'token usage unknown';

    // Refusal — newer OpenAI SDKs surface a structured refusal field.
    // Treat it as an explicit failure rather than letting it parse as
    // null and pretending we extracted something.
    if (message.refusal) {
        throw new Error(
            `OpenAI refused the request (model: ${model}, ${usageStr}): ${message.refusal}`
        );
    }

    const content = message.content;
    if (content == null || content === '') {
        // Empty content can happen on content-filter stops, transient
        // API issues, or weird finish_reasons we don't handle below.
        throw new Error(
            `OpenAI returned empty content (model: ${model}, finish_reason: ${finishReason || 'unknown'}, ${usageStr})`
        );
    }

    if (typeof content !== 'string') {
        // Defensive — content should always be a string in this flow.
        throw new Error(
            `OpenAI returned non-string content of type ${typeof content} (model: ${model})`
        );
    }

    // Truncation — the model hit the output token cap mid-JSON. With the
    // strict json_schema response_format this is recoverable only by
    // retrying with a higher cap or a smaller chunk of input. Surface
    // the actual numbers so the operator can decide.
    if (finishReason === 'length') {
        const preview = content.length > 500
            ? `${content.slice(0, 500)}…(${content.length - 500} more chars)`
            : content;
        throw new OpenAiTruncationError(
            `OpenAI response was truncated (finish_reason='length', model: ${model}, ${usageStr}). ` +
            `The schema produced more output than the model could fit in one response. ` +
            `Consider raising max_tokens, lowering temperature, or splitting the input. ` +
            `Response preview: ${preview}`,
            {
                model,
                finish_reason: finishReason,
                completion_tokens: usage.completion_tokens,
                prompt_tokens: usage.prompt_tokens,
                total_tokens: usage.total_tokens,
                preview,
            }
        );
    }

    try {
        return JSON.parse(content);
    } catch (parseError) {
        const preview = content.length > 500
            ? `${content.slice(0, 500)}…(${content.length - 500} more chars)`
            : content;
        throw new Error(
            `Failed to parse JSON from OpenAI response (model: ${model}, finish_reason: ${finishReason || 'unknown'}, ${usageStr}): ` +
            `${parseError.message}. Response preview: ${preview}`
        );
    }
}

export default { parseOpenAiStructuredResponse, OpenAiTruncationError };
