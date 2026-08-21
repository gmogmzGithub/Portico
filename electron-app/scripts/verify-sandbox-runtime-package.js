#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

const APP_ROOT = path.resolve(__dirname, "..");
const APP_PACKAGE_JSON = path.join(APP_ROOT, "package.json");
const SANDBOX_PACKAGE = "@anthropic-ai/sandbox-runtime";

function normalizedUnpackRoots(appPackage) {
  return (appPackage.build?.asarUnpack || []).map((pattern) =>
    String(pattern).replace(/\/\*\*\/?$/, "").replaceAll("\\", "/"),
  );
}

function isCoveredByUnpackRoot(relativePath, unpackRoots) {
  const normalized = relativePath.replaceAll("\\", "/");
  return unpackRoots.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
}

function isRealPathInsideDirectory(directoryPath, candidatePath) {
  const realDirectory = fs.realpathSync(directoryPath);
  const realCandidate = fs.realpathSync(candidatePath);
  const relative = path.relative(realDirectory, realCandidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sandboxDependencyEntrypoints(nodeModulesRoot) {
  const sandboxPackageJson = path.join(
    nodeModulesRoot,
    "@anthropic-ai",
    "sandbox-runtime",
    "package.json",
  );
  if (!fs.existsSync(sandboxPackageJson)) {
    throw new Error(`sandbox runtime package is missing: ${sandboxPackageJson}`);
  }
  const sandboxPackage = JSON.parse(fs.readFileSync(sandboxPackageJson, "utf8"));
  const sandboxRequire = createRequire(sandboxPackageJson);
  return Object.keys(sandboxPackage.dependencies || {})
    .sort()
    .map((dependency) => ({
      dependency,
      entrypoint: sandboxRequire.resolve(dependency),
    }));
}

function verifyConfiguredDependencyClosure() {
  const appPackage = JSON.parse(fs.readFileSync(APP_PACKAGE_JSON, "utf8"));
  const unpackRoots = normalizedUnpackRoots(appPackage);
  const dependencies = sandboxDependencyEntrypoints(
    path.join(APP_ROOT, "node_modules"),
  );
  const missing = dependencies.filter(({ entrypoint }) => {
    const relative = path.relative(APP_ROOT, entrypoint);
    return !isCoveredByUnpackRoot(relative, unpackRoots);
  });
  if (missing.length > 0) {
    throw new Error(
      `sandbox runtime dependencies are not covered by build.asarUnpack: ${missing
        .map(({ dependency }) => dependency)
        .join(", ")}`,
    );
  }
  return dependencies.map(({ dependency }) => dependency);
}

async function verifyPackagedDependencyClosure(resourcesDir) {
  const unpackedRoot = path.join(path.resolve(resourcesDir), "app.asar.unpacked");
  const nodeModulesRoot = path.join(unpackedRoot, "node_modules");
  const dependencies = sandboxDependencyEntrypoints(nodeModulesRoot);
  const outsideUnpacked = dependencies.filter(
    ({ entrypoint }) =>
      !isRealPathInsideDirectory(unpackedRoot, entrypoint),
  );
  if (outsideUnpacked.length > 0) {
    throw new Error(
      `packaged sandbox runtime dependencies escaped app.asar.unpacked: ${outsideUnpacked
        .map(({ dependency }) => dependency)
        .join(", ")}`,
    );
  }

  const sandboxEntrypoint = path.join(
    nodeModulesRoot,
    "@anthropic-ai",
    "sandbox-runtime",
    "dist",
    "index.js",
  );
  await import(pathToFileURL(sandboxEntrypoint).href);
  return dependencies.map(({ dependency }) => dependency);
}

async function afterPack(context) {
  verifyConfiguredDependencyClosure();
  const resourcesDir =
    context.electronPlatformName === "darwin"
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : path.join(context.appOutDir, "resources");
  await verifyPackagedDependencyClosure(resourcesDir);
}

module.exports = afterPack;
module.exports.verifyConfiguredDependencyClosure =
  verifyConfiguredDependencyClosure;
module.exports.verifyPackagedDependencyClosure = verifyPackagedDependencyClosure;
module.exports.isCoveredByUnpackRoot = isCoveredByUnpackRoot;
module.exports.isRealPathInsideDirectory = isRealPathInsideDirectory;

if (require.main === module) {
  try {
    const dependencies = verifyConfiguredDependencyClosure();
    process.stdout.write(
      `Sandbox runtime package closure verified: ${dependencies.join(", ")}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
