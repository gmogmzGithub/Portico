import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const TESTING_ROOT = path.join(REPO_ROOT, 'docs', 'testing');
export const PLAN_ROOT = path.join(TESTING_ROOT, 'plan');
export const STATUS_PATH = path.join(TESTING_ROOT, 'status.json');
export const TEMPLATE_PATH = path.join(TESTING_ROOT, 'templates', 'scenario.md');
export const TOP_README_PATH = path.join(TESTING_ROOT, 'README.md');
export const RUNS_DIR = path.join(TESTING_ROOT, 'runs');
export const LOCK_PATH = path.join(TESTING_ROOT, '.status.lock');

export function repoRelative(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}
