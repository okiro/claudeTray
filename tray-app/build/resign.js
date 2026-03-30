const { execSync } = require("child_process");
const path = require("path");

// electron-builder afterAllArtifactBuild hook
// Re-signs the .app bundle with ad-hoc signature to fix Team ID mismatch
module.exports = async function (buildResult) {
  for (const file of buildResult.artifactPaths || []) {
    if (file.endsWith(".app")) {
      console.log(`  • re-signing  ${path.basename(file)}`);
      execSync(`codesign --force --deep --sign - "${file}"`);
    }
  }

  // Also sign the unpacked .app in the output directory
  const appDir = path.join(buildResult.outDir, `mac-${buildResult.arch || "arm64"}`);
  const appName = `${buildResult.configuration.productName || "Claude Usage Tray"}.app`;
  const appPath = path.join(appDir, appName);

  try {
    console.log(`  • re-signing  ${appName}`);
    execSync(`codesign --force --deep --sign - "${appPath}"`);
  } catch (_) {
    // unpacked dir may not exist for all targets
  }

  return [];
};
