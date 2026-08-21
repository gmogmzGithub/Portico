const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXPECTED_SERVERS = {
  "a11y-mcp": {
    displayName: "A11y MCP",
    url: "https://a11y-mcp.sandbox.example.invalid/mcp",
    iconSha256:
      "9f78a43e180fe38b38b1859951b123041736af78e7db48a41a9f25495f3f779c",
    oauth: null,
  },
  "content-design-mcp": {
    displayName: "Content Design MCP",
    url: "https://content-design-mcp.sandbox.example.invalid/mcp",
    iconSha256:
      "0f7f643f320005a0646ee802dc17d9acbfd385dfb117ce517f05da67fa90b0f0",
    oauth: null,
  },
  "design-system-mcp": {
    displayName: "Design System MCP",
    url: "https://mcp.example.invalid/design-system-mcp/mcp",
    iconSha256:
      "1c9cb0836c6f9e8e0cc432766f2337ceb51d4d2abb11c1129f51469c0530c0ee",
    oauth: {
      type: "dcr",
      provider: "design-system-mcp",
      requires_user_authorization: true,
      server_url: "https://mcp.example.invalid",
    },
  },
};
const SAFE_PNG_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function parsePng(buffer, label) {
  assert.deepEqual(
    buffer.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    `${label} must have a PNG signature`,
  );
  let offset = 8;
  let width = null;
  let height = null;
  const chunks = [];

  while (offset < buffer.length) {
    assert.ok(offset + 12 <= buffer.length, `${label} has a truncated chunk`);
    const length = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    assert.ok(chunkEnd <= buffer.length, `${label} has an invalid chunk length`);
    const chunkType = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    assert.ok(
      SAFE_PNG_CHUNKS.has(chunkType),
      `${label} contains non-rendering metadata chunk ${chunkType}`,
    );
    chunks.push(chunkType);
    if (chunkType === "IHDR") {
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
    }
    offset = chunkEnd;
    if (chunkType === "IEND") break;
  }

  assert.equal(offset, buffer.length, `${label} has trailing data`);
  assert.equal(chunks[0], "IHDR");
  assert.equal(chunks.at(-1), "IEND");
  assert.ok(chunks.includes("IDAT"));
  return { width, height, chunks };
}

test("UX MCP bundles ship exact metadata, setup guides, and sanitized custom logos", () => {
  const iconHashes = new Set();

  for (const [serverId, expected] of Object.entries(EXPECTED_SERVERS)) {
    const serverRoot = path.join(REPO_ROOT, "mcp-configs", serverId);
    assert.deepEqual(
      fs.readdirSync(serverRoot).sort(),
      [
        `${serverId}.fragment`,
        `${serverId}.md`,
        `${serverId}.png`,
        `${serverId}.yaml`,
      ].sort(),
      `${serverId} must contain only its four bundled assets`,
    );

    const metadata = yaml.load(
      fs.readFileSync(path.join(serverRoot, `${serverId}.yaml`), "utf8"),
    );
    const fragment = JSON.parse(
      fs.readFileSync(path.join(serverRoot, `${serverId}.fragment`), "utf8"),
    );
    const setup = fs.readFileSync(
      path.join(serverRoot, `${serverId}.md`),
      "utf8",
    );
    const icon = fs.readFileSync(path.join(serverRoot, `${serverId}.png`));

    assert.equal(metadata.id, serverId);
    assert.equal(metadata.display_name, expected.displayName);
    assert.equal(metadata.deployment_type, "docker");
    assert.equal(metadata.user_installed, false);
    assert.equal(metadata.is_core, false);
    assert.deepEqual(metadata.required_env_vars, []);
    assert.equal(fragment.type, "streamable-http");
    assert.equal(fragment.url, expected.url);
    assert.match(setup, new RegExp(expected.displayName.replaceAll(" ", "\\s+"), "i"));
    assert.match(setup, /<success message=/);

    if (expected.oauth) {
      assert.deepEqual(metadata.oauth, {
        type: expected.oauth.type,
        provider: expected.oauth.provider,
        requires_user_authorization:
          expected.oauth.requires_user_authorization,
      });
      assert.deepEqual(fragment.oauth, {
        server_url: expected.oauth.server_url,
      });
    } else {
      assert.equal(metadata.oauth, undefined);
      assert.equal(fragment.oauth, undefined);
    }

    assert.equal(sha256(icon), expected.iconSha256);
    iconHashes.add(expected.iconSha256);
    const png = parsePng(icon, `${serverId}.png`);
    assert.equal(png.width, 1024);
    assert.equal(png.height, 1024);
  }

  assert.equal(iconHashes.size, Object.keys(EXPECTED_SERVERS).length);
});
