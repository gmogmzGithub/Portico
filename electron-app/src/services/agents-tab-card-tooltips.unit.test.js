// Agent-card density behavior: the compact "N skills" link, its hover tooltip
// (delegated on the list node, hidden on scroll/re-render), and the clamped
// description. All assertions run against real rendered output / real handler
// effects via the vm harness (mirrors agents-tab-clickability.unit.test.js).
// Visual styling for these surfaces (.agent-card-desc clamp, link colors,
// .agent-card-tooltip fixed positioning) is covered by live visual QA, not
// source pins.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const AGENTS_PATH = path.join(__dirname, "..", "renderer", "components", "agents.js");

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
    const shouldAdd = force === undefined ? !this.classes.has(name) : Boolean(force);
    if (shouldAdd) this.classes.add(name);
    else this.classes.delete(name);
    return shouldAdd;
  }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.className = "";
    this.style = { display: "none" };
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.innerHTML = "";
    this.textContent = "";
    this.dataset = {};
    this.attributes = {};
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    this.children = [];
    this.parentElement = null;
    this.offsetWidth = 120;
    this.offsetHeight = 40;
    this.rect = { left: 20, right: 60, top: 20, bottom: 40, width: 40, height: 20 };
    this.selectorMap = new Map();
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type);
    if (!handlers) return;
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  }

  // Accepts both dispatchEvent("click", {...}) from tests and
  // dispatchEvent(new CustomEvent("...")) from production code.
  dispatchEvent(typeOrEvent, event = {}) {
    const type = typeof typeOrEvent === "string" ? typeOrEvent : typeOrEvent?.type;
    const props = typeof typeOrEvent === "string" ? event : typeOrEvent;
    for (const handler of this.listeners.get(type) || []) {
      handler({
        preventDefault() {},
        stopPropagation() {},
        target: this,
        currentTarget: this,
        ...props,
      });
    }
    return true;
  }

  click() {
    this.dispatchEvent("click");
  }

  focus() {}

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  getBoundingClientRect() {
    return { ...this.rect };
  }

  contains(other) {
    return other === this || this.children.includes(other);
  }

  closest() {
    return null;
  }

  querySelector(selector) {
    return this.selectorMap.get(selector) || null;
  }

  querySelectorAll(selector) {
    const staged = this.selectorMap.get(`all:${selector}`);
    return Array.isArray(staged) ? staged : [];
  }

  appendChild(child) {
    if (child && typeof child === "object") {
      child.parentElement = this;
      this.children.push(child);
    }
    return child;
  }

  remove() {
    if (this.parentElement) {
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.parentElement = null;
    }
  }
}

function loadAgentsModuleHarness({ agents = [], skills = [] } = {}) {
  const source = fs.readFileSync(AGENTS_PATH, "utf8");
  const componentsDir = path.join(__dirname, "..", "renderer", "components");
  const extraSources = [
    "agent-reasoning-options.js",
    "agent-model-picker.js",
    "agent-reasoning-slider.js",
  ].map((name) => ({
    path: path.join(componentsDir, name),
    source: fs.readFileSync(path.join(componentsDir, name), "utf8"),
  }));

  const elements = new Map();
  const addElement = (id, { display = "none" } = {}) => {
    const element = new FakeElement(id);
    element.style.display = display;
    elements.set(id, element);
    return element;
  };

  addElement("view-mcp-servers-btn", { display: "" });
  addElement("view-agent-skills-btn", { display: "" });
  addElement("view-cost-dashboard-btn", { display: "" });
  addElement("view-agents-tab-btn", { display: "" });
  addElement("mcp-servers-view", { display: "" });
  addElement("agent-skills-view", { display: "none" });
  addElement("cost-dashboard-view", { display: "none" });
  addElement("agents-tab-view", { display: "none" });
  addElement("mcp-header-actions", { display: "" });
  addElement("skills-header-actions", { display: "none" });
  addElement("cost-dashboard-header-actions", { display: "none" });
  addElement("agents-tab-header-actions", { display: "none" });
  addElement("agents-tab-list", { display: "" });
  addElement("agents-tab-new-agent-btn", { display: "" });
  addElement("agents-tab-settings-btn", { display: "" });
  addElement("agents-tab-search-input", { display: "" });
  addElement("agents-tab-mode-tabs", { display: "" });

  const body = new FakeElement("body");
  // Document-level listeners are recorded so tests can drive the delegated
  // info-tooltip handlers (they attach to document, not to a list node).
  const documentListeners = new Map();
  const document = {
    readyState: "complete",
    body,
    createElement(tag) {
      const element = new FakeElement("");
      element.tagName = String(tag || "").toUpperCase();
      return element;
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    },
    removeEventListener() {},
  };

  const calls = [];
  const windowObject = {
    appState: {
      controlPlaneView: "mcp-servers",
    },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    electronAPI: {
      invokeMcpTool: async (_serverId, toolName, input = {}) => {
        calls.push([toolName, input]);
        if (toolName === "subagents_list_agents") {
          if (input.filter_type === "base") {
            return { success: true, data: { agents: [] } };
          }
          return { success: true, data: { agents } };
        }
        return { success: true, data: {} };
      },
      getSkills: async () => ({ success: true, skills }),
      loadMcpServers: async () => ({ success: true, data: [] }),
      getUsername: async () => ({ username: "dsantiago" }),
      aiMarketplace: {
        listLinks: async () => ({ success: true, links: {} }),
      },
    },
    showNotification() {},
  };

  const context = {
    window: windowObject,
    document,
    console,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    Promise,
    JSON,
    HTMLElement: FakeElement,
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    },
  };
  context.globalThis = context;

  for (const extra of extraSources) {
    vm.runInNewContext(extra.source, context, { filename: extra.path });
  }
  vm.runInNewContext(source, context, { filename: AGENTS_PATH });

  return {
    window: windowObject,
    elements,
    body,
    calls,
    documentListeners,
  };
}

