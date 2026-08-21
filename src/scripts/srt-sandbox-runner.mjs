#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

function usage() {
  console.error(
    "Usage: srt-sandbox-runner.mjs --settings <path> --srt-cli-js <path> [--append-profile <path>] -- <command> [args...]",
  );
}

function parseArgs(argv) {
  const options = {
    appendProfiles: [],
    debug: false,
    command: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      options.command = argv.slice(index + 1);
      break;
    }
    if (arg === "--settings") {
      options.settings = argv[++index];
    } else if (arg === "--srt-cli-js") {
      options.srtCliJs = argv[++index];
    } else if (arg === "--append-profile") {
      options.appendProfiles.push(argv[++index]);
    } else if (arg === "--debug") {
      options.debug = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!options.settings || !options.srtCliJs || options.command.length === 0) {
    usage();
    process.exit(2);
  }
  return options;
}

function shellQuoteArg(value) {
  const raw = String(value);
  if (raw.length === 0) {
    return "''";
  }
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

function shellWords(input) {
  const words = [];
  let current = "";
  let state = "normal";
  let tokenStarted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (state === "single") {
      if (char === "'") {
        state = "normal";
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }
    if (state === "double") {
      if (char === '"') {
        state = "normal";
      } else if (char === "\\" && index + 1 < input.length) {
        current += input[++index];
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        words.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    if (char === "'") {
      state = "single";
      tokenStarted = true;
    } else if (char === '"') {
      state = "double";
      tokenStarted = true;
    } else if (char === "\\" && index + 1 < input.length) {
      current += input[++index];
      tokenStarted = true;
    } else {
      current += char;
      tokenStarted = true;
    }
  }

  if (state !== "normal") {
    throw new Error("failed to parse SRT command: unterminated shell quote");
  }
  if (tokenStarted) {
    words.push(current);
  }
  return words;
}

function loadProfileAppend(paths) {
  return paths
    .map((profilePath) => fs.readFileSync(profilePath, "utf8").trim())
    .filter((content) => content.length > 0)
    .join("\n");
}

function packageRootFromCli(cliPath) {
  const resolved = path.resolve(cliPath);
  if (path.basename(resolved) !== "cli.js") {
    throw new Error(`SRT CLI path must point at dist/cli.js: ${resolved}`);
  }
  return path.dirname(path.dirname(resolved));
}

function applyProfileAppend(words, profileAppend) {
  if (!profileAppend || process.platform !== "darwin") {
    return words;
  }
  const sandboxExecIndex = words.indexOf("/usr/bin/sandbox-exec");
  if (sandboxExecIndex < 0) {
    throw new Error("SRT command did not contain /usr/bin/sandbox-exec");
  }
  const profileFlagIndex = words.indexOf("-p", sandboxExecIndex);
  if (profileFlagIndex < 0 || profileFlagIndex + 1 >= words.length) {
    throw new Error("SRT command did not contain an inline Seatbelt profile");
  }
  const nextWords = words.slice();
  nextWords[profileFlagIndex + 1] = `${nextWords[profileFlagIndex + 1]}\n\n; Portico hardening additions\n${profileAppend}\n`;
  return nextWords;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.debug) {
    process.env.SRT_DEBUG = "true";
  }

  const srtRoot = packageRootFromCli(options.srtCliJs);
  const { SandboxManager } = await import(
    pathToFileURL(path.join(srtRoot, "dist", "index.js")).href
  );
  const runtimeConfig = JSON.parse(fs.readFileSync(options.settings, "utf8"));
  await SandboxManager.initialize(runtimeConfig);

  const commandString = options.command.map(shellQuoteArg).join(" ");
  const wrappedCommand = await SandboxManager.wrapWithSandbox(commandString);
  const profileAppend = loadProfileAppend(options.appendProfiles);
  const words = applyProfileAppend(shellWords(wrappedCommand), profileAppend);

  const child = spawn(words[0], words.slice(1), {
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    SandboxManager.cleanupAfterCommand();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
  child.on("error", (error) => {
    console.error(`Failed to execute sandboxed command: ${error.message}`);
    process.exit(1);
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
