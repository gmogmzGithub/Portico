import fs from 'node:fs';
import path from 'node:path';

import { PLAN_ROOT, REPO_ROOT, repoRelative } from './paths.mjs';

const SECTION_LETTER_TO_NAME = {
  P0: '0. Pre-release smoke',
  A: 'A. Installation & clean state',
  B: 'B. Shell, windows & shortcuts',
  C: 'C. Themes & UI preferences',
  D: 'D. Chat UI & OWUI patches',
  E: 'E. Search & navigation',
  F: 'F. Detached windows & artifacts',
  G: 'G. MCP orchestration',
  H: 'H. Auth, OAuth & integrations',
  I: 'I. LLM routing',
  J: 'J. Agent skills & sub-agents',
  K: 'K. Update & distribution',
  L: 'L. Security hardening',
  M: 'M. Other UI & observability',
  N: 'N. Konami / hidden features',
  O: 'O. Performance & smoke',
};

const SECTION_FOLDER_TO_LETTER = {
  'pre-release-smoke': 'P0',
  installation: 'A',
  shell: 'B',
  themes: 'C',
  'chat-ui': 'D',
  search: 'E',
  'detached-windows': 'F',
  mcp: 'G',
  auth: 'H',
  llm: 'I',
  skills: 'J',
  updates: 'K',
  security: 'L',
  'misc-ui': 'M',
  konami: 'N',
  perf: 'O',
};

const SCENARIO_HEADING_RE = /^### ([A-Z0-9]+-\d+)\s+—\s+(.+?)\s*$/;
// Coverage line forms in the wild:
//   **Coverage:** Auto
//   **Coverage:** Auto — [`some-test.js`](path)
//   **Coverage:** Manual (N-008)
//   **Coverage:** Manual (regression #64 fork)
//   **Coverage:** Partial — script + manual cert verify
// We accept any trailing content after the coverage word; `coverageRest`
// captures only the em-dash-separated link payload (used by deriveTestPath).
const COVERAGE_RE = /^\*\*Coverage:\*\*\s+(Auto|Partial|Manual)(?:\s+—\s+(.*)|\s*\(.*\))?\s*$/;
const TYPE_RE = /^\*\*Type:\*\*\s+(.+?)\s*$/;
const LAST_EXEC_RE = /^\*\*Last execution:\*\*\s*$/;
const MARKER_BEGIN_RE = /^<!--\s*@portico:test-status:begin\s+id=([A-Z0-9]+-\d+)\s*-->\s*$/;
const MARKER_END = '<!-- @portico:test-status:end -->';
const MARKDOWN_LINK_RE = /\[(?:[^\]]*)\]\(([^)]+)\)/;

function listMarkdownFiles(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fp);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(fp);
      }
    }
  }
  return out.sort();
}

export function deriveSectionLetter(absFile) {
  const rel = path.relative(PLAN_ROOT, absFile).split(path.sep);
  if (rel.length === 0) return null;
  const folder = rel[0];
  return SECTION_FOLDER_TO_LETTER[folder] ?? null;
}

function deriveTestPath(coverageText) {
  if (!coverageText) return null;
  const m = coverageText.match(MARKDOWN_LINK_RE);
  if (!m) return null;
  let target = m[1].trim();
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1);
  }
  // Strip in-page anchors and surrounding backticks/quotes if any
  const hashIdx = target.indexOf('#');
  if (hashIdx !== -1) target = target.slice(0, hashIdx);
  return target;
}

function resolveTestPathRepoRelative(testPath, mdAbsPath) {
  if (!testPath) return null;
  if (/^[a-z]+:\/\//i.test(testPath)) return null; // external URL
  const absDir = path.dirname(mdAbsPath);
  const abs = path.resolve(absDir, testPath);
  if (!abs.startsWith(REPO_ROOT)) return null;
  return repoRelative(abs);
}

function findLastExecBlockRange(lines, scenarioStartIdx, scenarioEndIdx) {
  for (let i = scenarioStartIdx; i < scenarioEndIdx; i++) {
    const line = lines[i];
    const markerMatch = line.match(MARKER_BEGIN_RE);
    if (markerMatch) {
      for (let j = i + 1; j < scenarioEndIdx; j++) {
        if (lines[j].trim() === MARKER_END) {
          return { kind: 'marker', begin: i, end: j };
        }
      }
    }
    if (LAST_EXEC_RE.test(line)) {
      let endIdx = i + 1;
      while (endIdx < scenarioEndIdx && lines[endIdx].startsWith('- ')) {
        endIdx++;
      }
      return { kind: 'unmarked', begin: i, end: endIdx - 1 };
    }
  }
  return null;
}

export function parseScenarioFile(absFile) {
  const text = fs.readFileSync(absFile, 'utf8');
  const lines = text.split('\n');
  const scenarios = [];
  const sectionLetter = deriveSectionLetter(absFile);
  const fileRel = repoRelative(absFile);

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
    const title = m[2].trim();

    let coverage = null;
    let coverageRest = null;
    let type = null;
    for (let i = start + 1; i < end; i++) {
      const line = lines[i];
      if (!coverage) {
        const cm = line.match(COVERAGE_RE);
        if (cm) {
          coverage = cm[1];
          coverageRest = cm[2] ?? null;
          continue;
        }
      }
      if (!type) {
        const tm = line.match(TYPE_RE);
        if (tm) type = tm[1].trim();
      }
      if (coverage && type) break;
    }

    const testPath = deriveTestPath(coverageRest);
    const testPathRepoRelative = resolveTestPathRepoRelative(testPath, absFile);
    const lastExec = findLastExecBlockRange(lines, start, end);

    scenarios.push({
      id,
      title,
      sectionLetter,
      sectionName: sectionLetter ? SECTION_LETTER_TO_NAME[sectionLetter] ?? sectionLetter : null,
      coverage,
      type,
      testPath,
      testPathRepoRelative,
      file: fileRel,
      fileAbs: absFile,
      headingLine: start + 1,
      headingIdx: start,
      blockEndIdx: end - 1,
      lastExec,
    });
  }

  return scenarios;
}

export function parseAllScenarios() {
  const files = listMarkdownFiles(PLAN_ROOT);
  const all = [];
  const byId = new Map();
  for (const file of files) {
    const scenarios = parseScenarioFile(file);
    for (const s of scenarios) {
      if (byId.has(s.id)) {
        const prev = byId.get(s.id);
        throw new Error(
          `Duplicate scenario ID ${s.id} in ${s.file} (already seen in ${prev.file})`
        );
      }
      byId.set(s.id, s);
      all.push(s);
    }
  }
  return { all, byId, files };
}

export function summarize(all) {
  const bySection = new Map();
  for (const s of all) {
    const key = s.sectionLetter ?? '?';
    if (!bySection.has(key)) {
      bySection.set(key, { letter: key, name: s.sectionName ?? key, scenarios: [] });
    }
    bySection.get(key).scenarios.push(s);
  }
  return { totalCount: all.length, bySection };
}

export const SECTION_ORDER = [
  'P0',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
];

export const SECTION_NAMES = SECTION_LETTER_TO_NAME;