const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test("agent card presentation helpers build the skills link and tooltip content", () => {
  const { window } = loadAgentsModuleHarness();
  const helpers = window.AgentCardTooltips;
  assert.ok(helpers, "window.AgentCardTooltips is exposed");

  // Skills link summary: empty, singular, plural, escaping.
  assert.equal(helpers.buildAgentSkillsLinkHtml("a1", [], { skills: [] }), "");
  const one = helpers.buildAgentSkillsLinkHtml("a1", ["code-execution"], { skills: [] });
  assert.match(one, />1 skill</);
  assert.match(one, /class="agent-card-skills-link"/);
  assert.match(one, /data-agent-id="a1"/);
  const three = helpers.buildAgentSkillsLinkHtml('a"<x>', ["a", "b", "c"], { skills: [] });
  assert.match(three, />3 skills</);
  assert.match(three, /data-agent-id="a&quot;&lt;x&gt;"/);

  // marketplace/slug and bare-slug forms of the same skill count once.
  const deduped = helpers.buildAgentSkillsLinkHtml(
    "a1",
    ["anthropic-agent-skills/algorithmic-art", "algorithmic-art"],
    { skills: [] },
  );
  assert.match(deduped, />1 skill</);

  // Tooltip content: catalog display names win; empty catalog falls back to
  // title-cased ids.
  const items = helpers.getAgentSkillDetails(
    ["anthropic-agent-skills/algorithmic-art", "using-deepsearch"],
    { skills: [{ id: "algorithmic-art", display_name: "Algorithmic Art" }] },
  );
  const tooltip = helpers.buildAgentSkillsTooltipHtml(items);
  assert.match(tooltip, /class="tooltip-header">Skills</);
  assert.match(tooltip, /Algorithmic Art/);
  assert.match(tooltip, /Using Deepsearch/);
  assert.equal(helpers.buildAgentSkillsTooltipHtml([]), "");
  assert.match(
    helpers.buildAgentSkillsTooltipHtml([{ id: "x", label: "<script>alert(1)</script>" }]),
    /&lt;script&gt;/,
  );
});

