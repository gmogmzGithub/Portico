#!/usr/bin/env node
/**
 * Portico Electron MCP Server
 *
 * A custom MCP server for automating the Portico Electron app.
 * Provides tools for launching, navigating, clicking, typing, and taking screenshots.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { _electron } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths
const ELECTRON_APP_DIR = join(__dirname, '..');
const PROJECT_ROOT = join(ELECTRON_APP_DIR, '..');
const SCREENSHOTS_DIR = join(tmpdir(), 'portico-electron-mcp-screenshots');

// Ensure screenshots directory exists
if (!existsSync(SCREENSHOTS_DIR)) {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

// State
let electronApp = null;
let mainWindow = null;
let webviewPage = null;
let currentOwuiViewKey = null;
let refCounter = 100;
let elementRefMap = new Map();

async function findOwuiHostPage() {
  if (!electronApp) {
    return null;
  }

  const allWindows = electronApp.windows();
  for (const page of allWindows) {
    try {
      const result = await page.evaluate(async () => {
        if (!window.electronAPI?.owui?.listViews) {
          return null;
        }
        try {
          const views = await window.electronAPI.owui.listViews();
          return Array.isArray(views) ? views : null;
        } catch (error) {
          return null;
        }
      });

      if (Array.isArray(result)) {
        return { page, views: result };
      }
    } catch (error) {
      // Window might not be ready or may have closed.
    }
  }

  return null;
}

async function getOwuiViews() {
  const result = await findOwuiHostPage();
  return result || { page: null, views: [] };
}

/**
 * Launch the Electron app
 */
async function launchApp() {
  if (electronApp) {
    console.error('[MCP] App already running');
    return { success: true, message: 'App already running' };
  }

  console.error('[MCP] Launching Electron app...');

  electronApp = await _electron.launch({
    args: [ELECTRON_APP_DIR, '--dev'],
    cwd: PROJECT_ROOT,
    timeout: 60000,
  });

  console.error('[MCP] Waiting for main window...');
  mainWindow = await electronApp.firstWindow();
  console.error('[MCP] Main window ready:', await mainWindow.title());

  // Listen for new windows (the main app window replaces loading screen)
  electronApp.on('window', async (page) => {
    const title = await page.title();
    console.error('[MCP] New window detected:', title);
    if (!title.includes('Loading')) {
      mainWindow = page;
    }
  });

  return { success: true, message: 'Electron app launched' };
}

/**
 * Wait for the app to fully initialize and find the appropriate window
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} mode - 'webview' (default), 'guided-setup', or 'any'
 */
