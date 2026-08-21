import path from 'node:path';

import { parseAllScenarios } from './parse.mjs';
import { REPO_ROOT, repoRelative } from './paths.mjs';

const TEST_TOKEN_HINT_RE = /\.(test\.(?:js|mjs|cjs|sh|ts)|test_[\w.-]+\.py|spec\.(?:js|mjs|ts))$|^test_[\w.-]+\.py$|^test-[\w.-]+\.sh$/i;

function looksLikeTestPath(token) {
  return /\.(?:test\.|spec\.)/.test(token) || /\/test_[\w.-]+\.py$/.test(token) || /^test_[\w.-]+\.py$/.test(token) || /^test-[\w.-]+\.sh$/.test(token) || /\/test-[\w.-]+\.sh$/.test(token) || TEST_TOKEN_HINT_RE.test(token);
}

function normalizeToken(token, cwd) {
  if (!token) return null;
  if (token.startsWith('-')) return null;
  let abs;
  if (path.isAbsolute(token)) {
    abs = token;
  } else {
    abs = path.resolve(cwd, token);
  }
  if (!abs.startsWith(REPO_ROOT)) return null;
  return repoRelative(abs);
}

export function matchScenariosFromArgs(args, cwd = process.cwd()) {
  const { all, byId } = parseAllScenarios();
  const matched = new Map();

  const tokens = [];
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    tokens.push(arg);
    if (arg.includes(' ')) {
      for (const part of arg.split(/\s+/)) tokens.push(part);
    }
  }

  for (const token of tokens) {
    if (!looksLikeTestPath(token)) continue;
    const normalized = normalizeToken(token, cwd);
    if (!normalized) continue;
    for (const scenario of all) {
      if (!scenario.testPathRepoRelative) continue;
      if (scenario.testPathRepoRelative === normalized) {
        matched.set(scenario.id, scenario);
        continue;
      }
      if (
        scenario.testPathRepoRelative.endsWith('/' + normalized) ||
        normalized.endsWith('/' + scenario.testPathRepoRelative)
      ) {
        matched.set(scenario.id, scenario);
      }
    }
  }

  return { matched: Array.from(matched.values()), byId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const { matched } = matchScenariosFromArgs(args);
  for (const s of matched) {
    process.stdout.write(`${s.id}\t${s.coverage}\t${s.testPathRepoRelative}\n`);
  }
}
