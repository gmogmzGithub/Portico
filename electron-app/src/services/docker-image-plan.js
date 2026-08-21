const fs = require("fs");
const path = require("path");

const COMMUNITY_DOCKER_IMAGES_TO_PULL = [
  { name: "redis", tag: "7-alpine", label: "Redis Cache" },
  { name: "mongo", tag: "7", label: "MongoDB" },
  { name: "nginx", tag: "alpine", label: "Nginx" },
];

const HARBOR_IMAGE_BASE = "harbor.example.invalid/portico";
const EXCLUDED_HARBOR_IMAGE_NAMES = new Set([
  "openapi-aggregator",
  "openapi-aggregator-rust",
]);
const SHIPPED_HARBOR_IMAGE_NAMES = [
  "mcpo-control-plane-rust",
  "mcp-orc-rust",
  "bifrost-bridge",
  "open-webui-patched",
  "health-check",
  "chat-state-api",
  "agent-vm",
];
const SHIPPED_HARBOR_IMAGE_NAME_SET = new Set(SHIPPED_HARBOR_IMAGE_NAMES);

const HARBOR_IMAGE_LABELS = {
  "mcpo-control-plane-rust": "MCP Control Plane",
  "mcp-orc-rust": "MCP Runtime",
  "open-webui-patched": "Open WebUI",
  "health-check": "Health Check",
  "bifrost-bridge": "LLM Gateway",
  "chat-state-api": "Chat State API",
  "agent-vm": "Agent VM",
};

const LOCAL_IMAGE_ALIASES = {
  "portico-mcpo-control-plane-rust": "mcpo-control-plane-rust",
  "portico-mcp-orc-rust": "mcp-orc-rust",
  "portico-open-webui": "open-webui-patched",
  "portico-health-check": "health-check",
  "portico-bifrost-bridge": "bifrost-bridge",
  "portico-chat-state-api": "chat-state-api",
  "agent-vm": "agent-vm",
};

function normalizeMcpMode(value) {
  void value;
  return "rust-full";
}

function normalizeGatewayMode(value) {
  void value;
  return "bifrost";
}

function resolveRuntimeModes(projectRoot, env = process.env) {
  void projectRoot;
  void env;
  const mcpMode = normalizeMcpMode();
  const llmGatewayMode = normalizeGatewayMode();
  return { mcpMode, llmGatewayMode };
}

function harborImageSpec(imageName, tag = "latest") {
  return {
    name: `${HARBOR_IMAGE_BASE}/${imageName}`,
    tag,
    label:
      HARBOR_IMAGE_LABELS[imageName] ||
      `Portico ${imageName.replace(/-/g, " ")}`,
  };
}

function buildFallbackHarborImageSpecs({
  tag = "latest",
  mcpMode = "rust-full",
  llmGatewayMode = "bifrost",
}) {
  void mcpMode;
  void llmGatewayMode;

  return SHIPPED_HARBOR_IMAGE_NAMES
    .filter((imageName) => !EXCLUDED_HARBOR_IMAGE_NAMES.has(imageName))
    .map((imageName) => harborImageSpec(imageName, tag));
}

