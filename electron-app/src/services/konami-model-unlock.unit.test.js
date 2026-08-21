const test = require("node:test");
const assert = require("node:assert/strict");

const {
  KonamiModelUnlockError,
  buildUnlockedModelPayload,
  isAlreadyUnlocked,
  unlockKonamiModelWithServiceAuth,
} = require("./konami-model-unlock");

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return payload === null ? "" : JSON.stringify(payload);
    },
  };
}

test("service-auth Konami unlock updates the service-owned model", async () => {
  const calls = [];
  const responses = [
    jsonResponse(200, { token: "service-token" }),
    jsonResponse(200, {
      id: "GPT-5.6 Sol Pro",
      user_id: "portico-service",
      name: "GPT-5.6 Sol Pro",
      params: { system: "system prompt" },
      meta: {
        disabled: true,
        disabled_reason: "Temporarily disabled due to high costs",
        toolIds: ["server:skills"],
      },
      user: { id: "portico-service" },
      info: { read_only: true },
    }),
    jsonResponse(200, { id: "GPT-5.6 Sol Pro" }),
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return responses.shift();
  };

  const result = await unlockKonamiModelWithServiceAuth({
    fetchImpl,
    bridgeSecret: "bridge-secret",
    baseUrl: "http://localhost:3789",
  });

  assert.deepEqual(result, {
    success: true,
    modelId: "GPT-5.6 Sol Pro",
    alreadyUnlocked: false,
    auth: "service",
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "http://localhost:3789/api/v1/portico/auth/service-token");
  assert.equal(calls[0].options.headers.Authorization, "Bearer bridge-secret");
  assert.equal(calls[1].options.headers.Authorization, "Bearer service-token");
  assert.match(calls[1].url, /\/api\/v1\/models\/model\?id=GPT-5\.6\+Sol\+Pro$/);
  assert.equal(calls[2].options.headers.Authorization, "Bearer service-token");
  assert.match(calls[2].url, /\/api\/v1\/models\/model\/update\?id=GPT-5\.6\+Sol\+Pro$/);

  const updatePayload = JSON.parse(calls[2].options.body);
  assert.equal(updatePayload.user_id, "portico-service");
  assert.equal(updatePayload.meta.disabled, false);
  assert.equal(updatePayload.meta.toolIds[0], "server:skills");
  assert.equal("disabled_reason" in updatePayload.meta, false);
  assert.equal("user" in updatePayload, false);
  assert.equal("info" in updatePayload, false);
});

test("service-auth Konami unlock is idempotent when the model is already enabled", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return jsonResponse(200, { access_token: "service-token" });
    }
    return jsonResponse(200, {
      id: "GPT-5.6 Sol Pro",
      meta: { disabled: false },
    });
  };

  const result = await unlockKonamiModelWithServiceAuth({
    fetchImpl,
    bridgeSecret: "bridge-secret",
  });

  assert.equal(result.success, true);
  assert.equal(result.alreadyUnlocked, true);
  assert.equal(calls.length, 2);
});

test("service-auth Konami unlock preserves structured permission failures", async () => {
  const fetchImpl = async () =>
    jsonResponse(401, { detail: "Invalid OWUI auth bridge token" });

  await assert.rejects(
    unlockKonamiModelWithServiceAuth({
      fetchImpl,
      bridgeSecret: "stale-secret",
    }),
    (error) => {
      assert.equal(error instanceof KonamiModelUnlockError, true);
      assert.equal(error.code, "service-token-failed");
      assert.equal(error.status, 401);
      assert.deepEqual(error.body, {
        detail: "Invalid OWUI auth bridge token",
      });
      assert.equal(error.message.includes("stale-secret"), false);
      return true;
    },
  );
});

test("service-auth Konami unlock classifies startup connection failures", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };

  await assert.rejects(
    unlockKonamiModelWithServiceAuth({
      fetchImpl,
      bridgeSecret: "bridge-secret",
    }),
    (error) => {
      assert.equal(error instanceof KonamiModelUnlockError, true);
      assert.equal(error.code, "owui-unavailable");
      assert.equal(error.message, "OWUI request failed: fetch failed");
      assert.equal(error.cause instanceof TypeError, true);
      return true;
    },
  );
});

test("Konami payload helpers only remove update-incompatible fields", () => {
  const original = {
    id: "GPT-5.6 Sol Pro",
    meta: { disabled: true, disabled_reason: "cost", custom: "preserved" },
    user: { id: "owner" },
    info: { read_only: true },
  };
  const payload = buildUnlockedModelPayload(original);

  assert.equal(isAlreadyUnlocked(original), false);
  assert.equal(isAlreadyUnlocked(payload), true);
  assert.deepEqual(payload.meta, { disabled: false, custom: "preserved" });
  assert.equal("user" in payload, false);
  assert.equal("info" in payload, false);
  assert.equal(original.meta.disabled, true);
});
