#!/usr/bin/env node
"use strict";

const path = require("path");

function parseArgs(argv) {
  const args = {
    projectRoot: "",
    snapshotPath: "",
    reason: "script",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project-root") {
      args.projectRoot = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--snapshot") {
      args.snapshotPath = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--reason") {
      args.reason = argv[index + 1] || "script";
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot =
    args.projectRoot ||
    path.resolve(__dirname, "..", "..");
  const togglesPath = path.join(projectRoot, "mcp_toggles.json");
  const snapshotPath =
    args.snapshotPath ||
    path.join(projectRoot, "health-status", "mcp_toggles_snapshot.json");

  const {
    normalizeMcpToggleSourceAtPath,
  } = require(path.join(
    projectRoot,
    "electron-app",
    "src",
    "services",
    "mcp-toggle-store.js",
  ));

  const result = normalizeMcpToggleSourceAtPath(togglesPath, {
    reason: args.reason,
    snapshotPath,
    logger: console,
  });
  console.log(
    JSON.stringify({
      togglesPath: result.togglesPath,
      snapshotPath: result.snapshotPath,
      revision: result.revision,
      repaired: result.repaired,
      repairReason: result.repairReason,
      backupPath: result.backupPath || null,
      toggleCount: Object.keys(result.toggles || {}).length,
    }),
  );
}

try {
  main();
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
