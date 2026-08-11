'use strict';

const { globalShortcut } = require('electron');
const config = require('./config');
const { findConflicts, isValidAccelerator } = require('./shortcut-utils');

/**
 * Global hotkeys.
 *
 * globalShortcut.register returns false when another application already owns
 * the combination. That failure is silent by default, which is a miserable way
 * to debug "my hotkey does nothing" — so failures are collected and surfaced in
 * the overlay's status panel and the tray tooltip, each tagged with *why*:
 *
 *   'conflict'    two of our OWN actions are bound to the same key
 *   'invalid'     the accelerator string isn't shaped like a real shortcut
 *   'unavailable' the OS says another application already owns it
 *
 * Conflicting/invalid entries are never even sent to globalShortcut — there's
 * no point asking the OS to register something we already know is broken.
 */

let failures = [];

function registerAll(actions) {
  unregisterAll();
  const hotkeys = config.get('hotkeys');

  const conflicts = findConflicts(hotkeys);
  const conflictingActions = new Set();
  for (const { a, b, accelerator } of conflicts) {
    conflictingActions.add(a);
    conflictingActions.add(b);
    console.warn(`[hotkeys] conflict: ${a} and ${b} are both bound to ${accelerator}`);
  }
  for (const action of conflictingActions) {
    failures.push({ action, accelerator: hotkeys[action], reason: 'conflict' });
  }

  for (const [action, accelerator] of Object.entries(hotkeys)) {
    const handler = actions[action];
    if (!handler || !accelerator) continue;
    if (conflictingActions.has(action)) continue; // already recorded above

    if (!isValidAccelerator(accelerator)) {
      failures.push({ action, accelerator, reason: 'invalid' });
      console.warn(`[hotkeys] ${action} -> "${accelerator}" is not a valid accelerator`);
      continue;
    }

    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, handler);
    } catch (err) {
      // Malformed accelerators throw rather than returning false — Electron's
      // own validation is stricter in some cases than isValidAccelerator's
      // shape check, so this is a real (if rare) second line of defense.
      console.error(`[hotkeys] ${action} (${accelerator}) rejected by Electron:`, err.message);
      failures.push({ action, accelerator, reason: 'invalid' });
      continue;
    }

    if (!ok) {
      failures.push({ action, accelerator, reason: 'unavailable' });
      console.warn(`[hotkeys] could not register ${action} -> ${accelerator} (already taken by another app?)`);
    }
  }

  return getFailures();
}

function unregisterAll() {
  globalShortcut.unregisterAll();
  failures = [];
}

function getFailures() {
  return failures.slice();
}

module.exports = { registerAll, unregisterAll, getFailures };
