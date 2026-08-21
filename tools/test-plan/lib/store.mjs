import fs from 'node:fs';
import path from 'node:path';

import { STATUS_PATH } from './paths.mjs';

export const STATUS_VALUES = ['NotRun', 'Pass', 'Fail', 'Skipped', 'Blocked', 'NotApplicable'];

const EMPTY = () => ({ version: 1, updated_at: null, scenarios: {} });

export function loadStatus() {
  if (!fs.existsSync(STATUS_PATH)) return EMPTY();
  const raw = fs.readFileSync(STATUS_PATH, 'utf8').trim();
  if (!raw) return EMPTY();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${STATUS_PATH}: ${err.message}`);
  }
  if (parsed.version !== 1) {
    throw new Error(`Unsupported status.json version: ${parsed.version} (expected 1)`);
  }
  if (!parsed.scenarios || typeof parsed.scenarios !== 'object') {
    throw new Error(`status.json missing 'scenarios' object`);
  }
  return parsed;
}

export function saveStatus(status) {
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
  const out = {
    version: 1,
    updated_at: new Date().toISOString(),
    scenarios: status.scenarios ?? {},
  };
  const sortedScenarios = {};
  for (const id of Object.keys(out.scenarios).sort()) {
    sortedScenarios[id] = out.scenarios[id];
  }
  out.scenarios = sortedScenarios;
  const tmp = STATUS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, STATUS_PATH);
  return out;
}

export function recordScenario(status, id, entry) {
  if (!STATUS_VALUES.includes(entry.status)) {
    throw new Error(
      `Invalid status '${entry.status}' for ${id}. Must be one of: ${STATUS_VALUES.join(', ')}`
    );
  }
  const cleanEntry = {
    status: entry.status,
    date: entry.date ?? new Date().toISOString(),
    build: entry.build ?? '-',
    executor: entry.executor ?? '-',
    notes: entry.notes ?? '-',
  };
  status.scenarios = status.scenarios ?? {};
  status.scenarios[id] = cleanEntry;
  return cleanEntry;
}

export function defaultEntry() {
  return {
    status: 'NotRun',
    date: '-',
    build: '-',
    executor: '-',
    notes: '-',
  };
}
