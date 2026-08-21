const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SKILL_PATH = path.join(ROOT, "skills", "snowflake-setup", "SKILL.md");
const SCRIPT_PATH = path.join(
  ROOT,
  "skills",
  "snowflake-setup",
  "scripts",
  "snowflake_setup.py",
);

test("snowflake setup skill instructs single-role PAT generation", () => {
  const content = fs.readFileSync(SKILL_PATH, "utf8");

  assert.match(
    content,
    /choose \*\*Single role \(recommended\)\*\* and keep \*\*PUBLIC \(default role\)\*\* selected/,
  );
  assert.doesNotMatch(content, /choose \*\*All of my roles\*\* \(not Single role\)/);
  // The password-path/network-policy theory is dead: the preamble carries no
  // policy caveats, and the superseded combined-dialog screenshot is gone.
  assert.doesNotMatch(content, /network policy/);
  assert.doesNotMatch(content, /the screenshot may show the older All of my roles choice/);
  // Role capture: non-default single roles are collected in chat and must
  // match the token's restriction.
  assert.match(content, /pass a non-default role as `--role <ROLE>`/);
  assert.match(content, /must match the token's role restriction/);
});

test("snowflake setup skill validates before enabling", () => {
  const content = fs.readFileSync(SKILL_PATH, "utf8");

  assert.match(content, /## Connection Validation/);
  assert.match(
    content,
    /run `scripts\/snowflake_setup\.py` with `--operation validate --output-dir \/work` BEFORE `mcp_assistant_toggle_integration`/,
  );
  // Scope carve-out: stub-backed candidate_ready re-enables must NOT be sent
  // to re-mint a token just to satisfy validation.
  assert.match(
    content,
    /Validation applies only when this session wrote or rotated the connection file/,
  );
  assert.match(content, /skip validation and enable directly/);
  assert.match(
    content,
    /collecting a new PAT just to make validation possible is never acceptable/,
  );
  assert.match(content, /error_code: "auth_rejected"/);
  assert.match(content, /error_code: "network_unreachable"` or `"snowflake_unavailable"/);
  assert.match(content, /error_code: "validation_unexpected_response"/);
  // auth_rejected leads with the real causes and caps the re-mint loop.
  assert.match(content, /the token was mis-pasted, expired, or revoked/);
  assert.match(
    content,
    /role restriction does not match the `role` in the connection file/,
  );
  assert.match(
    content,
    /If a second freshly minted token is also rejected, stop collecting tokens/,
  );
  assert.match(content, /do not keep asking the user questions or minting tokens/);
  assert.match(content, /restart the Secure PAT flow and validate again/);
  // The legacy broken shape routes to enable-time auto-migration — never to
  // a new token, and never to rotate (which would demand a token file).
  assert.match(content, /error_code: "legacy_pat_credential"/);
  assert.match(
    content,
    /Do not collect a new token and do not rotate: enable the integration/,
  );
  // Hand-written files keep a human in the loop before any replacement.
  assert.match(content, /`connections.generated: true`/);
  assert.match(
    content,
    /ask one plain-language question before replacing it, no matter how clear the request/,
  );
  assert.match(content, /pat_credential_key_mismatch/);
  assert.match(
    content,
    /whenever this session wrote or rotated the connection file — Connection Validation succeeded/,
  );
  // Validation must stay behind the ordering: the section sits before
  // "Activation and Failures".
  assert.ok(
    content.indexOf("## Connection Validation") <
      content.indexOf("## Activation and Failures"),
  );
  // Operations list documents the new op without requesting a PAT for it.
  assert.match(content, /- `validate`: no extra arguments; do not request a PAT\./);
});

test("snowflake setup skill routes secure stubs away from rotate-token", () => {
  const content = fs.readFileSync(SKILL_PATH, "utf8");

  assert.match(
    content,
    /use `--operation rotate-token` only when `connections\.state` is `complete`/,
  );
  assert.match(
    content,
    /when it is `secure_stub` or `connections\.toml` is otherwise unusable, collect the PAT and LDAP username and use `--operation connections --replace-existing`/,
  );
  assert.match(
    content,
    /keeps serving the previously imported secret bytes, so keeping the stub leaves the old token in effect/,
  );
  assert.match(
    content,
    /It fails with `connections_file_stub` when `connections\.toml` is a secure stub/,
  );
});

test("snowflake setup skill repairs unavailable saved secrets without generic guided setup", () => {
  const content = fs.readFileSync(SKILL_PATH, "utf8");

  assert.match(content, /errorCode: "SAVED_SECRET_UNAVAILABLE"/);
  assert.match(content, /configurationIssue: "saved_secret_unavailable"/);
  assert.match(
    content,
    /do not retry the toggle and do not open generic guided setup/,
  );
  assert.match(
    content,
    /collect a fresh PAT plus the LDAP username, run `--operation connections --replace-existing`, validate the newly written connection, and then enable exactly once more/,
  );
  assert.match(
    content,
    /Never call `mcp_assistant_trigger_guided_setup` from this skill/,
  );
});

test("snowflake setup skill keeps the secret boundary intact", () => {
  const content = fs.readFileSync(SKILL_PATH, "utf8");

  // Verbatim boundary sentences from v2.0 — round-7 edits must not weaken them.
  assert.match(
    content,
    /`scripts\/snowflake_inspect\.py` is the only permitted way to inspect `\/work\/connections\.toml` or `\/work\/mcp_config\.yaml`\./,
  );
  assert.match(
    content,
    /Never request, print, echo, summarize, or return any value from an existing connection file\./,
  );
  assert.match(
    content,
    /Never ask for a PAT, API key, password, or client secret in chat\./,
  );
  assert.match(
    content,
    /pass only its temporary file path to `scripts\/snowflake_setup\.py`, and never read that file\./,
  );
  // The validation section must promise value-free output.
  assert.match(
    content,
    /it never prints the token or any connection-file value/,
  );
});

test("snowflake setup script pins the validate security invariants", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");

  assert.match(source, /"all", "connections", "mcp-config", "rotate-token", "validate"/);
  // Host derives only from the account field; no override surface.
  assert.match(source, /ACCOUNT_HOST_PATTERN = re\.compile\(r"\^\[A-Za-z0-9_-\]\{1,120\}\$"\)/);
  assert.match(source, /snowflakecomputing\.com\/session\/v1\/login-request/);
  for (const forbidden of ["--url", "--host", "--endpoint", "--base-url"]) {
    assert.ok(
      !source.includes(forbidden),
      `${forbidden} would allow redirecting the PAT off-Snowflake`,
    );
  }
  // Success bodies carry a session token and must never be echoed.
  assert.match(source, /Never echo the body/);
  // Untrusted response fields are sanitized: code constrained to a short
  // charset, message stripped of C0/C1/bidi controls and capped.
  assert.match(source, /SERVER_CODE_PATTERN = re\.compile\(r"\^\[0-9A-Za-z_.-\]\{1,32\}\$"\)/);
  assert.match(source, /\\u202a-\\u202e/);
  // Only PAT-shaped connections may be probed — never transmit a possible
  // real corporate password behind another authenticator.
  assert.match(
    source,
    /authenticator is not None\n\s+and str\(authenticator\)\.strip\(\)\.upper\(\) != "PROGRAMMATIC_ACCESS_TOKEN"\n\s+\):\n\s+raise SetupError\("connections_file_invalid"\)/,
  );
  // The probe mirrors the connector: TOKEN field under the PAT authenticator,
  // PASSWORD only for bare password files, never both.
  assert.match(source, /"AUTHENTICATOR": "PROGRAMMATIC_ACCESS_TOKEN",\n\s+"TOKEN": credential,/);
  assert.match(source, /credential_fields = \{"PASSWORD": credential\}/);
  assert.match(source, /raise SetupError\("legacy_pat_credential"\)/);
  // Transient Snowflake outages are not token verdicts.
  assert.match(source, /error\.code == 429 or error\.code >= 500:\n            raise SetupError\("snowflake_unavailable"\)/);
  // rotate-token refuses secure stubs with the dedicated code.
  assert.match(source, /raise SetupError\("connections_file_stub"\)/);
  assert.match(
    source,
    /# Portico imported this sensitive runtime file into secure storage\./,
  );
});
