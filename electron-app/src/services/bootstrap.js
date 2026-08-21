// Bootstrap module - app initialization, logger, paths, menu, theme icons
// Extracted from main.js for modularity

const { app, BrowserWindow, shell, dialog, Menu, nativeTheme, session } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');
const { getResolvedBuildChannelInfo } = require('../utils/build-info');
const {
  createReleaseChannelMenuItems,
  getDefaultReleaseChannel,
} = require('../utils/release-channel');
const {
  readReleaseChannelInfo,
  seedReleaseChannelFromPackage,
  writeReleaseChannelSelection,
} = require('./release-channel-state');
const { buildRuntimeSecretEnv } = require('../config/runtime-secrets-config');
const { getLlmDebugMonitorBaseUrl } = require('../config/local-service-ports');
const { createEnhancedEnv } = require('./env-paths');
const { openHttpExternalUrl } = require('./shell-open');

// Import shared state
const state = require('./shared-state');

// Import logger
const { initLogger, getLogPaths } = require('./logger');

// Initialize logger FIRST
const logger = initLogger();

// Path constants - __dirname is electron-app/src/services
const APP_ROOT = path.resolve(__dirname, '..', '..');
const APP_SRC = path.join(APP_ROOT, 'src');
const APP_VIEWS = path.join(APP_SRC, 'renderer', 'views');
const APP_SERVICES = path.join(APP_SRC, 'services');
const PRELOAD_SCRIPT = path.join(APP_SERVICES, 'preload.js');

// Project root will be set during initialization
let PROJECT_ROOT = null;
let SCRIPTS_DIR = null;

// Promisify exec for async/await usage
const execAsync = util.promisify(exec);

const EXPECTED_PROJECT_FILES = ['src', 'docker-compose.yml'];
const DEFAULT_MANAGED_ROOT = path.join(os.homedir(), 'portico', 'portico-managed');
const DEBUG_MONITOR_BASE_URL = `${getLlmDebugMonitorBaseUrl()}/`;
const DEBUG_MONITOR_ALLOWED_ORIGINS = new Set([
  getLlmDebugMonitorBaseUrl('localhost'),
  getLlmDebugMonitorBaseUrl('127.0.0.1'),
]);

function getDefaultManagedRoot() {
  return DEFAULT_MANAGED_ROOT;
}

function getDebugMonitorToken() {
  const runtimeSecrets = buildRuntimeSecretEnv({
    env: process.env,
    projectRoot: PROJECT_ROOT,
    resourcesPath: process.resourcesPath,
    managedRoot: process.env.PORTICO_MANAGED_ROOT || getDefaultManagedRoot(),
    isPackagedApp: Boolean(app && app.isPackaged),
  });
  return String(runtimeSecrets.BIFROST_BRIDGE_LOCAL_API_KEY || '').trim();
}

function buildDebugMonitorUrl(targetUrl = DEBUG_MONITOR_BASE_URL) {
  const url = new URL(targetUrl || DEBUG_MONITOR_BASE_URL, DEBUG_MONITOR_BASE_URL);
  if (!DEBUG_MONITOR_ALLOWED_ORIGINS.has(url.origin)) {
    throw new Error('Invalid debug monitor URL');
  }
  const token = getDebugMonitorToken();
  if (!token) {
    throw new Error('Debug monitor token is unavailable');
  }
  url.searchParams.set('token', token);
  return url.toString();
}

function getDebugMonitorAccess() {
  const url = new URL(buildDebugMonitorUrl());
  const token = url.searchParams.get('token') || '';
  url.searchParams.delete('token');
  return {
    baseUrl: url.origin,
    token,
  };
}

function isRootPath(candidate) {
  if (!candidate) return true;
  const resolved = path.resolve(candidate);
  return resolved === path.parse(resolved).root;
}

function getMissingProjectFiles(projectRoot) {
  if (!projectRoot) return EXPECTED_PROJECT_FILES.slice();
  return EXPECTED_PROJECT_FILES.filter(file =>
    !fs.existsSync(path.join(projectRoot, file))
  );
}

function isValidProjectRoot(projectRoot) {
  return getMissingProjectFiles(projectRoot).length === 0;
}

function ensureDirectoryExists(dirPath) {
  if (!dirPath || fs.existsSync(dirPath)) return true;
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return true;
  } catch (error) {
    console.error('[ProjectRoot] Failed to create directory:', dirPath, error.message);
    return false;
  }
}

/**
 * Log startup information
 */
