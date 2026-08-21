#!/usr/bin/env node
/**
 * Test script for electron_reload tool
 * Run with: node test-reload-tool.js
 */

import { _electron } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ELECTRON_APP_DIR = join(__dirname, '..');
const PROJECT_ROOT = join(ELECTRON_APP_DIR, '..');

async function test() {
  console.log('=== Testing electron_reload tool ===\n');

  // Launch app
  console.log('1. Launching Electron app...');
  const electronApp = await _electron.launch({
    args: [ELECTRON_APP_DIR, '--dev'],
    cwd: PROJECT_ROOT,
    timeout: 60000,
  });

  let mainWindow = await electronApp.firstWindow();
  console.log('   First window:', await mainWindow.title());

  // Wait for webview and find the correct main window
  console.log('\n2. Waiting for webview and main app window...');
  const startTime = Date.now();
  let webviewPage = null;
  let appWindow = null;

  while (Date.now() - startTime < 120000) {
    const allWindows = electronApp.windows();
    console.log(`   Checking ${allWindows.length} windows...`);

    for (const page of allWindows) {
      try {
        const url = page.url();
        const title = await page.title();

        // Find the webview (Open WebUI content)
        if (url.includes('localhost:3789') || url.includes('localhost:8080')) {
          webviewPage = page;
          console.log('   Found webview:', url);
        }

        // Find the app window (Electron wrapper with index.html)
        if (url.includes('index.html') && !title.includes('Loading')) {
          appWindow = page;
          console.log('   Found app window:', title, '@', url);
        }
      } catch (e) {}
    }

    if (webviewPage && appWindow) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!webviewPage) {
    console.error('   FAILED: Timeout waiting for webview');
    await electronApp.close();
    process.exit(1);
  }

  if (!appWindow) {
    console.error('   FAILED: Could not find app window with index.html');
    await electronApp.close();
    process.exit(1);
  }

  // Take screenshot before reload
  console.log('\n3. Taking screenshot BEFORE reload...');
  await appWindow.screenshot({ path: '/tmp/electron-before-reload.png' });
  console.log('   Saved to /tmp/electron-before-reload.png');

  // Test the reload
  console.log('\n4. Testing reload on app window...');
  try {
    await appWindow.reload();
    console.log('   Reload initiated successfully!');

    // Wait for reload
    await new Promise(r => setTimeout(r, 3000));

    // Check if we can still interact
    const title = await appWindow.title();
    console.log('   After reload, title:', title);

    // Take screenshot after reload
    console.log('\n5. Taking screenshot AFTER reload...');
    await appWindow.screenshot({ path: '/tmp/electron-after-reload.png' });
    console.log('   Saved to /tmp/electron-after-reload.png');

    console.log('\n=== RELOAD TEST PASSED ===');
    console.log('Check /tmp/electron-before-reload.png and /tmp/electron-after-reload.png');
    console.log('The "Chat 🔥" label should be visible in the after screenshot.');

  } catch (error) {
    console.error('   FAILED:', error.message);
  }

  // Close
  console.log('\n6. Closing app...');
  await electronApp.close();
  console.log('   Done!');
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