async function waitForWebview(timeoutMs = 180000, mode = 'any') {
  if (!electronApp) {
    throw new Error('App not launched. Call electron_launch first.');
  }

  console.error(`[MCP] Waiting for window (mode: ${mode})...`);

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const allWindows = electronApp.windows();

    for (const page of allWindows) {
      try {
        const url = page.url();
        const title = await page.title();

        // Check for guided setup window
        if ((mode === 'guided-setup' || mode === 'any') &&
            url.includes('guided-setup.html')) {
          // For guided setup, use mainWindow directly (no webview)
          mainWindow = page;
          webviewPage = null; // Clear webview reference
          console.error('[MCP] Found guided setup window:', url);
          return { success: true, message: 'Guided setup ready', url, mode: 'guided-setup', title };
        }

        // Check for any Electron window with content (not loading/blank)
        if (mode === 'any' && url.includes('file://') && !url.includes('loading.html')) {
          const content = await page.content();
          if (content && content.length > 500) { // Has meaningful content
            mainWindow = page;
            console.error('[MCP] Found Electron window:', url);
            return { success: true, message: 'Window ready', url, mode: 'electron', title };
          }
        }
      } catch (e) {
        // Window might have closed
      }
    }

    if (mode === 'webview' || mode === 'any') {
      const { page, views } = await getOwuiViews();
      if (page && views.length > 0) {
        const preferred =
          views.find((view) => view.viewKey === 'main') ||
          views.find((view) => view.visible) ||
          views[0];
        mainWindow = page;
        webviewPage = null;
        currentOwuiViewKey = preferred.viewKey;
        console.error('[MCP] Found OWUI view:', preferred.viewKey, preferred.currentUrl || preferred.requestedUrl || '');
        return {
          success: true,
          message: 'OWUI view ready',
          url: preferred.currentUrl || preferred.requestedUrl || '',
          mode: 'webview',
          viewKey: preferred.viewKey,
        };
      }
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  throw new Error(`Timeout waiting for window (mode: ${mode})`);
}

/**
 * Get accessibility snapshot of the current page
 */
async function getSnapshot() {
  const page = webviewPage || mainWindow;
  if (!page) {
    throw new Error('No page available. Launch app first.');
  }

  const snapshot = await page.accessibility.snapshot();
  elementRefMap.clear();
  refCounter = 100;

  // Recursively add refs to elements
  function addRefs(node, depth = 0) {
    if (!node) return null;

    const ref = `e${refCounter++}`;
    const result = {
      ref,
      role: node.role,
      name: node.name || '',
      value: node.value || '',
      description: node.description || '',
      focused: node.focused || false,
      children: []
    };

    elementRefMap.set(ref, {
      role: node.role,
      name: node.name,
      selector: `[aria-label="${node.name}"]` // Simplified selector
    });

    if (node.children) {
      result.children = node.children.map(child => addRefs(child, depth + 1)).filter(Boolean);
    }

    return result;
  }

  const tree = addRefs(snapshot);

  return {
    url: page.url(),
    title: await page.title(),
    snapshot: tree
  };
}

/**
 * Click an element
 */
async function clickElement(ref, description) {
  const page = webviewPage || mainWindow;
  if (!page) throw new Error('No page available');

  // Try to click by accessibility name first
  const info = elementRefMap.get(ref);
  if (info && info.name) {
    try {
      await page.getByRole(info.role, { name: info.name }).click({ timeout: 5000 });
      return { success: true, message: `Clicked ${description || info.name}` };
    } catch (e) {
      console.error('[MCP] Role click failed, trying locator');
    }
  }

  // Fallback to text content
  if (description) {
    try {
      await page.getByText(description).first().click({ timeout: 5000 });
      return { success: true, message: `Clicked ${description}` };
    } catch (e) {
      console.error('[MCP] Text click failed');
    }
  }

  throw new Error(`Could not find element to click: ${ref} / ${description}`);
}

/**
 * Type text into an element
 */
async function typeText(text, ref, submit = false) {
  const page = webviewPage || mainWindow;
  if (!page) throw new Error('No page available');

  // For chat input, use contenteditable
  try {
    const input = page.locator('[contenteditable="true"]').first();
    await input.click();
    await input.fill(text);

    if (submit) {
      await page.keyboard.press('Enter');
    }

    return { success: true, message: `Typed: ${text}${submit ? ' (submitted)' : ''}` };
  } catch (e) {
    // Try regular input
    const input = page.locator('input, textarea').first();
    await input.fill(text);
    if (submit) {
      await page.keyboard.press('Enter');
    }
    return { success: true, message: `Typed: ${text}${submit ? ' (submitted)' : ''}` };
  }
}

/**
 * Take a screenshot
 */
async function takeScreenshot(name = 'screenshot') {
  const filename = `${name}-${Date.now()}.png`;
  const filepath = join(SCREENSHOTS_DIR, filename);

  if (currentOwuiViewKey) {
    const { page } = await getOwuiViews();
    if (page) {
      const pngBase64 = await page.evaluate(async (viewKey) => {
        return window.electronAPI?.owui?.capturePage
          ? window.electronAPI.owui.capturePage(viewKey)
          : null;
      }, currentOwuiViewKey);

      if (pngBase64) {
        writeFileSync(filepath, Buffer.from(pngBase64, 'base64'));
        return {
          success: true,
          message: `Screenshot saved`,
          path: filepath
        };
      }
    }
  }

  const page = webviewPage || mainWindow;
  if (!page) throw new Error('No page available');
  await page.screenshot({ path: filepath });

  return {
    success: true,
    message: `Screenshot saved`,
    path: filepath
  };
}

/**
 * Press a key
 */
async function pressKey(key) {
  const page = webviewPage || mainWindow;
  if (!page) throw new Error('No page available');

  await page.keyboard.press(key);
  return { success: true, message: `Pressed ${key}` };
}

/**
 * Evaluate JavaScript in the page
 */
async function evaluate(code) {
  if (currentOwuiViewKey) {
    const { page } = await getOwuiViews();
    if (page) {
      const result = await page.evaluate(
        async ({ viewKey, script }) => {
          if (!window.electronAPI?.owui?.executeJavaScript) {
            throw new Error('OWUI execute bridge unavailable');
          }
          return window.electronAPI.owui.executeJavaScript(viewKey, script);
        },
        { viewKey: currentOwuiViewKey, script: code }
      );
      return { success: true, result };
    }
  }

  const page = webviewPage || mainWindow;
  if (!page) throw new Error('No page available');
  const result = await page.evaluate(code);
  return { success: true, result };
}

/**
 * Close the app
 */
async function closeApp() {
  if (electronApp) {
    await electronApp.close();
    electronApp = null;
    mainWindow = null;
    webviewPage = null;
    currentOwuiViewKey = null;
  }
  return { success: true, message: 'App closed' };
}

/**
 * Get current page info
 */
async function getPageInfo() {
  const page = webviewPage || mainWindow;
  if (!page) {
    return {
      launched: !!electronApp,
      mainWindow: !!mainWindow,
      webview: !!webviewPage,
      owuiViewKey: currentOwuiViewKey,
      message: 'App not fully initialized'
    };
  }

  if (currentOwuiViewKey) {
    const { views } = await getOwuiViews();
    const selectedView = views.find((view) => view.viewKey === currentOwuiViewKey) || null;
    return {
      launched: true,
      mainWindow: !!mainWindow,
      webview: Boolean(currentOwuiViewKey),
      owuiViewKey: currentOwuiViewKey,
      url: selectedView?.currentUrl || selectedView?.requestedUrl || page.url(),
      title: await page.title()
    };
  }

  return {
    launched: true,
    mainWindow: !!mainWindow,
    webview: !!webviewPage,
    owuiViewKey: currentOwuiViewKey,
    url: page.url(),
    title: await page.title()
  };
}

/**
 * List all available webviews (pages that contain localhost:3789)
 */
async function listWebviews() {
  if (!electronApp) {
    throw new Error('App not launched. Call electron_launch first.');
  }

  const { views } = await getOwuiViews();
  const webviews = views.map((view, index) => ({
    index,
    url: view.currentUrl || view.requestedUrl || '',
    title: view.windowType || 'owui',
    viewKey: view.viewKey,
    isCurrent: view.viewKey === currentOwuiViewKey,
  }));
  const currentIndex = webviews.findIndex((view) => view.isCurrent);

  return {
    success: true,
    webviews,
    currentIndex,
    total: webviews.length
  };
}

/**
 * Switch to a specific webview by URL pattern or index
 */
async function switchWebview(urlPattern, index) {
  if (!electronApp) {
    throw new Error('App not launched. Call electron_launch first.');
  }

  const { views } = await getOwuiViews();
  let targetView = null;

  // Find by URL pattern if provided
  if (urlPattern) {
    for (const view of views) {
      const url = view.currentUrl || view.requestedUrl || '';
      if (url.includes(urlPattern) || view.viewKey.includes(urlPattern)) {
        targetView = view;
        break;
      }
    }
  }
  // Otherwise find by index
  else if (typeof index === 'number' && index >= 0 && index < views.length) {
    targetView = views[index];
  }

  if (!targetView) {
    throw new Error(`Could not find webview. Pattern: ${urlPattern}, Index: ${index}. Available: ${views.map(v => v.currentUrl || v.requestedUrl || v.viewKey).join(', ')}`);
  }

  currentOwuiViewKey = targetView.viewKey;
  webviewPage = null;
  const newUrl = targetView.currentUrl || targetView.requestedUrl || '';
  const newTitle = targetView.windowType || 'owui';

  console.error(`[MCP] Switched to OWUI view: ${targetView.viewKey} (${newUrl})`);

  return {
    success: true,
      message: `Switched to webview`,
    url: newUrl,
    title: newTitle,
    viewKey: targetView.viewKey,
  };
}

/**
 * Reload the Electron wrapper UI (main window)
 * This reloads the Electron renderer HTML, not the webview content
 */
async function reloadElectronView() {
  if (!electronApp) {
    throw new Error('App not launched. Call electron_launch first.');
  }

  console.error('[MCP] Reloading Electron wrapper UI...');

  // Find the window that contains the webview (the actual app, not loading screen)
  const allWindows = electronApp.windows();
  let targetWindow = null;

  for (const page of allWindows) {
    try {
      const title = await page.title();
      const url = page.url();
      console.error(`[MCP] Window: "${title}" @ ${url}`);

      // Find the window with the index.html (Electron wrapper UI)
      if (url.includes('index.html') && !title.includes('Loading')) {
        targetWindow = page;
        break;
      }
    } catch (e) {
      // Window might have closed
    }
  }

  if (!targetWindow) {
    // Fallback: try to use mainWindow if it's still valid
    if (mainWindow) {
      try {
        const url = mainWindow.url();
        if (url.includes('index.html')) {
          targetWindow = mainWindow;
        }
      } catch (e) {
        // mainWindow is stale
      }
    }
  }

  if (!targetWindow) {
    throw new Error('Could not find Electron wrapper window to reload. The app may still be loading.');
  }

  // Reload the window
  await targetWindow.reload();

  // Wait for reload to complete
  await new Promise(r => setTimeout(r, 2000));

  // Update references
  mainWindow = targetWindow;
  webviewPage = null;
  currentOwuiViewKey = null;

  console.error('[MCP] Electron wrapper reloaded');

  return {
    success: true,
    message: 'Electron wrapper UI reloaded. Call electron_wait_ready to reconnect to webview.'
  };
}

// Tool definitions
const TOOLS = [
  {
    name: 'electron_launch',
    description: 'Launch the Portico Electron app',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'electron_wait_ready',
    description: 'Wait for the app to fully initialize and the webview to be ready',
    inputSchema: {
      type: 'object',
      properties: {
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 180000)'
        },
        mode: {
          type: 'string',
          enum: ['any', 'webview', 'guided-setup'],
          description: 'Window type to wait for: "any" (default) - first available window, "webview" - Open WebUI webview only, "guided-setup" - guided setup wizard only'
        }
      },
      required: []
    }
  },
  {
    name: 'electron_snapshot',
    description: 'Get accessibility snapshot of the current page with element references',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'electron_click',
    description: 'Click an element by reference or description',
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Element reference from snapshot (e.g., e123)'
        },
        description: {
          type: 'string',
          description: 'Human-readable element description'
        }
      },
      required: []
    }
  },
  {
    name: 'electron_type',
    description: 'Type text into the current input or chat field',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to type'
        },
        ref: {
          type: 'string',
          description: 'Optional element reference'
        },
        submit: {
          type: 'boolean',
          description: 'Press Enter after typing'
        }
      },
      required: ['text']
    }
  },
  {
    name: 'electron_screenshot',
    description: 'Take a screenshot of the current page',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Screenshot name prefix'
        }
      },
      required: []
    }
  },
  {
    name: 'electron_press_key',
    description: 'Press a keyboard key',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Key to press (e.g., Enter, Tab, ArrowDown)'
        }
      },
      required: ['key']
    }
  },
  {
    name: 'electron_evaluate',
    description: 'Execute JavaScript in the page context',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript code to execute'
        }
      },
      required: ['code']
    }
  },
  {
    name: 'electron_info',
    description: 'Get current app and page info',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'electron_close',
    description: 'Close the Electron app',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'electron_reload',
    description: 'Reload the Electron wrapper UI (reloads the main window HTML/JS, not the webview content). Use this to see changes to Electron app files like index.html, styles.css, etc.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'electron_list_webviews',
    description: 'List all available webviews (tabs) in the Electron app. Useful for finding subagent chat tabs.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'electron_switch_webview',
    description: 'Switch to a specific webview by URL pattern or index. Use after electron_list_webviews to target a specific tab.',
    inputSchema: {
      type: 'object',
      properties: {
        urlPattern: {
          type: 'string',
          description: 'URL pattern to match (e.g., chat ID like "06a3de3f-9a1a-4b91-893a-dd971aa48d17")'
        },
        index: {
          type: 'number',
          description: 'Webview index from electron_list_webviews (0-based)'
        }
      },
      required: []
    }
  }
];

