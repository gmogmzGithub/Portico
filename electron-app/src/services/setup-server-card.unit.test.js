const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeElement } = require("./test-helpers/fake-dom");

function loadModule() {
  const modulePath = require.resolve("../renderer/components/setup-server-card");
  delete require.cache[modulePath];
  return require("../renderer/components/setup-server-card");
}

function withCardDom(run) {
  const created = [];
  const previousDocument = global.document;
  global.document = {
    createElement(tagName) {
      const element = new FakeElement();
      element.tagName = tagName;
      created.push(element);
      return element;
    },
  };

  try {
    return run({ created });
  } finally {
    global.document = previousDocument;
  }
}

test("server card helpers identify OAuth, config, and core servers", () => {
  const mod = loadModule();

  assert.equal(
    mod.serverRequiresOAuth({ oauth: { requires_user_authorization: true } }),
    true,
  );
  assert.equal(mod.serverRequiresOAuth({ oauth: {} }), false);
  assert.equal(
    mod.serverRequiresConfig({ required_env_vars: [{ name: "TOKEN" }] }),
    true,
  );
  assert.equal(mod.serverRequiresConfig({ required_env_vars: [] }), false);
  assert.equal(mod.serverIsCore({ isCore: true }), true);
  assert.equal(mod.serverIsCore({ isCore: false }), false);
});

test("createServerCard applies host/core state, badges, descriptions, and icon cleanup", () => {
  withCardDom(() => {
    const mod = loadModule();
    const card = mod.createServerCard(
      {
        id: "chrome-devtools",
        name: "🦊 Chrome DevTools MCP Server",
        display_name: "🦊 Chrome DevTools MCP Server",
        icon: "chrome.png",
        guidedSetupDescription: "Automate your browser.",
        oauth: { requires_user_authorization: true },
        required_env_vars: [{ name: "TOKEN" }],
        isCore: true,
        deploymentType: "host",
      },
      4,
      false,
      false,
    );

    assert.equal(card.dataset.serverId, "chrome-devtools");
    assert.equal(card.dataset.index, 4);
    assert.equal(card.classList.contains("host-disabled"), true);
    assert.equal(card.classList.contains("core-server"), true);
    assert.match(card.innerHTML, /Chrome DevTools/);
    assert.doesNotMatch(card.innerHTML, /🦊/);
    assert.match(card.innerHTML, /badge-core/);
    assert.match(card.innerHTML, /badge-oauth/);
    assert.match(card.innerHTML, /badge-config/);
    assert.match(card.innerHTML, /Automate your browser\./);
    assert.match(card.innerHTML, /mcp-card-icon-img/);
  });
});

test("createServerCard uses a placeholder icon when no server icon is available", () => {
  withCardDom(() => {
    const mod = loadModule();
    const card = mod.createServerCard(
      {
        id: "sourcegraph",
        name: "Sourcegraph MCP Server",
      },
      1,
      false,
      true,
    );

    assert.equal(card.classList.contains("host-disabled"), false);
    assert.match(card.innerHTML, /mcp-card-icon-placeholder/);
    assert.match(card.innerHTML, /Sourcegraph/);
  });
});

test("createServerCard falls back to the general description and keeps badges independent", () => {
  withCardDom(() => {
    const mod = loadModule();
    const card = mod.createServerCard(
      {
        id: "oauth-only",
        name: "OAuth Only MCP Server",
        description: "General integration description.",
        oauth: { requires_user_authorization: true },
      },
      2,
      false,
      true,
    );

    assert.match(card.innerHTML, /General integration description\./);
    assert.match(card.innerHTML, /badge-oauth/);
    assert.doesNotMatch(card.innerHTML, /badge-config/);
  });
});

test("createServerCard shows the DEPRECATED badge alongside auth/config badges", () => {
  withCardDom(() => {
    const mod = loadModule();
    const card = mod.createServerCard(
      {
        id: "n8n-community-mcp",
        name: "n8n MCP Server",
        display_name: "n8n (Community Fork)",
        guidedSetupDescription: "Build and run n8n automation workflows",
        required_env_vars: [{ name: "N8N_API_KEY" }],
        deprecated: true,
      },
      3,
      false,
      true,
    );

    assert.match(card.innerHTML, /badge-deprecated">DEPRECATED</);
    assert.match(card.innerHTML, /badge-config/);
  });
});

test("createServerCard omits the DEPRECATED badge for non-deprecated servers", () => {
  withCardDom(() => {
    const mod = loadModule();
    const card = mod.createServerCard(
      {
        id: "sourcegraph",
        name: "Sourcegraph MCP Server",
      },
      1,
      false,
      true,
    );

    assert.doesNotMatch(card.innerHTML, /badge-deprecated/);
  });
});

test("createServerCard applies guided-setup-disabled tooltip metadata without adding extra badges", () => {
  withCardDom(() => {
    const mod = loadModule();
    const card = mod.createServerCard(
      {
        id: "data-plat-mcp",
        name: "Data Platform MCP Server",
        display_name: "Data Platform",
      },
      2,
      false,
      true,
      {
        guidedSetupDisabled: true,
        guidedSetupDisabledTooltip: "Disabled in guided setup",
      },
    );

    assert.equal(card.classList.contains("guided-setup-disabled"), true);
    assert.equal(card.getAttribute("aria-disabled"), "true");
    assert.equal(card.dataset.tooltip, "Disabled in guided setup");
    assert.equal(card.getAttribute("tabindex"), "0");
    assert.doesNotMatch(card.innerHTML, /badge-disabled/);
  });
});

test("selectServerCard, deselectServerCard, and addConfiguredCheckmark keep indicator state in sync", () => {
  const mod = loadModule();
  const indicator = new FakeElement("indicator");
  const removableCheckmark = {
    removed: false,
    remove() {
      this.removed = true;
    },
  };
  const card = new FakeElement("card");
  card.querySelector = (selector) => {
    if (selector === ".mcp-card-selection-indicator") {
      return indicator;
    }
    if (selector === ".configured-checkmark") {
      return removableCheckmark;
    }
    return null;
  };

  mod.selectServerCard(card);
  assert.equal(card.classList.contains("selected"), true);
  assert.match(indicator.innerHTML, /polyline/);

  mod.addConfiguredCheckmark(card);
  assert.equal(card.classList.contains("configured"), true);
  assert.match(indicator.innerHTML, /polyline/);

  mod.deselectServerCard(card);
  assert.equal(card.classList.contains("selected"), false);
  assert.equal(card.classList.contains("configured"), false);
  assert.equal(indicator.innerHTML, "");
  assert.equal(removableCheckmark.removed, true);
});

test("createHostWarning renders the shared host-mode warning copy", () => {
  withCardDom(() => {
    const mod = loadModule();
    const warning = mod.createHostWarning();

    assert.equal(warning.id, "host-warning-message");
    assert.equal(warning.className, "host-warning");
    assert.match(warning.innerHTML, /dependencies needed to run Host-mode integrations/);
    assert.match(warning.innerHTML, /#help-portico/);
  });
});
