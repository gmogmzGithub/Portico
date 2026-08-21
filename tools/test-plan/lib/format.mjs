import { defaultEntry, STATUS_VALUES } from './store.mjs';

export function formatLastRun(entry) {
  if (!entry || entry.status === 'NotRun') return '-';
  if (!entry.date || entry.date === '-') return '-';
  // Show YYYY-MM-DD for compactness
  const m = entry.date.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : entry.date;
}

export function formatStatus(entry) {
  if (!entry) return 'NotRun';
  return entry.status ?? 'NotRun';
}

export function statusBlockLines(scenarioId, entry) {
  const e = entry ?? defaultEntry();
  const safeStatus = STATUS_VALUES.includes(e.status) ? e.status : 'NotRun';
  return [
    `<!-- @portico:test-status:begin id=${scenarioId} -->`,
    '**Last execution:**',
    `- Status: \`${safeStatus}\``,
    `- Date: ${e.date && e.date !== '-' ? e.date : '-'}`,
    `- Build: ${e.build && e.build !== '-' ? e.build : '-'}`,
    `- Executor: ${e.executor && e.executor !== '-' ? e.executor : '-'}`,
    `- Notes: ${e.notes && e.notes !== '-' ? e.notes : '-'}`,
    '<!-- @portico:test-status:end -->',
  ];
}

export function tallySection(scenarios, status) {
  const tally = { Total: 0, NotRun: 0, Pass: 0, Fail: 0, Skipped: 0, Blocked: 0, NotApplicable: 0 };
  for (const s of scenarios) {
    tally.Total++;
    const entry = status.scenarios?.[s.id];
    const st = entry?.status ?? 'NotRun';
    if (tally[st] !== undefined) tally[st]++;
    else tally.NotRun++;
  }
  return tally;
}

export function renderSnapshotTable(tally) {
  return [
    '<!-- @portico:status-snapshot:begin -->',
    '| Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |',
    '|---:|---:|---:|---:|---:|---:|---:|',
    `| ${pad(tally.Total, 5)} | ${pad(tally.NotRun, 6)} | ${pad(tally.Pass, 4)} | ${pad(tally.Fail, 4)} | ${pad(tally.Skipped, 7)} | ${pad(tally.Blocked, 7)} | ${pad(tally.NotApplicable, 3)} |`,
    '<!-- @portico:status-snapshot:end -->',
  ];
}

function pad(value, width) {
  const s = String(value);
  if (s.length >= width) return s;
  return ' '.repeat(width - s.length) + s;
}
