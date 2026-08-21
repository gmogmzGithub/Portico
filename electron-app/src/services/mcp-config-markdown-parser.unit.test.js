const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadModule() {
  const modulePath = require.resolve('../renderer/components/mcp-config-markdown-parser');
  delete require.cache[modulePath];
  return require('../renderer/components/mcp-config-markdown-parser');
}

class MiniClassList {
  constructor(initial = []) {
    this.classes = new Set(initial);
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

  toggle(name) {
    if (this.classes.has(name)) {
      this.classes.delete(name);
      return false;
    }
    this.classes.add(name);
    return true;
  }

  toString() {
    return [...this.classes].join(' ');
  }
}

class MiniElement {
  constructor(tagName, textContent = '') {
    this.nodeType = 1;
    this.tagName = String(tagName || 'div').toUpperCase();
    this.textContent = textContent;
    this.innerHTML = textContent;
    this.children = [];
    this.parentNode = null;
    this.parentElement = null;
    this.onclick = null;
    this.id = '';
    this.classList = new MiniClassList();
  }

  set className(value) {
    const names = String(value || '')
      .split(/\s+/)
      .filter(Boolean);
    this.classList = new MiniClassList(names);
  }

  get className() {
    return this.classList.toString();
  }

  appendChild(child) {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, referenceNode) {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }

    const index = this.children.indexOf(referenceNode);
    if (index === -1) {
      return this.appendChild(child);
    }

    child.parentNode = this;
    child.parentElement = this;
    this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentNode = null;
      child.parentElement = null;
    }
    return child;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  closest(selector) {
    if (selector !== '.mcp-config-accordion') {
      return null;
    }

    let current = this.parentNode;
    while (current) {
      if (current.classList.contains('mcp-config-accordion')) {
        return current;
      }
      current = current.parentNode;
    }

    return null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      node.children.forEach((child) => {
        if (selector === 'h2' && child.tagName === 'H2') {
          matches.push(child);
        }
        visit(child);
      });
    };

    visit(this);
    return matches;
  }

  get nextSibling() {
    if (!this.parentNode) {
      return null;
    }

    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index === -1 || index + 1 >= siblings.length) {
      return null;
    }

    return siblings[index + 1];
  }
}

function withMiniDom(run) {
  const previousDocument = global.document;
  const previousNode = global.Node;
  const previousWindow = global.window;
  const previousNavigator = global.navigator;
  const registry = new Map();

  global.Node = { ELEMENT_NODE: 1 };
  global.document = {
    createElement(tagName) {
      const element = new MiniElement(tagName);
      Object.defineProperty(element, 'id', {
        get() {
          return this._id || '';
        },
        set(value) {
          this._id = String(value || '');
          if (this._id) {
            registry.set(this._id, this);
          }
        },
      });
      return element;
    },
    getElementById(id) {
      return registry.get(id) || null;
    },
  };
  global.window = {};
  global.navigator = {};

  try {
    return run();
  } finally {
    global.document = previousDocument;
    global.Node = previousNode;
    global.window = previousWindow;
    global.navigator = previousNavigator;
  }
}

