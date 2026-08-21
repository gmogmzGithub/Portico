import { execFileSync } from 'node:child_process';
import os from 'node:os';

import { REPO_ROOT } from './paths.mjs';

function tryGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

export function detectBuild() {
  if (process.env.portico_RELEASE_TAG) {
    const channel = process.env.UPDATE_CHANNEL ?? process.env.portico_RELEASE_CHANNEL;
    return channel ? `${process.env.portico_RELEASE_TAG} (${channel})` : process.env.portico_RELEASE_TAG;
  }
  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown';
  const sha = tryGit(['rev-parse', '--short', 'HEAD']) ?? 'unknown';
  const dirty = tryGit(['status', '--porcelain']);
  const dirtySuffix = dirty && dirty.length > 0 ? '-dirty' : '';
  return `${branch} @ ${sha}${dirtySuffix}`;
}

export function detectExecutor() {
  if (process.env.portico_EXECUTOR) return process.env.portico_EXECUTOR;
  if (process.env.portico_AGENT === '1') return 'agent';
  if (process.env.CI === 'true' || process.env.CI === '1') return 'ci';
  const user = process.env.USER ?? process.env.USERNAME ?? os.userInfo().username ?? 'unknown';
  return user;
}

export function nowIso() {
  return new Date().toISOString();
}
