#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseAllScenarios } from './lib/parse.mjs';
import { REPO_ROOT } from './lib/paths.mjs';

function usage() {
  console.log(`Usage: run-auto.mjs [--filter <regex>] [--dry-run] [--stop-on-fail]

Walks every scenario with Coverage: Auto and a runnable testPath, dispatches
each one through tools/test-plan/run-and-record.sh, and prints a summary.

Options:
  --filter <regex>   Only run scenarios whose ID matches the regex (e.g. '^B-').
  --dry-run          List the planned commands; do not execute or record.
  --stop-on-fail     Halt on the first failing test (default: keep going).
  -h, --help         Show this help.

Each test file is run once even if multiple scenarios cite it; the wrapper
records all matched scenarios from a single execution.
`);
}

function parseArgs(argv) {
  const args = { filter: null, dryRun: false, stopOnFail: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--filter':
        args.filter = new RegExp(argv[++i]);
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--stop-on-fail':
        args.stopOnFail = true;
        break;
      case '-h':
      case '--help':
        usage();
        process.exit(0);
      default:
        console.error(`run-auto: unknown argument: ${a}`);
        usage();
        process.exit(2);
    }
  }
  return args;
}

function resolveUv() {
  if (process.env.portico_UV) return process.env.portico_UV;
  for (const candidate of [`${process.env.HOME}/.local/bin/uv`, '/opt/homebrew/bin/uv', '/usr/local/bin/uv']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolvePython() {
  if (process.env.portico_PYTHON) return process.env.portico_PYTHON;
  for (const candidate of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'python3';
}

function pytestCommand(testPath) {
  // Match the convention used by run-tests.sh: prefer `uv run` with the
  // project's slim requirements; fall back to plain `python3 -m pytest` if
  // uv is not installed.
  const reqs = path.join(REPO_ROOT, 'requirements-open-webui-slim.txt');
  const uv = resolveUv();
  if (uv && fs.existsSync(reqs)) {
    return [
      uv,
      'run',
      '--python',
      resolvePython(),
      '--with',
      'pytest',
      '--with',
      'pytest-asyncio',
      '--with',
      'docker',
      '--with',
      'pypdf',
      '--with-requirements',
      reqs,
      'python',
      '-m',
      'pytest',
      '--rootdir',
      REPO_ROOT,
      testPath,
    ];
  }
  return [resolvePython(), '-m', 'pytest', testPath];
}

function commandForTestPath(testPath) {
  if (!testPath) return null;
  const abs = path.join(REPO_ROOT, testPath);
  if (!fs.existsSync(abs)) return { skipReason: `file not found: ${testPath}` };

  if (testPath.endsWith('.test.js') || testPath.endsWith('.test.mjs') || testPath.endsWith('.test.cjs')) {
    return { kind: 'node-test', argv: [process.execPath, '--test', testPath] };
  }
  if (testPath.endsWith('.unit.test.js')) {
    return { kind: 'node-test', argv: [process.execPath, '--test', testPath] };
  }
  if (testPath.endsWith('.test.sh') || /\/test_[\w.-]+\.sh$/.test(testPath) || /\/test-[\w.-]+\.sh$/.test(testPath)) {
    return { kind: 'shell-test', argv: ['bash', testPath] };
  }
  if (/\/test_[\w.-]+\.py$/.test(testPath)) {
    return { kind: 'pytest', argv: pytestCommand(testPath) };
  }
  return { skipReason: `unsupported test extension: ${testPath}` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { all } = parseAllScenarios();

  const planned = [];
  const byPath = new Map();
  for (const s of all) {
    if (s.coverage !== 'Auto') continue;
    if (!s.testPathRepoRelative) continue;
    if (args.filter && !args.filter.test(s.id)) continue;
    const existing = byPath.get(s.testPathRepoRelative);
    if (existing) {
      existing.extraIds.push(s.id);
      continue;
    }
    const entry = {
      primaryId: s.id,
      extraIds: [],
      testPath: s.testPathRepoRelative,
      command: commandForTestPath(s.testPathRepoRelative),
    };
    byPath.set(s.testPathRepoRelative, entry);
    planned.push(entry);
  }

  if (planned.length === 0) {
    console.log('run-auto: no Auto scenarios match the filter.');
    return;
  }

  console.log(`run-auto: ${planned.length} test file(s) to execute (covering ${planned.reduce((n, p) => n + 1 + p.extraIds.length, 0)} scenarios).\n`);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const wrapper = path.join(here, 'run-and-record.sh');
  const summary = { ran: 0, passed: 0, failed: 0, skipped: 0, skippedReasons: [] };

  for (const item of planned) {
    const idsLabel = [item.primaryId, ...item.extraIds].join(', ');
    if (item.command?.skipReason) {
      console.log(`SKIP  [${idsLabel}]  ${item.command.skipReason}`);
      summary.skipped++;
      summary.skippedReasons.push({ ids: idsLabel, reason: item.command.skipReason });
      continue;
    }
    const cmdStr = item.command.argv.join(' ');
    console.log(`RUN   [${idsLabel}]  ${cmdStr}`);
    if (args.dryRun) continue;

    const env = { ...process.env, NODE_BIN: process.execPath };
    if (item.command.kind === 'pytest') {
      const extraPaths = [
        path.join(REPO_ROOT, 'src/patches/backend'),
        path.join(REPO_ROOT, 'llm-debug-monitor'),
      ];
      const existing = env.PYTHONPATH ? [env.PYTHONPATH] : [];
      env.PYTHONPATH = [...extraPaths, ...existing].join(':');
    }
    const result = spawnSync(wrapper, item.command.argv, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      env,
    });
    summary.ran++;
    const isPytestNoCollect = result.status === 5 && item.command.kind === 'pytest';
    if (result.status === 0) summary.passed++;
    else if (isPytestNoCollect) summary.skipped++;
    else {
      summary.failed++;
      if (args.stopOnFail) {
        console.error(`run-auto: --stop-on-fail set; halting after [${idsLabel}].`);
        break;
      }
    }
  }

  console.log('\n--- run-auto summary ---');
  console.log(`  Planned: ${planned.length}`);
  console.log(`  Ran:     ${summary.ran}`);
  console.log(`  Passed:  ${summary.passed}`);
  console.log(`  Failed:  ${summary.failed}`);
  console.log(`  Skipped: ${summary.skipped}`);
  if (summary.skipped > 0) {
    for (const s of summary.skippedReasons.slice(0, 10)) {
      console.log(`    - [${s.ids}] ${s.reason}`);
    }
    if (summary.skippedReasons.length > 10) {
      console.log(`    ... and ${summary.skippedReasons.length - 10} more.`);
    }
  }

  process.exit(summary.failed > 0 ? 1 : 0);
}

main();
