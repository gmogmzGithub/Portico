const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeElement } = require("./test-helpers/fake-dom");

function loadModule() {
  const modulePath = require.resolve("../renderer/components/setup-server-nav");
  delete require.cache[modulePath];
  return require("../renderer/components/setup-server-nav");
}

function withNavDom(run) {
  const container = new FakeElement("server-nav-container");
  const previousDocument = global.document;
  global.document = {
    getElementById(id) {
      if (id === "server-nav-container") {
        return container;
      }
      return null;
    },
  };

  try {
    return run({ container });
  } finally {
    global.document = previousDocument;
  }
}

test("getCleanServerName strips the MCP suffix for navigation labels", () => {
  const mod = loadModule();
  assert.equal(mod.getCleanServerName("Slack MCP Server"), "Slack");
  assert.equal(mod.getCleanServerName("Glean"), "Glean");
});

test("createServerNavigation renders active, skipped, configured, and preconfigured cards", () => {
  withNavDom(({ container }) => {
    const mod = loadModule();
    mod.createServerNavigation(
      [
        { id: "gitlab", name: "GitLab MCP Server", display_name: "GitLab", icon: "gitlab.png" },
        { id: "slack", name: "Slack MCP Server", display_name: "Slack", icon: "slack.png" },
        { id: "sourcegraph", name: "Sourcegraph MCP Server", display_name: "Sourcegraph" },
      ],
      1,
      new Set(["gitlab"]),
      new Set(["sourcegraph"]),
      new Set(["slack"]),
    );

    assert.equal(container.style.display, "block");
    assert.match(container.innerHTML, /oauth-stage-preview-card done/);
    assert.match(container.innerHTML, /oauth-stage-preview-card current done preconfigured/);
    assert.match(container.innerHTML, /oauth-stage-preview-card skipped/);
    assert.match(container.innerHTML, /title="Configured"/);
    assert.match(container.innerHTML, /title="Already configured"/);
    assert.match(container.innerHTML, /title="Sourcegraph MCP Server \(Skipped\)"/);
    assert.match(container.innerHTML, /onclick="jumpToServer\(1\)"/);
    assert.match(container.innerHTML, />Slack</);
  });
});

test("updateServerNavigation skips hidden containers and rerenders visible ones", () => {
  withNavDom(({ container }) => {
    const mod = loadModule();
    container.style.display = "none";
    container.innerHTML = "unchanged";

    mod.updateServerNavigation(
      [{ id: "slack", name: "Slack MCP Server" }],
      0,
      new Set(),
      new Set(),
    );
    assert.equal(container.innerHTML, "unchanged");

    container.style.display = "block";
    mod.updateServerNavigation(
      [{ id: "slack", name: "Slack MCP Server" }],
      0,
      new Set(),
      new Set(),
    );
    assert.match(container.innerHTML, /Slack/);
  });
});

test("showServerNavContainer and hideServerNavContainer toggle visibility", () => {
  withNavDom(({ container }) => {
    const mod = loadModule();

    mod.showServerNavContainer();
    assert.equal(container.style.display, "block");

    mod.hideServerNavContainer();
    assert.equal(container.style.display, "none");
  });
});
