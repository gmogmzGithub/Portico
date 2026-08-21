const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeElement } = require("./test-helpers/fake-dom");

function loadModule() {
  const modulePath = require.resolve(
    "../renderer/components/setup-confirmation",
  );
  delete require.cache[modulePath];
  return require("../renderer/components/setup-confirmation");
}

function withDocument(elements, run) {
  const previousDocument = global.document;
  global.document = {
    getElementById(id) {
      return elements[id] || null;
    },
  };

  try {
    return run();
  } finally {
    global.document = previousDocument;
  }
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
    return [...this.classes].join(" ");
  }
}

class MiniElement {
  constructor(tagName, textContent = "") {
    this.nodeType = 1;
    this.tagName = String(tagName || "div").toUpperCase();
    this.textContent = textContent;
    this.innerHTML = textContent;
    this.children = [];
    this.parentNode = null;
    this.parentElement = null;
    this.onclick = null;
    this.style = {};
    this.classList = new MiniClassList();
    this._id = "";
  }

  get id() {
    return this._id;
  }

  set id(value) {
    this._id = String(value || "");
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    const names = String(value || "")
      .split(/\s+/)
      .filter(Boolean);
    this.classList = new MiniClassList(names);
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
    if (!String(selector || "").startsWith(".")) {
      return null;
    }

    const className = selector.slice(1);
    let current = this.parentNode;
    while (current) {
      if (current.classList.contains(className)) {
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
        if (selector === "h2" && child.tagName === "H2") {
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
  const registry = new Map();

  global.Node = { ELEMENT_NODE: 1 };
  global.document = {
    createElement(tagName) {
      const element = new MiniElement(tagName);
      Object.defineProperty(element, "id", {
        get() {
          return this._id || "";
        },
        set(value) {
          this._id = String(value || "");
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

  try {
    return run();
  } finally {
    global.document = previousDocument;
    global.Node = previousNode;
  }
}

test("handleConfirmationYes refreshes Configure guidance and auto-expands the next follow-on accordion", () => {
  const mod = loadModule();
  const confirmationCard = new FakeElement("confirmation-1");
  const afterContent = new FakeElement("after-confirmation-1");
  const logs = [];
  const accordionCalls = [];
  let refreshCalls = 0;
  const scrollContainer = { id: "configuration-scroll-area" };

  withDocument(
    {
      "confirmation-1": confirmationCard,
      "after-confirmation-1": afterContent,
    },
    () => {
      mod.handleConfirmationYes("confirmation-1", "server-config", {
        createAccordionsForVisibleContent(container, context, options) {
          accordionCalls.push({ container, context, options });
        },
        refreshConfigurationGuidance() {
          refreshCalls += 1;
        },
        handleConfigurationAccordionToggle() {},
        getConfigurationScrollContainer() {
          return scrollContainer;
        },
        addLog(message, level) {
          logs.push({ message, level });
        },
      });
    },
  );

  assert.equal(confirmationCard.style.display, "none");
  assert.equal(afterContent.classList.contains("visible"), true);
  assert.equal(accordionCalls.length, 1);
  assert.equal(accordionCalls[0].container, afterContent);
  assert.equal(
    accordionCalls[0].context,
    "server-config-after-confirmation-1",
  );
  assert.equal(accordionCalls[0].options.startCollapsed, true);
  assert.equal(accordionCalls[0].options.autoExpandFirst, true);
  assert.equal(accordionCalls[0].options.scrollContainer, scrollContainer);
  assert.equal(
    typeof accordionCalls[0].options.onToggle,
    "function",
  );
  assert.equal(refreshCalls, 1);
  assert.deepEqual(logs, [
    {
      message: "Continuing with configuration...",
      level: "info",
    },
  ]);
});

test("handleConfirmationYes watches for delayed Configure follow-on content and auto-expands it once rendered", () => {
  const mod = loadModule();
  const previousMutationObserver = global.MutationObserver;
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const confirmationCard = new FakeElement("confirmation-1");
  const afterContent = new FakeElement("after-confirmation-1");
  const scrollContainer = { id: "configuration-scroll-area" };
  const observers = [];
  const timers = [];
  const accordionCalls = [];
  let refreshCalls = 0;
  let createCalls = 0;

  global.MutationObserver = class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
    }

    disconnect() {
      this.disconnected = true;
    }

    trigger(records = []) {
      this.callback(records, this);
    }
  };
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) {
      timer.cleared = true;
    }
  };

  try {
    withDocument(
      {
        "confirmation-1": confirmationCard,
        "after-confirmation-1": afterContent,
      },
      () => {
        mod.handleConfirmationYes("confirmation-1", "server-config", {
          createAccordionsForVisibleContent(container, context, options) {
            accordionCalls.push({ container, context, options });
            createCalls += 1;
            if (createCalls === 1) {
              return [];
            }

            return [{ accordion: {}, header: {} }];
          },
          refreshConfigurationGuidance() {
            refreshCalls += 1;
          },
          handleConfigurationAccordionToggle() {},
          getConfigurationScrollContainer() {
            return scrollContainer;
          },
          confirmationFollowUpTimeoutMs: 500,
        });
      },
    );

    assert.equal(confirmationCard.style.display, "none");
    assert.equal(afterContent.classList.contains("visible"), true);
    assert.equal(accordionCalls.length, 1);
    assert.equal(observers.length, 1);
    assert.equal(observers[0].target, afterContent);
    assert.deepEqual(observers[0].options, { childList: true, subtree: true });
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 500);
    assert.equal(refreshCalls, 1);

    observers[0].trigger([{ type: "childList" }]);

    assert.equal(accordionCalls.length, 2);
    assert.equal(accordionCalls[1].container, afterContent);
    assert.equal(
      accordionCalls[1].context,
      "server-config-after-confirmation-1",
    );
    assert.equal(accordionCalls[1].options.autoExpandFirst, true);
    assert.equal(accordionCalls[1].options.scrollContainer, scrollContainer);
    assert.equal(refreshCalls, 2);
    assert.equal(observers[0].disconnected, true);
    assert.equal(timers[0].cleared, true);
  } finally {
    global.MutationObserver = previousMutationObserver;
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

test("handleConfirmationYes auto-expands the newly revealed Configure follow-up accordion in the real nested accordion flow", () => {
  const confirmationMod = loadModule();
  const accordionPath = require.resolve("../renderer/components/setup-accordion");
  delete require.cache[accordionPath];
  const accordionMod = require("../renderer/components/setup-accordion");

  withMiniDom(() => {
    const container = global.document.createElement("div");
    const step1Heading = global.document.createElement("h2");
    step1Heading.textContent = "Step 1";
    step1Heading.innerHTML = "Step 1";
    const step1Paragraph = global.document.createElement("p");
    step1Paragraph.textContent = "Create the app";
    step1Paragraph.innerHTML = "Create the app";
    const confirmationCard = global.document.createElement("div");
    confirmationCard.id = "confirmation-1";
    const afterContent = global.document.createElement("div");
    afterContent.id = "after-confirmation-1";
    afterContent.className = "content-after-confirmation";
    const step2Heading = global.document.createElement("h2");
    step2Heading.textContent = "Step 2";
    step2Heading.innerHTML = "Step 2";
    const step2Paragraph = global.document.createElement("p");
    step2Paragraph.textContent = "Add OAuth scopes";
    step2Paragraph.innerHTML = "Add OAuth scopes";

    afterContent.appendChild(step2Heading);
    afterContent.appendChild(step2Paragraph);
    container.appendChild(step1Heading);
    container.appendChild(step1Paragraph);
    container.appendChild(confirmationCard);
    container.appendChild(afterContent);

    accordionMod.createAccordionsForVisibleContent(container, "server-config", {
      startCollapsed: true,
    });

    const step1Accordion = container.children[0];
    assert.equal(step1Accordion.classList.contains("accordion-section"), true);
    assert.equal(afterContent.children[0], step2Heading);

    confirmationMod.handleConfirmationYes("confirmation-1", "server-config", {
      markAccordionsAsCompleted: accordionMod.markAccordionsAsCompleted,
      createAccordionsForVisibleContent: accordionMod.createAccordionsForVisibleContent,
      handleConfigurationAccordionToggle() {},
      getConfigurationScrollContainer() {
        return null;
      },
      refreshConfigurationGuidance() {},
    });

    assert.equal(confirmationCard.style.display, "none");
    assert.equal(step1Accordion.classList.contains("completed"), true);
    assert.equal(step1Accordion.classList.contains("collapsed"), true);
    assert.equal(afterContent.classList.contains("visible"), true);
    assert.equal(afterContent.children[0].classList.contains("accordion-section"), true);
    assert.equal(afterContent.children[0].classList.contains("collapsed"), false);
    assert.equal(afterContent.children[0].children[1].children[0], step2Paragraph);
  });
});

test("confirmation helpers render the expected copy and route No answers by context", () => {
  const mod = loadModule();
  const logs = [];
  const stages = [];
  let skipped = 0;

  assert.match(
    mod.generateConfirmationCard("Proceed?", "confirmation-1", "server-config"),
    /Proceed\?/,
  );

  mod.handleConfirmationNo("confirmation-1", "server-config", {
    addLog(message, level) {
      logs.push({ message, level });
    },
    handleSkipServer() {
      skipped += 1;
    },
  });
  mod.handleConfirmationNo("confirmation-2", "portico-api", {
    addLog(message, level) {
      logs.push({ message, level });
    },
    showStage(stage) {
      stages.push(stage);
    },
  });

  assert.equal(skipped, 1);
  assert.deepEqual(stages, ["welcome"]);
  assert.deepEqual(logs, [
    {
      message: "Skipping server configuration based on user choice...",
      level: "warning",
    },
    {
      message: "Configuration cancelled by user",
      level: "warning",
    },
  ]);
});

test("createWindowHandlers wires confirmation actions onto window", () => {
  const mod = loadModule();
  const previousWindow = global.window;
  global.window = {};
  const calls = [];

  try {
    mod.createWindowHandlers({
      addLog() {},
      showStage(stage) {
        calls.push({ kind: "stage", stage });
      },
      handleSkipServer() {
        calls.push({ kind: "skip" });
      },
    });

    global.window.handleConfirmationNo("confirmation-1", "server-config");
    global.window.handleConfirmationNo("confirmation-2", "portico-api");
  } finally {
    global.window = previousWindow;
  }

  assert.deepEqual(calls, [
    { kind: "skip" },
    { kind: "stage", stage: "welcome" },
  ]);
});
