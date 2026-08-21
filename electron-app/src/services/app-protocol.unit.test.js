const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  APP_ORIGIN,
  APP_PAGE_FILES,
  APP_SCHEME,
  buildAppPageUrl,
  installAppProtocol,
  isAllowedBundlePath,
  loadAppPage,
  parseBundleRequestPath,
  registerAppScheme,
  resolveBundleFilePath,
} = require("./app-protocol");

function createProtocolHarness() {
  let registeredScheme = null;
  let handler = null;
  return {
    protocol: {
      isProtocolHandled: () => false,
      handle(scheme, nextHandler) {
        registeredScheme = scheme;
        handler = nextHandler;
      },
    },
    get registeredScheme() {
      return registeredScheme;
    },
    get handler() {
      return handler;
    },
  };
}

test("registerAppScheme grants only the required renderer privileges", () => {
  let registrations = null;
  registerAppScheme({
    registerSchemesAsPrivileged(value) {
      registrations = value;
    },
  });

  assert.deepEqual(registrations, [
    {
      scheme: "app",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
      },
    },
  ]);
});

test("buildAppPageUrl creates a stable app origin and preserves query values", () => {
  const url = new URL(
    buildAppPageUrl("conversation-window.html", {
      query: {
        conversationId: "chat/123",
        url: "http://localhost:3789/c/abc?x=1#message",
        title: "A title with spaces",
        repeated: ["one", "two"],
        omitted: null,
      },
    }),
  );

  assert.equal(`${url.protocol}//${url.host}`, APP_ORIGIN);
  assert.equal(url.pathname, "/src/renderer/views/conversation-window.html");
  assert.equal(url.searchParams.get("conversationId"), "chat/123");
  assert.equal(
    url.searchParams.get("url"),
    "http://localhost:3789/c/abc?x=1#message",
  );
  assert.equal(url.searchParams.get("title"), "A title with spaces");
  assert.deepEqual(url.searchParams.getAll("repeated"), ["one", "two"]);
  assert.equal(url.searchParams.has("omitted"), false);
  assert.throws(
    () => buildAppPageUrl("../services/main.js"),
    /Unknown application page/,
  );
});

test("bundle allowlist contains every declared shell page and required assets", () => {
  assert.equal(APP_PAGE_FILES.length, 8);
  for (const page of APP_PAGE_FILES) {
    assert.equal(
      isAllowedBundlePath(`src/renderer/views/${page}`),
      true,
      page,
    );
  }

  assert.equal(isAllowedBundlePath("src/styles.css"), true);
  assert.equal(isAllowedBundlePath("assets/icon-light.png"), true);
  assert.equal(isAllowedBundlePath("src/utils/build-info.js"), true);
  assert.equal(isAllowedBundlePath("src/services/manager.js"), true);
  assert.equal(isAllowedBundlePath("src/services/main.js"), false);
  assert.equal(isAllowedBundlePath("../package.json"), false);
  assert.equal(
    isAllowedBundlePath("src/renderer/views/../../services/main.js"),
    false,
  );
  assert.equal(isAllowedBundlePath("src/renderer//views/index.html"), false);
});

test("bundle request parsing rejects malformed and traversing paths", () => {
  assert.deepEqual(
    parseBundleRequestPath("/src/renderer/views/index.html"),
    {
      ok: true,
      relativePath: "src/renderer/views/index.html",
    },
  );
  assert.equal(parseBundleRequestPath("/%E0%A4%A").status, 400);
  assert.equal(
    parseBundleRequestPath("/src%2Frenderer%2F..%2Fservices%2Fmain.js")
      .status,
    403,
  );
  assert.equal(parseBundleRequestPath("/src%5Cservices%5Cmain.js").status, 400);
  assert.equal(parseBundleRequestPath("/src/services/main.js").status, 403);
});

test("bundle file resolution remains inside the application root", () => {
  const root = path.resolve("/tmp/portico-app");
  assert.equal(
    resolveBundleFilePath(root, "src/renderer/views/index.html"),
    path.join(root, "src", "renderer", "views", "index.html"),
  );
  assert.equal(resolveBundleFilePath(root, "../outside.txt"), null);
  assert.equal(resolveBundleFilePath(root, ""), null);
});

test("installed protocol serves allowed resources through net.fetch", async () => {
  const harness = createProtocolHarness();
  const fetchCalls = [];
  installAppProtocol({
    protocol: harness.protocol,
    net: {
      async fetch(url, options) {
        fetchCalls.push({ url, options });
        return new Response("ok", { status: 200 });
      },
    },
    appRoot: "/tmp/app.asar",
  });

  assert.equal(harness.registeredScheme, APP_SCHEME);
  const response = await harness.handler({
    method: "GET",
    url: "app://bundle/src/renderer/views/index.html?cache=1",
  });

  assert.equal(response.status, 200);
  assert.equal(fetchCalls.length, 1);
  assert.equal(
    fetchCalls[0].url,
    "file:///tmp/app.asar/src/renderer/views/index.html",
  );
  assert.deepEqual(fetchCalls[0].options, { method: "GET" });

  const headResponse = await harness.handler({
    method: "HEAD",
    url: "app://bundle/src/renderer/views/index.html",
  });
  assert.equal(headResponse.status, 200);
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(fetchCalls[1].options, { method: "HEAD" });
});

test("installed protocol fails closed for invalid requests and missing files", async () => {
  const harness = createProtocolHarness();
  installAppProtocol({
    protocol: harness.protocol,
    net: {
      async fetch() {
        throw new Error("ERR_FILE_NOT_FOUND");
      },
    },
    appRoot: "/tmp/app.asar",
    logger: { warn() {} },
  });

  const scenarios = [
    {
      request: {
        method: "POST",
        url: "app://bundle/src/renderer/views/index.html",
      },
      status: 405,
    },
    {
      request: {
        method: "GET",
        url: "app://other/src/renderer/views/index.html",
      },
      status: 404,
    },
    {
      request: {
        method: "GET",
        url: "app://bundle/src%2Frenderer%2F..%2Fservices%2Fmain.js",
      },
      status: 403,
    },
    {
      request: {
        method: "GET",
        url: "app://bundle/src/services/main.js",
      },
      status: 403,
    },
    {
      request: {
        method: "GET",
        url: "app://bundle/src/renderer/views/missing.html",
      },
      status: 404,
    },
  ];

  for (const { request, status } of scenarios) {
    const response = await harness.handler(request);
    assert.equal(response.status, status, request.url);
  }
});

test("loadAppPage reports main-frame failures with the app URL", async () => {
  const webContents = new EventEmitter();
  const failures = [];
  const windowRef = {
    webContents,
    async loadURL(url) {
      webContents.emit(
        "did-fail-load",
        {},
        -6,
        "ERR_FILE_NOT_FOUND",
        url,
        true,
      );
      throw new Error("ERR_FILE_NOT_FOUND");
    },
  };

  await assert.rejects(
    loadAppPage(windowRef, "loading.html", {
      logger: { error() {} },
      onFailure: (details) => failures.push(details),
    }),
    /ERR_FILE_NOT_FOUND/,
  );

  assert.equal(failures.length, 1);
  assert.equal(
    failures[0].url,
    "app://bundle/src/renderer/views/loading.html",
  );
  assert.equal(failures[0].didFailLoad.errorCode, -6);
  assert.equal(webContents.listenerCount("did-fail-load"), 0);
});
