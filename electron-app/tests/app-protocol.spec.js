const { expect, test } = require("@playwright/test");
const { _electron: electron } = require("playwright");
const path = require("node:path");

const LOCAL_API_ENDPOINTS = Object.freeze([
  {
    label: "port-9876",
    url: "http://localhost:9876/app-protocol-smoke",
  },
  {
    label: "port-8765",
    url: "http://localhost:8765/app-protocol-smoke",
  },
  {
    label: "port-8766",
    url: "http://localhost:8766/app-protocol-smoke",
  },
]);

test("app://bundle loads packaged resources and retains localhost API access", async () => {
  const electronApp = await electron.launch({
    args: [
      path.join(__dirname, "fixtures", "app-protocol-smoke-main.js"),
    ],
  });

  try {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const localApiRequests = [];
    for (const endpoint of LOCAL_API_ENDPOINTS) {
      await page.route(endpoint.url, async (route) => {
        const request = route.request();
        const headers = await request.allHeaders();
        localApiRequests.push({
          method: request.method(),
          origin: headers.origin || null,
          url: request.url(),
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: {
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({ label: endpoint.label, ok: true }),
        });
      });
    }

    expect(page.url()).toMatch(
      /^app:\/\/bundle\/src\/renderer\/views\/conversation-window\.html\?/,
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    const result = await page.evaluate(async (localApiUrls) => {
      const fetchStatus = async (url) => {
        const response = await fetch(url);
        return {
          status: response.status,
          bodyLength: (await response.arrayBuffer()).byteLength,
        };
      };

      const [
        stylesheet,
        script,
        modal,
        image,
        blockedMainProcessSource,
        localApis,
      ] = await Promise.all([
        fetchStatus("/src/styles.css"),
        fetchStatus("/src/services/manager.js"),
        fetchStatus("/src/renderer/components/oauth-wizard-modal.html"),
        fetchStatus("/assets/icon-light.png"),
        fetchStatus("/src/services/main.js"),
        Promise.all(
          localApiUrls.map(async (url) => {
            const response = await fetch(url);
            return response.json();
          }),
        ),
      ]);

      await document.fonts.load('500 16px "Portico Sans"');

      return {
        origin: window.location.origin,
        stylesheet,
        script,
        modal,
        image,
        blockedMainProcessSource,
        localApis,
        linkedStylesheets: Array.from(document.styleSheets)
          .map((sheet) => sheet.href)
          .filter(Boolean),
        porticoSansLoaded: document.fonts.check('500 16px "Portico Sans"'),
      };
    }, LOCAL_API_ENDPOINTS.map((endpoint) => endpoint.url));

    expect(result.origin).toBe("app://bundle");
    expect(result.stylesheet.status).toBe(200);
    expect(result.script.status).toBe(200);
    expect(result.modal.status).toBe(200);
    expect(result.image.status).toBe(200);
    expect(result.image.bodyLength).toBeGreaterThan(0);
    expect(result.blockedMainProcessSource.status).toBe(403);
    expect(result.localApis).toEqual([
      { label: "port-9876", ok: true },
      { label: "port-8765", ok: true },
      { label: "port-8766", ok: true },
    ]);
    expect(result.linkedStylesheets).toContain("app://bundle/src/styles.css");
    expect(result.porticoSansLoaded).toBe(true);

    expect(localApiRequests).toEqual(
      LOCAL_API_ENDPOINTS.map((endpoint) => ({
        method: "GET",
        origin: "app://bundle",
        url: endpoint.url,
      })),
    );
  } finally {
    await electronApp.close();
  }
});
