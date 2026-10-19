#!/usr/bin/env bash
# Builds a Developer ID-signed release into macos-app/dist/.
set -euo pipefail
cd "$(dirname "$0")"

APP="Claude Usage Tray.app"

xcodegen generate --quiet
rm -rf build dist
xcodebuild -project ClaudeUsageTray.xcodeproj -scheme ClaudeUsageTray -configuration Release \
  -destination 'generic/platform=macOS' -derivedDataPath build -quiet build

mkdir -p dist
cp -R "build/Build/Products/Release/$APP" dist/
codesign --verify --strict --verbose=1 "dist/$APP"
ditto -c -k --keepParent "dist/$APP" "dist/Claude Usage Tray.zip"
echo "Built dist/$APP"
