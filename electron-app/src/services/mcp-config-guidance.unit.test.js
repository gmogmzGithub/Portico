const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { FakeElement } = require('./test-helpers/fake-dom');

function loadModule() {
  const modulePath = require.resolve('../renderer/components/mcp-config-guidance');
  delete require.cache[modulePath];
  return require('../renderer/components/mcp-config-guidance');
}

function createInput(varNameRaw, value) {
  const input = new FakeElement(`input-${varNameRaw}`);
  input.className = 'input-field';
  input.dataset.var = varNameRaw;
  input.value = value;
  const wrapper = new FakeElement(`wrapper-${varNameRaw}`);
  input.parentElement = wrapper;
  input.parentNode = wrapper;
  return input;
}

function createConfirmationCard(id, options = {}) {
  const card = new FakeElement(id);
  card.className = 'mcp-config-confirmation-card';
  if (options.answered === 'confirmed') {
    card.classList.add('confirmed');
  }
  if (options.answered === 'skipped') {
    card.classList.add('skipped');
  }

  const accordionContent = new FakeElement(`${id}-content`);
  const accordion = options.accordion || new FakeElement(`${id}-accordion`);
  accordion.className = options.accordionClassName || 'mcp-config-accordion';
  accordionContent.parentElement = accordion;
  card.parentElement = accordionContent;

  if (options.afterContentVisible !== undefined) {
    const afterContent = new FakeElement(`after-${id}`);
    afterContent.className = options.afterContentVisible
      ? 'mcp-config-content-after-confirmation visible'
      : 'mcp-config-content-after-confirmation hidden';
    accordionContent.parentElement = afterContent;
    afterContent.parentElement = accordion;
    card.parentElement = accordionContent;
  }

  return { card, accordion };
}

function createDocument({
  inputs = [],
  firstAccordion = null,
  confirmationCards = [],
  saveButtonDisabled = false,
} = {}) {
  const configContent = new FakeElement('mcp-config-content');
  const saveButton = new FakeElement('mcp-config-save-btn');
  saveButton.disabled = saveButtonDisabled;

  configContent.querySelector = (selector) => {
    if (selector === '.mcp-config-accordion') {
      return firstAccordion;
    }
    return null;
  };

  configContent.querySelectorAll = (selector) => {
    if (selector === '.input-field:not([disabled])') {
      return inputs.filter((input) => !input.disabled);
    }
    if (
      selector === '.mcp-config-accordion.is-guidance-pulsing' &&
      firstAccordion?.classList?.contains?.('is-guidance-pulsing')
    ) {
      return [firstAccordion];
    }
    if (selector === '.mcp-config-confirmation-card') {
      return confirmationCards;
    }
    if (selector === '.mcp-config-confirmation-card.is-guidance-pulsing') {
      return confirmationCards.filter((card) =>
        card.classList?.contains?.('is-guidance-pulsing'),
      );
    }
    return [];
  };

  const elementMap = {
    'mcp-config-content': configContent,
    'mcp-config-save-btn': saveButton,
  };

  if (firstAccordion?.id) {
    elementMap[firstAccordion.id] = firstAccordion;
  }
  confirmationCards.forEach((card) => {
    if (card?.id) {
      elementMap[card.id] = card;
    }
  });

  return {
    configContent,
    saveButton,
    document: {
      getElementById(id) {
        return elementMap[id] || null;
      },
      querySelector(selector) {
        if (selector === '.mcp-config-body') {
          return new FakeElement('mcp-config-body');
        }
        return null;
      },
    },
  };
}

function withDocument(doc, run) {
  const previousDocument = global.document;
  global.document = doc;
  try {
    return run();
  } finally {
    global.document = previousDocument;
  }
}

