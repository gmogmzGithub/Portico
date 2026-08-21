// Retry/timeout behavior of the AI Marketplace REST client's request().
// Everything is injected — fetchImpl, sleepImpl — no real network, no real
// sleeps. Covers the smart-slides incident class: a publish click must
// survive transient 502s, client-side timeouts, and stalled response bodies
// without the user having to hammer the button.
const test = require("node:test");
const assert = require("node:assert");

const aiMarketplaceClient = require("./ai-marketplace-client");

function fakeResponse({ status = 200, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

// The DOMException AbortSignal.timeout() rejects with: name "TimeoutError",
// legacy numeric code 23, and exactly this message.
function timeoutException() {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  error.code = 23;
  return error;
}

function sleepRecorder() {
  const sleeps = [];
  return {
    sleeps,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  };
}

function flakyFetch(failures, finalResponse) {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    if (calls <= failures.length) {
      const failure = failures[calls - 1];
      if (failure instanceof Error) throw failure;
      return fakeResponse(failure);
    }
    return finalResponse ? fakeResponse(finalResponse) : fakeResponse();
  };
  return { impl, callCount: () => calls };
}

test("GET retries a timeout and succeeds on the second attempt", async () => {
  const { sleeps, sleepImpl } = sleepRecorder();
  const { impl, callCount } = flakyFetch([timeoutException()], {
    status: 200,
    body: { ok: true },
  });
  const data = await aiMarketplaceClient.request("/api/solutions/abc", {
    apiKey: "k",
    fetchImpl: impl,
    sleepImpl,
  });
  assert.deepEqual(data, { ok: true });
  assert.equal(callCount(), 2);
  assert.deepEqual(sleeps, [1000]);
});

test("GET exhausts 3 attempts on persistent timeouts with classified error", async () => {
  const { sleeps, sleepImpl } = sleepRecorder();
  const { impl, callCount } = flakyFetch([
    timeoutException(),
    timeoutException(),
    timeoutException(),
  ]);
  await assert.rejects(
    () =>
      aiMarketplaceClient.request("/api/solutions/abc", {
        apiKey: "k",
        fetchImpl: impl,
        sleepImpl,
      }),
    (error) => {
      assert.equal(error.code, "timeout");
      assert.match(error.message, /timed out after 30000ms/);
      assert.match(error.message, /\(after 3 attempts\)$/);
      return true;
    },
  );
  assert.equal(callCount(), 3);
  assert.deepEqual(sleeps, [1000, 3000]);
});

test("search POST with retryable opt-in survives a 502 then succeeds", async () => {
  const { sleeps, sleepImpl } = sleepRecorder();
  const { impl, callCount } = flakyFetch(
    [{ status: 502, body: { error: "bad gateway" } }],
    { status: 200, body: { solutions: [] } },
  );
  const data = await aiMarketplaceClient.search(
    { query: "" },
    { apiKey: "k", retryable: true, fetchImpl: impl, sleepImpl },
  );
  assert.deepEqual(data, { solutions: [] });
  assert.equal(callCount(), 2);
  assert.deepEqual(sleeps, [1000]);
});

test("retryAttempts raises an opt-in POST to the full 3-attempt budget", async () => {
  const { sleeps, sleepImpl } = sleepRecorder();
  const { impl, callCount } = flakyFetch(
    [
      { status: 502, body: { error: "bad gateway" } },
      { status: 503, body: { error: "unavailable" } },
    ],
    { status: 200, body: { solutions: [] } },
  );
  const data = await aiMarketplaceClient.search(
    { query: "" },
    { apiKey: "k", retryable: true, retryAttempts: 3, fetchImpl: impl, sleepImpl },
  );
  assert.deepEqual(data, { solutions: [] });
  assert.equal(callCount(), 3);
  assert.deepEqual(sleeps, [1000, 3000]);
});

test("retryAttempts is clamped to the GET-grade ceiling", async () => {
  const { impl, callCount } = flakyFetch([
    { status: 502, body: {} },
    { status: 502, body: {} },
    { status: 502, body: {} },
    { status: 502, body: {} },
  ]);
  await assert.rejects(() =>
    aiMarketplaceClient.request("/api/solutions/search", {
      method: "POST",
      body: {},
      apiKey: "k",
      retryable: true,
      retryAttempts: 99,
      fetchImpl: impl,
      sleepImpl: async () => {},
    }),
  );
  assert.equal(callCount(), 3, "attempt budget never exceeds 3");
});

test("POST without the retryable opt-in gets exactly one attempt", async () => {
  const { sleeps, sleepImpl } = sleepRecorder();
  const { impl, callCount } = flakyFetch([
    { status: 502, body: { error: "bad gateway" } },
  ]);
  await assert.rejects(
    () =>
      aiMarketplaceClient.request("/api/solutions", {
        method: "POST",
        body: { name: "x" },
        apiKey: "k",
        fetchImpl: impl,
        sleepImpl,
      }),
    (error) => error.status === 502,
  );
  assert.equal(callCount(), 1);
  assert.deepEqual(sleeps, []);
});

test("non-retryable HTTP statuses never retry, even on GETs", async () => {
  for (const status of [400, 401, 404, 409]) {
    const { impl, callCount } = flakyFetch([{ status, body: { error: "no" } }]);
    await assert.rejects(
      () =>
        aiMarketplaceClient.request("/api/solutions/abc", {
          apiKey: "k",
          fetchImpl: impl,
          sleepImpl: async () => {},
        }),
      (error) => error.status === status,
    );
    assert.equal(callCount(), 1, `status ${status} must not retry`);
  }
});

test("retryable PUT re-sends after a timeout and caps at 2 attempts", async () => {
  const { sleeps, sleepImpl } = sleepRecorder();
  const okPut = flakyFetch([timeoutException()], {
    status: 200,
    body: { id: "abc" },
  });
  const data = await aiMarketplaceClient.updateSolution(
    "abc",
    { name: "x" },
    { apiKey: "k", retryable: true, fetchImpl: okPut.impl, sleepImpl },
  );
  assert.deepEqual(data, { id: "abc" });
  assert.equal(okPut.callCount(), 2);
  assert.deepEqual(sleeps, [1000]);

  const deadPut = flakyFetch([timeoutException(), timeoutException()]);
  await assert.rejects(
    () =>
      aiMarketplaceClient.updateSolution(
        "abc",
        { name: "x" },
        {
          apiKey: "k",
          retryable: true,
          fetchImpl: deadPut.impl,
          sleepImpl: async () => {},
        },
      ),
    (error) => {
      assert.equal(error.code, "timeout");
      assert.match(error.message, /\(after 2 attempts\)$/);
      return true;
    },
  );
  assert.equal(deadPut.callCount(), 2);
});

test("a stalled response body is wrapped as a timeout and retried", async () => {
  // Headers arrive, then AbortSignal.timeout kills the body stream mid-read.
  // Before the fix this leaked a raw DOMException (code 23) to callers.
  let calls = 0;
  const impl = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: true,
        status: 200,
        text: async () => {
          throw timeoutException();
        },
      };
    }
    return fakeResponse({ status: 200, body: { ok: true } });
  };
  const data = await aiMarketplaceClient.request("/api/solutions/abc", {
    apiKey: "k",
    fetchImpl: impl,
    sleepImpl: async () => {},
  });
  assert.deepEqual(data, { ok: true });
  assert.equal(calls, 2);
});

