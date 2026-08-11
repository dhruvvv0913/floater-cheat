'use strict';

const { spawn } = require('child_process');
const electronPath = require('electron');

/**
 * Launcher.
 *
 * VS Code (and anything else built on Electron) exports ELECTRON_RUN_AS_NODE=1
 * into its integrated terminal. Inherited by our child, that flag makes the
 * electron binary boot as a plain Node process: process.type is undefined and
 * require('electron') resolves to the executable's path string rather than the
 * API object, so the app dies on `app.requestSingleInstanceLock is not a
 * function`. Stripping it here means `npm start` behaves the same from VS Code,
 * Windows Terminal or a bare cmd.exe.
 */
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('close', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('Failed to launch Electron:', err.message);
  process.exit(1);
});
