// Skill-details image viewer: the main process serves image assets as data
// URLs (never utf8 text), and the renderer shows image tabs through a
// dedicated read-only preview instead of the raw code view.
//
// Behavioral suite (no source pins): the read-skill-file handler runs for
// REAL via the Module._load ipc-capture pattern (terminal-command-ipc
// .unit.test.js) against temp skill roots; renderer tab behavior runs
// agent-skills.js in the vm FakeElement harness (agent-skills-harness.js).
//
// The former styles.css pins (.skill-image-content/.skill-image-stage/
// .skill-image-preview) were removed rather than converted: they assert
// static CSS with no runtime to exercise in Node. The class names' presence
// in the RENDERED markup is asserted below; the rules live in
// electron-app/src/styles.css.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const {
  FakeElement,
  flushAsync,
  loadAgentSkillsHarness,
} = require("./agent-skills-harness");

const ipcModulePath = require.resolve("./ipc");
const originalModuleLoad = Module._load;

function loadReadSkillFileHarness() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-img-root-"));
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "skills-img-data-"));
  const handlers = new Map();
  const previousModule = require.cache[ipcModulePath];

  const electronStub = {
    app: { getPath: () => userDataPath },
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      on() {},
    },
    shell: {
      async openExternal() {
        return true;
      },
      async openPath() {
        return "";
      },
    },
    clipboard: { writeText() {} },
    BrowserWindow: {
      fromWebContents() {
        return null;
      },
      getAllWindows() {
        return [];
      },
    },
    Notification: function Notification() {},
  };

  const moduleMap = new Map([
    ["./bootstrap", { PROJECT_ROOT: projectRoot }],
    // Registration-time hooks of unrelated MCP machinery in the same
    // registration group: inert stubs.
    [
      "./docker-mcp",
      {
        resetTargetedMcpOperationPublication() {},
        publishTargetedMcpReadiness() {},
        beginTargetedMcpOperationPublication() {},
        endTargetedMcpOperationPublication() {},
      },
    ],
    [
      "./mcp-operation-manager",
      { defaultMcpOperationManager: { onMcpOperationUpdated: () => () => {} } },
    ],
    [
      "./mcp-operation-coordinator",
      { McpOperationCoordinator: class McpOperationCoordinator {} },
    ],
    ["./mcp-operation-service", { registerMcpOperationCoordinator() {} }],
  ]);

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return electronStub;
    if (
      parent?.filename === ipcModulePath &&
      (request.startsWith("./") || request.startsWith("../"))
    ) {
      if (moduleMap.has(request)) return moduleMap.get(request);
      return {};
    }
    return originalModuleLoad.apply(this, [request, parent, isMain]);
  };

  delete require.cache[ipcModulePath];
  const ipc = require("./ipc");
  ipc.registerPerServerMcpoHandlers();

  return {
    handlers,
    projectRoot,
    restore() {
      Module._load = originalModuleLoad;
      delete require.cache[ipcModulePath];
      if (previousModule) require.cache[ipcModulePath] = previousModule;
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(userDataPath, { recursive: true, force: true });
    },
  };
}

