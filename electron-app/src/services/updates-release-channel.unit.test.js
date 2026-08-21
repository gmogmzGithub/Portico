const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const updatesPath = require.resolve("./updates");
const bootstrapPath = require.resolve("./bootstrap");
const sharedStatePath = require.resolve("./shared-state");
const cloudsmithConfigPath = require.resolve("../config/cloudsmith-config");
const originalLoad = Module._load;

function loadUpdates(projectRoot) {
  const previous = new Map(
    [updatesPath, bootstrapPath, sharedStatePath, cloudsmithConfigPath].map((modulePath) => [
      modulePath,
      require.cache[modulePath],
    ]),
  );

  require.cache[bootstrapPath] = {
    id: bootstrapPath,
    filename: bootstrapPath,
    loaded: true,
    exports: {
      PROJECT_ROOT: projectRoot,
      getThemeIcon() {
        return null;
      },
    },
  };
  require.cache[sharedStatePath] = {
    id: sharedStatePath,
    filename: sharedStatePath,
    loaded: true,
    exports: {
      buildInfo: {
        buildNumber: "06222026-aaaaaaaa",
        timestamp: "2026-06-22T12:00:00.000Z",
      },
      windows: {},
    },
  };
  require.cache[cloudsmithConfigPath] = {
    id: cloudsmithConfigPath,
    filename: cloudsmithConfigPath,
    loaded: true,
    exports: {
      CLOUDSMITH_OWNER: "portico",
      CLOUDSMITH_REPO: "portico",
      CLOUDSMITH_API_BASE: "https://api.example.test/v1",
      CLOUDSMITH_DL_BASE: "https://dl.example.test",
      CLOUDSMITH_READ_TOKEN: "metadata-token",
      CLOUDSMITH_ENTITLEMENT_TOKEN: "download-token",
    },
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          exit() {},
          quit() {},
          relaunch() {},
        },
        dialog: {
          async showMessageBox() {
            return { response: 0 };
          },
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[updatesPath];
  const updates = require(updatesPath);

  return {
    updates,
    restore() {
      Module._load = originalLoad;
      for (const [modulePath, cached] of previous) {
        delete require.cache[modulePath];
        if (cached) require.cache[modulePath] = cached;
      }
    },
  };
}

test("custom update discovery and specific-build lookup retain package identity", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "custom-updates-"));
  fs.writeFileSync(
    path.join(projectRoot, "UPDATE_CHANNEL"),
    "portico_team-alpha\n",
    "utf8",
  );
  const { updates, restore } = loadUpdates(projectRoot);
  const originalFetch = global.fetch;
  const requestedUrls = [];
  const customPackage = {
    name: "portico_team-alpha",
    filename: "portico_team-alpha-06232026-deadbeef.zip",
    version: "06232026-deadbeef",
    uploaded_at: "2026-06-23T12:00:00.000Z",
    checksum_sha256: "abc123",
    size: 1234,
    tags_immutable: { custom: ["portico-update-ready-v1"] },
  };
  global.fetch = async (url) => {
    requestedUrls.push(String(url));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return [customPackage];
      },
    };
  };

  try {
    const discovered = await updates.checkForUpdates();
    assert.equal(discovered.updateAvailable, true);
    assert.equal(discovered.updateChannel, "portico_team-alpha");
    assert.equal(discovered.updateChannelDisplay, "custom");
    assert.equal(
      discovered.downloadUrl,
      "https://dl.example.test/download-token/portico/raw/names/portico_team-alpha/versions/06232026-deadbeef/portico_team-alpha-06232026-deadbeef.zip",
    );

    const specific = await updates.findSpecificBuild("06232026-deadbeef");
    assert.equal(specific.found, true);
    assert.equal(specific.updateChannel, "portico_team-alpha");
    assert.equal(specific.updateChannelDisplay, "custom");
    const queries = requestedUrls.map((url) => new URL(url).searchParams.get("query"));
    assert.equal(
      queries.every((query) => query.includes("name:^portico_team-alpha$")),
      true,
    );
    assert.match(queries[0], /tag:\^portico-update-ready-v1\$/);
    assert.doesNotMatch(queries[1], /portico-update-ready-v1/);
  } finally {
    global.fetch = originalFetch;
    restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("malformed runtime channel falls back to Stable while safe legacy values remain custom", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-updates-"));
  const updateChannelPath = path.join(projectRoot, "UPDATE_CHANNEL");
  const { updates, restore } = loadUpdates(projectRoot);

  try {
    fs.writeFileSync(updateChannelPath, "../../unsafe\n", "utf8");
    assert.equal(updates.getUpdateChannel(), "portico");

    fs.writeFileSync(updateChannelPath, "historicalTeam_7\n", "utf8");
    assert.equal(updates.getUpdateChannel(), "historicalTeam_7");
    assert.equal(updates.getUpdateChannelInfo().kind, "custom");
  } finally {
    restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
