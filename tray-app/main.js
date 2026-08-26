const { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const { parseUsageData, getTokensInWindow } = require("./lib/claude-usage-parser");
const auth = require("./auth");

// Tray-only app — no dock icon
app.dock?.hide();

let tray = null;
let popup = null;
let refreshInterval = null;
let rateLimitInterval = null;
let rateLimits = null;
let rateLimitError = null;
let cachedDashboardData = null;
let rateLimitFetchInFlight = null;
let isQuitting = false;

const API_URL = "https://api.anthropic.com/v1/messages";
const POPUP_WIDTH = 320;
const POPUP_HEIGHT = 440;
const REQUEST_TIMEOUT_MS = 10_000;

// ─── Local disk cache ────────────────────────────────────────────────────────

function getCachePath() {
  return path.join(app.getPath("userData"), "dashboard-cache.json");
}

function loadCache() {
  try {
    const raw = fs.readFileSync(getCachePath(), "utf8");
    const cached = JSON.parse(raw);
    if (cached.rateLimits) rateLimits = cached.rateLimits;
    if (cached.rateLimitError) rateLimitError = cached.rateLimitError;
    if (cached.dashboardData) cachedDashboardData = cached.dashboardData;
  } catch {
    // No cache yet — that's fine
  }
}

let saveCachePending = null;
let saveCacheQueued = false;
function saveCache() {
  // A save requested while one is in flight used to be a silent no-op, so the
  // final state before quit (e.g. after Disconnect) never reached disk. Queue a
  // single trailing write instead.
  if (saveCachePending) {
    saveCacheQueued = true;
    return saveCachePending;
  }
  saveCachePending = (async () => {
    try {
      const cachePath = getCachePath();
      await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.promises.writeFile(cachePath, JSON.stringify({
        rateLimits,
        rateLimitError,
        dashboardData: cachedDashboardData,
      }));
    } catch {
      // Non-critical — ignore write errors
    } finally {
      saveCachePending = null;
    }
    if (saveCacheQueued) {
      saveCacheQueued = false;
      await saveCache();
    }
  })();
  return saveCachePending;
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method: "POST",
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "content-type": "application/json",
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

// ─── Rate limit fetching ─────────────────────────────────────────────────────

async function fetchRateLimits(opts = {}) {
  // Coalesce concurrent callers onto the same request so rapid Refresh clicks
  // don't race multiple writes to rateLimits/rateLimitError.
  if (rateLimitFetchInFlight) return rateLimitFetchInFlight;
  rateLimitFetchInFlight = doFetchRateLimits(opts).finally(() => {
    rateLimitFetchInFlight = null;
  });
  return rateLimitFetchInFlight;
}

async function doFetchRateLimits({ allowReimport = true } = {}) {
  // getValidAccessToken will re-import from keychain if token is expired
  const accessToken = await auth.getValidAccessToken();
  if (!accessToken) {
    rateLimits = null;
    rateLimitError = "Not connected — click Connect to Claude Code";
    return;
  }

  try {
    const res = await httpsPost(
      API_URL,
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      },
      {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      }
    );

    const h = res.headers;

    if (res.status === 401) {
      // Token rejected by API — try re-importing fresh from keychain
      console.log("[main] API returned 401, attempting keychain re-import...");
      await auth.clearCredentials();
      if (allowReimport && await auth.importFromKeychain()) {
        console.log("[main] Re-imported from keychain after 401, retrying once");
        return doFetchRateLimits({ allowReimport: false });
      }
      rateLimitError = "Auth expired — reconnect to Claude Code";
      rateLimits = null;
      return;
    }

    // Any non-2xx other than 429 carries no anthropic-ratelimit-unified-*
    // headers. Falling through here would publish a fabricated "0% used" reading
    // and clear the error banner during an outage.
    if (res.status !== 429 && (res.status < 200 || res.status >= 300)) {
      rateLimitError = `API error ${res.status}`;
      rateLimits = null;
      return;
    }

    // A 429 does carry the headers, but a response missing them entirely is not
    // something we can render as utilisation.
    if (h["anthropic-ratelimit-unified-5h-utilization"] === undefined &&
        h["anthropic-ratelimit-unified-status"] === undefined) {
      rateLimitError = "Rate limit headers missing from API response";
      rateLimits = null;
      return;
    }

    const creds = (await auth.loadCredentials()) || {};
    rateLimitError = null;
    rateLimits = {
      status: h["anthropic-ratelimit-unified-status"] || "unknown",
      fiveHourStatus: h["anthropic-ratelimit-unified-5h-status"],
      fiveHourUtil: parseFloat(h["anthropic-ratelimit-unified-5h-utilization"] || "0"),
      fiveHourReset: h["anthropic-ratelimit-unified-5h-reset"],
      sevenDayStatus: h["anthropic-ratelimit-unified-7d-status"],
      sevenDayUtil: parseFloat(h["anthropic-ratelimit-unified-7d-utilization"] || "0"),
      sevenDayReset: h["anthropic-ratelimit-unified-7d-reset"],
      overageStatus: h["anthropic-ratelimit-unified-overage-status"],
      overageUtil: parseFloat(h["anthropic-ratelimit-unified-overage-utilization"] || "0"),
      fallbackPct: h["anthropic-ratelimit-unified-fallback-percentage"],
      subscriptionType: creds.subscriptionType || "unknown",
      rateLimitTier: creds.rateLimitTier || "",
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    rateLimitError = err.message;
    rateLimits = null;
  }
}

// ─── Data assembly ───────────────────────────────────────────────────────────

// Coalesce concurrent refreshes: the 60s interval, the 15m interval and the
// refresh/login/logout IPC handlers can all fire at once, and overlapping
// parseUsageData runs raced each other's history writes.
let refreshInFlight = null;
async function refreshCachedData() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      cachedDashboardData = await gatherData();
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function gatherData() {
  // Local, not module-global: two overlapping gatherData runs used to append to
  // the same array and cross-contaminate each other's error lists.
  const errors = [];

  let data;
  try {
    data = await parseUsageData({ historyDir: app.getPath("userData") });
  } catch (err) {
    errors.push("Usage data: " + err.message);
    data = { totals: { cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, todayCost: 0, monthCost: 0 }, projects: {} };
  }

  const { totals, projects } = data;

  let creds;
  try {
    creds = await auth.loadCredentials();
  } catch (err) {
    errors.push("Credentials: " + err.message);
    creds = null;
  }

  // Only surface this as an error when the user is actually connected — being
  // logged out is a deliberate state, not a fault to flag in the error banner.
  if (rateLimitError && creds) {
    errors.push("Rate limits: " + rateLimitError);
  }

  // Attach per-window token counts derived from local JSONL files.
  // The rate-limit API returns only utilization percentages, not absolute token
  // counts — so we derive them by summing JSONL entries whose timestamp falls
  // inside each window. Not a server-authoritative number, but a useful
  // indicator alongside the utilization bar.
  // Snapshot the global once: doFetchRateLimits may replace `rateLimits` with a
  // fresh object while the awaits below are running, and writing the token
  // counts onto the old object would silently drop them from the payload.
  const rl = rateLimits ? { ...rateLimits } : null;
  if (rl) {
    const nowMs = Date.now();
    const fiveHourResetMs = Number(rl.fiveHourReset) * 1000;
    const sevenDayResetMs = Number(rl.sevenDayReset) * 1000;
    try {
      rl.fiveHourTokens = Number.isFinite(fiveHourResetMs)
        ? await getTokensInWindow(fiveHourResetMs - 5 * 3600 * 1000, nowMs)
        : null;
      rl.sevenDayTokens = Number.isFinite(sevenDayResetMs)
        ? await getTokensInWindow(sevenDayResetMs - 7 * 24 * 3600 * 1000, nowMs)
        : null;
    } catch (err) {
      errors.push("Window tokens: " + err.message);
      rl.fiveHourTokens = null;
      rl.sevenDayTokens = null;
    }
  }

  const allProjects = Object.values(projects);

  const recentProjects = allProjects
    .filter((p) => p.lastSeen)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 3)
    .map((p) => ({ name: p.name, cost: p.cost, lastSeen: p.lastSeen, totalTokens: p.inputTokens + p.outputTokens }));

  const topProjects = allProjects
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 3)
    .map((p) => ({ name: p.name, cost: p.cost, firstSeen: p.firstSeen, lastSeen: p.lastSeen, totalTokens: p.inputTokens + p.outputTokens }));

  return {
    totals,
    rateLimits: rl,
    rateLimitError,
    isLoggedIn: !!creds,
    oauth: creds ? { subscriptionType: creds.subscriptionType, rateLimitTier: creds.rateLimitTier } : null,
    recentProjects,
    topProjects,
    errors,
    appVersion: app.getVersion(),
  };
}

