'use strict';

/**
 * PORTICO PATCH: Unit tests for the shell-side wrapper around the in-page
 * Custom Highlight API local-find controller. The DOM-driven behavior lives in
 * owui-local-find-page.js and is exercised at integration time by
 * tab-search-regressions.test.js plus the live test plan
 * (docs/testing/plan/search/in-chat-find.md E-10..E-19).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const controller = require('./owui-local-find-controller');

test('escapeRegex escapes every metacharacter that breaks a literal-text query', () => {
  const meta = '.*+?^${}()|[]\\';
  const escaped = controller.escapeRegex(meta);
  // Round-trip: the escaped output, used as a regex source, must match the
  // original text exactly with no fewer and no more characters.
  const re = new RegExp(escaped);
  assert.equal(re.test(meta), true);
  assert.equal(escaped.length >= meta.length * 2 - 1, true);
});

test('escapeRegex returns "" for null/undefined without throwing', () => {
  assert.equal(controller.escapeRegex(undefined), '');
  assert.equal(controller.escapeRegex(null), '');
});

test('buildRegex returns null+null for empty queries', () => {
  const r = controller.buildRegex('', {});
  assert.equal(r.regex, null);
  assert.equal(r.error, null);
});

test('buildRegex defaults to case-insensitive global plain text', () => {
  const { regex, error } = controller.buildRegex('Foo', {});
  assert.equal(error, null);
  assert.match(regex.flags, /g/);
  assert.match(regex.flags, /i/);
  assert.equal(regex.test('foo'), true);
  regex.lastIndex = 0;
  assert.equal(regex.test('FOO'), true);
});

test('buildRegex respects caseSensitive flag', () => {
  const { regex } = controller.buildRegex('Foo', { caseSensitive: true });
  assert.equal(regex.flags.includes('i'), false);
  assert.equal(regex.test('Foo'), true);
  regex.lastIndex = 0;
  assert.equal(regex.test('foo'), false);
});

test('buildRegex with regex flag passes the user pattern verbatim', () => {
  const { regex, error } = controller.buildRegex('bug-\\d+', { regex: true });
  assert.equal(error, null);
  assert.equal(regex.test('bug-123'), true);
});

test('buildRegex with invalid user regex returns a non-null error and null regex', () => {
  const { regex, error } = controller.buildRegex('[', { regex: true });
  assert.equal(regex, null);
  assert.equal(typeof error, 'string');
  assert.equal(error.length > 0, true);
});

test('buildRegex with regex flag does NOT escape literal punctuation in plain mode', () => {
  // A user typing "(foo)" without regex mode expects to match the parens.
  const { regex } = controller.buildRegex('(foo)', {});
  assert.equal(regex.test('(foo)'), true);
  regex.lastIndex = 0;
  // And '(foo)' should not silently match 'foo' alone.
  assert.equal(regex.test('foo'), false);
});

test('computeNextOrdinal returns 0 when there are no matches', () => {
  assert.equal(controller.computeNextOrdinal(0, 0, true), 0);
  assert.equal(controller.computeNextOrdinal(3, 0, false), 0);
});

test('computeNextOrdinal advances forward and wraps from end to 1', () => {
  assert.equal(controller.computeNextOrdinal(1, 3, true), 2);
  assert.equal(controller.computeNextOrdinal(2, 3, true), 3);
  assert.equal(controller.computeNextOrdinal(3, 3, true), 1);
});

test('computeNextOrdinal goes backward and wraps from 1 to total', () => {
  assert.equal(controller.computeNextOrdinal(2, 5, false), 1);
  assert.equal(controller.computeNextOrdinal(1, 5, false), 5);
});

test('computeNextOrdinal seeds first/last when current is 0', () => {
  assert.equal(controller.computeNextOrdinal(0, 4, true), 1);
  assert.equal(controller.computeNextOrdinal(0, 4, false), 4);
});

test('computeNextOrdinal handles non-finite / negative inputs defensively', () => {
  assert.equal(controller.computeNextOrdinal(NaN, 4, true), 1);
  assert.equal(controller.computeNextOrdinal(-1, 4, true), 1);
  assert.equal(controller.computeNextOrdinal(2, NaN, true), 0);
});

test('normalizeOptions enforces booleans with sane defaults', () => {
  assert.deepEqual(controller.normalizeOptions(undefined), {
    matchCase: false,
    findNext: false,
    forward: true,
    regex: false,
  });
  assert.deepEqual(
    controller.normalizeOptions({
      matchCase: true,
      findNext: true,
      forward: false,
      regex: 'truthy-but-not-true',
    }),
    {
      matchCase: true,
      findNext: true,
      forward: false,
      regex: false,
    },
  );
});

test('getControllerSource returns the in-page IIFE verbatim', () => {
  const src = controller.getControllerSource();
  const onDisk = fs.readFileSync(
    path.join(__dirname, 'owui-local-find-page.js'),
    'utf8',
  );
  assert.equal(src, onDisk);
});

test('getControllerSource is cached on second call', () => {
  const a = controller.getControllerSource();
  const b = controller.getControllerSource();
  assert.equal(a === b, true);
});

test('in-page IIFE source advertises the documented contract', () => {
  const src = controller.getControllerSource();
  // Scoping root marker — the controller MUST limit matches to this subtree.
  assert.match(src, /\[data-portico-chat-root="true"\]/);
  // Excludes that prevent E-13 / E-14 regressions.
  assert.match(src, /'textarea'/);
  assert.match(src, /'input'/);
  assert.match(src, /\[data-portico-find-exclude\]/);
  assert.match(src, /\.katex-mathml/);
  assert.match(src, /\.sr-only/);
  // Window namespace contract that the host bridge depends on.
  assert.match(src, /__porticoAicLocalFind/);
  // Update event the chat-webview-preload bridge listens to.
  assert.match(src, /portico-portico-local-find-update/);
  // Custom Highlight API feature detection — required for the fallback path.
  assert.match(src, /CSS\.highlights/);
  assert.match(src, /typeof Highlight === 'function'/);
});

test('buildActionScript installs the page IIFE and dispatches an action', () => {
  const search = controller.buildActionScript('search', {
    query: 'Hello "World"',
    matchCase: true,
    regex: false,
    findNext: true,
  });
  // Sanity: the script ends with an IIFE invocation we can hand to executeJavaScript.
  assert.match(search.trim().slice(-3), /\)\(\)/);
  // The page source is embedded.
  assert.match(search, /__porticoAicLocalFind/);
  // Params are JSON-encoded so embedded quotes are safe.
  assert.match(search, /"query":"Hello \\"World\\""/);
  assert.match(search, /"matchCase":true/);
});

test('buildActionScript dispatches stop without parameters cleanly', () => {
  const stop = controller.buildActionScript('stop');
  assert.match(stop, /ctrl\.stop\(\)/);
  // Stop should not assume a query.
  assert.match(stop, /"query":""/);
});

test('buildActionScript next/prev call the matching controller method', () => {
  assert.match(controller.buildActionScript('next'), /ctrl\.next\(\)/);
  assert.match(controller.buildActionScript('prev'), /ctrl\.prev\(\)/);
});
