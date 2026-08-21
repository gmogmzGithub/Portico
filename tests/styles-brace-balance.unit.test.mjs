// A stray closing brace in a stylesheet makes the CSS parser silently
// swallow the next rule (this ate `#debug-btn { position: relative }` and
// rendered the debug-collection progress invisible, 2026-08-07). Keep the
// main stylesheets structurally balanced.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const relative of ['electron-app/src/styles.css']) {
	test(`${relative} has balanced braces`, async () => {
		const source = await fs.readFile(path.join(repoRoot, relative), 'utf8');
		// Strip comments and quoted strings so embedded braces don't count.
		const stripped = source
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
		const opens = (stripped.match(/\{/g) || []).length;
		const closes = (stripped.match(/\}/g) || []).length;
		assert.equal(opens, closes,
			`unbalanced braces (${opens} open vs ${closes} close) — a stray brace silently disables the following rule`);
	});
}
