'use strict';

const sdk = require('openai');
const OpenAI = sdk.OpenAI || sdk.default || sdk;
const { classifyStatusError } = require('./provider-errors');

/**
 * OpenAI adapter — bring-your-own-key, Chat Completions API.
 *
 * No effort/adaptive-thinking equivalent for the catalog models (gpt-4o,
 * gpt-4o-mini are plain chat models, not the o-series reasoning models) — the
 * param is accepted for interface consistency with the other adapters and
 * intentionally unused, same as Ollama's stance on the same field.
 */

let client = null;
let clientKey = null;

function getClient(apiKey, timeoutMs, maxRetries) {
  if (!client || clientKey !== apiKey) {
    client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries });
    clientKey = apiKey;
  }
  return client;
}

function invalidateClient() {
  client = null;
  clientKey = null;
}

/** Canonical block -> OpenAI's content-array shape. */
function toOpenAIContent(blocks) {
  return blocks.map((block) =>
    block.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.base64}` } }
      : { type: 'text', text: block.text }
  );
}

function normalizeStopReason(finishReason) {
  // content_filter is OpenAI's closest equivalent to a policy-driven refusal.
  if (finishReason === 'content_filter') return 'refusal';
  if (finishReason === 'stop') return 'end_turn';
  return 'other';
}

function normalizeUsage(usage) {
  if (!usage) return undefined;
  // OpenAI's field names differ from Anthropic's; ai.js and usage.js only
  // ever read input_tokens/output_tokens, so translate once, here.
  return { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 };
}

function describeError(err, model) {
  return classifyStatusError(err, {
    providerLabel: 'OpenAI',
    model,
    autoRetries: true, // client is constructed with maxRetries
    errorClasses: {
      Abort: OpenAI.APIUserAbortError,
      Authentication: OpenAI.AuthenticationError,
      PermissionDenied: OpenAI.PermissionDeniedError,
      NotFound: OpenAI.NotFoundError,
      RateLimit: OpenAI.RateLimitError,
      Connection: OpenAI.APIConnectionError,
    },
  });
}

async function askStructured({ apiKey, model, maxTokens, system, content, jsonSchema, timeoutMs, maxRetries }) {
  const api = getClient(apiKey, timeoutMs, maxRetries);
  try {
    const completion = await api.chat.completions.create({
      model,
      max_completion_tokens: maxTokens, // max_tokens is deprecated on this API
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: toOpenAIContent(content) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'terse_answer', schema: jsonSchema, strict: true },
      },
    });

    const choice = completion.choices[0];
    const stopReason = normalizeStopReason(choice.finish_reason);
    if (stopReason === 'refusal') {
      return { ok: false, error: 'Declined by OpenAI content filters.' };
    }

    return {
      ok: true,
      text: choice.message?.content || '',
      stopReason,
      usage: normalizeUsage(completion.usage),
      model: completion.model,
    };
  } catch (err) {
    const described = describeError(err, model);
    return { ok: false, error: described.message, aborted: described.aborted };
  }
}

async function askStreaming({ apiKey, model, maxTokens, system, messages, onDelta, registerAbort, timeoutMs, maxRetries }) {
  const api = getClient(apiKey, timeoutMs, maxRetries);
  const wireMessages = [
    { role: 'system', content: system },
    ...messages.map((m) => ({ role: m.role, content: toOpenAIContent(m.content) })),
  ];

  const controller = new AbortController();
  if (registerAbort) registerAbort(() => controller.abort());

  try {
    const stream = await api.chat.completions.create(
      {
        model,
        max_completion_tokens: maxTokens, // max_tokens is deprecated on this API
        messages: wireMessages,
        stream: true,
        // Without this, a streamed response carries no usage at all — the
        // final chunk (empty choices array) is where it arrives.
        stream_options: { include_usage: true },
      },
      { signal: controller.signal }
    );

    let stopReason = 'other';
    let usage;
    let responseModel = model;

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) onDelta(delta);
      if (choice?.finish_reason) stopReason = normalizeStopReason(choice.finish_reason);
      if (chunk.usage) usage = normalizeUsage(chunk.usage);
      if (chunk.model) responseModel = chunk.model;
    }

    return { ok: true, stopReason, usage, model: responseModel };
  } catch (err) {
    const described = describeError(err, model);
    return { ok: false, error: described.message, aborted: described.aborted };
  } finally {
    if (registerAbort) registerAbort(null);
  }
}

async function validate({ apiKey, model }) {
  try {
    const probe = new OpenAI({ apiKey, timeout: 15000, maxRetries: 0 });
    await probe.models.retrieve(model);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err, model).message };
  }
}

module.exports = { id: 'openai', needsKey: true, askStructured, askStreaming, validate, invalidateClient };
