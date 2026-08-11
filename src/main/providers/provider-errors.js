'use strict';

/**
 * Shared HTTP-status-code error classification for the three adapters whose
 * SDKs are REST clients with real status codes (Anthropic, OpenAI, Gemini).
 *
 * Ollama is deliberately NOT built on this. Its failures are almost always
 * transport-level — connection refused, timeout — not HTTP status codes from
 * an authenticated API, so it keeps its own describeFetchError in
 * providers/ollama.js rather than being forced through a status-code shape
 * that doesn't fit what actually goes wrong with a local server.
 *
 * `errorClasses` lets a caller supply its SDK's typed exception classes for a
 * belt-and-suspenders check alongside the raw status code. instanceof is more
 * precise when a matching class exists, but every adapter's errors also carry
 * `.status` directly (confirmed against each SDK's real type defs before
 * this was written), so the status-code branch is what actually carries the
 * mapping — a provider with no typed classes at all (Gemini has one flat
 * ApiError, not per-code classes) still classifies correctly from status
 * alone.
 */

function matchesClass(err, cls) {
  return typeof cls === 'function' && err instanceof cls;
}

/**
 * @param {unknown} err
 * @param {object} opts
 * @param {string}  opts.providerLabel   e.g. "Anthropic", "OpenAI", "Gemini" — used in the 5xx fallback message
 * @param {string}  opts.model
 * @param {boolean} [opts.autoRetries]   true if this adapter's client actually retries 429/5xx itself
 * @param {object}  [opts.errorClasses]  optional { Abort, Authentication, PermissionDenied, NotFound, RateLimit, Connection }
 * @returns {{message: string, aborted?: boolean}}
 */
function classifyStatusError(err, { providerLabel, model, autoRetries = false, errorClasses = {} }) {
  if (matchesClass(err, errorClasses.Abort) || err?.name === 'AbortError' || /aborted/i.test(err?.message || '')) {
    return { aborted: true, message: 'Stopped.' };
  }

  const status = err?.status;

  if (matchesClass(err, errorClasses.Authentication) || status === 401) {
    return { message: 'API key rejected (401). Check it in Settings.' };
  }
  if (matchesClass(err, errorClasses.PermissionDenied) || status === 403) {
    return { message: 'This key cannot access that model (403).' };
  }
  if (matchesClass(err, errorClasses.NotFound) || status === 404) {
    return { message: `Model "${model}" not found (404).` };
  }
  if (matchesClass(err, errorClasses.RateLimit) || status === 429) {
    return {
      message: autoRetries
        ? 'Rate limited. The SDK already retried — wait a moment.'
        : 'Rate limited. Wait a moment and try again.',
    };
  }
  if (
    matchesClass(err, errorClasses.Connection) ||
    /ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(err?.message || '')
  ) {
    return { message: 'Could not reach the API. Check your network connection.' };
  }
  if (status >= 500) return { message: `${providerLabel} API error (${status}).` };

  return { message: err?.message || 'Unknown error.' };
}

module.exports = { classifyStatusError };
