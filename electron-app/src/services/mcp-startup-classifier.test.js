const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyStartupLogText } = require("./mcp-startup-classifier");
const { clampSinceSeconds } = require("./mcp-server-logs");

test("auth signatures win over config and crash markers", () => {
  const snowflakeCrash = [
    "Starting Snowflake MCP Server...",
    "ERROR Error starting MCP server: 250001 (08001): Failed to connect to DB:",
    "Programmatic access token is invalid.",
    "Traceback (most recent call last):",
    "[mcp_orc::app] native MCP startup failed for 'snowflake': failed to connect stdio server",
  ].join("\n");
  assert.equal(
    classifyStartupLogText(snowflakeCrash, { serverId: "snowflake" }),
    "auth",
  );
});

test("missing static secret broker material is classified without exposing secret identifiers", () => {
  const logs = [
    "Starting Snowflake MCP Server...",
    "FATAL: static secret broker denied snowflake/portico_runtime_file_snowflake_connections_toml_deadbeef with HTTP 404",
    "container exited with code 78",
  ].join("\n");

  assert.equal(
    classifyStartupLogText(logs, { serverId: "snowflake" }),
    "saved_secret_unavailable",
  );
});

test("config signatures classify parse failures", () => {
  assert.equal(
    classifyStartupLogText("yaml.parser.YAMLError: mapping values", {
      serverId: "x",
    }),
    "config",
  );
  assert.equal(
    classifyStartupLogText("tomllib.TOMLDecodeError: Invalid value", {
      serverId: "x",
    }),
    "config",
  );
});

test("crash-loop marker is scoped to the server's own id", () => {
  const otherServersFailure =
    "[mcp_orc::app] native MCP startup failed for 'other-server': failed to connect";
  assert.equal(
    classifyStartupLogText(otherServersFailure, { serverId: "snowflake" }),
    null,
  );
  assert.equal(
    classifyStartupLogText(otherServersFailure, { serverId: "other-server" }),
    "crash_loop",
  );
});

test("healthy or ambiguous logs return no verdict", () => {
  assert.equal(classifyStartupLogText("", { serverId: "x" }), null);
  assert.equal(classifyStartupLogText(null, { serverId: "x" }), null);
  assert.equal(
    classifyStartupLogText("INFO Uvicorn running on http://0.0.0.0:8000", {
      serverId: "x",
    }),
    null,
  );
});

test("regex-special server ids cannot break the crash pattern", () => {
  assert.equal(
    classifyStartupLogText("startup failed for 'a.b+c'", { serverId: "a.b+c" }),
    "crash_loop",
  );
  assert.equal(
    classifyStartupLogText("startup failed for 'aXbYc'", { serverId: "a.b+c" }),
    null,
  );
});

test("clampSinceSeconds bounds the docker logs window", () => {
  assert.equal(clampSinceSeconds(180), 180);
  assert.equal(clampSinceSeconds("240"), 240);
  assert.equal(clampSinceSeconds(0), null);
  assert.equal(clampSinceSeconds(-5), null);
  assert.equal(clampSinceSeconds(undefined), null);
  assert.equal(clampSinceSeconds(999999999), 24 * 60 * 60);
});
