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

## Native Swift App (`macos-app/`)

Native replacement for the Electron app, kept alongside it until parity is confirmed.
AppKit `NSStatusItem` + `NSPopover` hosting SwiftUI; Swift 6 language mode; macOS 14+; no dependencies.

cd macos-app
xcodegen generate  # regenerate the Xcode project (after adding/removing files or editing project.yml)
open ClaudeUsageTray.xcodeproj
./build.sh         # Developer ID-signed universal release in macos-app/dist/

- `AppModel.swift` — `@Observable` state, refresh timers (60s usage, 15m rate limits), coalesced fetches, disk cache
- `UsageStore.swift` — actor; port of `claude-usage-parser.js`, with parsed entries cached per file by mtime+size
- `CredentialStore.swift` — keychain import; `RateLimitClient.swift` — rate-limit header probe
- `StatusItemController.swift` — menu bar item, popover show/dismiss, right-click menu
- `PopoverView.swift` — the popover UI

Gotchas:
- `ClaudeUsageTray.xcodeproj` is generated and git-ignored — edit `project.yml`, not the project
- `Pricing.swift` mirrors `MODEL_PRICING`; update both while both apps exist
- `usage-history.json` keeps the Electron layout at `HISTORY_VERSION` 3; a v2 file is re-priced on load, not discarded, since it holds usage whose transcripts are gone. It lives in `~/Library/Application Support/Claude Usage Tray/` and is seeded from the Electron app's `claude-usage-tray/` directory on first launch
- The OAuth token is never written to disk; only a `connected` flag in UserDefaults persists
- Read Claude Code's keychain item through `/usr/bin/security`, not `SecItem` — the item trusts that tool, so there is no access prompt
- Same bundle ID as the Electron app (`com.claude.usage-tray`): `open` may activate whichever is running, so quit one before launching the other
