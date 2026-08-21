#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const Module = require("module");

function parseArgs(argv) {
  const result = {
    sinceHours: 48,
    reportingDir: path.resolve(process.cwd(), "open-webui-data", "reporting"),
    chatDbPath: path.resolve(process.cwd(), "open-webui-data", "webui.db"),
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--since-hours" && next) {
      result.sinceHours = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--reporting-dir" && next) {
      result.reportingDir = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--chat-db" && next) {
      result.chatDbPath = path.resolve(next);
      index += 1;
    }
  }

  return result;
}

function stubElectron() {
  const electronStub = {
    app: {
      getPath(name) {
        if (name === "userData") {
          return process.env.PORTICO_REPORTING_DIR;
        }
        return "";
      },
    },
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return electronStub;
    }
    return originalLoad.apply(this, arguments);
  };

  return () => {
    Module._load = originalLoad;
  };
}

async function main() {
  const options = parseArgs(process.argv);
  fs.mkdirSync(options.reportingDir, { recursive: true });

  process.env.PORTICO_REPORTING_DIR = options.reportingDir;

  const restoreElectron = stubElectron();
  try {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const costReporting = require(path.join(
      repoRoot,
      "electron-app",
      "src",
      "services",
      "cost-reporting.js",
    ));

    const backfill = await costReporting.backfillPromptCostsFromChatDb({
      force: true,
      sinceHours: options.sinceHours,
      chatDbPath: options.chatDbPath,
    });
    const dashboard = await costReporting.getDashboard({ range: "all" });

    const payload = {
      success: Boolean(backfill?.success && dashboard?.success),
      reportingDir: options.reportingDir,
      chatDbPath: options.chatDbPath,
      sinceHours: options.sinceHours,
      backfill,
      dashboardSummary: dashboard?.data?.overview?.allTime ?? null,
      generatedAt: dashboard?.data?.generatedAt ?? null,
    };

    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (!payload.success) {
      process.exitCode = 1;
    }
  } finally {
    restoreElectron();
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
