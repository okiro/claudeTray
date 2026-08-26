(function() {
const trayApp = window.trayApp;

function fmtCost(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (n >= 100) return "$" + n.toFixed(0);
  if (n >= 10) return "$" + n.toFixed(1);
  return "$" + n.toFixed(2);
}

function formatResetTime(epochStr) {
  if (!epochStr) return "";
  const epoch = Number(epochStr);
  // A missing/garbage reset header used to render as "NaNm".
  if (!isFinite(epoch)) return "";
  const reset = new Date(epoch * 1000);
  const diffMs = reset - Date.now();
  if (diffMs <= 0) return "now";
  const mins = Math.floor(diffMs / 60000);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return hrs + "h " + (mins % 60) + "m";
  return mins + "m";
}

function getPeakHoursInfo() {
  var now = new Date();
  var pt = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  var h = pt.getHours();
  var m = pt.getMinutes();
  var nowMins = h * 60 + m;
  var peakStart = 5 * 60;   // 05:00 PT
  var peakEnd = 11 * 60;    // 11:00 PT

  if (nowMins >= peakStart && nowMins < peakEnd) {
    var left = peakEnd - nowMins;
    var lh = Math.floor(left / 60);
    var lm = left % 60;
    return { inPeak: true, text: "Peak Hours end in " + (lh > 0 ? lh + "h " : "") + lm + "m" };
  } else {
    var till = nowMins < peakStart ? peakStart - nowMins : (24 * 60 - nowMins) + peakStart;
    var th = Math.floor(till / 60);
    var tm = till % 60;
    return { inPeak: false, text: (th > 0 ? th + "h " : "") + tm + "m till Peak Hours" };
  }
}

function barClass(pct) {
  if (pct < 0.5) return "low";
  if (pct < 0.8) return "mid";
  return "high";
}

function statusDotClass(status) {
  if (status === "allowed_warning") return "warning";
  if (status === "rejected") return "danger";
  return "";
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTokens(n) {
  if (typeof n !== "number" || !isFinite(n) || n === 0) return "";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "m";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(n);
}

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt)) return "";
  const mon = dt.toLocaleString("en", { month: "short" });
  return mon + " " + dt.getDate();
}

function renderRateRow(label, pct, reset, tokens) {
  // Utilisation can exceed 1.0 (overage) and can be NaN if a header is garbage —
  // either would produce an invalid width that overflows or breaks the track.
  const safePct = isFinite(pct) ? Math.min(1, Math.max(0, pct)) : 0;
  const w = Math.max(1, Math.round(safePct * 100));
  const cls = barClass(safePct);
  const tokensLabel = fmtTokens(tokens);
  return '<div class="rate-row">' +
    '<span class="rate-label">' + label + "</span>" +
    '<div class="rate-bar-track">' +
      '<div class="rate-bar-fill ' + cls + '" style="width:' + w + '%"></div>' +
    "</div>" +
    '<span class="rate-pct">' + (isFinite(pct) ? (pct * 100).toFixed(1) + "%" : "—") + "</span>" +
    (tokensLabel ? '<span class="rate-tokens" title="Tokens used in this window (local count)">· ' + tokensLabel + "</span>" : "") +
    '<span class="rate-reset">' + (reset ? "↻ " + reset : "") + "</span>" +
  "</div>";
}

function renderProjects(projects, emptyMessage, dateField) {
  if (!projects || projects.length === 0) {
    return '<div class="rate-message">' + emptyMessage + "</div>";
  }

  return projects.map((project) => {
    const projectDate = project[dateField] || project.lastSeen || project.firstSeen;
    return '<div class="project-row">' +
      '<div class="project-dot"></div>' +
      '<span class="project-name">' + esc(project.name) + "</span>" +
      (project.totalTokens ? '<span class="project-tokens">' + fmtTokens(project.totalTokens) + "</span>" : "") +
      (projectDate ? '<span class="project-date">' + fmtDate(projectDate) + "</span>" : "") +
      '<span class="project-cost">' + fmtCost(project.cost) + "</span>" +
    "</div>";
  }).join("");
}

function renderErrors(errs) {
  const banner = document.getElementById("error-banner");
  if (!errs || errs.length === 0) {
    banner.style.display = "none";
    return;
  }
  banner.style.display = "";
  document.getElementById("error-banner-label").textContent =
    errs.length === 1 ? "1 issue detected" : errs.length + " issues detected";
  document.getElementById("error-banner-details").innerHTML =
    errs.map(function(e) { return '<div class="error-banner-item">' + esc(e) + "</div>"; }).join("");
}

