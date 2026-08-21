const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { build } = require('../electron-app/node_modules/esbuild');

const REPO_ROOT = path.resolve(__dirname, '..');
const MOTION_HELPER_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/utils/modelLogoMotion.ts'
);
const RESPONSE_MESSAGE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage.svelte'
);
const ANIMATED_TERRA_LOGO_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/common/AnimatedTerraLogo.svelte'
);
const MODEL_BRANDING_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/utils/modelBranding.ts'
);
const APP_CSS_PATH = path.join(REPO_ROOT, 'src/patches/frontend/src/app.css');

let tempDir;
let motionHelper;

before(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'streaming-model-logo-tests-'));
	const outfile = path.join(tempDir, 'modelLogoMotion.cjs');
	await build({
		entryPoints: [MOTION_HELPER_PATH],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: ['node20'],
		logLevel: 'silent',
		outfile
	});
	motionHelper = require(outfile);
});

after(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test('streaming model logo motion resolves each first-party visual language exactly', () => {
	const cases = [
		[{ id: 'Atlas Sonnet 5' }, 'atlas'],
		[{ id: 'GPT-5.6 Sol' }, 'sol'],
		[{ id: 'openai/GPT-5.6 Sol Pro:latest' }, 'sol'],
		[{ id: 'GPT-5.6 Terra' }, 'terra'],
		[{ id: 'GPT-5.6 Luna' }, 'luna'],
		[{ id: 'gemini-3.1-pro-preview' }, 'gemini'],
		[{ id: 'GPT-5.5' }, 'gpt'],
		[{ id: 'llama-local', meta: { local_provider: 'lm_studio' } }, 'local'],
		[{ id: 'unbranded-model' }, 'other']
	];

	for (const [candidate, expected] of cases) {
		assert.equal(motionHelper.getStreamingModelLogoMotionKind(candidate), expected);
	}
});

test('per-response motion timing is bounded, deterministic, and varied without runtime randomness', async () => {
	const first = motionHelper.getStreamingModelLogoMotionVariables('message-alpha', 'atlas');
	const repeated = motionHelper.getStreamingModelLogoMotionVariables('message-alpha', 'atlas');
	const second = motionHelper.getStreamingModelLogoMotionVariables('message-beta', 'atlas');

	assert.deepEqual(repeated, first);
	assert.notDeepEqual(second, first);
	assert.match(first['--model-logo-breathe-duration'], /^\d+\.\d{2}s$/);
	assert.match(first['--model-logo-spin-duration'], /^\d+\.\d{2}s$/);
	assert.match(first['--model-logo-glow-duration'], /^\d+\.\d{2}s$/);
	assert.match(first['--model-logo-breathe-delay'], /^-\d+\.\d{2}s$/);
	assert.match(first['--model-logo-spin-delay'], /^-\d+\.\d{2}s$/);
	assert.match(first['--model-logo-glow-delay'], /^-\d+\.\d{2}s$/);
	assert.match(first['--model-logo-terra-flourish-duration'], /^\d+\.\d{2}s$/);
	assert.match(first['--model-logo-terra-flourish-delay'], /^-\d+\.\d{2}s$/);
	assert.match(first['--model-logo-atlas-cycle-delay'], /^-\d+\.\d{2}s$/);

	const seconds = (value) => Number.parseFloat(value);
	assert.ok(seconds(first['--model-logo-breathe-duration']) >= 14);
	assert.ok(seconds(first['--model-logo-breathe-duration']) <= 20);
	assert.ok(seconds(first['--model-logo-spin-duration']) >= 44);
	assert.ok(seconds(first['--model-logo-spin-duration']) <= 62);
	assert.ok(seconds(first['--model-logo-glow-duration']) >= 12);
	assert.ok(seconds(first['--model-logo-glow-duration']) <= 18);

	const helperSource = await fs.readFile(MOTION_HELPER_PATH, 'utf8');
	assert.doesNotMatch(helperSource, /Math\.random|setInterval|setTimeout/);
});

test('celestial motion keeps the rebalanced deterministic timing ranges', () => {
	const haiku = motionHelper.getStreamingModelLogoMotionVariables(
		'message-atlas',
		'atlas',
		{ id: 'Atlas Haiku 4.5' }
	);
	const sonnet = motionHelper.getStreamingModelLogoMotionVariables(
		'message-atlas',
		'atlas',
		{ id: 'Atlas Sonnet 5' }
	);
	const opus = motionHelper.getStreamingModelLogoMotionVariables(
		'message-atlas',
		'atlas',
		{ id: 'Atlas Opus 4.8' }
	);
	const sol = motionHelper.getStreamingModelLogoMotionVariables(
		'message-sol',
		'sol',
		{ id: 'GPT-5.6 Sol' }
	);
	const terra = motionHelper.getStreamingModelLogoMotionVariables(
		'message-terra',
		'terra',
		{ id: 'GPT-5.6 Terra' }
	);
	const luna = motionHelper.getStreamingModelLogoMotionVariables(
		'message-luna',
		'luna',
		{ id: 'GPT-5.6 Luna' }
	);

	assert.ok(Number(haiku['--model-logo-atlas-ray-peak']) < Number(sonnet['--model-logo-atlas-ray-peak']));
	assert.ok(Number(sonnet['--model-logo-atlas-ray-peak']) < Number(opus['--model-logo-atlas-ray-peak']));
	assert.ok(Number(haiku['--model-logo-halo-peak']) < Number(sonnet['--model-logo-halo-peak']));
	assert.ok(Number(sonnet['--model-logo-halo-peak']) < Number(opus['--model-logo-halo-peak']));
	assert.ok(Number.parseFloat(sol['--model-logo-breathe-duration']) >= 6.5);
	assert.ok(Number.parseFloat(sol['--model-logo-breathe-duration']) <= 9.25);
	assert.ok(Number.parseFloat(sol['--model-logo-spin-duration']) >= 22);
	assert.ok(Number.parseFloat(sol['--model-logo-spin-duration']) <= 31);
	assert.ok(Number.parseFloat(sol['--model-logo-glow-duration']) >= 7.5);
	assert.ok(Number.parseFloat(sol['--model-logo-glow-duration']) <= 10.5);
	assert.ok(Number.parseFloat(terra['--model-logo-spin-duration']) >= 16);
	assert.ok(Number.parseFloat(terra['--model-logo-spin-duration']) <= 22);
	assert.ok(Number.parseFloat(terra['--model-logo-terra-flourish-duration']) >= 16 / 0.41);
	assert.ok(Number.parseFloat(terra['--model-logo-terra-flourish-duration']) <= 22 / 0.41);
	assert.ok(
		Math.abs(
			Number.parseFloat(terra['--model-logo-terra-flourish-duration']) * 0.41 -
				Number.parseFloat(terra['--model-logo-spin-duration'])
		) <= 0.02
	);
	assert.ok(Number.parseFloat(terra['--model-logo-terra-flourish-delay']) <= 0);
	assert.ok(
		Math.abs(Number.parseFloat(terra['--model-logo-terra-flourish-delay'])) <=
			Number.parseFloat(terra['--model-logo-terra-flourish-duration'])
	);
	assert.ok(Number.parseFloat(terra['--model-logo-glow-duration']) >= 7);
	assert.ok(Number.parseFloat(terra['--model-logo-glow-duration']) <= 10);
	assert.ok(Number.parseFloat(luna['--model-logo-spin-duration']) >= 11.8);
	assert.ok(Number.parseFloat(luna['--model-logo-spin-duration']) <= 18.4);
	assert.ok(Number.parseFloat(luna['--model-logo-glow-duration']) >= 2.7);
	assert.ok(Number.parseFloat(luna['--model-logo-glow-duration']) <= 4.7);
	assert.equal(motionHelper.getAtlasModelLogoMotionTier({ id: 'Atlas Haiku 4.5' }), 'haiku');
	assert.equal(motionHelper.getAtlasModelLogoMotionTier({ id: 'Atlas Sonnet 5' }), 'sonnet');
	assert.equal(motionHelper.getAtlasModelLogoMotionTier({ id: 'Atlas Opus 4.8' }), 'opus');
});

test('response avatars animate only for live streams, restore Luna PNG, and use direct Terra SVG hooks', async () => {
	const [source, branding, terraLogo] = await Promise.all([
		fs.readFile(RESPONSE_MESSAGE_PATH, 'utf8'),
		fs.readFile(MODEL_BRANDING_PATH, 'utf8'),
		fs.readFile(ANIMATED_TERRA_LOGO_PATH, 'utf8')
	]);

	assert.match(source, /getStreamingModelLogoMotionKind/);
	assert.match(source, /getStreamingModelLogoMotionStyle\(\s*message\.id,/s);
	assert.match(source, /assistantModelLogoIsStreaming\s*=\s*!message\.done\s*&&\s*!message\.error/);
	assert.match(source, /assistant-model-logo-motion--\$\{assistantModelMotionKind\}/);
	assert.match(source, /data-model-logo-streaming=\{assistantModelLogoIsStreaming/);
	assert.match(source, /assistant-model-logo-rotor/);
	assert.doesNotMatch(source, /AnimatedLunaLogo/);
	assert.match(branding, /LUNA_MODEL_LOGO_SRC\s*=\s*'\/luna\.png'/);
	assert.match(source, /assistantModelMotionKind === 'terra'[\s\S]*?<AnimatedTerraLogo/s);
	assert.match(terraLogo, /const surfaceOffsets = \[0, 100\] as const/);
	assert.match(terraLogo, /animated-terra-continent-copy/);
	assert.match(terraLogo, /clipPathUnits="userSpaceOnUse"/);
	assert.match(terraLogo, /clip-path=\{`url\(#\$\{clipId\}\)`\}/);
	assert.match(terraLogo, /animated-terra-region--north-america/);
	assert.match(terraLogo, /animated-terra-region--south-america/);
	assert.match(terraLogo, /animated-terra-region--eurasia/);
	assert.match(terraLogo, /animated-terra-region--africa/);
	assert.match(terraLogo, /animated-terra-region--australia/);
	assert.equal((terraLogo.match(/<circle class="animated-terra-sparkle/g) ?? []).length, 12);
	assert.ok(terraLogo.indexOf('animated-terra-water-glints') < terraLogo.indexOf('animated-terra-surface-strip'));
	assert.match(terraLogo, /--terra-sparkle-duration: 2\.3s/);
	assert.match(terraLogo, /--terra-sparkle-duration: 5\.7s/);
	assert.match(
		terraLogo,
		/<g class="animated-terra-surface-clip"[\s\S]*animated-terra-daylight[\s\S]*animated-terra-limb-shadow[\s\S]*<\/g>/s
	);
	assert.match(source, /clipId=\{`animated-terra-response-/);
});

test('brand motion CSS includes rebalanced celestial motion and reduced-motion safety', async () => {
	const [css, terraLogo] = await Promise.all([
		fs.readFile(APP_CSS_PATH, 'utf8'),
		fs.readFile(ANIMATED_TERRA_LOGO_PATH, 'utf8')
	]);

	assert.match(
		css,
		/\.assistant-model-logo-motion\s*\{[^}]*flex:\s*0 0 2rem;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*width:\s*2rem;[^}]*height:\s*2rem;/s
	);
	assert.match(
		css,
		/\.assistant-model-logo-rotor\s*\{[^}]*flex:\s*0 0 2rem;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*width:\s*2rem;[^}]*height:\s*2rem;/s
	);

	for (const kind of ['atlas', 'sol', 'terra', 'luna', 'gemini', 'gpt', 'local', 'other']) {
		assert.match(css, new RegExp(`\\.assistant-model-logo-motion--${kind}`));
	}

	assert.match(css, /@keyframes assistant-logo-atlas-slow-spin[\s\S]*rotate\(360deg\)/);
	assert.match(
		css,
		/@keyframes assistant-logo-atlas-opus-spin[\s\S]*rotate\(171deg\)[\s\S]*rotate\(545deg\)[\s\S]*rotate\(720deg\)/
	);
	assert.match(
		css,
		/data-atlas-motion-tier='haiku'[\s\S]*assistant-model-logo-rotor[\s\S]*animation-name:\s*assistant-logo-atlas-slow-spin[\s\S]*animation-timing-function:\s*linear/
	);
	assert.match(css, /assistant-logo-atlas-ray-pulse-haiku 48s/);
	assert.match(css, /assistant-logo-atlas-ray-pulse-sonnet 20s/);
	assert.match(css, /assistant-logo-atlas-ray-pulse-opus 14s/);
	assert.match(css, /\.atlas-haiku-group--12\s*\{[^}]*- 44s\)/);
	assert.match(css, /\.atlas-sonnet-group--5\s*\{[^}]*- 16s\)/);
	assert.match(css, /\.atlas-opus-group--4\s*\{[^}]*- 10\.5s\)/);
	assert.match(css, /\.atlas-ray-direction--out\s*\{[^}]*--model-logo-atlas-ray-target:/);
	assert.match(css, /\.animated-atlas-mark--haiku \.atlas-ray-direction--in\s*\{[^}]*0\.9/);
	assert.match(css, /\.animated-atlas-mark--sonnet \.atlas-ray-direction--in\s*\{[^}]*0\.84/);
	assert.match(css, /\.animated-atlas-mark--opus \.atlas-ray-direction--in\s*\{[^}]*0\.76/);
	assert.match(
		css,
		/@keyframes assistant-logo-sol-spin[\s\S]*rotate\(70deg\)[\s\S]*rotate\(310deg\)[\s\S]*rotate\(460deg\)[\s\S]*rotate\(700deg\)[\s\S]*rotate\(720deg\)/
	);
	assert.doesNotMatch(
		css,
		/\.assistant-model-logo-motion--sol\.is-streaming \.assistant-model-logo-rotor\s*\{[^}]*animation-timing-function:\s*linear/s
	);
	assert.match(css, /@keyframes assistant-logo-sol-breathe[\s\S]*scale\(0\.97\)[\s\S]*scale\(1\.16\)[\s\S]*saturate\(1\.4\)[\s\S]*brightness\(1\.2\)/);
	assert.match(css, /@keyframes assistant-logo-solar-corona[\s\S]*opacity:\s*0\.76[\s\S]*scale\(1\.35\)/);
	assert.match(css, /@keyframes assistant-logo-solar-ray[\s\S]*opacity:\s*0\.72[\s\S]*scale\(1\.32\)/);
	assert.match(css, /\.assistant-model-logo-motion--sol::after\s*\{[^}]*repeating-conic-gradient/s);
	assert.match(css, /assistant-logo-terra-float/);
	assert.match(
		css,
		/\.animated-terra-surface-strip\s*\{[\s\S]*animation:\s*assistant-logo-terra-surface-pan var\(--model-logo-terra-flourish-duration, 46\.34s\) var\(--model-logo-terra-flourish-delay, 0s\) infinite;/
	);
	assert.match(
		css,
		/@keyframes assistant-logo-terra-surface-pan[\s\S]*41%[\s\S]*41\.71%[\s\S]*42\.52%[\s\S]*43\.53%[\s\S]*44\.84%[\s\S]*46\.65%[\s\S]*49\.26%[\s\S]*53\.07%[\s\S]*59%[\s\S]*59\.01%[\s\S]*translateX\(-100px\)/
	);
	const terraPanKeyframes = css.match(
		/@keyframes assistant-logo-terra-surface-pan\s*\{([\s\S]*?)\n\}/
	)?.[1];
	assert.ok(terraPanKeyframes);
	assert.equal((terraPanKeyframes.match(/translateX\(-100px\)/g) ?? []).length, 10);
	assert.match(css, /@keyframes assistant-logo-terra-aura[\s\S]*opacity:\s*0\.34[\s\S]*scale\(1\.08\)/);
	for (const group of ['a', 'b', 'c', 'd']) {
		assert.match(css, new RegExp(`@keyframes assistant-logo-terra-sparkle-${group}`));
	}
	assert.doesNotMatch(css, /assistant-logo-terra-ocean-glints/);
	assert.doesNotMatch(css, /assistant-logo-terra-spin/);
	assert.doesNotMatch(
		css,
		/\.assistant-model-logo-motion--terra\.is-streaming \.assistant-model-logo-rotor\s*\{[^}]*animation-name/s
	);
	assert.match(terraLogo, /animated-terra-surface-strip/);
	assert.match(terraLogo, /animated-terra-ocean/);
	assert.match(terraLogo, /animated-terra-night-shade/);
	assert.match(terraLogo, /animated-terra-atmosphere/);
	assert.match(terraLogo, /animated-terra-water-glints/);
	assert.match(css, /\.animated-terra-land\s*\{[^}]*stroke-linejoin:\s*round;[^}]*stroke-width:\s*0\.78;/s);
	assert.match(css, /assistant-logo-luna-orbit/);
	assert.match(css, /@keyframes assistant-logo-luna-tumble[\s\S]*rotate\(378deg\)/);
	assert.match(css, /@keyframes assistant-logo-luna-terminator[\s\S]*translateX\(-72%\)[\s\S]*translateX\(72%\)/);
	assert.match(css, /\.assistant-model-logo-motion--luna::after\s*\{[^}]*inset:\s*2px;[^}]*linear-gradient/s);
	assert.doesNotMatch(css, /animated-luna|model-logo-luna-light|assistant-logo-luna-light-phases/);
	assert.match(css, /assistant-logo-prismatic-halo/);
	assert.match(
		css,
		/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.assistant-model-logo-motion\.is-streaming[\s\S]*animation:\s*none !important/
	);
	assert.match(
		css,
		/@media \(prefers-reduced-motion: reduce\)[\s\S]*animated-terra-surface-strip[\s\S]*animated-terra-sparkle[\s\S]*animation:\s*none !important/
	);
});
