const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { FakeElement } = require("./test-helpers/fake-dom");

const loadingPath = path.resolve(
  __dirname,
  "../renderer/views/loading.js",
);

function createLoadingHarness(currentUser) {
  const elements = new Map();
  const decorateElement = (element) => {
    element.style.setProperty = (name, value) => {
      element.style[name] = value;
    };
    element.querySelector = () => null;
    element.querySelectorAll = () => element.children;
    element.closest = () => null;
    element.insertAdjacentHTML = () => undefined;
    element.scrollHeight = 0;
    element.clientHeight = 0;
    element.scrollTop = 0;
    element.title = "";
    return element;
  };
  const getElement = (id) => {
    if (!elements.has(id)) {
      elements.set(id, decorateElement(new FakeElement(id)));
    }
    return elements.get(id);
  };

  const body = getElement("body");
  const head = getElement("head");
  const initLogs = [];
  const oauthLogs = [];
  const warnings = [];
  const normalizedCurrentUser = currentUser
    ? { get: async () => null, ...currentUser }
    : currentUser;
  const apiTarget = {
    currentUser: normalizedCurrentUser,
    sendInitLog: (message, type) => initLogs.push({ message, type }),
    logOAuthEvent: (entry) => oauthLogs.push(entry),
    stopHostMcpBridge: async () => ({ success: true }),
    stopHostMcpo: async () => ({ success: true }),
    dockerStop: async () => ({ success: true }),
    setLoadingWindowLogsDrawerOpen: async () => undefined,
  };
  const electronAPI = new Proxy(apiTarget, {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property === "string" && property.startsWith("on")) {
        return () => undefined;
      }
      return async () => undefined;
    },
  });

  const context = {
    AbortController,
    Blob,
    Date,
    Error,
    JSON,
    Math,
    Promise,
    RegExp,
    Set,
    URL,
    clearInterval: () => undefined,
    clearTimeout,
    console: {
      error: (...values) => warnings.push(values.join(" ")),
      log: () => undefined,
      warn: (...values) => warnings.push(values.join(" ")),
    },
    document: {
      body,
      head,
      createElement: (tag) => decorateElement(new FakeElement(tag)),
      getElementById: getElement,
      querySelector: (selector) => getElement(selector),
      querySelectorAll: () => [],
    },
    setTimeout,
    window: {
      addEventListener: () => undefined,
      clearInterval: () => undefined,
      electronAPI,
      requestAnimationFrame: (callback) => callback(),
      setInterval: () => 1,
      setTimeout,
    },
  };
  context.globalThis = context;

  const source = `${fs.readFileSync(loadingPath, "utf8")}\n` +
    `globalThis.__loadingAuthTest = {\n` +
    `  formatCurrentUserAuthError,\n` +
    `  syncCurrentUserStatusFromMain,\n` +
    `  runCurrentUserAuthGate,\n` +
    `};\n`;
  vm.runInNewContext(source, context, { filename: loadingPath });

  return {
    apiTarget,
    elements,
    initLogs,
    oauthLogs,
    warnings,
    auth: context.__loadingAuthTest,
    combinedOutput() {
      const elementOutput = [...elements.values()].flatMap((element) => [
        element.textContent,
        element.innerHTML,
        ...element.children.flatMap((child) => [child.textContent, child.innerHTML]),
      ]);
      return JSON.stringify({
        warnings,
        initLogs,
        oauthLogs,
        elementOutput,
      });
    },
  };
}

test("loading auth status failures persist only fixed copy", async () => {
  let statusCalls = 0;
  const harness = createLoadingHarness({
    clearError: async () => null,
    ensureAuthenticated: async () => ({ success: false }),
    status: async () => {
      statusCalls += 1;
      if (statusCalls === 1) {
        throw new Error("/Users/example/private-status.json STATUS_PRIVATE");
      }
      return {
        phase: "error",
        errorCode: "setup_auth_failed",
        error: "/Users/example/private-session.bin SESSION_PRIVATE",
      };
    },
  });

  assert.equal(await harness.auth.syncCurrentUserStatusFromMain(), null);
  await harness.auth.syncCurrentUserStatusFromMain();

  const output = harness.combinedOutput();
  assert.match(
    output,
    /Failed to read current-user status \(status_unavailable\)/,
  );
  assert.match(output, /Login failed\. Please try again\./);
  assert.doesNotMatch(
    output,
    /Users|STATUS_PRIVATE|SESSION_PRIVATE|private-status|private-session/,
  );
});

test("loading auth gate contains rejected calls and resolved private failures", async () => {
  const harness = createLoadingHarness({
    clearError: async () => {
      throw new Error("/Users/example/private-clear.json CLEAR_PRIVATE");
    },
    status: async () => {
      throw new Error("/Users/example/private-status.json STATUS_PRIVATE");
    },
    ensureAuthenticated: async () => ({
      success: false,
      authenticated: false,
      errorCode: "identity_sync_failed",
      error: "/Users/example/private-token.json TOKEN_PRIVATE",
    }),
  });

  assert.equal(await harness.auth.runCurrentUserAuthGate(), false);
  assert.equal(
    harness.elements.get("task-auth").classList.contains("failed"),
    true,
  );
  assert.equal(
    harness.elements.get("recovery-buttons").classList.contains("visible"),
    true,
  );

  const output = harness.combinedOutput();
  assert.match(output, /clear_error_failed/);
  assert.match(output, /status_unavailable/);
  assert.match(
    output,
    /The signed-in account could not be saved locally\. Try again\./,
  );
  assert.doesNotMatch(
    output,
    /Users|CLEAR_PRIVATE|STATUS_PRIVATE|TOKEN_PRIVATE|private-clear|private-status|private-token/,
  );
});