// Round 9 extracted the card into buildAgentCardHtml; round 5 removed the
// description tooltip. The rendered card is the contract: a compact "N skills"
// link row (no per-skill chip list), a 70-char clamped description with no
// native title attribute, and a presentation-only variant that swaps the link
// for a static count row.
test("rendered agent cards carry the compact skills link and clamped description", async () => {
  const longDescription = `${"d".repeat(80)} tail that must be cut`;
  const agent = {
    id: "agent-1",
    name: "Card Agent",
    description: longDescription,
    base_model_id: "gpt-5",
    skill_ids: ["anthropic-agent-skills/algorithmic-art", "algorithmic-art", "using-deepsearch"],
    tool_server_ids: [],
    created_by_email: "dsantiago@example.invalid",
    creation_source: "local",
  };
  const { window, elements } = loadAgentsModuleHarness({
    agents: [agent],
    skills: [{ id: "algorithmic-art", display_name: "Algorithmic Art" }],
  });

  await window.AgentsTabModule.loadMyAgents();
  await settle();
  const listHtml = elements.get("agents-tab-list").innerHTML;

  // Skills render as one deduped count link, not a chip per skill.
  assert.match(listHtml, /class="agent-card-skills-link" data-agent-id="agent-1">2 skills</);
  assert.ok(!listHtml.includes("Algorithmic Art"), "per-skill labels live in the tooltip only");

  // Description is clamped to 70 chars with an ellipsis and carries no native
  // title attribute (the custom tooltip machinery owns hover content).
  const descMatch = listHtml.match(/<p class="agent-card-desc"[^>]*>([^<]*)<\/p>/);
  assert.ok(descMatch, "card description renders");
  assert.match(descMatch[0], /^<p class="agent-card-desc">/);
  assert.equal(descMatch[1], `${"d".repeat(70)}…`);

  // Presentation-only variant (publish preview): static skills count, no link,
  // no menu, no Chat action.
  const staticCard = window.AgentCardRenderer.buildAgentCardHtml(agent, {
    interactive: false,
    viewerIdentity: "dsantiago",
  });
  assert.doesNotMatch(staticCard, /agent-card-skills-link/);
  assert.match(staticCard, /<strong>Skills:<\/strong> <span>2 skills<\/span>/);
  assert.doesNotMatch(staticCard, /mcp-card-menu-trigger/);
  assert.doesNotMatch(staticCard, /agent-use-btn/);
  const clampedStatic = staticCard.match(/<p class="agent-card-desc">([^<]*)<\/p>/);
  assert.equal(clampedStatic[1], `${"d".repeat(70)}…`);
});