// ─── Tray icon ───────────────────────────────────────────────────────────────

function createGaugeIcon(pct) {
  // Vertical fill gauge at 2x Retina (16x22 points → 32x44 pixels)
  const pw = 16, ph = 22;
  const w = pw * 2, h = ph * 2;
  const canvas = Buffer.alloc(w * h * 4, 0);

  function set(x, y) {
    if (x >= 0 && x < w && y >= 0 && y < h) {
      const i = (y * w + x) * 4;
      canvas[i] = canvas[i + 1] = canvas[i + 2] = 0;
      canvas[i + 3] = 255;
    }
  }

  function fillRect(x1, y1, x2, y2) {
    for (let y = y1; y <= y2; y++)
      for (let x = x1; x <= x2; x++) set(x, y);
  }

  function clearPixel(x, y) {
    if (x >= 0 && x < w && y >= 0 && y < h) {
      canvas[(y * w + x) * 4 + 3] = 0;
    }
  }

  function clearRect(x1, y1, x2, y2) {
    for (let y = y1; y <= y2; y++)
      for (let x = x1; x <= x2; x++) clearPixel(x, y);
  }

  // Outer rounded rect: x=4..27, y=2..41 (24w x 40h)
  fillRect(4, 2, 27, 41);
  // Punch out inner rect for 2px border: x=6..25, y=4..39
  clearRect(6, 4, 25, 39);

  // Round the four corners (clear 2x2 triangle at each)
  clearPixel(4, 2); clearPixel(5, 2); clearPixel(4, 3);
  clearPixel(26, 2); clearPixel(27, 2); clearPixel(27, 3);
  clearPixel(4, 41); clearPixel(5, 41); clearPixel(4, 40);
  clearPixel(26, 41); clearPixel(27, 41); clearPixel(27, 40);

  // Fill zone: x=8..23 (16px wide), y=6..37 (32px tall)
  // Fill from bottom: height proportional to pct
  // Overage utilisation can exceed 1.0; clamp so the fill cannot paint over the
  // border, and guard against NaN from a malformed header.
  const safePct = Math.min(1, Math.max(0, Number(pct) || 0));
  const fillHeight = Math.round(safePct * 32);
  if (fillHeight > 0) {
    fillRect(8, 38 - fillHeight, 23, 37);
  }

  const img = nativeImage.createFromBuffer(canvas, {
    width: w, height: h, scaleFactor: 2.0,
  });
  img.setTemplateImage(true);
  return img;
}

