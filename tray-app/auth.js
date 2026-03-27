/**
 * Authentication module for Claude Dashboard
 * Imports credentials directly from Claude Code's macOS keychain.
 * Does NOT refresh tokens itself — always re-imports from keychain
 * so Claude Code remains the single owner of token lifecycle.
 */

const { app, safeStorage } = require("electron");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

const AUTH_FILE = () => path.join(app.getPath("userData"), "auth.enc");
const REQUEST_TIMEOUT_MS = 10_000;

let cachedToken = null;

// ─── Credential storage (safeStorage + encrypted file) ─────────────────────

function saveCredentials(tokenData) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Encryption not available on this system");
  }
  const json = JSON.stringify(tokenData);
  const encrypted = safeStorage.encryptString(json);
  fs.writeFileSync(AUTH_FILE(), encrypted);
  cachedToken = tokenData;
}

function loadCredentials() {
  if (cachedToken) return cachedToken;
  try {
    const encrypted = fs.readFileSync(AUTH_FILE());
    const json = safeStorage.decryptString(encrypted);
    cachedToken = JSON.parse(json);
    return cachedToken;
  } catch {
    return null;
  }
}

function clearCredentials() {
  cachedToken = null;
  try {
    fs.unlinkSync(AUTH_FILE());
  } catch {
    // File may not exist
  }
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const contentType = typeof body === "string"
      ? "application/x-www-form-urlencoded"
      : "application/json";
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method: "POST",
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "content-type": contentType,
          "content-length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.write(data);
    req.end();
  });
}

function httpsPostJSON(url, body, headers = {}) {
  return httpsPost(url, body, headers);
}

// ─── Import from Claude Code keychain ────────────────────────────────────────

function importFromKeychain() {
  try {
    // Try user-account entry first (active Claude Code), fall back to generic
    let raw;
    try {
      raw = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-a", process.env.USER || "", "-w"],
        { encoding: "utf8", timeout: 5000 }
      ).trim();
    } catch {
      raw = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-a", "Claude Code", "-w"],
        { encoding: "utf8", timeout: 5000 }
      ).trim();
    }
    const creds = JSON.parse(raw);
    if (!creds?.claudeAiOauth) return false;

    const oauth = creds.claudeAiOauth;
    saveCredentials({
      accessToken: oauth.accessToken,
      expiresAt: oauth.expiresAt || 0,
      subscriptionType: oauth.subscriptionType || null,
      rateLimitTier: oauth.rateLimitTier || null,
    });
    return true;
  } catch {
    return false;
  }
}

// ─── Token access ───────────────────────────────────────────────────────────

function getValidAccessToken() {
  const creds = loadCredentials();
  if (!creds) return null;

  // Token still valid (5 min buffer) — use it
  if (creds.expiresAt && creds.expiresAt > Date.now() + 300_000) {
    return creds.accessToken;
  }

  // Token expired — re-import fresh from Claude Code's keychain
  console.log("[auth] Token expired, re-importing from keychain...");
  cachedToken = null; // clear in-memory cache so importFromKeychain saves fresh
  if (importFromKeychain()) {
    console.log("[auth] Keychain re-import successful");
    return cachedToken.accessToken;
  }

  console.error("[auth] Keychain re-import failed");
  return null;
}

// ─── Login (imports fresh from Claude Code keychain) ─────────────────────────

async function login() {
  clearCredentials();

  if (!importFromKeychain()) {
    throw new Error("Could not find Claude Code credentials in keychain — make sure Claude Code is logged in");
  }

  return loadCredentials();
}

module.exports = {
  saveCredentials,
  loadCredentials,
  clearCredentials,
  login,
  importFromKeychain,
  getValidAccessToken,
  httpsPostJSON,
};