function logStartupInfo() {
  console.log('================================');
  console.log('Portico Starting');
  console.log(`Process ID: ${process.pid}`);
  console.log(`Node Version: ${process.version}`);
  console.log(`Electron Version: ${process.versions.electron}`);
  console.log(`Platform: ${process.platform}`);
  console.log(`Architecture: ${process.arch}`);
  console.log(`App Path: ${app.getAppPath()}`);
  console.log(`Is Packaged: ${app.isPackaged}`);

  const logPaths = getLogPaths();
  if (logPaths) {
    console.log(`Log files:`);
    console.log(`  - Main: ${logPaths.logFile}`);
    console.log(`  - Errors: ${logPaths.errorFile}`);
  }
  console.log('================================');
}

/**
 * Check if a port is currently in use
 * @param {number} port - Port to check
 * @returns {Promise<boolean>} - true if port is in use, false if free
 */
async function isPortInUse(port) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
      return stdout.trim().length > 0;
    } else {
      // LISTEN-only: avoid considering client sockets as "port in use"
      const { stdout } = await execAsync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
      return stdout.trim().length > 0;
    }
  } catch (err) {
    // Exit code 1 means no process found - port is free
    if (err.code === 1) {
      return false;
    }
    // Other errors, assume port might be in use
    return true;
  }
}

/**
 * Wait for a port to become available after killing a process
 * @param {number} port - Port to wait for
 * @param {number} maxWaitMs - Maximum time to wait in milliseconds
 * @param {number} checkIntervalMs - Interval between checks in milliseconds
 * @returns {Promise<boolean>} - true if port became free, false if timed out
 */
async function waitForPortRelease(port, maxWaitMs = 2000, checkIntervalMs = 100) {
  let waited = 0;

  while (waited < maxWaitMs) {
    await new Promise(r => setTimeout(r, checkIntervalMs));
    waited += checkIntervalMs;

    const inUse = await isPortInUse(port);
    if (!inUse) {
      console.log(`[Port] Port ${port} is now free after ${waited}ms`);
      return true;
    }
  }

  console.warn(`[Port] Port ${port} may still be in use after ${maxWaitMs}ms wait`);
  return false;
}

/**
 * Kill any process using a specific port
 */
async function killProcessOnPort(port) {
  let killedAny = false;

  try {
    console.log(`[Port] Checking if port ${port} is in use...`);

    if (process.platform === 'win32') {
      // Windows: netstat + taskkill
      try {
        const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
        const lines = stdout.trim().split('\n');

        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];

          if (pid && !isNaN(pid)) {
            console.log(`[Port] Killing process ${pid} using port ${port}...`);
            await execAsync(`taskkill /F /PID ${pid}`);
            console.log(`[Port] Successfully killed process ${pid}`);
            killedAny = true;
          }
        }
      } catch (err) {
        if (err.code === 1) {
          console.log(`[Port] Port ${port} is free`);
        }
      }
    } else {
      // macOS/Linux: lsof + kill
      try {
        // LISTEN-only: avoid killing client PIDs (can include the Electron app)
        const { stdout } = await execAsync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
        const pids = stdout.trim().split('\n').filter(pid => pid);

        for (const pid of pids) {
          const pidNum = parseInt(pid, 10);
          if (!pidNum || Number.isNaN(pidNum)) continue;

          // Never kill the current Electron process
          if (pidNum === process.pid) {
            console.warn(`[Port] Refusing to kill current process (pid=${pidNum}) for port ${port}`);
            continue;
          }

          console.log(`[Port] Killing process ${pidNum} using port ${port} (SIGTERM)...`);
          await execAsync(`kill -TERM ${pidNum} 2>/dev/null || true`);
          await new Promise(r => setTimeout(r, 200));

          // If still alive, SIGKILL
          try {
            await execAsync(`kill -0 ${pidNum}`);
            console.log(`[Port] Process ${pidNum} still running, sending SIGKILL...`);
            await execAsync(`kill -9 ${pidNum} 2>/dev/null || true`);
          } catch (e) {
            // Not running anymore, good
          }

          console.log(`[Port] Successfully killed process ${pidNum}`);
          killedAny = true;
        }
      } catch (err) {
        if (err.code === 1) {
          console.log(`[Port] Port ${port} is free`);
        } else {
          console.warn(`[Port] Warning: ${err.message}`);
        }
      }
    }

    // If we killed any process, wait for the port to be released
    if (killedAny) {
      await waitForPortRelease(port);
    }
  } catch (error) {
    console.warn(`[Port] Warning checking port ${port}: ${error.message}`);
  }
}

/**
 * Clear webview cache on app startup to prevent using stale Open WebUI artifacts
 */