function renderData(data) {
  const { totals, rateLimits, rateLimitError, oauth, recentProjects, topProjects, isLoggedIn, errors, appVersion } = data;

  const authBtn = document.getElementById("btn-auth");
  authBtn.textContent = isLoggedIn ? "Disconnect" : "Connect to Claude Code";
  authBtn.dataset.connected = isLoggedIn ? "true" : "false";

  document.getElementById("app-version").textContent = appVersion ? "v" + appVersion : "";

  document.getElementById("cost-today").textContent = fmtCost(totals?.todayCost);
  document.getElementById("cost-month").textContent = fmtCost(totals?.monthCost);
  document.getElementById("cost-total").textContent = fmtCost(totals?.cost);

  const plan = oauth?.subscriptionType || "";
  document.getElementById("plan-label").textContent = plan ? plan.toUpperCase() + " PLAN" : "USAGE MONITOR";

  const headerDot = document.getElementById("header-dot");
  headerDot.className = "header-status" + (rateLimits ? " " + statusDotClass(rateLimits.status) : "");

  var peakInfo = getPeakHoursInfo();
  var peakEl = document.getElementById("peak-hours-indicator");
  if (peakEl) {
    peakEl.textContent = peakInfo.text;
    peakEl.className = "peak-hours-indicator" + (peakInfo.inPeak ? " peak-active" : "");
  }

  const rlContainer = document.getElementById("rate-limits-container");
  if (!isLoggedIn) {
    rlContainer.innerHTML = '<div class="rate-message">Not connected - click <strong>Connect to Claude Code</strong> to get started</div>';
  } else if (rateLimitError) {
    rlContainer.innerHTML = '<div class="rate-message error">' + esc(rateLimitError) + "</div>";
  } else if (rateLimits) {
    let html = '<div class="rate-limits">';

    html += renderRateRow("5h", rateLimits.fiveHourUtil || 0, formatResetTime(rateLimits.fiveHourReset), rateLimits.fiveHourTokens && rateLimits.fiveHourTokens.total);
    html += renderRateRow("7d", rateLimits.sevenDayUtil || 0, formatResetTime(rateLimits.sevenDayReset), rateLimits.sevenDayTokens && rateLimits.sevenDayTokens.total);
    html += "</div>";

    if (rateLimits.overageUtil) {
      const opct = rateLimits.overageUtil;
      html += '<div class="overage-row">';
      html += '<span class="overage-tag">Overage</span>';
      html += '<span class="overage-val">' + (opct * 100).toFixed(1) + "% used</span>";
      html += "</div>";
    }

    const status = rateLimits.status;
    const statusLabel = status === "allowed"
      ? "Within limits"
      : status === "allowed_warning"
        ? "Approaching limit"
        : status === "rejected"
          ? "Rate limited"
          : status;

    html += '<div class="rate-status">';
    html += '<div class="rate-status-dot ' + statusDotClass(status) + '"></div>';
    html += '<span class="rate-status-text">' + esc(statusLabel);
    if (rateLimits.fetchedAt) {
      const ago = Math.round((Date.now() - new Date(rateLimits.fetchedAt).getTime()) / 1000);
      html += "  ·  " + (ago < 60 ? ago + "s ago" : Math.round(ago / 60) + "m ago");
    }
    html += "</span></div>";

    rlContainer.innerHTML = html;
  } else {
    rlContainer.innerHTML = '<div class="rate-message">Loading...</div>';
  }

  document.getElementById("recent-projects-container").innerHTML = renderProjects(
    recentProjects,
    "No projects found",
    "lastSeen"
  );
  document.getElementById("top-projects-container").innerHTML = renderProjects(
    topProjects,
    "No projects found",
    "firstSeen"
  );

  renderErrors(errors);
}

const unsubscribeUpdateData = trayApp.onUpdateData(renderData);
window.addEventListener("beforeunload", () => {
  unsubscribeUpdateData();
});

document.getElementById("btn-refresh").addEventListener("click", () => {
  trayApp.refresh();
});

document.getElementById("btn-auth").addEventListener("click", (event) => {
  if (event.currentTarget.dataset.connected === "true") {
    trayApp.logout();
  } else {
    trayApp.login();
  }
});

document.getElementById("btn-quit").addEventListener("click", () => {
  trayApp.quit();
});

document.getElementById("error-banner-toggle").addEventListener("click", () => {
  const details = document.getElementById("error-banner-details");
  const chevron = document.getElementById("error-banner-chevron");
  const open = details.style.display === "none";
  details.style.display = open ? "" : "none";
  chevron.className = "error-banner-chevron" + (open ? " open" : "");
});

trayApp.requestData();
})();
