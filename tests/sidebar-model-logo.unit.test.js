const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { build } = require('../electron-app/node_modules/esbuild');

const ROOT = path.resolve(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');
let tempDir;
let sidebarModels;
let notificationModels;
let modelBranding;

const bundle = async (entry, output) => {
	await build({
		entryPoints: [path.join(ROOT, entry)],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: ['node20'],
		logLevel: 'silent',
		outfile: output
	});
	return require(output);
};

before(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-model-logo-'));
	sidebarModels = await bundle(
		'src/patches/frontend/src/lib/utils/chatSidebarModel.ts',
		path.join(tempDir, 'chat-sidebar-model.cjs')
	);
	notificationModels = await bundle(
		'src/patches/frontend/src/lib/utils/chatNotificationModel.ts',
		path.join(tempDir, 'chat-notification-model.cjs')
	);
	modelBranding = await bundle(
		'src/patches/frontend/src/lib/utils/modelBranding.ts',
		path.join(tempDir, 'model-branding.cjs')
	);
});

after(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

test('sidebar model resolver follows the active branch and uses the primary pre-response model', () => {
	const row = (currentId, messages, models = ['Primary Model']) => ({
		chat: { history: { currentId, messages }, models }
	});

	assert.equal(
		sidebarModels.resolveSidebarChatModelId(
			row('a2', { a2: { role: 'assistant', model: 'Latest Response' } })
		),
		'Latest Response'
	);
	assert.equal(
		sidebarModels.resolveSidebarChatModelId(
			row('u2', {
				a1: { role: 'assistant', model: 'Parent Response' },
				u2: { role: 'user', parentId: 'a1' }
			})
		),
		'Parent Response'
	);
	assert.equal(
		sidebarModels.resolveSidebarChatModelId(
			row('branch-active', {
				'branch-active': { role: 'assistant', model: 'Active Branch' },
				'branch-inactive': { role: 'assistant', model: 'Inactive Branch' }
			})
		),
		'Active Branch'
	);
	assert.equal(
		sidebarModels.resolveSidebarChatModelId(row('u1', { u1: { role: 'user' } })),
		'Primary Model'
	);
	assert.equal(
		sidebarModels.resolveSidebarChatModelId({ model_id: 'API Model' }),
		'API Model'
	);
});

test('notification model identity follows the active branch and underlying base model', () => {
	const modelCatalog = [
		{
			id: 'recruiting-agent',
			name: 'Recruiting Agent',
			owned_by: 'openai',
			base_model_id: 'anthropic/atlas-opus-4.8'
		},
		{
			id: 'anthropic/atlas-opus-4.8',
			name: 'Atlas Opus 4.8',
			owned_by: 'anthropic'
		},
		{ id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', owned_by: 'openai' }
	];
	const chatRow = {
		chat: {
			history: {
				currentId: 'active-user',
				messages: {
					'old-assistant': { role: 'assistant', model: 'gpt-5.6-terra' },
					'active-assistant': {
						role: 'assistant',
						model: 'recruiting-agent',
						parentId: 'old-assistant'
					},
					'active-user': { role: 'user', parentId: 'active-assistant' },
					'inactive-assistant': { role: 'assistant', model: 'gpt-5.6-terra' }
				}
			},
			models: ['gpt-5.6-terra']
		}
	};

	assert.deepEqual(
		notificationModels.resolveChatNotificationModelIdentity({ chatRow, modelCatalog }),
		{
			id: 'recruiting-agent',
			name: 'Recruiting Agent',
			ownedBy: 'openai',
			baseModelId: 'anthropic/atlas-opus-4.8',
			baseModelName: 'Atlas Opus 4.8',
			baseModelOwnedBy: 'anthropic'
		}
	);
	assert.deepEqual(
		notificationModels.resolveChatNotificationModelIdentity({
			chatRow: { chat: { history: { currentId: null, messages: {} }, models: [] } },
			modelCatalog,
			fallbackModelIds: ['gpt-5.6-terra']
		}),
		{
			id: 'gpt-5.6-terra',
			name: 'GPT-5.6 Terra',
			ownedBy: 'openai'
		}
	);
});

test('custom agents keep profile images ahead of Gemini and OpenAI provider branding', () => {
	for (const agent of [
		{ id: 'gemini-agent', owned_by: 'openai', info: { base_model_id: 'Gemini 3.5 Flash' } },
		{ id: 'gpt-agent', owned_by: 'openai', info: { base_model_id: 'GPT-5.5' } }
	]) {
		assert.equal(modelBranding.getStaticModelLogoSrc(agent), null);
		assert.equal(modelBranding.usesDarkLogoBadgeInLightMode(agent), false);
		assert.match(
			modelBranding.getModelLogoSources(agent, '/api', 'en', '/favicon').light,
			new RegExp(`profile/image\\?id=${agent.id}`)
		);
	}

	assert.equal(modelBranding.getStaticModelLogoSrc({ id: 'Atlas Sonnet 4.6' }), '/atlas.png');
	assert.equal(modelBranding.getStaticModelLogoSrc({ id: 'GPT-5.5' }), '/gpt.png');
	assert.equal(modelBranding.getStaticModelLogoSrc({ id: 'Gemini 3.5 Flash' }), '/gemini.png');
	assert.equal(modelBranding.getStaticModelLogoSrc({ id: 'GPT-5.6 Sol' }), '/sol.png');
	assert.deepEqual(
		modelBranding.getModelLogoSources(
			{ id: 'local', meta: { local_provider: 'lm_studio' } },
			'/api',
			'en',
			'/favicon'
		),
		{
			light: '/local-model-light.svg',
			dark: '/local-model-dark.svg',
			isLocal: true
		}
	);
	assert.equal(
		modelBranding.getModelSelectorLogoPresentation({ id: 'GPT-5.5' }, 'sidebar').outerSizeClass,
		'size-4'
	);
});

test('normal, pinned, and recursive folder rows pass and render one model logo before titles', () => {
	const chatItem = read(
		'src', 'patches', 'frontend', 'src', 'lib', 'components', 'layout', 'Sidebar', 'ChatItem.svelte'
	);
	const sidebar = read(
		'src', 'patches', 'frontend', 'src', 'lib', 'components', 'layout', 'Sidebar.svelte'
	);
	const recursiveFolder = read(
		'src', 'patches', 'frontend', 'src', 'lib', 'components', 'layout', 'Sidebar', 'RecursiveFolder.svelte'
	);
	const logo = read(
		'src', 'patches', 'frontend', 'src', 'lib', 'components', 'layout', 'Sidebar', 'SidebarModelLogo.svelte'
	);

	const activityIndex = chatItem.indexOf('<ChatActivityBlocks />');
	const logoIndex = chatItem.indexOf('<SidebarModelLogo {modelId} />', activityIndex);
	const titleIndex = chatItem.indexOf('{title}', logoIndex);
	assert.ok(activityIndex !== -1 && logoIndex > activityIndex && titleIndex > logoIndex);
	assert.equal((sidebar.match(/modelId=\{resolveSidebarChatModelId\(chat\)\}/g) || []).length, 2);
	assert.match(recursiveFolder, /getChatListByFolderId/);
	assert.doesNotMatch(recursiveFolder, /folderChats\.filter/);
	assert.match(recursiveFolder, /modelId=\{resolveSidebarChatModelId\(chat\)\}/);
	assert.match(logo, /ProfileImage/);
	assert.match(logo, /getModelLogoSources/);
	assert.match(logo, /getModelSelectorLogoPresentation\(model, 'sidebar'\)/);
	assert.match(logo, /\{#if modelId\}/);
	assert.ok(logo.indexOf('{#if modelId}') < logo.indexOf('<ProfileImage'));
	assert.match(chatItem, /overflow-hidden flex-1 min-w-0 h-\[20px\] truncate/);
	assert.match(chatItem, /sidebar-chat-status-slot/);
	assert.match(chatItem, /id="sidebar-chat-item-menu"/);
});

test('search modal reuses one sidebar model logo per conversation header', () => {
	const searchModal = read(
		'src',
		'patches',
		'frontend',
		'src',
		'lib',
		'components',
		'layout',
		'SearchModal.svelte'
	);
	const chatSearchApi = read(
		'src',
		'patches',
		'frontend',
		'src',
		'lib',
		'apis',
		'chatSearch.ts'
	);

	assert.match(searchModal, /import SidebarModelLogo from '\.\/Sidebar\/SidebarModelLogo\.svelte';/);
	assert.match(searchModal, /import \{ resolveSidebarChatModelId \} from '\$lib\/utils\/chatSidebarModel';/);
	assert.equal((searchModal.match(/<SidebarModelLogo /g) || []).length, 3);
	assert.equal(
		(searchModal.match(/<SidebarModelLogo modelId=\{resolveSidebarChatModelId\(chat\)\} \/>/g) || [])
			.length,
		1
	);
	assert.equal(
		(searchModal.match(/<SidebarModelLogo modelId=\{result\.modelId\} \/>/g) || []).length,
		2
	);
	assert.match(searchModal, /modelId:\s*result\.model_id \?\? null/);
	assert.match(chatSearchApi, /model_id\?: string \| null;/);

	const messageSnippetSection = searchModal.slice(
		searchModal.indexOf('{#each result.matches as match, matchIdx}'),
		searchModal.indexOf('{\/each}', searchModal.indexOf('{#each result.matches as match, matchIdx}'))
	);
	assert.doesNotMatch(messageSnippetSection, /SidebarModelLogo/);
});

test('sidebar chat loading preserves rows and retries transient failures', () => {
	const sidebar = read(
		'src', 'patches', 'frontend', 'src', 'lib', 'components', 'layout', 'Sidebar.svelte'
	);
	const selector = read(
		'src',
		'patches',
		'frontend',
		'src',
		'lib',
		'components',
		'chat',
		'ModelSelector',
		'Selector.svelte'
	);

	assert.match(sidebar, /Chat history load failed; preserving existing rows/);
	assert.match(sidebar, /CHAT_LIST_MAX_RETRIES = 8/);
	assert.match(sidebar, /void loadPrimaryChatList\(\)/);
	assert.match(sidebar, /Array\.isArray\(folderResponse\)/);
	assert.match(sidebar, /Additional chat page failed to load; preserving existing rows/);
	assert.equal((selector.match(/loading="eager"/g) || []).length, 6);
});