async function clearWebviewCache() {
  try {
    console.log('[Cache] Clearing webview cache for fresh Open WebUI session...');

    // Get the persistent session used by webviews (partition="persist:openwebui")
    const webviewSession = session.fromPartition('persist:openwebui');

    // Clear all cache data
    await webviewSession.clearCache();

    // Clear storage data (cookies, localStorage, etc.)
    await webviewSession.clearStorageData({
      storages: [
        'appcache',
        'cookies',
        'filesystem',
        'indexdb',
        'localstorage',
        'sessionstorage',
        'serviceworkers',
        'cachestorage',
        'websql'
      ]
    });

    console.log('[Cache] Webview cache cleared successfully');
  } catch (error) {
    console.error('[Cache] Failed to clear webview cache:', error);
  }
}

/**
 * Load build info from build-info.json
 * Checks process.resourcesPath first (packaged apps), then falls back to APP_ROOT (dev mode)
 */
function loadBuildInfo() {
  // Reset to defaults first to avoid stale state on repeated calls
  state.buildInfo.buildNumber = 'dev-build';
  state.buildInfo.date = 'unknown';
  state.buildInfo.fullSha = 'unknown';
  state.buildInfo.channel = 'portico';
  state.buildInfo.timestamp = null;

  let info = null;

  // Priority 1: Check process.resourcesPath (packaged apps - Contents/Resources/)
  // This is where electron-builder puts files from extraResources
  if (process.resourcesPath) {
    const bundledPath = path.join(process.resourcesPath, 'build-info.json');
    if (fs.existsSync(bundledPath)) {
      try {
        const content = fs.readFileSync(bundledPath, 'utf8');
        info = JSON.parse(content);
        console.log('Build info loaded from resources path:', bundledPath);
      } catch (err) {
        console.log('Failed to read bundled build-info.json:', err.message);
      }
    }
  }

  // Priority 2: Check APP_ROOT via require (development mode or app.asar)
  if (!info) {
    try {
      const buildInfoPath = path.join(APP_ROOT, 'build-info.json');
      delete require.cache[require.resolve(buildInfoPath)];
      info = require(buildInfoPath);
      console.log('Build info loaded from APP_ROOT:', buildInfoPath);
    } catch (error) {
      // Fallback: try fs.readFileSync directly
      try {
        const buildData = fs.readFileSync(path.join(APP_ROOT, 'build-info.json'), 'utf8');
        info = JSON.parse(buildData);
        console.log('Build info loaded via fs fallback');
      } catch (fileError) {
        console.log('Could not read build-info.json:', fileError.message);
      }
    }
  }

  // Update shared state with loaded info
  if (info) {
    state.buildInfo.buildNumber = info.buildNumber || 'dev-build';
    state.buildInfo.date = info.date || 'unknown';
    state.buildInfo.fullSha = info.fullSha || 'unknown';
    state.buildInfo.channel = info.channel || 'portico';
    state.buildInfo.timestamp = info.timestamp || null;
  }

  console.log('Build info:', state.buildInfo);
}

/**
 * Create a custom execPromise that includes proper PATH for Docker access
 */
function execPromise(command, options = {}) {
  return util.promisify(exec)(command, {
    ...options,
    env: createEnhancedEnv(options.env || {}),
  });
}

/**
 * Get the appropriate icon based on system theme
 */
function getThemeIcon() {
  const isDarkMode = nativeTheme.shouldUseDarkColors;
  const iconName = isDarkMode ? 'icon-light.png' : 'icon-dark.png';
  return path.join(APP_ROOT, 'assets', iconName);
}

/**
 * Update all window icons when theme changes
 */
function updateAllWindowIcons() {
  const iconPath = getThemeIcon();
  const allWindows = BrowserWindow.getAllWindows();
  allWindows.forEach(window => {
    if (window && !window.isDestroyed()) {
      window.setIcon(iconPath);
    }
  });
}

/**
 * Resolve the current release channel from UPDATE_CHANNEL.
 * Safe historical raw package names remain readable as legacy custom channels.
 */
function getCurrentChannelInfo() {
  if (!PROJECT_ROOT) return getDefaultReleaseChannel();
  return readReleaseChannelInfo(PROJECT_ROOT, {
    onInvalid(channelContent) {
      console.error(
        `[Channel] Ignoring malformed UPDATE_CHANNEL value and using Stable: ${JSON.stringify(channelContent)}`,
      );
    },
    onError(error) {
      console.error('Error reading UPDATE_CHANNEL:', error);
    },
  });
}

function getCurrentChannel() {
  return getCurrentChannelInfo().name;
}

function getCurrentChannelLabel() {
  return getCurrentChannelInfo().label;
}

function clearPreparedUpdateAfterChannelChange() {
  try {
    const updatePreparation = require('./update-preparation');
    if (typeof updatePreparation.clearPreparation === 'function') {
      updatePreparation.clearPreparation('release-channel-changed');
    } else if (typeof updatePreparation.cancelPreparation === 'function') {
      updatePreparation.cancelPreparation('release-channel-changed');
    }
  } catch (error) {
    console.warn('[Channel] Failed to clear prepared update:', error.message);
  }
}

