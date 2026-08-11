'use strict';

const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.Anthropic || sdk.default || sdk;
const { classifyStatusError } = require('./provider-errors');

/**
 * Anthropic adapter — the only provider that exists today, extracted so
 * ai.js can eventually call other providers through the same three-method
 * shape without knowing which SDK is on the other end.
 *
 * Interface every adapter implements:
 *   id            string
 *   needsKey      boolean
 *   askStructured({apiKey, model, maxTokens, effort, system, content})
 *                 -> {ok, text?, stopReason?, usage?, model?, error?, aborted?}
 *   askStreaming({apiKey, model, maxTokens, effort, system, messages,
 *                 onDelta, registerAbort})
 *                 -> {ok, stopReason?, usage?, model?, error?, aborted?}
 *   validate({apiKey, model}) -> {ok, error?}
 *
 * `content` on askStructured and each message's `content` on askStreaming
 * are the CANONICAL block shape ai.js builds — [{type:'text', text} |
 * {type:'image', mediaType, base64}] — never Anthropic's wire format. The
 * adapter is the only thing that knows Anthropic wants
 * {type:'image', source:{type:'base64', media_type, data}}; every other
 * adapter will translate the same canonical input into whatever its own
 * SDK wants, and ai.js never has to change.
 *
 * stopReason is normalized to 'refusal' | 'end_turn' | 'other' so ai.js's
 * refusal check doesn't need to know Anthropic's exact field spelling.
 */

let client = null;
let clientKey = null;

function getClient(apiKey, timeoutMs, maxRetries) {
  if (!client || clientKey !== apiKey) {
    client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries });
    clientKey = apiKey;
  }
  return client;
}

function invalidateClient() {
  client = null;
  clientKey = null;
}

/** Canonical block -> Anthropic's wire shape. */
function toAnthropicContent(blocks) {
  return blocks.map((block) =>
    block.type === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.base64 } }
      : { type: 'text', text: block.text }
  );
}

function normalizeStopReason(stopReason) {
  if (stopReason === 'refusal') return 'refusal';
  if (stopReason === 'end_turn') return 'end_turn';
  return 'other';
}

function describeError(err, model) {
  return classifyStatusError(err, {
    providerLabel: 'Anthropic',
    model,
    autoRetries: true, // client is constructed with maxRetries
    errorClasses: {
      Authentication: Anthropic.AuthenticationError,
      PermissionDenied: Anthropic.PermissionDeniedError,
      NotFound: Anthropic.NotFoundError,
      RateLimit: Anthropic.RateLimitError,
      Connection: Anthropic.APIConnectionError,
    },
  });
}

async function askStructured({ apiKey, model, maxTokens, effort, system, content, jsonSchema, timeoutMs, maxRetries }) {
  const api = getClient(apiKey, timeoutMs, maxRetries);
  try {
    const message = await api.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: toAnthropicContent(content) }],
      output_config: { effort, format: { type: 'json_schema', schema: jsonSchema } },
    });

    const stopReason = normalizeStopReason(message.stop_reason);
    if (stopReason === 'refusal') {
      return {
        ok: false,
        error: `Declined by safety classifiers${
          message.stop_details?.category ? ` (${message.stop_details.category})` : ''
        }.`,
      };
    }

    return {
      ok: true,
      text: message.content.find((b) => b.type === 'text')?.text || '',
      stopReason,
      usage: message.usage,
      model: message.model,
    };
  } catch (err) {
    const described = describeError(err, model);
    return { ok: false, error: described.message, aborted: described.aborted };
  }
}

async function askStreaming({ apiKey, model, maxTokens, effort, system, messages, onDelta, registerAbort, timeoutMs, maxRetries }) {
  const api = getClient(apiKey, timeoutMs, maxRetries);
  const wireMessages = messages.map((m) => ({ ...m, content: toAnthropicContent(m.content) }));
  // Tracked locally (separate from ai.js's own accumulation) purely to decide
  // whether a retry-without-fallback is still safe below — Anthropic validates
  // the beta header before any token flows, so this is realistically always
  // false when the beta-rejection branch fires, but the check is kept exact
  // rather than assumed.
  let streamedAnyText = false;

  const startStream = (withFallbacks) => {
    const request = {
      model,
      max_tokens: maxTokens,
      system,
      messages: wireMessages,
      output_config: { effort },
    };
    if (withFallbacks) {
      // Opus 5's safety classifiers can decline outright. Server-side fallbacks
      // re-run the request on a suitable model in the same call. Anthropic-only
      // — no other provider has an equivalent, so this stays adapter-local.
      request.betas = ['server-side-fallback-2026-07-01'];
      request.fallbacks = 'default';
    }

    const stream = withFallbacks ? api.beta.messages.stream(request) : api.messages.stream(request);
    if (registerAbort) registerAbort(() => stream.abort());
    stream.on('text', (delta) => {
      streamedAnyText = true;
      onDelta(delta);
    });
    return stream.finalMessage();
  };

  try {
    let message;
    try {
      message = await startStream(true);
    } catch (err) {
      // Accounts without the fallback beta reject the parameter. That is a
      // hardening feature, not the request — retry plainly rather than losing
      // the whole answer over it. But not if real text already streamed: at
      // that point a later error is a genuine failure, not a beta rejection.
      const rejectedBeta = err?.status === 400 && /fallback|beta/i.test(err?.message || '');
      if (!rejectedBeta || streamedAnyText) throw err;
      message = await startStream(false);
    }

    return {
      ok: true,
      stopReason: normalizeStopReason(message.stop_reason),
      usage: message.usage,
      model: message.model,
    };
  } catch (err) {
    const described = describeError(err, model);
    return { ok: false, error: described.message, aborted: described.aborted };
  } finally {
    if (registerAbort) registerAbort(null);
  }
}

async function validate({ apiKey, model }) {
  try {
    const probe = new Anthropic({ apiKey, timeout: 15000, maxRetries: 0 });
    await probe.models.retrieve(model);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err, model).message };
  }
}

module.exports = { id: 'anthropic', needsKey: true, askStructured, askStreaming, validate, invalidateClient };