// ─── Popup window ────────────────────────────────────────────────────────────

function createPopup() {
  popup = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  popup.webContents.on("will-navigate", (event) => event.preventDefault());
  popup.loadFile(path.join(__dirname, "popup.html"));

  popup.on("blur", () => {
    if (popup && !popup.isDestroyed()) {
      popup.hide();
    }
  });

  // Electron's default menu supplies a ⌘W "Close Window" role, and letting it
  // destroy the popup left every later tray click dead. Hide instead — but only
  // while the app is running: on quit the window must really close. Note this
  // has to be an event handler rather than the `closable: false` constructor
  // option, because a non-closable window makes app.quit() hang forever.
  popup.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    popup.hide();
  });

  // Defence in depth: if the window is destroyed by any route, drop the stale
  // reference so showPopup() can build a fresh one instead of no-op'ing forever.
  popup.on("closed", () => {
    popup = null;
  });
}

function showPopup() {
  if (!popup || popup.isDestroyed()) createPopup();
  if (!popup) return;

  if (popup.isVisible()) {
    popup.hide();
    return;
  }

  positionPopup();
  popup.show();
  popup.focus();
  sendDataToPopup();
}

function positionPopup() {
  if (!popup || popup.isDestroyed() || !tray) return;

  const trayBounds = tray.getBounds();
  const display = screen.getDisplayMatching(trayBounds);

  let x = Math.round(trayBounds.x + trayBounds.width / 2 - POPUP_WIDTH / 2);
  let y = trayBounds.y + trayBounds.height + 4;

  if (x + POPUP_WIDTH > display.bounds.x + display.bounds.width) {
    x = display.bounds.x + display.bounds.width - POPUP_WIDTH - 8;
  }
  if (x < display.bounds.x) x = display.bounds.x + 8;

  popup.setPosition(x, y, false);
}