test("a stalled body on the last attempt surfaces the wrapped timeout error", async () => {
  const impl = async () => ({
    ok: true,
    status: 200,
    text: async () => {
      throw timeoutException();
    },
  });
  await assert.rejects(
    () =>
      aiMarketplaceClient.request("/api/solutions/abc", {
        apiKey: "k",
        fetchImpl: impl,
        sleepImpl: async () => {},
      }),
    (error) => {
      assert.equal(error.code, "timeout");
      assert.match(error.message, /response body timed out after 30000ms/);
      assert.match(error.message, /\(after 3 attempts\)$/);
      return true;
    },
  );
});

test("retryable: false opts a GET out of retries entirely", async () => {
  const { impl, callCount } = flakyFetch([timeoutException()]);
  await assert.rejects(
    () =>
      aiMarketplaceClient.request("/api/solutions/abc", {
        apiKey: "k",
        retryable: false,
        fetchImpl: impl,
        sleepImpl: async () => {},
      }),
    (error) => {
      assert.equal(error.code, "timeout");
      // Single attempt: no "(after N attempts)" suffix noise.
      assert.ok(!/attempts\)$/.test(error.message));
      return true;
    },
  );
  assert.equal(callCount(), 1);
});

test("per-attempt diag lines carry the attempt number", async () => {
  const captured = [];
  const origWarn = console.warn;
  console.warn = (...args) => captured.push(args);
  try {
    await assert.rejects(() =>
      aiMarketplaceClient.request("/api/solutions/abc", {
        apiKey: "k",
        fetchImpl: async () => {
          throw timeoutException();
        },
        sleepImpl: async () => {},
      }),
    );
  } finally {
    console.warn = origWarn;
  }
  const lines = captured.filter((args) =>
    String(args[0] || "").startsWith("[Marketplace][http]"),
  );
  assert.equal(lines.length, 3);
  const attempts = lines.map((args) => JSON.parse(args[1]).attempt);
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.ok(
    lines.every((args) => JSON.parse(args[1]).errorCode === "timeout"),
    "timeouts are classified as timeout, not network_error",
  );
});

