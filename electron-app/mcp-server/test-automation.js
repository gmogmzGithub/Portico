#!/usr/bin/env node
/**
 * Test script for Portico Electron MCP automation
 * This demonstrates the agentic workflow that Claude Code will use
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Start MCP server as subprocess
const server = spawn('node', [join(__dirname, 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let requestId = 1;
let responseBuffer = '';

// Handle server output
server.stdout.on('data', (data) => {
  responseBuffer += data.toString();
  // Try to parse complete JSON responses
  const lines = responseBuffer.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    try {
      const response = JSON.parse(lines[i]);
      console.log('\n📥 Response:', JSON.stringify(response.result, null, 2));
    } catch (e) {
      // Not JSON, might be partial
    }
  }
  responseBuffer = lines[lines.length - 1];
});

server.stderr.on('data', (data) => {
  console.log('🔧', data.toString().trim());
});

// Send MCP request
function sendRequest(method, params = {}) {
  const request = {
    jsonrpc: '2.0',
    id: requestId++,
    method,
    params
  };
  console.log('\n📤 Request:', method, params.name || '');
  server.stdin.write(JSON.stringify(request) + '\n');
}

// Wait helper
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Main automation flow
async function main() {
  console.log('🚀 Starting Portico Electron MCP Automation Test\n');
  console.log('=' .repeat(50));

  // Step 1: Launch app
  console.log('\n📱 Step 1: Launching Electron app...');
  sendRequest('tools/call', { name: 'electron_launch', arguments: {} });
  await wait(5000);

  // Step 2: Wait for webview
  console.log('\n⏳ Step 2: Waiting for app to initialize...');
  sendRequest('tools/call', { name: 'electron_wait_ready', arguments: { timeout: 120000 } });
  await wait(60000); // Wait up to 60s for the app

  // Step 3: Get snapshot
  console.log('\n📸 Step 3: Getting accessibility snapshot...');
  sendRequest('tools/call', { name: 'electron_snapshot', arguments: {} });
  await wait(3000);

  // Step 4: Take screenshot
  console.log('\n🖼️ Step 4: Taking screenshot...');
  sendRequest('tools/call', { name: 'electron_screenshot', arguments: { name: 'test-automation' } });
  await wait(2000);

  // Step 5: Type a message
  console.log('\n⌨️ Step 5: Typing test message...');
  sendRequest('tools/call', { name: 'electron_type', arguments: {
    text: 'Hello! This is an automated test from the MCP server.',
    submit: true
  }});
  await wait(15000); // Wait for response

  // Step 6: Take final screenshot
  console.log('\n🖼️ Step 6: Taking final screenshot...');
  sendRequest('tools/call', { name: 'electron_screenshot', arguments: { name: 'test-response' } });
  await wait(2000);

  // Step 7: Get info
  console.log('\n📊 Step 7: Getting app info...');
  sendRequest('tools/call', { name: 'electron_info', arguments: {} });
  await wait(2000);

  console.log('\n' + '='.repeat(50));
  console.log('✅ Automation test complete!');
  console.log('Check /tmp/portico-electron-mcp-screenshots/ for screenshots');

  // Keep running for a bit to see results
  await wait(5000);

  // Close app
  console.log('\n🔚 Closing app...');
  sendRequest('tools/call', { name: 'electron_close', arguments: {} });
  await wait(2000);

  server.kill();
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  server.kill();
  process.exit(1);
});
