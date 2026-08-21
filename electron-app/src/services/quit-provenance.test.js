const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  getQuitProvenance,
  resetQuitProvenanceForTests,
  tagAppQuit,
} = require("./quit-provenance");

test("untagged quits are reported as user/OS/external", () => {
  resetQuitProvenanceForTests();
  assert.deepEqual(getQuitProvenance(), {
    appOwned: false,
    reason: "user/OS/external",
    taggedAt: null,
  });
});

test("app-owned quits retain a sanitized diagnostic reason", () => {
  resetQuitProvenanceForTests();
  const tagged = tagAppQuit("prepared update restart");
  assert.equal(tagged.appOwned, true);
  assert.equal(tagged.reason, "prepared-update-restart");
  assert.equal(getQuitProvenance().reason, "prepared-update-restart");
});

test("production app.quit and app.exit calls are tagged immediately before invocation", () => {
  const servicesDir = __dirname;
  for (const fileName of ["main.js", "updates.js", "windows.js"]) {
    const lines = fs
      .readFileSync(path.join(servicesDir, fileName), "utf8")
      .split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!/\bapp\.(?:quit|exit)\(/.test(lines[index]) || lines[index].trim().startsWith("*")) {
        continue;
      }
      const context = lines.slice(Math.max(0, index - 3), index).join("\n");
      assert.match(
        context,
        /tagAppQuit\(/,
        `${fileName}:${index + 1} must tag quit provenance before exiting`,
      );
    }
  }
});

test("production files that call tagAppQuit import it", () => {
  const servicesDir = __dirname;
  for (const fileName of ["main.js", "updates.js", "windows.js"]) {
    const source = fs.readFileSync(path.join(servicesDir, fileName), "utf8");
    if (!/\btagAppQuit\(/.test(source)) {
      continue;
    }

    assert.match(
      source,
      /const\s+\{[^}]*\btagAppQuit\b[^}]*\}\s*=\s*require\(["']\.\/quit-provenance["']\)/s,
      `${fileName} calls tagAppQuit but does not import it`,
    );
  }
});
