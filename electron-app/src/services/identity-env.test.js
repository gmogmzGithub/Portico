const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  parseIdentityEnv,
  writeCanonicalIdentityEnv,
  writeIdentityEnvAtomic,
} = require("./identity-env");

test("identity env parser accepts export, whitespace, quotes, and last assignment wins", () => {
  assert.deepEqual(
    parseIdentityEnv([
      " PORTICO_USER_NAME = 'Old Name' ",
      'export PORTICO_USER_ID="abc123"',
      "export PORTICO_USER_NAME = Jane Doe",
      "",
    ].join("\n")),
    { userId: "abc123", userName: "Jane Doe" },
  );
});

test("identity env writer canonicalizes duplicates while preserving unrelated values", () => {
  const result = writeCanonicalIdentityEnv(
    [
      "FOO=one",
      " export PORTICO_USER_NAME='Old Name'",
      "CLOUDSMITH_API_KEY=protected",
      "PORTICO_USER_ID=old-id",
      "PORTICO_USER_NAME=duplicate",
      "BAR=two",
      "",
    ].join("\n"),
    { userId: "new-id", userName: "New Name" },
  );

  assert.match(result, /^FOO=one$/m);
  assert.match(result, /^CLOUDSMITH_API_KEY=protected$/m);
  assert.match(result, /^BAR=two$/m);
  assert.equal((result.match(/^PORTICO_USER_ID=/gm) || []).length, 1);
  assert.equal((result.match(/^PORTICO_USER_NAME=/gm) || []).length, 1);
  assert.deepEqual(parseIdentityEnv(result), {
    userId: "new-id",
    userName: "New Name",
  });
});

test("identity env writer preserves unrelated bytes, ordering, and CRLF endings", () => {
  const source = [
    "FOO=one",
    "CLOUDSMITH_API_KEY=protected-release-key",
    "PORTICO_USER_NAME=Old Name",
    "BAR=two # keep this comment byte-for-byte",
    "PORTICO_USER_ID=old-id",
    "BAZ='three'",
    "",
  ].join("\r\n");

  assert.equal(
    writeCanonicalIdentityEnv(source, {
      userId: "new-id",
      userName: "New Name",
    }),
    [
      "FOO=one",
      "CLOUDSMITH_API_KEY=protected-release-key",
      "PORTICO_USER_ID='new-id'",
      "PORTICO_USER_NAME='New Name'",
      "BAR=two # keep this comment byte-for-byte",
      "BAZ='three'",
      "",
    ].join("\r\n"),
  );
});

test("identity env writer round-trips dotenv metacharacters through the parser", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-env-parser-test-"));
  const envPath = path.join(dir, ".env");
  const userId = "jdoe$(printf unsafe)";
  const userName = "Jane O'Brien $HOME `printf unsafe` # admin \\ user";
  const content = writeCanonicalIdentityEnv("CLOUDSMITH_API_KEY='protected'\n", {
    userId,
    userName,
  });
  fs.writeFileSync(envPath, content, { mode: 0o600 });

  try {
    assert.deepEqual(parseIdentityEnv(content), { userId, userName });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("identity env writer round-trips apostrophes and metacharacters through Docker Compose", (t) => {
  const composeVersion = spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
  });
  if (composeVersion.status !== 0) {
    t.skip("Docker Compose is unavailable");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-env-compose-test-"));
  const envPath = path.join(dir, ".env");
  const composePath = path.join(dir, "compose.yml");
  const userId = "jdoe$(printf unsafe)";
  const userName = "Jane O'Brien $HOME `printf unsafe` # admin \\ user";
  fs.writeFileSync(
    envPath,
    writeCanonicalIdentityEnv("CLOUDSMITH_API_KEY='protected'\n", {
      userId,
      userName,
    }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    composePath,
    [
      "services:",
      "  identity-test:",
      "    image: busybox:latest",
      "    environment:",
      "      PORTICO_USER_ID: ${PORTICO_USER_ID}",
      "      PORTICO_USER_NAME: ${PORTICO_USER_NAME}",
      "",
    ].join("\n"),
  );

  try {
    const configured = spawnSync(
      "docker",
      [
        "compose",
        "--env-file",
        envPath,
        "-f",
        composePath,
        "config",
        "--environment",
      ],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(configured.status, 0, configured.stderr);
    const environment = new Map(
      configured.stdout
        .split(/\r?\n/)
        .filter((line) => line.includes("="))
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    assert.equal(environment.get("PORTICO_USER_ID"), userId);
    assert.equal(environment.get("PORTICO_USER_NAME"), userName);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("identity env writer rejects newline injection", () => {
  assert.throws(
    () =>
      writeCanonicalIdentityEnv("", {
        userId: "abc\nINJECTED=true",
        userName: "Jane Doe",
      }),
    /must not contain a newline/,
  );
});

test("atomic identity writer replaces the file and enforces mode 0600", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-env-test-"));
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "OLD=true\n", { mode: 0o644 });

  try {
    await writeIdentityEnvAtomic(envPath, "NEW=true\n");
    assert.equal(fs.readFileSync(envPath, "utf8"), "NEW=true\n");
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes(".tmp")),
      [],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
