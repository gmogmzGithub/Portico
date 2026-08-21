// Round-12 kebab menus on Discover cards: pure listings offer View Details +
// Install Skill (Install drops when the listing has no bundle); counterpart
// cards offer View Details only, opening the exact local page. The trigger
// open/close protocol is the shared SkillCardRenderer machinery (body
// reparent, viewport clamps, _originalParent return).
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FakeElement,
  flushAsync,
  loadAgentSkillsHarness,
} = require("./agent-skills-harness");

const INSTALLED_ART = Object.freeze({
  name: "ai-marketplace/algorithmic-art",
  display_name: "Algorithmic Art",
  source: "marketplace",
  skill_path: "skills-marketplace/ai-marketplace/algorithmic-art",
  marketplace_id: "ai-marketplace",
  marketplace_name: "AI Marketplace",
  marketplace_solution_id: "sol-art",
  description: "Installed art skill",
  version: "1.0",
});

function menusHarness({ skills = [], results }) {
  const harness = loadAgentSkillsHarness({
    skills,
    skillFilesByName: { [INSTALLED_ART.name]: { files: [], basePath: "" } },
    marketplace: {
      search: async () => ({ success: true, data: { results } }),
    },
  });
  return harness;
}

async function activateDiscover(h) {
  h.window.AgentSkillsHooks.applySkillsActiveFilter("discover");
  await flushAsync();
}

function cardSlice(html, marker) {
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `card marker ${marker} rendered`);
  const next = html.indexOf("mcp-server-card skill-card", start);
  return html.slice(start, next === -1 ? undefined : next);
}

test("pure listings offer View Details + Install Skill; bundle-less listings drop Install; counterparts get Details only", async () => {
  const h = menusHarness({
    skills: [INSTALLED_ART],
    results: [
      { id: "sol-x", name: "pure-tool", description: "P", author: "a", has_bundle: true },
      { id: "sol-nb", name: "no-bundle", description: "N", author: "b", has_bundle: false },
      { id: "sol-art", name: "algorithmic-art", description: "Installed art skill", author: "anthropic", has_bundle: true },
    ],
  });
  await h.window.loadSkills();
  await activateDiscover(h);

  const html = h.getElementById("skills-list").innerHTML;
  const pureCard = cardSlice(html, 'data-dropdown-solution-id="sol-x"');
  assert.match(pureCard, /skill-discover-menu-details-btn" data-solution-id="sol-x"/);
  assert.match(pureCard, /skill-discover-menu-install-btn" data-solution-id="sol-x"/);
  const noBundleCard = cardSlice(html, 'data-dropdown-solution-id="sol-nb"');
  assert.match(noBundleCard, /skill-discover-menu-details-btn/);
  assert.doesNotMatch(noBundleCard, /skill-discover-menu-install-btn/);
  const counterpartCard = cardSlice(html, 'data-dropdown-solution-id="sol-art"');
  assert.match(counterpartCard, /skill-discover-menu-details-btn" data-solution-id="sol-art"/);
  assert.doesNotMatch(counterpartCard, /skill-discover-menu-install-btn/);
});

test("the menu Install item installs the listing; Details routes to the local page or the listing page per branch", async () => {
  const h = menusHarness({
    skills: [INSTALLED_ART],
    results: [
      { id: "sol-x", name: "pure-tool", description: "P", author: "a", has_bundle: true },
      { id: "sol-art", name: "algorithmic-art", description: "Installed art skill", author: "anthropic", has_bundle: true },
    ],
  });
  await h.window.loadSkills();
  await activateDiscover(h);

  const list = h.getElementById("skills-list");
  const installItem = new FakeElement("menu-install");
  installItem.dataset.solutionId = "sol-x";
  const detailsCounterpart = new FakeElement("menu-details-art");
  detailsCounterpart.dataset.solutionId = "sol-art";
  const detailsPure = new FakeElement("menu-details-pure");
  detailsPure.dataset.solutionId = "sol-x";
  list.qsaResults.set(".skill-discover-menu-install-btn", [installItem]);
  list.qsaResults.set(".skill-discover-menu-details-btn", [
    detailsCounterpart,
    detailsPure,
  ]);
  await activateDiscover(h);

  installItem.click({ stopPropagation() {}, target: { closest: () => null } });
  await flushAsync(12);
  assert.deepEqual(h.calls.install, [["sol-x", undefined]]);

  detailsCounterpart.click({ stopPropagation() {}, target: { closest: () => null } });
  await flushAsync(12);
  assert.deepEqual(
    h.calls.getSkillFiles,
    [INSTALLED_ART.name],
    "counterpart Details opened the exact local page",
  );
  assert.equal(h.calls.getBundle.length, 0);

  h.window.closeSkillDetailsModal();
  await activateDiscover(h);
  detailsPure.click({ stopPropagation() {}, target: { closest: () => null } });
  await flushAsync(12);
  assert.deepEqual(h.calls.getBundle, ["sol-x"], "pure Details opened the listing page");
});

test("the shared trigger protocol: open reparents the dropdown to body with `visible`; close returns it home", async () => {
  const h = menusHarness({
    results: [
      { id: "sol-x", name: "pure-tool", description: "P", author: "a", has_bundle: true },
    ],
  });
  await h.window.loadSkills();
  await activateDiscover(h);

  const list = h.getElementById("skills-list");
  const wrapper = new FakeElement("menu-wrapper");
  const trigger = new FakeElement("menu-trigger");
  const dropdown = new FakeElement("menu-dropdown");
  trigger.parentElement = wrapper;
  dropdown.parentElement = wrapper;
  wrapper.children.set(".mcp-card-dropdown", dropdown);
  list.qsaResults.set(".mcp-card-menu-trigger", [trigger]);
  await activateDiscover(h);

  trigger.click({ stopPropagation() {}, target: { closest: () => null } });
  assert.ok(dropdown.classList.contains("visible"), "dropdown opened");
  assert.equal(
    dropdown.parentElement,
    h.document.body,
    "dropdown escapes overflow clipping via document.body",
  );
  assert.equal(dropdown._originalParent, wrapper, "the way home is recorded");

  // The document-level closer's contract: visible dropdowns lose the class
  // and return to their original parent.
  h.docQsaResults.set(".mcp-card-dropdown.visible", [dropdown]);
  h.window.SkillCardRenderer.closeAllCardMenus();
  assert.ok(!dropdown.classList.contains("visible"), "dropdown closed");
  assert.equal(dropdown.parentElement, wrapper, "returned to its card");
});
