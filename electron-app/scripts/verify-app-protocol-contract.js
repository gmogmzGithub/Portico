#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  APP_PAGE_FILES,
  isAllowedBundlePath,
} = require("../src/services/app-protocol");

const RUNTIME_SOURCE_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);

function isRuntimeSourceFile(fileName) {
  const normalized = String(fileName || "").toLowerCase();
  return (
    RUNTIME_SOURCE_EXTENSIONS.has(path.extname(normalized)) &&
    !normalized.includes(".test.") &&
    !normalized.includes(".spec.")
  );
}

function findLoadFileUsages(sourceRoot) {
  if (!fs.existsSync(sourceRoot)) {
    return [];
  }

  const matches = [];
  const pendingDirectories = [sourceRoot];
  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    for (const entry of fs.readdirSync(currentDirectory, {
      withFileTypes: true,
    })) {
      if (entry.name === "node_modules") {
        continue;
      }

      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }
      if (
        isRuntimeSourceFile(entry.name) &&
        /\.loadFile\s*\(/.test(fs.readFileSync(entryPath, "utf8"))
      ) {
        matches.push(entryPath);
      }
    }
  }

  return matches.sort();
}

function verifyAppProtocolContract(electronAppRoot) {
  const root = path.resolve(electronAppRoot);
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const errors = [];

  const filePrivilegesEnabled =
    packageJson?.build?.electronFuses?.grantFileProtocolExtraPrivileges === true;
  const loadFileUsages = filePrivilegesEnabled
    ? []
    : findLoadFileUsages(path.join(root, "src"));
  if (loadFileUsages.length > 0) {
    const relativeUsages = loadFileUsages.map((filePath) =>
      path.relative(root, filePath).split(path.sep).join("/"),
    );
    errors.push(
      "BrowserWindow.loadFile() cannot be used while grantFileProtocolExtraPrivileges is disabled: " +
        relativeUsages.join(", "),
    );
  }

  for (const page of APP_PAGE_FILES) {
    const relativePath = `src/renderer/views/${page}`;
    const sourcePath = path.join(root, ...relativePath.split("/"));
    if (!fs.existsSync(sourcePath)) {
      errors.push(`Declared application page is missing: ${relativePath}`);
    }
    if (!isAllowedBundlePath(relativePath)) {
      errors.push(
        `Declared application page is outside the app://bundle allowlist: ${relativePath}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Electron app protocol contract failed:\n- ${errors.join("\n- ")}`,
    );
  }

  return {
    pages: APP_PAGE_FILES.length,
    grantFileProtocolExtraPrivileges: filePrivilegesEnabled,
  };
}

function run() {
  const electronAppRoot = path.resolve(__dirname, "..");
  const result = verifyAppProtocolContract(electronAppRoot);
  console.log(
    `Verified app://bundle contract for ${result.pages} shell pages ` +
      `(file protocol privileges: ${result.grantFileProtocolExtraPrivileges ? "enabled" : "disabled"})`,
  );
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  findLoadFileUsages,
  verifyAppProtocolContract,
};