/**
 * Set a built-in or canonical custom release channel.
 */
function setReleaseChannel(channel) {
  if (!PROJECT_ROOT) {
    const error = new Error('Project root is not initialized');
    console.error('Error setting release channel:', error);
    dialog.showErrorBox('Channel Switch Failed', error.message);
    return { success: false, error: error.message };
  }

  try {
    const resolvedChannel = writeReleaseChannelSelection(PROJECT_ROOT, channel);
    console.log(
      `[Channel] Switched to ${resolvedChannel.label} (${resolvedChannel.packageName})`,
    );

    clearPreparedUpdateAfterChannelChange();
    if (state.windows.main && !state.windows.main.isDestroyed()) {
      state.windows.main.webContents.send('clear-update-state');
    }
    createMenu();
    return { success: true, channel: resolvedChannel };
  } catch (error) {
    console.error('Error setting release channel:', error);
    dialog.showErrorBox('Channel Switch Failed', `Failed to switch channel: ${error.message}`);
    createMenu();
    return { success: false, error: error.message };
  }
}

function ensureUpdateChannelSeededFromBuildInfo() {
  if (!PROJECT_ROOT) {
    return false;
  }

  const updateChannelPath = path.join(PROJECT_ROOT, 'UPDATE_CHANNEL');
  if (fs.existsSync(updateChannelPath)) {
    return false;
  }

  const resolvedChannel = getResolvedBuildChannelInfo(state.buildInfo);
  if (
    !resolvedChannel?.channelKeyword ||
    resolvedChannel.channelKeyword === 'portico'
  ) {
    return false;
  }

  try {
    const seeded = seedReleaseChannelFromPackage(
      PROJECT_ROOT,
      resolvedChannel.channelKeyword,
    );
    if (!seeded) return false;
    console.log(
      `[Channel] Seeded UPDATE_CHANNEL from bundled build metadata: ${resolvedChannel.channelKeyword}`,
    );
    return true;
  } catch (error) {
    console.error('[Channel] Failed to seed UPDATE_CHANNEL from build metadata:', error);
    return false;
  }
}

/**
 * Build dynamic Window menu with artifact windows
 */
function buildWindowMenu() {
  const { artifactWindows, conversationWindows, windows } = state;

  const submenu = [
    {
      label: 'New Chat',
      accelerator: 'CmdOrCtrl+N',
      registerAccelerator: false,
      click: () => {
        const { BrowserWindow } = require('electron');
        const focusedWin = BrowserWindow.getFocusedWindow();
        const owuiViews = require('./owui-views');
        if (focusedWin && !focusedWin.isDestroyed()) {
          owuiViews.sendToActiveViewForWindow(focusedWin.id, 'open-new-chat', {});
        }
      }
    },
    {
      label: 'New Chat Window',
      accelerator: 'CmdOrCtrl+Shift+N',
      registerAccelerator: false,
      click: () => {
        const { openNewChatWindow } = require('./windows');
        openNewChatWindow();
      }
    },
    {
      label: 'New Tab',
      accelerator: 'CmdOrCtrl+T',
      registerAccelerator: false,
      click: () => {
        if (windows.main && !windows.main.isDestroyed()) {
          windows.main.webContents.send('open-new-chat-tab');
          windows.main.focus();
        }
      }
    },
    {
      label: 'Close Tab',
      accelerator: 'CmdOrCtrl+W',
      registerAccelerator: false,
      click: () => {
        const { BrowserWindow } = require('electron');
        const focusedWin = BrowserWindow.getFocusedWindow();
        if (focusedWin && windows.main && focusedWin.id === windows.main.id) {
          windows.main.webContents.send('close-active-tab');
        } else if (focusedWin) {
          focusedWin.close();
        }
      }
    },
    {
      label: 'Close Window',
      accelerator: 'CmdOrCtrl+Shift+W',
      click: () => {
        const { BrowserWindow } = require('electron');
        const focusedWin = BrowserWindow.getFocusedWindow();
        if (focusedWin && !focusedWin.isDestroyed()) {
          focusedWin.close();
        }
      }
    },
    { type: 'separator' },
    { role: 'minimize' },
    { role: 'zoom' },
    { type: 'separator' },
    {
      label: 'Main Window',
      click: () => {
        if (windows.main && !windows.main.isDestroyed()) {
          windows.main.show();
          windows.main.focus();
        }
      }
    }
  ];

  // Only show detached conversation windows in the menu
  const detachedEntries = [];
  for (const info of conversationWindows.values()) {
    if (info.window && !info.window.isDestroyed()) {
      const baseLabel = info.title || (info.windowType === 'chat' ? 'Chat' : 'Subagent');
      detachedEntries.push({ info, baseLabel });
    }
  }

  const hasDetachedWindows = detachedEntries.length > 0;
  const hasArtifactWindows = artifactWindows.size > 0;

  if (hasDetachedWindows || hasArtifactWindows) {
    submenu.push({ type: 'separator' });
  }

  if (hasDetachedWindows) {
    const labelCounts = {};
    const labelIndexes = {};
    detachedEntries.forEach(entry => {
      labelCounts[entry.baseLabel] = (labelCounts[entry.baseLabel] || 0) + 1;
    });

    detachedEntries.forEach(entry => {
      let label = entry.baseLabel;
      if (labelCounts[label] > 1) {
        labelIndexes[label] = (labelIndexes[label] || 0) + 1;
        label = `${label} ${labelIndexes[label]}`;
      }
      submenu.push({
        label,
        click: () => {
          if (entry.info.window && !entry.info.window.isDestroyed()) {
            entry.info.window.show();
            entry.info.window.focus();
          }
        }
      });
    });
  }

  if (hasArtifactWindows) {
    if (hasDetachedWindows) {
      submenu.push({ type: 'separator' });
    }
    for (const info of artifactWindows.values()) {
      if (info.window && !info.window.isDestroyed()) {
        submenu.push({
          label: info.name || 'Artifact Preview',
          click: () => {
            if (info.window && !info.window.isDestroyed()) {
              info.window.show();
              info.window.focus();
            }
          }
        });
      }
    }
  }

  submenu.push({ type: 'separator' });
  submenu.push({ role: 'front' });

  return submenu;
}