test('modal guidance pulses the first accordion on a not-ready arrival', () => {
  const mod = loadModule();
  const firstAccordion = new FakeElement('accordion-1');
  firstAccordion.className = 'mcp-config-accordion collapsed';
  const input = createInput('TOKEN', '');
  const dom = createDocument({
    firstAccordion,
    inputs: [input],
  });

  withDocument(dom.document, () => {
    const state = mod.initializeMcpConfigGuidance({ id: 'gitlab' }, {
      validateEnvValue(rawValue) {
        return { valid: !!rawValue.trim(), value: rawValue.trim() };
      },
    });

    assert.equal(state.pulseTarget, 'accordion');
    assert(firstAccordion.classList.contains('is-guidance-pulsing'));
    assert.equal(dom.saveButton.classList.contains('is-pulsing'), false);
  });
});

test('MCP config guidance supports the browser script-tag path without require', () => {
  const configurationGuidancePath = path.join(
    __dirname,
    '..',
    'renderer',
    'components',
    'configuration-guidance.js',
  );
  const mcpConfigGuidancePath = path.join(
    __dirname,
    '..',
    'renderer',
    'components',
    'mcp-config-guidance.js',
  );
  const context = {
    console,
    module: undefined,
    exports: undefined,
    require: undefined,
  };
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(fs.readFileSync(configurationGuidancePath, 'utf8'), context, {
    filename: 'configuration-guidance.js',
  });
  vm.runInNewContext(fs.readFileSync(mcpConfigGuidancePath, 'utf8'), context, {
    filename: 'mcp-config-guidance.js',
  });

  assert.equal(typeof context.window.ConfigurationGuidance?.createConfigurationGuidanceController, 'function');
  assert.equal(typeof context.window.McpConfigGuidance?.initializeMcpConfigGuidance, 'function');
});

test('modal guidance prioritizes visible confirmation cards over save guidance', () => {
  const mod = loadModule();
  const firstAccordion = new FakeElement('accordion-1');
  firstAccordion.className = 'mcp-config-accordion';
  const input = createInput('TOKEN', 'secret');
  const { card: confirmationCard } = createConfirmationCard('confirmation-1', {
    accordion: firstAccordion,
  });
  const dom = createDocument({
    firstAccordion,
    inputs: [input],
    confirmationCards: [confirmationCard],
  });

  withDocument(dom.document, () => {
    const state = mod.initializeMcpConfigGuidance({ id: 'slack' }, {
      validateEnvValue(rawValue) {
        return { valid: !!rawValue.trim(), value: rawValue.trim() };
      },
    });

    assert.equal(state.pulseTarget, 'confirmation');
    assert.equal(dom.saveButton.classList.contains('is-pulsing'), false);
    assert(confirmationCard.classList.contains('is-guidance-pulsing'));
  });
});

test('modal guidance switches to Save and Test once readiness becomes true and the confirmation is answered', () => {
  const mod = loadModule();
  const firstAccordion = new FakeElement('accordion-1');
  firstAccordion.className = 'mcp-config-accordion';
  const input = createInput('TOKEN', 'secret');
  const { card: confirmationCard } = createConfirmationCard('confirmation-1', {
    accordion: firstAccordion,
  });
  const dom = createDocument({
    firstAccordion,
    inputs: [input],
    confirmationCards: [confirmationCard],
  });

  withDocument(dom.document, () => {
    mod.initializeMcpConfigGuidance({ id: 'glean' }, {
      validateEnvValue(rawValue) {
        return { valid: !!rawValue.trim(), value: rawValue.trim() };
      },
    });

    confirmationCard.classList.add('confirmed');
    const refreshed = mod.refreshMcpConfigGuidance({
      validateEnvValue(rawValue) {
        return { valid: !!rawValue.trim(), value: rawValue.trim() };
      },
    });

    assert.equal(refreshed.pulseTarget, 'save');
    assert.equal(
      confirmationCard.classList.contains('is-guidance-pulsing'),
      false,
    );
    assert.equal(dom.saveButton.classList.contains('is-pulsing'), true);
  });
});

