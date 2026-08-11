'use strict';

const { GoogleGenAI } = require('@google/genai');
const { classifyStatusError } = require('./provider-errors');

/**
 * Gemini adapter — bring-your-own-key, Google's GenAI SDK.
 *
 * Two real differences from the other adapters, both because Gemini's wire
 * shape genuinely differs from the Anthropic/OpenAI convention:
 *
 *   - the system prompt is NOT a message with a system role — Gemini has no
 *     such role in `contents`. It's a separate `config.systemInstruction`.
 *   - the assistant's own turns are role `'model'`, not `'assistant'`. Only
 *     matters when translating chat history for the streaming path.
 *
 * No effort/adaptive-thinking equivalent in the request shape for the
 * catalog models — accepted for interface consistency, unused, same stance
 * as the Ollama and OpenAI adapters.
 */

let client = null;
let clientKey = null;

/**
 * `maxRetries` is folded into the cache key (not just apiKey) because it's
 * set at client-construction time here, unlike Anthropic/OpenAI where it's a
 * per-client option that happens to also only change alongside the key in
 * practice. Without a real 429/5xx retry policy, Gemini would silently fall
 * back to the SDK's own default of 5 attempts — fine on its own, but
 * inconsistent with the user's configured maxRetries everywhere else.
 */
function getClient(apiKey, maxRetries) {
  const cacheKey = `${apiKey}::${maxRetries}`;
  if (!client || clientKey !== cacheKey) {
    client = new GoogleGenAI({
      apiKey,
      httpOptions: { retryOptions: { attempts: (maxRetries ?? 2) + 1 } },
    });
    clientKey = cacheKey;
  }
  return client;
}

function invalidateClient() {
  client = null;
  clientKey = null;
}

/** Canonical block -> a Gemini Part. */
function toGeminiPart(block) {
  return block.type === 'image'
    ? { inlineData: { mimeType: block.mediaType, data: block.base64 } }
    : { text: block.text };
}

// SAFETY / BLOCKLIST / PROHIBITED_CONTENT / SPII are all policy-driven
// refusals; RECITATION/MAX_TOKENS/OTHER/LANGUAGE stopped generation for a
// different reason and aren't "declined", so they map to 'other' rather than
// being lumped in as a refusal.
const REFUSAL_FINISH_REASONS = new Set(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

function normalizeStopReason(finishReason) {
  if (REFUSAL_FINISH_REASONS.has(finishReason)) return 'refusal';
  if (finishReason === 'STOP') return 'end_turn';
  return 'other';
}

function normalizeUsage(usageMetadata) {
  if (!usageMetadata) return undefined;
  return {
    input_tokens: usageMetadata.promptTokenCount || 0,
    output_tokens: usageMetadata.candidatesTokenCount || 0,
  };
}

function describeError(err, model) {
  // Gemini's SDK has one flat ApiError with a status code, no per-code
  // classes — classifyStatusError's plain status-code branches handle this
  // correctly with an empty errorClasses map. As a side effect of unifying
  // onto the shared classifier, 401 and 403 now get their own distinct
  // messages here too, instead of being collapsed into one.
  return classifyStatusError(err, {
    providerLabel: 'Gemini',
    model,
    autoRetries: true, // client is constructed with httpOptions.retryOptions
  });
}

/** True when the response has no usable candidate at all (blocked upfront). */
function blockedBeforeGeneration(response) {
  return !response.candidates || response.candidates.length === 0;
}

async function askStructured({ apiKey, model, maxTokens, system, content, jsonSchema, timeoutMs, maxRetries }) {
  const api = getClient(apiKey, maxRetries);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 60000);

  try {
    const response = await api.models.generateContent({
      model,
      contents: [{ role: 'user', parts: content.map(toGeminiPart) }],
      config: {
        systemInstruction: system,
        maxOutputTokens: maxTokens,
        responseMimeType: 'application/json',
        responseSchema: jsonSchema,
        abortSignal: controller.signal,
      },
    });

    if (blockedBeforeGeneration(response)) {
      return { ok: false, error: 'Declined by Gemini safety filters before generating a response.' };
    }

    const stopReason = normalizeStopReason(response.candidates[0].finishReason);
    if (stopReason === 'refusal') {
      return { ok: false, error: `Declined by Gemini safety filters (${response.candidates[0].finishReason}).` };
    }

    return {
      ok: true,
      text: response.text || '',
      stopReason,
      usage: normalizeUsage(response.usageMetadata),
      model,
    };
  } catch (err) {
    const described = describeError(err, model);
    return { ok: false, error: described.message, aborted: described.aborted };
  } finally {
    clearTimeout(timer);
  }
}

async function askStreaming({ apiKey, model, maxTokens, system, messages, onDelta, registerAbort, timeoutMs, maxRetries }) {
  const api = getClient(apiKey, maxRetries);
  const wireContents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user', // Gemini has no 'assistant' role
    parts: m.content.map(toGeminiPart),
  }));

  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs || 60000);
  if (registerAbort) registerAbort(() => controller.abort());

  try {
    const stream = await api.models.generateContentStream({
      model,
      contents: wireContents,
      config: {
        systemInstruction: system,
        maxOutputTokens: maxTokens,
        abortSignal: controller.signal,
      },
    });

    let stopReason = 'other';
    let usage;
    let sawAnyCandidate = false;

    for await (const chunk of stream) {
      if (!blockedBeforeGeneration(chunk)) {
        sawAnyCandidate = true;
        const text = chunk.text;
        if (text) onDelta(text);
        const finishReason = chunk.candidates[0].finishReason;
        if (finishReason) stopReason = normalizeStopReason(finishReason);
      }
      if (chunk.usageMetadata) usage = normalizeUsage(chunk.usageMetadata);
    }

    if (!sawAnyCandidate) {
      return { ok: false, error: 'Declined by Gemini safety filters before generating a response.' };
    }

    return { ok: true, stopReason, usage, model };
  } catch (err) {
    const described = describeError(err, model);
    return { ok: false, error: described.message, aborted: described.aborted };
  } finally {
    clearTimeout(timeoutTimer);
    if (registerAbort) registerAbort(null);
  }
}

async function validate({ apiKey, model }) {
  try {
    const api = getClient(apiKey);
    await api.models.get({ model });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err, model).message };
  }
}

module.exports = { id: 'gemini', needsKey: true, askStructured, askStreaming, validate, invalidateClient };
