const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeClassList } = require("./test-helpers/fake-dom");

function loadModule() {
  const modulePath = require.resolve("../renderer/components/setup-accordion");
  delete require.cache[modulePath];
  return require("../renderer/components/setup-accordion");
}

class MiniElement {
  constructor(tagName, textContent = "") {
    this.nodeType = 1;
    this.tagName = String(tagName || "div").toUpperCase();
    this.textContent = textContent;
    this.innerHTML = textContent;
    this.children = [];
    this.parentNode = null;
    this.onclick = null;
    this.id = "";
    this.classList = new FakeClassList();
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    const names = String(value || "")
      .split(/\s+/)
      .filter(Boolean);
    this.classList = new FakeClassList(names);
  }

  appendChild(child) {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
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
    this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentNode = null;
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

test("createAccordionsForVisibleContent honors startCollapsed and emits toggle callbacks", () => {
  const mod = loadModule();

  withMiniDom(() => {
    const container = new MiniElement("div");
    const heading = new MiniElement("h2", "Step 1");
    const paragraph = new MiniElement("p", "Do the thing");
    container.appendChild(heading);
    container.appendChild(paragraph);

    const toggles = [];
    mod.createAccordionsForVisibleContent(container, "server-config", {
      startCollapsed: true,
      onToggle(details) {
        toggles.push(details);
      },
    });

    const accordion = container.children[0];
    const header = accordion.children[0];

    assert.equal(accordion.classList.contains("collapsed"), true);
    assert.equal(accordion.children[1].children[0], paragraph);

    header.onclick();

    assert.equal(accordion.classList.contains("collapsed"), false);
    assert.deepEqual(toggles.map((entry) => entry.isCollapsed), [false]);
    assert.equal(toggles[0].context, "server-config");
  });
});

test("createAccordionsForVisibleContent leaves accordions expanded by default outside Configure", () => {
  const mod = loadModule();

  withMiniDom(() => {
    const container = new MiniElement("div");
    const heading = new MiniElement("h2", "Step 1");
    const paragraph = new MiniElement("p", "Do the thing");
    container.appendChild(heading);
    container.appendChild(paragraph);

    mod.createAccordionsForVisibleContent(container, "oauth");

    const accordion = container.children[0];
    assert.equal(accordion.classList.contains("collapsed"), false);
  });
});

test("createAccordionsForVisibleContent scrolls expanded Configure accordions into the provided scroll container", () => {
  const mod = loadModule();

  withMiniDom(() => {
    const container = new MiniElement("div");
    const heading = new MiniElement("h2", "Step 1");
    const paragraph = new MiniElement("p", "Do the thing");
    container.appendChild(heading);
    container.appendChild(paragraph);

    const scrollCalls = [];
    const scrollContainer = {
      scrollTop: 0,
      getBoundingClientRect() {
        return { top: 0, bottom: 200 };
      },
      scrollTo(args) {
        scrollCalls.push(args);
      },
    };

    mod.createAccordionsForVisibleContent(container, "server-config", {
      startCollapsed: true,
      scrollContainer,
      scrollSchedule(callback) {
        return callback();
      },
    });

    const accordion = container.children[0];
    const header = accordion.children[0];
    accordion.getBoundingClientRect = () => ({
      top: 120,
      bottom: 240,
      height: 120,
    });

    header.onclick();

    assert.deepEqual(scrollCalls, [{ top: 60, behavior: "smooth" }]);

    header.onclick();

    assert.deepEqual(scrollCalls, [{ top: 60, behavior: "smooth" }]);
  });
});

test("createAccordionsForVisibleContent can auto-expand the first newly revealed Configure accordion", () => {
  const mod = loadModule();

  withMiniDom(() => {
    const container = new MiniElement("div");
    const heading = new MiniElement("h2", "Step 2");
    const paragraph = new MiniElement("p", "Keep going");
    container.appendChild(heading);
    container.appendChild(paragraph);

    const toggles = [];
    let scheduleCalls = 0;
    const createdAccordions = mod.createAccordionsForVisibleContent(
      container,
      "server-config-after-confirmation-1",
      {
        startCollapsed: true,
        autoExpandFirst: true,
        onToggle(details) {
          toggles.push(details);
        },
        scrollContainer: {
          scrollTop: 0,
          getBoundingClientRect() {
            return { top: 0, bottom: 200 };
          },
        },
        scrollSchedule(callback) {
          scheduleCalls += 1;
          return callback();
        },
      },
    );

    const accordion = container.children[0];

    assert.equal(accordion.classList.contains("collapsed"), false);
    assert.equal(createdAccordions.length, 1);
    assert.deepEqual(toggles.map((entry) => entry.isCollapsed), [false]);
    assert.equal(scheduleCalls, 1);
  });
});

test("createAccordionsForVisibleContent defers hidden follow-up headings until their confirmation branch is revealed", () => {
  const mod = loadModule();

  withMiniDom(() => {
    const container = new MiniElement("div");
    const step1Heading = new MiniElement("h2", "Step 1");
    const step1Paragraph = new MiniElement("p", "Create the app");
    const afterStep1 = new MiniElement("div");
    afterStep1.className = "content-after-confirmation";
    afterStep1.id = "after-confirmation-1";
    const step2Heading = new MiniElement("h2", "Step 2");
    const step2Paragraph = new MiniElement("p", "Add OAuth scopes");
    const afterStep2 = new MiniElement("div");
    afterStep2.className = "content-after-confirmation";
    afterStep2.id = "after-confirmation-2";
    const step3Heading = new MiniElement("h2", "Step 3");
    const step3Paragraph = new MiniElement("p", "Install the app");

    afterStep2.appendChild(step3Heading);
    afterStep2.appendChild(step3Paragraph);
    afterStep1.appendChild(step2Heading);
    afterStep1.appendChild(step2Paragraph);
    afterStep1.appendChild(afterStep2);
    container.appendChild(step1Heading);
    container.appendChild(step1Paragraph);
    container.appendChild(afterStep1);

    mod.createAccordionsForVisibleContent(container, "server-config", {
      startCollapsed: true,
    });

    assert.equal(container.children[0].classList.contains("accordion-section"), true);
    assert.equal(afterStep1.children[0], step2Heading);
    assert.equal(afterStep2.children[0], step3Heading);

    const createdAccordions = mod.createAccordionsForVisibleContent(
      afterStep1,
      "server-config-after-confirmation-1",
      {
        startCollapsed: true,
        autoExpandFirst: true,
      },
    );

    assert.equal(createdAccordions.length, 1);
    assert.equal(afterStep1.children[0].classList.contains("accordion-section"), true);
    assert.equal(afterStep1.children[0].classList.contains("collapsed"), false);
    assert.equal(afterStep2.children[0], step3Heading);
  });
});

test("createInitialAccordions wraps visible h2 sections and leaves hidden confirmation follow-on content untouched", () => {
  const mod = loadModule();
  const html = [
    "<h1>Slack MCP Server Configuration</h1>",
    "<h2>Step 1</h2>",
    "<p>Create the app.</p>",
    '<div class="content-after-confirmation" id="after-confirmation-1">',
    "  <h2>Step 2</h2>",
    "  <p>Hidden follow-on content.</p>",
    "</div>",
    "<h2>Step 3</h2>",
    "<p>Final visible step.</p>",
  ].join("\n");

  const processed = mod.createInitialAccordions(html, "server-config");

  assert.match(processed, /accordion-initial-server-config-0/);
  assert.match(processed, /accordion-initial-server-config-1/);
  assert.match(processed, /<h1>Slack MCP Server Configuration<\/h1>/);
  assert.match(processed, /content-after-confirmation/);
  assert.match(processed, /<h2>Step 2<\/h2>/);
  assert.doesNotMatch(processed, /accordion-initial-server-config-2/);
});

test("markAccordionsAsCompleted marks the containing accordion and toggleAccordion handles missing ids", () => {
  const mod = loadModule();
  const previousDocument = global.document;
  const accordion = new MiniElement("div");
  accordion.id = "accordion-1";
  accordion.className = "accordion-section";
  const confirmationCard = new MiniElement("div");
  confirmationCard.id = "confirmation-1";
  confirmationCard.closest = (selector) => {
    if (selector === ".accordion-section") {
      return accordion;
    }
    return null;
  };

  global.document = {
    getElementById(id) {
      if (id === "confirmation-1") {
        return confirmationCard;
      }
      if (id === "accordion-1") {
        return accordion;
      }
      return null;
    },
  };

  try {
    mod.markAccordionsAsCompleted("confirmation-1");
    assert.equal(accordion.classList.contains("completed"), true);
    assert.equal(accordion.classList.contains("collapsed"), true);

    assert.equal(mod.toggleAccordion("missing"), null);
    assert.equal(mod.toggleAccordion("accordion-1"), false);
    assert.equal(accordion.classList.contains("collapsed"), false);
  } finally {
    global.document = previousDocument;
  }
});

test("createAccordionSection returns the shared collapsed accordion markup shell", () => {
  const mod = loadModule();
  const html = mod.createAccordionSection("Step 1", [], "accordion-1");

  assert.match(html, /accordion-section collapsed/);
  assert.match(html, /toggleAccordion\('accordion-1'\)/);
  assert.match(html, /<div class="accordion-title">Step 1<\/div>/);
});
