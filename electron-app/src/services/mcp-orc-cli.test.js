const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildMcpOrcGeneratorCommand,
  buildMcpOrcGeneratorInvocation,
  ensureMcpOrcBinary,
  ensureMcpOrcGeneratorCommand,
  hostMcpCurrentTargetTriple,
  isPackagedMacAppRun,
  resolveMcpOrcBinary,
} = require("./mcp-orc-cli");

function makeExecutable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(filePath, 0o755);
}

function makeRustSourceTree(projectRoot) {
  const rustRoot = path.join(projectRoot, "src", "mcp-orc-rust");
  fs.mkdirSync(path.join(rustRoot, "crates", "mcp-orc", "src"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(rustRoot, "Cargo.toml"), "[workspace]\n", "utf8");
  fs.writeFileSync(
    path.join(rustRoot, "crates", "mcp-orc", "src", "main.rs"),
    "fn main() {}\n",
    "utf8",
  );
  return rustRoot;
}

function makeBootstrapScript(projectRoot) {
  const scriptPath = path.join(
    projectRoot,
    "src",
    "scripts",
    "build-host-mcp-binaries.sh",
  );
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");
  return scriptPath;
}

function makeElectronDistributionBundlePaths(bundleRoot) {
  const contentsRoot = path.join(
    bundleRoot,
    "node_modules",
    "electron",
    "dist",
    "Electron.app",
    "Contents",
  );
  return {
    resourcesPath: path.join(contentsRoot, "Resources"),
    execPath: path.join(contentsRoot, "MacOS", "Electron"),
  };
}

test("hostMcpCurrentTargetTriple maps supported hosts to packaged binary targets", () => {
  assert.equal(
    hostMcpCurrentTargetTriple({ platform: "darwin", arch: "arm64" }),
    "aarch64-apple-darwin",
  );
  assert.equal(
    hostMcpCurrentTargetTriple({ platform: "darwin", arch: "x64" }),
    "x86_64-apple-darwin",
  );
  assert.equal(
    hostMcpCurrentTargetTriple({ platform: "linux", arch: "x64" }),
    "x86_64-unknown-linux-gnu",
  );
  assert.equal(
    hostMcpCurrentTargetTriple({ platform: "linux", arch: "arm64" }),
    "aarch64-unknown-linux-gnu",
  );
});

test("isPackagedMacAppRun detects signed app bundle execution on macOS", () => {
  assert.equal(
    isPackagedMacAppRun({
      platform: "darwin",
      defaultApp: false,
      resourcesPath: "/Applications/Portico.app/Contents/Resources",
      execPath: "/Applications/Portico.app/Contents/MacOS/Portico",
    }),
    true,
  );
  assert.equal(
    isPackagedMacAppRun({
      platform: "darwin",
      defaultApp: true,
      resourcesPath: "/Applications/Portico.app/Contents/Resources",
      execPath: "/Applications/Portico.app/Contents/MacOS/Portico",
    }),
    false,
  );
});

test("isPackagedMacAppRun ignores Electron distribution wrappers unless explicitly packaged", () => {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-dev-app-"));
  const { resourcesPath, execPath } = makeElectronDistributionBundlePaths(bundleRoot);

  assert.equal(
    isPackagedMacAppRun({
      platform: "darwin",
      defaultApp: false,
      resourcesPath,
      execPath,
    }),
    false,
  );
  assert.equal(
    isPackagedMacAppRun({
      platform: "darwin",
      defaultApp: false,
      resourcesPath,
      execPath,
      isPackagedApp: false,
    }),
    false,
  );
  assert.equal(
    isPackagedMacAppRun({
      platform: "darwin",
      defaultApp: false,
      resourcesPath,
      execPath,
      isPackagedApp: true,
    }),
    true,
  );

  fs.rmSync(bundleRoot, { recursive: true, force: true });
});

test("resolveMcpOrcBinary prefers a current repo-local debug binary", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-cli-"));
  makeRustSourceTree(projectRoot);
  const debugBinary = path.join(
    projectRoot,
    "src",
    "mcp-orc-rust",
    "target",
    "debug",
    "mcp-orc",
  );
  makeExecutable(debugBinary);

  assert.equal(
    resolveMcpOrcBinary(projectRoot, { env: { PATH: "" } }),
    debugBinary,
  );

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("resolveMcpOrcBinary prefers the bundled signed app binary on packaged macOS", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-cli-"));
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-app-"));
  const resourcesRoot = path.join(
    bundleRoot,
    "Portico.app",
    "Contents",
    "Resources",
  );
  fs.mkdirSync(resourcesRoot, { recursive: true });
  makeRustSourceTree(projectRoot);

  const debugBinary = path.join(
    projectRoot,
    "src",
    "mcp-orc-rust",
    "target",
    "debug",
    "mcp-orc",
  );
  makeExecutable(debugBinary);

  const bundledBinary = path.join(
    resourcesRoot,
    "host-mcp-binaries",
    hostMcpCurrentTargetTriple({ platform: "darwin", arch: "arm64" }),
    "mcp-orc",
  );
  makeExecutable(bundledBinary);

  assert.equal(
    resolveMcpOrcBinary(projectRoot, {
      platform: "darwin",
      arch: "arm64",
      resourcesPath: resourcesRoot,
      execPath: path.join(
        bundleRoot,
        "Portico.app",
        "Contents",
        "MacOS",
        "Portico",
      ),
      defaultApp: false,
      isPackagedApp: true,
      env: { PATH: "" },
    }),
    bundledBinary,
  );

  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(bundleRoot, { recursive: true, force: true });
});

test("resolveMcpOrcBinary rejects unsigned fallbacks for packaged macOS runs", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-cli-"));
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-app-missing-"));
  const resourcesRoot = path.join(
    bundleRoot,
    "Portico.app",
    "Contents",
    "Resources",
  );
  fs.mkdirSync(resourcesRoot, { recursive: true });
  makeRustSourceTree(projectRoot);
  const debugBinary = path.join(
    projectRoot,
    "src",
    "mcp-orc-rust",
    "target",
    "debug",
    "mcp-orc",
  );
  makeExecutable(debugBinary);

  assert.throws(
    () => resolveMcpOrcBinary(projectRoot, {
      platform: "darwin",
      arch: "arm64",
      resourcesPath: resourcesRoot,
      execPath: path.join(
        bundleRoot,
        "Portico.app",
        "Contents",
        "MacOS",
        "Portico",
      ),
      defaultApp: false,
      isPackagedApp: true,
      env: { PATH: "" },
    }),
    /Packaged macOS app requires bundled signed mcp-orc/,
  );

  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(bundleRoot, { recursive: true, force: true });
});

