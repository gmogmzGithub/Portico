// Rewrites the upstream Open WebUI package.json build script to a plain
// `vite build` (this deployment disables built-in code execution, so the
// upstream pyodide prefetch step is skipped).
//
// PORTICO-205 cache contract: this file is COPY'd into the Docker build BEFORE
// the npm dependency layers (`npm ci` / `npm install`), so it must stay
// tiny, stable, and must ONLY mutate package.json. All frontend source
// rewrites live in slim-openwebui-frontend.cjs, which runs AFTER the
// dependency layers alongside the patched-frontend COPY. Moving logic
// between the two files changes which Docker layers get invalidated —
// see Dockerfile.open-webui-patched.

const fs = require('fs');
const path = require('path');

const buildRoot = process.argv[2] || '/build';

function patchPackageJson() {
  const packageJsonPath = path.join(buildRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  if (!pkg.scripts || !pkg.scripts.build) {
    throw new Error('package.json is missing scripts.build');
  }

  pkg.scripts.build = 'vite build';
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

patchPackageJson();
