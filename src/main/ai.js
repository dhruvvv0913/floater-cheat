'use strict';

const config = require('./config');
const secrets = require('./secrets');
const usage = require('./usage');
const log = require('./logger');
const anthropicProvider = require('./providers/anthropic');
const ollamaProvider = require('./providers/ollama');
const openaiProvider = require('./providers/openai');
const geminiProvider = require('./providers/gemini');

/**
 * The provider-agnostic core: prompts, history, cost accounting, budget
 * enforcement. Everything that actually talks to an SDK lives in
 * src/main/providers/*.js — this file only knows the adapter interface
 * documented at the top of providers/anthropic.js (askStructured /
 * askStreaming / validate), never a specific vendor's request shape.
 *
 * Only one provider exists today, so `getActiveProvider()` always returns the
 * Anthropic adapter. That's the seam future providers plug into.
 *
 * Two modes with genuinely different shapes:
 *
 *   terse  one keypress, structured JSON out. Not streamed — the payload is a
 *          handful of words, so streaming buys nothing, and a schema buys a
 *          guaranteed format plus the two fields that make the answer
 *          trustworthy: what the model thought the question was, and how sure
 *          it is. Prompt instructions alone gave neither reliably.
 *
 *   chat   typed follow-ups, streamed token by token. Free-form prose where
 *          time-to-first-token is what the user feels.
 */

const CHAT_PROMPT = [
  'You are a private assistant in a small always-on-top overlay panel, roughly',
  '380px wide, sitting over whatever the user is doing.',
  '',
  'When a screenshot is attached it shows the screen behind the panel. Read it',
  'carefully and answer about what is actually visible — quote exact text,',
  'identifiers and values rather than paraphrasing. If the screenshot does not',
  'contain what you would need, say so instead of guessing.',
  '',
  'Lead with the answer in the first sentence; supporting detail after, only if',
  'it changes what the reader does next. The panel is small, so keep responses',
  'tight and skip preamble, restatement of the question, and sign-offs.',
].join('\n');

const TERSE_PROMPT = [
  'You read a screenshot and return the answer to the question on it.',
  '',
  'question: restate the question you are answering, in under 12 words, so the',
  'user can confirm you read the right one. If several questions are visible,',
  'answer the most prominent or most complete one and say which in this field.',
  '',
  'answer: the answer alone.',
  '- Multiple choice: the option letter, an em dash, then at most six words of',
  '  the option text. Example: "C — 4.18 kJ/kg·K".',
  '- Numeric: the value with units, nothing else.',
  '- Short answer: one sentence under 25 words.',
  '- Code: the corrected line or direct answer, in a fenced block.',
  '- No working, no explanation, no restating the question.',
  '',
  'confidence: "high" only if the question is fully legible and you are sure.',
  '"low" if the text is cut off, ambiguous, or outside what you can determine',
  'from the image. Do not inflate this — a flagged low-confidence answer is far',
  'more useful than a confident wrong one.',
].join('\n');

const TERSE_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The question being answered, under 12 words.' },
    answer: { type: 'string', description: 'The answer alone, no explanation.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['question', 'answer', 'confidence'],
  additionalProperties: false,
};

const ONE_SHOT_QUESTION = 'Answer the question on screen.';

let history = [];
let currentAbort = null; // set by the active adapter while a stream is in flight

// The registry of adapters that actually exist in code. This is the single
// place a new provider gets wired in — add the require, add the id here, and
// it becomes selectable in Settings automatically (main/index.js only offers
// ids present in this object). More may be documented in
// config.MODEL_CATALOG than are registered here; an entry with no adapter is
// just inert suggested-models data.
const PROVIDERS = {
  anthropic: anthropicProvider,
  ollama: ollamaProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
};

/** Falls back to Anthropic if config somehow holds an id with no adapter. */
function getActiveProvider() {
  const id = config.get('ai').provider;
  return PROVIDERS[id] || PROVIDERS.anthropic;
}

