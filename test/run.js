'use strict';

/**
 * Headless integration harness.
 *
 * The real AI pipeline has never touched the network (no key), so this stubs
 * `electron` and `@anthropic-ai/sdk` at the module loader and drives the actual
 * production modules — config, usage, secrets, capture math, and the ai client
 * — against scripted API responses. It verifies the plumbing that a "does it
 * launch" check cannot: JSON parsing, history retention, cost accounting,
 * error mapping, and streaming.
 *
 * Run with:  node test/run.js
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const Module = require('module');

/* ------------------------------------------------- fake userData location */

const USERDATA = path.join(os.tmpdir(), `floater-test-${process.pid}`);
fs.mkdirSync(USERDATA, { recursive: true });
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'; // so secrets.getKey() resolves

/* -------------------------------------------------------- scripted SDK ---- */

// The test sets these before each call; the fake client delegates to them.
// lastRequest captures whatever payload the ai module actually sent, so tests
// can assert on the messages/history/effort that reached the "API".
const mock = {
  create: async () => ({ content: [], stop_reason: 'end_turn', usage: {}, model: 'x' }),
  stream: () => streamOf(['(no script)']),
  retrieve: async () => ({}),
  lastRequest: null,
};

function streamOf(chunks, final = {}) {
  let onText = null;
  return {
    on(event, cb) {
      if (event === 'text') onText = cb;
      return this;
    },
    async finalMessage() {
      for (const c of chunks) if (onText) onText(c);
      return {
        stop_reason: 'end_turn',
        usage: { input_tokens: 1200, output_tokens: 40 },
        model: 'claude-opus-5',
        content: [{ type: 'text', text: chunks.join('') }],
        ...final,
      };
    },
    abort() {},
  };
}

class FakeAnthropic {
  constructor() {
    const create = (r) => {
      mock.lastRequest = r;
      return mock.create(r);
    };
    const stream = (r) => {
      mock.lastRequest = r;
      return mock.stream(r);
    };
    this.messages = { create, stream };
    this.beta = { messages: { create, stream } };
    this.models = { retrieve: (id) => mock.retrieve(id) };
  }
}
// ai.js does `err instanceof Anthropic.AuthenticationError` — provide the classes.
for (const name of [
  'AuthenticationError',
  'PermissionDeniedError',
  'NotFoundError',
  'RateLimitError',
  'APIConnectionError',
]) {
  FakeAnthropic[name] = class extends Error {};
}
FakeAnthropic.Anthropic = FakeAnthropic;

// Separate mock namespace so Anthropic and OpenAI adapter tests never
// interfere with each other's scripted responses.
const mockOpenAI = {
  create: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'stop' }], usage: {}, model: 'x' }),
  // Streaming responses are async-iterable in the real SDK — tests assign an
  // async generator here, e.g. `mockOpenAI.createStream = () => (async
  // function*(){ yield {...}; })();`.
  createStream: () => (async function* () {})(),
  retrieve: async () => ({}),
  lastRequest: null,
  lastOpts: null,
};

class FakeOpenAI {
  constructor() {
    this.chat = {
      completions: {
        create: (body, opts) => {
          mockOpenAI.lastRequest = body;
          mockOpenAI.lastOpts = opts;
          return body.stream ? mockOpenAI.createStream(body) : mockOpenAI.create(body);
        },
      },
    };
    this.models = { retrieve: (id) => mockOpenAI.retrieve(id) };
  }
}
for (const name of [
  'AuthenticationError',
  'PermissionDeniedError',
  'NotFoundError',
  'RateLimitError',
  'APIConnectionError',
  'APIUserAbortError',
]) {
  FakeOpenAI[name] = class extends Error {};
}
FakeOpenAI.OpenAI = FakeOpenAI;

// The real GenerateContentResponse.text is a getter computed from
// candidates[0].content.parts, but a plain data property with the same name
// is indistinguishable to code that only ever reads `response.text` (which is
// all the adapter does) — no need to replicate the getter mechanism.
const mockGemini = {
  generateContent: async () => ({ candidates: [{ finishReason: 'STOP' }], usageMetadata: {}, text: '' }),
  generateContentStream: async () => (async function* () {})(),
  getModel: async () => ({}),
  lastParams: null,
};

class FakeGoogleGenAI {
  constructor() {
    this.models = {
      generateContent: (params) => {
        mockGemini.lastParams = params;
        return mockGemini.generateContent(params);
      },
      generateContentStream: (params) => {
        mockGemini.lastParams = params;
        return mockGemini.generateContentStream(params);
      },
      get: (params) => mockGemini.getModel(params),
    };
  }
}
class FakeApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/* ---------------------------------------------------------- fake electron */

const fakeElectron = {
  app: {
    getPath: () => USERDATA,
    isPackaged: false,
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: () => {},
    on: () => {},
  },
  safeStorage: {
    // Force the env-var fallback path in secrets.js.
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(s),
    decryptString: (b) => b.toString(),
  },
  screen: {
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }),
    getDisplayMatching: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }),
    getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    on: () => {},
  },
  BrowserWindow: class {},
  desktopCapturer: { getSources: async () => [] },
  nativeImage: {},
  nativeTheme: { shouldUseDarkColors: true, on: () => {} },
  globalShortcut: {
    _registered: new Map(), // keys THIS app currently holds
    _externallyOwned: new Set(), // keys a (simulated) other app holds — survives our unregisterAll
    register(accelerator, handler) {
      if (this._externallyOwned.has(accelerator) || this._registered.has(accelerator)) return false;
      this._registered.set(accelerator, handler);
      return true;
    },
    unregisterAll() {
      // Real OS behavior: releases only what THIS app registered, never what
      // another application holds.
      this._registered.clear();
    },
  },
};

/* ----------------------------------------------------------- fetch (ollama) */

