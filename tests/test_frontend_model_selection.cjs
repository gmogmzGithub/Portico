const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { build } = require('../electron-app/node_modules/esbuild');

const REPO_ROOT = path.resolve(__dirname, '..');
const MODEL_SELECTOR_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/ModelSelector/Selector.svelte'
);
const MODEL_SELECTOR_WRAPPER_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/ModelSelector.svelte'
);
const MODEL_ITEM_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/ModelSelector/ModelItem.svelte'
);
const MODEL_GUIDE_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/ModelSelector/ModelGuide.svelte'
);
const NAVBAR_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Navbar.svelte'
);
const PLACEHOLDER_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Placeholder.svelte'
);
const SUGGESTIONS_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Suggestions.svelte'
);
const SUGGESTION_ICON_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/SuggestionIcon.svelte'
);
const RESPONSE_MESSAGE_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Messages/ResponseMessage.svelte'
);
const MESSAGE_INPUT_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/MessageInput.svelte'
);
const CHAT_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/chat/Chat.svelte'
);
const BASE_MODEL_BADGE_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/common/BaseModelBadge.svelte'
);
const WORKSPACE_MODELS_SVELTE_PATH = path.join(
	REPO_ROOT,
	'src/patches/frontend/src/lib/components/workspace/Models.svelte'
);
const APP_CSS_PATH = path.join(REPO_ROOT, 'src/patches/frontend/src/app.css');
const ELECTRON_STYLES_PATH = path.join(REPO_ROOT, 'electron-app/src/styles.css');
const ELECTRON_WINDOWS_PATH = path.join(REPO_ROOT, 'electron-app/src/services/windows.js');
const ELECTRON_LOADING_HTML_PATH = path.join(
	REPO_ROOT,
	'electron-app/src/renderer/views/loading.html'
);
const BACKEND_MAIN_PATH = path.join(REPO_ROOT, 'src/patches/backend/open_webui/main.py');
const MODEL_CATALOG_PATH = path.join(REPO_ROOT, 'model_catalog.yaml');
const GPT_56_PRICING = require('./fixtures/gpt-56-pricing.json');

let tempDir;
let modelAvailability;
let modelSelection;
let modelCapabilities;
let modelTraits;
let modelBranding;
let modelLogoCache;
let modelPricing;
let suggestionVisual;
let modelSelectorLayout;
let landingHeroModel;

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
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-model-selection-tests-'));
	modelAvailability = await bundleModule(
		'src/patches/frontend/src/lib/utils/modelAvailability.ts',
		path.join(tempDir, 'modelAvailability.cjs')
	);
	modelSelection = await bundleModule(
		'src/patches/frontend/src/lib/utils/modelSelection.ts',
		path.join(tempDir, 'modelSelection.cjs')
	);
	modelCapabilities = await bundleModule(
		'src/patches/frontend/src/lib/config/model-capabilities.ts',
		path.join(tempDir, 'modelCapabilities.cjs')
	);
	modelTraits = await bundleModule(
		'src/patches/frontend/src/lib/config/model-traits.ts',
		path.join(tempDir, 'modelTraits.cjs')
	);
	modelPricing = await bundleModule(
		'src/patches/frontend/src/lib/config/model-pricing.ts',
		path.join(tempDir, 'modelPricing.cjs')
	);
	modelBranding = await bundleModule(
		'src/patches/frontend/src/lib/utils/modelBranding.ts',
		path.join(tempDir, 'modelBranding.cjs')
	);
	modelLogoCache = await bundleModule(
		'src/patches/frontend/src/lib/utils/modelLogoCache.ts',
		path.join(tempDir, 'modelLogoCache.cjs')
	);
	suggestionVisual = await bundleModule(
		'src/patches/frontend/src/lib/utils/suggestionVisual.ts',
		path.join(tempDir, 'suggestionVisual.cjs')
	);
	modelSelectorLayout = await bundleModule(
		'src/patches/frontend/src/lib/utils/modelSelectorLayout.ts',
		path.join(tempDir, 'modelSelectorLayout.cjs')
	);
	landingHeroModel = await bundleModule(
		'src/patches/frontend/src/lib/utils/landingHeroModel.ts',
		path.join(tempDir, 'landingHeroModel.cjs')
	);
});

