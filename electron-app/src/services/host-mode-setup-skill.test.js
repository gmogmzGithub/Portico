const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SKILL_DIR = path.join(REPO_ROOT, "skills/host-mode-setup");
const SKILL_MD = path.join(SKILL_DIR, "SKILL.md");

function frontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "expected SKILL.md frontmatter");
  return match[1];
}

test("host-mode-setup skill is bundled with cache-busted 1.0.1 installer instructions", () => {
  const markdown = fs.readFileSync(SKILL_MD, "utf8");

  assert.match(markdown, /name: host-mode-setup/);
  assert.match(markdown, /versions\/1\.0\.1\/install-host-mode-deps\.sh\?t=\$\(date \+%s\)/);
  assert.match(markdown, /mcp_assistant_toggle_integration/);
  assert.match(markdown, /mcp_assistant_restart_mcp_server/);
  assert.match(markdown, /mcp_assistant_get_mcp_server_logs/);
  assert.match(markdown, /mcp_assistant_activate_integration/);
  assert.match(markdown, /https:\/\/example\.com/);
  assert.match(markdown, /skills_get_skill_assets/);
  assert.match(markdown, /Allow remote debugging\?/);
  assert.match(markdown, /URL-based `markdown_image`/);
  assert.doesNotMatch(markdown, /data:image/);
  assert.doesNotMatch(markdown, /base64/i);
  assert.doesNotMatch(markdown, /fallback/i);
});

test("host-mode-setup skill does not require Chrome DevTools for activation", () => {
  const metadata = frontmatter(fs.readFileSync(SKILL_MD, "utf8"));

  assert.doesNotMatch(metadata, /required_mcp_servers/);
  assert.doesNotMatch(metadata, /server:chrome-devtools/);
});

test("host-mode-setup skill ships stable PNG setup assets", () => {
  const expectedAssets = [
    "01-open-spotlight.png",
    "02-open-terminal.png",
    "03-paste-installer-command.png",
    "04-sudo-password.png",
    "05-allow-remote-debugging.png",
  ];

  for (const assetName of expectedAssets) {
    const assetPath = path.join(SKILL_DIR, "assets", assetName);
    const bytes = fs.readFileSync(assetPath);
    assert.ok(bytes.length > 32, `${assetName} should not be empty`);
    assert.deepEqual(
      Array.from(bytes.subarray(0, 8)),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${assetName} should be a PNG`,
    );
  }
});
