const { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const { parseUsageData } = require("./lib/claude-usage-parser");
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
let errors = [];

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

function saveCache() {
  try {
    const cachePath = getCachePath();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
      rateLimits,
      rateLimitError,
      dashboardData: cachedDashboardData,
    }));
  } catch {
    // Non-critical — ignore write errors
  }
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

async function fetchRateLimits({ allowReimport = true } = {}) {
  // getValidAccessToken will re-import from keychain if token is expired
  const accessToken = auth.getValidAccessToken();
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
      auth.clearCredentials();
      if (allowReimport && auth.importFromKeychain()) {
        console.log("[main] Re-imported from keychain after 401, retrying once");
        return fetchRateLimits({ allowReimport: false });
      }
      rateLimitError = "Auth expired — reconnect to Claude Code";
      rateLimits = null;
      return;
    }

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
      subscriptionType: (auth.loadCredentials() || {}).subscriptionType || "unknown",
      rateLimitTier: (auth.loadCredentials() || {}).rateLimitTier || "",
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    rateLimitError = err.message;
    rateLimits = null;
  }
}

// ─── Data assembly ───────────────────────────────────────────────────────────

function refreshCachedData() {
  cachedDashboardData = gatherData();
}

function gatherData() {
  errors = [];

  let data;
  try {
    data = parseUsageData({ historyDir: app.getPath("userData") });
  } catch (err) {
    errors.push("Usage data: " + err.message);
    data = { totals: { cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, todayCost: 0, monthCost: 0 }, projects: {} };
  }

  const { totals, projects } = data;

  let creds;
  try {
    creds = auth.loadCredentials();
  } catch (err) {
    errors.push("Credentials: " + err.message);
    creds = null;
  }

  if (rateLimitError) {
    errors.push("Rate limits: " + rateLimitError);
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
    rateLimits,
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
  const fillHeight = Math.round(pct * 32);
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
}

function showPopup() {
  if (!popup || popup.isDestroyed()) return;

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
  if (popup && !popup.isDestroyed()) {
    if (!cachedDashboardData) refreshCachedData();
    popup.webContents.send("update-data", cachedDashboardData);
  }
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.on("request-data", () => sendDataToPopup());

ipcMain.on("refresh", async () => {
  await fetchRateLimits();
  refreshCachedData();
  updateTrayTitle();
  sendDataToPopup();
});

ipcMain.on("login", async () => {
  try {
    await auth.login();
    await fetchRateLimits();
    refreshCachedData();
    updateTrayTitle();
    sendDataToPopup();
    saveCache();
  } catch (err) {
    // Auth failed — refresh UI state with error
    rateLimitError = err.message;
    refreshCachedData();
    sendDataToPopup();
  }
});

ipcMain.on("logout", () => {
  auth.clearCredentials();
  rateLimits = null;
  rateLimitError = "Not connected";
  cachedDashboardData = null;
  refreshCachedData();
  updateTrayTitle();
  sendDataToPopup();
  saveCache();
});

ipcMain.on("quit", () => app.quit());

// ─── Tray title ──────────────────────────────────────────────────────────────

function updateTrayTitle() {
  if (!tray) return;
  if (!rateLimits) {
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
      { label: "Refresh", click: async () => { await fetchRateLimits(); updateTrayTitle(); sendDataToPopup(); } },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]);
    tray.popUpContextMenu(menu);
  });

  // Load cached data immediately so tray shows data on launch
  loadCache();
  updateTrayTitle();

  // Then fetch fresh data in background
  fetchRateLimits().then(() => {
    refreshCachedData();
    updateTrayTitle();
    sendDataToPopup();
    saveCache();
  });

  // Auto-refresh usage every 60s
  refreshInterval = setInterval(() => {
    refreshCachedData();
    updateTrayTitle();
    sendDataToPopup();
    saveCache();
  }, 60_000);

  // Auto-refresh rate limits every 5 minutes
  rateLimitInterval = setInterval(async () => {
    await fetchRateLimits();
    refreshCachedData();
    updateTrayTitle();
    sendDataToPopup();
    saveCache();
  }, 5 * 60_000);
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});

app.on("before-quit", () => {
  if (refreshInterval) clearInterval(refreshInterval);
  if (rateLimitInterval) clearInterval(rateLimitInterval);
});
