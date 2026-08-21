const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const mcpServersSourcePath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'mcp-servers.js',
);
const windowsServicePath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'services',
  'windows.js',
);
const updatesSourcePath = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'updates.js',
);

class FakeClassList {
  constructor() {
    this.classes = new Set();
  }

  add(...names) {
    names.filter(Boolean).forEach((name) => this.classes.add(name));
  }

  remove(...names) {
    names.filter(Boolean).forEach((name) => this.classes.delete(name));
  }

  contains(name) {
    return this.classes.has(name);
  }

  toggle(name, force) {
    if (force === undefined) {
      if (this.classes.has(name)) {
        this.classes.delete(name);
        return false;
      }
      this.classes.add(name);
      return true;
    }

    if (force) {
      this.classes.add(name);
      return true;
    }

    this.classes.delete(name);
    return false;
  }
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.classList = new FakeClassList();
    this.style = {
      display: 'none',
      opacity: '0',
      visibility: 'hidden',
      pointerEvents: 'none',
    };
    this.innerHTML = '<div>tooltip</div>';
    this.offsetWidth = 280;
    this.offsetHeight = 180;
    this.listeners = new Map();
    this.rect = { left: 48, bottom: 38, width: 120, height: 34 };
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      handlers.filter((item) => item !== handler),
    );
  }

  dispatch(type, event = {}) {
    const handlers = this.listeners.get(type) || [];
    for (const handler of handlers) {
      handler({
        currentTarget: this,
        target: this,
        preventDefault() {},
        stopPropagation() {},
        ...event,
      });
    }
  }

  getBoundingClientRect() {
    return { ...this.rect };
  }

  contains(target) {
    return target === this;
  }
}

