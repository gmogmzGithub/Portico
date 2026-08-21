import fs from 'node:fs';

import { parseScenarioFile, deriveSectionLetter } from './parse.mjs';
import { statusBlockLines, renderSnapshotTable, tallySection, formatStatus, formatLastRun } from './format.mjs';

const SCENARIO_HEADING_RE = /^### ([A-Z0-9]+-\d+)\s+—\s+(.+?)\s*$/;
const STATUS_SNAPSHOT_HEADING_RE = /^##\s+Status snapshot\s*$/;
const AT_A_GLANCE_HEADING_RE = /^##\s+At-a-glance\s*$/;
const MARKER_BEGIN_PER = /^<!--\s*@portico:test-status:begin\s+id=([A-Z0-9]+-\d+)\s*-->\s*$/;
const MARKER_END_PER = /^<!--\s*@portico:test-status:end\s*-->\s*$/;
const MARKER_BEGIN_SNAPSHOT = /^<!--\s*@portico:status-snapshot:begin\s*-->\s*$/;
const MARKER_END_SNAPSHOT = /^<!--\s*@portico:status-snapshot:end\s*-->\s*$/;
const LAST_EXEC_HEADING = /^\*\*Last execution:\*\*\s*$/;

/**
 * Render the per-scenario "Last execution" block. Replaces the existing block
 * (whether already wrapped in markers or still in legacy plain form) with the
 * marker-bracketed canonical form derived from `entry`.
 */
function rewriteScenarioBlock(lines, scenarioStartIdx, scenarioEndIdx, scenarioId, entry) {
  // 1. Look for an existing marker pair.
  for (let i = scenarioStartIdx; i < scenarioEndIdx; i++) {
    const m = lines[i].match(MARKER_BEGIN_PER);
    if (m) {
      const id = m[1];
      if (id !== scenarioId) continue;
      for (let j = i + 1; j < scenarioEndIdx; j++) {
        if (MARKER_END_PER.test(lines[j])) {
          const rendered = statusBlockLines(scenarioId, entry);
          return { begin: i, end: j, replacement: rendered };
        }
      }
    }
  }
  // 2. Legacy unmarked form: "**Last execution:**" followed by 5 dash bullets.
  for (let i = scenarioStartIdx; i < scenarioEndIdx; i++) {
    if (LAST_EXEC_HEADING.test(lines[i])) {
      let endIdx = i + 1;
      while (endIdx < scenarioEndIdx && lines[endIdx].startsWith('- ')) {
        endIdx++;
      }
      const rendered = statusBlockLines(scenarioId, entry);
      return { begin: i, end: endIdx - 1, replacement: rendered };
    }
  }
  return null;
}

/**
 * Render the section "Status snapshot" table. Replaces between markers; if
 * markers aren't present yet, finds the first table after the
 * "## Status snapshot" heading and wraps + replaces it.
 */
function rewriteSnapshotTable(lines, tally) {
  // Try existing marker pair first
  for (let i = 0; i < lines.length; i++) {
    if (MARKER_BEGIN_SNAPSHOT.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        if (MARKER_END_SNAPSHOT.test(lines[j])) {
          const rendered = renderSnapshotTable(tally);
          return { begin: i, end: j, replacement: rendered };
        }
      }
    }
  }
  // Find "## Status snapshot" heading, then the next table
  for (let i = 0; i < lines.length; i++) {
    if (!STATUS_SNAPSHOT_HEADING_RE.test(lines[i])) continue;
    let j = i + 1;
    // Skip blanks
    while (j < lines.length && lines[j].trim() === '') j++;
    if (j >= lines.length || !lines[j].startsWith('|')) return null;
    const tableStart = j;
    while (j < lines.length && lines[j].startsWith('|')) j++;
    const tableEnd = j - 1;
    return { begin: tableStart, end: tableEnd, replacement: renderSnapshotTable(tally) };
  }
  return null;
}

/**
 * Update the Status / Last run columns of every row in the section
 * At-a-glance table. Leaves all other columns untouched. Detects column
 * positions from the header row.
 */