test("timeoutMs override reaches the failure message", async () => {
  await assert.rejects(
    () =>
      aiMarketplaceClient.request("/api/solutions/abc", {
        apiKey: "k",
        timeoutMs: 60_000,
        retryable: false,
        fetchImpl: async () => {
          throw timeoutException();
        },
        sleepImpl: async () => {},
      }),
    (error) => {
      assert.match(error.message, /timed out after 60000ms/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// bodyBytes in the [Marketplace][http] diag (2026-08-14: a 27.6MB search
// response was only discoverable via manual curl probes — payload size must
// be answerable from logs).
// ---------------------------------------------------------------------------

function captureHttpDiags() {
  const lines = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const record = (...args) => {
    const head = String(args[0] || "");
    if (head.startsWith("[Marketplace][http]")) {
      lines.push({ head, meta: JSON.parse(String(args[1] || "{}")) });
    }
  };
  console.log = (...args) => record(...args);
  console.warn = (...args) => record(...args);
  return {
    lines,
    restore: () => {
      console.log = origLog;
      console.warn = origWarn;
    },
  };
}

test("ok diag carries the decoded body byte length", async () => {
  const body = { solutions: [{ id: "sol-1", name: "väst" }] };
  const { impl } = flakyFetch([], { status: 200, body });
  const capture = captureHttpDiags();
  try {
    await aiMarketplaceClient.request("/api/solutions/abc", {
      apiKey: "k",
      fetchImpl: impl,
    });
  } finally {
    capture.restore();
  }
  assert.equal(capture.lines.length, 1);
  assert.ok(capture.lines[0].head.includes("ok"));
  assert.equal(
    capture.lines[0].meta.bodyBytes,
    Buffer.byteLength(JSON.stringify(body), "utf8"),
  );
});

test("http-error diag carries bodyBytes; pre-headers timeout reports null", async () => {
  const errBody = { error: "bad gateway" };
  const failing = flakyFetch([
    { status: 502, body: errBody },
    { status: 502, body: errBody },
    { status: 502, body: errBody },
  ]);
  const capture = captureHttpDiags();
  try {
    await assert.rejects(() =>
      aiMarketplaceClient.request("/api/solutions/abc", {
        apiKey: "k",
        fetchImpl: failing.impl,
        sleepImpl: async () => {},
      }),
    );
  } finally {
    capture.restore();
  }
  const httpErrors = capture.lines.filter((l) => l.meta.errorCode === "http_error");
  assert.ok(httpErrors.length >= 1);
  for (const line of httpErrors) {
    assert.equal(line.meta.bodyBytes, Buffer.byteLength(JSON.stringify(errBody), "utf8"));
  }

  const timeoutFetch = flakyFetch([
    timeoutException(),
    timeoutException(),
    timeoutException(),
  ]);
  const capture2 = captureHttpDiags();
  try {
    await assert.rejects(() =>
      aiMarketplaceClient.request("/api/solutions/abc", {
        apiKey: "k",
        fetchImpl: timeoutFetch.impl,
        sleepImpl: async () => {},
      }),
    );
  } finally {
    capture2.restore();
  }
  assert.ok(capture2.lines.length >= 1);
  for (const line of capture2.lines) {
    assert.equal(line.meta.bodyBytes, null);
  }
});
