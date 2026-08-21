const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const read = (...segments) => fs.readFile(path.join(REPO_ROOT, ...segments), 'utf8');

test('konami unlock is wired through renderer, preload, IPC, and OWUI chat sources', async () => {
	const [
		themeJs,
		indexHtml,
		indexJs,
		preloadJs,
		ipcJs,
		chatWebviewPreloadJs,
		chatSvelte,
		mainJs,
		konamiLoggerJs,
		konamiModelUnlockJs
	] =
		await Promise.all([
			read('electron-app', 'src', 'renderer', 'theme.js'),
			read('electron-app', 'src', 'renderer', 'views', 'index.html'),
			read('electron-app', 'src', 'renderer', 'views', 'index.js'),
			read('electron-app', 'src', 'services', 'preload.js'),
			read('electron-app', 'src', 'services', 'ipc.js'),
			read('electron-app', 'src', 'services', 'chat-webview-preload.js'),
			read('src', 'patches', 'frontend', 'src', 'lib', 'components', 'chat', 'Chat.svelte'),
			read('electron-app', 'src', 'services', 'main.js'),
			read('electron-app', 'src', 'services', 'konami-logger.js'),
			read('electron-app', 'src', 'services', 'konami-model-unlock.js')
		]);

	assert.equal(themeJs.includes('const KONAMI_MAX_GAP_MS = 400;'), true);
	assert.equal(themeJs.includes("toggle.addEventListener('pointerdown'"), true);
	assert.equal(themeJs.includes('window.electronAPI.konami.getState({'), true);
	assert.equal(themeJs.includes('window.electronAPI.konami.unlock({'), true);
	assert.equal(themeJs.includes('window.electronAPI.logToMain(payload);'), true);
	assert.equal(themeJs.includes("window.setNativeOverlayInteractionSuppressed('konami-modal', visible);"), true);
	assert.equal(indexHtml.includes('id="konami-modal"'), true);
	assert.equal(indexHtml.includes('Restrictions Removed'), true);
	assert.equal(indexJs.includes("'konami-modal': '#konami-modal.visible'"), true);
	assert.equal(preloadJs.includes('getState: (options = {}) => ipcRenderer.invoke(\'konami-get-state\', options),'), true);
	assert.equal(preloadJs.includes('unlock: (options = {}) => ipcRenderer.invoke(\'konami-unlock\', options),'), true);
	assert.equal(preloadJs.includes("ipcRenderer.on('konami-unlock-changed', (_event, payload) => callback(payload));"), true);
	assert.equal(ipcJs.includes('ipcMain.handle("konami-get-state"'), true);
	assert.equal(ipcJs.includes('ipcMain.handle("konami-unlock"'), true);
	assert.equal(ipcJs.includes('logKonamiMain("Main", "info", "Received Konami unlock request"'), true);
	assert.equal(ipcJs.includes('logKonamiMain(meta.konamiLayer || "Renderer", level, message, meta);'), true);
	assert.equal(ipcJs.includes('const persisted = persistKonamiDesiredState(context);'), true);
	assert.equal(ipcJs.includes('result = await attemptKonamiOwuiUnlock({'), true);
	assert.equal(ipcJs.includes('const result = await unlockKonamiModelWithServiceAuth();'), true);
	assert.equal(ipcJs.indexOf('const persisted = persistKonamiDesiredState(context);') < ipcJs.indexOf('result = await attemptKonamiOwuiUnlock({'), true);
	assert.equal(ipcJs.includes('unlocked: desiredStatePersisted,'), true);
	assert.equal(ipcJs.includes('repairPending: true,'), true);
	assert.equal(ipcJs.includes('owuiViews.broadcastToViews("owui-konami-unlock-changed", payload);'), true);
	assert.equal(ipcJs.includes("/api/v1/models/model/update"), true);
	assert.equal(chatWebviewPreloadJs.includes("logKonamiOwuiPreload('info', 'Dispatched OWUI Konami unlock event into the page'"), true);
	assert.equal(chatWebviewPreloadJs.includes("window.dispatchEvent(new CustomEvent('owui-konami-unlock-changed', { detail }))"), true);
	assert.equal(chatSvelte.includes("window.addEventListener('owui-konami-unlock-changed', handleKonamiUnlockChanged);"), true);
	assert.equal(chatSvelte.includes("void refreshKonamiModelsInBackground();"), true);
	assert.equal(mainJs.includes('initKonamiLogger();'), true);
	assert.equal(konamiLoggerJs.includes('konami-${new Date().toISOString().split("T")[0]}.log'), true);
	assert.equal(konamiModelUnlockJs.includes('/api/v1/portico/auth/service-token'), true);
	assert.equal(konamiModelUnlockJs.includes('/api/v1/models/model/update'), true);
});
