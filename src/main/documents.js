'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./logger');

/**
 * Reference document context.
 *
 * Attach a PDF or text file and its contents are prepended to the system
 * prompt, so answers are grounded in your own material (course notes, a spec,
 * a textbook chapter) instead of the model's general knowledge.
 *
 * Design decisions worth knowing:
 *
 *   - The extracted TEXT is cached in config.json, not just the file path.
 *     Re-parsing a PDF on every question would add hundreds of ms to the
 *     latency budget for a file that almost never changes. The path is stored
 *     too, purely so the UI can show which file it came from and detect that
 *     the file has since been edited.
 *
 *   - It is truncated, hard. A 200-page PDF would blow past the context window
 *     and cost a fortune per question — every question, since this ships on
 *     every request. See MAX_CHARS.
 *
 *   - This is the ONE piece of user content that gets persisted to disk in
 *     plain text (config.json). Screenshots never are, answers never are. The
 *     UI says so, and "Remove" deletes it.
 */

// ~40k characters is roughly 10k tokens — enough for a dense chapter or a full
// spec, while staying a sane fraction of the per-question bill. Anything
// bigger is better served by a region-cropped screenshot of the relevant page.
const MAX_CHARS = 40000;

const SUPPORTED_EXTENSIONS = ['.pdf', '.txt', '.md', '.markdown', '.text', '.csv', '.json'];

function blank() {
  return { path: null, name: null, text: '', chars: 0, truncated: false, attachedAt: null };
}

function current() {
  return config.get('document') || blank();
}

/** Strip pdf-parse's own "-- 1 of 3 --" page-break markers from extracted text. */
function stripPageMarkers(text) {
  return text.replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, '');
}

function tidy(text) {
  return stripPageMarkers(text)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n') // collapse runs of blank lines from PDF layout
    .trim();
}

async function extractPdf(filePath) {
  // Required lazily: pdf-parse pulls in pdfjs and is comparatively heavy, and
  // most sessions never attach a document at all.
  const { PDFParse } = require('pdf-parse');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    return result.text || '';
  } finally {
    // Frees the underlying pdfjs worker — skipping this leaks it for the
    // lifetime of the app.
    await parser.destroy();
  }
}

/**
 * Read and attach a file as the reference document.
 * @returns {Promise<{ok: boolean, error?: string, document?: object}>}
 */
async function attach(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    return {
      ok: false,
      error: `Unsupported file type "${extension}". Use PDF or a plain-text file.`,
    };
  }

  let raw;
  try {
    raw = extension === '.pdf' ? await extractPdf(filePath) : fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    log.error('[documents] could not read', filePath, err.message);
    return { ok: false, error: `Could not read that file: ${err.message}` };
  }

  const text = tidy(raw);
  if (!text) {
    return {
      ok: false,
      error:
        extension === '.pdf'
          ? 'No text found — this PDF is probably a scan. Use region capture on the page instead.'
          : 'That file is empty.',
    };
  }

  const truncated = text.length > MAX_CHARS;
  const document = {
    path: filePath,
    name: path.basename(filePath),
    text: truncated ? text.slice(0, MAX_CHARS) : text,
    chars: Math.min(text.length, MAX_CHARS),
    truncated,
    attachedAt: Date.now(),
  };

  config.set('document', document);
  log.info(
    `[documents] attached ${document.name} — ${document.chars} chars${truncated ? ' (truncated)' : ''}`
  );
  return { ok: true, document: describe() };
}

function clear() {
  config.set('document', blank());
  log.info('[documents] detached');
}

/** Safe to send to the renderer: metadata only, never the full text. */
function describe() {
  const doc = current();
  if (!doc.path) return null;
  return {
    name: doc.name,
    chars: doc.chars,
    truncated: doc.truncated,
    // A file edited after attaching means the cached text is stale — surface
    // it rather than silently answering from an old revision.
    stale: fileChangedSinceAttach(doc),
  };
}

function fileChangedSinceAttach(doc) {
  if (!doc.path || !doc.attachedAt) return false;
  try {
    return fs.statSync(doc.path).mtimeMs > doc.attachedAt;
  } catch {
    // Moved or deleted — the cached text still works, so this isn't an error,
    // but it is no longer verifiable against the source.
    return false;
  }
}

/**
 * The block prepended to the system prompt, or '' when nothing is attached.
 * Kept as its own function so ai.js doesn't need to know the storage shape.
 */
function promptBlock() {
  const doc = current();
  if (!doc.text) return '';
  return [
    `The user attached a reference document ("${doc.name}")${
      doc.truncated ? ', truncated to its first section' : ''
    }. Prefer it over general knowledge when the two disagree, and say so if the`,
    'answer is not in it rather than inventing one.',
    '',
    '--- BEGIN DOCUMENT ---',
    doc.text,
    '--- END DOCUMENT ---',
  ].join('\n');
}

module.exports = { attach, clear, describe, promptBlock, current, MAX_CHARS, SUPPORTED_EXTENSIONS };