const availableProviders = () => Object.keys(PROVIDERS);
const activeProviderId = () => getActiveProvider().id;
const activeProviderNeedsKey = () => getActiveProvider().needsKey;

/**
 * Images dominate token cost, and only the newest one is being asked about.
 * Operates on ai.js's own canonical message shape (see buildUserContent) —
 * provider-agnostic, so this doesn't move to the adapters.
 */
function historyForRequest() {
  const lastUser = history.map((m) => m.role).lastIndexOf('user');
  return history.map((message, index) => {
    if (index === lastUser || !Array.isArray(message.content)) return message;
    const text = message.content.filter((block) => block.type !== 'image');
    return { ...message, content: text.length ? text : [{ type: 'text', text: '(screenshot)' }] };
  });
}

/** Canonical content blocks every adapter accepts and translates to its own wire shape. */
function buildUserContent(question, image) {
  const content = [];
  if (image) {
    // Image before text: Claude attends better to a question asked about an
    // image it has already seen; keeping the same order for every provider.
    content.push({ type: 'image', mediaType: image.mediaType, base64: image.base64 });
  }
  content.push({ type: 'text', text: question });
  return content;
}

function trimHistory() {
  const max = config.get('ai').historyTurns * 2;
  if (history.length > max) history = history.slice(-max);
}

function budgetBlocked() {
  const { budgetUsd } = config.get('ai');
  if (!usage.overBudget(budgetUsd)) return null;
  return {
    ok: false,
    error: `Budget of $${budgetUsd.toFixed(2)} reached. Raise or reset it in Settings.`,
  };
}

function missingKeyResult() {
  return { ok: false, error: 'No API key. Open Settings from the tray, or set ANTHROPIC_API_KEY.' };
}

/* ------------------------------------------------------------------ terse */

/**
 * One-shot structured answer. Not streamed — see the note at the top.
 *
 * @param {object}  opts
 * @param {object}  [opts.image]          screenshot to read, or
 * @param {string}  [opts.text]           text to answer about (e.g. clipboard)
 * @param {string}  [opts.effortOverride] force an effort level for this call
 * @returns {Promise<{ok, question?, answer?, confidence?, usage?, costUsd?, ms?, error?}>}
 */
async function askTerse({ image = null, text = '', effortOverride = null } = {}) {
  const provider = getActiveProvider();
  const apiKey = secrets.getKey(provider.id);
  if (provider.needsKey && !apiKey) return missingKeyResult();

  const blocked = budgetBlocked();
  if (blocked) return blocked;

  const settings = config.get('ai');
  const started = Date.now();
  const prompt = text ? `Answer this question:\n\n${text}` : ONE_SHOT_QUESTION;

  const result = await provider.askStructured({
    apiKey,
    model: settings.model,
    maxTokens: settings.maxTokens,
    effort: effortOverride || settings.effort,
    system: TERSE_PROMPT,
    content: buildUserContent(prompt, image),
    jsonSchema: TERSE_SCHEMA,
    timeoutMs: settings.timeoutMs,
    maxRetries: settings.maxRetries,
    baseUrl: config.get('ollama').baseUrl, // only read by the Ollama adapter
  });

  if (!result.ok) {
    log.error('[ai] terse failed:', result.error);
    return { ok: false, error: result.error, aborted: result.aborted };
  }

  const ms = Date.now() - started;
  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    // Schema enforcement should make this unreachable; degrade rather than
    // throwing away an answer we already paid for.
    log.warn('[ai] terse response was not valid JSON, using raw text');
    parsed = { question: '', answer: (result.text || '').trim(), confidence: 'low' };
  }

  const costUsd = usage.record(result.usage, result.model || settings.model, provider.id);
  log.info(
    `[ai] terse ${ms}ms · ${result.usage?.input_tokens || 0} in / ` +
      `${result.usage?.output_tokens || 0} out · $${costUsd.toFixed(4)} · ${parsed.confidence}`
  );

  // Record it so a follow-up ("explain") afterwards has the context. Honour
  // the retention switch — a user who turned history off wants nothing kept.
  if (config.get('ai').keepHistory !== false) {
    history.push({ role: 'user', content: buildUserContent(prompt, image) });
    history.push({ role: 'assistant', content: [{ type: 'text', text: parsed.answer }] });
    trimHistory();
  }

  return {
    ok: true,
    question: parsed.question || '',
    answer: parsed.answer || '',
    confidence: parsed.confidence || 'medium',
    usage: result.usage,
    costUsd,
    ms,
    model: result.model,
  };
}