test('modal guidance resets between arrivals and re-pulses the first accordion for the next server', () => {
  const mod = loadModule();
  const firstAccordion = new FakeElement('accordion-1');
  firstAccordion.className = 'mcp-config-accordion collapsed';
  const input = createInput('TOKEN', '');
  const dom = createDocument({ firstAccordion, inputs: [input] });

  withDocument(dom.document, () => {
    mod.initializeMcpConfigGuidance({ id: 'gitlab' }, {});
    mod.handleMcpConfigAccordionToggle({
      accordionId: 'accordion-1',
      isCollapsed: false,
    });
    assert.equal(firstAccordion.classList.contains('is-guidance-pulsing'), false);

    mod.resetMcpConfigGuidance('slack');
    const nextArrival = mod.initializeMcpConfigGuidance({ id: 'slack' }, {});
    assert.equal(nextArrival.pulseTarget, 'accordion');
    assert.equal(firstAccordion.classList.contains('is-guidance-pulsing'), true);
  });
});

test('handleMcpConfigAccordionToggle focuses and pulses the first empty input in the expanded accordion', () => {
  const mod = loadModule();
  const filledInput = createInput('TOKEN', 'already-set');
  const pendingInput = createInput('TEAM', '');
  const firstAccordion = new FakeElement('accordion-1');
  firstAccordion.className = 'mcp-config-accordion collapsed';
  filledInput.parentElement.parentElement = firstAccordion;
  filledInput.parentNode = filledInput.parentElement;
  pendingInput.parentElement.parentElement = firstAccordion;
  pendingInput.parentNode = pendingInput.parentElement;

  const dom = createDocument({
    firstAccordion,
    inputs: [filledInput, pendingInput],
  });

  withDocument(dom.document, () => {
    mod.initializeMcpConfigGuidance({ id: 'slack' }, {});

    const toggleState = mod.handleMcpConfigAccordionToggle(
      {
        accordionId: 'accordion-1',
        isCollapsed: false,
      },
      {},
    );

    assert.equal(toggleState.focusedInputId, 'input-TEAM');
    assert.equal(filledInput.focused, false);
    assert.equal(pendingInput.focused, true);
    assert.equal(
      pendingInput.classList.contains('is-input-guidance-pulsing'),
      true,
    );
  });
});

test('modal input guidance pulse clears once the user starts typing', () => {
  const mod = loadModule();
  const input = createInput('TOKEN', '');
  const firstAccordion = new FakeElement('accordion-1');
  firstAccordion.className = 'mcp-config-accordion collapsed';
  input.parentElement.parentElement = firstAccordion;
  input.parentNode = input.parentElement;

  const dom = createDocument({
    firstAccordion,
    inputs: [input],
  });

  withDocument(dom.document, () => {
    mod.initializeMcpConfigGuidance({ id: 'slack' }, {});

    mod.handleMcpConfigAccordionToggle(
      {
        accordionId: 'accordion-1',
        isCollapsed: false,
      },
      {},
    );

    assert.equal(input.classList.contains('is-input-guidance-pulsing'), true);

    const inputHandlers = dom.configContent.listeners.get('input') || [];
    input.value = 'secret';
    inputHandlers[0]({ target: input });

    assert.equal(input.classList.contains('is-input-guidance-pulsing'), false);
  });
});

test('collapsing a modal accordion clears any active input pulse', () => {
  const mod = loadModule();
  const input = createInput('TOKEN', '');
  const firstAccordion = new FakeElement('accordion-1');
  firstAccordion.className = 'mcp-config-accordion';
  input.parentElement.parentElement = firstAccordion;
  input.parentNode = input.parentElement;

  const dom = createDocument({
    firstAccordion,
    inputs: [input],
  });

  withDocument(dom.document, () => {
    mod.initializeMcpConfigGuidance({ id: 'slack' }, {});

    mod.handleMcpConfigAccordionToggle(
      {
        accordionId: 'accordion-1',
        isCollapsed: false,
      },
      {},
    );

    assert.equal(input.classList.contains('is-input-guidance-pulsing'), true);

    mod.handleMcpConfigAccordionToggle(
      {
        accordionId: 'accordion-1',
        isCollapsed: true,
      },
      {},
    );

    assert.equal(input.classList.contains('is-input-guidance-pulsing'), false);
  });
});
