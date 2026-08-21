const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildWorkspaceFileUrl,
  encodeWorkspaceUrlSegment,
} = require("./chat-workspaces");

test("encodeWorkspaceUrlSegment percent-encodes markdown-sensitive filename characters", () => {
  assert.equal(
    encodeWorkspaceUrlSegment("diagram (v2)#1%.md"),
    "diagram%20%28v2%29%231%25.md",
  );
  assert.equal(encodeWorkspaceUrlSegment("résumé.md"), "r%C3%A9sum%C3%A9.md");
});

test("buildWorkspaceFileUrl preserves workspace separators while encoding each segment", () => {
  assert.equal(
    buildWorkspaceFileUrl({
      host: "localhost",
      port: 9876,
      chatId: "chat-123",
      filePath: "output/reports/Agg Disco Pipeline 2025 Overview (v2)#1%.md",
    }),
    "http://localhost:9876/workspace/chat-123/output/reports/Agg%20Disco%20Pipeline%202025%20Overview%20%28v2%29%231%25.md",
  );
});

test("buildWorkspaceFileUrl rejects missing inputs", () => {
  assert.throws(() => buildWorkspaceFileUrl({ filePath: "output/report.md" }), /chatId is required/);
  assert.throws(() => buildWorkspaceFileUrl({ chatId: "chat-123" }), /filePath is required/);
});
