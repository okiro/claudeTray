# Claude Usage Tray

macOS menu bar app for monitoring Claude Code usage and rate-limit status.

## What It Does

- Displays today, monthly, and all-time Claude Code spending in the menu bar
- Shows 5-hour and 7-day usage limit bars with reset countdowns
- Shows overage utilization when non-zero
- Lists recent and top projects by cost
- Reads local Claude usage history from `~/.claude/projects`
- Imports Claude Code credentials from the macOS keychain
- Auto-refreshes usage every 60s and rate limits every 15 minutes
- Shows an error indicator when something goes wrong

## Screenshot

Click the tray icon to open the popup:

- Cost cards (today / month / all time)
- Rate limit bars (5h and 7d utilization)
- Recent and top projects
- Error banner (only visible when issues are detected)

## Repository Layout

```text
.
├── README.md
├── .gitignore
└── tray-app/
    ├── main.js           # Electron main process, tray icon, IPC
    ├── auth.js           # Keychain import, token management
    ├── preload.js        # Context bridge for renderer
    ├── popup.html        # Popup UI and styles
    ├── popup.js          # Renderer logic
    ├── lib/
    │   └── claude-usage-parser.js  # JSONL parsing and cost calculation
    ├── fonts/            # Instrument Serif, Azeret Mono
    ├── build/            # macOS build assets (icon, entitlements)
    ├── package.json
    └── package-lock.json
```

## Requirements

- macOS
- Node.js and npm
- Claude Code installed and logged in (credentials must exist in macOS keychain)

## Run

```bash
cd tray-app
npm install
npm start
```

## Build

```bash
cd tray-app
npm run build
```

Build output goes to `tray-app/dist/` (git-ignored).

## Native macOS App (Swift)

`macos-app/` is a native Swift rewrite of the tray app (AppKit status item, SwiftUI popover, no dependencies), about 2 MB instead of Electron's ~260 MB. It reads the same data and, on first launch, carries over the Electron app's usage history and connected state.

Requires macOS 14+, Xcode, and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

```bash
cd macos-app
xcodegen generate              # creates ClaudeUsageTray.xcodeproj
open ClaudeUsageTray.xcodeproj # run from Xcode
./build.sh                     # signed universal release in macos-app/dist/
```

## How It Works

1. **Usage data** is parsed from `~/.claude/projects/` JSONL files and merged with a persistent history file to survive session deletions.
2. **Rate limits** are fetched by making a minimal API request to Anthropic and reading the response headers.
3. **Authentication** is imported from Claude Code's macOS keychain entry and encrypted locally with Electron's `safeStorage`.
4. **Errors** from data parsing, auth, or API calls surface in a collapsible error banner above the footer.

## Security

- No API keys or credentials are stored in the repository
- Credentials are imported from the macOS keychain at runtime
- Tokens are encrypted on disk using Electron `safeStorage`
- The renderer is isolated via a preload context bridge (no `nodeIntegration`)