// Tool handlers
async function handleTool(name, args) {
  switch (name) {
    case 'electron_launch':
      return await launchApp();
    case 'electron_wait_ready':
      return await waitForWebview(args.timeout || 180000, args.mode || 'any');
    case 'electron_snapshot':
      return await getSnapshot();
    case 'electron_click':
      return await clickElement(args.ref, args.description);
    case 'electron_type':
      return await typeText(args.text, args.ref, args.submit);
    case 'electron_screenshot':
      return await takeScreenshot(args.name);
    case 'electron_press_key':
      return await pressKey(args.key);
    case 'electron_evaluate':
      return await evaluate(args.code);
    case 'electron_info':
      return await getPageInfo();
    case 'electron_close':
      return await closeApp();
    case 'electron_reload':
      return await reloadElectronView();
    case 'electron_list_webviews':
      return await listWebviews();
    case 'electron_switch_webview':
      return await switchWebview(args.urlPattern, args.index);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Create MCP server
const server = new Server(
  { name: 'portico-electron-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleTool(name, args || {});
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: error.message }, null, 2)
      }],
      isError: true
    };
  }
});

// Start server
async function main() {
  console.error('[MCP] Starting Portico Electron MCP Server...');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] Server running on stdio');
}

main().catch(err => {
  console.error('[MCP] Fatal error:', err);
  process.exit(1);
});
