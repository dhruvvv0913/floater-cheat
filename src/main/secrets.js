'use strict';

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

/**
 * API key storage — one encrypted file per provider.
 *
 * The key is encrypted with Electron's safeStorage, which is backed by the OS
 * keystore (DPAPI on Windows, Keychain on macOS, libsecret on Linux) and tied
 * to the current user account. It deliberately never touches config.json —
 * that file is plain text and gets opened, copied and pasted around.
 *
 * Resolution order when the AI client asks for a key:
 *   1. the encrypted store for that provider
 *   2. that provider's conventional environment variable
 *
 * If OS encryption is unavailable (common on a Linux box with no keyring), we
 * refuse to persist rather than silently writing the key to disk in plain
 * text, and point the user at the environment variable instead.
 *
 * Filename note: before this became multi-provider, the single Anthropic key
 * lived at literally `anthropic-key.bin` — which is exactly what
 * `${provider}-key.bin` produces for provider === 'anthropic'. So there is no
 * migration to write: an existing user's key is found at the same path under
 * the new signature, automatically.
 */

const ENV_VAR_BY_PROVIDER = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

function file(provider) {
  return path.join(app.getPath('userData'), `${provider}-key.bin`);
}

function envVarFor(provider) {
  return ENV_VAR_BY_PROVIDER[provider] || null;
}

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function hasStoredKey(provider) {
  try {
    return fs.existsSync(file(provider));
  } catch {
    return false;
  }
}

/** The key for one provider, or null. Never sent to the renderer. */
function getKey(provider) {
  if (hasStoredKey(provider) && encryptionAvailable()) {
    try {
      return safeStorage.decryptString(fs.readFileSync(file(provider)));
    } catch (err) {
      // A key encrypted under a different OS user or a reset credential store
      // cannot be recovered — surface it rather than failing later as a 401.
      console.error(`[secrets] stored ${provider} key could not be decrypted:`, err.message);
    }
  }
  const envVar = envVarFor(provider);
  return (envVar && process.env[envVar]) || null;
}

function setKey(provider, rawKey) {
  const key = (rawKey || '').trim();

  if (!key) {
    clearKey(provider);
    return { ok: true, cleared: true };
  }
  if (!encryptionAvailable()) {
    const envVar = envVarFor(provider);
    return {
      ok: false,
      error: envVar
        ? `OS encryption is unavailable, so the key will not be written to disk. Set the ${envVar} environment variable instead.`
        : 'OS encryption is unavailable, so the key will not be written to disk.',
    };
  }

  try {
    fs.writeFileSync(file(provider), safeStorage.encryptString(key));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not save the key: ${err.message}` };
  }
}

function clearKey(provider) {
  try {
    if (hasStoredKey(provider)) fs.unlinkSync(file(provider));
  } catch (err) {
    console.error(`[secrets] could not remove stored ${provider} key:`, err.message);
  }
}

/** Safe to send to the renderer — describes the key without revealing it. */
function status(provider) {
  const stored = hasStoredKey(provider) && encryptionAvailable();
  const envVar = envVarFor(provider);
  const fromEnv = !stored && !!(envVar && process.env[envVar]);
  return {
    configured: stored || fromEnv,
    source: stored ? 'encrypted store' : fromEnv ? envVar : null,
    encryptionAvailable: encryptionAvailable(),
  };
}

module.exports = { getKey, setKey, clearKey, status, encryptionAvailable, envVarFor };