function createEventTarget() {
  const listeners = new Map();

  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) {
        listeners.set(type, []);
      }
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      listeners.set(
        type,
        handlers.filter((item) => item !== handler),
      );
    },
    dispatch(type, event = {}) {
      const handlers = listeners.get(type) || [];
      for (const handler of [...handlers]) {
        handler({
          type,
          preventDefault() {},
          stopPropagation() {},
          ...event,
        });
      }
    },
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMcpBadgeHarness() {
  const source = fs.readFileSync(mcpServersSourcePath, 'utf8');
  const badge = new FakeElement('mcp-badge');
  const tooltip = new FakeElement('mcp-tooltip');
  const bodyClassList = new FakeClassList();
  const documentEvents = createEventTarget();
  const windowEvents = createEventTarget();

  const document = {
    hidden: false,
    body: {
      classList: bodyClassList,
      style: {},
    },
    documentElement: {
      getAttribute(name) {
        return name === 'data-theme' ? 'light' : null;
      },
    },
    getElementById(id) {
      if (id === 'mcp-badge') return badge;
      if (id === 'mcp-tooltip') return tooltip;
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener(type, handler) {
      documentEvents.addEventListener(type, handler);
    },
    removeEventListener(type, handler) {
      documentEvents.removeEventListener(type, handler);
    },
  };

  const windowObject = {
    appState: {},
    innerWidth: 1440,
    innerHeight: 900,
    electronAPI: {},
    mcpServerCardOrder: {},
    addEventListener(type, handler, options) {
      windowEvents.addEventListener(type, handler, options);
    },
    removeEventListener(type, handler, options) {
      windowEvents.removeEventListener(type, handler, options);
    },
  };

  const context = {
    window: windowObject,
    document,
    console,
    localStorage: {
      getItem() {
        return 'light';
      },
    },
    navigator: {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Math,
    Date,
    Promise,
    Set,
    Map,
    URL,
    runOAuthFlowForSingleServer() {},
    openServiceLogsPanel() {},
  };

  context.window.window = context.window;

  vm.runInNewContext(source, context, { filename: mcpServersSourcePath });
  context.window.setupMcpBadgeHover();

  return {
    badge,
    tooltip,
    bodyClassList,
    window: context.window,
    dispatchWindow(type, event = {}) {
      windowEvents.dispatch(type, event);
    },
    dispatchDocument(type, event = {}) {
      documentEvents.dispatch(type, event);
    },
  };
}

test('native MCP badge tooltip does not depend on renderer document focus', () => {
  const source = fs.readFileSync(mcpServersSourcePath, 'utf8');
  const showNativeTooltipBlock = source.slice(
    source.indexOf('function showNativeTooltip(layout, tooltip) {'),
    source.indexOf('function setTooltipVisible(visible, options = {}) {'),
  );

  assert.doesNotMatch(
    showNativeTooltipBlock,
    /document\.hasFocus\(\)/,
    'badge tooltip should not gate on renderer focus because the Chat tab OWUI BrowserView can own focus',
  );
  assert.match(
    showNativeTooltipBlock,
    /if \(document\.hidden\) \{/,
    'badge tooltip should still avoid showing while the renderer document is hidden',
  );
});

test('native MCP badge tooltip relies on main-process window focus checks', () => {
  const source = fs.readFileSync(windowsServicePath, 'utf8');
  const showShellTooltipBlock = source.slice(
    source.indexOf('async function showShellTooltip(kind, options = {}) {'),
    source.indexOf('async function showMcpTooltip(options = {}) {'),
  );

  assert.match(
    showShellTooltipBlock,
    /parentWindow\.isFocused/,
    'main-process tooltip shell should remain gated on the BrowserWindow focus state',
  );
  assert.doesNotMatch(
    showShellTooltipBlock,
    /\.includes\('mcp-tooltip-warning-content'\)/,
    'main-process tooltip shell should not special-case missing-setup warning variants',
  );
});

test('native update-prep tooltip does not depend on renderer document focus', () => {
  const source = fs.readFileSync(updatesSourcePath, 'utf8');
  const showNativeTooltipBlock = source.slice(
    source.indexOf('function showNativeUpdateTooltip(layout, tooltipEl) {'),
    source.indexOf('function clearUpdateTooltipTimer() {'),
  );

  assert.doesNotMatch(
    showNativeTooltipBlock,
    /document\.hasFocus\(\)/,
    'update-prep tooltip should not gate on renderer focus because the Chat tab OWUI BrowserView can own focus',
  );
  assert.match(
    showNativeTooltipBlock,
    /if \(document\.hidden\) return;/,
    'update-prep tooltip should still avoid showing while the renderer document is hidden',
  );
});

test('MCP badge suppression waits for meaningful pointer intent before releasing', async () => {
  const harness = buildMcpBadgeHarness();

  harness.dispatchWindow('pointermove', { clientX: 120, clientY: 40 });
  harness.window.suppressMcpBadgeTooltip({ untilPointerMove: true });

  harness.dispatchWindow('pointermove', { clientX: 120, clientY: 40 });
  harness.badge.dispatch('mouseenter');
  await wait(40);

  assert.equal(
    harness.tooltip.style.display,
    'none',
    'stationary pointermove events should not release tooltip suppression',
  );

  harness.dispatchWindow('pointermove', { clientX: 136, clientY: 40 });
  harness.badge.dispatch('mouseenter');
  await wait(40);

  assert.equal(
    harness.tooltip.style.display,
    'block',
    'meaningful pointer movement should release suppression and allow the tooltip to show again',
  );
});

test('MCP badge suppression also releases on pointerdown', async () => {
  const harness = buildMcpBadgeHarness();

  harness.dispatchWindow('pointermove', { clientX: 120, clientY: 40 });
  harness.window.suppressMcpBadgeTooltip({ untilPointerMove: true });
  harness.dispatchWindow('pointerdown', { clientX: 120, clientY: 40 });
  harness.badge.dispatch('mouseenter');
  await wait(40);

  assert.equal(
    harness.tooltip.style.display,
    'block',
    'a new pointerdown after modal dismissal should release tooltip suppression',
  );
});

test('MCP badge tooltip never shows while overlay interaction is suppressed', async () => {
  const harness = buildMcpBadgeHarness();

  harness.bodyClassList.add('overlay-interaction-suppressed');
  harness.badge.dispatch('mouseenter');
  await wait(40);

  assert.equal(
    harness.tooltip.style.display,
    'none',
    'badge tooltip should stay hidden while the renderer overlay suppression class is active',
  );

  harness.bodyClassList.remove('overlay-interaction-suppressed');
  harness.badge.dispatch('mouseenter');
  await wait(40);

  assert.equal(
    harness.tooltip.style.display,
    'block',
    'badge tooltip should show again after overlay suppression is removed',
  );
});

test('MCP badge tooltip uses a tiny show debounce before appearing', async () => {
  const harness = buildMcpBadgeHarness();

  harness.badge.dispatch('mouseenter');
  await wait(10);

  assert.equal(
    harness.tooltip.style.display,
    'none',
    'badge tooltip should not appear before the reduced debounce elapses',
  );

  await wait(30);

  assert.equal(
    harness.tooltip.style.display,
    'block',
    'badge tooltip should appear shortly after hover begins',
  );
});

test('MCP badge tooltip hides immediately on mouseleave', async () => {
  const harness = buildMcpBadgeHarness();

  harness.badge.dispatch('mouseenter');
  await wait(40);

  assert.equal(harness.tooltip.style.display, 'block');

  harness.badge.dispatch('mouseleave');

  assert.equal(
    harness.tooltip.style.display,
    'none',
    'badge tooltip should hide synchronously on mouseleave',
  );
});

test('MCP badge tooltip cancels a pending show when hover ends early', async () => {
  const harness = buildMcpBadgeHarness();

  harness.badge.dispatch('mouseenter');
  await wait(10);
  harness.badge.dispatch('mouseleave');
  await wait(40);

  assert.equal(
    harness.tooltip.style.display,
    'none',
    'badge tooltip should stay hidden when the pointer leaves before the debounce completes',
  );
});
