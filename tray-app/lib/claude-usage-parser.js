/**
 * Shared Claude Code usage parsing logic
 * Used by both the web dashboard and the tray app
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const CLAUDE_DIR = path.join(os.homedir(), ".claude", "projects");
const DEFAULT_HISTORY_DIR = path.join(os.homedir(), ".claude");
const HISTORY_FILENAME = "usage-history.json";

// ─── Pricing (per million tokens) ────────────────────────────────────────────

const MODEL_PRICING = {
  // Claude 4.x / Opus
  "claude-opus-4-6":       { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-5":       { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  // Claude Sonnet
  "claude-sonnet-4-6":     { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5":     { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-0":     { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // Claude 3.5
  "claude-3-5-sonnet-20241022": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-sonnet-20240620": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku-20241022":  { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  // Claude Haiku
  "claude-haiku-4-5":      { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  // Fallback
  _default:                { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

function calculateCost(model, usage) {
  const baseModel = model.replace(/-\d{8}$/, "");
  const pricing = MODEL_PRICING[model] || MODEL_PRICING[baseModel] || MODEL_PRICING._default;
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const directInput = Math.max(0, inputTokens - cacheRead - cacheWrite);
  return (
    (directInput * pricing.input +
     cacheRead * pricing.cacheRead +
     cacheWrite * pricing.cacheWrite +
     outputTokens * pricing.output) / 1_000_000
  );
}

// ─── History persistence ─────────────────────────────────────────────────────

function emptyHistory() {
  return { version: 1, lastUpdated: null, dailyUsage: {}, projects: {}, globalModelBreakdown: {} };
}

function loadHistory(historyPath) {
  try {
    if (fs.existsSync(historyPath)) {
      return JSON.parse(fs.readFileSync(historyPath, "utf8"));
    }
  } catch { /* corrupted file — start fresh */ }
  return emptyHistory();
}

