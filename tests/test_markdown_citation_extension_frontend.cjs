const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { build } = require('../electron-app/node_modules/esbuild');

const REPO_ROOT = path.resolve(__dirname, '..');

let tempDir;
let citationExtensionModule;

const bundleModule = async (entryPath, outFile) => {
	await build({
		entryPoints: [path.join(REPO_ROOT, entryPath)],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: ['node20'],
		logLevel: 'silent',
		outfile: outFile
	});

	return require(outFile);
};

before(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'citation-extension-tests-'));
	citationExtensionModule = await bundleModule(
		'src/patches/frontend/src/lib/utils/marked/citation-extension.ts',
		path.join(tempDir, 'citationExtension.cjs')
	);
});

after(async () => {
	if (tempDir) {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test('keeps numeric brackets literal when cited ids do not resolve to message sources', () => {
	const extension = citationExtensionModule.citationExtension({
		shouldTokenize: (ids) =>
			citationExtensionModule.areCitationIdsResolvable([], ids)
	});

	assert.equal(extension.tokenizer('[1, 2, 3] FY25H2: evidence line'), undefined);
	assert.equal(extension.tokenizer('[^1] footnote ref'), undefined);
});

test('tokenizes numeric brackets into citations only when every id resolves', () => {
	const sourceIds = ['Spec Doc', 'Epic', 'Design Doc', 'Launch Notes'];
	const extension = citationExtensionModule.citationExtension({
		shouldTokenize: (ids) =>
			citationExtensionModule.areCitationIdsResolvable(sourceIds, ids)
	});

	const token = extension.tokenizer('[1, 3, 4] FY25H2: evidence line');
	assert.deepEqual(token, {
		type: 'citation',
		raw: '[1, 3, 4]',
		ids: [1, 3, 4]
	});

	assert.equal(extension.tokenizer('[1, 5] unresolved line'), undefined);
});

test('treats placeholder or missing source titles as unresolved citations', () => {
	assert.equal(
		citationExtensionModule.resolveCitationSourceTitle(['Spec Doc', 'N/A'], 1),
		'Spec Doc'
	);
	assert.equal(
		citationExtensionModule.resolveCitationSourceTitle(['Spec Doc', 'N/A'], 2),
		null
	);
	assert.equal(
		citationExtensionModule.areCitationIdsResolvable(['Spec Doc', 'N/A'], [1, 2]),
		false
	);
});
