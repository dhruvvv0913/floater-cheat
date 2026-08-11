import answerView from './views/answer.js';
import settingsView from './views/settings.js';

/**
 * Panel shell.
 *
 * Owns reveal state, drag-to-move, and which of the two views is mounted.
 * There is deliberately no chrome — no titlebar, no status dots, no button
 * bar. In answer mode the panel is a single block of text and nothing else;
 * everything configurable lives in the tray menu's Settings view.
 */

const api = window.overlay;

const panel = document.getElementById('panel');
const host = document.getElementById('view');
const marker = document.getElementById('marker');

const VIEWS = { answer: answerView, settings: settingsView };

let state = { revealed: false, mode: 'answer', protectionEnabled: true, pinned: false };
let info = null;
let mounted = null;
let mountedMode = null;
const subscribers = new Set();

/* --------------------------------------------------------------- helpers */

export function formatAccel(accelerator) {
  return (accelerator || '')
    .replace(/\bControl\b|\bCommandOrControl\b/g, 'Ctrl')
    .replace(/\bReturn\b/g, 'Enter');
}

export function kbd(accelerator) {
  const el = document.createElement('kbd');
  el.textContent = formatAccel(accelerator);
  return el;
}

/* ----------------------------------------------------------------- state */

function applyState(next) {
  state = next;
  panel.classList.toggle('revealed', !!state.revealed);
  panel.classList.toggle('mode-answer', state.mode === 'answer');

  if (state.mode !== mountedMode) mountView(state.mode);
  for (const fn of subscribers) fn(state);
}

function mountView(mode) {
  if (mounted?.unmount) mounted.unmount();
  host.replaceChildren();
  mountedMode = mode;
  const view = VIEWS[mode] || VIEWS.answer;
  try {
    mounted = view.mount(host, context()) || {};
  } catch (err) {
    mounted = {};
    host.textContent = `View "${mode}" failed: ${err.message}`;
    console.error(`[view:${mode}]`, err);
  }
}

function context() {
  return {
    api,
    info,
    getState: () => state,
    onState: (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    setBusy: (busy) => panel.classList.toggle('busy', busy),
    kbd,
    formatAccel,
  };
}

/* ------------------------------------------------------------------ drag */

// Press and hold anywhere on the panel to move it. Handled here rather than
// with -webkit-app-region so it keeps working on a transparent, non-focusable
// window, where app-region hit-testing is unreliable.
function startDrag(event) {
  if (event.button !== 0) return;
  // Never hijack a press aimed at a control.
  if (event.target.closest('input, textarea, button, select, a')) return;
  // Settings has its own handle; dragging from anywhere would fight the form.
  if (state.mode === 'settings' && !event.target.closest('.settings-head')) return;

  event.preventDefault();
  let lastX = event.screenX;
  let lastY = event.screenY;

  panel.classList.add('dragging');
  api.setDragging(true);

  const onMove = (e) => {
    api.moveBy(e.screenX - lastX, e.screenY - lastY);
    lastX = e.screenX;
    lastY = e.screenY;
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    panel.classList.remove('dragging');
    api.setDragging(false);
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

panel.addEventListener('mousedown', startDrag);

/* -------------------------------------------------------------- selftest */

// Two-frame paint: set the class, let layout and paint land, and only then
// tell main it is safe to capture. Skipping this races the compositor and
// produces a false "protected" result.
api.onShowMarker((show) => {
  marker.hidden = !show;
  requestAnimationFrame(() => requestAnimationFrame(() => api.markerPainted()));
});

api.onBlank((blanked) => panel.classList.toggle('blanked', !!blanked));

function applyFontScale(scale) {
  document.documentElement.style.fontSize = `${Math.round(13 * (scale || 1))}px`;
}

// Theme is resolved in main (so 'auto' can follow Windows) and arrives already
// reduced to 'dark' or 'light'; the renderer just stamps it on <html>.
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

api.onDisplay((payload) => {
  if (payload?.fontScale != null) applyFontScale(payload.fontScale);
  if (payload?.theme) applyTheme(payload.theme);
});

/* ------------------------------------------------------------------ boot */

async function boot() {
  info = await api.getInfo();
  applyFontScale(info.fontScale);
  applyTheme(info.theme);
  applyState(await api.getState());
  api.onState(applyState);
}

boot();
