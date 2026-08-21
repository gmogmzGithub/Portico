// Behavior tests for the renderer bundle script's dual mode: importable
// (the dev app startup rebuild) without side effects, executable as a CLI
// (packaged builds). A stale renderer/dist during dev launches was a real
// incident (2026-07-28): edits shipped "live-verified" that the app never
// loaded.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SCRIPT_PATH = path.join(__dirname, "..", "..", "scripts", "bundle-renderer.js");
const DIST_DIR = path.join(__dirname, "..", "renderer", "dist");

test("requiring the bundle script exports the builder without running it", () => {
  const before = fs.existsSync(DIST_DIR)
    ? fs.readdirSync(DIST_DIR).map((name) => {
        const stat = fs.statSync(path.join(DIST_DIR, name));
        return `${name}:${stat.mtimeMs}`;
      })
    : [];

  delete require.cache[require.resolve(SCRIPT_PATH)];
  const mod = require(SCRIPT_PATH);
  assert.equal(typeof mod.bundleRendererScripts, "function");

  const after = fs.existsSync(DIST_DIR)
    ? fs.readdirSync(DIST_DIR).map((name) => {
        const stat = fs.statSync(path.join(DIST_DIR, name));
        return `${name}:${stat.mtimeMs}`;
      })
    : [];
  assert.deepEqual(after, before, "import alone must not rebuild dist");
});

test("invoking the builder produces the agent-skills bundle", async () => {
  delete require.cache[require.resolve(SCRIPT_PATH)];
  const { bundleRendererScripts } = require(SCRIPT_PATH);
  await bundleRendererScripts();
  const bundlePath = path.join(DIST_DIR, "agent-skills.bundle.js");
  assert.ok(fs.existsSync(bundlePath), "agent-skills bundle exists");
  const content = fs.readFileSync(bundlePath, "utf8");
  assert.ok(
    content.includes("AgentSkillsHooks"),
    "the bundle carries current source (hooks surface present)",
  );
});
