/**
 * Playwright configuration for Electron app testing
 */

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: [
    '**/*.spec.js',
    '**/*.spec.cjs',
    '**/*.spec.mjs',
    '**/*.spec.ts',
    '**/*.playwright.test.js',
    '**/*.playwright.test.cjs',
    '**/*.playwright.test.mjs',
    '**/*.playwright.test.ts',
    '**/*.pw.test.js',
    '**/*.pw.test.cjs',
    '**/*.pw.test.mjs',
    '**/*.pw.test.ts',
  ],
  timeout: 120000, // 2 minutes per test
  retries: 0,
  workers: 1, // Electron tests must run serially

  reporter: [
    ['list'],
    ['html', { outputFolder: 'tests/playwright-report' }]
  ],

  use: {
    trace: 'on-first-retry',
    video: 'on',
    screenshot: 'on',
  },

  // Output directory for videos and traces
  outputDir: 'tests/test-results',
});
