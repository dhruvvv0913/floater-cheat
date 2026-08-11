'use strict';

/**
 * Self-heal when this file is executed as plain Node *because* of
 * ELECTRON_RUN_AS_NODE.
 *
 * VS Code (itself an Electron app) exports that flag into its terminal, and it
 * is inherited by anything started from there. When it causes the electron
 * binary to actually run this script as Node, process.type is undefined and
 * require('electron') returns the executable's path string instead of the API.
 * Re-exec ourselves without the flag.
 *
 * The `ELECTRON_RUN_AS_NODE` guard is load-bearing: without it, running this
 * file under a real `node` (where the flag is unset and process.type is also
 * undefined) would re-exec node → index.js → forever. We only self-heal for the
 * one cause we can actually fix.
 */
if (!process.type && process.env.ELECTRON_RUN_AS_NODE) {
  const { spawn } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(process.execPath, process.argv.slice(1), { env, detached: true, stdio: 'ignore' }).unref();
  process.exit(0);
}

const os = require('os');
const { app, ipcMain, Tray, Menu, nativeImage, shell, screen, clipboard } = require('electron');

const config = require('./config');
const log = require('./logger');
const overlay = require('./overlay-window');
const hotkeys = require('./hotkeys');
const selftest = require('./selftest');
const capture = require('./capture');
const region = require('./region-select');
const secrets = require('./secrets');
const usage = require('./usage');
const ai = require('./ai');

const TRAY_ICON =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMElEQVR4nGNgGF7g9esP/4nBFGnGaQhMQk5OBS+mvQE08wL9DKDYC3RJC1g1D10AACa7cixicSF7AAAAAElFTkSuQmCC';

let tray = null;

/* -------------------------------------------------------------- lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => overlay.setPinned(true));
  app.on('window-all-closed', (event) => event.preventDefault());
  app.whenReady().then(start);
}

function start() {
  log.info(`[app] starting — electron ${process.versions.electron}, ${os.release()}`);
  applyLoginItem();
  overlay.create();
  registerHotkeys();
  createTray();
  registerIpc();

  // Nothing works without a key (unless the active provider needs none, e.g.
  // a local Ollama), and the panel is invisible until hovered, so a first-run
  // user would otherwise face a blank screen with no idea what to do. Open
  // Settings so the key field is right there.
  if (ai.activeProviderNeedsKey() && !secrets.status(ai.activeProviderId()).configured) {
    log.info('[app] no API key configured — opening Settings for first-run setup');
    setMode('settings');
  }
}

function applyLoginItem() {
  // Only meaningful in a packaged build — in dev the "executable" is
  // electron.exe, and registering that would launch bare Electron at login.
  if (!app.isPackaged) return;
  const want = !!config.get('startOnLogin');
  if (app.getLoginItemSettings().openAtLogin !== want) {
    app.setLoginItemSettings({ openAtLogin: want, args: [] });
  }
}

app.on('will-quit', () => hotkeys.unregisterAll());

process.on('uncaughtException', (err) => log.error('[uncaught]', err.stack || err.message));
process.on('unhandledRejection', (err) => log.error('[unhandled]', err?.stack || String(err)));

/* -------------------------------------------------------- answer history */

// A ring of recent answers you can page back through. One answer at a time is
// fine until you want to check what it said two questions ago.
const answers = [];
let cursor = -1;

function pushAnswer(entry) {
  answers.push({ ...entry, at: Date.now() });
  const max = config.get('answerHistory');
  while (answers.length > max) answers.shift();
  cursor = answers.length - 1;
  return answers[cursor];
}

function showAnswer(offset) {
  if (!answers.length) return null;
  cursor = Math.max(0, Math.min(answers.length - 1, cursor + offset));
  send('answer:show', { ...answers[cursor], index: cursor, total: answers.length });
  return answers[cursor];
}

function copyAnswer() {
  const entry = answers[cursor];
  if (!entry?.answer) return false;
  clipboard.writeText(entry.answer);
  send('toast', 'Copied');
  return true;
}

