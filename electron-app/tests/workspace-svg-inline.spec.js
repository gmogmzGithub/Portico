const { expect, test } = require("@playwright/test");
const { _electron: electron } = require("playwright");
const path = require("node:path");

test("workspace SVGs render inline without executing active content", async () => {
  const electronApp = await electron.launch({
    args: [path.join(__dirname, "fixtures", "workspace-svg-main.js")],
  });

  try {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const shellUrl = new URL(page.url());
    const port = shellUrl.searchParams.get("workspacePort");
    expect(port).toBeTruthy();

    const baseUrl = `http://127.0.0.1:${port}/workspace/workspace-svg-smoke`;
    const probeRequests = [];
    page.on("request", (request) => {
      if (request.url().includes("/svg-security-probe")) {
        probeRequests.push(request.url());
      }
    });

    const rendered = await page.evaluate(async ({ baseUrl }) => {
      const loadImage = (src) =>
        new Promise((resolve) => {
          const image = new Image();
          image.onload = () =>
            resolve({
              complete: image.complete,
              naturalHeight: image.naturalHeight,
              naturalWidth: image.naturalWidth,
              src,
            });
          image.onerror = () =>
            resolve({
              complete: image.complete,
              naturalHeight: image.naturalHeight,
              naturalWidth: image.naturalWidth,
              src,
            });
          document.body.append(image);
          image.src = src;
        });

      return Promise.all([
        loadImage(`${baseUrl}/valid.svg?inline=1`),
        loadImage(`${baseUrl}/valid.svg`),
        loadImage(`${baseUrl}/active-content.svg?inline=1`),
      ]);
    }, { baseUrl });

    for (const image of rendered) {
      expect(image.complete).toBe(true);
      expect(image.naturalWidth).toBeGreaterThan(0);
      expect(image.naturalHeight).toBeGreaterThan(0);
    }

    await page.waitForTimeout(250);
    expect(probeRequests).toEqual([]);

    const directResponse = await fetch(`${baseUrl}/valid.svg`);
    expect(directResponse.status).toBe(200);
    expect(directResponse.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
    expect(directResponse.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(directResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(directResponse.headers.get("content-security-policy")).toBeNull();
    await directResponse.arrayBuffer();

    const inlineResponse = await fetch(`${baseUrl}/valid.svg?inline=1`);
    expect(inlineResponse.status).toBe(200);
    expect(inlineResponse.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(inlineResponse.headers.get("content-security-policy")).toContain(
      "script-src 'none'",
    );
    expect(inlineResponse.headers.get("content-security-policy")).toContain(
      "img-src data:",
    );
    await inlineResponse.arrayBuffer();
  } finally {
    await electronApp.close();
  }
});
