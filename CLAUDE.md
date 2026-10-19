# CLAUDE.md

## Commands

cd macos-app
xcodegen generate  # regenerate the Xcode project (after adding/removing files or editing project.yml)
open ClaudeUsageTray.xcodeproj
./build.sh         # Developer ID-signed universal release in macos-app/dist/

## Architecture

Native menu bar app (no Dock icon, no main window): AppKit `NSStatusItem` + `NSPopover` hosting SwiftUI. Swift 6 language mode, macOS 14+, no dependencies.

- `AppDelegate.swift` — entry point; creates the model and the status item
- `AppModel.swift` — `@Observable` state, refresh timers (60s usage, 15m rate limits), coalesced fetches, disk cache
- `UsageStore.swift` — actor; parses `~/.claude/projects/**/*.jsonl` (entries cached per file by mtime+size) and merges with the persisted history
- `Pricing.swift` — per-model prices
- `CredentialStore.swift` — keychain import; `RateLimitClient.swift` — rate-limit header probe
- `StatusItemController.swift` — menu bar item, popover show/dismiss, right-click menu
- `PopoverView.swift` — the popover UI

## Data Flow

1. `UsageStore.load` scans the JSONL transcripts, merges with `usage-history.json` and saves it
2. `AppModel` combines that with the rate limits read from a one-token API request's `anthropic-ratelimit-unified-*` headers
3. `PopoverView` and `StatusItemController` observe `AppModel` directly

## Gotchas

- `ClaudeUsageTray.xcodeproj` is generated and git-ignored — edit `project.yml`, not the project
- `Pricing.swift` must be updated manually when new Claude models launch. A model missing from it is billed at the fallback rate, and history keeps the inflated value (it only goes up) unless a history-version migration re-prices it
- History uses high-water-mark merging — values only go up, never down. Bump `historyVersion` only with a migration: transcripts get deleted, so the history is the only record of older usage
- Data lives in `~/Library/Application Support/Claude Usage Tray/`; on first launch it is seeded from the former Electron app's `claude-usage-tray/` directory
- The OAuth token is never written to disk; only a `connected` flag in UserDefaults persists
- Read Claude Code's keychain item through `/usr/bin/security`, not `SecItem` — the item trusts that tool, so there is no access prompt
- The popover uses `.applicationDefined` behavior with its own dismissal, and opens with `activate(ignoringOtherApps:)` — the cooperative `activate()` leaves the app inactive after a menu bar click
- The former Electron app used the same bundle ID (`com.claude.usage-tray`): quit an installed copy before launching this one

## Code Style

- Plain Swift and SwiftUI; no third-party packages
- Strict concurrency: UI types are `@MainActor`, file and network work runs in actors or off the main thread