test("skills-link hover shows the shared tooltip; scroll and re-render hide it", async () => {
  const agent = {
    id: "agent-1",
    name: "Hover Agent",
    description: "Hover fixture",
    base_model_id: "gpt-5",
    skill_ids: ["anthropic-agent-skills/algorithmic-art", "using-deepsearch"],
    tool_server_ids: [],
    created_by_email: "dsantiago@example.invalid",
    creation_source: "local",
  };
  const { window, elements, body } = loadAgentsModuleHarness({
    agents: [agent],
    skills: [{ id: "algorithmic-art", display_name: "Algorithmic Art", source: "user" }],
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();

  const list = elements.get("agents-tab-list");
  // The delegated tooltip listeners live on the stable list node.
  for (const type of ["mouseover", "focusin", "mouseout", "focusout", "scroll"]) {
    assert.ok((list.listeners.get(type) || []).length > 0, `list wires ${type}`);
  }

  // A hover target inside a card: closest() resolves the skills-link anchor
  // exactly when production asks for the skills-link selector.
  const anchor = new FakeElement("");
  anchor.classList.add("agent-card-skills-link");
  anchor.dataset.agentId = "agent-1";
  anchor.rect = { left: 40, right: 90, top: 760, bottom: 780, width: 50, height: 20 };
  anchor.closest = (selector) =>
    selector === ".agent-card-skills-link" ? anchor : null;

  list.dispatchEvent("mouseover", { target: anchor, relatedTarget: null });

  const tooltip = body.children.find(
    (child) => child.className === "agent-card-tooltip",
  );
  assert.ok(tooltip, "tooltip node is created once and body-mounted");
  assert.equal(tooltip.hidden, false, "tooltip is shown on hover");
  assert.match(tooltip.innerHTML, /class="tooltip-header">Skills</);
  assert.match(tooltip.innerHTML, /Algorithmic Art/);
  assert.match(tooltip.innerHTML, /Using Deepsearch/);
  // Round 15: my-agents rows carry the provenance table's Skill|Source shape
  // — source chips for resolvable skills, the missing note otherwise.
  assert.match(tooltip.innerHTML, /agent-card-tooltip-skill-grid/);
  assert.match(
    tooltip.innerHTML,
    /Algorithmic Art[\s\S]*?agents-publish-skill-chips[\s\S]*?badge-user/,
  );
  assert.match(tooltip.innerHTML, /Not on this computer/);
  // Anchored to the link: flipped above the anchor because the viewport
  // (800px) has no room below rect.bottom=780 for a 40px tooltip.
  assert.equal(tooltip.style.top, `${760 - 40 - 6}px`);
  assert.equal(tooltip.style.left, "40px");

  // Scrolling the list hides the tooltip (delegated { passive } listener).
  list.dispatchEvent("scroll");
  assert.equal(tooltip.hidden, true, "scroll hides the tooltip");

  // Hover again, then re-render the grid: closeAllAgentDropdowns runs first
  // and must hide the tooltip with the dropdowns.
  list.dispatchEvent("mouseover", { target: anchor, relatedTarget: null });
  assert.equal(tooltip.hidden, false);
  await window.AgentsTabModule.loadMyAgents();
  await settle();
  assert.equal(tooltip.hidden, true, "re-render hides the tooltip");

  // Hovering a non-anchor (e.g. the description) never shows a tooltip: the
  // description tooltip was removed in round 5 and only the skills link is an
  // anchor.
  const descTarget = new FakeElement("");
  descTarget.closest = () => null;
  list.dispatchEvent("mouseover", { target: descTarget, relatedTarget: null });
  assert.equal(tooltip.hidden, true, "non-anchor hover targets show nothing");
});

test("InfoTooltips: trigger builder shape and document-delegated show/hide/toggle", () => {
  const { window, body, documentListeners } = loadAgentsModuleHarness();
  assert.ok(window.InfoTooltips, "window.InfoTooltips is exposed");

  const html = window.InfoTooltips.triggerHtml('Needs "quotes" & <escaping>');
  assert.match(html, /class="info-tooltip-trigger"/);
  assert.match(html, /role="button"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /aria-label="More information"/);
  assert.match(html, /data-info-tooltip="Needs &quot;quotes&quot; &amp; &lt;escaping&gt;"/);
  assert.match(html, /<svg /, "carries the help-circle glyph");
  assert.match(html, /width="18" height="18"/, "the trigger glyph renders at 18px");
  assert.match(html, /M9\.09 9a3 3/, "the glyph shows a question mark, not a bare dash");

  // Delegated document listeners drive the shared floating tooltip.
  const COPY = "Without pinned skills, this agent picks its own tools per session.";
  const trigger = new FakeElement("info-trigger");
  trigger.dataset.infoTooltip = COPY;
  trigger.closest = (selector) =>
    selector.startsWith(".info-tooltip-trigger") ? trigger : null;
  const eventFor = (target, extra = {}) => ({
    target,
    relatedTarget: null,
    preventDefault() {},
    stopPropagation() {},
    ...extra,
  });
  const fire = (type, event) => {
    for (const handler of documentListeners.get(type) || []) handler(event);
  };

  fire("mouseover", eventFor(trigger));
  const tooltip = body.children.at(-1);
  assert.ok(tooltip, "the floating tooltip mounted on body");
  assert.equal(tooltip.hidden, false, "hover shows the tooltip");
  assert.match(tooltip.innerHTML, /tooltip-content/);
  assert.ok(tooltip.innerHTML.includes("Without pinned skills"), "carries the copy");

  fire("mouseout", eventFor(trigger));
  assert.equal(tooltip.hidden, true, "mouseout hides it");

  // Click toggles (keyboard/touch affordance) and never bubbles an action.
  let stopped = 0;
  fire("click", eventFor(trigger, { stopPropagation: () => (stopped += 1) }));
  assert.equal(tooltip.hidden, false, "click shows");
  assert.equal(stopped, 1, "the click never activates the surroundings");
  fire("click", eventFor(trigger, { stopPropagation() {} }));
  assert.equal(tooltip.hidden, true, "second click hides");

  // Non-trigger targets are ignored.
  const other = new FakeElement("");
  other.closest = () => null;
  fire("mouseover", eventFor(other));
  assert.equal(tooltip.hidden, true);
});

test("InfoTooltips: rich list tooltips render a titled row-per-item panel, capped with +N more", () => {
  const { window, body, documentListeners } = loadAgentsModuleHarness();
  assert.equal(typeof window.InfoTooltips.listTriggerHtml, "function");

  const spec = {
    title: "Used by 3 agents",
    items: [
      "dsantiago-Agent-AI4I-Skills",
      "dsantiago Awesome Agent",
      "Dionny's General Assistant",
    ],
    icon: "agent",
  };
  const html = window.InfoTooltips.listTriggerHtml(spec);
  assert.match(html, /class="info-tooltip-trigger"/);
  assert.match(html, /aria-label="Used by 3 agents"/);
  assert.match(html, /data-info-tooltip-list=/);
  assert.match(html, /<svg /, "carries the info-circle glyph");

  // Wrapped variant: caller markup (a badge chip) rides INSIDE the trigger,
  // making badge + icon one hover surface.
  const wrapped = window.InfoTooltips.listTriggerHtml(
    spec,
    '<span class="mcp-card-badge badge-agents">3 AGENTS</span>',
  );
  assert.match(wrapped, /class="info-tooltip-trigger info-tooltip-trigger-inline"/);
  assert.match(
    wrapped,
    /><span class="mcp-card-badge badge-agents">3 AGENTS<\/span><svg /,
    "badge renders inside the trigger, before the icon",
  );

  const eventFor = (target, extra = {}) => ({
    target,
    relatedTarget: null,
    preventDefault() {},
    stopPropagation() {},
    ...extra,
  });
  const fire = (type, event) => {
    for (const handler of documentListeners.get(type) || []) handler(event);
  };
  const triggerFor = (dataset) => {
    const trigger = new FakeElement("list-trigger");
    Object.assign(trigger.dataset, dataset);
    trigger.closest = (selector) =>
      selector.startsWith(".info-tooltip-trigger") ? trigger : null;
    return trigger;
  };

  // Structured panel: title header + one glyph-led row per agent — never the
  // old comma-joined sentence.
  const trigger = triggerFor({ infoTooltipList: JSON.stringify(spec) });
  fire("mouseover", eventFor(trigger));
  const tooltip = body.children.at(-1);
  assert.equal(tooltip.hidden, false, "hover shows the tooltip");
  assert.match(tooltip.innerHTML, /info-tooltip-rich-title">Used by 3 agents</);
  assert.equal((tooltip.innerHTML.match(/<li>/g) || []).length, 3, "one row per agent");
  assert.ok(tooltip.innerHTML.includes("Dionny&#39;s General Assistant"), "names escaped per-row");
  assert.doesNotMatch(tooltip.innerHTML, /Used by:/);
  assert.doesNotMatch(tooltip.innerHTML, /info-tooltip-rich-more/, "no overflow row at 3 items");
  fire("mouseout", eventFor(trigger));

  // Long lists cap at 10 rows and summarize the remainder.
  const many = triggerFor({
    infoTooltipList: JSON.stringify({
      title: "14 skills in this plugin",
      items: Array.from({ length: 14 }, (_, i) => `Skill ${i + 1}`),
      icon: "skill",
    }),
  });
  fire("mouseover", eventFor(many));
  assert.equal((tooltip.innerHTML.match(/<li>/g) || []).length, 10, "rows capped");
  assert.match(tooltip.innerHTML, /info-tooltip-rich-more">\+4 more</);
  fire("mouseout", eventFor(many));

  // Moving the pointer between the badge and the icon — both children of
  // ONE trigger unit — never hides the tooltip; leaving the unit does.
  const innerBadge = new FakeElement("badge-child");
  const unit = triggerFor({ infoTooltipList: JSON.stringify(spec) });
  unit.contains = (node) => node === innerBadge;
  fire("mouseover", eventFor(unit));
  assert.equal(tooltip.hidden, false, "hovering the unit shows");
  fire("mouseout", eventFor(unit, { relatedTarget: innerBadge }));
  assert.equal(tooltip.hidden, false, "badge→icon move never flickers");
  fire("mouseover", eventFor(unit, { relatedTarget: innerBadge }));
  assert.equal(tooltip.hidden, false, "re-entry from a child is a no-op");
  fire("mouseout", eventFor(unit, { relatedTarget: null }));
  assert.equal(tooltip.hidden, true, "leaving the unit hides");

  // A malformed list payload falls back to the plain-text attribute.
  const broken = triggerFor({
    infoTooltipList: "{not json",
    infoTooltip: "fallback copy",
  });
  fire("mouseover", eventFor(broken));
  assert.match(tooltip.innerHTML, /tooltip-content/);
  assert.ok(tooltip.innerHTML.includes("fallback copy"));
});

test("InfoTooltips: an optional note line renders under the rows", () => {
  const { body, documentListeners } = loadAgentsModuleHarness();
  const eventFor = (target) => ({
    target,
    relatedTarget: null,
    preventDefault() {},
    stopPropagation() {},
  });
  const fire = (type, event) => {
    for (const handler of documentListeners.get(type) || []) handler(event);
  };
  const triggerFor = (spec) => {
    const trigger = new FakeElement("note-trigger");
    trigger.dataset.infoTooltipList = JSON.stringify(spec);
    trigger.closest = (selector) =>
      selector.startsWith(".info-tooltip-trigger") ? trigger : null;
    return trigger;
  };

  const withNote = triggerFor({
    title: "Used by 2 agents",
    items: ["Research Buddy", "Planner Bot"],
    icon: "agent",
    note: "Remove it from these agents first.",
  });
  fire("mouseover", eventFor(withNote));
  const tooltip = body.children.at(-1);
  assert.equal(tooltip.hidden, false);
  assert.match(
    tooltip.innerHTML,
    /info-tooltip-rich-note">Remove it from these agents first\.</,
  );
  const lastRow = tooltip.innerHTML.lastIndexOf("</li>");
  const noteAt = tooltip.innerHTML.indexOf("info-tooltip-rich-note");
  assert.ok(noteAt > lastRow, "the note renders below the agent rows");
  fire("mouseout", eventFor(withNote));

  const withoutNote = triggerFor({
    title: "Used by 1 agent",
    items: ["Research Buddy"],
    icon: "agent",
  });
  fire("mouseover", eventFor(withoutNote));
  assert.doesNotMatch(tooltip.innerHTML, /info-tooltip-rich-note/);
});

test("InfoTooltips: placement=right anchors at the trigger's right edge with clamped fallback", () => {
  const { body, documentListeners } = loadAgentsModuleHarness();
  const eventFor = (target) => ({
    target,
    relatedTarget: null,
    preventDefault() {},
    stopPropagation() {},
  });
  const fire = (type, event) => {
    for (const handler of documentListeners.get(type) || []) handler(event);
  };
  const triggerAt = (rect, placement) => {
    const trigger = new FakeElement("placed-trigger");
    trigger.dataset.infoTooltipList = JSON.stringify({
      title: "Used by 1 agent",
      items: ["Research Buddy"],
      icon: "agent",
    });
    if (placement) trigger.dataset.infoTooltipPlacement = placement;
    trigger.rect = rect;
    trigger.closest = (selector) =>
      selector.startsWith(".info-tooltip-trigger") ? trigger : null;
    return trigger;
  };

  // Room to the right (viewport 1200, tooltip 120x40): panel sits at
  // rect.right + 6, vertically centered on the 32px-tall trigger.
  const right = triggerAt(
    { left: 300, right: 420, top: 300, bottom: 332, width: 120, height: 32 },
    "right",
  );
  fire("mouseover", eventFor(right));
  const tooltip = body.children.at(-1);
  assert.equal(tooltip.style.left, "426px");
  assert.equal(tooltip.style.top, "296px");
  fire("mouseout", eventFor(right));

  // No room to the right: falls back to the default below-left placement.
  const clamped = triggerAt(
    { left: 1000, right: 1100, top: 300, bottom: 332, width: 100, height: 32 },
    "right",
  );
  fire("mouseover", eventFor(clamped));
  assert.equal(tooltip.style.left, "1000px");
  assert.equal(tooltip.style.top, "338px");

  // No placement opt-in: below-left as always.
  const plain = triggerAt({
    left: 300,
    right: 420,
    top: 300,
    bottom: 332,
    width: 120,
    height: 32,
  });
  fire("mouseover", eventFor(plain));
  assert.equal(tooltip.style.left, "300px");
  assert.equal(tooltip.style.top, "338px");
});

test("Discover skills-link hover shows the provenance tooltip; non-local rows get the Marketplace chip", async () => {
  const { window, elements, body } = loadAgentsModuleHarness({
    agents: [],
    skills: [
      { id: "algorithmic-art", display_name: "Algorithmic Art", source: "user" },
      { id: "web-search", display_name: "Web Search", source: "system" },
    ],
  });
  // Catalogs load on the my-agents path; Discover reuses them.
  await window.AgentsTabModule.loadMyAgents();
  await settle();

  // A marketplace search result whose envelope carries flattened skill ids —
  // two locally known, one with no local copy.
  window.electronAPI.aiMarketplace.search = async () => ({
    success: true,
    data: {
      results: [
        {
          id: "sol-1",
          name: "Marketplace Agent",
          skill_ids: ["algorithmic-art", "web-search", "loupe-update-generator"],
        },
      ],
    },
  });
  await window.AgentsTabModule.runDiscoverSearch();
  await settle();

  const anchor = new FakeElement("");
  anchor.classList.add("agent-card-skills-link");
  anchor.dataset.solutionId = "sol-1";
  anchor.rect = { left: 40, right: 90, top: 200, bottom: 220, width: 50, height: 20 };
  anchor.closest = (selector) =>
    selector === ".agent-card-skills-link" ? anchor : null;
  elements
    .get("agents-tab-list")
    .dispatchEvent("mouseover", { target: anchor, relatedTarget: null });

  const tooltip = body.children.find(
    (child) => child.className === "agent-card-tooltip",
  );
  assert.ok(tooltip, "tooltip node is created and body-mounted");
  assert.equal(tooltip.hidden, false, "tooltip is shown on hover");
  // Discover now renders the provenance grid, not the plain name list.
  assert.match(tooltip.innerHTML, /agent-card-tooltip-skill-grid/);
  // Locally-resolvable rows carry their real source chips.
  assert.match(tooltip.innerHTML, /Algorithmic Art[\s\S]*?badge-user/);
  assert.match(tooltip.innerHTML, /Web Search[\s\S]*?badge-core/);
  // Rows without a local copy get the neutral Solutions Marketplace chip —
  // never the my-agents "Not on this computer" note (user decision,
  // 2026-07-31; label spelled out in full since 2026-08-03).
  assert.match(
    tooltip.innerHTML,
    /Loupe Update Generator[\s\S]*?badge-marketplace-name">Solutions Marketplace</,
  );
  assert.doesNotMatch(tooltip.innerHTML, /Not on this computer/);
});

test("skills tooltip rows sort by source group, then alphabetically (round 17)", async () => {
  const agent = {
    id: "agent-sort",
    name: "Sort Agent",
    description: "Sort fixture",
    base_model_id: "gpt-5",
    // Scrambled selection order on purpose.
    skill_ids: ["zed-notes", "alpha-installed", "aaa-git", "web-search", "aaa-notes"],
    tool_server_ids: [],
    created_by_email: "dsantiago@example.invalid",
    creation_source: "local",
  };
  const { window, elements, body } = loadAgentsModuleHarness({
    agents: [agent],
    skills: [
      { id: "zed-notes", display_name: "Zed Notes", source: "user" },
      { id: "aaa-notes", display_name: "Aaa Notes", source: "user" },
      { id: "web-search", display_name: "Web Search", source: "system" },
      {
        id: "alpha-installed",
        display_name: "Alpha Installed",
        source: "marketplace",
        marketplace_id: "ai-marketplace",
        marketplace_name: "AI Marketplace",
      },
      {
        // Git-marketplace install: ranks LAST despite alphabetizing first.
        id: "aaa-git",
        display_name: "Aaa Git",
        source: "marketplace",
        marketplace_id: "anthropic-agent-skills",
        marketplace_name: "anthropic-agent-skills",
      },
    ],
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();

  const anchor = new FakeElement("");
  anchor.classList.add("agent-card-skills-link");
  anchor.dataset.agentId = "agent-sort";
  anchor.rect = { left: 40, right: 90, top: 200, bottom: 220, width: 50, height: 20 };
  anchor.closest = (selector) =>
    selector === ".agent-card-skills-link" ? anchor : null;
  elements.get("agents-tab-list").dispatchEvent("mouseover", { target: anchor, relatedTarget: null });

  const tooltip = body.children.find((child) => child.className === "agent-card-tooltip");
  const html = tooltip.innerHTML;
  const at = (label) => html.indexOf(label);
  // Core/system → user (alpha) → Solutions installs → git installs,
  // regardless of selection order.
  assert.ok(at("Web Search") >= 0, "system row renders");
  assert.ok(at("Web Search") < at("Aaa Notes"), "system precedes user");
  assert.ok(at("Aaa Notes") < at("Zed Notes"), "user rows alphabetize");
  assert.ok(at("Zed Notes") < at("Alpha Installed"), "installed rows follow user rows");
  assert.ok(
    at("Alpha Installed") < at("Aaa Git"),
    "git-marketplace installs rank last despite alphabetizing first",
  );
});