test("loading token-exchange copy is fixed and ignores provider text", () => {
  const harness = createLoadingHarness({
    clearError: async () => null,
    status: async () => ({}),
    ensureAuthenticated: async () => ({}),
  });
  const message = harness.auth.formatCurrentUserAuthError({
    errorCode: "token_exchange_failed",
    error: "employee@example.com /Users/example/private.txt PRIVATE_TOKEN",
  });

  assert.equal(
    message,
    "Okta rejected the final sign-in step. Try again once; if it keeps failing, contact support.",
  );
  assert.doesNotMatch(message, /employee|Users|PRIVATE_TOKEN/);
  assert.equal(
    harness.auth.formatCurrentUserAuthError({
      errorCode: "missing_refresh_token",
      error: "/Users/example/private-refresh-message",
    }),
    "The saved Okta login could not be refreshed. Sign in again.",
  );
});

// ---------------------------------------------------------------------------
// PORTICO-414: the startup gate heals an email-less session (silent backfill →
// identity-repair sign-in → terminal fixed error) with no re-auth loop.
// ---------------------------------------------------------------------------

const EMAIL_UNAVAILABLE_COPY =
  "Sign-in finished, but your account did not provide an email address, which this app requires. Retry login; if it keeps happening, contact support.";

const authenticatedResult = (email) => ({
  success: true,
  authenticated: true,
  sessionSummary: { user: { id: "jdoe", name: "Jane Doe", email } },
});

test("gate repairs an email-less session silently and completes without any sign-in UI", async () => {
  const identities = [authenticatedResult(null), authenticatedResult("jdoe@example.invalid")];
  let repairCalls = 0;
  let ensureCalls = 0;
  const harness = createLoadingHarness({
    clearError: async () => null,
    status: async () => ({}),
    get: async () => identities.shift() || authenticatedResult("jdoe@example.invalid"),
    repairIdentity: async () => {
      repairCalls += 1;
      return { authenticated: true, repaired: true };
    },
    ensureAuthenticated: async () => {
      ensureCalls += 1;
      return authenticatedResult("jdoe@example.invalid");
    },
  });
  const guidedSetupLaunches = [];
  harness.apiTarget.launchGuidedSetupFromInit = (payload) => {
    guidedSetupLaunches.push(payload);
  };

  assert.equal(await harness.auth.runCurrentUserAuthGate(), true);
  assert.equal(repairCalls, 1);
  assert.equal(ensureCalls, 0, "no interactive sign-in for a silent heal");
  assert.deepEqual(guidedSetupLaunches, []);
  assert.equal(
    harness.elements.get("task-auth").classList.contains("completed"),
    true,
  );
});

test("gate falls back to the identity-repair sign-in when the silent backfill cannot find an email", async () => {
  let ensureCalls = 0;
  const harness = createLoadingHarness({
    clearError: async () => null,
    status: async () => ({}),
    get: async () => authenticatedResult(null),
    repairIdentity: async () => ({
      authenticated: true,
      repaired: false,
      emailUnavailable: true,
      terminal: false,
    }),
    ensureAuthenticated: async () => {
      ensureCalls += 1;
      return authenticatedResult("jdoe@example.invalid");
    },
  });
  const guidedSetupLaunches = [];
  harness.apiTarget.launchGuidedSetupFromInit = (payload) => {
    guidedSetupLaunches.push(payload);
  };

  assert.equal(await harness.auth.runCurrentUserAuthGate(), false);
  assert.equal(guidedSetupLaunches.length, 1);
  assert.equal(guidedSetupLaunches[0].setupMode, "identity_repair");
  assert.equal(guidedSetupLaunches[0].setupReason, "session-email-missing");
  assert.equal(guidedSetupLaunches[0].safeErrorCode, "SETUP_IDENTITY_LOGIN_REQUIRED");
  assert.equal(ensureCalls, 0, "the guided-setup window owns the sign-in, not the gate");
});

test("gate lands in the fixed terminal error when a fresh sign-in already failed to yield an email", async () => {
  let ensureCalls = 0;
  const harness = createLoadingHarness({
    clearError: async () => null,
    status: async () => ({}),
    get: async () => authenticatedResult(null),
    repairIdentity: async () => ({
      authenticated: true,
      repaired: false,
      emailUnavailable: true,
      terminal: true,
    }),
    ensureAuthenticated: async () => {
      ensureCalls += 1;
      return authenticatedResult(null);
    },
  });
  const guidedSetupLaunches = [];
  harness.apiTarget.launchGuidedSetupFromInit = (payload) => {
    guidedSetupLaunches.push(payload);
  };

  assert.equal(await harness.auth.runCurrentUserAuthGate(), false);
  assert.deepEqual(guidedSetupLaunches, [], "no re-auth loop after a terminal repair");
  assert.equal(ensureCalls, 0);
  assert.equal(
    harness.elements.get("task-auth").classList.contains("failed"),
    true,
  );
  assert.equal(
    harness.elements.get("recovery-buttons").classList.contains("visible"),
    true,
  );
  assert.match(harness.combinedOutput(), new RegExp(
    EMAIL_UNAVAILABLE_COPY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ));
});

test("a fresh interactive sign-in that yields no email fails the gate once with the fixed copy", async () => {
  let ensureCalls = 0;
  const harness = createLoadingHarness({
    clearError: async () => null,
    status: async () => ({}),
    get: async () => ({ authenticated: false }),
    ensureAuthenticated: async () => {
      ensureCalls += 1;
      return authenticatedResult(null);
    },
  });

  assert.equal(await harness.auth.runCurrentUserAuthGate(), false);
  assert.equal(ensureCalls, 1, "exactly one sign-in attempt per gate run");
  assert.match(harness.combinedOutput(), new RegExp(
    EMAIL_UNAVAILABLE_COPY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ));
});
