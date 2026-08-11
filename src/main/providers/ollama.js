'use strict';

/**
 * Ollama adapter — a local model server, no API key, nothing leaves the
 * machine. No SDK dependency: Ollama's HTTP API is simple enough that plain
 * `fetch` (global since Node 18) is the right tool, and it keeps this
 * provider's install cost at zero.
 *
 * Two real differences from the hosted providers, both because the model is
 * local:
 *   - no `effort`/`maxRetries` concept — accepted in the call signature for
 *     interface consistency with the other adapters, intentionally unused.
 *   - structured output is best-effort. Ollama's JSON-schema `format` support
 *     (>=0.5) varies by model, so a response that fails to parse gets ONE
 *     repair retry asking explicitly for valid JSON before giving up — see
 *     askStructured.
 */

const DEFAULT_TIMEOUT_MS = 60000;

/** Canonical content blocks -> Ollama's flat {content, images} shape. */
function splitCanonicalContent(blocks) {
  const textParts = [];
  const images = [];
  for (const block of blocks || []) {
    if (block.type === 'image') images.push(block.base64); // raw base64, no data-URL prefix
    else textParts.push(block.text);
  }
  return { text: textParts.join('\n'), images };
}

function toOllamaMessage(message) {
  const { text, images } = splitCanonicalContent(message.content);
  const out = { role: message.role, content: text };
  if (images.length) out.images = images;
  return out;
}

function normalizeUsage(data) {
  // Ollama's own field names — no cache-read/write concept locally.
  return { input_tokens: data?.prompt_eval_count || 0, output_tokens: data?.eval_count || 0 };
}

async function describeHttpError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error ? `: ${body.error}` : '';
  } catch {
    // Non-JSON error body — the status code alone is still useful.
  }
  return `Ollama responded with ${res.status}${detail}.`;
}

function describeFetchError(err, baseUrl) {
  if (err?.name === 'AbortError') return { aborted: true, message: 'Stopped.' };
  if (err?.name === 'TimeoutError') return { message: `Ollama did not respond in time (${baseUrl}).` };
  const code = err?.cause?.code || err?.code;
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(err?.message || '')) {
    return { message: `Ollama isn't running at ${baseUrl}. Start it, then try again.` };
  }
  return { message: err?.message || `Could not reach Ollama at ${baseUrl}.` };
}

async function askStructured({ model, maxTokens, system, content, jsonSchema, baseUrl, timeoutMs }) {
  const { text: prompt, images } = splitCanonicalContent(content);
  const userMessage = { role: 'user', content: prompt };
  if (images.length) userMessage.images = images;

  const body = {
    model,
    messages: [{ role: 'system', content: system }, userMessage],
    stream: false,
    format: jsonSchema,
    options: { num_predict: maxTokens },
  };

  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: await describeHttpError(res) };

    let data = await res.json();
    let text = data.message?.content || '';

    try {
      JSON.parse(text);
    } catch {
      // Local models are flakier about honoring a schema than a hosted API —
      // one explicit repair pass before surfacing an error, per the note at
      // the top of this file.
      const repairBody = {
        ...body,
        messages: [
          ...body.messages,
          { role: 'assistant', content: text },
          { role: 'user', content: 'Reply with ONLY valid JSON matching the required shape. No prose, no markdown fences.' },
        ],
      };
      const repairRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(repairBody),
        signal: AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS),
      });
      if (repairRes.ok) {
        data = await repairRes.json();
        text = data.message?.content || text;
      }
    }

    return { ok: true, text, stopReason: 'end_turn', usage: normalizeUsage(data), model: data.model || model };
  } catch (err) {
    const described = describeFetchError(err, baseUrl);
    return { ok: false, error: described.message, aborted: described.aborted };
  }
}

async function askStreaming({ model, maxTokens, system, messages, onDelta, registerAbort, baseUrl, timeoutMs }) {
  const wireMessages = [{ role: 'system', content: system }, ...messages.map(toOllamaMessage)];
  const controller = new AbortController();
  const timeoutSignal = AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS);
  const signal = AbortSignal.any([controller.signal, timeoutSignal]);
  if (registerAbort) registerAbort(() => controller.abort());

  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: wireMessages, stream: true, options: { num_predict: maxTokens } }),
      signal,
    });
    if (!res.ok) return { ok: false, error: await describeHttpError(res) };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let final = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        const event = JSON.parse(line); // Ollama's stream is newline-delimited JSON, never SSE framing
        if (event.message?.content) onDelta(event.message.content);
        if (event.done) final = event;
      }
    }

    if (!final) return { ok: false, error: 'Ollama stream ended without a final response.' };
    return { ok: true, stopReason: 'end_turn', usage: normalizeUsage(final), model: final.model || model };
  } catch (err) {
    const described = describeFetchError(err, baseUrl);
    return { ok: false, error: described.message, aborted: described.aborted };
  } finally {
    if (registerAbort) registerAbort(null);
  }
}

async function validate({ model, baseUrl }) {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, error: `Ollama responded with ${res.status}.` };
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name);
    const hasModel = names.some((n) => n === model || n.startsWith(`${model}:`));
    if (!hasModel) {
      return { ok: false, error: `Model "${model}" is not pulled locally. Run: ollama pull ${model}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeFetchError(err, baseUrl).message };
  }
}

module.exports = { id: 'ollama', needsKey: false, askStructured, askStreaming, validate };
