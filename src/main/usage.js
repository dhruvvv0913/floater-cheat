'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Token and cost accounting.
 *
 * Without this you have no idea what the tool costs until the invoice arrives —
 * and vision requests are not cheap: a full-screen capture can run to ~4,800
 * input tokens on its own, so the image dominates the bill on short answers.
 */

// USD per million tokens. Cache reads bill at ~0.1x input, writes at ~1.25x.
const PRICING = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-5:fast': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // Snapshot pricing, same caveat as the Claude rows above — check
  // platform.openai.com/pricing if a number here looks stale.
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
};
const FALLBACK_PRICE = { input: 5, output: 25 };
// Local inference is free regardless of which model was pulled — a lookup
// table can't enumerate every model name a user might run through Ollama, so
// this is a provider-level short-circuit rather than a per-model entry.
const FREE_PRICE = { input: 0, output: 0 };

const FILE = 'usage.json';

const session = blank();
let lifetime = null;

function blank() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
}

function file() {
  return path.join(app.getPath('userData'), FILE);
}

function loadLifetime() {
  if (lifetime) return lifetime;
  try {
    lifetime = { ...blank(), ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    lifetime = blank();
  }
  return lifetime;
}

function saveLifetime() {
  try {
    fs.writeFileSync(file(), JSON.stringify(loadLifetime(), null, 2), 'utf8');
  } catch {
    // Accounting is not worth crashing over.
  }
}

function priceFor(model, providerId, fast) {
  if (providerId === 'ollama') return FREE_PRICE;
  return PRICING[`${model}${fast ? ':fast' : ''}`] || PRICING[model] || FALLBACK_PRICE;
}

function estimateCost(usage, model, providerId, fast) {
  const price = priceFor(model, providerId, fast);
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  return (
    (input * price.input +
      output * price.output +
      cacheRead * price.input * 0.1 +
      cacheWrite * price.input * 1.25) /
    1_000_000
  );
}

/** @returns {number} cost of this single request, in USD. */
function record(usage, model, providerId, { fast = false } = {}) {
  if (!usage) return 0;
  const cost = estimateCost(usage, model, providerId, fast);
  const total = loadLifetime();

  for (const bucket of [session, total]) {
    bucket.requests += 1;
    bucket.inputTokens += usage.input_tokens || 0;
    bucket.outputTokens += usage.output_tokens || 0;
    bucket.cacheReadTokens += usage.cache_read_input_tokens || 0;
    bucket.costUsd += cost;
  }

  saveLifetime();
  return cost;
}

function snapshot() {
  return { session: { ...session }, lifetime: { ...loadLifetime() } };
}

/** Has the configured budget been exceeded? Null budget means uncapped. */
function overBudget(budgetUsd) {
  if (!budgetUsd || budgetUsd <= 0) return false;
  return loadLifetime().costUsd >= budgetUsd;
}

function resetLifetime() {
  lifetime = blank();
  saveLifetime();
}

module.exports = { record, snapshot, overBudget, resetLifetime, estimateCost, PRICING };