function parseServiceImagesFromCompose(filePaths) {
  const serviceImages = new Map();

  for (const filePath of filePaths) {
    if (!filePath || !fs.existsSync(filePath)) {
      continue;
    }

    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    let inServices = false;
    let currentService = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const indent = line.length - line.trimStart().length;

      if (indent === 0 && trimmed === "services:") {
        inServices = true;
        currentService = null;
        continue;
      }

      if (indent === 0 && inServices && /^[A-Za-z0-9_.-]+:\s*$/.test(trimmed)) {
        inServices = false;
        currentService = null;
      }

      if (!inServices) {
        continue;
      }

      if (indent === 2 && /^[A-Za-z0-9_.-]+:\s*$/.test(trimmed)) {
        currentService = trimmed.slice(0, -1);
        continue;
      }

      if (
        currentService &&
        indent >= 4 &&
        /^image:\s*/.test(trimmed)
      ) {
        const rawValue = trimmed.replace(/^image:\s*/, "");
        const image = rawValue.replace(/^["']|["']$/g, "");
        if (image) {
          serviceImages.set(currentService, image);
        }
      }
    }
  }

  return Array.from(serviceImages.values());
}

function imageBaseName(imageRef) {
  if (!imageRef || typeof imageRef !== "string") {
    return "";
  }

  const withoutDigest = imageRef.split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const namePart =
    lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
  return namePart.split("/").pop() || "";
}

function canonicalHarborImageName(imageRef) {
  const baseName = imageBaseName(imageRef);
  if (!baseName) {
    return null;
  }

  if (
    EXCLUDED_HARBOR_IMAGE_NAMES.has(baseName)
  ) {
    return null;
  }

  if (imageRef.startsWith(`${HARBOR_IMAGE_BASE}/`)) {
    if (SHIPPED_HARBOR_IMAGE_NAME_SET.has(baseName)) {
      return baseName;
    }
    return null;
  }

  return LOCAL_IMAGE_ALIASES[baseName] || null;
}

function canonicalizeComposeImagesToHarbor(imageRefs, tag = "latest") {
  const seen = new Set();
  const harborImages = [];

  for (const imageRef of imageRefs) {
    const imageName = canonicalHarborImageName(imageRef);
    if (!imageName || seen.has(imageName)) {
      continue;
    }
    seen.add(imageName);
    harborImages.push(harborImageSpec(imageName, tag));
  }

  return harborImages;
}

function defaultComposeFiles(projectRoot, llmGatewayMode) {
  void llmGatewayMode;
  return [path.join(projectRoot, "docker-compose.harbor.yml")];
}

function mergeDockerImagesWithCommunity(harborImages) {
  return [...COMMUNITY_DOCKER_IMAGES_TO_PULL, ...harborImages];
}

function buildDockerImagesToPull({
  projectRoot,
  tag = "latest",
  env = process.env,
  composeFilePaths = null,
}) {
  const { mcpMode, llmGatewayMode } = resolveRuntimeModes(projectRoot, env);
  const files = composeFilePaths || defaultComposeFiles(projectRoot, llmGatewayMode);
  let harborImages = canonicalizeComposeImagesToHarbor(
    parseServiceImagesFromCompose(files),
    tag,
  );
  void mcpMode;

  if (harborImages.length === 0) {
    harborImages = buildFallbackHarborImageSpecs({
      tag,
      mcpMode,
      llmGatewayMode,
    });
  }

  const names = new Set(harborImages.map((image) => image.name));
  const requiredFallback = buildFallbackHarborImageSpecs({
    tag,
    mcpMode,
    llmGatewayMode,
  });

  for (const image of requiredFallback) {
    if (!names.has(image.name)) {
      harborImages.push(image);
      names.add(image.name);
    }
  }

  return mergeDockerImagesWithCommunity(harborImages);
}

// Reverse lookup: Harbor image name → local image name
const HARBOR_TO_LOCAL = Object.fromEntries(
  Object.entries(LOCAL_IMAGE_ALIASES).map(([local, harbor]) => [harbor, local]),
);

function harborToLocalImageRef(harborImageRef) {
  if (!harborImageRef || typeof harborImageRef !== "string") return null;
  const prefix = `${HARBOR_IMAGE_BASE}/`;
  if (!harborImageRef.startsWith(prefix)) return null;
  const rest = harborImageRef.slice(prefix.length);
  const colonIdx = rest.indexOf(":");
  const imageName = colonIdx >= 0 ? rest.slice(0, colonIdx) : rest;
  const tag = colonIdx >= 0 ? rest.slice(colonIdx + 1) : "latest";
  const localName = HARBOR_TO_LOCAL[imageName];
  if (!localName) return null;
  return `${localName}:${tag}`;
}

module.exports = {
  COMMUNITY_DOCKER_IMAGES_TO_PULL,
  HARBOR_IMAGE_BASE,
  SHIPPED_HARBOR_IMAGE_NAMES,
  normalizeMcpMode,
  normalizeGatewayMode,
  resolveRuntimeModes,
  buildFallbackHarborImageSpecs,
  parseServiceImagesFromCompose,
  canonicalHarborImageName,
  canonicalizeComposeImagesToHarbor,
  buildDockerImagesToPull,
  harborToLocalImageRef,
  LOCAL_IMAGE_ALIASES,
};
