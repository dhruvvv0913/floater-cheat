'use strict';

const crypto = require('crypto');
const { desktopCapturer, screen } = require('electron');
const config = require('./config');
const overlay = require('./overlay-window');
const log = require('./logger');

/**
 * Screenshot capture for vision requests.
 *
 * A pleasant consequence of the whole premise of this app: because the overlay
 * sets WDA_EXCLUDEFROMCAPTURE, DWM omits it from these captures too. The model
 * sees what is behind the panel, never the panel itself — no hide/show dance
 * needed. The one exception is when the user has toggled stealth off, which is
 * why captureScreen() blanks the panel for the duration in that case.
 */

// Claude's high-resolution vision tier caps the long edge at 2576px. Smaller
// tiers exist because upload time is most of the round trip on a big display,
// and 1568px still reads body text comfortably.
const TIERS = { fast: 1280, balanced: 1568, max: 2576 };
const JPEG_QUALITY = 92;
const REPAINT_SETTLE_MS = 120;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fitWithin(size, maxEdge) {
  const longEdge = Math.max(size.width, size.height);
  if (longEdge <= maxEdge) return null;
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/**
 * Which display to grab.
 *
 * Defaults to the one under the cursor, not the one the panel is on: with two
 * monitors those are routinely different, and capturing the panel's display
 * silently answers a question about the wrong screen — the worst failure mode
 * this app has, because the answer looks perfectly confident.
 */
function pickDisplay(region) {
  if (region) {
    return screen.getDisplayMatching({
      x: region.x,
      y: region.y,
      width: Math.max(1, region.width),
      height: Math.max(1, region.height),
    });
  }

  const mode = config.get('capture').display;
  if (mode === 'primary') return screen.getPrimaryDisplay();
  if (mode === 'panel') {
    const win = overlay.getWindow();
    if (win && !win.isDestroyed()) return screen.getDisplayMatching(win.getBounds());
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

async function grabDisplay(display) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.bounds.width * display.scaleFactor),
      height: Math.round(display.bounds.height * display.scaleFactor),
    },
  });
  if (!sources.length) throw new Error('No screen sources available.');

  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source.thumbnail || source.thumbnail.isEmpty()) {
    throw new Error('Screen capture returned an empty image.');
  }
  return source.thumbnail;
}

/** Convert a screen-space (DIP) region into image pixel coordinates. */
function regionToPixels(region, display, imageSize) {
  const scaleX = imageSize.width / display.bounds.width;
  const scaleY = imageSize.height / display.bounds.height;

  const x = Math.round((region.x - display.bounds.x) * scaleX);
  const y = Math.round((region.y - display.bounds.y) * scaleY);
  const width = Math.round(region.width * scaleX);
  const height = Math.round(region.height * scaleY);

  // Clamp into the captured image; a region dragged past the edge is common.
  const left = Math.max(0, Math.min(x, imageSize.width - 1));
  const top = Math.max(0, Math.min(y, imageSize.height - 1));
  return {
    x: left,
    y: top,
    width: Math.max(1, Math.min(width, imageSize.width - left)),
    height: Math.max(1, Math.min(height, imageSize.height - top)),
  };
}

/**
 * @returns {Promise<{base64, mediaType, width, height, hash, bytes, ms, region}>}
 */
async function captureScreen() {
  const started = Date.now();
  const settings = config.get('capture');
  const region = settings.region;

  const overlayState = overlay.getState();
  // Only needed when stealth is off — with it on, DWM already excludes us.
  const mustHidePanel = !overlayState.protectionEnabled && overlayState.revealed;

  if (mustHidePanel) {
    overlay.setPanelBlanked(true);
    await delay(REPAINT_SETTLE_MS);
  }

  try {
    const display = pickDisplay(region);
    let image = await grabDisplay(display);

    if (region) {
      image = image.crop(regionToPixels(region, display, image.getSize()));
    }

    const maxEdge = TIERS[settings.quality] || TIERS.balanced;
    const resized = fitWithin(image.getSize(), maxEdge);
    if (resized) image = image.resize({ ...resized, quality: 'best' });

    const buffer = image.toJPEG(JPEG_QUALITY);
    const size = image.getSize();
    const ms = Date.now() - started;

    log.info(
      `[capture] ${size.width}x${size.height} ${(buffer.length / 1024).toFixed(0)}KB ` +
        `in ${ms}ms (display ${display.id}${region ? ', region' : ''})`
    );

    return {
      base64: buffer.toString('base64'),
      mediaType: 'image/jpeg',
      width: size.width,
      height: size.height,
      bytes: buffer.length,
      // Identical screens produce identical JPEGs, which lets the caller skip a
      // pointless paid round trip on a double-press.
      hash: crypto.createHash('sha1').update(buffer).digest('hex'),
      ms,
      region: !!region,
    };
  } finally {
    if (mustHidePanel) overlay.setPanelBlanked(false);
  }
}

module.exports = { captureScreen, TIERS, fitWithin, regionToPixels };