/* ------------------------------------------------------------------- chat */

async function askChat(question, image, onDelta) {
  const provider = getActiveProvider();
  const apiKey = secrets.getKey(provider.id);
  if (provider.needsKey && !apiKey) return missingKeyResult();

  const blocked = budgetBlocked();
  if (blocked) return blocked;

  const settings = config.get('ai');
  const started = Date.now();
  let firstTokenAt = 0;
  let answer = '';

  history.push({ role: 'user', content: buildUserContent(question, image) });

  currentAbort = null;
  const result = await provider.askStreaming({
    apiKey,
    model: settings.model,
    maxTokens: settings.maxTokens,
    effort: settings.effort,
    system: CHAT_PROMPT,
    messages: historyForRequest(),
    onDelta: (delta) => {
      if (!firstTokenAt) firstTokenAt = Date.now();
      answer += delta;
      onDelta(delta);
    },
    registerAbort: (fn) => {
      currentAbort = fn;
    },
    timeoutMs: settings.timeoutMs,
    maxRetries: settings.maxRetries,
    baseUrl: config.get('ollama').baseUrl, // only read by the Ollama adapter
  });
  currentAbort = null;

  if (!result.ok) {
    if (result.aborted && answer) {
      history.push({ role: 'assistant', content: [{ type: 'text', text: answer }] });
      trimHistory();
    } else {
      history.pop();
    }
    log.error('[ai] chat failed:', result.error);
    return { ok: false, error: result.error, aborted: result.aborted };
  }

  if (result.stopReason === 'refusal') {
    history.pop();
    return { ok: false, error: 'Declined by safety classifiers.' };
  }
  if (!answer) {
    history.pop();
    return { ok: false, error: 'The model returned an empty response.' };
  }

  const costUsd = usage.record(result.usage, result.model || settings.model, provider.id);
  log.info(
    `[ai] chat ttft ${firstTokenAt - started}ms · total ${Date.now() - started}ms · ` +
      `$${costUsd.toFixed(4)}`
  );

  if (config.get('ai').keepHistory === false) {
    history = []; // the turn above was transient — retain nothing
  } else {
    history.push({ role: 'assistant', content: [{ type: 'text', text: answer }] });
    trimHistory();
  }

  return {
    ok: true,
    text: answer,
    usage: result.usage,
    costUsd,
    ttftMs: firstTokenAt ? firstTokenAt - started : null,
    ms: Date.now() - started,
    model: result.model,
  };
}

/* ----------------------------------------------------------------- misc */

/**
 * Cheap auth check so a bad key fails at save time rather than on first real
 * use.
 */
async function validateKey(key) {
  return getActiveProvider().validate({
    apiKey: key,
    model: config.get('ai').model,
    baseUrl: config.get('ollama').baseUrl,
  });
}

function cancel() {
  if (currentAbort) {
    currentAbort();
    return true;
  }
  return false;
}

/** Invalidate the ACTIVE provider's cached client — e.g. after its key changes. */
function invalidateClient() {
  getActiveProvider().invalidateClient?.();
}

const clearHistory = () => {
  history = [];
};
const isBusy = () => currentAbort !== null;

module.exports = {
  askTerse,
  askChat,
  cancel,
  clearHistory,
  isBusy,
  validateKey,
  invalidateClient,
  availableProviders,
  activeProviderId,
  activeProviderNeedsKey,
};
