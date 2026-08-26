/**
 * Shared Claude Code usage parsing logic
 * Used by both the web dashboard and the tray app
 */

const fsp = require("fs").promises;
const path = require("path");
const os = require("os");

const CLAUDE_DIR = path.join(os.homedir(), ".claude", "projects");
const DEFAULT_HISTORY_DIR = path.join(os.homedir(), ".claude");
const HISTORY_FILENAME = "usage-history.json";

// Bumped whenever a parser bug made previously-persisted numbers untrustworthy.
// loadHistory() discards any file whose version does not match, which resets the
// high-water marks instead of preserving bad values forever.
// v2: dedupe streamed assistant entries, fix cache-token double-subtraction,
//     correct/extend model pricing, local-time day keys.
const HISTORY_VERSION = 2;

// ─── Pricing (per million tokens) ────────────────────────────────────────────

const MODEL_PRICING = {
  // Claude Fable / Mythos
  "claude-fable-5":        { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-mythos-5":       { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  // Claude Opus
  "claude-opus-5":         { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8":       { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7":       { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6":       { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-5":       { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // Claude Sonnet
  "claude-sonnet-5":       { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6":     { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5":     { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-0":     { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // Claude 3.5
  "claude-3-5-sonnet-20241022": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-sonnet-20240620": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku-20241022":  { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  // Claude Haiku
  "claude-haiku-4-5":      { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // Bare aliases that appear in some JSONL entries
  "opus":                  { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "fable":                 { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "sonnet":                { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "haiku":                 { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // Locally-generated messages are never billed
  "<synthetic>":           { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
  // NOTE: usage.input_tokens already EXCLUDES cache reads/writes — do not subtract them.
  return (
    (inputTokens * pricing.input +
     cacheRead * pricing.cacheRead +
     cacheWrite * pricing.cacheWrite +
     outputTokens * pricing.output) / 1_000_000
  );
}

// ─── History persistence ─────────────────────────────────────────────────────

function emptyHistory() {
  return { version: HISTORY_VERSION, lastUpdated: null, dailyUsage: {}, projects: {}, globalModelBreakdown: {} };
}

async function loadHistory(historyPath) {
  try {
    const raw = await fsp.readFile(historyPath, "utf8");
    const parsed = JSON.parse(raw);
    // Stale schema: drop it rather than merging known-bad high-water marks forward.
    if (!parsed || parsed.version !== HISTORY_VERSION) return emptyHistory();
    parsed.dailyUsage = parsed.dailyUsage || {};
    parsed.projects = parsed.projects || {};
    parsed.globalModelBreakdown = parsed.globalModelBreakdown || {};
    return parsed;
  } catch { /* missing or corrupted — start fresh */ }
  return emptyHistory();
}

let saveHistoryCounter = 0;

async function saveHistory(historyPath, history) {
  history.lastUpdated = new Date().toISOString();
  const tmp = `${historyPath}.${process.pid}.${++saveHistoryCounter}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(history, null, 2));
    await fsp.rename(tmp, historyPath);
  } catch {
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
  }
}

function mergeMax(target, source) {
  for (const [key, val] of Object.entries(source)) {
    target[key] = Math.max(target[key] || 0, val);
  }
}

// ─── Data parsing ────────────────────────────────────────────────────────────

/**
 * Claude Code writes one `type:"assistant"` JSONL line per content block of a
 * streamed response. Every one of those lines repeats the SAME message.id,
 * requestId and the SAME full usage object, so summing them multiplies cost and
 * tokens by the number of content blocks. Resumed sessions additionally copy
 * entries into a new file, duplicating across files.
 *
 * Returns a stable identity for an entry, or null when it carries no id at all
 * (in which case the caller must count it — it cannot be a known duplicate).
 */
function entryDedupeKey(entry, msg) {
  const messageId = msg && msg.id;
  const requestId = entry.requestId || entry.request_id;
  if (messageId) return `${messageId}:${requestId || ""}`;
  if (requestId) return `req:${requestId}`;
  return null;
}

/** Day key in the user's LOCAL timezone — toISOString() would use UTC boundaries. */
function localDayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function decodeProjectName(dirName) {
  return dirName.replace(/^-/, "/").replace(/-/g, "/");
}

const projectPathCache = new Map();

/**
 * `decodeProjectName` cannot be correct on its own: the encoding replaces every
 * "/" with "-", so "Birja-IO" and "Birja/IO" encode identically. Recover the real
 * path by walking the filesystem, preferring the longest segment that exists at
 * each level, and fall back to the naive decode for directories that are gone.
 */
async function resolveProjectPath(dirName) {
  const cached = projectPathCache.get(dirName);
  if (cached !== undefined) return cached;

  const parts = dirName.replace(/^-/, "").split("-");
  let base = "/";
  let i = 0;
  let ok = true;

  while (i < parts.length) {
    let matched = 0;
    for (let take = parts.length - i; take >= 1; take--) {
      const candidate = path.join(base, parts.slice(i, i + take).join("-"));
      try {
        const st = await fsp.stat(candidate);
        if (st.isDirectory()) { base = candidate; matched = take; break; }
      } catch { /* not this split — try a shorter one */ }
    }
    if (!matched) { ok = false; break; }
    i += matched;
  }

  const resolved = ok ? base : decodeProjectName(dirName);
  projectPathCache.set(dirName, resolved);
  return resolved;
}

function getShortName(fullPath) {
  const parts = fullPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || fullPath;
}

async function parseUsageData(options = {}) {
  const historyDir = options.historyDir || DEFAULT_HISTORY_DIR;
  const historyPath = path.join(historyDir, HISTORY_FILENAME);
  const projects = {};
  const dailyUsage = {};
  const globalModelBreakdown = {};
  const sessionMap = {};
  // Shared across every project/file so cross-file duplicates from resumed
  // sessions are counted once, not once per file they were copied into.
  // Whichever project is scanned FIRST owns a duplicated entry, so the scan
  // order is sorted rather than left to readdir: unstable attribution would let
  // the high-water-mark merge credit the same cost to two projects across
  // successive runs, re-inflating exactly what this dedup removes.
  const seenEntries = new Set();

  const now = new Date();
  const todayStr = localDayKey(now);
  const monthStr = todayStr.slice(0, 7);

  let topEntries;
  try {
    topEntries = await fsp.readdir(CLAUDE_DIR, { withFileTypes: true });
  } catch {
    return { projects, dailyUsage, globalModelBreakdown, sessions: [], totals: { cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, todayCost: 0, monthCost: 0 } };
  }

  const projectDirs = topEntries.filter((e) => e.isDirectory()).map((e) => e.name).sort();

  for (const dir of projectDirs) {
    const projectPath = await resolveProjectPath(dir);
    const shortName = getShortName(projectPath);
    const projectDir = path.join(CLAUDE_DIR, dir);

    let jsonlFiles;
    try {
      const entries = await fsp.readdir(projectDir);
      jsonlFiles = entries.filter((f) => f.endsWith(".jsonl")).sort();
    } catch { continue; }

    // Claude Code records the real working directory on its JSONL entries. That
    // is the only unambiguous source for the project path — the directory name
    // encodes "/" as "-", so "beply.io-vps" and "beply.io/vps" are identical
    // once encoded. Filled in from the first entry that carries a cwd.
    let recordedCwd = null;

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
      let lines;
      try {
        const raw = await fsp.readFile(filePath, "utf8");
        lines = raw.split("\n").filter(Boolean);
      } catch { continue; }

      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry) continue;

        if (!recordedCwd && typeof entry.cwd === "string" && entry.cwd.startsWith("/")) {
          recordedCwd = entry.cwd;
        }

        if (entry.type !== "assistant") continue;

        const msg = entry.message || {};

        const dedupeKey = entryDedupeKey(entry, msg);
        if (dedupeKey !== null) {
          if (seenEntries.has(dedupeKey)) continue;
          seenEntries.add(dedupeKey);
        }

        const usage = msg.usage || entry.usage || {};
        const ts = entry.timestamp ? new Date(entry.timestamp) : null;
        const model = msg.model || entry.model || "unknown";
        const cost = entry.costUSD || calculateCost(model, usage);
        const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);

        // proj.cost is recomputed from dailyCost further down, so accumulating it
        // here would be dead code — everything must land in a dailyCost bucket.
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

          const day = localDayKey(ts);
          proj.dailyCost[day] = (proj.dailyCost[day] || 0) + cost;
          dailyUsage[day] = (dailyUsage[day] || 0) + cost;
        } else {
          // No usable timestamp: keep the cost in the project total under a key
          // that can never match a today/month prefix filter.
          proj.dailyCost.unknown = (proj.dailyCost.unknown || 0) + cost;
        }

        proj.modelBreakdown[model] = (proj.modelBreakdown[model] || 0) + cost;
        globalModelBreakdown[model] = (globalModelBreakdown[model] || 0) + cost;
      }
    }

    proj.sessions = proj.sessions.size;
    if (recordedCwd) {
      proj.fullPath = recordedCwd;
      proj.name = getShortName(recordedCwd);
    }
    projects[dir] = proj;
  }

  // ─── Merge with persisted history ──────────────────────────────────────────
  const history = await loadHistory(historyPath);

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
    version: HISTORY_VERSION,
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
  await saveHistory(historyPath, updatedHistory);

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

// ─── Window-scoped token counting ────────────────────────────────────────────

/**
 * Sum tokens from JSONL entries whose timestamp falls within [windowStartMs, windowEndMs].
 * Used to show "tokens used in the current rate limit window" alongside the rate-limit bars.
 * Note: this is a local, best-effort count and will not match Anthropic's server-side
 * unified utilization exactly (different weighting / per-model accounting).
 */
async function getTokensInWindow(windowStartMs, windowEndMs) {
  const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) return empty;

  const result = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const seenEntries = new Set();

  let topEntries;
  try {
    topEntries = await fsp.readdir(CLAUDE_DIR, { withFileTypes: true });
  } catch { return empty; }

  const projectDirs = topEntries.filter((e) => e.isDirectory()).map((e) => e.name).sort();

  for (const dir of projectDirs) {
    const projectDir = path.join(CLAUDE_DIR, dir);
    let jsonlFiles;
    try {
      const entries = await fsp.readdir(projectDir);
      jsonlFiles = entries.filter((f) => f.endsWith(".jsonl")).sort();
    } catch { continue; }

    for (const file of jsonlFiles) {
      const filePath = path.join(projectDir, file);

      // Fast path: skip files last modified before the window started.
      try {
        const stat = await fsp.stat(filePath);
        if (stat.mtimeMs < windowStartMs) continue;
      } catch { continue; }

      let lines;
      try {
        const raw = await fsp.readFile(filePath, "utf8");
        lines = raw.split("\n").filter(Boolean);
      } catch { continue; }

      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || entry.type !== "assistant") continue;
        if (!entry.timestamp) continue;

        const ts = Date.parse(entry.timestamp);
        if (!Number.isFinite(ts)) continue;
        if (ts < windowStartMs || ts > windowEndMs) continue;

        const dedupeKey = entryDedupeKey(entry, entry.message);
        if (dedupeKey !== null) {
          if (seenEntries.has(dedupeKey)) continue;
          seenEntries.add(dedupeKey);
        }

        const usage = (entry.message && entry.message.usage) || entry.usage || {};
        result.input += usage.input_tokens || 0;
        result.output += usage.output_tokens || 0;
        result.cacheRead += usage.cache_read_input_tokens || 0;
        result.cacheWrite += usage.cache_creation_input_tokens || 0;
      }
    }
  }

  result.total = result.input + result.output;
  return result;
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
  resolveProjectPath,
  getShortName,
  parseUsageData,
  getTokensInWindow,
  fmt,
  fmtCost,
};