/**
 * Create application menu
 */
function createMenu() {
  const currentChannel = getCurrentChannelInfo();
  const channelLabel = currentChannel.label;
  const aboutChannelLabel = getResolvedBuildChannelInfo(state.buildInfo).label;

  const template = [
    {
      label: 'Portico',
      submenu: [
        {
          label: 'About Portico',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'About Portico',
              message: 'Portico',
              detail: `AI-powered chat interface with MCP integration\n\nVersion: 1.0.0\nBuild: ${state.buildInfo.buildNumber}\nChannel: ${aboutChannelLabel}\n\nPowered by open source tools, including, but not limited to, Open WebUI, MCPO, and Bifrost.\n\n© 2026 Portico`,
              buttons: ['OK'],
              icon: getThemeIcon()
            });
          }
        },
        { type: 'separator' },
        {
          label: `Release Channel: ${channelLabel}`,
          enabled: false
        },
        {
          label: 'Switch Release Channel',
          submenu: createReleaseChannelMenuItems(currentChannel, {
            stable: () => setReleaseChannel('stable'),
            beta: () => setReleaseChannel('beta'),
            dev: () => setReleaseChannel('dev'),
            custom: async () => {
              try {
                const { showReleaseChannelPrompt } = require('./windows');
                const channelName = await showReleaseChannelPrompt({
                  initialValue: currentChannel.kind === 'custom'
                    ? currentChannel.name
                    : '',
                });
                if (channelName === null) {
                  createMenu();
                  return;
                }
                setReleaseChannel(channelName);
              } catch (error) {
                console.error('[Channel] Custom channel prompt failed:', error);
                dialog.showErrorBox(
                  'Channel Switch Failed',
                  `Failed to choose a custom channel: ${error.message}`,
                );
                createMenu();
              }
            },
          })
        },
        {
          label: 'Check for Updates...',
          click: async () => {
            // This will be wired to updates.js
            const { checkForUpdatesFromMenu } = require('./windows');
            await checkForUpdatesFromMenu();
          }
        },
        {
          label: 'Reinstall Latest Build...',
          click: async () => {
            const { reinstallLatestBuildFromMenu } = require('./windows');
            await reinstallLatestBuildFromMenu();
          }
        },
        {
          label: 'Install Specific Build...',
          click: async () => {
            const { installSpecificBuildFromMenu } = require('./windows');
            await installSpecificBuildFromMenu();
          }
        },
        { type: 'separator' },
        // macOS standard application-menu items. Without `hide` / `hideOthers`
        // / `unhide` here, Cmd+H, Cmd+Alt+H, and "Show All" are not bound.
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Search Conversations\u2026',
          accelerator: 'Shift+CmdOrCtrl+F',
          click: () => {
            const { BrowserWindow } = require('electron');
            const focusedWin = BrowserWindow.getFocusedWindow();
            const { resolveLocalFindOwnerWindow } = require('./windows');
            const targetWin = resolveLocalFindOwnerWindow(focusedWin);
            if (targetWin && !targetWin.isDestroyed()) {
              const owuiViews = require('./owui-views');
              owuiViews.sendToActiveViewForWindow(targetWin.id, 'trigger-search', {});
              const activeViewKey = owuiViews.getActiveViewKeyForWindow(targetWin.id);
              if (activeViewKey) {
                void owuiViews.focusView(activeViewKey).catch(() => {});
              }
            }
          }
        },
        {
          label: 'Find in Current Chat',
          accelerator: 'CmdOrCtrl+F',
          click: () => {
            const { BrowserWindow } = require('electron');
            const focusedWin = BrowserWindow.getFocusedWindow();
            const { resolveLocalFindOwnerWindow } = require('./windows');
            const targetWin = resolveLocalFindOwnerWindow(focusedWin);
            if (targetWin && !targetWin.isDestroyed()) {
              targetWin.webContents.send('find-in-page-open');
            }
          }
        },
        {
          label: 'Find Next in Current Chat',
          accelerator: 'CmdOrCtrl+G',
          click: () => {
            const { BrowserWindow } = require('electron');
            const focusedWin = BrowserWindow.getFocusedWindow();
            const { resolveLocalFindOwnerWindow } = require('./windows');
            const targetWin = resolveLocalFindOwnerWindow(focusedWin);
            if (targetWin && !targetWin.isDestroyed()) {
              targetWin.webContents.send('find-in-page-next');
            }
          }
        },
        {
          label: 'Find Previous in Current Chat',
          accelerator: 'Shift+CmdOrCtrl+G',
          click: () => {
            const { BrowserWindow } = require('electron');
            const focusedWin = BrowserWindow.getFocusedWindow();
            const { resolveLocalFindOwnerWindow } = require('./windows');
            const targetWin = resolveLocalFindOwnerWindow(focusedWin);
            if (targetWin && !targetWin.isDestroyed()) {
              targetWin.webContents.send('find-in-page-prev');
            }
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: buildWindowMenu()
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open Logs Folder',
          click: () => {
            const paths = getLogPaths();
            if (paths) {
              shell.openPath(paths.logDir);
            }
          }
        },
        ...(!app.isPackaged ? [{
          label: 'Open Debug Monitor',
          click: () => {
            void openHttpExternalUrl(shell, buildDebugMonitorUrl()).catch(() => {});
          }
        }] : []),
        { type: 'separator' },
        {
          label: 'Documentation',
          click: () => {
            void openHttpExternalUrl(shell, 'https://link.example.invalid/portico').catch(() => {});
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/**
 * Update the Window menu to reflect current artifact windows
 * Called when artifact windows are opened or closed
 */
function updateWindowMenu() {
  createMenu();  // Rebuild entire menu (simple approach)
}

/**
 * Get config path for saving project root
 */
function getConfigPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'project-config.json');
}

/**
 * Save project root to config file
 */
function saveProjectRoot(projectRoot, context = {}) {
  try {
    const configPath = getConfigPath();
    const config = { projectRoot, savedAt: new Date().toISOString() };
    const logContext = {
      reason: context.reason || 'unspecified',
      source: context.source || 'unknown',
      projectRoot,
      configPath,
      savedAt: config.savedAt,
      isPackaged: app.isPackaged,
      cwd: process.cwd()
    };
    if (context.details && typeof context.details === 'object') {
      logContext.details = context.details;
    }
    console.log('[ProjectRoot] Writing project-config.json', logContext);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('[ProjectRoot] Saved project root to:', configPath);
    return true;
  } catch (error) {
    console.error('[ProjectRoot] Failed to save project root:', error);
    return false;
  }
}

/**
 * Load saved project root from config file
 */
function loadSavedProjectRoot(options = {}) {
  const { allowMissing = false } = options;
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.projectRoot && !isRootPath(config.projectRoot)) {
        const missingFiles = getMissingProjectFiles(config.projectRoot);
        if (missingFiles.length === 0) {
          console.log('Loaded saved project root from:', configPath);
          console.log('Project root:', config.projectRoot);
          console.log('Saved at:', config.savedAt);
          return config.projectRoot;
        }

        if (allowMissing) {
          console.warn('[ProjectRoot] Saved project root missing expected files; using anyway', {
            projectRoot: config.projectRoot,
            missingFiles,
            savedAt: config.savedAt
          });
          return config.projectRoot;
        }

        console.log('Saved project root is no longer valid:', config.projectRoot);
      }
    }
  } catch (error) {
    console.error('Failed to load saved project root:', error);
  }
  return null;
}

