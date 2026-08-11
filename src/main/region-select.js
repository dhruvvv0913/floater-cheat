'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const config = require('./config');
const log = require('./logger');

/**
 * Region picker: a full-screen scrim the user drags a box on.
 *
 * Cropping to a region is the single biggest lever this app has. A 700x400 crop
 * versus a 2560x1440 screen is roughly an order of magnitude fewer image
 * tokens, a correspondingly smaller upload, and — the part that actually
 * matters — no competing questions in frame for the model to answer instead.
 *
 * This window is deliberately NOT content-protected: the user has to see it.
 */

let picker = null;

function open() {
  return new Promise((resolve) => {
    if (picker && !picker.isDestroyed()) {
      picker.focus();
      return resolve(null);
    }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

    picker = new BrowserWindow({
      ...display.bounds,
      frame: false,
      transparent: true,
      // A picker that dodged the taskbar would leave part of the screen
      // unselectable, so cover the full display bounds, not the work area.
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      fullscreenable: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'region.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    picker.setAlwaysOnTop(true, 'screen-saver');
    // Match the overlay's stealth: content protection hides a window from screen
    // capture but NOT from the local display, so the picker stays visible to the
    // user while staying invisible to anyone they happen to be sharing with.
    picker.setContentProtection(config.get('contentProtection'));
    picker.loadFile(path.join(__dirname, '..', 'renderer', 'region.html'));
    picker.once('ready-to-show', () => {
      picker.show();
      picker.focus();
    });

    let settled = false;
    const finish = (region) => {
      if (settled) return;
      settled = true;
      if (picker && !picker.isDestroyed()) picker.close();
      picker = null;
      resolve(region);
    };

    picker.webContents.ipc.on('region:done', (_event, rect) => {
      if (!rect || rect.width < 8 || rect.height < 8) {
        log.info('[region] selection cancelled or too small');
        return finish(null);
      }
      // Renderer coordinates are display-local CSS pixels; store absolute
      // screen coordinates so the crop still resolves if the panel or cursor
      // later lives on a different monitor.
      const region = {
        x: Math.round(display.bounds.x + rect.x),
        y: Math.round(display.bounds.y + rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      config.set('capture', { ...config.get('capture'), region });
      log.info('[region] set', region);
      finish(region);
    });

    picker.webContents.ipc.on('region:cancel', () => finish(null));
    picker.on('closed', () => finish(null));
  });
}

function clear() {
  config.set('capture', { ...config.get('capture'), region: null });
  log.info('[region] cleared — capturing the full display again');
}

function current() {
  return config.get('capture').region;
}

module.exports = { open, clear, current };
