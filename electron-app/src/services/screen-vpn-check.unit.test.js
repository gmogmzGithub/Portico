const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeElement } = require("./test-helpers/fake-dom");

function loadModule() {
  const modulePath = require.resolve(
    "../renderer/screens/guided-setup/screen-vpn-check",
  );
  delete require.cache[modulePath];
  return require("../renderer/screens/guided-setup/screen-vpn-check");
}

async function withVpnDom(run) {
  const harborStatus = new FakeElement("vpn-check-harbor-status");
  const cloudsmithStatus = new FakeElement("vpn-check-cloudsmith-status");
  const errorBox = new FakeElement("vpn-check-error");
  const button = new FakeElement("vpn-check-button");
  const previousDocument = global.document;

  global.document = {
    getElementById(id) {
      switch (id) {
        case "vpn-check-harbor-status":
          return harborStatus;
        case "vpn-check-cloudsmith-status":
          return cloudsmithStatus;
        case "vpn-check-error":
          return errorBox;
        case "vpn-check-button":
          return button;
        default:
          return null;
      }
    },
  };

  try {
    return await run({ harborStatus, cloudsmithStatus, errorBox, button });
  } finally {
    global.document = previousDocument;
  }
}

test("vpn check helpers normalize missing state and render the right status labels", () => {
  const mod = loadModule();

  assert.deepEqual(mod._test.normalizeResult(null), {
    success: false,
    harbor: { ok: false, error: null },
    cloudsmith: { ok: false, error: null },
  });
  assert.equal(mod._test.getStatusLabel(false, true, false), "Checking...");
  assert.equal(mod._test.getStatusLabel(false, false, false), "Not checked");
  assert.equal(mod._test.getStatusLabel(true, false, true), "Connected");
  assert.equal(mod._test.getStatusLabel(false, false, true), "Needs VPN");
});

test("runVpnCheck falls through to prerequisites when no native VPN checker is available", async () => {
  await withVpnDom(async () => {
    const previousWindow = global.window;
    const shownStages = [];
    global.window = { electronAPI: {} };

    try {
      const mod = loadModule();
      mod.loadVpnCheckScreen({}, {
        showStage(stage) {
          shownStages.push(stage);
        },
      });
      await mod.runVpnCheck();
      assert.deepEqual(shownStages, ["prerequisites"]);
    } finally {
      global.window = previousWindow;
    }
  });
});

test("runVpnCheck renders failures and only advances on success", async () => {
  await withVpnDom(async ({ harborStatus, cloudsmithStatus, errorBox, button }) => {
    const previousWindow = global.window;
    const shownStages = [];
    let attempt = 0;
    global.window = {
      electronAPI: {
        async checkVpnConnectivity() {
          attempt += 1;
          if (attempt === 1) {
            return {
              success: false,
              harbor: { ok: false, error: "vpn required" },
              cloudsmith: { ok: true, error: null },
            };
          }
          return {
            success: true,
            harbor: { ok: true, error: null },
            cloudsmith: { ok: true, error: null },
          };
        },
      },
    };

    try {
      const mod = loadModule();
      mod.loadVpnCheckScreen({}, {
        showStage(stage) {
          shownStages.push(stage);
        },
      });

      await mod.runVpnCheck();
      assert.equal(errorBox.style.display, "block");
      assert.match(errorBox.textContent, /Harbor registry/);
      assert.equal(harborStatus.textContent, "Needs VPN");
      assert.equal(cloudsmithStatus.textContent, "Connected");
      assert.equal(button.textContent, "Check VPN & Continue");
      assert.deepEqual(shownStages, []);

      await mod.runVpnCheck();
      assert.equal(errorBox.style.display, "none");
      assert.equal(harborStatus.textContent, "Connected");
      assert.equal(cloudsmithStatus.textContent, "Connected");
      assert.deepEqual(shownStages, ["prerequisites"]);
    } finally {
      global.window = previousWindow;
    }
  });
});
