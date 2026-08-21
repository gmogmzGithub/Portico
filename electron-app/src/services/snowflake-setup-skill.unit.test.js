const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const yaml = require("js-yaml");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SKILL_DIR = path.join(REPO_ROOT, "skills/snowflake-setup");
const SKILL_PATH = path.join(SKILL_DIR, "SKILL.md");
const SETUP_SCRIPT_PATH = path.join(SKILL_DIR, "scripts/snowflake_setup.py");
const INSPECT_SCRIPT_PATH = path.join(SKILL_DIR, "scripts/snowflake_inspect.py");
const PYTHON = process.env.PYTHON || "python3";
const PAT = "SECRET_PAT_VALUE_NEVER_ECHO";

function readSkill() {
  return fs.readFileSync(SKILL_PATH, "utf8");
}

function frontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "expected SKILL.md frontmatter");
  return match[1];
}

function createFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snowflake-setup-skill-"));
  const tokenPath = path.join(tmp, "pat.txt");
  const outputDir = path.join(tmp, "out");
  fs.writeFileSync(tokenPath, `${PAT}\n`, { encoding: "utf8", mode: 0o600 });
  return { tmp, tokenPath, outputDir };
}

function connectionArgs(tokenPath) {
  return ["--token-file", tokenPath, "--user", "dsantiago"];
}

function runSetup(fixture, operation = "all", extraArgs = []) {
  return spawnSync(
    PYTHON,
    [
      SETUP_SCRIPT_PATH,
      "--operation",
      operation,
      "--output-dir",
      fixture.outputDir,
      ...(operation === "mcp-config" ? [] : connectionArgs(fixture.tokenPath)),
      ...extraArgs,
    ],
    { encoding: "utf8" },
  );
}

function runInspector(outputDir) {
  return spawnSync(
    PYTHON,
    [INSPECT_SCRIPT_PATH, "--output-dir", outputDir],
    { encoding: "utf8" },
  );
}

function parseSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /SECRET_PAT_VALUE_NEVER_ECHO/);
  assert.doesNotMatch(result.stderr, /SECRET_PAT_VALUE_NEVER_ECHO/);
  return JSON.parse(result.stdout);
}

