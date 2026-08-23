'use strict';

const path = require('path');
const { BrowserWindow, screen, nativeTheme } = require('electron');
const config = require('./config');

/**
 * The overlay window and everything that makes it "stealthy".
 *
 * Visibility model: the panel is invisible by default and reveals itself when
 * the cursor is inside its bounds. Five things can hold it open —
 *
 *   hovered   cursor is within the window bounds (polled, see watchCursor)
 *   pinned    user pressed the pin hotkey to read without holding the mouse
 *   dragging  a move is in progress; the cursor can outrun the window
 *   inputOpen the text box is up, so hiding mid-sentence would be maddening
 *   peeking   tapped the peek hotkey; times out unless hover takes over first
 *             (see startPeek — this is a deliberate approximation of "hold to
 *             show": Electron's global-hotkey API has no key-up event, so a
 *             real press-and-release-to-hide isn't available without adding a
 *             native keyboard hook)
 *
 * Revealing is a CSS class in the renderer, never win.hide(): on Windows,
 * setContentProtection has a long history of silently dropping after a
 * hide()/show() cycle, and this window toggles many times a minute.
 */

let win = null;
let saveTimer = null;
let hideTimer = null;
let cursorTimer = null;
let peekTimer = null;
let lastApplied = null;

const state = {
  protectionEnabled: config.get('contentProtection'),
  hovered: false,
  pinned: false,
  dragging: false,
  inputOpen: false,
  peeking: false,
  mode: 'answer', // 'answer' | 'settings'
};

const isRevealed = () =>
  state.pinned || state.hovered || state.dragging || state.inputOpen || state.peeking;

function initialBounds() {
  const saved = config.get('bounds');
  const work = screen.getPrimaryDisplay().workArea;
  const width = Math.min(saved.width, work.width);
  const height = Math.min(saved.height, work.height);
  return clampToDisplay({
    width,
    height,
    x: saved.x === null ? work.x + work.width - width - 24 : saved.x,
    y: saved.y === null ? work.y + 24 : saved.y,
  });
}

function clampToDisplay(bounds) {
  const work = screen.getDisplayMatching(bounds).workArea;
  // Always leave a grabbable sliver on screen — an invisible panel parked fully
  // off-display would be unrecoverable except by editing config.json.
  const margin = 40;
  return {
    width: bounds.width,
    height: bounds.height,
    x: Math.round(
      Math.min(Math.max(bounds.x, work.x - bounds.width + margin), work.x + work.width - margin)
    ),
    y: Math.round(Math.min(Math.max(bounds.y, work.y), work.y + work.height - margin)),
  };
}

function create() {
  win = new BrowserWindow({
    ...initialBounds(),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    // Out of the taskbar AND out of Alt+Tab. An overlay that shows up in
    // Alt+Tab gives itself away far more readily than a stray pixel.
    skipTaskbar: true,
    // Never take focus from whatever is underneath; flipped on only while the
    // text box is open.
    focusable: false,
    thickFrame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.error(`[renderer:${event.level}] ${event.message} (${event.lineNumber})`);
    }
  });
  // A dead renderer leaves an invisible, permanently blank panel with no
  // outward sign anything is wrong — reload rather than leaving a corpse.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] gone:', details.reason, '— reloading');
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) {
      win.reload();
      lastApplied = null; // force the window flags to be re-applied after reload
    }
  });

  win.once('ready-to-show', () => {
    win.showInactive(); // not show() — launching must not pull focus either
    applyAll();
    watchCursor();
  });

  win.on('blur', reassertTopmost);
  win.on('move', scheduleBoundsSave);

  screen.on('display-metrics-changed', () => {
    if (!win || win.isDestroyed()) return;
    win.setBounds(clampToDisplay(win.getBounds()));
    applyAll();
  });

  // When the user is on 'auto' and flips Windows between light and dark, follow.
  nativeTheme.on('updated', () => {
    if (config.get('theme') === 'auto') applyDisplaySettings();
  });

  return win;
}

/* ------------------------------------------------------------------ hover */

let lastPoint = { x: -1, y: -1 };
let lastMovedAt = Date.now();
let pollingIdle = false;

