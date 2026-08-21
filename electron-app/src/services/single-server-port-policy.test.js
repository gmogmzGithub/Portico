const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CANONICAL_MAIN_STACK_CALLBACK_PORT,
  CANONICAL_SINGLE_STACK_CALLBACK_PORT,
  isSupportedOAuthCallbackPort,
  normalizeSingleServerCallbackPort,
  preferredSingleServerCallbackPorts,
  applyMainStackOAuthCallbackPortEnv,
  selectSingleServerCallbackPort,
} = require("./single-server-port-policy");

test("single-server callback policy only allows canonical callback ports", () => {
  assert.equal(isSupportedOAuthCallbackPort(3834), true);
  assert.equal(isSupportedOAuthCallbackPort(3836), true);
  assert.equal(isSupportedOAuthCallbackPort(3996), false);
  assert.equal(isSupportedOAuthCallbackPort("3837"), false);
});

test("single-server callback policy normalizes unsupported ports to 3836", () => {
  assert.equal(
    normalizeSingleServerCallbackPort(3996),
    CANONICAL_SINGLE_STACK_CALLBACK_PORT,
  );
  assert.equal(
    normalizeSingleServerCallbackPort("3836"),
    CANONICAL_SINGLE_STACK_CALLBACK_PORT,
  );
  assert.equal(
    normalizeSingleServerCallbackPort(3834),
    CANONICAL_MAIN_STACK_CALLBACK_PORT,
  );
});

test("single-server callback policy prefers only port 3836 for guided setup", () => {
  assert.deepEqual(preferredSingleServerCallbackPorts(), [3836]);
});

test("host and bridge runtimes are pinned to the main-stack callback port", () => {
  const env = applyMainStackOAuthCallbackPortEnv({
    MCPO_OAUTH_CALLBACK_PORT: "3836",
    OAUTH_CALLBACK_PORT: "3836",
    KEEP_ME: "yes",
  });

  assert.equal(env.MCPO_OAUTH_CALLBACK_PORT, "3834");
  assert.equal(env.OAUTH_CALLBACK_PORT, "3834");
  assert.equal(env.KEEP_ME, "yes");
});

test("single-server callback policy does not fall back to random callback ports", async () => {
  const selected = await selectSingleServerCallbackPort(async (port) => port === 3836);
  assert.equal(selected, 3836);

  await assert.rejects(
    () => selectSingleServerCallbackPort(async () => false),
    /OAuth callback port 3836 is required/,
  );
});
