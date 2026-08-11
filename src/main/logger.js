'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Rotating file log.
 *
 * stdout is useless here: the app is normally launched by double-clicking a
 * packaged .exe, or from a terminal that gets closed. When something misbehaves
 * mid-exam there has to be a file to look at afterwards.
 */

const MAX_BYTES = 1024 * 1024; // rotate at 1MB, keep one previous
let stream = null;
let filePath = null;

function file() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'floater-cheat.log');
  return filePath;
}

function rotateIfNeeded() {
  try {
    const { size } = fs.statSync(file());
    if (size < MAX_BYTES) return;
    if (stream) {
      stream.end();
      stream = null;
    }
    fs.renameSync(file(), `${file()}.1`);
  } catch {
    // No file yet, or rotation raced another write — either way, carry on.
  }
}

function out() {
  if (!stream) {
    rotateIfNeeded();
    stream = fs.createWriteStream(file(), { flags: 'a' });
    stream.on('error', (err) => {
      console.error('[logger] write failed, falling back to console:', err.message);
      stream = null;
    });
  }
  return stream;
}

function write(level, args) {
  const line = args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ');
  const record = `${new Date().toISOString()} ${level.padEnd(5)} ${line}\n`;

  // Mirror to the console so `npm start` still shows everything live.
  (level === 'ERROR' ? console.error : console.log)(record.trimEnd());

  try {
    out()?.write(record);
  } catch {
    // Never let logging take the app down.
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = {
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
  file,
};
