# Claude Usage Tray

Native macOS menu bar app for monitoring Claude Code usage and rate-limit status.

## What It Does

- Shows the 5-hour usage limit as a gauge and percentage in the menu bar
- Displays today, monthly, and all-time Claude Code spending
- Shows 5-hour and 7-day usage limit bars with reset countdowns and local token counts
- Shows overage utilization when non-zero
- Lists recent and top projects by cost
- Reads local Claude usage history from `~/.claude/projects`
- Imports Claude Code credentials from the macOS keychain
- Auto-refreshes usage every 60s and rate limits every 15 minutes
- Shows an issue indicator when something goes wrong

Click the menu bar item to open the dashboard; right-click for Refresh and Quit.

## Repository Layout

```text
.
├── README.md
├── CLAUDE.md
└── macos-app/
    ├── project.yml          # XcodeGen project definition
    ├── build.sh             # Signed release build
    └── ClaudeUsageTray/     # Swift sources and asset catalog
```

## Requirements

- macOS 14+
- Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)
- Claude Code installed and logged in (credentials must exist in the macOS keychain)

## Run

```bash
cd macos-app
xcodegen generate              # creates ClaudeUsageTray.xcodeproj
open ClaudeUsageTray.xcodeproj # run from Xcode
```

## Build

```bash
cd macos-app
./build.sh
```

Produces a Developer ID-signed universal app and zip in `macos-app/dist/` (git-ignored).

## How It Works

1. **Usage data** is parsed from `~/.claude/projects/` JSONL files and merged with a persistent history file, so usage survives session deletions.
2. **Rate limits** are fetched by making a minimal API request to Anthropic and reading the response headers.
3. **Authentication** is imported from Claude Code's macOS keychain entry and kept in memory only.
4. **Errors** from the API or auth surface in a collapsible issue list above the footer.

## Security

- No API keys or credentials are stored in the repository
- Credentials are imported from the macOS keychain at runtime and never written to disk
- The release build is signed with hardened runtime