/**
 * Initialize project root path
 */
function initializeProjectRoot() {
  if (app.isPackaged) {
    const managedRoot = getDefaultManagedRoot();
    const savedRoot = loadSavedProjectRoot({ allowMissing: true });

    // Packaged apps always treat the managed runtime tree as the mutable project root.
    // The signed .app bundle under /Applications is immutable and only provides
    // helper resources (build-info, prereq scripts, host MCP binaries, etc).
    PROJECT_ROOT = managedRoot;
    let selection = { source: 'managed-default' };

    if (savedRoot && savedRoot !== managedRoot && isValidProjectRoot(savedRoot)) {
      console.log('[ProjectRoot] Ignoring saved packaged project root in favor of managed root:', savedRoot);
    }

    let missingFiles = getMissingProjectFiles(PROJECT_ROOT);
    if (!ensureDirectoryExists(PROJECT_ROOT)) {
      console.warn('[ProjectRoot] Failed to create managed project root; continuing with best effort', {
        projectRoot: PROJECT_ROOT
      });
      missingFiles = getMissingProjectFiles(PROJECT_ROOT);
    }
    try {
      process.chdir(PROJECT_ROOT);
    } catch (error) {
      console.warn('[ProjectRoot] Failed to change directory:', error.message);
    }

    if (missingFiles.length === 0) {
      console.log('Using packaged project root:', PROJECT_ROOT);
    } else {
      console.warn('[ProjectRoot] Packaged root missing expected files', {
        projectRoot: PROJECT_ROOT,
        missingFiles,
        source: selection.source
      });
    }

    if (!isRootPath(PROJECT_ROOT)) {
      saveProjectRoot(PROJECT_ROOT, {
        source: 'initializeProjectRoot',
        reason: missingFiles.length === 0 ? 'packaged-detected-root' : 'packaged-fallback-root',
        details: {
          missingFiles,
          source: selection.source
        }
      });
    }
  } else {
    // In development, go up one directory from electron-app
    PROJECT_ROOT = path.dirname(APP_ROOT);
    process.chdir(PROJECT_ROOT);
    console.log('Running in development mode from:', PROJECT_ROOT);
    saveProjectRoot(PROJECT_ROOT, {
      source: 'initializeProjectRoot',
      reason: 'dev-mode'
    });
  }

  // Set SCRIPTS_DIR after PROJECT_ROOT is set
  SCRIPTS_DIR = path.join(PROJECT_ROOT, 'src', 'scripts');

  // Update shared state
  state.PROJECT_ROOT = PROJECT_ROOT;

  // Log directory setup
  console.log('===========================================');
  console.log('Portico - Directory Setup');
  console.log('Project Root:', PROJECT_ROOT);
  console.log('Current Working Directory:', process.cwd());
  console.log('App Directory:', APP_ROOT);
  console.log('App Packaged:', app.isPackaged);
  console.log('Verifying files in project root:');
  console.log('  - .env:', fs.existsSync(path.join(PROJECT_ROOT, '.env')));
  console.log('  - system-env-presets.yaml:', fs.existsSync(path.join(PROJECT_ROOT, 'system-env-presets.yaml')));
  console.log('  - mcp-configs:', fs.existsSync(path.join(PROJECT_ROOT, 'mcp-configs')));
  console.log('  - scripts:', fs.existsSync(path.join(PROJECT_ROOT, 'src', 'scripts')));
  const devModeMarker = path.join(PROJECT_ROOT, '.dev-mode');
  const devModeMarkerExists = fs.existsSync(devModeMarker);
  const buildNumber = state.buildInfo?.buildNumber || 'unknown';
  const buildChannel = state.buildInfo?.channel || 'unknown';
  const isDevBuild = buildNumber === 'dev-build';
  console.log('[Build] Dev mode marker:', devModeMarkerExists ? devModeMarker : 'none');
  console.log(`[Build] Build number: ${buildNumber} (dev-build=${isDevBuild})`);
  console.log(`[Build] Channel: ${buildChannel}`);
  console.log('===========================================');

  return PROJECT_ROOT;
}

