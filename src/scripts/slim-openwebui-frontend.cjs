// Frontend SOURCE rewrites that strip the unused Pyodide code-execution
// paths from the upstream Open WebUI checkout.
//
// PORTICO-205 cache contract: this file intentionally contains ONLY source
// rewrites. The package.json mutation (scripts.build -> 'vite build') lives
// in slim-openwebui-package-json.cjs, which runs BEFORE the npm dependency
// layers in Dockerfile.open-webui-patched; this script runs AFTER them,
// alongside the patched-frontend COPY. Moving logic between the two files
// changes which Docker layers get invalidated.

const fs = require('fs');
const path = require('path');

const buildRoot = process.argv[2] || '/build';

function readFile(relativePath) {
  return fs.readFileSync(path.join(buildRoot, relativePath), 'utf8');
}

function writeFile(relativePath, content) {
  fs.writeFileSync(path.join(buildRoot, relativePath), content);
}

function replaceOrThrow(content, searchValue, replacement, description) {
  if (!content.includes(searchValue)) {
    throw new Error(`Unable to find ${description}`);
  }
  return content.replace(searchValue, replacement);
}

function replaceBetween(content, startMarker, endMarker, replacement, description) {
  const startIndex = content.indexOf(startMarker);
  if (startIndex === -1) {
    throw new Error(`Unable to find start marker for ${description}`);
  }

  const endIndex = content.indexOf(endMarker, startIndex);
  if (endIndex === -1) {
    throw new Error(`Unable to find end marker for ${description}`);
  }

  return content.slice(0, startIndex) + replacement + content.slice(endIndex);
}

function patchLayout() {
  const relativePath = 'src/routes/+layout.svelte';
  let content = readFile(relativePath);

  content = replaceOrThrow(
    content,
    "\timport PyodideWorker from '$lib/workers/pyodide.worker?worker';\n",
    '',
    'PyodideWorker import in +layout.svelte'
  );

  content = replaceBetween(
    content,
    '\tconst executePythonAsWorker = async (id, code, cb) => {\n',
    '\n\tconst executeTool = async (data, cb) => {\n',
    '',
    'executePythonAsWorker block in +layout.svelte'
  );

  content = replaceOrThrow(
    content,
    "\t\t\tif (type === 'execute:python') {\n\t\t\t\tconsole.log('execute:python', data);\n\t\t\t\texecutePythonAsWorker(data.id, data.code, cb);\n\t\t\t} else if (type === 'execute:tool') {\n",
    "\t\t\tif (type === 'execute:python') {\n\t\t\t\tcb?.({ stderr: 'Code execution is disabled in this deployment' });\n\t\t\t} else if (type === 'execute:tool') {\n",
    'execute:python event handler in +layout.svelte'
  );

  writeFile(relativePath, content);
}

function patchAppLayout() {
  const relativePath = 'src/routes/(app)/+layout.svelte';
  let content = readFile(relativePath);

  content = replaceOrThrow(
    content,
    "\t\t\tif (localDBChats.length === 0) {\n\t\t\t\tawait deleteDB('Chats');\n\t\t\t}\n",
    "\t\t\tif (localDBChats.length === 0) {\n\t\t\t\tDB.close();\n\t\t\t\tDB = null;\n\t\t\t\tawait deleteDB('Chats');\n\t\t\t}\n",
    'legacy empty chat database cleanup in (app)/+layout.svelte'
  );

  writeFile(relativePath, content);
}

function patchCodeEditor() {
  const relativePath = 'src/lib/components/common/CodeEditor.svelte';
  let content = readFile(relativePath);

  content = replaceOrThrow(
    content,
    "\timport { onMount, createEventDispatcher, getContext, tick, onDestroy } from 'svelte';\n",
    "\timport { onMount, createEventDispatcher, getContext, tick } from 'svelte';\n",
    'onDestroy import in CodeEditor.svelte'
  );

  content = replaceOrThrow(
    content,
    "\timport PyodideWorker from '$lib/workers/pyodide.worker?worker';\n\n",
    '',
    'PyodideWorker import in CodeEditor.svelte'
  );

  content = replaceOrThrow(
    content,
    "\timport { user } from '$lib/stores';\n",
    '',
    'user store import in CodeEditor.svelte'
  );

  content = replaceBetween(
    content,
    '\tlet pyodideWorkerInstance = null;\n',
    '\n\texport const formatPythonCodeHandler = async () => {\n',
    '',
    'Pyodide formatter fallback block in CodeEditor.svelte'
  );

  content = replaceOrThrow(
    content,
    "\t\t\tconst res = await (\n\t\t\t\t$user?.role === 'admin'\n\t\t\t\t\t? formatPythonCode(localStorage.token, _value)\n\t\t\t\t\t: formatPythonCodePyodide(_value)\n\t\t\t).catch((error) => {\n",
    "\t\t\tconst res = await formatPythonCode(localStorage.token, _value).catch((error) => {\n",
    'formatPythonCodeHandler fallback in CodeEditor.svelte'
  );

  content = replaceOrThrow(
    content,
    "\n\tonDestroy(() => {\n\t\tif (pyodideWorkerInstance) {\n\t\t\tpyodideWorkerInstance.terminate();\n\t\t}\n\t});\n",
    '\n',
    'onDestroy cleanup in CodeEditor.svelte'
  );

  writeFile(relativePath, content);
}

function patchCodeExecutionSettings() {
  const relativePath = 'src/lib/components/admin/Settings/CodeExecution.svelte';
  let content = readFile(relativePath);

  content = replaceOrThrow(
    content,
    "\tlet engines = ['pyodide', 'jupyter'];\n",
    "\tlet engines = ['jupyter'];\n",
    'code execution engine list in CodeExecution.svelte'
  );

  writeFile(relativePath, content);
}

patchLayout();
patchAppLayout();
patchCodeEditor();
patchCodeExecutionSettings();
