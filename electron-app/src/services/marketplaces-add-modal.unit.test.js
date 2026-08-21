// Add Marketplace modal behavior (round 9) — the behavioral home for the
// former control-plane-render-regressions source pin "add marketplace modal
// copy and renderer accept GitLab and sparse repositories": open/focus flow,
// submit wiring, validation copy naming the approved sources, backend policy
// errors surfacing in the modal, and card badge rendering. Static modal HTML
// copy has no behavioral seam; the user-facing allowed-sources copy is
// asserted here (renderer validation) and in marketplace-allowlist.unit.test.js
// (backend remediation message).
const test = require("node:test");
const assert = require("node:assert/strict");

const { flushAsync, loadMarketplacesHarness } = require("./marketplaces-harness");

test("opening the modal clears state and focuses the input after a frame", () => {
  const h = loadMarketplacesHarness();
  const modal = h.getElementById("add-marketplace-modal");
  const input = h.getElementById("marketplace-source-input");
  const errorDiv = h.getElementById("add-marketplace-error");

  input.value = "stale";
  errorDiv.style.display = "flex";
  const focusCalls = [];
  input.focus = (...args) => focusCalls.push(args);

  h.window.openAddMarketplaceModal();

  assert.equal(modal.classList.contains("visible"), true);
  assert.equal(input.value, "");
  assert.equal(errorDiv.style.display, "none");
  assert.equal(focusCalls.length, 1, "input focused via requestAnimationFrame");
  // The options object crosses the vm realm boundary; compare by value.
  assert.equal(focusCalls[0][0]?.preventScroll, true);
});

test("submitting an empty source shows validation copy naming the approved sources", async () => {
  const h = loadMarketplacesHarness();
  h.window.openAddMarketplaceModal();

  const submitBtn = h.getElementById("add-marketplace-submit-btn");
  submitBtn.click();
  await flushAsync();

  assert.equal(h.calls.addMarketplace.length, 0, "no backend call for empty input");
  const errorDiv = h.getElementById("add-marketplace-error");
  const errorText = h.getElementById("add-marketplace-error-text");
  assert.equal(errorDiv.style.display, "flex");
  assert.match(errorText.textContent, /example\.invalid/);
  assert.match(errorText.textContent, /anthropics\/skills/);
  assert.match(errorText.textContent, /anthropics\/knowledge-work-plugins/);
});

test("a valid submit adds the marketplace, closes the modal, and refreshes the list", async () => {
  const h = loadMarketplacesHarness();
  h.window.openAddMarketplaceModal();

  const input = h.getElementById("marketplace-source-input");
  input.value = "anthropics/skills";
  // Enter in the input submits, same as the button.
  input.dispatch("keydown", { key: "Enter" });
  await flushAsync();

  assert.deepEqual(h.calls.addMarketplace, ["anthropics/skills"]);
  assert.equal(
    h.getElementById("add-marketplace-modal").classList.contains("visible"),
    false,
    "modal closed on success",
  );
  assert.ok(h.calls.getMarketplaces >= 1, "list refreshed");
  assert.ok(
    h.notifications.some(
      ([kind, message]) =>
        kind === "success" && /added successfully/i.test(message),
    ),
  );
});

test("a backend policy rejection surfaces its remediation copy in the modal", async () => {
  const h = loadMarketplacesHarness({
    electronAPI: {
      addMarketplace: async () => ({
        success: false,
        error:
          "Marketplace source github.com/example/random is not an approved source. New skill marketplaces can only be added from internal Portico GitLab repositories (example.invalid) and Anthropic's anthropics/skills and anthropics/knowledge-work-plugins GitHub repositories.",
        errorCode: "marketplace_source_not_allowed",
      }),
    },
  });
  h.window.openAddMarketplaceModal();

  const input = h.getElementById("marketplace-source-input");
  input.value = "example/random";
  h.getElementById("add-marketplace-submit-btn").click();
  await flushAsync();

  const modal = h.getElementById("add-marketplace-modal");
  assert.equal(modal.classList.contains("visible"), true, "modal stays open");
  const errorDiv = h.getElementById("add-marketplace-error");
  const errorText = h.getElementById("add-marketplace-error-text");
  assert.equal(errorDiv.style.display, "flex");
  assert.match(errorText.textContent, /not an approved source/);
  assert.match(errorText.textContent, /example\.invalid/);
  assert.match(errorText.textContent, /anthropics\/knowledge-work-plugins/);
});

test("marketplace cards badge the provider (GITLAB/GITHUB/URL) and never a sparse badge", async () => {
  const h = loadMarketplacesHarness({
    config: {
      version: "1.0",
      marketplaces: [
        {
          id: "corp",
          name: "Corp Skills",
          source: {
            type: "gitlab",
            host: "example.invalid",
            projectPath: "community/skills",
          },
          cachedManifest: { plugins: [{ name: "corp", skills: ["./skills/a"] }] },
          owner: { name: "Community" },
        },
        {
          id: "anthropic",
          name: "Anthropic Skills",
          source: { type: "github", repo: "anthropics/skills" },
          isSparse: true,
          cachedManifest: { plugins: [{ name: "s", skills: ["./skills/b"] }] },
          owner: { name: "Anthropic" },
        },
      ],
      installedSkills: [],
    },
  });

  await h.window.loadMarketplaces();
  const html = h.getElementById("marketplaces-list").innerHTML;
  assert.match(html, /badge-provider">GITLAB</);
  assert.match(html, /badge-provider">GITHUB</);
  assert.doesNotMatch(html, /badge-sparse/, "sparse is an internal detail, not a badge");
  assert.match(html, /Corp Skills/);
  assert.match(html, /1 skills available/);
});

test("built-in (ootb) marketplace cards render no remove button; user-added cards keep it", async () => {
  const h = loadMarketplacesHarness({
    config: {
      version: "1.0",
      marketplaces: [
        {
          id: "knowledge-work-plugins",
          name: "knowledge-work-plugins",
          source: { type: "github", repo: "anthropics/knowledge-work-plugins" },
          ootb: true,
          cachedManifest: { plugins: [{ name: "s", skills: ["./skills/a"] }] },
          owner: { name: "Anthropic" },
        },
        {
          id: "user-added",
          name: "User Added",
          source: { type: "github", repo: "someone/skills" },
          cachedManifest: { plugins: [{ name: "u", skills: ["./skills/b"] }] },
          owner: { name: "Someone" },
        },
      ],
      installedSkills: [],
    },
  });

  await h.window.loadMarketplaces();
  const html = h.getElementById("marketplaces-list").innerHTML;
  assert.doesNotMatch(
    html,
    /marketplace-remove-btn" data-marketplace-id="knowledge-work-plugins"/,
    "built-in marketplaces are permanent",
  );
  assert.match(
    html,
    /marketplace-remove-btn" data-marketplace-id="user-added"/,
    "user-added marketplaces stay removable",
  );
  // Sync stays available on both.
  assert.match(html, /marketplace-sync-btn" data-marketplace-id="knowledge-work-plugins"/);
});