test("read-skill-file serves image assets as typed data URLs instead of utf8 text", async () => {
  const loaded = loadReadSkillFileHarness();
  try {
    const read = loaded.handlers.get("read-skill-file");
    assert.equal(typeof read, "function");

    const skillDir = path.join(loaded.projectRoot, "skills-user", "my-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const pngPath = path.join(skillDir, "logo.png");
    fs.writeFileSync(pngPath, pngBytes);
    const svgPath = path.join(skillDir, "diagram.svg");
    fs.writeFileSync(svgPath, "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const mdPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(mdPath, "# hello\n");

    // Binary image -> base64 data URL with the correct mime type + size.
    const png = await read(null, pngPath);
    assert.equal(png.success, true);
    assert.equal(png.fileKind, "image");
    assert.equal(png.mimeType, "image/png");
    assert.equal(png.sizeBytes, pngBytes.length);
    assert.equal(png.dataUrl, `data:image/png;base64,${pngBytes.toString("base64")}`);
    assert.equal(png.content, undefined, "images are never returned as text");

    // SVG maps to its dedicated mime type.
    const svg = await read(null, svgPath);
    assert.equal(svg.mimeType, "image/svg+xml");
    assert.match(svg.dataUrl, /^data:image\/svg\+xml;base64,/);

    // Non-image files keep the plain utf8 text contract.
    const text = await read(null, mdPath);
    assert.deepEqual(text, { success: true, fileKind: "text", content: "# hello\n" });

    // Paths outside the skills roots stay inaccessible.
    const denied = await read(null, "/etc/hosts");
    assert.equal(denied.success, false);
    assert.match(denied.error, /Access denied/);
  } finally {
    loaded.restore();
  }
});

test("image tabs render the read-only preview, never the raw code view", async () => {
  const userSkill = {
    name: "my-skill",
    source: "user",
    skill_path: "skills-user/my-skill",
    description: "Mine",
  };
  const files = [
    {
      name: "SKILL.md",
      relativePath: "SKILL.md",
      fullPath: "/skills/my-skill/SKILL.md",
      type: "file",
    },
    {
      name: "logo.png",
      relativePath: "logo.png",
      fullPath: "/skills/my-skill/logo.png",
      type: "file",
    },
    {
      name: "notes.txt",
      relativePath: "notes.txt",
      fullPath: "/skills/my-skill/notes.txt",
      type: "file",
    },
    {
      name: "broken.png",
      relativePath: "broken.png",
      fullPath: "/skills/my-skill/broken.png",
      type: "file",
    },
  ];
  const harness = loadAgentSkillsHarness({
    skills: [userSkill],
    skillFilesByName: { "my-skill": { success: true, basePath: "/skills/my-skill", files } },
    fileReads: {
      "/skills/my-skill/SKILL.md": { success: true, fileKind: "text", content: "# doc" },
      "/skills/my-skill/logo.png": {
        success: true,
        fileKind: "image",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,AAAA",
        sizeBytes: 2048,
      },
      "/skills/my-skill/notes.txt": {
        success: true,
        fileKind: "text",
        content: "plain text body",
      },
      // Image read that produced no dataUrl (e.g. read failure upstream).
      "/skills/my-skill/broken.png": { success: true, fileKind: "image" },
    },
  });

  // Wire clickable file-tree entries (production attaches per-item listeners).
  const fileTree = harness.getElementById("skill-file-tree");
  const makeItem = (file) => {
    const item = new FakeElement(file.name);
    item.dataset.path = file.fullPath;
    item.dataset.name = file.name;
    return item;
  };
  const pngItem = makeItem(files[1]);
  const txtItem = makeItem(files[2]);
  const brokenItem = makeItem(files[3]);
  fileTree.qsaResults.set(".skill-file-item", [pngItem, txtItem, brokenItem]);

  await harness.window.openSkillDetailsModal(userSkill);
  await flushAsync();
  const contentArea = harness.getElementById("skill-content-area");

  // Image tab: dedicated preview stage with the data URL + metadata, and the
  // raw code view is never used for it. Images stay read-only even on user
  // skills (no Edit toolbar).
  pngItem.click();
  await flushAsync();
  assert.match(contentArea.innerHTML, /class="skill-image-content"/);
  assert.match(contentArea.innerHTML, /class="skill-image-stage"/);
  assert.match(contentArea.innerHTML, /class="skill-image-preview"/);
  assert.match(contentArea.innerHTML, /src="data:image\/png;base64,AAAA"/);
  assert.match(contentArea.innerHTML, /image\/png \| 2 KB/);
  assert.doesNotMatch(contentArea.innerHTML, /skill-code-content/);
  assert.doesNotMatch(contentArea.innerHTML, /skill-file-edit-btn/);

  // Plain text tab: raw code view (and, for user skills, the Edit toolbar).
  txtItem.click();
  await flushAsync();
  assert.match(contentArea.innerHTML, /<pre class="skill-code-content/);
  assert.match(contentArea.innerHTML, /plain text body/);
  assert.match(contentArea.innerHTML, /skill-file-edit-btn/);
  assert.doesNotMatch(contentArea.innerHTML, /skill-image-preview/);

  // Image tab without a data URL degrades to the explicit placeholder.
  brokenItem.click();
  await flushAsync();
  assert.match(contentArea.innerHTML, /Unable to render image preview/);
  assert.doesNotMatch(contentArea.innerHTML, /skill-code-content/);
});
