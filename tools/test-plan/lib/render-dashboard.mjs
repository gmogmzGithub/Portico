import fs from 'node:fs';

import { TOP_README_PATH } from './paths.mjs';
import { SECTION_NAMES, SECTION_ORDER } from './parse.mjs';

const MARKER_BEGIN = /^<!--\s*@portico:status-dashboard:begin\s*-->\s*$/;
const MARKER_END = /^<!--\s*@portico:status-dashboard:end\s*-->\s*$/;
const DASHBOARD_HEADING = /^##\s+Status dashboard/i;

const COVERAGE_MARKER_BEGIN = /^<!--\s*@portico:coverage-map:begin\s*-->\s*$/;
const COVERAGE_MARKER_END = /^<!--\s*@portico:coverage-map:end\s*-->\s*$/;
const COVERAGE_HEADING = /^##\s+Coverage map/i;

function pad(s, width, align = 'right') {
  const str = String(s);
  if (str.length >= width) return str;
  const fill = ' '.repeat(width - str.length);
  return align === 'right' ? fill + str : str + fill;
}

function buildDashboard(scenariosById, status) {
  const totals = { Total: 0, NotRun: 0, Pass: 0, Fail: 0, Skipped: 0, Blocked: 0, NotApplicable: 0 };
  const perSection = new Map();
  for (const letter of SECTION_ORDER) {
    perSection.set(letter, { Total: 0, NotRun: 0, Pass: 0, Fail: 0, Skipped: 0, Blocked: 0, NotApplicable: 0 });
  }
  for (const s of scenariosById.values()) {
    const sec = perSection.get(s.sectionLetter);
    if (!sec) continue;
    const entry = status.scenarios?.[s.id];
    const st = entry?.status ?? 'NotRun';
    sec.Total++;
    totals.Total++;
    if (sec[st] !== undefined) {
      sec[st]++;
      totals[st]++;
    } else {
      sec.NotRun++;
      totals.NotRun++;
    }
  }

  const rows = [];
  rows.push(
    '| Section                          | Total | NotRun | Pass | Fail | Skipped | Blocked | N/A |'
  );
  rows.push(
    '|----------------------------------|------:|-------:|-----:|-----:|--------:|--------:|----:|'
  );
  for (const letter of SECTION_ORDER) {
    const t = perSection.get(letter);
    if (!t || t.Total === 0) continue;
    const name = SECTION_NAMES[letter] ?? letter;
    rows.push(
      `| ${pad(name, 32, 'left')} | ${pad(t.Total, 5)} | ${pad(t.NotRun, 6)} | ${pad(t.Pass, 4)} | ${pad(t.Fail, 4)} | ${pad(t.Skipped, 7)} | ${pad(t.Blocked, 7)} | ${pad(t.NotApplicable, 3)} |`
    );
  }
  rows.push(
    `| **Total**                        | **${totals.Total}** | **${totals.NotRun}** | **${totals.Pass}** | **${totals.Fail}** | **${totals.Skipped}** | **${totals.Blocked}** | **${totals.NotApplicable}** |`
  );
  return rows;
}

export function renderTopDashboard(scenariosById, status) {
  if (!fs.existsSync(TOP_README_PATH)) {
    return { changed: false, original: '', rendered: '' };
  }
  const original = fs.readFileSync(TOP_README_PATH, 'utf8');
  const lines = original.split('\n');
  const dashboardLines = buildDashboard(scenariosById, status);
  const wrapped = ['<!-- @portico:status-dashboard:begin -->', ...dashboardLines, '<!-- @portico:status-dashboard:end -->'];

  // 1. Existing markers — replace between them
  for (let i = 0; i < lines.length; i++) {
    if (MARKER_BEGIN.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        if (MARKER_END.test(lines[j])) {
          const out = lines.slice();
          out.splice(i, j - i + 1, ...wrapped);
          const rendered = out.join('\n');
          return { changed: rendered !== original, original, rendered };
        }
      }
    }
  }

  // 2. No markers — find heading and the next table, wrap + replace.
  for (let i = 0; i < lines.length; i++) {
    if (!DASHBOARD_HEADING.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    // skip leading note lines until we hit a table row
    while (j < lines.length && !lines[j].startsWith('|') && !lines[j].startsWith('## ') && !lines[j].startsWith('# ')) {
      j++;
    }
    if (j >= lines.length || !lines[j].startsWith('|')) {
      return { changed: false, original, rendered: original };
    }
    const tableStart = j;
    while (j < lines.length && lines[j].startsWith('|')) j++;
    const tableEnd = j - 1;
    const out = lines.slice();
    out.splice(tableStart, tableEnd - tableStart + 1, ...wrapped);
    const rendered = out.join('\n');
    return { changed: rendered !== original, original, rendered };
  }

  return { changed: false, original, rendered: original };
}

