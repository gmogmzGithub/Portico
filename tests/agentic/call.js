// One-shot MCP tool invocation through the harness broker, for driving the
// agentic test plan from a shell:
//
//   node tests/agentic/call.js <fixtureDir> <server> <tool> ['<json-args>']
//
// Prints the tool's parsed payload as pretty JSON on stdout. Exits 0 for any
// delivered tool response (including {success:false} domain failures, which
// are legitimate scenario outcomes) and 1 for transport/protocol errors.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const [fixtureDir, server, tool, argsJson] = process.argv.slice(2);
  if (!fixtureDir || !server || !tool) {
    console.error("usage: node call.js <fixtureDir> <server> <tool> ['<json-args>']");
    process.exit(1);
  }
  const endpoints = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, "endpoints.json"), "utf8"),
  );
  const response = await fetch(`${endpoints.broker}/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      server,
      tool,
      arguments: argsJson ? JSON.parse(argsJson) : {},
    }),
  });
  const outcome = await response.json();
  if (!outcome.ok) {
    console.error(JSON.stringify(outcome.error, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(outcome.payload, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