function watchCursor() {
  const hover = config.get('hover');
  if (!hover.enabled) {
    state.pinned = true;
    applyAll();
    return;
  }
  schedulePoll(hover, false);
}

/**
 * Poll the cursor, backing off to a lazy interval once the mouse has been
 * completely still for a while. Sampling 16x/second forever is pointless when
 * the machine has been untouched since last night.
 */
function schedulePoll(hover, idle) {
  clearInterval(cursorTimer);
  pollingIdle = idle;
  cursorTimer = setInterval(() => tick(hover), idle ? hover.idlePollMs : hover.pollMs);
}

function tick(hover) {
  if (!win || win.isDestroyed()) return;

  const point = screen.getCursorScreenPoint();
  const moved = point.x !== lastPoint.x || point.y !== lastPoint.y;
  lastPoint = point;

  if (moved) {
    lastMovedAt = Date.now();
    if (pollingIdle) schedulePoll(hover, false); // wake straight back up
  } else if (!pollingIdle && Date.now() - lastMovedAt > hover.idleAfterMs) {
    schedulePoll(hover, true);
  }

  const b = win.getBounds();
  const inside =
    point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
  if (inside === state.hovered) return;

  clearTimeout(hideTimer);
  if (inside || hover.hideDelayMs <= 0) {
    state.hovered = inside;
    applyReveal();
  } else {
    hideTimer = setTimeout(() => {
      state.hovered = false;
      applyReveal();
    }, hover.hideDelayMs);
  }
}

/* ----------------------------------------------------------------- apply */

function applyAll() {
  if (!win || win.isDestroyed()) return;

  // On Windows this is SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE),
  // enforced inside DWM — it covers Windows Graphics Capture, DXGI Desktop
  // Duplication and legacy BitBlt/GDI in one call.
  win.setContentProtection(state.protectionEnabled);
  win.setOpacity(config.get('opacity'));
  reassertTopmost();
  applyReveal();
}

function reassertTopmost() {
  if (!win || win.isDestroyed()) return;
  // 'screen-saver' is the highest level Electron exposes, so the panel floats
  // above full-screen apps instead of vanishing behind them.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function applyReveal() {
  if (!win || win.isDestroyed()) return;

  const revealed = isRevealed();
  const focusable = state.inputOpen;
  const signature = `${revealed}|${focusable}`;

  // Poll fires ~16x/second; only touch the window when something changed.
  if (signature !== lastApplied) {
    lastApplied = signature;
    // Clickable while revealed so press-and-hold dragging works. This does
    // create a click dead-zone over the panel — acceptable because the panel is
    // only clickable when the cursor is already sitting on it.
    win.setIgnoreMouseEvents(!revealed, { forward: true });
    win.setFocusable(focusable);
  }

  pushState();
}

function pushState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('overlay:state', { ...state, revealed: isRevealed() });
}

function scheduleBoundsSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    config.set('bounds', win.getBounds());
  }, 400);
}

/* ---------------------------------------------------------------- actions */

function setProtection(enabled) {
  state.protectionEnabled = enabled;
  config.set('contentProtection', enabled);
  applyAll();
}

function toggleProtection() {
  setProtection(!state.protectionEnabled);
  return state.protectionEnabled;
}

function setPinned(pinned) {
  state.pinned = pinned;
  applyReveal();
}

function togglePin() {
  setPinned(!state.pinned);
  return state.pinned;
}

function setDragging(dragging) {
  state.dragging = dragging;
  applyReveal();
  if (!dragging) scheduleBoundsSave();
}

function setInputOpen(open) {
  const opening = open && !state.inputOpen;
  state.inputOpen = open;
  applyReveal();
  // Focus only on the transition, or every unrelated state change re-steals it.
  if (opening && win && !win.isDestroyed()) win.focus();
}

/**
 * Tap-to-peek: reveal briefly without hovering or pinning. A second tap while
 * already peeking dismisses it early (toggle, not "extend the timer") — a
 * global hotkey works regardless of window focus, so this is the reliable
 * "make it go away now" path; the panel isn't focusable during a peek (same
 * as normal click-through), so Esc can't reach it the way it can when the
 * text box is open.
 *
 * If the cursor reaches the panel before the timer fires, `hovered` takes
 * over on its own — isRevealed() already ORs every flag — so nothing special
 * has to happen here for that handoff to feel seamless.
 */
