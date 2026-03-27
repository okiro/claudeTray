# CLAUDE.md

## Commands

cd tray-app
npm install        # install dependencies
npm start          # run in dev mode (electron .)
npm run build      # build macOS app (electron-builder --mac, output in dist/)

## Architecture

Electron tray-only app (no dock icon). Three processes:

- **Main** (`main.js`): Tray icon, popup window, IPC handlers, rate limit fetching, data assembly
- **Preload** (`preload.js`): Context bridge exposing `window.trayApp` API to renderer
- **Renderer** (`popup.html` + `popup.js`): Popup UI, data rendering

## Data Flow

1. `lib/claude-usage-parser.js` reads JSONL files from `~/.claude/projects/` and merges with persistent history
2. `main.js:gatherData()` assembles dashboard payload (totals, projects, rate limits, errors)
3. Sent to renderer via IPC `update-data` channel
4. `popup.js:renderData()` updates the DOM

## Key Files

- `tray-app/main.js` — App lifecycle, tray, popup window, IPC, rate limit API calls
- `tray-app/auth.js` — Keychain import (`security` CLI), token encryption via `safeStorage`
- `tray-app/lib/claude-usage-parser.js` — JSONL parsing, cost calculation, history merge
- `tray-app/popup.js` — Renderer logic (wrapped in IIFE to avoid contextBridge naming conflict)
- `tray-app/popup.html` — UI markup and all CSS (no external stylesheets)

## Gotchas

- `popup.js` must be wrapped in an IIFE — `contextBridge.exposeInMainWorld("trayApp", ...)` creates a global binding; a top-level `const trayApp` causes SyntaxError
- No `nodeIntegration` — renderer can only use APIs exposed through preload.js
- `app.dock?.hide()` makes this tray-only; there is no main window
- Popup hides on blur — test UI changes by keeping DevTools undocked
- Font files in `tray-app/fonts/` are required; missing fonts won't crash but text becomes invisible
- MODEL_PRICING in the parser must be updated manually when new Claude models launch
- History uses high-water-mark merging — values only go up, never down

## Code Style

- Plain JavaScript (no TypeScript, no bundler, no framework)
- HTML strings built via concatenation in popup.js (no template engine)
- All CSS is inline in popup.html `<style>` block
- No external dependencies beyond Electron