function rewriteAtAGlanceTable(lines, scenariosById, status) {
  let headingLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (AT_A_GLANCE_HEADING_RE.test(lines[i])) {
      headingLine = i;
      break;
    }
  }
  if (headingLine < 0) return [];

  let headerLine = -1;
  for (let i = headingLine + 1; i < lines.length; i++) {
    if (lines[i].startsWith('|')) {
      headerLine = i;
      break;
    }
    if (lines[i].startsWith('## ') || lines[i].startsWith('# ')) return [];
  }
  if (headerLine < 0) return [];

  const headerCells = parseTableRow(lines[headerLine]);
  if (!headerCells) return [];
  const statusIdx = headerCells.findIndex((c) => /^Status$/i.test(c.text.trim()));
  const lastRunIdx = headerCells.findIndex((c) => /^Last\s+run$/i.test(c.text.trim()));
  if (statusIdx < 0) return [];

  const edits = [];
  let i = headerLine + 1;
  // Skip alignment row
  if (i < lines.length && /^\s*\|\s*[-: ]+/.test(lines[i])) i++;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break;
    const cells = parseTableRow(line);
    if (!cells || cells.length === 0) break;
    const idCellRaw = cells[0]?.text?.trim();
    if (!idCellRaw) continue;
    const idMatch = idCellRaw.match(/^([A-Z0-9]+-\d+)/);
    if (!idMatch) continue;
    const id = idMatch[1];
    const scenario = scenariosById.get(id);
    if (!scenario) continue;
    const entry = status.scenarios?.[id];
    const newCells = cells.slice();
    if (statusIdx < newCells.length) {
      newCells[statusIdx] = padCell(formatStatus(entry), newCells[statusIdx]);
    }
    if (lastRunIdx >= 0 && lastRunIdx < newCells.length) {
      newCells[lastRunIdx] = padCell(formatLastRun(entry), newCells[lastRunIdx]);
    }
    const rebuilt = renderTableRow(newCells, line);
    if (rebuilt !== line) {
      edits.push({ index: i, replacement: rebuilt });
    }
  }
  return edits;
}

function parseTableRow(line) {
  if (!line.startsWith('|')) return null;
  const trimmed = line.replace(/^\|/, '').replace(/\|\s*$/, '');
  const parts = trimmed.split('|');
  return parts.map((p) => {
    const text = p.trim();
    const leading = p.match(/^\s*/)[0].length;
    const trailing = p.match(/\s*$/)[0].length;
    return { text, raw: p, leading, trailing };
  });
}

function padCell(newText, prevCell) {
  // Preserve the original cell width (leading + text + trailing).
  const totalWidth = prevCell.raw.length;
  if (newText.length >= totalWidth - 2) {
    return { text: newText, raw: ' ' + newText + ' ', leading: 1, trailing: 1 };
  }
  // Right-pad to keep table alignment.
  const padded = ' ' + newText + ' '.repeat(totalWidth - 1 - newText.length);
  return { text: newText, raw: padded, leading: 1, trailing: padded.length - 1 - newText.length };
}

function renderTableRow(cells, originalLine) {
  // Preserve leading "|" and trailing " |"
  const leadingPipe = originalLine.startsWith('| ') ? '|' : '|';
  return leadingPipe + cells.map((c) => c.raw).join('|') + '|';
}

export function renderMarkdownFile(absFile, scenariosById, status) {
  const original = fs.readFileSync(absFile, 'utf8');
  const lines = original.split('\n');
  const scenarios = parseScenarioFile(absFile);

  const replacements = [];

  // 1) Per-scenario blocks
  const headingIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (SCENARIO_HEADING_RE.test(lines[i])) headingIndices.push(i);
  }
  for (let h = 0; h < headingIndices.length; h++) {
    const start = headingIndices[h];
    const end = h + 1 < headingIndices.length ? headingIndices[h + 1] : lines.length;
    const m = lines[start].match(SCENARIO_HEADING_RE);
    if (!m) continue;
    const id = m[1];
    const scenario = scenariosById.get(id);
    if (!scenario) continue;
    const entry = status.scenarios?.[id];
    const edit = rewriteScenarioBlock(lines, start, end, id, entry);
    if (edit) replacements.push(edit);
  }

  // 2) Status snapshot table (only if section README — has snapshot heading)
  // Compute tally from scenarios that belong to *this section* (not just this file).
  const section = scenarios[0]?.sectionLetter ?? deriveSectionLetter(absFile);
  if (section) {
    const sectionScenarios = [];
    for (const s of scenariosById.values()) {
      if (s.sectionLetter === section) sectionScenarios.push(s);
    }
    const tally = tallySection(sectionScenarios, status);
    const snapshotEdit = rewriteSnapshotTable(lines, tally);
    if (snapshotEdit) replacements.push(snapshotEdit);
  }

  // 3) At-a-glance Status/Last run column updates
  const atAGlanceEdits = rewriteAtAGlanceTable(lines, scenariosById, status);

  if (replacements.length === 0 && atAGlanceEdits.length === 0) {
    return { changed: false, original, rendered: original };
  }

  // Apply edits from bottom to top so indices stay valid
  replacements.sort((a, b) => b.begin - a.begin);
  let out = lines.slice();
  for (const r of replacements) {
    out.splice(r.begin, r.end - r.begin + 1, ...r.replacement);
  }
  // At-a-glance edits are line-level (no insertions), can be applied anywhere.
  // Re-parse line indices in `out` is unnecessary because per-row edits don't
  // change line counts. But since `out` differs from `lines`, re-derive after.
  if (atAGlanceEdits.length > 0) {
    // Rebuild from the freshly modified `out` to avoid stale line numbers.
    const reLines = out.slice();
    const reEdits = rewriteAtAGlanceTable(reLines, scenariosById, status);
    for (const e of reEdits) {
      reLines[e.index] = e.replacement;
    }
    out = reLines;
  }

  const rendered = out.join('\n');
  return { changed: rendered !== original, original, rendered };
}