function send(channel, payload) {
  const win = overlay.getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---------------------------------------------------------------- hotkeys */

function registerHotkeys() {
  hotkeys.registerAll({
    answer: () => runOneShot(),
    ask: () => openInput(),
    retryHarder: () => runRetryHarder(),
    explain: () => runExplain(),
    answerClipboard: () => runClipboard(),
    panic: () => panicClear(),
    togglePin: () => {
      overlay.togglePin();
      updateTray();
    },
    copyAnswer: () => copyAnswer(),
    previousAnswer: () => showAnswer(-1),
    nextAnswer: () => showAnswer(1),
    selectRegion: () => pickRegion(),
    clearRegion: () => {
      region.clear();
      send('toast', 'Region cleared — capturing the full screen');
      updateTray();
    },
    toggleProtection: () => {
      overlay.toggleProtection();
      updateTray();
    },
    selfTest: () => runSelfTest(),
    moveUp: () => overlay.nudge(0, -1),
    moveDown: () => overlay.nudge(0, 1),
    moveLeft: () => overlay.nudge(-1, 0),
    moveRight: () => overlay.nudge(1, 0),
  });

  const failed = hotkeys.getFailures();
  if (failed.length) log.warn('[hotkeys] unavailable:', failed.map((f) => f.accelerator).join(', '));
  if (tray) updateTray();
}

/* ------------------------------------------------------------------- tray */

function createTray() {
  tray = new Tray(nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON}`));
  tray.on('click', () => {
    overlay.togglePin();
    updateTray();
  });
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const state = overlay.getState();
  const keys = config.get('hotkeys');
  const failed = hotkeys.getFailures();
  const rect = region.current();

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Answer what is on screen', accelerator: keys.answer, click: () => runOneShot() },
      { label: 'Ask a question…', accelerator: keys.ask, click: () => openInput() },
      { label: 'Retry the last one harder', accelerator: keys.retryHarder, click: () => runRetryHarder() },
      { label: 'Explain the last answer', accelerator: keys.explain, click: () => runExplain() },
      { label: 'Answer clipboard text', accelerator: keys.answerClipboard, click: () => runClipboard() },
      { label: 'Copy answer', accelerator: keys.copyAnswer, click: () => copyAnswer() },
      { type: 'separator' },
      {
        label: rect ? `Reading a ${rect.width}x${rect.height} region` : 'Reading the whole screen',
        enabled: false,
      },
      { label: 'Select region…', accelerator: keys.selectRegion, click: () => pickRegion() },
      ...(rect
        ? [
            {
              label: 'Clear region',
              accelerator: keys.clearRegion,
              click: () => {
                region.clear();
                updateTray();
              },
            },
          ]
        : []),
      { type: 'separator' },
      {
        label: 'Keep visible (pin)',
        type: 'checkbox',
        checked: state.pinned,
        accelerator: keys.togglePin,
        click: () => {
          overlay.togglePin();
          updateTray();
        },
      },
      {
        label: 'Move to corner',
        submenu: ['Top left', 'Top right', 'Bottom right', 'Bottom left'].map((label, index) => ({
          label,
          click: () => overlay.moveToCorner(index),
        })),
      },
      {
        label: 'Settings',
        type: 'checkbox',
        checked: state.mode === 'settings',
        click: () => setMode(state.mode === 'settings' ? 'answer' : 'settings'),
      },
      { type: 'separator' },
      {
        label: 'Hidden from screen capture',
        type: 'checkbox',
        checked: state.protectionEnabled,
        accelerator: keys.toggleProtection,
        click: () => {
          overlay.toggleProtection();
          updateTray();
        },
      },
      { label: 'Run invisibility self-test', accelerator: keys.selfTest, click: () => runSelfTest() },
      { type: 'separator' },
      {
        label: 'Start on login',
        type: 'checkbox',
        checked: !!config.get('startOnLogin'),
        enabled: app.isPackaged,
        click: () => {
          config.set('startOnLogin', !config.get('startOnLogin'));
          applyLoginItem();
          updateTray();
        },
      },
      { label: 'Open config folder', click: () => shell.showItemInFolder(config.file()) },
      { label: 'Open log file', click: () => shell.showItemInFolder(log.file()) },
      ...(failed.length
        ? [{ label: `${failed.length} hotkey(s) unavailable`, enabled: false }]
        : []),
      { label: 'Quit', click: () => app.exit(0) },
    ])
  );

  tray.setToolTip(
    `floater-cheat — ${state.protectionEnabled ? 'hidden from capture' : 'VISIBLE to capture'}` +
      (failed.length ? ` — ${failed.length} hotkey conflict(s)` : '')
  );
}

function setMode(mode) {
  overlay.setMode(mode);
  updateTray();
}

async function pickRegion() {
  const rect = await region.open();
  if (rect) send('toast', `Region set — ${rect.width}x${rect.height}`);
  updateTray();
}

/* -------------------------------------------------------------- self-test */

async function runSelfTest() {
  const win = overlay.getWindow();
  if (!win || win.isDestroyed()) return;
  setMode('settings');
  send('selftest:started');
  const result = await selftest.run();
  send('selftest:result', result);
  updateTray();
  return result;
}

/* -------------------------------------------------------------------- ask */

function openInput() {
  overlay.setMode('answer');
  overlay.setInputOpen(true);
  send('ask:open');
  updateTray();
}

let lastCaptureHash = null;
// Kept so retry-harder and explain can act on the same screen without a
// re-capture — the screen may have changed, and re-answering "that" question
// means the image it was about, not whatever is showing now.
let lastImage = null;

function recordAnswer(result, extraMs = 0) {
  const entry = pushAnswer({
    question: result.question,
    answer: result.answer,
    confidence: result.confidence,
    costUsd: result.costUsd,
    ms: (result.ms || 0) + extraMs,
    model: result.model,
  });
  send('answer:show', { ...entry, index: cursor, total: answers.length });
}

/**
 * The main flow: one keypress, screen captured, answer replaced.
 *
 * Deliberately does NOT reveal the panel — the whole point is that the answer
 * waits silently until you hover.
 */
async function runOneShot() {
  const win = overlay.getWindow();
  if (!win || win.isDestroyed()) return;

  if (ai.isBusy()) ai.cancel();
  send('ai:start');

  let image;
  try {
    image = await capture.captureScreen();
  } catch (err) {
    log.error('[oneshot] capture failed:', err.message);
    return send('ai:done', { ok: false, error: `Screen capture failed: ${err.message}` });
  }

  // A double-press on an unchanged screen is a mis-press, not a new question.
  // Re-answering it costs real money for a guaranteed-identical result.
  if (config.get('capture').skipUnchanged && image.hash === lastCaptureHash && answers.length) {
    log.info('[oneshot] screen unchanged — reusing the last answer');
    send('ai:done', { ok: true, reused: true });
    showAnswer(0);
    return;
  }
  lastCaptureHash = image.hash;
  lastImage = image;

  const result = await ai.askTerse({ image });
  if (result.ok) recordAnswer(result, image.ms);
  else lastCaptureHash = null; // a failure must not block an immediate retry

  send('ai:done', result);
  return result;
}

/** Re-run the last capture at high effort — the "actually think about it" key. */
async function runRetryHarder() {
  if (!lastImage) return send('toast', 'Nothing to retry yet');
  if (ai.isBusy()) ai.cancel();
  send('ai:start');
  send('toast', `Retrying at ${config.get('ai').retryEffort} effort…`);

  const result = await ai.askTerse({
    image: lastImage,
    effortOverride: config.get('ai').retryEffort,
  });
  if (result.ok) recordAnswer(result);
  send('ai:done', result);
  return result;
}

/** Expand the last terse answer into a sentence or two, streamed. */
async function runExplain() {
  const last = answers[cursor];
  if (!last?.answer) return send('toast', 'Nothing to explain yet');
  if (ai.isBusy()) ai.cancel();
  send('ai:start', { streaming: true });

  const question =
    `You previously answered "${last.answer}". Explain the reasoning in two or ` +
    `three sentences, referring to what is on screen.`;

  const result = await ai.askChat(question, lastImage, (delta) => send('ai:delta', delta));
  if (result.ok) {
    pushAnswer({ question: 'Explanation', answer: result.text, costUsd: result.costUsd, ms: result.ms, model: result.model });
    send('answer:show', { ...answers[cursor], index: cursor, total: answers.length });
  }
  send('ai:done', result);
  return result;
}

/** Answer about clipboard text — no screenshot, so cheap and fast. */
async function runClipboard() {
  const text = clipboard.readText().trim();
  if (!text) return send('toast', 'Clipboard is empty');
  if (ai.isBusy()) ai.cancel();
  send('ai:start');
  send('toast', 'Answering clipboard…');

  // No screenshot backs this answer, so retry-harder has nothing to re-run.
  lastImage = null;
  lastCaptureHash = null;

  const result = await ai.askTerse({ text });
  if (result.ok) recordAnswer(result);
  send('ai:done', result);
  return result;
}

async function runAsk(_event, { question }) {
  const win = overlay.getWindow();
  if (!win || win.isDestroyed()) return { ok: false, error: 'Overlay unavailable.' };

  send('ai:start', { streaming: true });

  let image = null;
  try {
    image = await capture.captureScreen();
    lastImage = image;
  } catch (err) {
    // Must still emit ai:done, or the panel sits on its busy indicator forever.
    const failure = { ok: false, error: `Screen capture failed: ${err.message}` };
    send('ai:done', failure);
    return failure;
  }

  const result = await ai.askChat(question, image, (delta) => send('ai:delta', delta));
  if (result.ok) {
    pushAnswer({
      question,
      answer: result.text,
      confidence: null,
      costUsd: result.costUsd,
      ms: result.ms,
      model: result.model,
    });
    // Without this the streamed text is cleared on ai:done and the answer
    // vanishes the moment it finishes. Send the canonical entry so it persists
    // with its cost/latency metadata like every other answer.
    send('answer:show', { ...answers[cursor], index: cursor, total: answers.length });
  }
  send('ai:done', result);
  return result;
}

function panicClear() {
  ai.cancel();
  ai.clearHistory();
  answers.length = 0;
  cursor = -1;
  lastCaptureHash = null;
  lastImage = null;
  send('answer:show', null);
  send('toast', 'Cleared');
  log.info('[panic] all answers and history wiped from memory');
}

/* -------------------------------------------------------------------- ipc */

function registerIpc() {
  /* --- window --- */
  ipcMain.handle('overlay:get-state', () => overlay.getState());
  ipcMain.handle('overlay:get-info', () => ({
    hotkeys: config.get('hotkeys'),
    hotkeyFailures: hotkeys.getFailures(),
    configPath: config.file(),
    logPath: log.file(),
    electron: process.versions.electron,
    platform: process.platform,
    osRelease: os.release(),
    scaleFactor: screen.getPrimaryDisplay().scaleFactor,
    fontScale: config.get('fontScale'),
    theme: overlay.resolvedTheme(),
  }));

  ipcMain.on('overlay:move-by', (_e, { dx = 0, dy = 0 } = {}) => overlay.moveBy(dx, dy));
  ipcMain.on('overlay:resize-by', (_e, { dw = 0, dh = 0 } = {}) => overlay.resizeBy(dw, dh));
  ipcMain.on('overlay:content-height', (_e, px) => overlay.setContentHeight(px));
  ipcMain.on('overlay:set-dragging', (_e, v) => overlay.setDragging(!!v));
  ipcMain.on('overlay:set-input-open', (_e, v) => overlay.setInputOpen(!!v));
  ipcMain.on('overlay:set-mode', (_e, mode) => setMode(mode === 'settings' ? 'settings' : 'answer'));
  ipcMain.on('overlay:set-protection', (_e, v) => {
    overlay.setProtection(!!v);
    updateTray();
  });
  ipcMain.on('overlay:quit', () => app.exit(0));

  /* --- answers --- */
  ipcMain.handle('answer:copy', () => copyAnswer());
  ipcMain.handle('answer:step', (_e, offset) => showAnswer(offset));
  ipcMain.handle('answer:current', () =>
    answers.length ? { ...answers[cursor], index: cursor, total: answers.length } : null
  );

  /* --- self-test / region --- */
  ipcMain.handle('overlay:run-selftest', () => runSelfTest());
  ipcMain.handle('region:pick', () => pickRegion());
  ipcMain.handle('region:clear', () => {
    region.clear();
    updateTray();
    return true;
  });

  /* --- ai --- */
  ipcMain.handle('ai:one-shot', () => runOneShot());
  ipcMain.handle('ai:ask', runAsk);
  ipcMain.handle('ai:retry-harder', () => runRetryHarder());
  ipcMain.handle('ai:explain', () => runExplain());
  ipcMain.handle('ai:clipboard', () => runClipboard());
  ipcMain.handle('ai:panic', () => panicClear());
  ipcMain.handle('ai:cancel', () => ai.cancel());
  ipcMain.handle('ai:clear-history', () => {
    ai.clearHistory();
    answers.length = 0;
    cursor = -1;
    lastCaptureHash = null;
    send('answer:show', null);
    return true;
  });
  ipcMain.handle('ai:get-settings', () => {
    const activeId = ai.activeProviderId();
    return {
      ...config.get('ai'),
      providers: ai.availableProviders(), // only ids with a real adapter registered
      modelCatalog: config.MODEL_CATALOG,
      capture: config.get('capture'),
      key: secrets.status(activeId),
      keyEnvVar: secrets.envVarFor(activeId),
      needsKey: ai.activeProviderNeedsKey(),
      usage: usage.snapshot(),
      display: {
        opacity: config.get('opacity'),
        fontScale: config.get('fontScale'),
        autoSize: config.get('autoSize'),
        theme: config.get('theme'),
      },
    };
  });
  ipcMain.handle('ai:set-key', async (_e, key) => {
    if (key) {
      const check = await ai.validateKey(key);
      // Fail at save time rather than on the first real question.
      if (!check.ok) return { ok: false, error: check.error };
    }
    const result = secrets.setKey(ai.activeProviderId(), key);
    if (result.ok) ai.invalidateClient();
    return result;
  });
  ipcMain.handle('ai:set-option', (_e, { name, value }) => {
    const aiKeys = ['model', 'effort', 'budgetUsd', 'maxTokens', 'historyTurns', 'retryEffort', 'keepHistory'];
    const captureKeys = ['quality', 'display', 'skipUnchanged'];
    const topKeys = { opacity: 'opacity', fontScale: 'fontScale', autoSize: 'autoSize', theme: 'theme' };

    if (name === 'provider') {
      if (!ai.availableProviders().includes(value)) {
        return { ok: false, error: `No adapter registered for provider "${value}".` };
      }
      const current = config.get('ai');
      // Restore whatever model was last picked for that provider, or fall
      // back to its first suggested model — never leave `model` pointing at
      // a model the new provider doesn't recognize.
      const nextModel = current.models[value] || config.MODEL_CATALOG[value]?.[0] || '';
      config.set('ai', { ...current, provider: value, model: nextModel });
      ai.invalidateClient(); // the old provider's cached client is now irrelevant
      lastCaptureHash = null; // a provider switch is as good as a model switch
      return { ok: true };
    }

    if (aiKeys.includes(name)) {
      const current = config.get('ai');
      const patch = { ...current, [name]: value };
      // Keep the per-provider memory in sync so switching providers and back
      // restores this pick instead of falling back to a default.
      if (name === 'model') patch.models = { ...current.models, [current.provider]: value };
      config.set('ai', patch);
      if (name === 'model') lastCaptureHash = null;
      if (name === 'keepHistory' && value === false) ai.clearHistory();
      return { ok: true };
    }
    if (captureKeys.includes(name)) {
      config.set('capture', { ...config.get('capture'), [name]: value });
      lastCaptureHash = null;
      return { ok: true };
    }
    if (topKeys[name]) {
      config.set(name, value);
      overlay.applyDisplaySettings();
      return { ok: true };
    }
    return { ok: false, error: `Unknown option "${name}".` };
  });
  ipcMain.handle('ai:reset-usage', () => {
    usage.resetLifetime();
    return usage.snapshot();
  });
}