function startPeek() {
  if (state.peeking) return stopPeek();
  clearTimeout(peekTimer);
  state.peeking = true;
  applyReveal();
  peekTimer = setTimeout(() => {
    state.peeking = false;
    applyReveal();
  }, config.get('peek').durationMs);
}

function stopPeek() {
  clearTimeout(peekTimer);
  if (!state.peeking) return;
  state.peeking = false;
  applyReveal();
}

function setMode(mode) {
  const settings = mode === 'settings';
  state.mode = mode;
  // Settings needs to be readable and clickable without holding the mouse
  // still, and its fields need keyboard focus. Both must drop on the way out —
  // leaving inputOpen set would keep the panel focusable and permanently
  // revealed after closing Settings.
  state.pinned = settings;
  state.inputOpen = settings;
  applyReveal();
}

/** Hide the panel's pixels while screenshotting with stealth off. */
function setPanelBlanked(blanked) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('overlay:blank', blanked);
}

/** Resolve the 'auto' theme against the OS; otherwise return the set choice. */
function resolvedTheme() {
  const choice = config.get('theme');
  if (choice === 'light' || choice === 'dark') return choice;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

/** Push opacity, font scale and theme after the user changes them in Settings. */
function applyDisplaySettings() {
  if (!win || win.isDestroyed()) return;
  win.setOpacity(config.get('opacity'));
  win.webContents.send('overlay:display', {
    fontScale: config.get('fontScale'),
    theme: resolvedTheme(),
  });
}

function moveBy(dx, dy) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  win.setBounds(clampToDisplay({ ...b, x: b.x + dx, y: b.y + dy }));
}

function nudge(dx, dy) {
  const step = config.get('moveStep');
  moveBy(dx * step, dy * step);
}

function resizeBy(dw, dh) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  win.setBounds({
    ...b,
    width: Math.max(240, Math.round(b.width + dw)),
    height: Math.max(120, Math.round(b.height + dh)),
  });
  scheduleBoundsSave();
}

/**
 * Shrink-to-fit. A four-word answer sitting in a 200px box is mostly empty
 * panel, which is both uglier and more conspicuous than it needs to be.
 * Width is left alone — a reflowing panel is far more distracting than a
 * growing one.
 */
// Floor is a hover-target concern, not a layout one: the panel is invisible
// until hovered, so if it shrinks to one line you can no longer find it with
// the mouse. Keep it a comfortable target and only grow for long answers.
const MIN_HOVER_HEIGHT = 150;

function setContentHeight(pixels) {
  if (!win || win.isDestroyed() || !config.get('autoSize')) return;

  const work = screen.getDisplayMatching(win.getBounds()).workArea;
  const b = win.getBounds();
  const height = Math.max(MIN_HOVER_HEIGHT, Math.min(Math.round(pixels), Math.round(work.height * 0.8)));
  if (Math.abs(height - b.height) < 4) return; // ignore sub-pixel churn

  win.setBounds(clampToDisplay({ ...b, height }));
}

/** Jump to a screen corner: 0 = top-left, 1 = top-right, 2 = bottom-right, 3 = bottom-left. */
function moveToCorner(index) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const work = screen.getDisplayMatching(b).workArea;
  const margin = 24;
  const left = work.x + margin;
  const right = work.x + work.width - b.width - margin;
  const top = work.y + margin;
  const bottom = work.y + work.height - b.height - margin;
  const corners = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  win.setBounds({ ...b, ...corners[index % 4] });
  scheduleBoundsSave();
}

function getWindow() {
  return win;
}

function getState() {
  return { ...state, revealed: isRevealed() };
}

module.exports = {
  create,
  getWindow,
  getState,
  applyAll,
  pushState,
  setProtection,
  toggleProtection,
  setPinned,
  togglePin,
  setDragging,
  setInputOpen,
  startPeek,
  stopPeek,
  setMode,
  setPanelBlanked,
  applyDisplaySettings,
  resolvedTheme,
  moveBy,
  nudge,
  resizeBy,
  setContentHeight,
  moveToCorner,
};
