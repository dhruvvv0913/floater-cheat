'use strict';

/**
 * Pure, dependency-free shortcut helpers — no Electron import, so these run
 * (and get tested) without booting a window. Two questions worth answering
 * before ever asking the OS to register anything:
 *
 *   1. did the user bind two of OUR OWN actions to the same key? (a conflict
 *      globalShortcut can't detect for us — it just registers whichever one
 *      wins the race and silently no-ops the other)
 *   2. is the accelerator even shaped like a real shortcut?
 */

const MODIFIERS = new Set([
  'CommandOrControl', 'CmdOrCtrl',
  'Command', 'Cmd',
  'Control', 'Ctrl',
  'Alt', 'Option', 'AltGr',
  'Shift',
  'Super', 'Meta',
]);

/** Normalize for comparison: trim, collapse case, but keep key order out of it. */
function normalize(accelerator) {
  return String(accelerator || '')
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('+');
}

/**
 * @param {Record<string,string>} hotkeysMap  action -> accelerator
 * @returns {Array<{a: string, b: string, accelerator: string}>}
 */
function findConflicts(hotkeysMap) {
  const seen = new Map(); // normalized accelerator -> first action that claimed it
  const conflicts = [];

  for (const [action, accelerator] of Object.entries(hotkeysMap || {})) {
    if (!accelerator) continue;
    const key = normalize(accelerator);
    if (!key) continue;

    const existing = seen.get(key);
    if (existing) {
      conflicts.push({ a: existing, b: action, accelerator });
    } else {
      seen.set(key, action);
    }
  }

  return conflicts;
}

/** Must have at least one non-modifier key alongside whatever modifiers it has. */
function isValidAccelerator(accelerator) {
  if (!accelerator || typeof accelerator !== 'string') return false;
  const parts = accelerator.split('+').map((p) => p.trim());
  if (parts.some((p) => !p)) return false; // "Control++Space" or a trailing "+"
  const keys = parts.filter((p) => !MODIFIERS.has(p));
  return keys.length >= 1;
}

module.exports = { findConflicts, isValidAccelerator, normalize };
