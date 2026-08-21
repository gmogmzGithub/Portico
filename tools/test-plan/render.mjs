#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { parseAllScenarios } from './lib/parse.mjs';
import { loadStatus } from './lib/store.mjs';
import { renderMarkdownFile } from './lib/render-file.mjs';
import { renderTopDashboard, renderTopCoverageMap } from './lib/render-dashboard.mjs';
import { TOP_README_PATH, TESTING_ROOT } from './lib/paths.mjs';

function parseArgs(argv) {
  const args = { check: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: render.mjs [--check] [--verbose]

Re-renders managed sections of the docs/testing/ tree from
docs/testing/status.json.

  --check     Do not write files. Exit 1 if any rendering would change a file.
  --verbose   Print the relative paths of every file that changes.

The renderer manages, per file:
  - <!-- @portico:test-status:begin id=X --> ... <!-- @portico:test-status:end -->
  - <!-- @portico:status-snapshot:begin --> ... <!-- @portico:status-snapshot:end -->
  - At-a-glance table Status / Last run columns (in-place row substitution)
  - <!-- @portico:status-dashboard:begin --> ... <!-- @portico:status-dashboard:end -->
  - <!-- @portico:coverage-map:begin --> ... <!-- @portico:coverage-map:end -->
`);
      process.exit(0);
    } else {
      console.error(`render: unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function relPath(absPath) {
  return path.relative(TESTING_ROOT, absPath).split(path.sep).join('/');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { all, byId, files } = parseAllScenarios();
  const status = loadStatus();

  const targetFiles = new Set(files);
  if (fs.existsSync(TOP_README_PATH)) targetFiles.add(TOP_README_PATH);

  const wouldChange = [];
  for (const file of files) {
    const result = renderMarkdownFile(file, byId, status);
    if (!result.changed) continue;
    wouldChange.push(file);
    if (!args.check) fs.writeFileSync(file, result.rendered);
  }

  // Render top-README managed blocks. Each renderer reads the current file
  // from disk so chaining writes is safe; in --check mode we never write,
  // so the second renderer would see the on-disk version (potentially
  // already-rendered). That is fine because we only need to know whether
  // anything would change overall, not which renderer caused it.
  let topReadmeChanged = false;
  const dashboard = renderTopDashboard(byId, status);
  if (dashboard.changed) {
    topReadmeChanged = true;
    if (!args.check) fs.writeFileSync(TOP_README_PATH, dashboard.rendered);
  }
  const coverage = renderTopCoverageMap(byId);
  if (coverage.changed) {
    topReadmeChanged = true;
    if (!args.check) fs.writeFileSync(TOP_README_PATH, coverage.rendered);
  }
  if (topReadmeChanged) wouldChange.push(TOP_README_PATH);

  if (args.verbose || args.check) {
    if (wouldChange.length === 0) {
      console.log(args.check ? 'render --check: clean (no changes needed).' : 'render: no changes.');
    } else {
      console.log(`${args.check ? 'Would change' : 'Updated'} ${wouldChange.length} file(s):`);
      for (const f of wouldChange) console.log(`  ${relPath(f)}`);
    }
  }

  if (args.check && wouldChange.length > 0) process.exit(1);
}

main();
