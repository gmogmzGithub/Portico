#!/usr/bin/env node
/**
 * Bundle renderer scripts for Electron with contextIsolation
 * This bundles guided-setup.js and its dependencies into a single file
 * that doesn't require nodeIntegration
 */

const esbuild = require('esbuild');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src');
const outDir = path.join(srcDir, 'renderer', 'dist');

async function bundle() {
  console.log('Bundling renderer code...');

  try {
    // Bundle guided-setup
    await esbuild.build({
      entryPoints: [path.join(srcDir, 'renderer', 'views', 'guided-setup.js')],
      bundle: true,
      outfile: path.join(outDir, 'guided-setup.bundle.js'),
      platform: 'browser',
      target: 'chrome120',
      format: 'iife',
      minify: false,
      sourcemap: true,
      // Don't bundle electron - it's not available in renderer anyway
      external: ['electron'],
      // Define globals that will come from the preload
      define: {
        'process.env.NODE_ENV': '"production"'
      },
      // Handle Node.js builtins that shouldn't be in the bundle
      alias: {
        'fs': path.join(__dirname, 'empty-module.js'),
        'path': path.join(__dirname, 'empty-module.js'),
      },
      logLevel: 'info'
    });
    console.log('Bundle created: src/renderer/dist/guided-setup.bundle.js');

    // Bundle agent-skills (with marked dependency)
    await esbuild.build({
      entryPoints: [path.join(srcDir, 'renderer', 'components', 'agent-skills.js')],
      bundle: true,
      outfile: path.join(outDir, 'agent-skills.bundle.js'),
      platform: 'browser',
      target: 'chrome120',
      format: 'iife',
      minify: false,
      sourcemap: true,
      external: ['electron'],
      define: {
        'process.env.NODE_ENV': '"production"'
      },
      logLevel: 'info'
    });
    console.log('Bundle created: src/renderer/dist/agent-skills.bundle.js');

    // Bundle the sensitive-info Markdown renderer with the existing marked dependency.
    await esbuild.build({
      entryPoints: [path.join(srcDir, 'renderer', 'components', 'sensitive-info-markdown-renderer.js')],
      bundle: true,
      outfile: path.join(outDir, 'sensitive-info-markdown-renderer.bundle.js'),
      platform: 'browser',
      target: 'chrome120',
      format: 'iife',
      minify: false,
      sourcemap: true,
      external: ['electron'],
      define: {
        'process.env.NODE_ENV': '"production"'
      },
      logLevel: 'info'
    });
    console.log('Bundle created: src/renderer/dist/sensitive-info-markdown-renderer.bundle.js');

  } catch (error) {
    console.error('Bundle failed:', error);
    if (require.main === module) process.exit(1);
    throw error;
  }
}

// CLI: `node scripts/bundle-renderer.js` (packaged builds run this via
// prepare:packaged-build). Also importable — dev app startup rebuilds the
// bundles so a stale renderer/dist can never be served during development.
if (require.main === module) {
  bundle();
}

module.exports = { bundleRendererScripts: bundle };
