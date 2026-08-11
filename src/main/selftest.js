'use strict';

const { desktopCapturer, screen, ipcMain } = require('electron');
const overlay = require('./overlay-window');

/**
 * Automated verification that the overlay really is excluded from capture.
 *
 * The capture is taken with Electron's own desktopCapturer, which on Windows
 * goes through Windows Graphics Capture — the same path Zoom, Teams, Meet,
 * Discord and OBS use. So a pass here is meaningful, not a simulation.
 *
 * The test runs in two phases, and the order matters:
 *
 *   1. CONTROL   protection OFF -> the marker MUST be found.
 *   2. ASSERTION protection ON  -> the marker MUST NOT be found.
 *
 * Without phase 1 a "pass" is worthless: a broken crop, a failed capture or a
 * blank screen source would all silently report "not found" and look like
 * success. If the control fails we report INCONCLUSIVE rather than a green tick.
 */

// Pure magenta. Vanishingly rare in real UI, so false positives are unlikely.
const MARKER = { r: 255, g: 0, b: 255 };
const CHANNEL_TOLERANCE = 60;
// Enough to shrug off scaling/compression speckle, small enough that a marker
// filling most of the panel is nowhere near the threshold.
const MIN_MATCHING_PIXELS = 40;
const COMPOSITOR_SETTLE_MS = 260;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isMarker(b, g, r) {
  return (
    Math.abs(r - MARKER.r) <= CHANNEL_TOLERANCE &&
    Math.abs(g - MARKER.g) <= CHANNEL_TOLERANCE &&
    Math.abs(b - MARKER.b) <= CHANNEL_TOLERANCE
  );
}

/** Ask the renderer to paint the marker, and wait until it confirms a frame. */
function paintMarker(win, on) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve();

    const done = () => {
      clearTimeout(timeout);
      ipcMain.removeListener('selftest:marker-painted', done);
      resolve();
    };
    // Never hang the test on a renderer that failed to reply.
    const timeout = setTimeout(done, 1500);

    ipcMain.once('selftest:marker-painted', done);
    win.webContents.send('selftest:show-marker', on);
  });
}

/** Grab the display the overlay currently sits on, at native pixel size. */
async function captureOverlayDisplay(win) {
  const winBounds = win.getBounds();
  const display = screen.getDisplayMatching(winBounds);
  const physical = {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
  };

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: physical,
  });
  if (!sources.length) return null;

  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  const image = source.thumbnail;
  if (!image || image.isEmpty()) return null;

  const size = image.getSize();
  // Derive scale from what we actually got back rather than assuming the
  // compositor honoured thumbnailSize exactly.
  const scaleX = size.width / display.bounds.width;
  const scaleY = size.height / display.bounds.height;

  const crop = {
    x: Math.round((winBounds.x - display.bounds.x) * scaleX),
    y: Math.round((winBounds.y - display.bounds.y) * scaleY),
    width: Math.round(winBounds.width * scaleX),
    height: Math.round(winBounds.height * scaleY),
  };

  return { bitmap: image.toBitmap(), size, crop };
}

/** Count marker-coloured pixels inside the overlay's rectangle. */
function countMarkerPixels(capture) {
  const { bitmap, size, crop } = capture;

  // Clamp to the captured image in case the panel hangs off the screen edge.
  const x0 = Math.max(0, crop.x);
  const y0 = Math.max(0, crop.y);
  const x1 = Math.min(size.width, crop.x + crop.width);
  const y1 = Math.min(size.height, crop.y + crop.height);
  if (x1 <= x0 || y1 <= y0) return { count: 0, sampled: 0 };

  let count = 0;
  let sampled = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * size.width + x) * 4; // toBitmap() is BGRA
      sampled++;
      if (isMarker(bitmap[i], bitmap[i + 1], bitmap[i + 2])) count++;
    }
  }
  return { count, sampled };
}

async function probe(win, protectionOn) {
  overlay.setProtection(protectionOn);
  await delay(COMPOSITOR_SETTLE_MS);
  const capture = await captureOverlayDisplay(win);
  if (!capture) return { ok: false, count: 0, sampled: 0 };
  return { ok: true, ...countMarkerPixels(capture) };
}

async function run() {
  const win = overlay.getWindow();
  if (!win || win.isDestroyed()) {
    return { status: 'error', message: 'Overlay window is not available.' };
  }

  const wasProtected = overlay.getState().protectionEnabled;
  const wasPinned = overlay.getState().pinned;

  try {
    // Pin it open for the duration — hover-driven reveal would otherwise hide
    // the marker the moment the cursor moved away mid-test.
    overlay.setPinned(true);
    await paintMarker(win, true);

    const control = await probe(win, false);
    if (!control.ok) {
      return {
        status: 'inconclusive',
        message:
          'Could not capture the screen at all. Grant screen-recording permission, then retry.',
      };
    }
    if (control.count < MIN_MATCHING_PIXELS) {
      return {
        status: 'inconclusive',
        message:
          'Control pass failed: the marker was not visible to the capture even with protection OFF. ' +
          'The test cannot distinguish real protection from a broken capture, so this is not a pass.',
        detail: `control matched ${control.count} px of ${control.sampled} sampled`,
      };
    }

    const assertion = await probe(win, true);
    if (!assertion.ok) {
      return { status: 'inconclusive', message: 'Second capture failed unexpectedly.' };
    }

    if (assertion.count < MIN_MATCHING_PIXELS) {
      return {
        status: 'pass',
        message:
          'Overlay is excluded from screen capture. Zoom, Teams, Meet, Discord, OBS and ' +
          'the Snipping Tool all read the same DWM output and will not see it.',
        detail: `control ${control.count} px visible -> protected ${assertion.count} px visible`,
      };
    }

    return {
      status: 'fail',
      message:
        'The overlay is still visible to screen capture. Content protection is not taking effect ' +
        'on this machine — do not rely on it.',
      detail: `control ${control.count} px visible -> protected ${assertion.count} px still visible`,
    };
  } catch (err) {
    return { status: 'error', message: err.message };
  } finally {
    // Always restore what the user had, whatever happened above.
    await paintMarker(win, false);
    overlay.setProtection(wasProtected);
    overlay.setPinned(wasPinned);
  }
}

module.exports = { run };