test("resolveMcpOrcBinary treats Electron distribution wrappers as dev launches", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-cli-"));
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-dev-app-"));
  makeRustSourceTree(projectRoot);
  const debugBinary = path.join(
    projectRoot,
    "src",
    "mcp-orc-rust",
    "target",
    "debug",
    "mcp-orc",
  );
  makeExecutable(debugBinary);
  const { resourcesPath, execPath } = makeElectronDistributionBundlePaths(bundleRoot);

  assert.equal(
    resolveMcpOrcBinary(projectRoot, {
      platform: "darwin",
      arch: "arm64",
      resourcesPath,
      execPath,
      defaultApp: false,
      env: { PATH: "" },
    }),
    debugBinary,
  );

  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(bundleRoot, { recursive: true, force: true });
});

test("resolveMcpOrcBinary falls through to packaged artifacts when repo-local binaries are missing", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-cli-"));
  const resourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-cli-res-"));
  makeRustSourceTree(projectRoot);

  const artifactBinary = path.join(
    resourcesRoot,
    "host-mcp-binaries",
    hostMcpCurrentTargetTriple({ platform: process.platform, arch: process.arch }),
    "mcp-orc",
  );
  makeExecutable(artifactBinary);

  assert.equal(
    resolveMcpOrcBinary(projectRoot, {
      resourcesPath: resourcesRoot,
      env: { PATH: "" },
    }),
    artifactBinary,
  );

  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(resourcesRoot, { recursive: true, force: true });
});

test("resolveMcpOrcBinary keeps packaged and dev cache entries separate", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-cli-"));
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-app-"));
  const resourcesRoot = path.join(
    bundleRoot,
    "Portico.app",
    "Contents",
    "Resources",
  );
  fs.mkdirSync(resourcesRoot, { recursive: true });
  makeRustSourceTree(projectRoot);

  const releaseBinary = path.join(
    projectRoot,
    "src",
    "mcp-orc-rust",
    "target",
    "release",
    "mcp-orc",
  );
  makeExecutable(releaseBinary);

  const bundledBinary = path.join(
    resourcesRoot,
    "host-mcp-binaries",
    hostMcpCurrentTargetTriple({ platform: "darwin", arch: "arm64" }),
    "mcp-orc",
  );
  makeExecutable(bundledBinary);

  assert.equal(
    resolveMcpOrcBinary(projectRoot, {
      platform: "darwin",
      arch: "arm64",
      resourcesPath: resourcesRoot,
      execPath: path.join(
        bundleRoot,
        "Portico.app",
        "Contents",
        "MacOS",
        "Portico",
      ),
      defaultApp: false,
      isPackagedApp: false,
      env: { PATH: "" },
    }),
    releaseBinary,
  );
  assert.equal(
    resolveMcpOrcBinary(projectRoot, {
      platform: "darwin",
      arch: "arm64",
      resourcesPath: resourcesRoot,
      execPath: path.join(
        bundleRoot,
        "Portico.app",
        "Contents",
        "MacOS",
        "Portico",
      ),
      defaultApp: false,
      isPackagedApp: true,
      env: { PATH: "" },
    }),
    bundledBinary,
  );

  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(bundleRoot, { recursive: true, force: true });
});

