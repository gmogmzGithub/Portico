const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildDockerImagesToPull,
  buildFallbackHarborImageSpecs,
  canonicalizeComposeImagesToHarbor,
  resolveRuntimeModes,
  HARBOR_IMAGE_BASE,
  SHIPPED_HARBOR_IMAGE_NAMES,
} = require("./docker-image-plan");

function withTempProject(files, fn) {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "docker-image-plan-test-"),
  );
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const targetPath = path.join(tempDir, relativePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, content, "utf8");
    }
    return fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("resolveRuntimeModes ignores stale runtime files and returns shipped rust and bifrost defaults", () => {
  withTempProject(
    {
      ".env": "MCP_ORC_MODE=old\nLLM_GATEWAY_MODE=old\n",
      ".env.runtime": "MCP_ORC_MODE=old\nLLM_GATEWAY_MODE=old\n",
    },
    (projectRoot) => {
      assert.deepEqual(resolveRuntimeModes(projectRoot), {
        mcpMode: "rust-full",
        llmGatewayMode: "bifrost",
      });
    },
  );
});

test("buildFallbackHarborImageSpecs returns the shipped rust-only and bifrost-only allowlist", () => {
  const images = buildFallbackHarborImageSpecs({
    tag: "03082026-abc12345",
    mcpMode: "rust-full",
    llmGatewayMode: "bifrost",
  });

  const refs = new Set(images.map((image) => `${image.name}:${image.tag}`));
  assert.equal(refs.size, SHIPPED_HARBOR_IMAGE_NAMES.length);
  for (const imageName of SHIPPED_HARBOR_IMAGE_NAMES) {
    assert(refs.has(`harbor.example.invalid/portico/${imageName}:03082026-abc12345`));
  }
  assert(!refs.has("harbor.example.invalid/portico/mcpo:03082026-abc12345"));
});

test("canonicalizeComposeImagesToHarbor maps current local runtime aliases to harbor refs", () => {
  const images = canonicalizeComposeImagesToHarbor(
    [
      "portico-mcp-orc-rust:latest",
      "portico-mcpo-control-plane-rust:latest",
      "portico-bifrost-bridge:latest",
      "portico-open-webui:latest",
    ],
    "03082026-abc12345",
  );

  const refs = new Set(images.map((image) => `${image.name}:${image.tag}`));
  assert(refs.has("harbor.example.invalid/portico/mcp-orc-rust:03082026-abc12345"));
  assert(refs.has("harbor.example.invalid/portico/mcpo-control-plane-rust:03082026-abc12345"));
  assert(refs.has("harbor.example.invalid/portico/bifrost-bridge:03082026-abc12345"));
  assert(refs.has("harbor.example.invalid/portico/open-webui-patched:03082026-abc12345"));
  assert.equal(
    images.filter((image) => image.name === "harbor.example.invalid/portico/bifrost-bridge").length,
    1,
  );
});

test("buildDockerImagesToPull returns community images plus the shipped runtime allowlist", () => {
  withTempProject(
    {
      ".env.runtime": "MCP_ORC_MODE=rust-full\nLLM_GATEWAY_MODE=bifrost\n",
      "docker-compose.harbor.yml": [
        "services:",
        "  mcpo:",
        "    image: portico-mcpo-control-plane-rust:latest",
        "  mcpo-google_workspace:",
        "    image: portico-mcp-orc-rust:latest",
        "  llm-gateway:",
        "    image: portico-bifrost-bridge:latest",
        "  open-webui:",
        "    image: portico-open-webui:latest",
      ].join("\n"),
    },
    (projectRoot) => {
      const images = buildDockerImagesToPull({
        projectRoot,
        tag: "03082026-abc12345",
      });

      const refs = new Set(images.map((image) => `${image.name}:${image.tag}`));
      assert(refs.has("redis:7-alpine"));
      assert(refs.has("mongo:7"));
      assert(refs.has("nginx:alpine"));
      for (const imageName of SHIPPED_HARBOR_IMAGE_NAMES) {
        assert(refs.has(`harbor.example.invalid/portico/${imageName}:03082026-abc12345`));
      }
      for (const image of images) {
        if (image.name.startsWith(`${HARBOR_IMAGE_BASE}/`)) {
          assert.notEqual(image.tag, "latest");
        }
      }
      assert(!refs.has("harbor.example.invalid/portico/mcpo:03082026-abc12345"));
    },
  );
});

test("PORTICO-231: the build-tagged Agent VM image is always in the update pull plan even when no compose service references it", () => {
  // The Agent VM image is created on demand, so it is never a docker-compose
  // service and is never present in docker-compose.harbor.yml. If it drops out
  // of the update pull plan, an app update stops provisioning it and every VM
  // task fails once the build tag changes (PORTICO-231). This asserts the exact
  // Harbor ref independently of SHIPPED_HARBOR_IMAGE_NAMES, so removing
  // "agent-vm" from that list — which would silently reintroduce the bug on the
  // update side — fails here rather than passing an allowlist-driven loop.
  withTempProject(
    {
      "docker-compose.harbor.yml": [
        "services:",
        "  mcpo:",
        "    image: portico-mcpo-control-plane-rust:latest",
        "  open-webui:",
        "    image: portico-open-webui:latest",
      ].join("\n"),
    },
    (projectRoot) => {
      const images = buildDockerImagesToPull({
        projectRoot,
        tag: "07262026-fbd7411e",
      });
      const refs = new Set(images.map((image) => `${image.name}:${image.tag}`));
      assert(
        refs.has(
          "harbor.example.invalid/portico/agent-vm:07262026-fbd7411e",
        ),
        "update pull plan must always include the build-tagged agent-vm image",
      );
    },
  );
});
