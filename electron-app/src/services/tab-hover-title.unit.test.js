const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function readRepoFile(...segments) {
  return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8');
}

test('tab buttons expose full titles across static, dynamic, and renamed states', () => {
  const tabBarSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'tab-bar.js',
  );
  const indexHtmlSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'views',
    'index.html',
  );
  const stylesSource = readRepoFile('electron-app', 'src', 'styles.css');
  const owuiViewsSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'owui-views.js',
  );
  const owuiHostSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'owui-host.js',
  );

  assert.equal(
    tabBarSource.includes('syncTabTitleAttributes(btn);'),
    true,
    'existing shell tabs should sync hover titles during tab bar init',
  );
  assert.equal(
    tabBarSource.includes('syncTabTitleAttributes(btn, title);'),
    true,
    'new dynamic tabs should set hover titles on the full tab button when created',
  );
  assert.equal(
    tabBarSource.includes('syncTabTitleAttributes(btn, displayTitle);'),
    true,
    'auto-title updates should refresh the button hover title, not just the truncated label node',
  );
  assert.equal(
    tabBarSource.includes("syncTabTitleAttributes(newLabel.closest('.tab-btn'), newName);"),
    true,
    'inline rename should keep the full tab hover title aligned with the new shell label',
  );
  assert.match(
    tabBarSource,
    /btn\.title = resolvedTitle;[\s\S]*btn\.setAttribute\('aria-label', resolvedTitle\);[\s\S]*label\.title = resolvedTitle;/s,
    'tab title syncing should update button tooltip, accessibility label, and the inner label fallback together',
  );
  assert.match(
    tabBarSource,
    /document\.addEventListener\('pointerdown', commitActiveRenameInputFromOutsidePointer, true\);[\s\S]*document\.addEventListener\('mousedown', commitActiveRenameInputFromOutsidePointer, true\);/,
    'renderer-wide pointer handling should be wired in capture phase so outside clicks can commit an active tab rename',
  );
  assert.match(
    tabBarSource,
    /function commitActiveRenameInputFromOutsidePointer\(event\) \{[\s\S]*document\.querySelector\('\.tab-rename-input'\)[\s\S]*input\.contains\(event\.target\)[\s\S]*commitRenameInput\(input\);[\s\S]*\}/s,
    'clicking any non-input renderer surface while renaming should commit through the inline rename path',
  );
  const outsidePointerBlock = tabBarSource.slice(
    tabBarSource.indexOf('function commitActiveRenameInputFromOutsidePointer'),
    tabBarSource.indexOf('function commitActiveRenameInputFromOwuiFocus'),
  );
  assert.doesNotMatch(
    outsidePointerBlock,
    /preventDefault|stopPropagation/,
    'outside-click rename commit should not intercept the clicked target normal action',
  );
  assert.doesNotMatch(
    outsidePointerBlock,
    /\.closest\?\.\('\.header, \.window-drag-strip'\)/,
    'outside-click rename commit should no longer be limited to header chrome targets',
  );
  assert.match(
    tabBarSource,
    /input\.__commitTabRename = commit;/,
    'the active rename input should expose its existing commit closure for outside clicks',
  );
  assert.match(
    tabBarSource,
    /const TAB_RENAME_ACTIVE_CLASS = 'tab-rename-active';[\s\S]*document\.body\?\.classList\.add\(TAB_RENAME_ACTIVE_CLASS\);[\s\S]*document\.body\?\.classList\.remove\(TAB_RENAME_ACTIVE_CLASS\);/s,
    'inline rename should mark the body while active and always clear the marker when editing completes',
  );
  assert.match(
    stylesSource,
    /body\.tab-rename-active \.header,\s*body\.tab-rename-active \.header \*,\s*body\.tab-rename-active \.window-drag-strip\s*\{[^}]*-webkit-app-region:\s*no-drag !important;[^}]*\}/s,
    'active inline rename should temporarily disable header drag regions so empty chrome clicks reach the renderer',
  );
  assert.match(
    owuiViewsSource,
    /contents\.on\("focus", \(\) => \{[\s\S]*emitToOwner\(entry, "focus", serializeEntry\(entry\)\);[\s\S]*\}\);/s,
    'OWUI native view focus should be emitted back to the owner renderer',
  );
  assert.match(
    owuiHostSource,
    /case "focus":[\s\S]*props\.viewKey = payload\.viewKey;[\s\S]*break;/s,
    'OWUI focus payloads should dispatch a renderer host event that tab-bar can observe',
  );
  assert.match(
    tabBarSource,
    /document\.addEventListener\('focus', commitActiveRenameInputFromOwuiFocus, true\);[\s\S]*function commitActiveRenameInputFromOwuiFocus\(event\) \{[\s\S]*event\.target\?\.dataset\?\.owuiHost !== 'true'[\s\S]*commitActiveRenameInput\(\);[\s\S]*\}/s,
    'OWUI host focus events should commit an active inline tab rename',
  );
  assert.match(
    indexHtmlSource,
    /<button[\s\S]*class="control-plane-toggle"[\s\S]*id="control-plane-toggle"[\s\S]*title="Control Plane"[\s\S]*aria-label="Control Plane"/s,
    'the Control Plane header button should expose its full title before renderer hydration',
  );
  assert.doesNotMatch(
    indexHtmlSource,
    /data-tab="control"/,
    'the Control Plane should no longer render as a visible tab-strip button',
  );
  assert.match(
    indexHtmlSource,
    /data-tab="chat"[^>]*title="Chat"[^>]*aria-label="Chat"/,
    'the permanent chat tab should expose its full title before renderer hydration',
  );
  assert.match(
    indexHtmlSource,
    /data-tab="chat"[\s\S]*<span class="tab-label" title="Chat">Chat<\/span>[\s\S]*<span class="tab-status-indicator hidden" aria-hidden="true"><\/span>[\s\S]*<span class="tab-close-spacer" aria-hidden="true"><\/span>/s,
    'the permanent chat tab should use the same post-label layout slots as dynamic chat tabs',
  );
});
