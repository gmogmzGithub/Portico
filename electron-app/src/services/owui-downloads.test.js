const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CHAT_EXPORT_TYPES,
  buildChatExportSaveDialogOptions,
  classifyOwuiChatExportDownload,
  normalizeChatExportSavePath,
} = require("./owui-downloads");

test("classifyOwuiChatExportDownload identifies the supported chat export downloads", () => {
  assert.deepEqual(
    classifyOwuiChatExportDownload({
      url: "blob:http://localhost:3789/abc123",
      filename: "chat-Project recap.pdf",
    }),
    {
      ...CHAT_EXPORT_TYPES.pdf,
      filename: "chat-Project recap.pdf",
    },
  );

  assert.deepEqual(
    classifyOwuiChatExportDownload({
      url: "blob:http://localhost:3789/def456",
      filename: "chat-Project recap.txt",
    }),
    {
      ...CHAT_EXPORT_TYPES.text,
      filename: "chat-Project recap.txt",
    },
  );

  assert.deepEqual(
    classifyOwuiChatExportDownload({
      url: "blob:http://localhost:3789/ghi789",
      filename: "chat-export-1710782042000.json",
    }),
    {
      ...CHAT_EXPORT_TYPES.json,
      filename: "chat-export-1710782042000.json",
    },
  );
});

test("classifyOwuiChatExportDownload ignores non-chat or non-blob downloads", () => {
  assert.equal(
    classifyOwuiChatExportDownload({
      url: "http://localhost:9876/workspace/chat-id/output/report.pdf",
      filename: "chat-report.pdf",
    }),
    null,
  );

  assert.equal(
    classifyOwuiChatExportDownload({
      url: "blob:http://localhost:3789/workspace-file",
      filename: "artifact-report.pdf",
    }),
    null,
  );

  assert.equal(
    classifyOwuiChatExportDownload({
      filename: "",
    }),
    null,
  );
});

test("buildChatExportSaveDialogOptions applies the expected single-format filter", () => {
  const options = buildChatExportSaveDialogOptions({
    defaultPath: "/Users/test/Downloads/chat-Project recap.pdf",
    download: {
      ...CHAT_EXPORT_TYPES.pdf,
      filename: "chat-Project recap.pdf",
    },
  });

  assert.equal(options.title, "Save Chat PDF");
  assert.equal(
    options.defaultPath,
    "/Users/test/Downloads/chat-Project recap.pdf",
  );
  assert.equal(options.buttonLabel, "Save");
  assert.deepEqual(options.filters, [
    {
      name: "PDF document",
      extensions: ["pdf"],
    },
  ]);
});

test("normalizeChatExportSavePath appends the expected extension only when it is missing", () => {
  assert.equal(
    normalizeChatExportSavePath("/tmp/report", ".pdf"),
    "/tmp/report.pdf",
  );
  assert.equal(
    normalizeChatExportSavePath("/tmp/report.", ".pdf"),
    "/tmp/report.pdf",
  );
  assert.equal(
    normalizeChatExportSavePath("/tmp/report.txt", ".pdf"),
    "/tmp/report.txt",
  );
  assert.equal(
    normalizeChatExportSavePath("/tmp/report.PDF", ".pdf"),
    "/tmp/report.PDF",
  );
});
