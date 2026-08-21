#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAllScenarios } from './lib/parse.mjs';
import { loadStatus, saveStatus, recordScenario, STATUS_VALUES } from './lib/store.mjs';
import { detectBuild, detectExecutor, nowIso } from './lib/git.mjs';

function usage() {
  console.log(`Usage: record.mjs --id <ID> --status <STATUS> [options]

Records the result of a single scenario execution into docs/testing/status.json
and (by default) re-renders the markdown tree.

Required:
  --id <ID>           Scenario ID (e.g. P0-01, B-15, L-04).
  --status <STATUS>   One of: ${STATUS_VALUES.join(', ')}.

Optional:
  --notes <text>      Free-form notes (default: "-").
  --build <text>      Override build label (default: auto-detected from git).
  --executor <text>   Override executor (default: \$USER, "ci", or "agent").
  --date <iso>        Override ISO timestamp (default: now).
  --no-render         Skip running render.mjs after the upsert.
  --batch <file.json> Upsert many scenarios from a JSON file shaped like
                      { "scenarios": { "B-15": { "status": "Pass", ... } } }.
  -h, --help          Show this help.
`);
}

function parseArgs(argv) {
  const args = { render: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--id':
        args.id = next();
        break;
      case '--status':
        args.status = next();
        break;
      case '--notes':
        args.notes = next();
        break;
      case '--build':
        args.build = next();
        break;
      case '--executor':
        args.executor = next();
        break;
      case '--date':
        args.date = next();
        break;
      case '--no-render':
        args.render = false;
        break;
      case '--batch':
        args.batch = next();
        break;
      case '-h':
      case '--help':
        usage();
        process.exit(0);
      default:
        console.error(`record: unknown argument: ${a}`);
        usage();
        process.exit(2);
    }
  }
  return args;
}

function runRender() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const result = spawnSync(process.execPath, [path.join(here, 'render.mjs')], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) {
    console.error('record: render.mjs exited non-zero');
    process.exit(result.status ?? 1);
  }
}

function applyEntry(status, byId, id, partial) {
  if (!byId.has(id)) {
    console.error(`record: unknown scenario ID '${id}'. (Not found in docs/testing/plan/.)`);
    process.exit(1);
  }
  const entry = {
    status: partial.status,
    date: partial.date ?? nowIso(),
    build: partial.build ?? detectBuild(),
    executor: partial.executor ?? detectExecutor(),
    notes: partial.notes ?? '-',
  };
  return recordScenario(status, id, entry);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { byId } = parseAllScenarios();
  const status = loadStatus();

  if (args.batch) {
    const raw = fs.readFileSync(args.batch, 'utf8');
    const parsed = JSON.parse(raw);
    const scenarios = parsed.scenarios ?? parsed;
    let count = 0;
    for (const [id, partial] of Object.entries(scenarios)) {
      applyEntry(status, byId, id, partial);
      count++;
    }
    saveStatus(status);
    console.log(`record: upserted ${count} scenario(s) from ${args.batch}.`);
  } else {
    if (!args.id || !args.status) {
      console.error('record: --id and --status are required (or use --batch <file>).');
      usage();
      process.exit(2);
    }
    applyEntry(status, byId, args.id, {
      status: args.status,
      notes: args.notes,
      build: args.build,
      executor: args.executor,
      date: args.date,
    });
    saveStatus(status);
    console.log(`record: ${args.id} -> ${args.status}`);
  }

  if (args.render) runRender();
}

main();
