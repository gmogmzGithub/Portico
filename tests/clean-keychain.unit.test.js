const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const helperPath = path.join(
  repoRoot,
  "src",
  "scripts",
  "cleanup-portico-keychain.sh",
);
const mockSecurityPath = path.join(
  repoRoot,
  "tests",
  "fixtures",
  "mock-portico-keychain-security.sh",
);
const MOCK_SECURITY = fs.readFileSync(mockSecurityPath, "utf8");

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function writeLines(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portico-keychain-cleanup-"));
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const stateDir = path.join(root, "state");
  const binDir = path.join(root, "bin");
  const tmpDir = path.join(root, "tmp");
  const loginKeychain = path.join(home, "Library", "Keychains", "login.keychain-db");
  const sslCache = path.join(
    home,
    "Library",
    "Caches",
    "portico",
    "single-server-ssl",
  );
  fs.mkdirSync(path.dirname(loginKeychain), { recursive: true });
  fs.mkdirSync(sslCache, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(loginKeychain, "fixture");
  fs.writeFileSync(
    path.join(sslCache, ".cert.sha1"),
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
  );
  writeLines(path.join(stateDir, "services.txt"), [
    "portico",
    "portico",
    "portico Safe Storage",
    "Portico Safe Storage",
    "portico-slack-token",
    "portico-bridge-bearer",
    "custom-portico-service",
    "com.example.unrelated",
  ]);
  writeLines(path.join(stateDir, "certs.txt"), [
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  ]);
  writeExecutable(path.join(binDir, "security"), MOCK_SECURITY);
  writeExecutable(path.join(binDir, "uname"), "#!/bin/bash\nprintf 'Darwin\\n'\n");

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    TMPDIR: tmpDir,
    PATH: `${binDir}:${process.env.PATH}`,
    MOCK_STATE_DIR: stateDir,
    portico_LOGIN_KEYCHAIN_PATH: loginKeychain,
    PORTICO_LLM_KEYCHAIN_SERVICE: "custom-portico-service",
  };

  return {
    root,
    home,
    projectRoot,
    stateDir,
    sslCache,
    env,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function runBash(script, fixture, extraEnv = {}) {
  return spawnSync("bash", ["-c", script], {
    cwd: fixture.projectRoot,
    env: { ...fixture.env, ...extraEnv },
    encoding: "utf8",
  });
}

function readState(fixture, name) {
  const filePath = path.join(fixture.stateDir, name);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function copyCleanDev(fixture) {
  const destination = path.join(fixture.projectRoot, "clean_dev.sh");
  fs.copyFileSync(path.join(repoRoot, "clean_dev.sh"), destination);
  fs.chmodSync(destination, 0o755);
  const helperDestination = path.join(
    fixture.projectRoot,
    "src",
    "scripts",
    "cleanup-portico-keychain.sh",
  );
  fs.mkdirSync(path.dirname(helperDestination), { recursive: true });
  fs.copyFileSync(helperPath, helperDestination);
  fs.chmodSync(helperDestination, 0o755);
  fs.mkdirSync(path.join(fixture.projectRoot, "mcp-configs-user"), {
    recursive: true,
  });
}

function seedElectronOAuthState(fixture) {
  const userDataRoots = [
    path.join(
      fixture.home,
      "Library",
      "Application Support",
      "portico",
    ),
    path.join(fixture.home, ".config", "Portico"),
  ];
  for (const userDataRoot of userDataRoots) {
    const recordsDir = path.join(userDataRoot, "mcp-oauth-records");
    fs.mkdirSync(recordsDir, { recursive: true });
    fs.writeFileSync(path.join(recordsDir, "product-pal.json.enc"), "encrypted");
    fs.writeFileSync(
      path.join(userDataRoot, "mcp-oauth-migration-status.json"),
      "{}",
    );
  }
  return userDataRoots;
}

test("shared cleaner purges current, dynamic, safeStorage, historical, custom, and certificate state", () => {
  const fixture = createFixture();
  try {
    const result = runBash(
      `set -e
source "${helperPath}"
portico_cleanup_legacy_oauth_certificates false "$PWD"
portico_cleanup_generic_passwords false
portico_remove_single_server_ssl_caches false "$PWD"`,
      fixture,
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      readState(fixture, "services.txt"),
      "com.example.unrelated\n",
    );
    assert.equal(readState(fixture, "certs.txt"), "");
    assert.equal(fs.existsSync(fixture.sslCache), false);

    const calls = readState(fixture, "calls.log");
    for (const service of [
      "portico",
      "portico Safe Storage",
      "Portico Safe Storage",
      "portico-slack-token",
      "portico-bridge-bearer",
      "custom-portico-service",
    ]) {
      assert.match(calls, new RegExp(`delete-generic-password\\|${service}`));
    }
    assert.doesNotMatch(calls, /delete-generic-password\|com\.example\.unrelated/);
    assert.doesNotMatch(calls, /(?:^|\|)-(?:a|g|w)(?:\||$)/m);
    assert.match(
      calls,
      /delete-certificate\|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/,
    );
    assert.match(
      calls,
      /delete-certificate\|BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("shared cleaner dry-run reports actions without mutating Keychain or cache state", () => {
  const fixture = createFixture();
  try {
    const initialServices = readState(fixture, "services.txt");
    const initialCerts = readState(fixture, "certs.txt");
    const result = runBash(
      `set -e
source "${helperPath}"
portico_cleanup_legacy_oauth_certificates true "$PWD"
portico_cleanup_generic_passwords true
portico_remove_single_server_ssl_caches true "$PWD"`,
      fixture,
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /\[dry-run\] security delete-certificate/);
    assert.match(result.stdout, /\[dry-run\] purge generic-password service=/);
    assert.match(result.stdout, /\[dry-run\] rm -rf/);
    assert.equal(readState(fixture, "services.txt"), initialServices);
    assert.equal(readState(fixture, "certs.txt"), initialCerts);
    assert.equal(fs.existsSync(fixture.sslCache), true);
    assert.doesNotMatch(readState(fixture, "calls.log"), /delete-/);
  } finally {
    fixture.cleanup();
  }
});

for (const keepKeychain of [false, true]) {
  test(`clean_dev removes OAuth artifacts with keep-keychain=${keepKeychain}`, () => {
    const fixture = createFixture();
    try {
      copyCleanDev(fixture);
      const protectedEnvPath = path.join(fixture.projectRoot, ".env");
      const protectedEnvContent = [
        "CLOUDSMITH_API_KEY=protected-test-key",
        "HARBOR_TOKEN=harbor-test-token",
        "",
      ].join("\n");
      fs.writeFileSync(protectedEnvPath, protectedEnvContent, { mode: 0o600 });
      const userDataRoots = seedElectronOAuthState(fixture);
      const args = [path.join(fixture.projectRoot, "clean_dev.sh"), "--yes"];
      if (keepKeychain) {
        args.push("--keep-keychain");
      }
      const result = spawnSync("bash", args, {
        cwd: fixture.projectRoot,
        env: fixture.env,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(
        fs.readFileSync(protectedEnvPath, "utf8"),
        protectedEnvContent,
        "clean_dev must preserve the repository operator .env byte-for-byte",
      );
      for (const userDataRoot of userDataRoots) {
        assert.equal(
          fs.existsSync(path.join(userDataRoot, "mcp-oauth-records")),
          false,
        );
        assert.equal(
          fs.existsSync(
            path.join(userDataRoot, "mcp-oauth-migration-status.json"),
          ),
          false,
        );
      }
      assert.equal(fs.existsSync(fixture.sslCache), false);

      const services = readState(fixture, "services.txt");
      const certs = readState(fixture, "certs.txt");
      const calls = readState(fixture, "calls.log");
      if (keepKeychain) {
        assert.match(result.stdout, /deliberately preserved/);
        assert.match(services, /portico/);
        assert.match(certs, /AAAA/);
        assert.doesNotMatch(calls, /delete-/);
      } else {
        assert.equal(services, "com.example.unrelated\n");
        assert.equal(certs, "");
        assert.match(calls, /delete-generic-password/);
        assert.match(calls, /delete-certificate/);
      }
    } finally {
      fixture.cleanup();
    }
  });
}

test("generic-password cleanup fails closed when deletion leaves an PORTICO service", () => {
  const fixture = createFixture();
  try {
    const result = runBash(
      `set -e
source "${helperPath}"
portico_cleanup_generic_passwords false`,
      fixture,
      { MOCK_KEEP_SERVICE: "portico" },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /PORTICO Keychain service remains after cleanup: portico/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("cleanup fails closed when Keychain metadata cannot be enumerated", () => {
  const fixture = createFixture();
  try {
    const result = runBash(
      `set -e
source "${helperPath}"
portico_cleanup_generic_passwords false`,
      fixture,
      { MOCK_DUMP_FAIL: "1" },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /Could not enumerate Keychain service metadata/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("certificate cleanup fails closed when a localhost certificate remains", () => {
  const fixture = createFixture();
  try {
    const result = runBash(
      `set -e
source "${helperPath}"
portico_cleanup_legacy_oauth_certificates false "$PWD"`,
      fixture,
      { MOCK_KEEP_CERT: "1" },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /localhost certificate remains after cleanup/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("both cleanup entrypoints expose the deliberate dirty-mode contract", () => {
  const cleanDev = fs.readFileSync(path.join(repoRoot, "clean_dev.sh"), "utf8");
  const cleanFull = fs.readFileSync(path.join(repoRoot, "clean_full.sh"), "utf8");

  for (const source of [cleanDev, cleanFull]) {
    assert.match(source, /--keep-keychain\) KEEP_KEYCHAIN=true/);
    assert.match(source, /cleanup-portico-keychain\.sh/);
  }
  assert.match(cleanDev, /mcp-oauth-records/);
  const filesToRemoveBlock = cleanDev.match(/FILES_TO_REMOVE=\([\s\S]*?\n\)/)?.[0];
  assert.ok(filesToRemoveBlock, "clean_dev.sh must declare FILES_TO_REMOVE");
  assert.doesNotMatch(filesToRemoveBlock, /"\.env"/);
  assert.match(cleanDev, /Preserved protected release-operator input: \.env/);
  assert.match(cleanDev, /mcp-oauth-migration-status\.json/);
  assert.match(cleanFull, /portico_cleanup_legacy_oauth_certificates "\$DRY_RUN"/);
  assert.match(cleanFull, /portico_cleanup_generic_passwords "\$DRY_RUN"/);
  assert.match(cleanFull, /portico_KEYCHAIN_CLEANUP_ALREADY_DONE=1/);
  assert.match(cleanFull, /GIT_CLEAN_PATHS=\(-- \. ':\(exclude,top\)\.env'\)/);
  assert.doesNotMatch(cleanFull, /KEYCHAIN_ACCOUNTS=/);
});
