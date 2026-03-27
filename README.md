# Claude Usage Tray

macOS tray app for viewing Claude Code usage and rate-limit status.

The main app lives in `tray-app/`. This repository also includes an optional local dashboard script at the project root for viewing the same usage data in a browser.

## What It Does

- Shows Claude Code usage in the macOS menu bar
- Displays 5-hour and 7-day usage limit status
- Reads local Claude usage history from `~/.claude/projects`
- Imports Claude Code credentials from the macOS keychain
- Stores app auth data locally using Electron `safeStorage`

## Repository Layout

```text
.
├── README.md
├── .gitignore
├── claude-usage-dashboard.js
├── lib/
│   └── claude-usage-parser.js
└── tray-app/
    ├── main.js
    ├── auth.js
    ├── preload.js
    ├── popup.html
    ├── popup.js
    ├── lib/
    ├── fonts/
    ├── build/
    ├── package.json
    └── package-lock.json
```

## Requirements

- macOS
- Node.js and npm
- Claude Code installed and logged in

## Run The Tray App

```bash
cd tray-app
npm install
npm start
```

## Build The App

```bash
cd tray-app
npm install
npm run build
```

Build output is generated under `tray-app/dist/` and is intentionally ignored by Git.

## Optional Local Dashboard

The repository root also contains a simple browser dashboard:

```bash
node claude-usage-dashboard.js
```

Then open `http://localhost:3333`.

This dashboard is optional and is not used by the tray app itself.

## Security Notes

- No API keys are stored in the repository.
- The tray app imports Claude Code credentials from the macOS keychain.
- The Electron renderer is isolated through a preload bridge instead of direct Node integration.
- Local build artifacts and dependencies are ignored via `.gitignore`.

## Publishing Notes

If you are publishing this repository on GitHub:

- keep `tray-app/node_modules/` out of version control
- keep `tray-app/dist/` out of version control
- review whether you want to keep the optional root dashboard files