test("snowflake setup skill starts with workspace consent and infers progress", () => {
  const source = readSkill();
  const metadata = frontmatter(source);
  const workspace = source.indexOf("agent_vm_set_chat_workspace");
  const createVm = source.indexOf("agent_vm_create");
  const inspect = source.indexOf("scripts/snowflake_inspect.py");

  assert.match(source, /^---\nname: snowflake-setup/m);
  assert.match(source, /^display_name: Snowflake Setup/m);
  assert.match(metadata, /priority: high/);
  assert.doesNotMatch(metadata, /required_mcp_servers/);
  assert.ok(workspace >= 0 && workspace < createVm && createVm < inspect);
  assert.match(source, /First call `agent_vm_set_chat_workspace`/);
  assert.match(source, /An `empty` result means the user is at the very beginning/);
  assert.match(source, /Do not ask `Which step are you at\?`/);
  assert.match(source, /The user's own request is the approval for files this app owns/);
  assert.match(source, /`connections.generated: true`/);
  assert.match(
    source,
    /ask one plain-language question before replacing it, no matter how clear the request/,
  );
  assert.match(
    source,
    /Also ask when intent is genuinely ambiguous/,
  );
  assert.match(
    source,
    /`mcp_config\.yaml` is different: never replace it without explicitly asking first/,
  );
  assert.match(source, /use plain language only/);
  assert.match(
    source,
    /never internal terms like "Trust Kit", "secure stub", "protected connection file"/,
  );
  assert.match(source, /Snowflake keeps its local connection files in `~\/\.snowflake`/);
  assert.match(source, /Your token is handled separately through a secure masked prompt/);
});

test("snowflake setup skill enforces the script-only secret boundary", () => {
  const source = readSkill();

  assert.match(source, /only permitted way to inspect `\/work\/connections\.toml`/);
  assert.match(source, /Never use file-read tools, shell commands, Python snippets, screenshots, links, or file display/);
  assert.match(source, /Never ask for a PAT, API key, password, or client secret in chat/);
  assert.match(source, /never source it by reading an existing connection file/);
  assert.match(source, /--operation rotate-token/);
  assert.match(
    source,
    /Pass `--replace-existing` when the user's request expresses setup\/repair\/new-token intent/,
  );
  assert.match(source, /Explicit user intent overrides `overall_state`/);
  assert.match(
    source,
    /broken, expired, or that they want to provide a new token, go straight to the Secure PAT flow/,
  );
  assert.match(source, /do not enable first/);
  assert.match(source, /Absent such explicit intent, use `overall_state` exactly/);
  assert.match(source, /`candidate_ready`: enable Snowflake immediately/);
  assert.match(source, /`connection_only`:[^\n]*--operation mcp-config/);
  assert.match(source, /`config_only`:[^\n]*--operation connections/);
  assert.match(
    source,
    /pivot to the rotate-token Secure PAT flow instead of waiting or re-toggling/,
  );
});

test("snowflake setup skill treats unavailable encrypted connection data as secure replacement", () => {
  const source = readSkill();

  assert.match(source, /errorCode: "SAVED_SECRET_UNAVAILABLE"/);
  assert.match(source, /configurationIssue: "saved_secret_unavailable"/);
  assert.match(
    source,
    /Immediately continue the Secure PAT flow, collect a fresh PAT plus the LDAP username/,
  );
  assert.match(source, /--operation connections --replace-existing/);
  assert.match(source, /then enable exactly once more/);
  assert.match(
    source,
    /Never call `mcp_assistant_trigger_guided_setup` from this skill/,
  );
});

test("snowflake setup skill requests a self-contained PAT modal in the same turn", () => {
  const source = readSkill();

  assert.match(source, /prompt="Enter your Snowflake programmatic access token"/);
  assert.match(source, /label="Snowflake programmatic access token"/);
  assert.match(source, /timeout_seconds=3600/);
  assert.match(source, /\[Open Snowflake's Authentication settings\]\(https:\/\/app\.snowflake\.com\/porticoorg\/portico\/settings\/authentication\)/);
  assert.match(source, /sign in through Okta if prompted/i);
  assert.match(source, /Under \*\*Programmatic access tokens\*\*, click \*\*Generate token\*\*/);
  assert.match(source, /Set the \*\*Name\*\* to `PORTICO-MCP`\./);
  assert.match(source, /Set \*\*Expires in\*\* to \*\*1 year\*\*\./);
  assert.match(
    source,
    /choose \*\*Single role \(recommended\)\*\* and keep \*\*PUBLIC \(default role\)\*\* selected/,
  );
  assert.doesNotMatch(source, /\*\*All of my roles\*\* \(not Single role\)/);
  // The token-creation preamble is 8 crisp steps with no policy caveats.
  assert.match(source, /8\. Return to this secure dialog and paste the token below\./);
  assert.doesNotMatch(source, /network policy/);
  assert.match(source, /Click the copy button next to the new token/);
  assert.match(source, /Return to this secure dialog and paste the token below/);
  assert.match(source, /Do not tell the user to return to chat or wait for another chat message/);
  assert.doesNotMatch(source, /copy the generated token, then return to chat/i);
});

test("snowflake setup skill provides visual aids from bundled assets", () => {
  const source = readSkill();

  assert.match(source, /skills_get_skill_assets/);
  assert.match(source, /skill_name="snowflake-setup"/);
  assert.match(source, /assets\/generate-token-page\.png/);
  assert.match(source, /assets\/token-name-field\.png/);
  assert.match(source, /assets\/token-expires-one-year\.png/);
  assert.match(source, /assets\/token-grant-single-role\.png/);
  assert.match(source, /assets\/generate-token-generate-button\.png/);
  assert.match(source, /assets\/copy-token-button\.png/);
  // The combined dialog screenshot was superseded by per-step crops.
  assert.doesNotMatch(source, /generate-token-dialog\.png/);
  assert.match(source, /visual_aids/);
  assert.match(source, /continue without visual aids/);
  assert.match(
    source,
    /only the `download_url` values returned by that same-turn `skills_get_skill_assets` call/,
  );
  assert.match(source, /"step": 3,[^\n]*token-name-field\.png/);
  assert.match(source, /"step": 4,[^\n]*token-expires-one-year\.png/);
  assert.match(source, /"step": 5,[^\n]*token-grant-single-role\.png/);
  assert.match(source, /"step": 6,[^\n]*generate-token-generate-button\.png/);
  assert.match(source, /"step": 7,[^\n]*copy-token-button\.png/);
  for (const asset of [
    "generate-token-page.png",
    "token-name-field.png",
    "token-expires-one-year.png",
    "token-grant-single-role.png",
    "generate-token-generate-button.png",
    "copy-token-button.png",
  ]) {
    assert.ok(
      fs.existsSync(path.join(SKILL_DIR, "assets", asset)),
      `expected bundled asset ${asset}`,
    );
  }
});

test("snowflake setup skill preserves the activation gates", () => {
  const source = readSkill();

  assert.doesNotMatch(source, /chrome[- ]?devtools/i);
  assert.match(source, /mcp_assistant_toggle_integration\(server_id="snowflake", enabled=true\)/);
  assert.match(source, /activate `server:snowflake`/);
  assert.match(source, /Ask before any live Snowflake smoke test/);
});

test("snowflake setup script writes valid files without returning connection values", () => {
  const fixture = createFixture();
  try {
    const payload = parseSuccess(runSetup(fixture));
    assert.deepEqual(payload, {
      files_written: ["connections.toml", "mcp_config.yaml"],
      mode: "trust-kit",
      operation: "all",
      success: true,
    });

    const connectionsPath = path.join(fixture.outputDir, "connections.toml");
    const configPath = path.join(fixture.outputDir, "mcp_config.yaml");
    const connections = fs.readFileSync(connectionsPath, "utf8");
    const config = yaml.load(fs.readFileSync(configPath, "utf8"));
    assert.match(connections, /authenticator = "PROGRAMMATIC_ACCESS_TOKEN"/);
    assert.match(connections, /token = "SECRET_PAT_VALUE_NEVER_ECHO"/);
    assert.doesNotMatch(connections, /password =/);
    assert.match(connections, /account = "PORTICOORG-PORTICO"/);
    assert.match(connections, /user = "dsantiago"/);
    assert.match(connections, /role = "PUBLIC"/);
    assert.match(connections, /warehouse = "<none selected>"/);
    assert.match(connections, /database = "<none selected>"/);
    assert.match(connections, /schema = "<none selected>"/);
    assert.equal(config.other_services.object_manager, true);
    assert.equal(config.other_services.query_manager, true);
    assert.equal(config.other_services.semantic_manager, true);
    assert.equal(config.agent_services[0].service_name, "TRUST_KIT_AGENT");
    assert.equal(config.analyst_services[0].semantic_model, "TRUST_KIT");
    assert.deepEqual(config.sql_statement_permissions, [
      { Select: true },
      { Describe: true },
      { Use: true },
    ]);
    assert.equal(fs.statSync(connectionsPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("snowflake setup operations preserve sibling files and rotate only the PAT", () => {
  const fixture = createFixture();
  try {
    parseSuccess(runSetup(fixture, "connections"));
    const connectionsPath = path.join(fixture.outputDir, "connections.toml");
    const configPath = path.join(fixture.outputDir, "mcp_config.yaml");
    assert.equal(fs.existsSync(configPath), false);

    parseSuccess(runSetup(fixture, "mcp-config"));
    const originalConfig = fs.readFileSync(configPath, "utf8");
    fs.appendFileSync(connectionsPath, 'custom_setting = "KEEP_ME"\n', "utf8");
    fs.writeFileSync(fixture.tokenPath, "ROTATED_PAT_NEVER_ECHO\n", "utf8");
    const rotated = runSetup(fixture, "rotate-token");
    assert.equal(rotated.status, 0, rotated.stderr);
    assert.doesNotMatch(`${rotated.stdout}${rotated.stderr}`, /ROTATED_PAT_NEVER_ECHO/);
    const updatedConnections = fs.readFileSync(connectionsPath, "utf8");
    assert.match(updatedConnections, /token = "ROTATED_PAT_NEVER_ECHO"/);
    assert.doesNotMatch(updatedConnections, /SECRET_PAT_VALUE_NEVER_ECHO/);
    assert.match(updatedConnections, /custom_setting = "KEEP_ME"/);
    assert.equal(fs.readFileSync(configPath, "utf8"), originalConfig);
    assert.deepEqual(
      fs.readdirSync(fixture.outputDir).sort(),
      ["connections.toml", "mcp_config.yaml"],
      "operations must not leave plaintext backups or staging files",
    );
  } finally {
    fs.rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("snowflake setup refuses implicit replacement and redacts invalid input", () => {
  const fixture = createFixture();
  try {
    parseSuccess(runSetup(fixture));
    const replacement = runSetup(fixture);
    assert.notEqual(replacement.status, 0);
    assert.deepEqual(JSON.parse(replacement.stderr), {
      error_code: "target_exists",
      success: false,
    });
    assert.doesNotMatch(`${replacement.stdout}${replacement.stderr}`, /SECRET_PAT_VALUE_NEVER_ECHO/);

    const badMetadata = runSetup(
      { ...fixture, outputDir: path.join(fixture.tmp, "bad") },
      "connections",
      ["--user", "DO_NOT_ECHO_THIS\nSECOND_LINE"],
    );
    assert.notEqual(badMetadata.status, 0);
    assert.doesNotMatch(`${badMetadata.stdout}${badMetadata.stderr}`, /DO_NOT_ECHO_THIS|SECOND_LINE/);
    assert.equal(JSON.parse(badMetadata.stderr).field, "user");
  } finally {
    fs.rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("snowflake inspector classifies progress without leaking file values", () => {
  const fixture = createFixture();
  try {
    let inspected = parseSuccess(runInspector(fixture.outputDir));
    assert.equal(inspected.overall_state, "empty");

    parseSuccess(runSetup(fixture));
    inspected = parseSuccess(runInspector(fixture.outputDir));
    assert.equal(inspected.connections.state, "complete");
    assert.equal(inspected.connections.issue_code, null);
    assert.equal(inspected.mcp_config.state, "generated_trust_kit");
    assert.equal(inspected.overall_state, "candidate_ready");
    assert.doesNotMatch(JSON.stringify(inspected), /dsantiago|SECRET_PAT/);

    // Legacy generated shape: PAT under `password` with the PAT authenticator
    // — flagged repairable but still usable (enable migrates it).
    const connectionsPath = path.join(fixture.outputDir, "connections.toml");
    const generated = fs.readFileSync(connectionsPath, "utf8");
    fs.writeFileSync(
      connectionsPath,
      generated.replace(/^token = /m, "password = "),
      "utf8",
    );
    const legacy = parseSuccess(runInspector(fixture.outputDir));
    assert.equal(legacy.connections.state, "complete");
    assert.equal(legacy.connections.issue_code, "legacy_pat_credential");
    assert.equal(legacy.overall_state, "candidate_ready");

    // Non-PAT authenticators stay unsupported.
    fs.writeFileSync(
      connectionsPath,
      generated.replace(
        'authenticator = "PROGRAMMATIC_ACCESS_TOKEN"',
        'authenticator = "externalbrowser"',
      ),
      "utf8",
    );
    const unsupported = parseSuccess(runInspector(fixture.outputDir));
    assert.equal(unsupported.connections.state, "invalid");
    assert.equal(unsupported.connections.issue_code, "unsupported_authenticator");

    // The same password-under-PAT defect WITHOUT our marker is hand-written:
    // never promised auto-migration, routed to repair instead.
    fs.writeFileSync(
      connectionsPath,
      generated
        .replace(/^token = /m, "password = ")
        .split("\n")
        .filter((line) => !line.startsWith("#"))
        .join("\n"),
      "utf8",
    );
    const handWritten = parseSuccess(runInspector(fixture.outputDir));
    assert.equal(handWritten.connections.state, "invalid");
    assert.equal(handWritten.connections.issue_code, "pat_credential_key_mismatch");
    assert.equal(handWritten.connections.generated, false);

    // Shapes the connector cannot sign in with are never "complete":
    // token without an authenticator (password login ignores `token`)...
    fs.writeFileSync(
      connectionsPath,
      generated.replace(/^authenticator = [^\n]*\n/m, ""),
      "utf8",
    );
    const bareToken = parseSuccess(runInspector(fixture.outputDir));
    assert.equal(bareToken.connections.state, "invalid");
    assert.equal(bareToken.connections.issue_code, "unsupported_credential_shape");

    // ...and both credential keys at once (repair rather than guess).
    fs.writeFileSync(
      connectionsPath,
      generated.replace(/^token = ([^\n]*)\n/m, 'token = $1\npassword = "also"\n'),
      "utf8",
    );
    const both = parseSuccess(runInspector(fixture.outputDir));
    assert.equal(both.connections.state, "invalid");
    assert.equal(both.connections.issue_code, "ambiguous_credentials");

    // The generated flag is exposed so the skill can scope intent-approval.
    fs.writeFileSync(connectionsPath, generated, "utf8");
    const regenerated = parseSuccess(runInspector(fixture.outputDir));
    assert.equal(regenerated.connections.generated, true);

    // A missing credential reports the canonical `token` field, and
    // `authenticator` is no longer a required field.
    fs.writeFileSync(
      connectionsPath,
      generated.replace(/^token = [^\n]*\n/m, ""),
      "utf8",
    );
    const missing = parseSuccess(runInspector(fixture.outputDir));
    assert.equal(missing.connections.state, "incomplete");
    assert.ok(missing.connections.missing_fields.includes("token"));
    assert.ok(!missing.connections.missing_fields.includes("authenticator"));
    fs.writeFileSync(connectionsPath, generated, "utf8");

    fs.writeFileSync(
      path.join(fixture.outputDir, "connections.toml"),
      '[default]\npassword = "MALFORMED_SECRET_NEVER_ECHO"\nbroken = [\n',
      "utf8",
    );
    const malformed = runInspector(fixture.outputDir);
    assert.equal(malformed.status, 0, malformed.stderr);
    assert.doesNotMatch(`${malformed.stdout}${malformed.stderr}`, /MALFORMED_SECRET_NEVER_ECHO/);
    const malformedPayload = JSON.parse(malformed.stdout);
    assert.equal(malformedPayload.connections.state, "invalid");
    assert.equal(malformedPayload.connections.issue_code, "parse_error");
    assert.equal(malformedPayload.overall_state, "ambiguous");

    fs.writeFileSync(
      path.join(fixture.outputDir, "connections.toml"),
      "# Portico imported this sensitive runtime file into secure storage.\n# scrubbed\n",
      "utf8",
    );
    const stub = parseSuccess(runInspector(fixture.outputDir));
    assert.equal(stub.connections.state, "secure_stub");
    assert.equal(stub.overall_state, "candidate_ready");
  } finally {
    fs.rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("snowflake inspector rejects unsafe files and preserves valid custom MCP config", () => {
  const fixture = createFixture();
  try {
    fs.mkdirSync(fixture.outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixture.outputDir, "mcp_config.yaml"),
      "other_services:\n  object_manager: false\nsql_statement_permissions:\n  - Select: true\n",
      "utf8",
    );
    let inspected = parseSuccess(runInspector(fixture.outputDir));
    assert.equal(inspected.mcp_config.state, "custom_valid");
    assert.equal(inspected.overall_state, "config_only");

    const outside = path.join(fixture.tmp, "outside-secret");
    fs.writeFileSync(outside, "SYMLINK_SECRET_NEVER_ECHO", "utf8");
    fs.symlinkSync(outside, path.join(fixture.outputDir, "connections.toml"));
    let unsafe = runInspector(fixture.outputDir);
    assert.equal(unsafe.status, 0, unsafe.stderr);
    assert.doesNotMatch(`${unsafe.stdout}${unsafe.stderr}`, /SYMLINK_SECRET_NEVER_ECHO/);
    assert.equal(JSON.parse(unsafe.stdout).connections.issue_code, "non_regular_file");

    fs.unlinkSync(path.join(fixture.outputDir, "connections.toml"));
    fs.writeFileSync(
      path.join(fixture.outputDir, "connections.toml"),
      Buffer.alloc(1024 * 1024 + 1, 65),
    );
    unsafe = parseSuccess(runInspector(fixture.outputDir));
    assert.equal(unsafe.connections.issue_code, "file_too_large");
  } finally {
    fs.rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("snowflake setup can render the Trust-Kit example", () => {
  const fixture = createFixture();
  try {
    const payload = parseSuccess(runSetup(fixture, "all", ["--mode", "trust-kit"]));
    assert.equal(payload.mode, "trust-kit");
    const config = yaml.load(
      fs.readFileSync(path.join(fixture.outputDir, "mcp_config.yaml"), "utf8"),
    );
    assert.equal(config.agent_services[0].service_name, "TRUST_KIT_AGENT");
    assert.equal(config.analyst_services[0].semantic_model, "TRUST_KIT");
    assert.equal(config.other_services.object_manager, true);
  } finally {
    fs.rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("snowflake setup can still render the read-only config on request", () => {
  const fixture = createFixture();
  try {
    const payload = parseSuccess(
      runSetup(fixture, "mcp-config", ["--mode", "read-only"]),
    );
    assert.equal(payload.mode, "read-only");
    const config = yaml.load(
      fs.readFileSync(path.join(fixture.outputDir, "mcp_config.yaml"), "utf8"),
    );
    assert.deepEqual(config.agent_services, []);
    assert.equal(config.other_services.object_manager, false);
  } finally {
    fs.rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test("snowflake integration guide launches the natural-language setup chat", () => {
  const guide = fs.readFileSync(
    path.join(REPO_ROOT, "mcp-configs/snowflake/snowflake.md"),
    "utf8",
  );
  assert.match(guide, /"Help me set up Snowflake"/);
  assert.match(
    guide,
    /<new-chat prompt="Help me set up Snowflake" label="Set up Snowflake in chat" \/>/,
  );
  assert.doesNotMatch(guide, /\$snowflake-setup/);
  assert.doesNotMatch(guide, /docs\.google\.com/);
  assert.match(guide, /secure runtime-secret path/);
});