// The Ollama adapter uses plain global fetch (no SDK), so it's mocked at that
// level instead of the module loader. Real Response/ReadableStream — not hand
// -rolled fakes — so the adapter's actual .json() / streaming-reader code runs.
let fetchImpl = async () => {
  throw new Error('fetch not mocked for this test');
};
global.fetch = (...args) => fetchImpl(...args);

function ndjsonStream(lines) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      controller.close();
    },
  });
}

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (request === '@anthropic-ai/sdk') return FakeAnthropic;
  if (request === 'openai') return FakeOpenAI;
  if (request === '@google/genai') return { GoogleGenAI: FakeGoogleGenAI, ApiError: FakeApiError };
  return realLoad.call(this, request, parent, isMain);
};

/* ----------------------------------------------------------------- runner */

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

async function main() {
  const config = require('../src/main/config');
  const usage = require('../src/main/usage');
  const secrets = require('../src/main/secrets');
  const capture = require('../src/main/capture');
  const ai = require('../src/main/ai');

  console.log('shortcut-utils (pure functions)');
  const { findConflicts, isValidAccelerator } = require('../src/main/shortcut-utils');
  const conflicts = findConflicts({ a: 'Control+Shift+Space', b: 'Control+Shift+Space', c: 'Control+Shift+Enter' });
  check('findConflicts catches two actions on the same key', conflicts.length === 1 && conflicts[0].a === 'a' && conflicts[0].b === 'b', JSON.stringify(conflicts));
  const conflictsCI = findConflicts({ a: 'Control+Shift+X', b: 'shift+control+x' });
  check('findConflicts is case/order insensitive', conflictsCI.length === 1, JSON.stringify(conflictsCI));
  check('findConflicts returns [] when everything is unique', findConflicts({ a: 'Control+A', b: 'Control+B' }).length === 0);
  check('findConflicts ignores empty/missing accelerators', findConflicts({ a: '', b: null, c: undefined }).length === 0);
  check('isValidAccelerator accepts a normal binding', isValidAccelerator('Control+Shift+Space') === true);
  check('isValidAccelerator rejects modifiers-only', isValidAccelerator('Control+Shift') === false);
  check('isValidAccelerator rejects empty string', isValidAccelerator('') === false);
  check('isValidAccelerator rejects a trailing +', isValidAccelerator('Control+Shift+') === false);
  check('isValidAccelerator rejects non-string input', isValidAccelerator(null) === false);

  console.log('hotkeys.registerAll (conflict vs invalid vs OS-unavailable)');
  const hotkeys = require('../src/main/hotkeys');
  const savedHotkeys = { ...config.get('hotkeys') }; // shallow clone — restore when done
  config.set('hotkeys', {
    ...config.get('hotkeys'),
    answer: 'Control+Shift+Space',
    ask: 'Control+Shift+Space', // deliberate clash with 'answer'
    selfTest: 'Control+Shift', // deliberate: modifiers only, invalid
  });
  fakeElectron.globalShortcut._externallyOwned.add('Control+Shift+P'); // simulate another app holding it
  config.set('hotkeys', { ...config.get('hotkeys'), toggleProtection: 'Control+Shift+P' });
  const noop = () => {};
  const handlers = Object.fromEntries(Object.keys(config.get('hotkeys')).map((k) => [k, noop]));
  const regFailures = hotkeys.registerAll(handlers);
  const byAction = Object.fromEntries(regFailures.map((f) => [f.action, f.reason]));
  check('conflicting actions are both reported with reason "conflict"', byAction.answer === 'conflict' && byAction.ask === 'conflict', JSON.stringify(byAction));
  check('a modifiers-only accelerator is reported "invalid"', byAction.selfTest === 'invalid', JSON.stringify(byAction));
  check('an OS-claimed accelerator is reported "unavailable"', byAction.toggleProtection === 'unavailable', JSON.stringify(byAction));
  check('a clean binding registers with no failure entry', !('answerClipboard' in byAction), JSON.stringify(byAction));
  hotkeys.unregisterAll();
  fakeElectron.globalShortcut._externallyOwned.clear();
  config.set('hotkeys', savedHotkeys); // restore for any later section

  console.log('config');
  check('defaults load with nested keys', config.get('hover').pollMs === 60);
  check('MODEL_CATALOG exported per provider', Array.isArray(config.MODEL_CATALOG.anthropic) && config.MODEL_CATALOG.anthropic.includes('claude-opus-5'));
  check('default ai.provider is anthropic', config.get('ai').provider === 'anthropic');
  check('theme defaults to dark', config.get('theme') === 'dark');
  config.set('opacity', 0.5);
  check('set/get roundtrip', config.get('opacity') === 0.5);
  config.set('opacity', 0.96);

  console.log('theme — stylesheet has a light override for every surface var');
  const css = fs.readFileSync(path.resolve(__dirname, '../src/renderer/styles.css'), 'utf8');
  const lightBlock = css.slice(css.indexOf('[data-theme="light"]'));
  for (const v of ['--bg', '--text', '--surface', '--input-bg', '--code-bg', '--pre-bg', '--border']) {
    check(`light theme overrides ${v}`, new RegExp(`${v}\\s*:`).test(lightBlock.slice(0, lightBlock.indexOf('}'))));
  }

  console.log('secrets — per-provider storage');
  check('falls back to ANTHROPIC_API_KEY env for the anthropic provider', secrets.getKey('anthropic') === 'sk-ant-test-key');
  check('status reports env source', secrets.status('anthropic').source === 'ANTHROPIC_API_KEY');
  check('a provider with no env var mapping and no stored key is unconfigured', secrets.status('gemini').configured === false);
  check('envVarFor exposes the mapping for each known provider', secrets.envVarFor('openai') === 'OPENAI_API_KEY' && secrets.envVarFor('gemini') === 'GEMINI_API_KEY');

  console.log('secrets — old single-key filename still resolves under the new signature');
  // Before this became multi-provider, the one stored key lived at literally
  // `anthropic-key.bin`. `${provider}-key.bin` produces that exact path for
  // provider === 'anthropic', so an existing user's key must be found with NO
  // migration step — prove it by writing a file at that literal legacy path
  // (bypassing setKey, to simulate a key saved by the OLD code) and reading it
  // back through the NEW per-provider getKey().
  {
    const legacyPath = path.join(USERDATA, 'anthropic-key.bin');
    fs.writeFileSync(legacyPath, fakeElectron.safeStorage.encryptString('sk-ant-legacy-value'));
    // The rest of this harness runs with encryption "unavailable" to keep the
    // env-var-fallback tests simple — flip it on just for this check, since
    // the whole point here is exercising the stored-key path.
    fakeElectron.safeStorage.isEncryptionAvailable = () => true;
    delete process.env.ANTHROPIC_API_KEY; // force the stored-key path, not the env fallback
    check('a key written at the old literal filename is read by the new getKey(provider)', secrets.getKey('anthropic') === 'sk-ant-legacy-value');
    fakeElectron.safeStorage.isEncryptionAvailable = () => false; // restore
    fs.unlinkSync(legacyPath);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'; // restore for later sections
  }

  console.log('usage');
  const cost = usage.estimateCost({ input_tokens: 1000, output_tokens: 1000 }, 'claude-opus-5');
  check('opus-5 cost math (1k in / 1k out = $0.03)', near(cost, 0.03), `got ${cost}`);
  const haiku = usage.estimateCost({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-haiku-4-5');
  check('haiku input cost ($1/M)', near(haiku, 1), `got ${haiku}`);
  usage.resetLifetime();
  usage.record({ input_tokens: 2000, output_tokens: 100 }, 'claude-opus-5');
  check('record accumulates a request', usage.snapshot().lifetime.requests === 1);
  check('record accumulates cost', usage.snapshot().lifetime.costUsd > 0);
  check('overBudget true past cap', usage.overBudget(0.0001) === true);
  check('overBudget false when uncapped', usage.overBudget(0) === false);

  console.log('usage — ollama is always free, regardless of model name');
  const ollamaCost = usage.estimateCost({ input_tokens: 50_000, output_tokens: 5_000 }, 'llama3.2-vision', 'ollama');
  check('a known ollama model in the catalog costs $0', ollamaCost === 0, `got ${ollamaCost}`);
  const unknownOllamaCost = usage.estimateCost({ input_tokens: 50_000, output_tokens: 5_000 }, 'some-model-nobody-heard-of', 'ollama');
  check('an arbitrary/unrecognized ollama model ALSO costs $0 (provider-level, not a lookup table)', unknownOllamaCost === 0, `got ${unknownOllamaCost}`);
  const sameModelNonOllama = usage.estimateCost({ input_tokens: 50_000, output_tokens: 5_000 }, 'some-model-nobody-heard-of', 'anthropic');
  check('the same unrecognized model name under a DIFFERENT provider falls back to the paid default (not silently free)', sameModelNonOllama > 0, `got ${sameModelNonOllama}`);

  console.log('capture math');
  const fit = capture.fitWithin({ width: 2560, height: 1440 }, 1568);
  check('fitWithin scales the long edge to the cap', fit.width === 1568 && fit.height === 882, JSON.stringify(fit));
  check('fitWithin returns null when already small', capture.fitWithin({ width: 800, height: 600 }, 1568) === null);
  const px = capture.regionToPixels(
    { x: 100, y: 100, width: 200, height: 100 },
    { bounds: { x: 0, y: 0, width: 1000, height: 1000 } },
    { width: 2000, height: 2000 }
  );
  check('regionToPixels applies the DIP→pixel scale', px.x === 200 && px.y === 200 && px.width === 400 && px.height === 200, JSON.stringify(px));

  console.log('ai — terse (structured one-shot)');
  ai.clearHistory();
  mock.create = async () => ({
    content: [{ type: 'text', text: JSON.stringify({ question: 'Specific heat of water?', answer: 'B — 4.18 kJ/kg·K', confidence: 'high' }) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1500, output_tokens: 18 },
    model: 'claude-opus-5',
  });
  const terse = await ai.askTerse({ image: { mediaType: 'image/jpeg', base64: 'AA' } });
  check('terse ok', terse.ok, terse.error);
  check('terse parsed the extracted question', terse.question === 'Specific heat of water?');
  check('terse parsed the answer', terse.answer === 'B — 4.18 kJ/kg·K');
  check('terse parsed confidence', terse.confidence === 'high');
  check('terse computed a positive cost', terse.costUsd > 0, `${terse.costUsd}`);

  console.log('ai — refusal handling');
  mock.create = async () => ({ content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' }, usage: {}, model: 'claude-opus-5' });
  const refused = await ai.askTerse({ image: { mediaType: 'image/jpeg', base64: 'AA' } });
  check('refusal maps to a friendly error', !refused.ok && /declined/i.test(refused.error), refused.error);

  console.log('ai — error mapping');
  mock.create = async () => { throw { status: 401, message: 'unauthorized' }; };
  const unauth = await ai.askTerse({ image: { mediaType: 'image/jpeg', base64: 'AA' } });
  check('401 maps to key-rejected message', !unauth.ok && /401/.test(unauth.error), unauth.error);

  mock.create = async () => { throw { message: 'getaddrinfo ENOTFOUND api.anthropic.com' }; };
  const offline = await ai.askTerse({ image: { mediaType: 'image/jpeg', base64: 'AA' } });
  check('network error maps to connection message', !offline.ok && /network/i.test(offline.error), offline.error);

  console.log('ai — text (clipboard) mode');
  ai.clearHistory();
  mock.create = async () => ({
    content: [{ type: 'text', text: JSON.stringify({ question: 'Capital of France?', answer: 'Paris', confidence: 'high' }) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 40, output_tokens: 4 },
    model: 'claude-opus-5',
  });
  const clip = await ai.askTerse({ text: 'What is the capital of France?' });
  check('clipboard/text mode answers', clip.ok && clip.answer === 'Paris', clip.error);

  console.log('ai — chat (streaming)');
  ai.clearHistory();
  const deltas = [];
  mock.stream = () => streamOf(['Because ', 'water has ', 'a high specific heat.']);
  const chat = await ai.askChat('Explain', { mediaType: 'image/jpeg', base64: 'AA' }, (d) => deltas.push(d));
  check('chat ok', chat.ok, chat.error);
  check('chat streamed deltas', deltas.length === 3);
  check('chat assembled the full text', chat.text === 'Because water has a high specific heat.');
  check('chat measured time-to-first-token', typeof chat.ttftMs === 'number');

  console.log('ai — history retention (payload inspection)');
  const terseReply = async () => ({
    content: [{ type: 'text', text: JSON.stringify({ question: 'q', answer: 'a', confidence: 'low' }) }],
    stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 }, model: 'claude-opus-5',
  });

  // keepHistory ON: a terse turn is recorded, so the following chat request
  // carries the prior turns (terse user + assistant + new user = 3 messages).
  config.set('ai', { ...config.get('ai'), keepHistory: true });
  ai.clearHistory();
  mock.create = terseReply;
  await ai.askTerse({ image: { mediaType: 'image/jpeg', base64: 'AA' } });
  mock.stream = () => streamOf(['ok']);
  await ai.askChat('follow up', { mediaType: 'image/jpeg', base64: 'BB' }, () => {});
  check('keepHistory=true carries prior turns into the chat request', mock.lastRequest.messages.length === 3, `got ${mock.lastRequest.messages.length}`);
  // The older turn's screenshot must be stripped — only the newest image ships.
  const firstMsgHasImage = mock.lastRequest.messages[0].content.some?.((b) => b.type === 'image');
  check('older screenshots are stripped from history', !firstMsgHasImage);

  // keepHistory OFF: the terse turn is not recorded, so the chat request is a
  // single, standalone turn.
  config.set('ai', { ...config.get('ai'), keepHistory: false });
  ai.clearHistory();
  mock.create = terseReply;
  await ai.askTerse({ image: { mediaType: 'image/jpeg', base64: 'AA' } });
  mock.stream = () => streamOf(['ok']);
  await ai.askChat('standalone', null, () => {});
  check('keepHistory=false sends only the current turn', mock.lastRequest.messages.length === 1, `got ${mock.lastRequest.messages.length}`);
  config.set('ai', { ...config.get('ai'), keepHistory: true });

  console.log('ai — effort override (retry harder)');
  ai.clearHistory();
  mock.create = terseReply;
  await ai.askTerse({ image: { mediaType: 'image/jpeg', base64: 'AA' }, effortOverride: 'high' });
  check('effortOverride reaches the request', mock.lastRequest.output_config.effort === 'high', mock.lastRequest.output_config.effort);

  console.log('ai — budget cap');
  usage.resetLifetime();
  usage.record({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-opus-5'); // $5
  config.set('ai', { ...config.get('ai'), budgetUsd: 1 });
  const capped = await ai.askTerse({ image: { mediaType: 'image/jpeg', base64: 'AA' } });
  check('over-budget request is blocked before calling the API', !capped.ok && /budget/i.test(capped.error), capped.error);
  config.set('ai', { ...config.get('ai'), budgetUsd: 0 });
  usage.resetLifetime();

  console.log('usage — cache-read discount');
  usage.resetLifetime();
  const cached = usage.estimateCost({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }, 'claude-opus-5');
  check('cache reads bill at ~0.1x input ($0.50/M)', near(cached, 0.5), `got ${cached}`);

  console.log('provider-errors — shared classifier (direct unit tests)');
  const { classifyStatusError } = require('../src/main/providers/provider-errors');
  {
    const opts = { providerLabel: 'TestProvider', model: 'test-model' };
    check('classifies 401 as key-rejected from status code alone', classifyStatusError({ status: 401 }, opts).message.includes('401'));
    check('classifies 403 distinctly from 401', classifyStatusError({ status: 403 }, opts).message !== classifyStatusError({ status: 401 }, opts).message);
    check('classifies 404 with the model name interpolated', classifyStatusError({ status: 404 }, opts).message.includes('test-model'));
    check('classifies 429 with the non-retry wording when autoRetries is false', classifyStatusError({ status: 429 }, { ...opts, autoRetries: false }).message === 'Rate limited. Wait a moment and try again.');
    check('classifies 429 with the retry wording when autoRetries is true', /already retried/.test(classifyStatusError({ status: 429 }, { ...opts, autoRetries: true }).message));
    check('classifies 5xx using the given providerLabel', classifyStatusError({ status: 503 }, opts).message === 'TestProvider API error (503).');
    check('classifies a network error message even with no status code', classifyStatusError({ message: 'connect ECONNREFUSED 127.0.0.1:443' }, opts).message.includes('network'));
    check('classifies name:"AbortError" as aborted', classifyStatusError({ name: 'AbortError' }, opts).aborted === true);
    check('an unrecognized error falls back to its own message', classifyStatusError({ message: 'something odd' }, opts).message === 'something odd');

    class FakeAuthError extends Error {}
    check('an instanceof match wins even when .status is absent', classifyStatusError(new FakeAuthError('x'), { ...opts, errorClasses: { Authentication: FakeAuthError } }).message.includes('401'));
    check('a class slot left undefined never throws (no instanceof-on-undefined crash)', (() => {
      try {
        classifyStatusError({ status: 401 }, { ...opts, errorClasses: {} });
        return true;
      } catch {
        return false;
      }
    })());
  }

  console.log('ollama adapter — direct (askStructured)');
  const ollama = require('../src/main/providers/ollama');
  const BASE_URL = 'http://localhost:11434';

  {
    let capturedBody = null;
    fetchImpl = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(
        JSON.stringify({
          message: { content: JSON.stringify({ question: 'q', answer: 'a', confidence: 'high' }) },
          prompt_eval_count: 500,
          eval_count: 20,
          model: 'llama3.2-vision',
        }),
        { status: 200 }
      );
    };
    const res = await ollama.askStructured({
      model: 'llama3.2-vision',
      maxTokens: 1000,
      system: 'sys',
      content: [
        { type: 'image', mediaType: 'image/jpeg', base64: 'IMGDATA' },
        { type: 'text', text: 'What is this?' },
      ],
      jsonSchema: { type: 'object' },
      baseUrl: BASE_URL,
      timeoutMs: 5000,
    });
    check('askStructured ok on a clean response', res.ok, res.error);
    check('askStructured parses the returned text later in ai.js — here it is passed through raw', res.text.includes('"answer":"a"'));
    check('askStructured normalizes Ollama usage field names', res.usage.input_tokens === 500 && res.usage.output_tokens === 20, JSON.stringify(res.usage));
    check('canonical image block becomes a bare base64 in `images`, no data-URL/type wrapper', capturedBody.messages[1].images?.[0] === 'IMGDATA');
    check('canonical text block becomes the plain `content` string', capturedBody.messages[1].content === 'What is this?');
    check('the system block is sent as its own role:"system" message', capturedBody.messages[0].role === 'system' && capturedBody.messages[0].content === 'sys');
    check('no api key field is ever sent (local, unauthenticated)', !('apiKey' in capturedBody) && !('api_key' in capturedBody));
  }

  console.log('ollama adapter — JSON repair retry');
  {
    let callCount = 0;
    fetchImpl = async () => {
      callCount++;
      const content =
        callCount === 1
          ? 'Sure! Here you go: ' + JSON.stringify({ question: 'q', answer: 'a', confidence: 'low' }) // not valid JSON on its own
          : JSON.stringify({ question: 'q', answer: 'a', confidence: 'low' }); // clean on the repair pass
      return new Response(JSON.stringify({ message: { content }, prompt_eval_count: 10, eval_count: 5, model: 'llama3.2-vision' }), { status: 200 });
    };
    const res = await ollama.askStructured({
      model: 'llama3.2-vision', maxTokens: 500, system: 's', content: [{ type: 'text', text: 'q' }],
      jsonSchema: { type: 'object' }, baseUrl: BASE_URL, timeoutMs: 5000,
    });
    check('a non-JSON first response triggers exactly one repair retry', callCount === 2, `calls=${callCount}`);
    check('the repaired response is what gets returned', res.ok && JSON.parse(res.text).answer === 'a', res.text);
  }

  console.log('ollama adapter — streaming (askStreaming)');
  {
    fetchImpl = async () =>
      new Response(
        ndjsonStream([
          { message: { content: 'Hello' }, done: false },
          { message: { content: ' world' }, done: false },
          { done: true, prompt_eval_count: 10, eval_count: 2, model: 'llama3.2-vision' },
        ]),
        { status: 200 }
      );
    const deltas = [];
    // The adapter clears registerAbort(null) in its `finally` once the stream
    // completes — that's correct (it's what makes ai.js's isBusy() work) — so
    // check that a real function was registered AT SOME POINT during the
    // call, not the value after it has already resolved and been cleared.
    let sawAbortFunction = false;
    const res = await ollama.askStreaming({
      model: 'llama3.2-vision', maxTokens: 500, system: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      onDelta: (d) => deltas.push(d),
      registerAbort: (fn) => { if (typeof fn === 'function') sawAbortFunction = true; },
      baseUrl: BASE_URL, timeoutMs: 5000,
    });
    check('askStreaming ok on a clean NDJSON stream', res.ok, res.error);
    check('askStreaming delivers each chunk to onDelta in order', deltas.join('') === 'Hello world', JSON.stringify(deltas));
    check('askStreaming normalizes usage from the final {done:true} event', res.usage.input_tokens === 10 && res.usage.output_tokens === 2);
    check('askStreaming registers a real abort function during the stream', sawAbortFunction === true);
  }

  console.log('ollama adapter — abort and connection errors map to friendly messages');
  {
    fetchImpl = async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    };
    const aborted = await ollama.askStreaming({
      model: 'x', maxTokens: 1, system: '', messages: [], onDelta: () => {}, registerAbort: () => {},
      baseUrl: BASE_URL, timeoutMs: 5000,
    });
    check('an AbortError is reported as aborted:true with a plain "Stopped." message', aborted.aborted === true && aborted.error === 'Stopped.');

    fetchImpl = async () => {
      const err = new Error('fetch failed');
      err.cause = { code: 'ECONNREFUSED' };
      throw err;
    };
    const refused = await ollama.validate({ model: 'llama3.2-vision', baseUrl: BASE_URL });
    check('ECONNREFUSED is reported as "Ollama isn\'t running", not a generic network error', !refused.ok && /isn't running/i.test(refused.error), refused.error);
  }

  console.log('ollama adapter — validate() checks the model is actually pulled');
  {
    fetchImpl = async () => new Response(JSON.stringify({ models: [{ name: 'llama3.2-vision:latest' }, { name: 'gemma3:latest' }] }), { status: 200 });
    const hasIt = await ollama.validate({ model: 'llama3.2-vision', baseUrl: BASE_URL });
    check('validate() accepts a model present with a :tag suffix', hasIt.ok, hasIt.error);
    const missing = await ollama.validate({ model: 'qwen2.5vl', baseUrl: BASE_URL });
    check('validate() rejects a model that is not pulled, with a "ollama pull" hint', !missing.ok && /ollama pull/i.test(missing.error), missing.error);
  }

  console.log('ai.js — full pipeline through the ollama provider (end-to-end)');
  {
    const savedAi = { ...config.get('ai') };
    config.set('ai', { ...savedAi, provider: 'ollama', model: 'llama3.2-vision' });
    fetchImpl = async (url, opts) => {
      const body = JSON.parse(opts.body);
      check('ai.js routes to Ollama with no apiKey required', ai.activeProviderNeedsKey() === false);
      return new Response(
        JSON.stringify({
          message: { content: JSON.stringify({ question: 'On screen?', answer: '42', confidence: 'medium' }) },
          prompt_eval_count: 300, eval_count: 15, model: body.model,
        }),
        { status: 200 }
      );
    };
    const result = await ai.askTerse({ image: { mediaType: 'image/jpeg', base64: 'AA' } });
    check('full pipeline: ai.askTerse succeeds via the ollama adapter', result.ok, result.error);
    check('full pipeline: structured fields parsed correctly end-to-end', result.answer === '42' && result.confidence === 'medium');
    check('full pipeline: cost is exactly $0 for a local model', result.costUsd === 0, `${result.costUsd}`);
    config.set('ai', savedAi); // restore Anthropic for any later section
  }

  console.log('openai adapter — direct (askStructured)');
  const openai = require('../src/main/providers/openai');

  {
    mockOpenAI.create = async () => ({
      choices: [{ message: { content: JSON.stringify({ question: 'q', answer: 'a', confidence: 'high' }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 400, completion_tokens: 25 },
      model: 'gpt-4o-mini',
    });
    const res = await openai.askStructured({
      apiKey: 'sk-test', model: 'gpt-4o-mini', maxTokens: 1000, system: 'sys',
      content: [
        { type: 'image', mediaType: 'image/jpeg', base64: 'IMGDATA' },
        { type: 'text', text: 'What is this?' },
      ],
      jsonSchema: { type: 'object' }, timeoutMs: 5000, maxRetries: 2,
    });
    check('askStructured ok on a clean response', res.ok, res.error);
    check('askStructured normalizes prompt_tokens/completion_tokens to input/output', res.usage.input_tokens === 400 && res.usage.output_tokens === 25, JSON.stringify(res.usage));
    check('uses max_completion_tokens, not the deprecated max_tokens field', mockOpenAI.lastRequest.max_completion_tokens === 1000 && !('max_tokens' in mockOpenAI.lastRequest));
    check('canonical image block becomes a data-URL image_url block', mockOpenAI.lastRequest.messages[1].content[0].image_url.url === 'data:image/jpeg;base64,IMGDATA');
    check('canonical text block becomes a text content part', mockOpenAI.lastRequest.messages[1].content[1].text === 'What is this?');
    check('requests strict json_schema structured output', mockOpenAI.lastRequest.response_format.type === 'json_schema' && mockOpenAI.lastRequest.response_format.json_schema.strict === true);
  }

  console.log('openai adapter — refusal via finish_reason:"content_filter"');
  {
    mockOpenAI.create = async () => ({
      choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
      model: 'gpt-4o-mini',
    });
    const res = await openai.askStructured({
      apiKey: 'sk-test', model: 'gpt-4o-mini', maxTokens: 100, system: 's',
      content: [{ type: 'text', text: 'q' }], jsonSchema: { type: 'object' }, timeoutMs: 5000,
    });
    check('content_filter finish_reason maps to a refusal error, not a crash', !res.ok && /content filter/i.test(res.error), res.error);
  }

  console.log('openai adapter — streaming (askStreaming)');
  {
    mockOpenAI.createStream = () =>
      (async function* () {
        yield { choices: [{ delta: { content: 'Hello' } }], model: 'gpt-4o-mini' };
        yield { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }], model: 'gpt-4o-mini' };
        yield { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 }, model: 'gpt-4o-mini' };
      })();
    const deltas = [];
    let sawAbortFunction = false;
    const res = await openai.askStreaming({
      apiKey: 'sk-test', model: 'gpt-4o-mini', maxTokens: 500, system: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      onDelta: (d) => deltas.push(d),
      registerAbort: (fn) => { if (typeof fn === 'function') sawAbortFunction = true; },
      timeoutMs: 5000,
    });
    check('askStreaming ok on a clean chunk sequence', res.ok, res.error);
    check('askStreaming delivers each delta.content chunk in order', deltas.join('') === 'Hello world', JSON.stringify(deltas));
    check('askStreaming reads usage from the final (empty-choices) chunk, per stream_options.include_usage', res.usage.input_tokens === 12 && res.usage.output_tokens === 3, JSON.stringify(res.usage));
    check('askStreaming captures stop_reason from the chunk that carries finish_reason', res.stopReason === 'end_turn');
    check('askStreaming requests stream_options.include_usage', mockOpenAI.lastRequest.stream_options?.include_usage === true);
    check('askStreaming registers a real abort function during the stream', sawAbortFunction === true);
  }

  console.log('openai adapter — error mapping');
  {
    mockOpenAI.create = async () => { throw new FakeOpenAI.AuthenticationError('bad key'); };
    const unauth = await openai.askStructured({ apiKey: 'x', model: 'gpt-4o-mini', maxTokens: 10, system: '', content: [{ type: 'text', text: 'q' }], jsonSchema: {}, timeoutMs: 5000 });
    check('AuthenticationError maps to a 401-style message', !unauth.ok && /401/.test(unauth.error), unauth.error);

    mockOpenAI.create = async () => { throw new FakeOpenAI.APIUserAbortError('aborted'); };
    const aborted = await openai.askStructured({ apiKey: 'x', model: 'gpt-4o-mini', maxTokens: 10, system: '', content: [{ type: 'text', text: 'q' }], jsonSchema: {}, timeoutMs: 5000 });
    check('APIUserAbortError maps to aborted:true, not a generic error', aborted.aborted === true && aborted.error === 'Stopped.');
  }

  console.log('openai adapter — validate()');
  {
    mockOpenAI.retrieve = async () => ({ id: 'gpt-4o-mini' });
    check('validate() accepts a reachable model', (await openai.validate({ apiKey: 'sk-test', model: 'gpt-4o-mini' })).ok);
    mockOpenAI.retrieve = async () => { throw new FakeOpenAI.NotFoundError('no such model'); };
    const bad = await openai.validate({ apiKey: 'sk-test', model: 'not-a-real-model' });
    check('validate() rejects an unknown model with a 404-style message', !bad.ok && /404/.test(bad.error), bad.error);
  }

  console.log('ai.js — full pipeline through the openai provider (end-to-end)');
  {
    const savedAi = { ...config.get('ai') };
    config.set('ai', { ...savedAi, provider: 'openai', model: 'gpt-4o-mini' });
    process.env.OPENAI_API_KEY = 'sk-openai-test-key'; // env fallback, no stored key needed for this check
    mockOpenAI.create = async (body) => ({
      choices: [{ message: { content: JSON.stringify({ question: 'On screen?', answer: '7', confidence: 'high' }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 350, completion_tokens: 18 },
      model: body.model,
    });
    const result = await ai.askTerse({ image: { mediaType: 'image/jpeg', base64: 'AA' } });
    check('full pipeline: ai.askTerse succeeds via the openai adapter', result.ok, result.error);
    check('full pipeline: structured fields parsed correctly end-to-end', result.answer === '7' && result.confidence === 'high');
    check('full pipeline: cost computed from the gpt-4o-mini price row (nonzero, unlike ollama)', result.costUsd > 0, `${result.costUsd}`);
    delete process.env.OPENAI_API_KEY;
    config.set('ai', savedAi); // restore Anthropic for any later section
  }

  console.log('gemini adapter — direct (askStructured)');
  const gemini = require('../src/main/providers/gemini');

  {
    mockGemini.generateContent = async () => ({
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 30 },
      text: JSON.stringify({ question: 'q', answer: 'a', confidence: 'high' }),
    });
    const res = await gemini.askStructured({
      apiKey: 'k', model: 'gemini-2.5-flash', maxTokens: 1000, system: 'sys',
      content: [
        { type: 'image', mediaType: 'image/jpeg', base64: 'IMGDATA' },
        { type: 'text', text: 'What is this?' },
      ],
      jsonSchema: { type: 'object' }, timeoutMs: 5000,
    });
    check('askStructured ok on a clean response', res.ok, res.error);
    check('askStructured normalizes promptTokenCount/candidatesTokenCount', res.usage.input_tokens === 600 && res.usage.output_tokens === 30, JSON.stringify(res.usage));
    check('the system prompt goes in config.systemInstruction, NOT a contents message', mockGemini.lastParams.config.systemInstruction === 'sys' && mockGemini.lastParams.contents.every((c) => c.role !== 'system'));
    check('canonical image block becomes an inlineData part (mimeType/data, not a data URL)', mockGemini.lastParams.contents[0].parts[0].inlineData.mimeType === 'image/jpeg' && mockGemini.lastParams.contents[0].parts[0].inlineData.data === 'IMGDATA');
    check('canonical text block becomes a text part', mockGemini.lastParams.contents[0].parts[1].text === 'What is this?');
    check('requests JSON via responseMimeType + responseSchema', mockGemini.lastParams.config.responseMimeType === 'application/json' && !!mockGemini.lastParams.config.responseSchema);
  }

  console.log('gemini adapter — refusal handling (two distinct shapes)');
  {
    mockGemini.generateContent = async () => ({
      candidates: [{ finishReason: 'SAFETY' }], usageMetadata: {}, text: '',
    });
    const declined = await gemini.askStructured({ apiKey: 'k', model: 'gemini-2.5-flash', maxTokens: 100, system: 's', content: [{ type: 'text', text: 'q' }], jsonSchema: {}, timeoutMs: 5000 });
    check('finishReason:"SAFETY" maps to a refusal error', !declined.ok && /safety/i.test(declined.error), declined.error);

    mockGemini.generateContent = async () => ({ candidates: [], usageMetadata: {} }); // blocked before any candidate existed
    const blocked = await gemini.askStructured({ apiKey: 'k', model: 'gemini-2.5-flash', maxTokens: 100, system: 's', content: [{ type: 'text', text: 'q' }], jsonSchema: {}, timeoutMs: 5000 });
    check('an empty candidates array (blocked before generation) does not crash reading .text, and is reported as declined', !blocked.ok && /declined/i.test(blocked.error), blocked.error);
  }

  console.log('gemini adapter — streaming, including assistant->model role mapping');
  {
    mockGemini.generateContentStream = async () =>
      (async function* () {
        yield { candidates: [{ finishReason: undefined }], text: 'Hello' };
        yield { candidates: [{ finishReason: 'STOP' }], text: ' world' };
        yield { usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 4 }, candidates: [{ finishReason: 'STOP' }], text: '' };
      })();
    const deltas = [];
    let sawAbortFunction = false;
    const res = await gemini.askStreaming({
      apiKey: 'k', model: 'gemini-2.5-flash', maxTokens: 500, system: 's',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'prior answer' }] },
      ],
      onDelta: (d) => deltas.push(d),
      registerAbort: (fn) => { if (typeof fn === 'function') sawAbortFunction = true; },
      timeoutMs: 5000,
    });
    check('askStreaming ok on a clean chunk sequence', res.ok, res.error);
    check('askStreaming delivers each .text chunk in order', deltas.join('') === 'Hello world', JSON.stringify(deltas));
    check('askStreaming reads usage from whichever chunk carries usageMetadata', res.usage.input_tokens === 15 && res.usage.output_tokens === 4, JSON.stringify(res.usage));
    check('history role "assistant" is translated to Gemini\'s "model" role', mockGemini.lastParams.contents[1].role === 'model', JSON.stringify(mockGemini.lastParams.contents));
    check('history role "user" stays "user"', mockGemini.lastParams.contents[0].role === 'user');
    check('askStreaming registers a real abort function during the stream', sawAbortFunction === true);
  }

  console.log('gemini adapter — error mapping (flat ApiError + status code, not per-code classes)');
  {
    mockGemini.generateContent = async () => { throw new FakeApiError('unauthorized', 401); };
    const unauth = await gemini.askStructured({ apiKey: 'x', model: 'gemini-2.5-flash', maxTokens: 10, system: '', content: [{ type: 'text', text: 'q' }], jsonSchema: {}, timeoutMs: 5000 });
    check('a 401 ApiError maps to a key-rejected message', !unauth.ok && /401/.test(unauth.error), unauth.error);

    mockGemini.generateContent = async () => { throw new FakeApiError('rate limited', 429); };
    const limited = await gemini.askStructured({ apiKey: 'x', model: 'gemini-2.5-flash', maxTokens: 10, system: '', content: [{ type: 'text', text: 'q' }], jsonSchema: {}, timeoutMs: 5000 });
    check('a 429 ApiError maps to a rate-limit message', !limited.ok && /rate limit/i.test(limited.error), limited.error);
  }

  console.log('gemini adapter — validate()');
  {
    mockGemini.getModel = async () => ({ name: 'models/gemini-2.5-flash' });
    check('validate() accepts a reachable model', (await gemini.validate({ apiKey: 'k', model: 'gemini-2.5-flash' })).ok);
    mockGemini.getModel = async () => { throw new FakeApiError('not found', 404); };
    const bad = await gemini.validate({ apiKey: 'k', model: 'not-a-real-model' });
    check('validate() rejects an unknown model with a 404-style message', !bad.ok && /404/.test(bad.error), bad.error);
  }

  console.log('ai.js — full pipeline through the gemini provider (end-to-end)');
  {
    const savedAi = { ...config.get('ai') };
    config.set('ai', { ...savedAi, provider: 'gemini', model: 'gemini-2.5-flash' });
    process.env.GEMINI_API_KEY = 'gm-test-key';
    mockGemini.generateContent = async () => ({
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20 },
      text: JSON.stringify({ question: 'On screen?', answer: 'blue', confidence: 'medium' }),
    });
    const result = await ai.askTerse({ image: { mediaType: 'image/jpeg', base64: 'AA' } });
    check('full pipeline: ai.askTerse succeeds via the gemini adapter', result.ok, result.error);
    check('full pipeline: structured fields parsed correctly end-to-end', result.answer === 'blue' && result.confidence === 'medium');
    check('full pipeline: cost computed from the gemini-2.5-flash price row', result.costUsd > 0, `${result.costUsd}`);
    delete process.env.GEMINI_API_KEY;
    config.set('ai', savedAi);
  }

  console.log('ai — provider registry');
  check('availableProviders lists every adapter actually registered', ['anthropic', 'ollama', 'openai', 'gemini'].every((id) => ai.availableProviders().includes(id)), JSON.stringify(ai.availableProviders()));
  check('activeProviderId matches config.ai.provider', ai.activeProviderId() === 'anthropic');
  check('activeProviderNeedsKey is true for anthropic', ai.activeProviderNeedsKey() === true);
  {
    // An unknown/stale provider id in config (e.g. from an old config.json
    // predating a removed adapter) must fall back to Anthropic, not crash.
    const saved = config.get('ai').provider;
    config.set('ai', { ...config.get('ai'), provider: 'nonexistent-provider' });
    check('an unregistered provider id falls back to anthropic', ai.activeProviderId() === 'anthropic');
    config.set('ai', { ...config.get('ai'), provider: saved });
  }

  console.log('ai — key validation');
  mock.retrieve = async () => ({ id: 'claude-opus-5' });
  check('validateKey accepts a working key', (await ai.validateKey('sk-ant-good')).ok);
  mock.retrieve = async () => { throw { status: 401 }; };
  check('validateKey rejects a bad key', !(await ai.validateKey('sk-ant-bad')).ok);

  console.log('renderer — markdown is CSP-safe (DOM nodes, never innerHTML)');
  await testMarkdown();

  /* ---------------------------------------------------------------- done */
  console.log(`\n${passed} passed, ${failed} failed`);
  try {
    fs.rmSync(USERDATA, { recursive: true, force: true });
  } catch {}
  process.exit(failed ? 1 : 0);
}

/* -------------------- renderer markdown (fake DOM, real module) ---------- */

function fakeNode(tag) {
  return {
    tag,
    children: [],
    textContent: '',
    append(...ns) {
      for (const n of ns) this.children.push(typeof n === 'string' ? { tag: '#text', textContent: n } : n);
    },
    replaceChildren(...ns) {
      this.children = ns;
    },
  };
}

// Flatten a node tree into "tag:text" pairs and a concatenated string, so tests
// can assert both the structure (a `pre>code`, a `strong`) and the text.
function walk(node, tags, out) {
  for (const child of node.children) {
    tags.add(child.tag);
    if (child.textContent) out.push(child.textContent);
    if (child.children) walk(child, tags, out);
  }
}

async function testMarkdown() {
  global.document = {
    createElement: (tag) => fakeNode(tag),
    createTextNode: (text) => ({ tag: '#text', textContent: text }),
  };

  const url = require('url').pathToFileURL(
    path.resolve(__dirname, '../src/renderer/views/markdown.js')
  ).href;
  const { renderMarkdown } = await import(url);

  const container = fakeNode('div');
  renderMarkdown(container, 'The answer is **B**.\n\n```js\nconst x = 1;\n```\n\n- first\n- `code` item');

  const tags = new Set();
  const out = [];
  walk(container, tags, out);
  const joined = out.join(' ');

  check('renders paragraphs', tags.has('p'));
  check('renders bold as <strong>', tags.has('strong') && out.includes('B'));
  check('renders fenced code as <pre><code>', tags.has('pre') && tags.has('code'));
  check('strips the language tag from fences', joined.includes('const x = 1;') && !joined.includes('js\n'));
  check('renders bullet lists as <ul><li>', tags.has('ul') && tags.has('li'));
  check('renders inline code as <code>', out.includes('code'));
  // The whole point: no raw HTML string ever exists to be injected.
  check('never produces an innerHTML string', !('innerHTML' in container));

  delete global.document;
}

main().catch((err) => {
  console.error('harness crashed:', err);
  process.exit(1);
});