function buildCoverageMap(scenariosById) {
  const totals = { Total: 0, Auto: 0, Partial: 0, Manual: 0, Unknown: 0 };
  const perSection = new Map();
  for (const letter of SECTION_ORDER) {
    perSection.set(letter, { Total: 0, Auto: 0, Partial: 0, Manual: 0, Unknown: 0 });
  }
  for (const s of scenariosById.values()) {
    const sec = perSection.get(s.sectionLetter);
    if (!sec) continue;
    sec.Total++;
    totals.Total++;
    const cov = s.coverage;
    if (cov === 'Auto' || cov === 'Partial' || cov === 'Manual') {
      sec[cov]++;
      totals[cov]++;
    } else {
      sec.Unknown++;
      totals.Unknown++;
    }
  }

  const pct = (n) => (totals.Total === 0 ? '0%' : `${Math.round((n / totals.Total) * 100)}%`);

  const rows = [];
  rows.push(
    '| Section                          | Total | Auto | Partial | Manual |'
  );
  rows.push(
    '|----------------------------------|------:|-----:|--------:|-------:|'
  );
  for (const letter of SECTION_ORDER) {
    const t = perSection.get(letter);
    if (!t || t.Total === 0) continue;
    const name = SECTION_NAMES[letter] ?? letter;
    rows.push(
      `| ${pad(name, 32, 'left')} | ${pad(t.Total, 5)} | ${pad(t.Auto, 4)} | ${pad(t.Partial, 7)} | ${pad(t.Manual, 6)} |`
    );
  }
  rows.push(
    `| **Total**                        | **${totals.Total}** | **${totals.Auto} (${pct(totals.Auto)})** | **${totals.Partial} (${pct(totals.Partial)})** | **${totals.Manual} (${pct(totals.Manual)})** |`
  );
  return rows;
}

export function renderTopCoverageMap(scenariosById) {
  if (!fs.existsSync(TOP_README_PATH)) {
    return { changed: false, original: '', rendered: '' };
  }
  const original = fs.readFileSync(TOP_README_PATH, 'utf8');
  const lines = original.split('\n');
  const coverageLines = buildCoverageMap(scenariosById);
  const wrapped = [
    '<!-- @portico:coverage-map:begin -->',
    ...coverageLines,
    '<!-- @portico:coverage-map:end -->',
  ];

  // 1. Existing markers — replace between them.
  for (let i = 0; i < lines.length; i++) {
    if (COVERAGE_MARKER_BEGIN.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        if (COVERAGE_MARKER_END.test(lines[j])) {
          const out = lines.slice();
          out.splice(i, j - i + 1, ...wrapped);
          const rendered = out.join('\n');
          return { changed: rendered !== original, original, rendered };
        }
      }
    }
  }

  // 2. No markers — find heading and the next table, wrap + replace.
  for (let i = 0; i < lines.length; i++) {
    if (!COVERAGE_HEADING.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    while (
      j < lines.length &&
      !lines[j].startsWith('|') &&
      !lines[j].startsWith('## ') &&
      !lines[j].startsWith('# ')
    ) {
      j++;
    }
    if (j >= lines.length || !lines[j].startsWith('|')) {
      return { changed: false, original, rendered: original };
    }
    const tableStart = j;
    while (j < lines.length && lines[j].startsWith('|')) j++;
    const tableEnd = j - 1;
    const out = lines.slice();
    out.splice(tableStart, tableEnd - tableStart + 1, ...wrapped);
    const rendered = out.join('\n');
    return { changed: rendered !== original, original, rendered };
  }

  return { changed: false, original, rendered: original };
}
