'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Settings persisted to <userData>/config.json.
 *
 * Anything a future feature needs to remember across launches belongs here.
 * Add a key to DEFAULTS and it is merged into existing user configs on load,
 * so shipping a new setting never invalidates someone's saved file.
 *
 * The API key deliberately does NOT live here — see secrets.js.
 */
const DEFAULTS = {
  // null x/y means "top-right of the primary display on first run"
  bounds: { width: 380, height: 200, x: null, y: null },
  opacity: 0.96,
  fontScale: 1,
  // Panel colour scheme: 'dark' | 'light' | 'auto' (follow Windows).
  theme: 'dark',

  hover: {
    // The panel is invisible until the cursor is inside its bounds.
    enabled: true,
    // Hover is detected by polling the cursor in the main process rather than
    // by DOM events: a click-through window gets mousemove while the cursor is
    // inside but no reliable mouseleave when it exits, so DOM-only detection
    // has to guess with a timeout. Polling costs ~nothing and never misses.
    pollMs: 60,
    // Both directions instant by default. Raise if a twitchy mouse strobes it.
    hideDelayMs: 0,
    // After this long with no cursor movement at all, drop to a lazy poll —
    // there is no point sampling 16x/second at 3am.
    idleAfterMs: 120000,
    idlePollMs: 400,
  },

  // Master stealth switch. When false the window behaves like any normal
  // window and IS captured — useful when you actually want to share it.
  contentProtection: true,
  moveStep: 40,
  autoSize: true,

  capture: {
    // 'cursor' is the only sane default on a multi-monitor setup: capturing the
    // panel's display instead silently answers about the wrong screen.
    display: 'cursor', // 'cursor' | 'panel' | 'primary'
    quality: 'balanced', // 'fast' 1280px | 'balanced' 1568px | 'max' 2576px
    // Absolute screen-space rect to crop to, or null for the whole display.
    region: null,
    // Skip the API call when the screen is byte-identical to the last capture.
    skipUnchanged: true,
  },

  hotkeys: {
    // The main one: capture the screen and replace the answer with a new one.
    answer: 'Control+Shift+Space',
    // Slides in the text box for a specific or follow-up question.
    ask: 'Control+Shift+Return',
    // Re-run the LAST capture at high effort — for when a terse answer came
    // back low-confidence and you want the model to actually think.
    retryHarder: 'Control+Shift+H',
    // Expand the last terse answer into a couple of sentences of reasoning.
    explain: 'Control+Shift+E',
    // Answer about whatever text is on the clipboard — no screenshot, so it is
    // faster and far cheaper than vision when you can just copy the question.
    answerClipboard: 'Control+Shift+G',
    // Keeps the panel visible without hovering (for reading a long answer).
    togglePin: 'Control+Shift+\\',
    copyAnswer: 'Control+Shift+C',
    previousAnswer: 'Control+Shift+[',
    nextAnswer: 'Control+Shift+]',
    selectRegion: 'Control+Shift+R',
    clearRegion: 'Control+Shift+F',
    // Wipe every answer and the conversation from memory, now.
    // (Ctrl+Shift+X is commonly claimed by other apps; Backspace rarely is.)
    panic: 'Control+Shift+Backspace',
    toggleProtection: 'Control+Shift+P',
    selfTest: 'Control+Shift+T',
    // Recovery path if the panel ends up somewhere you can't find by hovering.
    moveUp: 'Control+Shift+Up',
    moveDown: 'Control+Shift+Down',
    moveLeft: 'Control+Shift+Left',
    moveRight: 'Control+Shift+Right',
  },

  ai: {
    // Which adapter answers questions. More may exist in code than are
    // actually selectable — main/index.js only offers providers ai.js has a
    // real adapter registered for.
    provider: 'anthropic',
    model: 'claude-opus-5',
    // Remembers your last model choice PER provider, so flipping from
    // Anthropic to something else and back doesn't lose either pick. `model`
    // above always mirrors `models[provider]` — it's what the rest of the
    // app reads; this is just the memory that survives a provider switch.
    models: { anthropic: 'claude-opus-5', openai: '', gemini: '', ollama: '' },
    // Thinking is on by default on Opus 5 and shares this budget with the
    // response text, so a tight cap truncates answers mid-sentence. max_tokens
    // is a ceiling, not a charge — only actual usage is billed.
    maxTokens: 16000,
    // An overlay is a latency product. 'low' still answers screen questions
    // well on this model; raise for harder reasoning at the cost of speed.
    effort: 'low',
    historyTurns: 6,
    timeoutMs: 60000,
    maxRetries: 2,
    // Lifetime spend cap in USD; 0 means uncapped.
    budgetUsd: 0,
    // Effort used by retry-harder. Deliberately near the top of the ladder —
    // the whole point is to spend more thinking on a question 'low' fumbled.
    retryEffort: 'high',
    // When false, nothing is retained between questions: no conversation, no
    // "explain" context. Privacy switch.
    keepHistory: true,
  },

  // Local Ollama server — no API key, nothing leaves the machine.
  ollama: { baseUrl: 'http://localhost:11434' },

  // Answers kept in the ring buffer you can page back through.
  answerHistory: 8,
  startOnLogin: false,
};

// Suggested models per provider, shown in Settings. Not every key here has a
// working adapter yet — main/index.js only lists providers ai.js actually
// implements, so an unimplemented entry here is inert until its adapter ships.
const MODEL_CATALOG = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  openai: ['gpt-4o-mini', 'gpt-4o'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  // A vision-capable local model is required — text-only models can't read
  // the screenshot at all. These three are the commonly available options.
  ollama: ['llama3.2-vision', 'qwen2.5vl', 'gemma3'],
};

let cache = null;
let filePath = null;

function file() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'config.json');
  return filePath;
}

// Only one level deep, which is all the shape above needs.
function merge(defaults, saved) {
  const out = { ...defaults };
  for (const [key, value] of Object.entries(saved || {})) {
    if (!(key in defaults)) continue;
    const base = defaults[key];
    const bothPlainObjects =
      base && typeof base === 'object' && !Array.isArray(base) &&
      value && typeof value === 'object' && !Array.isArray(value);
    out[key] = bothPlainObjects ? { ...base, ...value } : value;
  }
  return out;
}

function load() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    // Missing or corrupt config is not an error — fall back to defaults.
  }
  cache = merge(DEFAULTS, saved);
  return cache;
}

function save() {
  if (!cache) return;
  try {
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('[config] could not write', file(), err.message);
  }
}

const get = (key) => load()[key];

function set(key, value) {
  load()[key] = value;
  save();
}

module.exports = { load, save, get, set, file, DEFAULTS, MODEL_CATALOG };
