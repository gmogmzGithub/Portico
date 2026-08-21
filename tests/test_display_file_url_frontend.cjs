const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { build } = require('../electron-app/node_modules/esbuild');

const REPO_ROOT = path.resolve(__dirname, '..');
let tempDir;
let displayFileUrl;

before(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'display-file-url-tests-'));
	const outfile = path.join(tempDir, 'displayFileUrl.cjs');
	await build({
		entryPoints: [
			path.join(REPO_ROOT, 'src/patches/frontend/src/lib/utils/displayFileUrl.ts')
		],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: ['node20'],
		logLevel: 'silent',
		outfile
	});
	displayFileUrl = require(outfile);
});

after(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test('images prefer browser URLs intended for inline rendering', () => {
	assert.equal(
		displayFileUrl.selectDisplayFileUrl(
			{
				url: 'http://localhost:9876/workspace/chat/diagram.svg',
				browser_url: 'http://localhost:9876/workspace/chat/diagram.svg?inline=1',
				download_url: 'http://localhost:9876/workspace/chat/diagram.svg'
			},
			true
		),
		'http://localhost:9876/workspace/chat/diagram.svg?inline=1'
	);
});

test('non-images prefer download URLs', () => {
	assert.equal(
		displayFileUrl.selectDisplayFileUrl(
			{
				url: 'http://localhost:9876/workspace/chat/report.txt?inline=1',
				browser_url: 'http://localhost:9876/workspace/chat/report.txt?inline=1',
				download_url: 'http://localhost:9876/workspace/chat/report.txt'
			},
			false
		),
		'http://localhost:9876/workspace/chat/report.txt'
	);
});

test('legacy image records fall back to their plain URL', () => {
	assert.equal(
		displayFileUrl.selectDisplayFileUrl(
			{ url: 'http://localhost:9876/workspace/chat/legacy.svg' },
			true
		),
		'http://localhost:9876/workspace/chat/legacy.svg'
	);
});