function sendDataToPopup() {
  if (popup && !popup.isDestroyed() && cachedDashboardData) {
    popup.webContents.send("update-data", cachedDashboardData);
  }
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.on("request-data", () => sendDataToPopup());

ipcMain.on("refresh", async () => {
  await fetchRateLimits();
  await refreshCachedData();
  updateTrayTitle();
  sendDataToPopup();
});

ipcMain.on("login", async () => {
  try {
    await auth.login();
    await fetchRateLimits();
    await refreshCachedData();
    updateTrayTitle();
    sendDataToPopup();
    saveCache();
  } catch (err) {
    // Auth failed — refresh UI state with error
    rateLimitError = err.message;
    await refreshCachedData();
    sendDataToPopup();
  }
});

ipcMain.on("logout", async () => {
  await auth.clearCredentials();
  rateLimits = null;
  rateLimitError = "Not connected";
  cachedDashboardData = null;
  await refreshCachedData();
  updateTrayTitle();
  sendDataToPopup();
  saveCache();
});

ipcMain.on("quit", () => app.quit());

// ─── Tray title ──────────────────────────────────────────────────────────────

function updateTrayTitle() {
  if (!tray) return;
  if (!rateLimits) {
    // Reset the gauge too — otherwise it keeps the last fill level after logout.
    tray.setImage(createGaugeIcon(0));
    tray.setTitle(" —");
    return;
  }
  const pct = rateLimits.fiveHourUtil || 0;
  tray.setImage(createGaugeIcon(pct));
  tray.setTitle(` ${Math.round(pct * 100)}%`);
}

// ─── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  tray = new Tray(createGaugeIcon(0));
  tray.setToolTip("Claude Code Usage");

  // Pre-create popup (hidden) so tray clicks are instant
  createPopup();

  // mouse-down is more reliable than click on macOS tray
  tray.on("mouse-down", () => showPopup());

  // Right-click: minimal native menu fallback
  tray.on("right-click", () => {
    const menu = Menu.buildFromTemplate([
      { label: "Refresh", click: async () => {
        await fetchRateLimits();
        await refreshCachedData();
        updateTrayTitle();
        sendDataToPopup();
      } },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]);
    tray.popUpContextMenu(menu);
  });

  // Load cached data immediately so tray shows data on launch
  loadCache();
  updateTrayTitle();

  // Then fetch fresh data in background
  fetchRateLimits().then(async () => {
    await refreshCachedData();
    updateTrayTitle();
    sendDataToPopup();
    saveCache();
  });

  // Auto-refresh usage every 60s
  refreshInterval = setInterval(async () => {
    await refreshCachedData();
    updateTrayTitle();
    sendDataToPopup();
    saveCache();
  }, 60_000);

  // Auto-refresh rate limits every 15 minutes
  rateLimitInterval = setInterval(async () => {
    await fetchRateLimits();
    await refreshCachedData();
    updateTrayTitle();
    sendDataToPopup();
    saveCache();
  }, 15 * 60_000);
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (refreshInterval) clearInterval(refreshInterval);
  if (rateLimitInterval) clearInterval(rateLimitInterval);
});