after(async () => {
	if (tempDir) {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test('frontend availability helpers inherit disabled reasons through base-model chains', () => {
	const disabledBase = {
		id: 'GPT-5.6 Sol Pro:latest',
		meta: {
			disabled: true,
			disabled_reason: ' Temporarily disabled due to high costs '
		}
	};
	const derivedModel = {
		id: 'agent-gpt-pro',
		info: {
			base_model_id: 'GPT-5.6 Sol Pro'
		}
	};

	assert.deepEqual(
		modelAvailability.getModelAvailability(derivedModel, [disabledBase, derivedModel]),
		{
			disabled: true,
			disabledReason: 'Temporarily disabled due to high costs'
		}
	);
});

test('frontend availability helpers avoid false positives for cyclical base-model links', () => {
	const cycleA = {
		id: 'cycle-a',
		info: { base_model_id: 'cycle-b' }
	};
	const cycleB = {
		id: 'cycle-b',
		info: { base_model_id: 'cycle-a' }
	};

	assert.deepEqual(modelAvailability.getModelAvailability(cycleA, [cycleA, cycleB]), {
		disabled: false,
		disabledReason: null
	});
});

test('frontend enabled-model list excludes hidden models and models disabled through inheritance', () => {
	const models = [
		{
			id: 'Atlas Sonnet 4.6',
			meta: { hidden: true }
		},
		{
			id: 'GPT-5.6 Sol Pro',
			meta: {
				disabled: true,
				disabled_reason: 'Temporarily disabled due to high costs'
			}
		},
		{
			id: 'Agent GPT Pro',
			info: { base_model_id: 'GPT-5.6 Sol Pro' }
		},
		{ id: 'GPT-5.6 Sol' },
		{ id: 'GPT-5.6 Terra' }
	];

	assert.deepEqual(modelAvailability.getEnabledModelIds(models), ['GPT-5.6 Sol', 'GPT-5.6 Terra']);
});

test('frontend chat-model resolution keeps only enabled selections, dedupes, and falls back cleanly', () => {
	const models = [
		{
			id: 'GPT-5.6 Sol Pro',
			meta: {
				disabled: true,
				disabled_reason: 'Temporarily disabled due to high costs'
			}
		},
		{ id: 'GPT-5.6 Sol' },
		{ id: 'GPT-5.6 Terra' },
		{ id: 'GPT-5.6 Luna' }
	];

	assert.deepEqual(
		modelSelection.resolveEnabledSelectedModelIds(
			['GPT-5.6 Sol Pro', 'GPT-5.6 Terra', 'GPT-5.6 Terra', 'missing'],
			models
		),
		['GPT-5.6 Terra']
	);
	assert.deepEqual(modelSelection.resolveEnabledSelectedModelIds(['missing'], models), []);
	assert.deepEqual(
		modelSelection.resolveEnabledSelectedModelIds(['GPT-5.6 Sol Pro'], models, { fallback: true }),
		['GPT-5.6 Sol']
	);
	assert.deepEqual(
		modelSelection.resolveEnabledSelectedModelIds(['missing'], [], { fallback: true }),
		['Atlas Sonnet 5']
	);
});

test('frontend chat-model fallback prefers Atlas Sonnet 5 when available', () => {
	const models = [
		{ id: 'GPT-5.6 Sol' },
		{ id: 'Atlas Sonnet 5' },
		{ id: 'Atlas Sonnet 4.6' },
		{ id: 'GPT-5.6 Terra' }
	];

	assert.equal(modelSelection.DEFAULT_CHAT_MODEL_ID, 'Atlas Sonnet 5');
	assert.deepEqual(
		modelSelection.resolveEnabledSelectedModelIds(['missing'], models, { fallback: true }),
		['Atlas Sonnet 5']
	);
	assert.deepEqual(
		modelSelection.resolveEnabledSelectedModelIds(
			['missing'],
			[
				{ id: 'GPT-5.6 Sol' },
				{ id: 'Atlas Sonnet 5', meta: { disabled: true } },
				{ id: 'Atlas Sonnet 4.6', meta: { disabled: true } },
				{ id: 'GPT-5.6 Terra' }
			],
			{ fallback: true }
		),
		['GPT-5.6 Sol']
	);
	// Sonnet 4.6 stays selectable when explicitly chosen.
	assert.deepEqual(
		modelSelection.resolveEnabledSelectedModelIds(['Atlas Sonnet 4.6'], models),
		['Atlas Sonnet 4.6']
	);
});

test('frontend effective defaults preserve custom-agent wrapper ids and fall back safely', () => {
	const models = [
		{ id: 'Atlas Sonnet 5' },
		{ id: 'GPT-5.6 Sol' },
		{
			id: 'research-agent',
			name: 'Research Agent',
			preset: true,
			info: { base_model_id: 'GPT-5.6 Sol' }
		}
	];

	assert.equal(
		modelSelection.resolveEffectiveDefaultModelId({
			userDefaultModels: ['research-agent'],
			configDefaultModels: 'Atlas Sonnet 5',
			models
		}),
		'research-agent'
	);
	assert.equal(
		modelSelection.resolveEffectiveDefaultModelId({
			userDefaultModels: [],
			configDefaultModels: 'GPT-5.6 Sol',
			models
		}),
		'GPT-5.6 Sol'
	);
	assert.equal(
		modelSelection.resolveEffectiveDefaultModelId({
			userDefaultModels: ['deleted-agent'],
			configDefaultModels: 'GPT-5.6 Sol',
			models
		}),
		'Atlas Sonnet 5'
	);
	assert.equal(
		modelSelection.resolveEffectiveDefaultModelId({
			userDefaultModels: ['disabled-agent'],
			configDefaultModels: 'GPT-5.6 Sol',
			models: [
				{ id: 'Atlas Sonnet 5' },
				{ id: 'GPT-5.6 Sol', meta: { disabled: true } },
				{
					id: 'disabled-agent',
					preset: true,
					info: { base_model_id: 'GPT-5.6 Sol' }
				}
			]
		}),
		'Atlas Sonnet 5'
	);
});

test('an explicitly saved default outranks the last-used carry-forward for new chats', async () => {
	const source = await fs.readFile(CHAT_SVELTE_PATH, 'utf8');
	const initNewChatStart = source.indexOf('const initNewChat = async () => {');
	// Boundary is the next declaration after initNewChat. This used to key off
	// 'const loadChat = async () => {', which stopped matching once loadChat
	// grew a multi-line signature -- the slice silently became empty and this
	// test guarded nothing.
	const initNewChatEnd = source.indexOf(
		'const seedReasoningEffortFromChatParams = () => {',
		initNewChatStart
	);
	const initNewChatSource = source.slice(initNewChatStart, initNewChatEnd);

	assert.notEqual(initNewChatStart, -1);
	assert.notEqual(initNewChatEnd, -1);
	assert.ok(initNewChatSource.length > 0, 'initNewChat slice must not be empty');
	// The carry-forward itself is unchanged: still written on send, still
	// consumed exactly once by the next new chat.
	assert.match(source, /sessionStorage\.selectedModels = selectedModelsString/);
	assert.match(source, /saveSessionSelectedModels\(\)/);
	assert.match(initNewChatSource, /sessionStorage\.removeItem\('selectedModels'\)/);
	// PORTICO-251 originally ranked the carry-forward above the saved default. That
	// ordering is intentionally reverted here so the picker's "Set as default"
	// action is honoured even after visiting an older chat on another model.
	const savedDefaultBranch = initNewChatSource.indexOf('if ($settings?.models) {');
	const carryForwardBranch = initNewChatSource.indexOf('} else if (sessionSelectedModels) {');
	assert.notEqual(savedDefaultBranch, -1, 'expected a saved-default branch');
	assert.notEqual(carryForwardBranch, -1, 'expected a carry-forward branch');
	assert.ok(
		savedDefaultBranch < carryForwardBranch,
		'an explicitly saved default must outrank the implicit last-used model'
	);
	// It must still be consumed unconditionally, so a stale value cannot
	// resurface on a later new chat.
	assert.ok(
		initNewChatSource.indexOf("sessionStorage.removeItem('selectedModels')") <
			savedDefaultBranch,
		'the carry-forward must be consumed regardless of which branch wins'
	);
});

test('model picker inline default action persists the selected model or agent only after a successful update', async () => {
	const [wrapperSource, selectorSource, messageInputSource] = await Promise.all([
		fs.readFile(MODEL_SELECTOR_WRAPPER_SVELTE_PATH, 'utf8'),
		fs.readFile(MODEL_SELECTOR_SVELTE_PATH, 'utf8'),
		fs.readFile(MESSAGE_INPUT_SVELTE_PATH, 'utf8')
	]);

	assert.match(wrapperSource, /resolveEffectiveDefaultModelId\(\{/);
	assert.match(wrapperSource, /models: \[selectedModelId\]/);
	assert.match(wrapperSource, /setDefaultModelHandler=\{saveDefaultModel\}/);
	assert.match(wrapperSource, /defaultModelId=\{effectiveDefaultModelId\}/);
	assert.match(wrapperSource, /catch \(error\)[\s\S]*Failed to update the default model/);
	assert.ok(
		wrapperSource.indexOf('await updateUserSettings') < wrapperSource.indexOf('settings.set(nextSettings)'),
		'the local settings store must update only after persistence succeeds'
	);
	// Saving a default discards the one-shot carry-forward, but only once the
	// write has succeeded.
	assert.match(wrapperSource, /sessionStorage\.removeItem\('selectedModels'\)/);
	assert.ok(
		wrapperSource.indexOf('settings.set(nextSettings)') <
			wrapperSource.indexOf("sessionStorage.removeItem('selectedModels')"),
		'a failed persist must not clear the carry-forward'
	);

	assert.match(selectorSource, /class="model-selector-tab model-selector-set-default-button/);
	assert.doesNotMatch(selectorSource, /model-selector-default-footer/);
	assert.ok(
		selectorSource.indexOf("$i18n.t('Agents')") <
			selectorSource.indexOf('model-selector-set-default-button'),
		'the default action should follow the Models and Agents tabs'
	);
	assert.match(selectorSource, /disabled=\{!canSaveDefaultModel \|\| savingDefaultModel\}/);
	assert.match(selectorSource, /selectedModelIsDefault[\s\S]*\? \$i18n\.t\('Default'\)/);
	assert.match(selectorSource, /await setDefaultModelHandler\(value\)/);
	assert.match(selectorSource, /side=\{\$mobile \? 'bottom' : composer \? 'top' : 'bottom'\}/);
});

test('the inline default action is derived from placement, not prop-drilled by callers', async () => {
	const [wrapperSource, selectorSource, messageInputSource] = await Promise.all([
		fs.readFile(MODEL_SELECTOR_WRAPPER_SVELTE_PATH, 'utf8'),
		fs.readFile(MODEL_SELECTOR_SVELTE_PATH, 'utf8'),
		fs.readFile(MESSAGE_INPUT_SVELTE_PATH, 'utf8')
	]);

	// Only the composer placement may change a global default. Deriving it here
	// means the scheduled-tasks form-field picker cannot opt in by accident.
	assert.match(wrapperSource, /\$: showSetDefault = compact && !formField;/);
	assert.match(selectorSource, /export let showSetDefault = false;/);
	assert.doesNotMatch(messageInputSource, /showSetDefault/);
	assert.match(
		messageInputSource,
		/<ModelSelector bind:selectedModels compact=\{true\} \/>/
	);
});

test('model picker form-field mode keeps the composer picker presentation with a full-width trigger', async () => {
	const wrapperSource = await fs.readFile(MODEL_SELECTOR_WRAPPER_SVELTE_PATH, 'utf8');

	assert.match(wrapperSource, /export let formField = false;/);
	assert.match(wrapperSource, /export let placeholder = \$i18n\.t\('Select a model'\);/);
	assert.match(
		wrapperSource,
		/data-model-selector-placement=\{compact \? 'composer' : formField \? 'form' : 'navbar'\}/
	);
	assert.match(wrapperSource, /formField[\s\S]*\? 'w-full'[\s\S]*: 'w-full max-w-fit'/);
	assert.match(wrapperSource, /\{placeholder\}[\s\S]*composer=\{compact \|\| formField\}/);
	assert.match(wrapperSource, /showSelectedModelLogo=\{formField\}/);
	assert.match(
		wrapperSource,
		/triggerClassName=\{compact[\s\S]*\? 'text-xs font-medium'[\s\S]*formField[\s\S]*\? 'text-sm font-normal'[\s\S]*: 'text-lg'/
	);

	const selectorSource = await fs.readFile(MODEL_SELECTOR_SVELTE_PATH, 'utf8');
	assert.match(selectorSource, /export let showSelectedModelLogo = false;/);
	assert.match(selectorSource, /showSelectedModelLogo && selectedModel/);
	assert.match(selectorSource, /data-selected-model-logo=\{selectedModel\.value\}/);
	assert.ok(
		selectorSource.indexOf('data-selected-model-logo={selectedModel.value}') <
			selectorSource.indexOf('{selectedModel.label}'),
		'the selected model logo should render before its name'
	);
});

test('frontend agent base-model helpers exclude disabled, preset, arena, direct, and current models', () => {
	const models = [
		{ id: 'current-model' },
		{ id: 'preset-model', preset: true },
		{ id: 'arena-model', owned_by: 'arena' },
		{ id: 'direct-model', direct: true },
		{
			id: 'GPT-5.6 Sol Pro',
			meta: {
				disabled: true,
				disabled_reason: 'Temporarily disabled due to high costs'
			}
		},
		{ id: 'GPT-5.6 Sol' },
		{ id: 'GPT-5.6 Terra' },
		{ id: 'GPT-5.6 Luna' }
	];

	assert.deepEqual(
		modelSelection
			.getAvailableBaseModels(models, { currentModelId: 'current-model' })
			.map((model) => model.id),
		['GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna']
	);
	assert.equal(
		modelSelection.resolveAvailableBaseModelId('GPT-5.6 Sol Pro', models, {
			currentModelId: 'current-model'
		}),
		'GPT-5.6 Sol'
	);
	assert.equal(
		modelSelection.resolveAvailableBaseModelId('GPT-5.6 Terra', models, {
			currentModelId: 'current-model'
		}),
		'GPT-5.6 Terra'
	);
	assert.equal(
		modelSelection.resolveAvailableBaseModelId(null, [
			{ id: 'GPT-5.6 Sol Pro', meta: { disabled: true } }
		]),
		null
	);
});

test('frontend migrations resolve every retired GPT id and :latest alias to a selectable model', () => {
	const migrationCases = [
		['GPT-5.4', 'GPT-5.6 Sol'],
		['GPT-5.4 pro', 'GPT-5.6 Sol Pro'],
		['GPT-4.1', 'GPT-5.6 Sol'],
		['GPT-4.1 mini', 'GPT-5.6 Terra'],
		['GPT-4.1 nano', 'GPT-5.6 Luna']
	];
	const selectableModelIds = new Set(Object.keys(modelCapabilities.MODEL_CAPABILITIES));

	for (const [retiredId, targetId] of migrationCases) {
		assert.equal(modelCapabilities.MODEL_MIGRATIONS[retiredId], targetId);
		assert.equal(modelCapabilities.resolveMigratedModelId(retiredId), targetId);
		assert.equal(modelCapabilities.resolveMigratedModelId(`${retiredId}:latest`), targetId);
		assert.equal(modelCapabilities.resolveMigratedModelId(`${retiredId}:LATEST`), targetId);
		assert.deepEqual(modelSelection.normalizeSelectedModelIds([retiredId, `${retiredId}:latest`]), [
			targetId
		]);
		assert.equal(selectableModelIds.has(targetId), true, `${targetId} must be selectable`);
	}
});

test('GPT-5.6 Sol GUI reasoning stops at Max while the backend catalog retains Ultra', async () => {
	assert.deepEqual(modelCapabilities.getReasoningEffortOptions('GPT-5.6 Sol'), [
		'none',
		'low',
		'medium',
		'high',
		'xhigh',
		'max'
	]);
	assert.deepEqual(modelCapabilities.getReasoningEffortOptions('GPT-5.6 Terra'), [
		'none',
		'low',
		'medium',
		'high',
		'xhigh',
		'max'
	]);

	const catalog = await fs.readFile(MODEL_CATALOG_PATH, 'utf8');
	const solBlock = catalog.match(
		/model_name: "GPT-5\.6 Sol"[\s\S]*?(?=\n\s*- model_name: "GPT-5\.6 Sol Pro")/
	)?.[0];
	assert.ok(solBlock, 'GPT-5.6 Sol catalog block must exist');
	assert.match(solBlock, /reasoning_effort_options: \["none", "low", "medium", "high", "xhigh", "max", "ultra"\]/);
});

test('frontend model traits assign exactly one guide tier to every catalog model', () => {
	const expectedTraits = new Map([
		['Atlas Sonnet 5', 'general'],
		['Atlas Sonnet 4.6', 'general'],
		['Atlas Opus 5', 'heavy'],
		['Atlas Opus 4.8', 'heavy'],
		['Atlas Haiku 4.5', 'lightweight'],
		['GPT-5.6 Terra', 'general'],
		['GPT-5.6 Sol', 'heavy'],
		['GPT-5.5', 'heavy'],
		['GPT-5.6 Sol Pro', 'premium'],
		['GPT-5.6 Luna', 'lightweight'],
		['Gemini 3.6 Flash', 'general'],
		['Gemini 3.5 Flash', 'general'],
		['Gemini 3.1 Pro Preview', 'premium'],
		['Gemini 3.5 Flash-Lite', 'lightweight'],
		['Gemini 3.1 Flash-Lite', 'lightweight']
	]);
	const expectedProviders = new Map([
		['Atlas Sonnet 5', 'anthropic'],
		['Atlas Sonnet 4.6', 'anthropic'],
		['Atlas Opus 5', 'anthropic'],
		['Atlas Opus 4.8', 'anthropic'],
		['Atlas Haiku 4.5', 'anthropic'],
		['GPT-5.6 Terra', 'openai'],
		['GPT-5.6 Sol', 'openai'],
		['GPT-5.5', 'openai'],
		['GPT-5.6 Sol Pro', 'openai'],
		['GPT-5.6 Luna', 'openai'],
		['Gemini 3.6 Flash', 'google'],
		['Gemini 3.5 Flash', 'google'],
		['Gemini 3.1 Pro Preview', 'google'],
		['Gemini 3.5 Flash-Lite', 'google'],
		['Gemini 3.1 Flash-Lite', 'google']
	]);

	for (const [modelId, expectedTrait] of expectedTraits) {
		const actualTraits = modelTraits.resolveModelTraitKeys({ modelId });
		assert.deepEqual(actualTraits, [expectedTrait], modelId);
		assert.equal(actualTraits.length, 1, `${modelId} must render exactly one guide icon`);
		assert.deepEqual(modelCapabilities.resolveModelPickerMetadata(modelId), {
			pickerProvider: expectedProviders.get(modelId),
			pickerTier: expectedTrait
		});
	}

	assert.deepEqual(modelTraits.MODEL_TRAIT_LEGEND_ORDER, [
		'general',
		'heavy',
		'premium',
		'lightweight'
	]);
	assert.deepEqual(
		modelTraits.MODEL_TRAIT_LEGEND_ORDER.map(
			(trait) => modelTraits.MODEL_TRAIT_DEFINITIONS[trait].label
		),
		['Everyday', 'Heavy', 'Extreme', 'Lightweight']
	);
});

test('frontend picker presentation metadata is generated from the root model catalog', async () => {
	const traitsSource = await fs.readFile(
		path.join(REPO_ROOT, 'src/patches/frontend/src/lib/config/model-traits.ts'),
		'utf8'
	);
	const selectorSource = await fs.readFile(MODEL_SELECTOR_SVELTE_PATH, 'utf8');

	assert.doesNotMatch(traitsSource, /MODEL_TRAIT_ASSIGNMENTS/);
	assert.match(traitsSource, /resolveModelPickerMetadata/);
	assert.match(selectorSource, /const catalogProvider = resolveModelPickerMetadata\(/);
	assert.deepEqual(
		modelCapabilities.resolveModelPickerMetadata('portico-openai/gpt-5.6-sol:latest'),
		{ pickerProvider: 'openai', pickerTier: 'heavy' }
	);
	assert.deepEqual(
		modelCapabilities.resolveModelPickerMetadata('us.anthropic.atlas-sonnet-5'),
		{ pickerProvider: 'anthropic', pickerTier: 'general' }
	);
});

test('frontend model traits preserve exact aliases and derived-agent base model inheritance', () => {
	assert.deepEqual(
		modelTraits.resolveModelTraitKeys({ baseModelId: 'us.anthropic.atlas-sonnet-5' }),
		['general']
	);
	assert.deepEqual(
		modelTraits.resolveModelTraitKeys({ modelId: 'openai/GPT-5.6 Sol Pro:latest' }),
		['premium']
	);
	assert.deepEqual(
		modelTraits.resolveModelTraitKeysForModel({
			id: 'workspace-agent',
			info: { base_model_id: 'openai/GPT-5.6 Sol Pro:latest' }
		}),
		['premium']
	);
});

test('frontend and Electron pricing tables include GPT-5.5 list prices', () => {
	const frontendPricing = modelPricing.resolveModelPricing('GPT-5.5');
	const electronPricing = require('../electron-app/src/services/model-pricing').resolveModelPricing('GPT-5.5');

	for (const pricing of [frontendPricing, electronPricing]) {
		assert.equal(pricing.displayName, 'GPT-5.5');
		assert.equal(pricing.inputPerMillion, 5);
		assert.equal(pricing.cacheReadPerMillion, 0.5);
		assert.equal(pricing.outputPerMillion, 30);
	}
});

test('Rust, frontend, and Electron GPT-5.6 pricing share one rate fixture', () => {
	const electronModelPricing = require('../electron-app/src/services/model-pricing');

	for (const { displayName, base, highContext } of GPT_56_PRICING.models) {
		const frontendPricing = modelPricing.resolveModelPricing(displayName);
		const electronPricing = electronModelPricing.resolveModelPricing(displayName);

		for (const pricing of [frontendPricing, electronPricing]) {
			assert.equal(pricing.displayName, displayName);
			assert.equal(pricing.inputPerMillion, base.inputPerMillion);
			assert.equal(pricing.outputPerMillion, base.outputPerMillion);
			assert.equal(pricing.cacheReadPerMillion, base.cacheReadPerMillion);
			assert.equal(pricing.cacheWritePerMillion, base.cacheWritePerMillion);
			assert.equal(
				pricing.highContext.thresholdPromptTokens,
				GPT_56_PRICING.thresholdPromptTokens
			);
			assert.equal(pricing.highContext.inputPerMillion, highContext.inputPerMillion);
			assert.equal(pricing.highContext.outputPerMillion, highContext.outputPerMillion);
			assert.equal(
				pricing.highContext.cacheReadPerMillion,
				highContext.cacheReadPerMillion
			);
			assert.equal(
				pricing.highContext.cacheWritePerMillion,
				highContext.cacheWritePerMillion
			);
		}
	}

	assert.equal(
		modelPricing.resolveModelPricing('portico-openai/gpt-5.6-terra').displayName,
		'GPT-5.6 Terra'
	);
});

test('GPT-5.6 costs use base rates through 272K and high-context rates above it', () => {
	const electronModelPricing = require('../electron-app/src/services/model-pricing');
	const perMillion = 1_000_000;
	const roundCurrency = (value) =>
		Math.round((value + Number.EPSILON) * perMillion) / perMillion;

	for (const { displayName, base, highContext } of GPT_56_PRICING.models) {
		for (const promptTokens of GPT_56_PRICING.promptTokenCases) {
			const rates =
				promptTokens > GPT_56_PRICING.thresholdPromptTokens ? highContext : base;
			const nonCachedPromptTokens =
				promptTokens - GPT_56_PRICING.cacheReadTokens - GPT_56_PRICING.cacheWriteTokens;
			const expectedCost = roundCurrency(
				(nonCachedPromptTokens / perMillion) * rates.inputPerMillion +
					(GPT_56_PRICING.completionTokens / perMillion) * rates.outputPerMillion +
					(GPT_56_PRICING.cacheReadTokens / perMillion) * rates.cacheReadPerMillion +
					(GPT_56_PRICING.cacheWriteTokens / perMillion) * rates.cacheWritePerMillion
			);
			const input = {
				modelId: displayName,
				promptTokens,
				completionTokens: GPT_56_PRICING.completionTokens,
				cachedTokens: GPT_56_PRICING.cacheReadTokens,
				cacheWriteInputTokens: GPT_56_PRICING.cacheWriteTokens
			};
			const frontendMetrics = modelPricing.calculatePromptCacheMetrics(input);
			const electronMetrics = electronModelPricing.calculatePromptCacheMetrics(input);

			for (const metrics of [frontendMetrics, electronMetrics]) {
				assert.equal(
					metrics.estimatedActualCost,
					expectedCost,
					`${displayName} promptTokens=${promptTokens}`
				);
				assert.equal(metrics.cacheReadTokens, GPT_56_PRICING.cacheReadTokens);
				assert.equal(metrics.cacheWriteTokens, GPT_56_PRICING.cacheWriteTokens);
				assert.equal(
					metrics.actualCacheReadCost,
					roundCurrency(
						(GPT_56_PRICING.cacheReadTokens / perMillion) * rates.cacheReadPerMillion
					)
				);
				assert.equal(
					metrics.actualCacheWriteCost,
					roundCurrency(
						(GPT_56_PRICING.cacheWriteTokens / perMillion) * rates.cacheWritePerMillion
					)
				);
			}
			assert.deepEqual(frontendMetrics, electronMetrics);
		}
	}
});

test('frontend and Electron pricing tables include Atlas Opus 4.8 list prices', () => {
	const electronModelPricing = require('../electron-app/src/services/model-pricing');
	const frontendPricing = modelPricing.resolveModelPricing('Atlas Opus 4.8');
	const frontendBedrockPricing = modelPricing.resolveModelPricing(
		'us.anthropic.atlas-opus-4-8-v1:0'
	);
	const electronPricing = electronModelPricing.resolveModelPricing(
		'bedrock/converse_like/us.anthropic.atlas-opus-4-8'
	);

	for (const pricing of [frontendPricing, frontendBedrockPricing, electronPricing]) {
		assert.equal(pricing.displayName, 'Atlas Opus 4.8');
		assert.equal(pricing.inputPerMillion, 5);
		assert.equal(pricing.cacheReadPerMillion, 0.5);
		assert.equal(pricing.cacheWritePerMillion, 6.25);
		assert.equal(pricing.outputPerMillion, 25);
	}
});

test('frontend and Electron pricing tables include Atlas Opus 5 list prices', () => {
	const electronModelPricing = require('../electron-app/src/services/model-pricing');
	const frontendPricing = modelPricing.resolveModelPricing('Atlas Opus 5');
	const frontendBedrockPricing = modelPricing.resolveModelPricing(
		'us.anthropic.atlas-opus-5'
	);
	const electronPricing = electronModelPricing.resolveModelPricing(
		'bedrock/converse_like/us.anthropic.atlas-opus-5'
	);

	for (const pricing of [frontendPricing, frontendBedrockPricing, electronPricing]) {
		assert.equal(pricing.displayName, 'Atlas Opus 5');
		assert.equal(pricing.inputPerMillion, 5);
		assert.equal(pricing.cacheReadPerMillion, 0.5);
		assert.equal(pricing.cacheWritePerMillion, 6.25);
		assert.equal(pricing.outputPerMillion, 25);
	}

	// Opus 4.5-era ids must not resolve to the Opus 5 spec.
	assert.notEqual(
		modelPricing.resolveModelPricing('us.anthropic.atlas-opus-4-5-20251101-v1:0')
			?.displayName,
		'Atlas Opus 5'
	);
});

test('frontend and Electron pricing tables include Atlas Sonnet 5 list prices', () => {
	const electronModelPricing = require('../electron-app/src/services/model-pricing');
	const frontendPricing = modelPricing.resolveModelPricing('Atlas Sonnet 5');
	const frontendBedrockPricing = modelPricing.resolveModelPricing(
		'us.anthropic.atlas-sonnet-5'
	);
	const electronPricing = electronModelPricing.resolveModelPricing(
		'bedrock/converse_like/us.anthropic.atlas-sonnet-5'
	);

	for (const pricing of [frontendPricing, frontendBedrockPricing, electronPricing]) {
		assert.equal(pricing.displayName, 'Atlas Sonnet 5');
		assert.equal(pricing.inputPerMillion, 3);
		assert.equal(pricing.cacheReadPerMillion, 0.3);
		assert.equal(pricing.cacheWritePerMillion, 3.75);
		assert.equal(pricing.outputPerMillion, 15);
	}

	// Sonnet 4.5-era ids must not resolve to the Sonnet 5 spec.
	assert.notEqual(
		modelPricing.resolveModelPricing('us.anthropic.atlas-sonnet-4-5-20250929-v1:0')
			?.displayName,
		'Atlas Sonnet 5'
	);
});

test('frontend and Electron pricing tables include Gemini Priority PayGo rates', () => {
	const electronModelPricing = require('../electron-app/src/services/model-pricing');
	const frontendFlash = modelPricing.resolveModelPricing('Gemini 3.5 Flash');
	const electronFlash = electronModelPricing.resolveModelPricing('Gemini 3.5 Flash');
	const frontendPro = modelPricing.resolveModelPricing('gemini/vertex/gemini-3.1-pro-preview');
	const electronPro = electronModelPricing.resolveModelPricing('gemini/vertex/gemini-3.1-pro-preview');
	const frontendLite = modelPricing.resolveModelPricing('Gemini 3.1 Flash-Lite');
	const electronLite = electronModelPricing.resolveModelPricing('Gemini 3.1 Flash-Lite');

	for (const pricing of [frontendFlash, electronFlash]) {
		assert.equal(pricing.displayName, 'Gemini 3.5 Flash');
		assert.equal(pricing.inputPerMillion, 2.7);
		assert.equal(pricing.cacheReadPerMillion, 0.27);
		assert.equal(pricing.outputPerMillion, 16.2);
	}
	for (const pricing of [frontendPro, electronPro]) {
		assert.equal(pricing.displayName, 'Gemini 3.1 Pro Preview');
		assert.equal(pricing.inputPerMillion, 3.6);
		assert.equal(pricing.cacheReadPerMillion, 0.36);
		assert.equal(pricing.outputPerMillion, 21.6);
		assert.equal(pricing.highContext.thresholdPromptTokens, 200000);
		assert.equal(pricing.highContext.inputPerMillion, 7.2);
	}
	for (const pricing of [frontendLite, electronLite]) {
		assert.equal(pricing.displayName, 'Gemini 3.1 Flash-Lite');
		assert.equal(pricing.inputPerMillion, 0.45);
		assert.equal(pricing.cacheReadPerMillion, 0.045);
		assert.equal(pricing.outputPerMillion, 2.7);
	}

	const frontend36Flash = modelPricing.resolveModelPricing('Gemini 3.6 Flash');
	const electron36Flash = electronModelPricing.resolveModelPricing('Gemini 3.6 Flash');
	for (const pricing of [frontend36Flash, electron36Flash]) {
		assert.equal(pricing.displayName, 'Gemini 3.6 Flash');
		assert.equal(pricing.inputPerMillion, 2.7);
		assert.equal(pricing.cacheReadPerMillion, 0.27);
		assert.equal(pricing.outputPerMillion, 13.5);
	}

	const frontend35Lite = modelPricing.resolveModelPricing(
		'gemini/vertex/gemini-3.5-flash-lite'
	);
	const electron35Lite = electronModelPricing.resolveModelPricing(
		'gemini/vertex/gemini-3.5-flash-lite'
	);
	for (const pricing of [frontend35Lite, electron35Lite]) {
		assert.equal(pricing.displayName, 'Gemini 3.5 Flash-Lite');
		assert.equal(pricing.inputPerMillion, 0.54);
		assert.equal(pricing.cacheReadPerMillion, 0.054);
		assert.equal(pricing.outputPerMillion, 4.5);
	}

	// Fuzzy-matcher shadowing regression: /\bgemini 3 5 flash\b/ also matches
	// "gemini 3 5 flash lite" strings, so the Lite spec must win for Lite ids
	// that miss the exact-alias map (table order pins this).
	for (const pricingModule of [modelPricing, electronModelPricing]) {
		assert.equal(
			pricingModule.resolveModelPricing('my-agent (gemini-3.5-flash-lite)')?.displayName,
			'Gemini 3.5 Flash-Lite'
		);
		assert.equal(
			pricingModule.resolveModelPricing('my-agent (gemini-3.5-flash)')?.displayName,
			'Gemini 3.5 Flash'
		);
		assert.equal(
			pricingModule.resolveModelPricing('my-agent (gemini-3.6-flash)')?.displayName,
			'Gemini 3.6 Flash'
		);
	}

	const frontendMetrics = modelPricing.calculatePromptCacheMetrics({
		modelId: 'gemini-3.1-pro-preview',
		promptTokens: 250000,
		completionTokens: 1000,
		cachedTokens: 50000
	});
	const electronMetrics = electronModelPricing.calculatePromptCacheMetrics({
		modelId: 'gemini-3.1-pro-preview',
		promptTokens: 250000,
		completionTokens: 1000,
		cachedTokens: 50000
	});

	assert.equal(frontendMetrics.estimatedActualCost, 1.5084);
	assert.equal(electronMetrics.estimatedActualCost, 1.5084);
	assert.equal(frontendMetrics.cacheReadTokens, 50000);
});

test('frontend model traits do not assign capability badges to LM Studio local models', () => {
	assert.deepEqual(
		modelTraits.resolveModelTraitKeysForModel({
			id: 'GPT-OSS local',
			meta: { local_provider: 'lm_studio' },
			info: { meta: { local_provider: 'lm_studio' } }
		}),
		[]
	);
});

test('frontend selector logo presentation keeps Atlas and OpenAI footprints aligned', () => {
	const atlasCompact = modelBranding.getModelSelectorLogoPresentation(
		{ id: 'Atlas Sonnet 4.6' },
		'compact'
	);
	const openaiCompact = modelBranding.getModelSelectorLogoPresentation(
		{ id: 'GPT-5.5' },
		'compact'
	);
	const atlasGrouped = modelBranding.getModelSelectorLogoPresentation(
		{ id: 'Atlas Sonnet 4.6' },
		'grouped'
	);
	const openaiGrouped = modelBranding.getModelSelectorLogoPresentation(
		{ id: 'GPT-5.5' },
		'grouped'
	);

	assert.equal(atlasCompact.outerSizeClass, 'size-5');
	assert.equal(openaiCompact.outerSizeClass, 'size-5');
	assert.equal(atlasCompact.outerSizeClass, openaiCompact.outerSizeClass);
	assert.equal(atlasGrouped.outerSizeClass, 'size-7');
	assert.equal(openaiGrouped.outerSizeClass, 'size-7');
	assert.equal(atlasGrouped.outerSizeClass, openaiGrouped.outerSizeClass);
	assert.equal(openaiCompact.needsDarkBadge, true);
	assert.equal(atlasCompact.needsDarkBadge, false);
	assert.equal(openaiCompact.imageClassName, atlasCompact.imageClassName);
	assert.match(openaiCompact.wrapperClassName, /\bbg-black\b/);
	assert.match(atlasCompact.wrapperClassName, /\bbg-transparent\b/);
});

test('frontend celestial model branding uses exact self-contained logos without OpenAI badges', () => {
	const cases = [
		[{ id: 'GPT-5.6 Sol' }, 'sol', '/sol.png'],
		[{ id: 'GPT-5.6 Sol Pro:latest' }, 'sol', '/sol.png'],
		[{ id: 'openai/responses/gpt-5.6-terra:latest' }, 'terra', '/terra.png'],
		[{ id: 'portico-openai/gpt-5.6-luna' }, 'luna', '/luna.png'],
		[
			{
				id: 'catalog-terra',
				litellm_params: { model: 'openai/responses/gpt-5.6-terra' }
			},
			'terra',
			'/terra.png'
		]
	];

	for (const [candidate, identity, logoSrc] of cases) {
		assert.equal(modelBranding.getCelestialModelIdentity(candidate), identity);
		assert.equal(modelBranding.getStaticModelLogoSrc(candidate), logoSrc);
		assert.equal(modelBranding.usesCelestialModelLogo(candidate), true);
		assert.equal(modelBranding.usesDarkLogoBadgeInLightMode(candidate), false);
		const presentation = modelBranding.getModelSelectorLogoPresentation(candidate, 'compact');
		assert.equal(presentation.needsDarkBadge, false);
		assert.match(presentation.wrapperClassName, /\bbg-transparent\b/);
		assert.doesNotMatch(presentation.wrapperClassName, /\bbg-black\b/);
		assert.match(presentation.imageClassName, /\bcelestial-model-logo\b/);
	}

	assert.equal(modelBranding.getCelestialModelIdentity({ id: 'GPT-5.5' }), null);
	assert.equal(modelBranding.usesCelestialModelLogo({ id: 'GPT-5.5' }), false);
	assert.equal(modelBranding.getStaticModelLogoSrc({ id: 'GPT-5.5' }), '/gpt.png');
	assert.equal(modelBranding.usesDarkLogoBadgeInLightMode({ id: 'GPT-5.5' }), true);
	assert.doesNotMatch(
		modelBranding.getModelSelectorLogoPresentation({ id: 'GPT-5.5' }, 'compact').imageClassName,
		/\bcelestial-model-logo\b/
	);
	assert.equal(modelBranding.getCelestialModelIdentity({ id: 'my-gpt-5.6-sol-agent' }), null);
});

test('frontend celestial model branding preserves derived workspace-agent profile images', () => {
	const derivedAgent = {
		id: 'portico_agent_custom',
		name: 'GPT-5.6 Sol',
		info: { base_model_id: 'GPT-5.6 Sol', updated_at: 456 }
	};

	assert.equal(modelBranding.getCelestialModelIdentity(derivedAgent), null);
	assert.equal(modelBranding.getStaticModelLogoSrc(derivedAgent), null);
	assert.deepEqual(
		modelBranding.getModelLogoSources(derivedAgent, '/api', 'en', '/static/favicon.png'),
		{
			light: '/api/models/model/profile/image?id=portico_agent_custom&lang=en&v=456',
			dark: null,
			isLocal: false
		}
	);
});

test('frontend selector logo presentation treats LM Studio models as local, not OpenAI', () => {
	const localCompact = modelBranding.getModelSelectorLogoPresentation(
		{ id: 'GPT-OSS local', meta: { local_provider: 'lm_studio' } },
		'compact'
	);

	assert.equal(modelBranding.getModelBrandFamily({ id: 'GPT-OSS local', meta: { local_provider: 'lm_studio' } }), 'local');
	assert.equal(localCompact.outerSizeClass, 'size-6');
	assert.equal(localCompact.needsDarkBadge, false);
	assert.match(localCompact.wrapperClassName, /\bbg-transparent\b/);
});

test('frontend selector logo presentation treats Gemini models as Google first-party models', () => {
	const geminiCompact = modelBranding.getModelSelectorLogoPresentation(
		{ id: 'Gemini 3.5 Flash' },
		'compact'
	);

	assert.equal(modelBranding.getModelBrandFamily({ id: 'Gemini 3.5 Flash' }), 'google');
	assert.equal(
		modelBranding.getModelBrandFamily({
			label: 'Gemini 3.5 Flash',
			model: {
				id: 'Gemini 3.5 Flash',
				owned_by: 'openai'
			}
		}),
		'google'
	);
	assert.equal(modelBranding.getStaticModelLogoSrc({ id: 'gemini-3.1-pro-preview' }), '/gemini.png');
	assert.equal(
		modelBranding.getStaticModelLogoSrc({
			id: 'portico_gemini_agent',
			name: 'Workspace summary',
			owned_by: 'openai',
			info: { base_model: 'gemini-3.1-flash-lite' }
		}),
		null
	);
	assert.equal(
		modelBranding.getStaticModelLogoSrc({
			id: 'gemini/vertex/gemini-3.5-flash',
			label: 'Gemini 3.5 Flash',
			model: {
				id: 'gemini/vertex/gemini-3.5-flash',
				info: { base_model_id: 'gemini-3.5-flash' }
			}
		}),
		null
	);
	assert.equal(geminiCompact.outerSizeClass, 'size-5');
	assert.equal(geminiCompact.needsDarkBadge, false);
	assert.match(geminiCompact.wrapperClassName, /\bbg-transparent\b/);
});

test('frontend local model branding hides embeddings and returns theme-aware local logos', () => {
	const localChat = { id: 'google/gemma-4-e4b', meta: { local_provider: 'lm_studio' } };
	const localEmbedding = { id: 'text-embedding-nomic-embed-text-v1.5', meta: { local_provider: 'lm_studio' } };

	assert.equal(modelBranding.isLocalEmbeddingModelCandidate(localChat), false);
	assert.equal(modelBranding.isLocalEmbeddingModelCandidate(localEmbedding), true);

	const logoSources = modelBranding.getModelLogoSources(
		localChat,
		'/api',
		'en',
		'/static/favicon.png'
	);
	assert.deepEqual(logoSources, {
		light: '/local-model-light.svg',
		dark: '/local-model-dark.svg',
		isLocal: true
	});
});

test('frontend model logo sources use static first-party assets before profile image endpoint', async () => {
	assert.deepEqual(
		modelBranding.getModelLogoSources({ id: 'Atlas Sonnet 4.6' }, '/api', 'en', '/static/favicon.png'),
		{
			light: '/atlas.png',
			dark: null,
			isLocal: false
		}
	);
	assert.deepEqual(
		modelBranding.getModelLogoSources({ id: 'GPT-5.6 Sol' }, '/api', 'en', '/static/favicon.png'),
		{
			light: '/sol.png',
			dark: null,
			isLocal: false
		}
	);
	assert.equal(modelBranding.getStaticModelLogoSrc({ id: 'GPT-5.6 Sol Pro' }), '/sol.png');
	assert.equal(modelBranding.getStaticModelLogoSrc({ id: 'GPT-5.6 Terra' }), '/terra.png');
	assert.equal(modelBranding.getStaticModelLogoSrc({ id: 'GPT-5.6 Luna' }), '/luna.png');
	assert.equal(modelBranding.getStaticModelLogoSrc({ id: 'GPT-5.5' }), '/gpt.png');
	assert.deepEqual(
		modelBranding.getModelLogoSources({ id: 'Gemini 3.5 Flash' }, '/api', 'en', '/static/favicon.png'),
		{
			light: '/gemini.png',
			dark: null,
			isLocal: false
		}
	);
	assert.deepEqual(
		modelBranding.getModelLogoSources(
			{
				label: 'Gemini 3.1 Pro Preview',
				model: {
					id: 'Gemini 3.1 Pro Preview',
					owned_by: 'openai'
				}
			},
			'/api',
			'en',
			'/static/favicon.png'
		),
		{
			light: '/gemini.png',
			dark: null,
			isLocal: false
		}
	);
	assert.deepEqual(
		modelBranding.getModelLogoSources(
			{
				id: 'gemini/vertex/gemini-3.5-flash',
				label: 'Gemini 3.5 Flash',
				model: {
					id: 'gemini/vertex/gemini-3.5-flash',
					info: { base_model_id: 'gemini-3.5-flash' }
				}
			},
			'/api',
			'en',
			'/static/favicon.png'
		),
		{
			light: '/api/models/model/profile/image?id=gemini%2Fvertex%2Fgemini-3.5-flash&lang=en',
			dark: null,
			isLocal: false
		}
	);
	assert.equal(modelBranding.usesStaticModelLogo({ id: 'Atlas Sonnet 4.6' }), true);
	assert.equal(
		modelBranding.usesStaticModelLogo({
			id: 'portico_agent_custom',
			name: 'Custom GPT agent',
			info: { base_model_id: 'GPT-5.6 Sol' }
		}),
		false
	);

	assert.deepEqual(
		modelBranding.getModelLogoSources(
			{ id: 'custom-model', name: 'Custom Model', info: { updated_at: 456 } },
			'/api',
			'en',
			'/static/favicon.png'
		),
		{
			light: '/api/models/model/profile/image?id=custom-model&lang=en&v=456',
			dark: null,
			isLocal: false
		}
	);
	assert.deepEqual(
		modelBranding.getModelLogoSources(
			{ id: 'unversioned-custom-model', name: 'Custom Model' },
			'/api',
			'en',
			'/static/favicon.png'
		),
		{
			light: '/api/models/model/profile/image?id=unversioned-custom-model&lang=en',
			dark: null,
			isLocal: false
		}
	);
	assert.equal(
		modelLogoCache.buildModelLogoUrl('/api/', 'custom model', 'en-US', 'version 1'),
		'/api/models/model/profile/image?id=custom%20model&lang=en-US&v=version%201'
	);

	await fs.access(path.join(REPO_ROOT, 'src/patches/frontend/static/atlas.png'));
	await fs.access(path.join(REPO_ROOT, 'src/patches/frontend/static/gpt.png'));
	await fs.access(path.join(REPO_ROOT, 'src/patches/frontend/static/gemini.png'));
	for (const assetName of ['sol.png', 'terra.png', 'luna.png']) {
		const frontendAsset = await fs.readFile(
			path.join(REPO_ROOT, 'src/patches/frontend/static', assetName)
		);
		const electronAsset = await fs.readFile(path.join(REPO_ROOT, 'electron-app/assets', assetName));
		assert.equal(frontendAsset.readUInt32BE(16), 1024, `${assetName} width`);
		assert.equal(frontendAsset.readUInt32BE(20), 1024, `${assetName} height`);
		const colorType = frontendAsset[25];
		assert.ok(
			colorType === 4 ||
				colorType === 6 ||
				(colorType === 3 && frontendAsset.includes(Buffer.from('tRNS'))),
			`${assetName} must preserve alpha transparency`
		);
		assert.ok(
			frontendAsset.includes(Buffer.from('sRGB')) ||
				frontendAsset.includes(Buffer.from('iCCP')),
			`${assetName} must include explicit sRGB color metadata`
		);
		assert.deepEqual(frontendAsset, electronAsset, `${assetName} must match in both asset roots`);
	}
	assert.deepEqual(
		await fs.readFile(path.join(REPO_ROOT, 'src/patches/frontend/static/gemini.png')),
		await fs.readFile(path.join(REPO_ROOT, 'electron-app/assets/gemini.png'))
	);

	const modelBrandingSource = await fs.readFile(
		path.join(REPO_ROOT, 'src/patches/frontend/src/lib/utils/modelBranding.ts'),
		'utf8'
	);
	const obsoleteGeminiLogo = ['google', 'gemini'].join('-') + '.svg';
	assert.equal(modelBrandingSource.includes(obsoleteGeminiLogo), false);
});

test('frontend chat navbar does not preload model logos on tab open', async () => {
	const navbarSource = await fs.readFile(NAVBAR_SVELTE_PATH, 'utf8');

	assert.doesNotMatch(navbarSource, /preloadModelLogos/);
	assert.doesNotMatch(navbarSource, /modelLogoPreloadScheduled/);
	assert.doesNotMatch(navbarSource, /modelLogoCache/);
});

test('frontend model logo cache dedupes requests and persists only versioned dynamic logos', async () => {
	const originalFetch = global.fetch;
	const originalCaches = global.caches;
	const originalCreateObjectUrl = URL.createObjectURL;
	const originalRevokeObjectUrl = URL.revokeObjectURL;
	const storedResponses = new Map();
	const matchedUrls = [];
	const putUrls = [];
	let fetchedUrls = [];
	let objectUrlCount = 0;

	const cache = {
		match: async (url) => {
			matchedUrls.push(String(url));
			return storedResponses.get(String(url))?.clone();
		},
		put: async (url, response) => {
			putUrls.push(String(url));
			storedResponses.set(String(url), response.clone());
		}
	};

	global.fetch = async (url) => {
		fetchedUrls.push(String(url));
		return new Response(new Blob([`network:${url}`], { type: 'image/png' }), { status: 200 });
	};
	global.caches = {
		open: async (name) => {
			assert.equal(name, 'open-webui-model-logos-v1');
			return cache;
		}
	};
	URL.createObjectURL = () => `blob:model-logo-${++objectUrlCount}`;
	URL.revokeObjectURL = () => {};

	try {
		const versionedUrl = modelLogoCache.buildModelLogoUrl('/api', 'custom-model', 'en', '123');
		const versionedCacheKey = modelLogoCache.getModelLogoCacheKey('custom-model', 'en', '123');
		const [firstLogoUrl, secondLogoUrl] = await Promise.all([
			modelLogoCache.fetchAndCacheModelLogo(versionedUrl, versionedCacheKey),
			modelLogoCache.fetchAndCacheModelLogo(versionedUrl, versionedCacheKey)
		]);
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(firstLogoUrl, 'blob:model-logo-1');
		assert.equal(secondLogoUrl, 'blob:model-logo-1');
		assert.deepEqual(fetchedUrls, ['/api/models/model/profile/image?id=custom-model&lang=en&v=123']);
		assert.deepEqual(putUrls, ['/api/models/model/profile/image?id=custom-model&lang=en&v=123']);
		assert.equal(modelLogoCache.getCachedModelLogoUrl(versionedCacheKey), 'blob:model-logo-1');

		const storedUrl = modelLogoCache.buildModelLogoUrl('/api', 'stored-model', 'en', '456');
		storedResponses.set(
			storedUrl,
			new Response(new Blob(['stored'], { type: 'image/png' }), { status: 200 })
		);
		const storedLogoUrl = await modelLogoCache.fetchAndCacheModelLogo(
			storedUrl,
			modelLogoCache.getModelLogoCacheKey('stored-model', 'en', '456')
		);
		assert.equal(storedLogoUrl, 'blob:model-logo-2');
		assert.deepEqual(fetchedUrls, ['/api/models/model/profile/image?id=custom-model&lang=en&v=123']);
		assert.ok(matchedUrls.includes('/api/models/model/profile/image?id=stored-model&lang=en&v=456'));

		const unversionedUrl = modelLogoCache.buildModelLogoUrl('/api', 'unversioned-model', 'en');
		const unversionedCacheKey = modelLogoCache.getModelLogoCacheKey('unversioned-model', 'en');
		await modelLogoCache.fetchAndCacheModelLogo(
			unversionedUrl,
			unversionedCacheKey
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.deepEqual(fetchedUrls, [
			'/api/models/model/profile/image?id=custom-model&lang=en&v=123',
			'/api/models/model/profile/image?id=unversioned-model&lang=en'
		]);
		assert.deepEqual(putUrls, ['/api/models/model/profile/image?id=custom-model&lang=en&v=123']);
		assert.equal(modelLogoCache.getCachedModelLogoUrl(unversionedCacheKey), undefined);
	} finally {
		global.fetch = originalFetch;
		if (originalCaches) {
			global.caches = originalCaches;
		} else {
			delete global.caches;
		}
		if (originalCreateObjectUrl) {
			URL.createObjectURL = originalCreateObjectUrl;
		} else {
			delete URL.createObjectURL;
		}
		if (originalRevokeObjectUrl) {
			URL.revokeObjectURL = originalRevokeObjectUrl;
		} else {
			delete URL.revokeObjectURL;
		}
	}
});

test('backend model profile image endpoint only caches versioned requests', async () => {
	const source = await fs.readFile(BACKEND_MAIN_PATH, 'utf8');

	assert.match(source, /MODEL_PROFILE_IMAGE_PATH_SUFFIX = "\/models\/model\/profile\/image"/);
	assert.match(source, /MODEL_PROFILE_IMAGE_CACHE_CONTROL = "private, max-age=86400"/);
	assert.match(
		source,
		/request\.url\.path\.endswith\(MODEL_PROFILE_IMAGE_PATH_SUFFIX\)[\s\S]*request\.query_params\.get\("v"\)[\s\S]*response\.headers\["Cache-Control"\] = MODEL_PROFILE_IMAGE_CACHE_CONTROL/
	);
	assert.match(source, /_add_vary_headers\(response, \["Cookie", "Authorization"\]\)/);
	assert.doesNotMatch(source, /stale-while-revalidate=604800/);
});

test('backend default model config falls back to Atlas Sonnet 5', async () => {
	const source = await fs.readFile(BACKEND_MAIN_PATH, 'utf8');

	assert.match(source, /DEFAULT_CHAT_MODEL_ID = "Atlas Sonnet 5"/);
	assert.match(source, /def resolve_default_models_config\(default_models\):/);
	assert.match(
		source,
		/value = getattr\(default_models, "value", default_models\)/
	);
	assert.match(
		source,
		/DEFAULT_MODELS\.value = resolve_default_models_config\(DEFAULT_MODELS\)[\s\S]*app\.state\.config\.DEFAULT_MODELS = DEFAULT_MODELS/
	);
	assert.match(
		source,
		/resolve_default_models_config\(\s*request\.app\.state\.config\.DEFAULT_MODELS\s*\)\.split\(","\)/
	);
});

test('grouped desktop model selector uses adaptive compact provider columns', async () => {
	const [source, appCss] = await Promise.all([
		fs.readFile(MODEL_SELECTOR_SVELTE_PATH, 'utf8'),
		fs.readFile(APP_CSS_PATH, 'utf8')
	]);
	const groupedLayoutStart = source.indexOf('{#if useGroupedBaseModelLayout}');
	const groupedLayoutEnd = source.indexOf('{:else if useSideGuideLayout}', groupedLayoutStart);

	assert.notEqual(groupedLayoutStart, -1);
	assert.notEqual(groupedLayoutEnd, -1);
	assert.match(source, /const DEFAULT_MODEL_SELECTOR_CLASS_NAME = 'w-\[56rem\]';/);
	assert.match(source, /const THREE_PROVIDER_MODEL_SELECTOR_CLASS_NAME = 'w-\[68rem\]';/);
	assert.match(source, /const FOUR_PROVIDER_MODEL_SELECTOR_CLASS_NAME = 'w-\[84rem\]';/);
	assert.match(source, /export let className = DEFAULT_MODEL_SELECTOR_CLASS_NAME;/);

	const groupedSegment = source.slice(groupedLayoutStart, groupedLayoutEnd);
	assert.match(source, /groupedBaseModelLayoutClass = shouldStackModelGuide/);
	assert.match(source, /grid gap-3 pb-2 grid-cols-\[minmax\(0,1fr\)_14\.5rem\]/);
	assert.match(
		source,
		/groupedBaseModelSections\.length >= 4[\s\S]*FOUR_PROVIDER_MODEL_SELECTOR_CLASS_NAME[\s\S]*groupedBaseModelSections\.length === 3[\s\S]*THREE_PROVIDER_MODEL_SELECTOR_CLASS_NAME/
	);
	assert.match(source, /groupedBaseModelSections\.length >= 4[\s\S]*'md:grid-cols-4'/);
	assert.match(
		source,
		/groupedBaseModelSections\.length === 3[\s\S]*'md:grid-cols-\[1fr_0\.95fr_0\.86fr\]'/
	);
	assert.match(source, /groupedBaseModelSections\.length === 2[\s\S]*'md:grid-cols-2'/);
	assert.match(source, /modelSelectorContentClassName/);
	assert.match(source, /COMPOSER_MODEL_SELECTOR_WIDTH_REM = 68/);
	assert.match(source, /composer[\s\S]*\? 'w-\[68rem\]'/);
	assert.match(source, /composer[\s\S]*\? 'grid gap-4 pb-3 grid-cols-\[minmax\(0,1fr\)_11\.25rem\]'/);
	assert.match(source, /class="space-y-1"/);
	assert.match(appCss, /\.model-selector-content\.is-composer-model-selector \.model-selector-group-item\s*\{[^}]*min-height:\s*2\.75rem;/s);
	assert.match(groupedSegment, /model-selector-sections grid/);
	assert.match(groupedSegment, /md:divide-x md:divide-y-0/);
	assert.match(groupedSegment, /class=\{groupedBaseModelLayoutClass\}/);
	assert.match(groupedSegment, /model-selector-section min-w-0 self-start/);
	assert.match(
		groupedSegment,
		/model-selector-group-item grid min-h-11 w-full grid-cols-\[minmax\(0,1fr\)_auto\][\s\S]*rounded-lg/
	);
	assert.doesNotMatch(groupedSegment, /rounded-\[1\.7rem\]/);
	assert.match(groupedSegment, /model-selector-group-main flex min-w-0 items-center gap-2\.5 pr-1/);
	assert.match(
		groupedSegment,
		/model-selector-group-actions ml-2 flex shrink-0 items-center gap-1\.5 justify-self-end/
	);
	assert.match(source, /import ModelGuide from '\.\/ModelGuide\.svelte';/);
	assert.equal((source.match(/<ModelGuide/g) ?? []).length, 3);
	assert.doesNotMatch(source, /MODEL_TRAIT_LEGEND_ORDER/);
	assert.match(source, /max-w-\[32rem\]/);
	assert.match(source, /rounded-xl border[\s\S]*modelSelectorContentStyle/);
	assert.doesNotMatch(source, /backdrop-blur/);
	assert.match(
		groupedSegment,
		/model-selector-group-label min-w-0 whitespace-nowrap text-sm leading-tight \{value === entry\.item\.value && !isDisabled \? 'font-bold' : 'font-medium'\}/
	);
	assert.match(groupedSegment, /data-model-picker-label=\{entry\.item\.value\}/);
	assert.doesNotMatch(groupedSegment, /model-selector-group-label[^\n]*\b(?:truncate|text-ellipsis|whitespace-normal)\b/);
	assert.doesNotMatch(groupedSegment, /line-clamp-2 text-sm[\s\S]*entry\.item\.label/);
});

test('model selector constrains wide grouped layout to available trigger space', async () => {
	const [source, guide] = await Promise.all([
		fs.readFile(MODEL_SELECTOR_SVELTE_PATH, 'utf8'),
		fs.readFile(MODEL_GUIDE_SVELTE_PATH, 'utf8')
	]);

	assert.match(source, /MODEL_SELECTOR_CLASS_WIDTHS_PX: Record<string, number>/);
	assert.match(source, /MODEL_SELECTOR_VIEWPORT_PADDING_PX = 16/);
	assert.match(source, /MODEL_SELECTOR_SIDE_GUIDE_MIN_WIDTH_PX = 1040/);
	assert.match(source, /updateModelSelectorAvailableSpace = async \(\) =>/);
	assert.match(source, /composer[\s\S]*\? COMPOSER_MODEL_SELECTOR_WIDTH_REM \* 16/);
	assert.match(source, /modelSelectorContentClassName = modelSelectorConstrainedWidthPx[\s\S]*\? 'w-full'/);

	// The constraint math itself lives in $lib/utils/modelSelectorLayout.ts
	// (Selector.svelte only measures the DOM and applies the result), so it is
	// asserted behaviorally on the bundled util instead of via source pins.
	const layoutConstants = {
		viewportPaddingPx: 16,
		minConstrainedWidthPx: 320,
		sideGuideMinWidthPx: 1040
	};
	const navbarDesiredWidthPx = 84 * 16; // four-provider grouped layout
	const wide = modelSelectorLayout.computeModelSelectorLayout({
		composer: false,
		isMobile: false,
		viewportWidth: 2200,
		triggerLeft: 100,
		triggerTop: 500,
		desiredWidthPx: navbarDesiredWidthPx,
		...layoutConstants
	});
	assert.equal(wide.constrainedWidthPx, null, 'wide viewport leaves the picker unconstrained');
	assert.equal(wide.shouldStackModelGuide, false);
	assert.equal(wide.contentStyle, '');

	const narrow = modelSelectorLayout.computeModelSelectorLayout({
		composer: false,
		isMobile: false,
		viewportWidth: 1200,
		triggerLeft: 300.5,
		triggerTop: 500,
		desiredWidthPx: navbarDesiredWidthPx,
		...layoutConstants
	});
	assert.equal(
		narrow.constrainedWidthPx,
		Math.floor(1200 - 300.5 - 16),
		'narrow viewport caps the picker to the floored space right of the trigger'
	);
	assert.equal(narrow.shouldStackModelGuide, true, 'below 1040px the guide stacks');
	assert.equal(narrow.contentStyle, `width: ${Math.floor(1200 - 300.5 - 16)}px;`);

	const floored = modelSelectorLayout.computeModelSelectorLayout({
		composer: false,
		isMobile: false,
		viewportWidth: 360,
		triggerLeft: 330,
		triggerTop: 500,
		desiredWidthPx: navbarDesiredWidthPx,
		...layoutConstants
	});
	assert.equal(floored.constrainedWidthPx, 320, 'constrained width never drops below the minimum');

	const composerDesktop = modelSelectorLayout.computeModelSelectorLayout({
		composer: true,
		isMobile: false,
		viewportWidth: 900,
		triggerLeft: 24,
		triggerTop: 640,
		desiredWidthPx: 68 * 16,
		...layoutConstants
	});
	assert.equal(
		composerDesktop.constrainedWidthPx,
		900 - 16 * 2,
		'composer picker is capped to the viewport minus both paddings'
	);
	assert.equal(
		composerDesktop.constrainedMaxHeightPx,
		Math.floor(640 - 12 - 16),
		'desktop composer max-height is exactly the space above the trigger'
	);
	assert.equal(
		composerDesktop.contentStyle,
		`width: ${900 - 32}px; max-height: ${Math.floor(640 - 12 - 16)}px;`,
		'style string joins both width and max-height when both are constrained'
	);

	const composerNearTop = modelSelectorLayout.computeModelSelectorLayout({
		composer: true,
		isMobile: false,
		viewportWidth: 900,
		triggerLeft: 24,
		triggerTop: 20,
		desiredWidthPx: 68 * 16,
		...layoutConstants
	});
	assert.equal(composerNearTop.constrainedMaxHeightPx, null, 'no cap when no space above');

	const composerMobile = modelSelectorLayout.computeModelSelectorLayout({
		composer: true,
		isMobile: true,
		viewportWidth: 390,
		triggerLeft: 10,
		triggerTop: 700,
		desiredWidthPx: 68 * 16,
		...layoutConstants
	});
	assert.equal(
		composerMobile.constrainedMaxHeightPx,
		null,
		'mobile keeps the default bottom+flip behavior (no max-height cap)'
	);

	const unknownDesiredWidth = modelSelectorLayout.computeModelSelectorLayout({
		composer: false,
		isMobile: false,
		viewportWidth: 800,
		triggerLeft: 100,
		triggerTop: 500,
		desiredWidthPx: null,
		...layoutConstants
	});
	assert.equal(
		unknownDesiredWidth.constrainedWidthPx,
		null,
		'an unknown natural width fits the available space and never constrains'
	);

	assert.equal(modelSelectorLayout.buildModelSelectorContentStyle(500, null), 'width: 500px;');
	assert.equal(
		modelSelectorLayout.buildModelSelectorContentStyle(null, 400),
		'max-height: 400px;'
	);
	assert.equal(modelSelectorLayout.buildModelSelectorContentStyle(null, null), '');
	assert.match(source, /<svelte:window on:resize=\{updateModelSelectorAvailableSpace\} \/>/);
	assert.match(source, /class="model-selector-content z-\[60\]/);
	assert.match(source, /style=\{modelSelectorContentStyle\}/);
	assert.match(source, /data-composer-model-selector=\{composer \? 'true' : 'false'\}/);
	assert.match(source, /className=\{composer \? 'composer-model-trait-badges shrink-0' : 'shrink-0'\}/);
	assert.match(source, /badgeClassName=\{composer \? 'size-5' : ''\}/);
	assert.match(source, /iconClassName=\{composer \? 'size-3\.5' : 'size-4\.5'\}/);
	assert.match(
		await fs.readFile(APP_CSS_PATH, 'utf8'),
		/\.composer-model-trait-badges \.model-trait-badge\s*\{[^}]*width:\s*1\.25rem;[^}]*height:\s*1\.25rem;/s
	);
	assert.match(source, /side=\{\$mobile \? 'bottom' : composer \? 'top' : 'bottom'\}/);
	assert.match(source, /align=\{composer \? 'center' : 'start'\}/);
	assert.match(source, /collisionPadding=\{12\}/);
	assert.match(source, /compact=\{composer && shouldStackModelGuide\}/);
	assert.match(source, /concise=\{composer\}/);
	assert.match(source, /model-selector-guide-rail/);
	assert.doesNotMatch(source, /model-selector-fixed-guide/);
	assert.match(guide, /model-selector-guide-compact/);
	assert.match(guide, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
	assert.doesNotMatch(source, /shouldStackGroupedBaseModelLayout/);
	assert.match(source, /groupedBaseModelSections\.length >= 4[\s\S]*'md:grid-cols-4'/);
	assert.match(source, /model-selector-sections grid divide-y[\s\S]*md:divide-x md:divide-y-0/);
	assert.match(source, /sideGuideLayoutClass = shouldStackModelGuide/);
});

test('model selector disabled rows do not look selected when current value matches', async () => {
	const [selectorSource, modelItemSource] = await Promise.all([
		fs.readFile(MODEL_SELECTOR_SVELTE_PATH, 'utf8'),
		fs.readFile(MODEL_ITEM_SVELTE_PATH, 'utf8')
	]);
	const combinedSelectorSource = `${selectorSource}\n${modelItemSource}`;

	assert.match(
		modelItemSource,
		/min-w-0 whitespace-normal leading-tight \{value === item\.value && !isDisabled \? 'font-bold' : ''\}/
	);
	assert.match(
		modelItemSource,
		/\{#if value === item\.value && !isDisabled\}[\s\S]*<Check className="size-3" \/>/
	);
	assert.match(
		modelItemSource,
		/\? 'cursor-not-allowed border-transparent bg-transparent text-slate-400 dark:border-transparent dark:bg-transparent dark:text-gray-500'/
	);
	assert.match(modelItemSource, /isDisabled \? 'opacity-50 grayscale' : ''/);
	assert.match(modelItemSource, /getCelestialModelIdentity\(item\) === 'sol'/);
	assert.match(modelItemSource, /modelTraitKeys\.includes\('premium'\)/);
	assert.match(
		modelItemSource,
		/className=\{isDisabled && !keepDisabledTraitBadgeVivid[\s\S]*\? 'shrink-0 opacity-50 grayscale'[\s\S]*: 'shrink-0'\}/
	);

	assert.match(
		selectorSource,
		/model-selector-group-label min-w-0 whitespace-nowrap text-sm leading-tight \{value === entry\.item\.value && !isDisabled \? 'font-bold' : 'font-medium'\}/
	);
	assert.match(
		selectorSource,
		/\{#if value === entry\.item\.value && !isDisabled\}[\s\S]*<Check className="size-3" \/>/
	);
	assert.match(
		selectorSource,
		/\? 'cursor-not-allowed border-transparent bg-transparent text-slate-400 dark:border-transparent dark:bg-transparent dark:text-gray-500'/
	);
	assert.match(selectorSource, /isDisabled \? 'opacity-50 grayscale' : ''/);
	assert.match(selectorSource, /getCelestialModelIdentity\(entry\.item\) === 'sol'/);
	assert.match(selectorSource, /modelTraitKeys\.includes\('premium'\)/);
	assert.match(
		selectorSource,
		/className=\{isDisabled && !keepDisabledTraitBadgeVivid[\s\S]*\? 'shrink-0 opacity-50 grayscale'[\s\S]*: 'shrink-0'\}/
	);
	assert.doesNotMatch(
		combinedSelectorSource,
		/className=\{isDisabled \? 'shrink-0 opacity-50 grayscale' : 'shrink-0'\}/
	);

	assert.doesNotMatch(modelItemSource, /\{#if value === item\.value\}[\s\S]*<Check className="size-3" \/>/);
	assert.doesNotMatch(
		selectorSource,
		/\{#if value === entry\.item\.value\}[\s\S]*<Check className="size-3" \/>/
	);
	assert.doesNotMatch(combinedSelectorSource, /GPT-5\.4 pro/);
});

test('grouped desktop model selector includes local models section and LM Studio warning UI', async () => {
	const source = await fs.readFile(MODEL_SELECTOR_SVELTE_PATH, 'utf8');
	assert.match(source, /providerGroupOrder = \['atlas', 'openai', 'google', 'local'\]/);
	assert.match(source, /google: 'Google'/);
	assert.match(source, /local: 'Local Models'/);
	assert.match(source, /sectionHasLocalWarning/);
	assert.match(source, /LM Studio is not running\. Start LM Studio and enable the local server\./);
	assert.match(source, /const isVisibleFilterTag = \(tagName: string\) => tagName !== 'local models';/);
	assert.match(source, /\.filter\(isVisibleFilterTag\)/);
	assert.match(source, /getModelLogoSources/);
	assert.match(source, /getGroupedItemLogoDarkSrc/);
	assert.match(source, /\{#if !isLocalModel\}[\s\S]*<ModelTraitBadges/);
	assert.match(source, /isLocalEmbeddingModelCandidate/);
});

test('model picker uses shared guide tiers while pinning GPT-5.5 to the OpenAI tail', async () => {
	const source = await fs.readFile(MODEL_SELECTOR_SVELTE_PATH, 'utf8');
	const sortByGuideTier = (modelIds) =>
		modelIds
			.map((id, index) => ({ id, index }))
			.sort((left, right) => {
				const tailRankDifference =
					Number(modelPricing.resolveModelPricing(left.id)?.key === 'gpt-5.5') -
					Number(modelPricing.resolveModelPricing(right.id)?.key === 'gpt-5.5');
				if (tailRankDifference) return tailRankDifference;

				const rankDifference =
					modelTraits.getModelTraitSortRankForModel({ id: left.id }) -
					modelTraits.getModelTraitSortRankForModel({ id: right.id });
				return rankDifference || left.index - right.index;
			})
			.map(({ id }) => id);

	assert.deepEqual(
		sortByGuideTier([
			'Atlas Sonnet 5',
			'Atlas Sonnet 4.6',
			'Atlas Opus 5',
			'Atlas Opus 4.8',
			'Atlas Haiku 4.5'
		]),
		[
			'Atlas Sonnet 5',
			'Atlas Sonnet 4.6',
			'Atlas Opus 5',
			'Atlas Opus 4.8',
			'Atlas Haiku 4.5'
		]
	);
	assert.deepEqual(
		sortByGuideTier([
			'GPT-5.6 Sol',
			'GPT-5.6 Sol Pro',
			'GPT-5.6 Terra',
			'GPT-5.6 Luna',
			'GPT-5.5'
		]),
		['GPT-5.6 Terra', 'GPT-5.6 Sol', 'GPT-5.6 Sol Pro', 'GPT-5.6 Luna', 'GPT-5.5']
	);
	assert.deepEqual(
		sortByGuideTier(['GPT-5.6 Luna', 'openai/responses/gpt-5.5:latest', 'GPT-5.6 Sol']),
		['GPT-5.6 Sol', 'GPT-5.6 Luna', 'openai/responses/gpt-5.5:latest']
	);
	assert.deepEqual(
		sortByGuideTier([
			'Gemini 3.5 Flash',
			'Gemini 3.1 Pro Preview',
			'Gemini 3.1 Flash-Lite'
		]),
		['Gemini 3.5 Flash', 'Gemini 3.1 Pro Preview', 'Gemini 3.1 Flash-Lite']
	);

	assert.match(source, /getModelTraitSortRankForModel/);
	assert.match(source, /resolveModelPricing/);
	assert.match(source, /const getModelPickerTailRank =/);
	assert.ok(
		source.indexOf('const tailRankDifference =') < source.indexOf('const traitRankDifference ='),
		'GPT-5.5 tail pinning must run before guide-tier sorting'
	);
	assert.match(source, /const sortBaseModelsByGuideOrder =/);
	assert.match(
		source,
		/\$: filteredItems =[\s\S]*selectedPickerTab === 'models' && searchValue\.trim\(\) === ''[\s\S]*\? sortBaseModelsByGuideOrder\(unsortedFilteredItems\)/
	);
	assert.ok(
		source.indexOf('$: filteredItems =') < source.indexOf('$: groupedBaseModelSections ='),
		'keyboard and visual row order must share the same sorted filteredItems list'
	);
	assert.doesNotMatch(source, /getProviderGroupSortRank/);
});

test('model catalog serves Atlas Sonnet 5 and keeps Atlas Sonnet 4.6', async () => {
	const catalog = await fs.readFile(MODEL_CATALOG_PATH, 'utf8');

	assert.match(catalog, /model_name: "Atlas Sonnet 5"/);
	assert.match(catalog, /model: bedrock\/converse_like\/us\.anthropic\.atlas-sonnet-5\n/);
	assert.match(catalog, /model_name: "Atlas Sonnet 4.6"/);
	assert.ok(
		catalog.indexOf('model_name: "Atlas Sonnet 5"') <
			catalog.indexOf('model_name: "Atlas Sonnet 4.6"'),
		'Atlas Sonnet 5 must be listed before Atlas Sonnet 4.6'
	);
});

test('Gemini catalog exposes only requested Google models', async () => {
	const catalog = await fs.readFile(MODEL_CATALOG_PATH, 'utf8');
	for (const modelId of [
		'gemini-3.6-flash',
		'gemini-3.5-flash',
		'gemini-3.1-pro-preview',
		'gemini-3.5-flash-lite',
		'gemini-3.1-flash-lite'
	]) {
		assert.match(catalog, new RegExp(`model: gemini/vertex/${modelId}`));
	}
	assert.doesNotMatch(catalog, /gemini-3\.1-pro-preview-customtools/);
});

test('shared model logo helper is used across every patched surface that renders a model logo', async () => {
	const sources = await Promise.all([
		fs.readFile(RESPONSE_MESSAGE_SVELTE_PATH, 'utf8'),
		fs.readFile(MESSAGE_INPUT_SVELTE_PATH, 'utf8'),
		fs.readFile(BASE_MODEL_BADGE_SVELTE_PATH, 'utf8'),
		fs.readFile(WORKSPACE_MODELS_SVELTE_PATH, 'utf8')
	]);

	for (const source of sources) {
		assert.match(source, /getModelLogoSources/);
		assert.match(source, /usesCelestialModelLogo/);
	}

	const placeholder = await fs.readFile(PLACEHOLDER_SVELTE_PATH, 'utf8');
	assert.match(placeholder, /portico-landing-hero/);
	assert.match(placeholder, /primaryModelLogoSources = getModelLogoSources/);

	// The landing hero brands with the agent's BASE model when an agent is
	// selected, else the primary model. The routing rule lives in
	// $lib/utils/landingHeroModel.ts (Placeholder.svelte feeds heroModel into
	// getModelLogoSources/usesCelestialModelLogo), asserted behaviorally here.
	const baseModel = { id: 'Atlas Sonnet 5' };
	const agentModel = { id: 'my-agent', info: { base_model_id: 'Atlas Sonnet 5' } };
	assert.equal(
		landingHeroModel.resolveLandingHeroModel(baseModel, agentModel),
		baseModel,
		'hero model is the agent base model when present'
	);
	assert.equal(
		landingHeroModel.resolveLandingHeroModel(null, agentModel),
		agentModel,
		'hero model falls back to the primary model'
	);
	assert.equal(landingHeroModel.resolveLandingHeroModel(undefined, undefined), undefined);
});

test('light mode uses a neutral off-white canvas while retaining interactive contrast', async () => {
	const [appCss, selectorSource, electronCss, windowsSource, loadingHtml] = await Promise.all([
		fs.readFile(APP_CSS_PATH, 'utf8'),
		fs.readFile(MODEL_SELECTOR_SVELTE_PATH, 'utf8'),
		fs.readFile(ELECTRON_STYLES_PATH, 'utf8'),
		fs.readFile(ELECTRON_WINDOWS_PATH, 'utf8'),
		fs.readFile(ELECTRON_LOADING_HTML_PATH, 'utf8')
	]);

	assert.match(appCss, /--portico-light-canvas:\s*#f7f7f7;/);
	assert.match(appCss, /body\s*\{[^}]*background:\s*var\(--portico-light-canvas\);/s);
	assert.match(appCss, /\.dark body\s*\{[^}]*background:\s*#171717;/s);
	for (const selector of [
		'\\.light \\.app > div',
		'\\.light #chat-container',
		'\\.light \\.workspace-shell,',
		'\\.light \\.workspace-shell-nav',
		'\\.light \\.workspace-page-toolbar,'
	]) {
		assert.match(
			appCss,
			new RegExp(`${selector}[^}]*var\\(--portico-light-canvas\\)`, 's')
		);
	}
	assert.match(
		appCss,
		/\.light #navbar-bg-gradient-to-b\s*\{[^}]*rgba\(247, 247, 247, 0\.98\)[^}]*rgba\(247, 247, 247, 0\.08\)/s
	);
	assert.match(
		appCss,
		/\.light #sidebar\s*\{[^}]*background:\s*var\(--portico-sidebar-light-surface\)/s
	);
	assert.match(
		appCss,
		/\.light #sidebar \.sidebar-bg-gradient-to-b\s*\{[^}]*background:\s*var\(--portico-sidebar-light-surface\)[^}]*mask-image:/s
	);
	assert.match(appCss, /\.celestial-model-logo\s*\{[^}]*transform:\s*scale\(1\.35\);/s);
	assert.match(
		appCss,
		/\.light #message-input-container\s*\{[^}]*background:\s*var\(--portico-light-canvas\)/s
	);
	assert.match(
		selectorSource,
		/rounded-xl border border-slate-300 bg-\[var\(--portico-light-canvas\)\] text-slate-900/
	);
	assert.doesNotMatch(selectorSource, /rounded-xl border border-slate-300 bg-slate-200/);
	assert.match(
		appCss,
		/\.light \.model-selector-content\s*\{[^}]*background:\s*var\(--portico-menu-surface\)/s
	);
	assert.match(
		appCss,
		/\.light \.model-selector-search-row\s*\{[^}]*background:\s*var\(--portico-light-canvas\)/s
	);
	assert.match(
		appCss,
		/\.light \.workspace-nav-pill\s*\{[^}]*background:\s*rgba\(200, 209, 221, 0\.78\)/s
	);

	assert.match(
		electronCss,
		/\[data-theme="light"\]\s*\{[^}]*--bg-primary:\s*#f7f7f7;[^}]*--window-bg:\s*#f7f7f7;/s
	);
	assert.match(
		electronCss,
		/\[data-theme="light"\]\s*\{[^}]*--header-bg:\s*#f7f7f7;/s
	);
	assert.match(
		windowsSource,
		/function getLoadingWindowBackgroundColor\(\)[\s\S]*currentTheme === 'light'[\s\S]*return '#f7f7f7';/
	);
	assert.match(
		windowsSource,
		/const backgroundColor = currentTheme === 'light' \? '#f7f7f7' : '#1e2324';/
	);
	assert.match(
		loadingHtml,
		/\[data-theme="light"\]\s*\{[^}]*--bg-primary:\s*#f7f7f7;[^}]*--window-chrome-bg:\s*#f7f7f7;/s
	);
	assert.match(
		loadingHtml,
		/\[data-theme="light"\] \.progress-panel\s*\{[^}]*background:\s*transparent;/s
	);
	assert.match(
		loadingHtml,
		/\[data-theme="light"\] \.loading-overlay\s*\{[^}]*background:\s*rgba\(247, 247, 247, 0\.95\);/s
	);
});

test('landing content compensates only for the collapsed desktop rail and shares one card gutter', async () => {
	const [placeholderSource, appCss] = await Promise.all([
		fs.readFile(PLACEHOLDER_SVELTE_PATH, 'utf8'),
		fs.readFile(APP_CSS_PATH, 'utf8')
	]);

	assert.match(placeholderSource, /\bshowSidebar\b/);
	assert.match(placeholderSource, /portico-landing-shell/);
	assert.match(placeholderSource, /\$showSidebar\s*\?\s*''\s*:\s*'md:-translate-x-\[1\.625rem\]'/s);
	assert.match(placeholderSource, /data-portico-rail-compensated=\{\$showSidebar \? 'false' : 'true'\}/);
	assert.match(
		placeholderSource,
		/mx-auto mt-3 w-full max-w-6xl font-primary[\s\S]*?<div class="px-2\.5">[\s\S]*?<Suggestions/
	);
	assert.doesNotMatch(placeholderSource, /<div class="mx-5">/);
	assert.doesNotMatch(appCss, /--message-input-horizontal-offset/);
	assert.doesNotMatch(appCss, /translateX\(var\(--message-input-horizontal-offset\)\)/);
});

test('suggestion cards receive semantic decorative icons without changing prompt selection', async () => {
	const [suggestionsSource, iconSource] = await Promise.all([
		fs.readFile(SUGGESTIONS_SVELTE_PATH, 'utf8'),
		fs.readFile(SUGGESTION_ICON_SVELTE_PATH, 'utf8')
	]);

	const prompts = [
		["It's my first time using Portico. What can you do?", 'welcome'],
		["I'm new here. What are you able to do?", 'welcome'],
		['Help me enable some new integrations!', 'integrations'],
		['What are my most important meetings this week?', 'meetings'],
		["What's going on at Portico this week?", 'portico'],
		['Draft a concise project update.', 'prompt']
	];

	for (const [content, expected] of prompts) {
		assert.equal(suggestionVisual.resolveSuggestionVisualKind({ content }), expected);
	}

	assert.match(suggestionsSource, /resolveSuggestionVisualKind\(prompt\)/);
	assert.match(suggestionsSource, /<SuggestionIcon kind=\{visualKind\} \/>/);
	assert.match(
		suggestionsSource,
		/on:click=\{\(\) => onSelect\(\{ type: 'prompt', data: prompt\.content \}\)\}/
	);
	assert.match(iconSource, /aria-hidden="true"/);
	assert.match(iconSource, /data-suggestion-icon=\{kind\}/);
	assert.match(iconSource, /kind === 'welcome'/);
	assert.match(iconSource, /kind === 'integrations'/);
	assert.match(iconSource, /kind === 'meetings'/);
	assert.match(iconSource, /kind === 'portico'/);
	assert.match(iconSource, /data-portico-mark/);
	assert.match(iconSource, /bg-\[#e8f0ff\] text-\[#2557a7\]/);
	assert.match(iconSource, /dark:bg-\[#2557a7\]\/25 dark:text-\[#8db5ff\]/);
	assert.match(iconSource, /stroke-linecap="round"/);
	assert.match(iconSource, /transform="translate\(0 -1\)"/);
	assert.match(iconSource, /<circle cx="17" cy="11\.15" r="2\.55" fill="currentColor"/);
	assert.doesNotMatch(iconSource, /\/static\/portico-logo\.png/);
	assert.match(suggestionsSource, /data-suggestion-card=\{visualKind\}/);
	assert.match(suggestionsSource, /data-suggestion-card-content/);
	assert.match(suggestionsSource, /container-name:\s*portico-suggestions;/);
	assert.match(suggestionsSource, /min-height:\s*6\.5rem;/);
	assert.doesNotMatch(iconSource, />👋</);
	assert.match(suggestionsSource, /\.portico-suggestion-card-content\s*\{[^}]*flex-direction:\s*column;/s);
	assert.match(suggestionsSource, /\.portico-suggestion-copy\s*\{[^}]*margin-top:\s*auto;/s);
	assert.match(suggestionsSource, /prompt\.title\.filter\(Boolean\)\.join\(' '\)/);
	assert.match(suggestionsSource, /Discover what Portico can do/);
	assert.match(suggestionsSource, /Connect and enable new integrations/);
	assert.match(suggestionsSource, /Review this week's key meetings/);
	assert.match(suggestionsSource, /Catch up on this week's Portico news/);
	assert.match(suggestionsSource, /replace\(\/\(\?:\\\.\{3\}\|…\)\/g, ''\)/);
	assert.doesNotMatch(suggestionsSource, /\{prompt\.title\[1\]\}/);
	assert.match(
		suggestionsSource,
		/@container portico-suggestions \(min-width: 38rem\)[\s\S]*?repeat\(2,[\s\S]*?@container portico-suggestions \(min-width: 60rem\)[\s\S]*?repeat\(4,/s
	);
	assert.match(suggestionsSource, /\.portico-suggestion-card:focus-visible/);
	assert.match(
		suggestionsSource,
		/:global\(\.dark\) \.portico-suggestion-card\s*\{[^}]*border-color:\s*var\(--portico-dark-card-border,[^}]*background:\s*var\(--portico-dark-card-surface,[^}]*box-shadow:/s
	);
	assert.match(
		suggestionsSource,
		/:global\(\.dark\) \.portico-suggestion-card:hover\s*\{[^}]*border-color:\s*var\(--portico-dark-card-border-hover,[^}]*background:\s*var\(--portico-dark-card-hover,[^}]*box-shadow:/s
	);
});

test('dark model, reasoning, and suggestion cards use shared contrast tokens without changing light surfaces', async () => {
	const [appCss, suggestionsSource] = await Promise.all([
		fs.readFile(APP_CSS_PATH, 'utf8'),
		fs.readFile(SUGGESTIONS_SVELTE_PATH, 'utf8')
	]);

	assert.match(
		appCss,
		/\.dark\s*\{[^}]*--portico-dark-card-surface:\s*#222225;[^}]*--portico-dark-card-hover:\s*#2b2b2f;[^}]*--portico-dark-card-border:\s*rgba\(255, 255, 255, 0\.14\);[^}]*--portico-dark-card-border-hover:\s*rgba\(255, 255, 255, 0\.21\);[^}]*--portico-dark-card-shadow:/s
	);
	assert.match(
		appCss,
		/\.dark \.model-selector-content\s*\{[^}]*background:\s*var\(--portico-dark-card-surface\) !important;[^}]*border-color:\s*var\(--portico-dark-card-border\) !important;[^}]*box-shadow:\s*var\(--portico-menu-shadow\) !important;/s
	);
	assert.match(
		appCss,
		/\.dark \.reasoning-effort-popover\s*\{[^}]*background:\s*var\(--portico-dark-card-surface\) !important;[^}]*border-color:\s*var\(--portico-dark-card-border\) !important;[^}]*box-shadow:\s*var\(--portico-menu-shadow\) !important;/s
	);
	assert.match(
		suggestionsSource,
		/:global\(\.dark\) \.portico-suggestion-card\s*\{[^}]*background:\s*var\(--portico-dark-card-surface, #222225\);/s
	);
	assert.match(
		suggestionsSource,
		/:global\(\.dark\) \.portico-suggestion-card:hover\s*\{[^}]*background:\s*var\(--portico-dark-card-hover, #2b2b2f\);/s
	);
	assert.match(appCss, /\.light \.model-selector-content\s*\{[^}]*background:\s*var\(--portico-menu-surface\)/s);
	assert.doesNotMatch(suggestionsSource, /(^|\n)\s*\.portico-suggestion-card\s*\{[^}]*var\(--portico-dark-card-surface/s);
});

test('shared structural borders stay quiet in both themes without weakening focus states', async () => {
	const [appCss, electronCss, loadingHtml] = await Promise.all([
		fs.readFile(APP_CSS_PATH, 'utf8'),
		fs.readFile(ELECTRON_STYLES_PATH, 'utf8'),
		fs.readFile(ELECTRON_LOADING_HTML_PATH, 'utf8')
	]);

	assert.match(appCss, /--portico-border-subtle:\s*rgb\(15 23 42 \/ 0\.1\);/);
	assert.match(appCss, /--portico-divider-subtle:\s*rgb\(15 23 42 \/ 0\.06\);/);
	assert.match(
		appCss,
		/\.dark\s*\{[^}]*--portico-border-subtle:\s*rgb\(255 255 255 \/ 0\.08\);[^}]*--portico-divider-subtle:\s*rgb\(255 255 255 \/ 0\.06\);/s
	);
	assert.match(
		appCss,
		/#message-input-container\s*\{[^}]*border:\s*1px solid var\(--portico-border-subtle\)/s
	);
	assert.doesNotMatch(
		appCss,
		/#message-input-container\s*\{[^}]*border:\s*1\.5px solid/s
	);
	for (const selector of [
		'\\.model-selector-content',
		'\\.model-selector-search-row',
		'\\.waterfall'
	]) {
		assert.match(
			appCss,
			new RegExp(`${selector}\\s*\\{[^}]*border-color:\\s*var\\(--portico-border-subtle\\)`, 's')
		);
	}
	assert.match(
		appCss,
		/\.model-selector-guide,[\s\S]*\.model-selector-guide-item\s*\{[^}]*border-color:\s*var\(--portico-divider-subtle\)/s
	);
	assert.match(
		appCss,
		/\.model-selector-search-row:focus-within\s*\{[^}]*border-color:\s*var\(--portico-border-hover\)/s
	);
	assert.match(
		appCss,
		/\.light \.model-selector-search-row:focus-within\s*\{[^}]*border-color:\s*var\(--portico-border-hover\)/s
	);
	assert.match(
		appCss,
		/\.light #message-input-container:focus-within\s*\{[^}]*border-color:\s*var\(--portico-border-hover\)/s
	);

	assert.match(
		electronCss,
		/:root\s*\{[^}]*--border-default:\s*rgba\(255, 255, 255, 0\.045\);[^}]*--border-strong:\s*rgba\(255, 255, 255, 0\.075\);/s
	);
	assert.match(
		electronCss,
		/\[data-theme="light"\]\s*\{[^}]*--border-default:\s*rgba\(15, 23, 42, 0\.07\);[^}]*--border-strong:\s*rgba\(15, 23, 42, 0\.1\);/s
	);
	assert.match(loadingHtml, /--border-default:\s*rgba\(255, 255, 255, 0\.045\);/);
	assert.match(
		loadingHtml,
		/\[data-theme="light"\]\s*\{[^}]*--border-default:\s*rgba\(15, 23, 42, 0\.07\);/s
	);
});

test('model picker tab + agent ordering helpers cover selection and race cases', async () => {
	const modelPickerState = await bundleModule(
		'src/patches/frontend/src/lib/utils/modelPickerState.ts',
		path.join(tempDir, 'modelPickerState.cjs')
	);
	const { resolveInitialPickerTab, orderAgentPickerItems } = modelPickerState;

	// Selected agent already in the loaded set → agents.
	assert.equal(
		resolveInitialPickerTab({
			selectedModelId: 'agent-1',
			selectedHasBaseModelId: false,
			agentIds: new Set(['agent-1'])
		}),
		'agents'
	);
	// Race window: agents not loaded yet, but the selected item is agent-shaped.
	assert.equal(
		resolveInitialPickerTab({
			selectedModelId: 'agent-1',
			selectedHasBaseModelId: true,
			agentIds: new Set()
		}),
		'agents'
	);
	// Plain base model → models.
	assert.equal(
		resolveInitialPickerTab({
			selectedModelId: 'atlas-sonnet-5',
			selectedHasBaseModelId: false,
			agentIds: new Set(['agent-1'])
		}),
		'models'
	);
	// Empty / whitespace ids never match the set.
	assert.equal(
		resolveInitialPickerTab({
			selectedModelId: '',
			selectedHasBaseModelId: false,
			agentIds: new Set()
		}),
		'models'
	);
	assert.equal(
		resolveInitialPickerTab({
			selectedModelId: '   ',
			selectedHasBaseModelId: false,
			agentIds: new Set([''])
		}),
		'models'
	);

	const items = [
		{ value: 'banana', label: 'Banana Bot' },
		{ value: 'zeta', label: 'zeta helper' },
		{ value: 'apple', label: 'apple assistant' },
		{ value: 'mango', label: 'Mango' }
	];
	// Selected pinned first; the rest case-insensitively alphabetical.
	assert.deepEqual(
		orderAgentPickerItems(items, 'mango').map((item) => item.value),
		['mango', 'apple', 'banana', 'zeta']
	);
	// Selected absent → pure alphabetical.
	assert.deepEqual(
		orderAgentPickerItems(items, 'missing').map((item) => item.value),
		['apple', 'banana', 'mango', 'zeta']
	);
	// Stable for duplicate labels (insertion order preserved).
	assert.deepEqual(
		orderAgentPickerItems(
			[
				{ value: 'b', label: 'Same' },
				{ value: 'a', label: 'Same' }
			],
			''
		).map((item) => item.value),
		['b', 'a']
	);
	// Non-mutating; missing labels tolerated; empty list stays empty.
	const input = [{ value: 'x', label: 'X' }, { value: 'y' }];
	const output = orderAgentPickerItems(input, 'y');
	assert.notEqual(output, input);
	assert.deepEqual(
		input.map((item) => item.value),
		['x', 'y']
	);
	assert.deepEqual(
		output.map((item) => item.value),
		['y', 'x']
	);
	assert.deepEqual(orderAgentPickerItems([], 'anything'), []);
});

test('Selector wires the picker-tab race fix and pinned agent ordering', async () => {
	const source = await fs.readFile(MODEL_SELECTOR_SVELTE_PATH, 'utf8');

	// Initial tab decision + user-override lifecycle.
	assert.match(
		source,
		/import \{ resolveInitialPickerTab, orderAgentPickerItems \} from '\$lib\/utils\/modelPickerState';/
	);
	assert.match(source, /pickerTabUserOverride = false;\s*selectedPickerTab = resolveInitialPickerTab\(\{/);
	assert.equal((source.match(/pickerTabUserOverride = true;/g) || []).length, 2);
	// Post-load re-decision inside the loader, guarded by the override flag and
	// building the agent-id set locally (the derived set lags in the async fn).
	assert.match(
		source,
		/workspaceAgentsLoaded = true;[\s\S]*?if \(show && !pickerTabUserOverride\) \{[\s\S]*?resolveInitialPickerTab\(\{[\s\S]*?agentIds: new Set\(workspaceAgentItems\.map\(\(item\) => getItemModelId\(item\)\)\)/
	);
	// The agents→models auto-correct can no longer fire mid-load.
	assert.match(
		source,
		/\$: if \(workspaceAgentsLoaded && selectedPickerTab === 'agents' && !hasAgentModels && hasBaseModels\)/
	);
	// Agents tab (empty search) renders pinned-selected + alphabetical order.
	assert.match(
		source,
		/selectedPickerTab === 'agents' && searchValue\.trim\(\) === ''\s*\? orderAgentPickerItems\(unsortedFilteredItems, value\)/
	);
});
