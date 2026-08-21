/**
 * PORTICO PATCH: Host-side bridge for the in-page local-find controller.
 *
 * - Reads the in-page IIFE source from `owui-local-find-page.js` once at module
 *   load (cached) and exposes it via `getControllerSource()` for callers that
 *   inject it into a WebContentsView with executeJavaScript().
 * - Exports pure helpers (escapeRegex, buildRegex, computeNextOrdinal,
 *   normalizeOptions) that mirror the in-page behavior so unit tests can run
 *   in plain Node without DOM.
 *
 * The in-page file is NEVER `require`d here — it depends on browser globals
 * (CSS, Highlight, MutationObserver) and would throw under Node.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
const PAGE_SOURCE_FILE = path.join(__dirname, 'owui-local-find-page.js');

let cachedPageSource = null;

function escapeRegex(input) {
  if (input == null) return '';
  return String(input).replace(REGEX_META, '\\$&');
}

/**
 * @param {string} query
 * @param {{caseSensitive?: boolean, regex?: boolean}} [options]
 * @returns {{ regex: RegExp | null, error: string | null }}
 */
function buildRegex(query, options = {}) {
  const text = typeof query === 'string' ? query : '';
  if (!text) return { regex: null, error: null };
  const flags = options.caseSensitive ? 'g' : 'gi';
  if (options.regex) {
    try {
      return { regex: new RegExp(text, flags), error: null };
    } catch (error) {
      return { regex: null, error: String(error?.message || error) };
    }
  }
  return { regex: new RegExp(escapeRegex(text), flags), error: null };
}

/**
 * @param {number} current 1-based ordinal, 0 if none
 * @param {number} total
 * @param {boolean} forward
 * @returns {number}
 */
function computeNextOrdinal(current, total, forward) {
  const t = Math.max(0, Math.floor(Number(total) || 0));
  if (t === 0) return 0;
  const c = Math.max(0, Math.floor(Number(current) || 0));
  if (c === 0) return forward ? 1 : t;
  if (forward) return c >= t ? 1 : c + 1;
  return c <= 1 ? t : c - 1;
}

/**
 * @param {*} options
 */
function normalizeOptions(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  return {
    matchCase: opts.matchCase === true,
    findNext: opts.findNext === true,
    forward: opts.forward !== false,
    regex: opts.regex === true,
  };
}

/**
 * Returns the in-page IIFE source. The file is read from disk once; callers
 * are expected to forward it directly to webContents.executeJavaScript().
 */
function getControllerSource() {
  if (cachedPageSource == null) {
    cachedPageSource = fs.readFileSync(PAGE_SOURCE_FILE, 'utf8');
  }
  return cachedPageSource;
}

/**
 * Build the full executeJavaScript payload that:
 *   1. Installs the controller (idempotent).
 *   2. Calls the requested action.
 *   3. Returns the snapshot to the host as the script result.
 *
 * @param {'install'|'search'|'next'|'prev'|'stop'} action
 * @param {{ query?: string, matchCase?: boolean, regex?: boolean, findNext?: boolean }} [params]
 */
function buildActionScript(action, params = {}) {
  const installSource = getControllerSource();
  const safeParams = JSON.stringify({
    query: typeof params.query === 'string' ? params.query : '',
    matchCase: params.matchCase === true,
    regex: params.regex === true,
    findNext: params.findNext === true,
  });

  // The in-page file is itself an IIFE that returns either
  // {supported, alreadyInstalled} (first install) or undefined (subsequent
  // installs are short-circuited). After install we look up the controller
  // and run the requested action. Wrapped to always return a JSON-serializable
  // object so executeJavaScript's promise resolves cleanly.
  return [
    '(() => {',
    '  try {',
    '    ' + installSource,
    '    const ctrl = window.__porticoAicLocalFind;',
    '    if (!ctrl) return { supported: false, totalMatches: 0, activeOrdinal: 0 };',
    '    const params = ' + safeParams + ';',
    '    if (!ctrl.supported) {',
    "      return { supported: false, totalMatches: 0, activeOrdinal: 0 };",
    '    }',
    '    let snap;',
    '    switch (' + JSON.stringify(action) + ') {',
    "      case 'install': snap = { supported: true, totalMatches: 0, activeOrdinal: 0 }; break;",
    "      case 'search': snap = ctrl.search(params.query, params); break;",
    "      case 'next': snap = ctrl.next(); break;",
    "      case 'prev': snap = ctrl.prev(); break;",
    "      case 'stop': snap = ctrl.stop(); break;",
    "      default: snap = { supported: true, totalMatches: 0, activeOrdinal: 0 };",
    '    }',
    '    return {',
    '      supported: snap && snap.supported !== false,',
    '      totalMatches: (snap && snap.totalMatches) || 0,',
    '      activeOrdinal: (snap && snap.activeOrdinal) || 0,',
    '      error: (snap && snap.error) || null,',
    '    };',
    '  } catch (err) {',
    "    return { supported: false, totalMatches: 0, activeOrdinal: 0, error: String((err && err.message) || err) };",
    '  }',
    '})()',
  ].join('\n');
}

module.exports = {
  escapeRegex,
  buildRegex,
  computeNextOrdinal,
  normalizeOptions,
  getControllerSource,
  buildActionScript,
};