test("resolveMcpOrcBinary memoizes the selected binary for repeated lookups until the binary disappears", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-cli-"));
  makeRustSourceTree(projectRoot);
  const releaseBinary = path.join(
    projectRoot,
    "src",
    "mcp-orc-rust",
    "target",
    "release",
    "mcp-orc",
  );
  makeExecutable(releaseBinary);

  assert.equal(resolveMcpOrcBinary(projectRoot, { env: { PATH: "" } }), releaseBinary);
  fs.unlinkSync(releaseBinary);
  assert.throws(
    () => resolveMcpOrcBinary(projectRoot, { env: { PATH: "" } }),
    /No current mcp-orc binary found/,
  );

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("resolveMcpOrcBinary rejects stale binaries when Rust sources are newer", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-cli-"));
  const rustRoot = makeRustSourceTree(projectRoot);
  const releaseBinary = path.join(
    projectRoot,
    "src",
    "mcp-orc-rust",
    "target",
    "release",
    "mcp-orc",
  );
  makeExecutable(releaseBinary);

  const sourceFile = path.join(rustRoot, "crates", "mcp-orc", "src", "main.rs");
  const staleTime = new Date("2024-01-01T00:00:00Z");
  const freshTime = new Date("2025-01-01T00:00:00Z");
  fs.utimesSync(releaseBinary, staleTime, staleTime);
  fs.utimesSync(sourceFile, freshTime, freshTime);

  assert.throws(
    () => resolveMcpOrcBinary(projectRoot, { env: { PATH: "" } }),
    /No current mcp-orc binary found/,
  );

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("ensureMcpOrcGeneratorCommand bootstraps the current host binary for dev runs", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-cli-"));
  makeRustSourceTree(projectRoot);
  const scriptPath = makeBootstrapScript(projectRoot);
  const hostBinary = path.join(
    projectRoot,
    "host-mcp-binaries",
    hostMcpCurrentTargetTriple({ platform: process.platform, arch: process.arch }),
    "mcp-orc",
  );
  const bootstrapCalls = [];
  const execAsync = async (command, options) => {
    bootstrapCalls.push({ command, options });
    makeExecutable(hostBinary);
    return { stdout: "built", stderr: "" };
  };

  const command = await ensureMcpOrcGeneratorCommand(
    projectRoot,
    "generate-docker-compose-override",
    {
      env: { PATH: "" },
      execAsync,
      isPackagedApp: false,
      defaultApp: true,
      resourcesPath: "",
      execPath: process.execPath,
    },
  );

  assert.equal(bootstrapCalls.length, 1);
  assert.ok(bootstrapCalls[0].command.startsWith("bash "));
  assert.ok(bootstrapCalls[0].command.includes(scriptPath));
  assert.ok(bootstrapCalls[0].command.endsWith(" --host-only"));
  assert.equal(command, `"${hostBinary}" "generate-docker-compose-override" "--project-root" "${projectRoot}"`);

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("ensureMcpOrcGeneratorCommand re-ensures MCP create_dirs before every generator invocation", async () => {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mcp-orc-cli-create-dirs-"),
  );
  makeRustSourceTree(projectRoot);
  const debugBinary = path.join(
    projectRoot,
    "src",
    "mcp-orc-rust",
    "target",
    "debug",
    "mcp-orc",
  );
  makeExecutable(debugBinary);
  const serverDir = path.join(projectRoot, "mcp-configs", "snowflake");
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(
    path.join(serverDir, "snowflake.yaml"),
    "id: snowflake\ncreate_dirs:\n  - runtime-cache\n",
    "utf8",
  );
  const ensuredDir = path.join(projectRoot, "runtime-cache");
  const options = {
    env: { PATH: "" },
    isPackagedApp: false,
    defaultApp: true,
    resourcesPath: "",
    execPath: process.execPath,
  };

  const command = await ensureMcpOrcGeneratorCommand(
    projectRoot,
    "generate-docker-compose-override",
    options,
  );

  assert.equal(
    command,
    `"${debugBinary}" "generate-docker-compose-override" "--project-root" "${projectRoot}"`,
  );
  assert.equal(fs.statSync(ensuredDir).isDirectory(), true);

  // Restart/toggle/tool-save flows re-invoke the generator after the user
  // deleted the directory mid-session; it must come back.
  fs.rmSync(ensuredDir, { recursive: true, force: true });
  await ensureMcpOrcGeneratorCommand(
    projectRoot,
    "generate-docker-compose-override",
    options,
  );

  assert.equal(fs.statSync(ensuredDir).isDirectory(), true);

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("ensureMcpOrcBinary rejects packaged app runs without a bundled signed binary", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-cli-"));
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-app-missing-"));
  const resourcesRoot = path.join(
    bundleRoot,
    "Portico.app",
    "Contents",
    "Resources",
  );
  fs.mkdirSync(resourcesRoot, { recursive: true });
  makeRustSourceTree(projectRoot);

  let attemptedBootstrap = false;
  await assert.rejects(
    () =>
      ensureMcpOrcBinary(projectRoot, {
        platform: "darwin",
        arch: "arm64",
        resourcesPath: resourcesRoot,
        execPath: path.join(
          bundleRoot,
          "Portico.app",
          "Contents",
          "MacOS",
          "Portico",
        ),
        defaultApp: false,
        isPackagedApp: true,
        env: { PATH: "" },
        execAsync: async () => {
          attemptedBootstrap = true;
          return { stdout: "", stderr: "" };
        },
      }),
    /Packaged macOS app requires bundled signed mcp-orc/,
  );
  assert.equal(attemptedBootstrap, false);

  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(bundleRoot, { recursive: true, force: true });
});

test("ensureMcpOrcBinary surfaces bootstrap failures with actionable context", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-cli-"));
  makeRustSourceTree(projectRoot);
  makeBootstrapScript(projectRoot);

  await assert.rejects(
    () =>
      ensureMcpOrcBinary(projectRoot, {
        env: { PATH: "" },
        execAsync: async () => {
          const error = new Error("Command failed");
          error.stderr = "bootstrap exploded";
          throw error;
        },
        isPackagedApp: false,
        defaultApp: true,
        resourcesPath: "",
        execPath: process.execPath,
      }),
    /Failed to bootstrap current-host mcp-orc binary via bash .*build-host-mcp-binaries\.sh --host-only: bootstrap exploded/,
  );

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("resolveMcpOrcBinary invalidates a cached binary when Rust sources become newer", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-cli-"));
  const rustRoot = makeRustSourceTree(projectRoot);
  const releaseBinary = path.join(
    projectRoot,
    "src",
    "mcp-orc-rust",
    "target",
    "release",
    "mcp-orc",
  );
  makeExecutable(releaseBinary);

  assert.equal(resolveMcpOrcBinary(projectRoot, { env: { PATH: "" } }), releaseBinary);

  const sourceFile = path.join(rustRoot, "crates", "mcp-orc", "src", "main.rs");
  const staleTime = new Date("2024-01-01T00:00:00Z");
  const freshTime = new Date("2025-01-01T00:00:00Z");
  fs.utimesSync(releaseBinary, staleTime, staleTime);
  fs.utimesSync(sourceFile, freshTime, freshTime);

  assert.throws(
    () => resolveMcpOrcBinary(projectRoot, { env: { PATH: "" } }),
    /No current mcp-orc binary found/,
  );

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("buildMcpOrcGeneratorInvocation includes the subcommand, force flag, and project root", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-orc-cli-"));
  makeRustSourceTree(projectRoot);
  const releaseBinary = path.join(
    projectRoot,
    "src",
    "mcp-orc-rust",
    "target",
    "release",
    "mcp-orc",
  );
  makeExecutable(releaseBinary);

  const invocation = buildMcpOrcGeneratorInvocation(
    projectRoot,
    "generate-docker-compose-override",
    { force: true },
  );

  assert.deepEqual(invocation, {
    command: releaseBinary,
    args: [
      "generate-docker-compose-override",
      "--force",
      "--project-root",
      projectRoot,
    ],
  });

  const command = buildMcpOrcGeneratorCommand(
    projectRoot,
    "generate-mcp-config",
  );
  assert.match(
    command,
    /mcp-orc" "generate-mcp-config" "--project-root"/,
  );

  fs.rmSync(projectRoot, { recursive: true, force: true });
});