test('generateConfirmationCard includes the guided-style canned copy and guidance target hook', () => {
  const mod = loadModule();
  const html = mod.generateConfirmationCard('Is the app created?', 'confirmation-1');

  assert.match(html, /data-guidance-target="confirmation"/);
  assert.match(html, /Clicking 'No' will skip the rest of this server's configuration\./);
  assert.match(html, /mcp-config-confirmation-canned-message/);
});

test('new-chat tags render an escaped runtime action with a configurable label', () => {
  const mod = loadModule();
  const html = mod.parseMarkdownContent(
    '<new-chat label="Set up &amp; &lt;go&gt;" prompt="Help &amp; confirm &quot;Snowflake&quot;" />',
    {},
  );

  assert.match(html, /class="mcp-config-new-chat-btn"/);
  assert.match(html, /data-chat-prompt="Help &amp; confirm &quot;Snowflake&quot;"/);
  assert.match(html, />\s*Set up &amp; &lt;go&gt;\s*<\/button>/);

  const defaultLabel = mod.processNewChatTags(
    '<new-chat prompt="Help me set up Snowflake" />',
  );
  assert.match(defaultLabel, />\s*Open new chat\s*<\/button>/);
  assert.equal(mod.processNewChatTags('<new-chat label="No prompt" />').trim(), '');
  assert.equal(mod.processNewChatTags('<new-chat prompt="   " />').trim(), '');
  assert.doesNotMatch(
    mod.processNewChatTags('<new-chat prompt="Missing self close">'),
    /mcp-config-new-chat-btn/,
  );
});

test('actionable new-chat detection matches the rendered control contract', () => {
  const mod = loadModule();

  assert.equal(
    mod.hasActionableNewChatControl(
      '<new-chat prompt="Help me set up Snowflake" />',
    ),
    true,
  );
  assert.equal(
    mod.hasActionableNewChatControl(
      '<new-chat label="Set up in chat" prompt="Use &quot;chat&quot;" />',
    ),
    true,
  );
  assert.equal(
    mod.hasActionableNewChatControl('<new-chat label="No prompt" />'),
    false,
  );
  assert.equal(
    mod.hasActionableNewChatControl('<new-chat prompt="   " />'),
    false,
  );
  assert.equal(
    mod.hasActionableNewChatControl(
      '<new-chat prompt="Missing self close">',
    ),
    false,
  );
  assert.equal(mod.hasActionableNewChatControl(null), false);
});

test('new-chat buttons submit their decoded prompt through the modal callback once', async () => {
  const mod = loadModule();
  let clickHandler = null;
  const button = {
    dataset: { chatPrompt: 'Help me set up Snowflake' },
    disabled: false,
    isConnected: true,
    addEventListener(type, callback) {
      if (type === 'click') clickHandler = callback;
    },
  };
  const container = {
    querySelectorAll(selector) {
      return selector === '.mcp-config-new-chat-btn' ? [button] : [];
    },
  };
  const prompts = [];

  mod.attachEventListeners(container, {
    openNewChat: async (prompt) => {
      prompts.push(prompt);
      assert.equal(button.disabled, true);
      return true;
    },
  });

  assert.equal(typeof clickHandler, 'function');
  await clickHandler({
    preventDefault() {},
    stopPropagation() {},
  });
  assert.deepEqual(prompts, ['Help me set up Snowflake']);
  assert.equal(button.disabled, false);
});

test('createAccordionsForMcpConfig creates collapsed accordions, emits toggle callbacks, and scrolls on expand', () => {
  const mod = loadModule();

  withMiniDom(() => {
    const container = new MiniElement('div');
    const heading = new MiniElement('h2', 'Step 1');
    const paragraph = new MiniElement('p', 'Create a token');
    container.appendChild(heading);
    container.appendChild(paragraph);

    const scrollCalls = [];
    const toggles = [];
    let scheduledScroll = null;
    const scrollContainer = {
      scrollTop: 0,
      getBoundingClientRect() {
        return { top: 0, bottom: 200 };
      },
      scrollTo(args) {
        scrollCalls.push(args);
      },
    };

    mod.createAccordionsForMcpConfig(container, {
      startCollapsed: true,
      context: 'mcp-config',
      onToggle(details) {
        toggles.push(details);
      },
      scrollContainer,
      scrollSchedule(callback) {
        return callback();
      },
    });

    const accordion = container.children[0];
    const header = accordion.children[0];
    accordion.getBoundingClientRect = () => ({ top: 120, bottom: 240, height: 120 });

    assert.equal(accordion.classList.contains('collapsed'), true);
    assert.equal(accordion.children[1].children[0], paragraph);

    header.onclick();

    assert.equal(accordion.classList.contains('collapsed'), false);
    assert.equal(toggles.length, 1);
    assert.equal(toggles[0].isCollapsed, false);
    assert.deepEqual(scrollCalls, [{ top: 60, behavior: 'smooth' }]);
  });
});

test('createAccordionsForMcpConfig can auto-expand the first newly revealed accordion', () => {
  const mod = loadModule();

  withMiniDom(() => {
    const container = new MiniElement('div');
    const heading = new MiniElement('h2', 'Step 2');
    const paragraph = new MiniElement('p', 'Add OAuth scopes');
    container.appendChild(heading);
    container.appendChild(paragraph);

    const scrollCalls = [];
    const toggles = [];
    const scrollContainer = {
      scrollTop: 0,
      getBoundingClientRect() {
        return { top: 0, bottom: 200 };
      },
      scrollTo(args) {
        scrollCalls.push(args);
      },
    };

    const created = mod.createAccordionsForMcpConfig(container, {
      startCollapsed: true,
      autoExpandFirst: true,
      onToggle(details) {
        toggles.push(details);
      },
      scrollContainer,
      scrollSchedule(callback) {
        scheduledScroll = callback;
        return null;
      },
    });

    const accordion = container.children[0];
    accordion.getBoundingClientRect = () => ({ top: 120, bottom: 240, height: 120 });

    scheduledScroll();

    assert.equal(created.length, 1);
    assert.equal(accordion.classList.contains('collapsed'), false);
    assert.equal(toggles.length, 1);
    assert.equal(toggles[0].isCollapsed, false);
    assert.deepEqual(scrollCalls, [{ top: 60, behavior: 'smooth' }]);
  });
});

test('mcpConfigConfirmationYes auto-expands the newly revealed follow-up accordion', () => {
  const mod = loadModule();

  withMiniDom(() => {
    const container = global.document.createElement('div');
    const step1Accordion = global.document.createElement('div');
    step1Accordion.className = 'mcp-config-accordion';
    step1Accordion.id = 'accordion-1';
    const step1Content = global.document.createElement('div');
    step1Content.className = 'mcp-config-accordion-content';
    const confirmationCard = global.document.createElement('div');
    confirmationCard.id = 'confirmation-1';
    confirmationCard.className = 'mcp-config-confirmation-card';
    const afterContent = global.document.createElement('div');
    afterContent.id = 'after-confirmation-1';
    afterContent.className = 'mcp-config-content-after-confirmation hidden';
    const step2Heading = global.document.createElement('h2');
    step2Heading.textContent = 'Step 2';
    step2Heading.innerHTML = 'Step 2';
    const step2Paragraph = global.document.createElement('p');
    step2Paragraph.textContent = 'Add OAuth scopes';
    step2Paragraph.innerHTML = 'Add OAuth scopes';

    afterContent.appendChild(step2Heading);
    afterContent.appendChild(step2Paragraph);
    step1Content.appendChild(confirmationCard);
    step1Accordion.appendChild(step1Content);
    container.appendChild(step1Accordion);
    container.appendChild(afterContent);

    mod.mcpConfigConfirmationYes('confirmation-1', {
      scrollSchedule(callback) {
        return callback();
      },
    });

    assert.equal(step1Accordion.classList.contains('completed'), true);
    assert.equal(step1Accordion.classList.contains('collapsed'), true);
    assert.equal(afterContent.classList.contains('visible'), true);
    assert.equal(afterContent.children[0].classList.contains('mcp-config-accordion'), true);
    assert.equal(afterContent.children[0].classList.contains('collapsed'), false);
    assert.equal(afterContent.children[0].children[1].children[0], step2Paragraph);
  });
});

test('MCP config markdown parser supports the browser script-tag path without require', () => {
  const accordionVisibilityPath = path.join(
    __dirname,
    '..',
    'renderer',
    'components',
    'accordion-visibility.js',
  );
  const mcpConfigParserPath = path.join(
    __dirname,
    '..',
    'renderer',
    'components',
    'mcp-config-markdown-parser.js',
  );
  const context = {
    console,
    module: undefined,
    exports: undefined,
    require: undefined,
  };
  context.window = context;
  context.globalThis = context;
  context.navigator = {};
  context.Node = { ELEMENT_NODE: 1 };
  context.document = {
    createElement() {
      return new MiniElement('div');
    },
    getElementById() {
      return null;
    },
  };

  vm.runInNewContext(fs.readFileSync(accordionVisibilityPath, 'utf8'), context, {
    filename: 'accordion-visibility.js',
  });
  vm.runInNewContext(fs.readFileSync(mcpConfigParserPath, 'utf8'), context, {
    filename: 'mcp-config-markdown-parser.js',
  });

  assert.equal(typeof context.window.AccordionVisibility?.scheduleExpandedAccordionVisibility, 'function');
  assert.equal(typeof context.window.McpConfigMarkdownParser?.parseMarkdownContent, 'function');
});