function saveHistory(historyPath, history) {
  history.lastUpdated = new Date().toISOString();
  const tmp = historyPath + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
    fs.renameSync(tmp, historyPath);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function mergeMax(target, source) {
  for (const [key, val] of Object.entries(source)) {
    target[key] = Math.max(target[key] || 0, val);
  }
}

// ─── Data parsing ────────────────────────────────────────────────────────────

function decodeProjectName(dirName) {
  return dirName.replace(/^-/, "/").replace(/-/g, "/");
}

function getShortName(fullPath) {
  const parts = fullPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || fullPath;
}

function parseUsageData(options = {}) {
  const historyDir = options.historyDir || DEFAULT_HISTORY_DIR;
  const historyPath = path.join(historyDir, HISTORY_FILENAME);
  const projects = {};
  const dailyUsage = {};
  const globalModelBreakdown = {};
  const sessionMap = {};

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const monthStr = now.toISOString().slice(0, 7);

  if (!fs.existsSync(CLAUDE_DIR)) {
    return { projects, dailyUsage, globalModelBreakdown, sessions: [], totals: { cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, todayCost: 0, monthCost: 0 } };
  }

  const projectDirs = fs.readdirSync(CLAUDE_DIR).filter((d) => {
    try {
      return fs.statSync(path.join(CLAUDE_DIR, d)).isDirectory();
    } catch {
      return false;
    }
  });

  for (const dir of projectDirs) {
    const projectPath = decodeProjectName(dir);
    const shortName = getShortName(projectPath);
    const projectDir = path.join(CLAUDE_DIR, dir);

    let jsonlFiles = [];
    try {
      jsonlFiles = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    } catch { continue; }

    const proj = {
      name: shortName,
      fullPath: projectPath,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      sessions: new Set(),
      firstSeen: null,
      lastSeen: null,
      dailyCost: {},
      modelBreakdown: {},
    };

    for (const file of jsonlFiles) {
      const filePath = path.join(projectDir, file);
      let lines = [];
      try {
        lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
      } catch { continue; }

      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }

        if (!entry || entry.type !== "assistant") continue;

        const msg = entry.message || {};
        const usage = msg.usage || entry.usage || {};
        const ts = entry.timestamp ? new Date(entry.timestamp) : null;
        const model = msg.model || entry.model || "unknown";
        const cost = entry.costUSD || calculateCost(model, usage);
        const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);

        proj.cost += cost;
        proj.inputTokens += usage.input_tokens || 0;
        proj.outputTokens += usage.output_tokens || 0;
        proj.cacheRead += usage.cache_read_input_tokens || 0;
        proj.cacheWrite += usage.cache_creation_input_tokens || 0;

        if (entry.sessionId) {
          proj.sessions.add(entry.sessionId);
          if (!sessionMap[entry.sessionId]) {
            sessionMap[entry.sessionId] = { cost: 0, tokens: 0, project: shortName, models: new Set(), timestamp: ts };
          }
          const s = sessionMap[entry.sessionId];
          s.cost += cost;
          s.tokens += totalTokens;
          s.models.add(model);
          if (ts && (!s.timestamp || ts > s.timestamp)) s.timestamp = ts;
        }

        if (ts && !isNaN(ts)) {
          if (!proj.firstSeen || ts < proj.firstSeen) proj.firstSeen = ts;
          if (!proj.lastSeen || ts > proj.lastSeen) proj.lastSeen = ts;

          const day = ts.toISOString().slice(0, 10);
          proj.dailyCost[day] = (proj.dailyCost[day] || 0) + cost;
          dailyUsage[day] = (dailyUsage[day] || 0) + cost;
        }

        proj.modelBreakdown[model] = (proj.modelBreakdown[model] || 0) + cost;
        globalModelBreakdown[model] = (globalModelBreakdown[model] || 0) + cost;
      }
    }

    proj.sessions = proj.sessions.size;
    projects[dir] = proj;
  }

  // ─── Merge with persisted history ──────────────────────────────────────────
  const history = loadHistory(historyPath);

  // Merge dailyUsage
  mergeMax(dailyUsage, history.dailyUsage);

  // Merge globalModelBreakdown
  mergeMax(globalModelBreakdown, history.globalModelBreakdown);

  // Merge projects
  for (const [dir, hp] of Object.entries(history.projects)) {
    if (!projects[dir]) {
      // Project was fully deleted from JSONL — restore from history
      projects[dir] = {
        name: hp.name,
        fullPath: hp.fullPath,
        cost: 0,
        inputTokens: hp.inputTokens || 0,
        outputTokens: hp.outputTokens || 0,
        cacheRead: hp.cacheRead || 0,
        cacheWrite: hp.cacheWrite || 0,
        sessions: hp.sessionCount || 0,
        firstSeen: hp.firstSeen ? new Date(hp.firstSeen) : null,
        lastSeen: hp.lastSeen ? new Date(hp.lastSeen) : null,
        dailyCost: { ...hp.dailyCost },
        modelBreakdown: { ...hp.modelBreakdown },
      };
    } else {
      const p = projects[dir];
      // Merge daily costs
      for (const [day, cost] of Object.entries(hp.dailyCost || {})) {
        p.dailyCost[day] = Math.max(p.dailyCost[day] || 0, cost);
      }
      // Merge model breakdown
      mergeMax(p.modelBreakdown, hp.modelBreakdown || {});
      // Merge token totals (high-water mark)
      p.inputTokens = Math.max(p.inputTokens, hp.inputTokens || 0);
      p.outputTokens = Math.max(p.outputTokens, hp.outputTokens || 0);
      p.cacheRead = Math.max(p.cacheRead, hp.cacheRead || 0);
      p.cacheWrite = Math.max(p.cacheWrite, hp.cacheWrite || 0);
      p.sessions = Math.max(p.sessions, hp.sessionCount || 0);
      // Keep earliest firstSeen, latest lastSeen
      if (hp.firstSeen) {
        const hFirst = new Date(hp.firstSeen);
        if (!p.firstSeen || hFirst < p.firstSeen) p.firstSeen = hFirst;
      }
      if (hp.lastSeen) {
        const hLast = new Date(hp.lastSeen);
        if (!p.lastSeen || hLast > p.lastSeen) p.lastSeen = hLast;
      }
    }
    // Recompute project cost from merged dailyCost
    projects[dir].cost = Object.values(projects[dir].dailyCost).reduce((s, v) => s + v, 0);
  }
  // Also recompute cost for live-only projects (no history entry yet)
  for (const [dir, p] of Object.entries(projects)) {
    if (!history.projects[dir]) {
      p.cost = Object.values(p.dailyCost).reduce((s, v) => s + v, 0);
    }
  }

  // Save updated history
  const updatedHistory = {
    version: 1,
    dailyUsage: { ...dailyUsage },
    globalModelBreakdown: { ...globalModelBreakdown },
    projects: {},
  };
  for (const [dir, p] of Object.entries(projects)) {
    updatedHistory.projects[dir] = {
      name: p.name,
      fullPath: p.fullPath,
      dailyCost: { ...p.dailyCost },
      modelBreakdown: { ...p.modelBreakdown },
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      cacheRead: p.cacheRead,
      cacheWrite: p.cacheWrite,
      sessionCount: p.sessions,
      firstSeen: p.firstSeen ? (p.firstSeen instanceof Date ? p.firstSeen.toISOString() : p.firstSeen) : null,
      lastSeen: p.lastSeen ? (p.lastSeen instanceof Date ? p.lastSeen.toISOString() : p.lastSeen) : null,
    };
  }
  saveHistory(historyPath, updatedHistory);

  const totals = Object.values(projects).reduce(
    (acc, p) => ({
      cost: acc.cost + p.cost,
      inputTokens: acc.inputTokens + p.inputTokens,
      outputTokens: acc.outputTokens + p.outputTokens,
      cacheRead: acc.cacheRead + p.cacheRead,
      cacheWrite: acc.cacheWrite + p.cacheWrite,
      sessions: acc.sessions + p.sessions,
    }),
    { cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, sessions: 0 }
  );

  totals.todayCost = dailyUsage[todayStr] || 0;
  totals.monthCost = Object.entries(dailyUsage)
    .filter(([day]) => day.startsWith(monthStr))
    .reduce((sum, [, v]) => sum + v, 0);

  const sessions = Object.entries(sessionMap)
    .map(([id, s]) => ({ id, cost: s.cost, tokens: s.tokens, project: s.project, models: [...s.models], timestamp: s.timestamp }))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 50);

  return { projects, dailyUsage, globalModelBreakdown, sessions, totals };
}

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toString();
}

function fmtCost(n) {
  return "$" + n.toFixed(4);
}

module.exports = {
  CLAUDE_DIR,
  MODEL_PRICING,
  calculateCost,
  decodeProjectName,
  getShortName,
  parseUsageData,
  fmt,
  fmtCost,
};
