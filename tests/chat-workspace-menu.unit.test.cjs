const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

function readRepoFile(relativePath) {
	return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

test('chat navbar menu shows an Open Workspace action below Copy Chat ID', () => {
	const menuSource = readRepoFile(
		'src/patches/frontend/src/lib/components/layout/Navbar/Menu.svelte'
	);

	assert.match(
		menuSource,
		/id="chat-copy-id-button"[\s\S]*id="chat-open-workspace-button"/
	);
	assert.match(menuSource, /Open Workspace/);
	assert.match(menuSource, /hostApi\.openChatWorkspace\(chat\.id\)/);
	assert.match(menuSource, /canOpenWorkspace = typeof getWorkspaceHostApi\(\)\?\.openChatWorkspace === 'function';/);
});

test('OWUI preload exposes the chat workspace bridge', () => {
	const preloadSource = readRepoFile('electron-app/src/services/chat-webview-preload.js');

	assert.match(preloadSource, /function openChatWorkspace\(chatId\)/);
	assert.match(preloadSource, /ipcRenderer\.invoke\('open-chat-workspace', \{ chatId \}\)/);
	assert.match(preloadSource, /openChatWorkspace,/);
});

test('Electron IPC registers a dedicated chat workspace opener', () => {
	const ipcSource = readRepoFile('electron-app/src/services/ipc.js');

	assert.match(ipcSource, /ipcMain\.handle\("open-chat-workspace"/);
	assert.match(ipcSource, /ensureChatWorkspaceDirectories\(\{/);
	assert.match(ipcSource, /const openError = await shell\.openPath\(chatWorkspace\);/);
});
