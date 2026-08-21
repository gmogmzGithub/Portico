const path = require("node:path");

const CHAT_EXPORT_TYPES = Object.freeze({
  pdf: Object.freeze({
    kind: "pdf",
    extension: ".pdf",
    filterName: "PDF document",
    filterExtensions: ["pdf"],
    title: "Save Chat PDF",
  }),
  text: Object.freeze({
    kind: "text",
    extension: ".txt",
    filterName: "Plain text",
    filterExtensions: ["txt"],
    title: "Save Chat Text",
  }),
  json: Object.freeze({
    kind: "json",
    extension: ".json",
    filterName: "Export chat",
    filterExtensions: ["json"],
    title: "Export Chat JSON",
  }),
});

function normalizeString(value) {
  return typeof value === "string" ? value : "";
}

function classifyOwuiChatExportDownload({ url, filename } = {}) {
  const normalizedFilename = normalizeString(filename).trim();
  if (!normalizedFilename) {
    return null;
  }

  const normalizedUrl = normalizeString(url).trim().toLowerCase();
  if (normalizedUrl && !normalizedUrl.startsWith("blob:")) {
    return null;
  }

  const lowerCaseFilename = normalizedFilename.toLowerCase();

  if (
    lowerCaseFilename.startsWith("chat-export-") &&
    lowerCaseFilename.endsWith(CHAT_EXPORT_TYPES.json.extension)
  ) {
    return { ...CHAT_EXPORT_TYPES.json, filename: normalizedFilename };
  }

  if (
    lowerCaseFilename.startsWith("chat-") &&
    lowerCaseFilename.endsWith(CHAT_EXPORT_TYPES.pdf.extension)
  ) {
    return { ...CHAT_EXPORT_TYPES.pdf, filename: normalizedFilename };
  }

  if (
    lowerCaseFilename.startsWith("chat-") &&
    lowerCaseFilename.endsWith(CHAT_EXPORT_TYPES.text.extension)
  ) {
    return { ...CHAT_EXPORT_TYPES.text, filename: normalizedFilename };
  }

  return null;
}

function buildChatExportSaveDialogOptions({
  defaultPath,
  download,
} = {}) {
  if (!download || !download.extension) {
    throw new Error("download metadata is required");
  }

  const options = {
    title: download.title,
    defaultPath: normalizeString(defaultPath).trim() || download.filename,
    buttonLabel: "Save",
    filters: [
      {
        name: download.filterName,
        extensions: download.filterExtensions,
      },
    ],
  };

  if (process.platform === "darwin") {
    options.showsTagField = false;
    options.properties = ["createDirectory"];
  }

  return options;
}

function normalizeChatExportSavePath(savePath, expectedExtension) {
  const normalizedPath = normalizeString(savePath);
  if (!normalizedPath) {
    return normalizedPath;
  }

  const normalizedExtension = normalizeString(expectedExtension);
  if (!normalizedExtension) {
    return normalizedPath;
  }

  const existingExtension = path.extname(normalizedPath);
  if (!existingExtension) {
    return `${normalizedPath}${normalizedExtension}`;
  }

  if (existingExtension === ".") {
    return `${normalizedPath.replace(/\.+$/, "")}${normalizedExtension}`;
  }

  return normalizedPath;
}

module.exports = {
  CHAT_EXPORT_TYPES,
  classifyOwuiChatExportDownload,
  buildChatExportSaveDialogOptions,
  normalizeChatExportSavePath,
};