function getBundledScriptsDir() {
  if (!process.resourcesPath) return null;
  const candidates = [
    path.join(process.resourcesPath, 'prereq-scripts'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'prereq-scripts'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'scripts')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveScriptPath(scriptName) {
  const bundledDir = getBundledScriptsDir();
  const candidates = [];

  if (app.isPackaged && bundledDir) {
    candidates.push(path.join(bundledDir, scriptName));
  }

  if (PROJECT_ROOT) {
    candidates.push(path.join(PROJECT_ROOT, 'src', 'scripts', scriptName));
  }

  if (!app.isPackaged && bundledDir) {
    candidates.push(path.join(bundledDir, scriptName));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function ensureProjectScript(scriptName) {
  if (!PROJECT_ROOT || isRootPath(PROJECT_ROOT)) return null;

  const projectScript = path.join(PROJECT_ROOT, 'src', 'scripts', scriptName);
  if (fs.existsSync(projectScript)) {
    return projectScript;
  }

  const bundledDir = getBundledScriptsDir();
  if (!bundledDir) return null;

  const bundledScript = path.join(bundledDir, scriptName);
  if (!fs.existsSync(bundledScript)) return null;

  if (!ensureDirectoryExists(path.dirname(projectScript))) {
    return null;
  }

  try {
    fs.copyFileSync(bundledScript, projectScript);
  } catch (error) {
    console.warn('[ProjectRoot] Failed to stage script', {
      scriptName,
      error: error.message
    });
    return null;
  }

  try {
    fs.chmodSync(projectScript, 0o755);
  } catch (error) {
    console.warn('[ProjectRoot] Failed to set script permissions', {
      scriptName,
      error: error.message
    });
  }

  return projectScript;
}

// Initialization logging functions
let currentInitLogFile = null;
let initLogStream = null;

/**
 * Start initialization logging to file
 */
function startInitLogging() {
  try {
    if (initLogStream && initLogStream.writable) {
      console.log('[Main] Init logging already active, using existing stream');
      return;
    }

    // Use Application Support directory for all logs (consistent with logger.js)
    const logsDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Use consistent naming format: init-YYYY-MM-DD.log (matches app-/error- pattern)
    const dateStr = new Date().toISOString().split('T')[0];
    currentInitLogFile = path.join(logsDir, `init-${dateStr}.log`);
    initLogStream = fs.createWriteStream(currentInitLogFile, { flags: 'a' });

    // Update shared state
    state.initLogs.file = currentInitLogFile;
    state.initLogs.stream = initLogStream;

    console.log('[Main] Started initialization logging to:', currentInitLogFile);
    cleanupOldInitLogs(logsDir);
  } catch (error) {
    console.error('[Main] Failed to start init logging:', error);
  }
}

/**
 * Log to init file
 */
function logToInitFile(text, type = 'info') {
  if (initLogStream && initLogStream.writable) {
    const cleanText = text.replace(/\x1b\[[0-9;]+m/g, '');
    const timestamp = new Date().toISOString();
    initLogStream.write(`[${timestamp}] [${type.toUpperCase()}] ${cleanText}`);
  }
}

/**
 * Stop init logging
 */
function stopInitLogging() {
  if (initLogStream) {
    initLogStream.end();
    initLogStream = null;
    state.initLogs.stream = null;
    console.log('[Main] Stopped initialization logging');
  }
}

/**
 * Send log to both window and file
 */
function sendInitLog(text, type = 'info') {
  logToInitFile(text, type);
  if (state.windows.loading && !state.windows.loading.isDestroyed()) {
    state.windows.loading.webContents.send('loading-log', { text, type });
  }
}

/**
 * Cleanup old init log files (keep last 10)
 */
function cleanupOldInitLogs(logsDir) {
  try {
    const files = fs.readdirSync(logsDir)
      // Match both old (init_) and new (init-) naming patterns for cleanup
      .filter(f => (f.startsWith('init-') || f.startsWith('init_')) && f.endsWith('.log'))
      .map(f => ({ name: f, path: path.join(logsDir, f), time: fs.statSync(path.join(logsDir, f)).mtime }))
      .sort((a, b) => b.time - a.time);

    if (files.length > 10) {
      files.slice(10).forEach(file => {
        try {
          fs.unlinkSync(file.path);
          console.log('[Main] Deleted old init log:', file.name);
        } catch (err) {
          console.error('[Main] Failed to delete old log:', file.name, err);
        }
      });
    }
  } catch (error) {
    console.error('[Main] Failed to cleanup old logs:', error);
  }
}

// Export all functions and constants
module.exports = {
  // Path constants
  APP_ROOT,
  APP_SRC,
  APP_VIEWS,
  APP_SERVICES,
  PRELOAD_SCRIPT,
  get PROJECT_ROOT() { return PROJECT_ROOT; },
  get SCRIPTS_DIR() { return SCRIPTS_DIR; },

  // Initialization
  logStartupInfo,
  loadBuildInfo,
  initializeProjectRoot,

  // Utilities
  killProcessOnPort,
  clearWebviewCache,
  execPromise,

  // Theme
  getThemeIcon,
  updateAllWindowIcons,

  // Menu
  buildDebugMonitorUrl,
  getDebugMonitorAccess,
  createMenu,
  updateWindowMenu,
  getCurrentChannel,
  getCurrentChannelInfo,
  getCurrentChannelLabel,
  setReleaseChannel,
  ensureUpdateChannelSeededFromBuildInfo,

  // Config
  getConfigPath,
  saveProjectRoot,
  loadSavedProjectRoot,
  resolveScriptPath,
  ensureProjectScript,

  // Logging
  startInitLogging,
  stopInitLogging,
  logToInitFile,
  sendInitLog,
  cleanupOldInitLogs,

  // Logger access
  getLogPaths
};
