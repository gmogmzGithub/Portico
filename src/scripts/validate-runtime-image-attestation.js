#!/usr/bin/env node

"use strict";

const fs = require("node:fs");

const MAX_ATTESTATION_BYTES = 64 * 1024;
const REQUIRED_IMAGE_NAMES = Object.freeze([
  "agent-vm",
  "bifrost-bridge",
  "chat-state-api",
  "health-check",
  "mcp-orc-rust",
  "mcpo-control-plane-rust",
  "open-webui-patched",
]);
const REQUIRED_PLATFORMS = Object.freeze(["linux/amd64", "linux/arm64"]);
const DEFAULT_REGISTRY = "harbor.example.invalid/portico";
const SHA_RE = /^[a-f0-9]{40}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function fail(message) {
  throw new Error(message);
}

function assertExactKeys(value, expectedKeys, label) {
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actualKeys.length !== expected.length ||
    actualKeys.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function validateRuntimeImageAttestation(
  value,
  {
    expectedSourceRevision = "",
    expectedTag = "",
    registry = DEFAULT_REGISTRY,
  } = {},
) {
  const attestation = requireObject(value, "runtime image attestation");
  assertExactKeys(
    attestation,
    ["schemaVersion", "sourceRevision", "tag", "images"],
    "runtime image attestation",
  );

  if (attestation.schemaVersion !== 1) {
    fail("runtime image attestation schemaVersion must be 1");
  }
  if (typeof attestation.sourceRevision !== "string" || !SHA_RE.test(attestation.sourceRevision)) {
    fail("runtime image attestation sourceRevision must be a full lowercase git SHA");
  }
  if (expectedSourceRevision && attestation.sourceRevision !== expectedSourceRevision) {
    fail(
      `runtime image attestation sourceRevision mismatch: expected ${expectedSourceRevision}, found ${attestation.sourceRevision}`,
    );
  }
  if (typeof attestation.tag !== "string" || !TAG_RE.test(attestation.tag)) {
    fail("runtime image attestation tag is invalid");
  }
  if (expectedTag && attestation.tag !== expectedTag) {
    fail(
      `runtime image attestation tag mismatch: expected ${expectedTag}, found ${attestation.tag}`,
    );
  }
  if (!Array.isArray(attestation.images) || attestation.images.length !== REQUIRED_IMAGE_NAMES.length) {
    fail(`runtime image attestation must contain exactly ${REQUIRED_IMAGE_NAMES.length} images`);
  }

  const normalizedRegistry = String(registry || "").replace(/\/+$/, "");
  if (!normalizedRegistry) {
    fail("runtime image attestation registry must not be empty");
  }

  const seenNames = new Set();
  for (const rawImage of attestation.images) {
    const image = requireObject(rawImage, "runtime image attestation image");
    assertExactKeys(
      image,
      ["name", "reference", "indexDigest", "platforms"],
      "runtime image attestation image",
    );

    if (!REQUIRED_IMAGE_NAMES.includes(image.name) || seenNames.has(image.name)) {
      fail(`runtime image attestation contains an unknown or duplicate image: ${String(image.name)}`);
    }
    seenNames.add(image.name);

    const expectedReference = `${normalizedRegistry}/${image.name}:${attestation.tag}`;
    if (image.reference !== expectedReference) {
      fail(
        `runtime image attestation reference mismatch for ${image.name}: expected ${expectedReference}, found ${String(image.reference)}`,
      );
    }
    if (typeof image.indexDigest !== "string" || !DIGEST_RE.test(image.indexDigest)) {
      fail(`runtime image attestation index digest is invalid for ${image.name}`);
    }

    const platforms = requireObject(
      image.platforms,
      `runtime image attestation platforms for ${image.name}`,
    );
    assertExactKeys(
      platforms,
      REQUIRED_PLATFORMS,
      `runtime image attestation platforms for ${image.name}`,
    );

    for (const platformName of REQUIRED_PLATFORMS) {
      const platform = requireObject(
        platforms[platformName],
        `runtime image attestation ${image.name} ${platformName}`,
      );
      assertExactKeys(
        platform,
        ["digest", "revision", "version"],
        `runtime image attestation ${image.name} ${platformName}`,
      );
      if (typeof platform.digest !== "string" || !DIGEST_RE.test(platform.digest)) {
        fail(`runtime image attestation digest is invalid for ${image.name} ${platformName}`);
      }
      if (platform.revision !== attestation.sourceRevision) {
        fail(`runtime image attestation revision mismatch for ${image.name} ${platformName}`);
      }
      if (platform.version !== attestation.tag) {
        fail(`runtime image attestation version mismatch for ${image.name} ${platformName}`);
      }
    }
  }

  const sortedNames = [...seenNames].sort();
  if (sortedNames.some((name, index) => name !== REQUIRED_IMAGE_NAMES[index])) {
    fail("runtime image attestation image inventory is incomplete");
  }

  return attestation;
}

function readRuntimeImageAttestation(filePath) {
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) {
    fail(`runtime image attestation is not a regular file: ${filePath}`);
  }
  if (stats.size < 2 || stats.size > MAX_ATTESTATION_BYTES) {
    fail(
      `runtime image attestation size must be between 2 and ${MAX_ATTESTATION_BYTES} bytes: ${filePath}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`runtime image attestation is invalid JSON: ${error.message}`);
  }
  return parsed;
}

function parseArgs(args) {
  const options = {
    attestationPath: "",
    expectedSourceRevision: "",
    expectedTag: "",
    registry: DEFAULT_REGISTRY,
    quiet: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--attestation":
        options.attestationPath = args[++index] || "";
        break;
      case "--expected-source-revision":
        options.expectedSourceRevision = args[++index] || "";
        break;
      case "--expected-tag":
        options.expectedTag = args[++index] || "";
        break;
      case "--registry":
        options.registry = args[++index] || "";
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: validate-runtime-image-attestation.js --attestation <path> " +
            "--expected-source-revision <sha> --expected-tag <tag> [--registry <path>] [--quiet]\n",
        );
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${argument}`);
    }
  }

  if (!options.attestationPath) {
    fail("--attestation is required");
  }
  if (options.expectedSourceRevision && !SHA_RE.test(options.expectedSourceRevision)) {
    fail("--expected-source-revision must be a full lowercase git SHA");
  }
  if (options.expectedTag && !TAG_RE.test(options.expectedTag)) {
    fail("--expected-tag is invalid");
  }
  return options;
}

function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const attestation = readRuntimeImageAttestation(options.attestationPath);
  validateRuntimeImageAttestation(attestation, options);
  if (!options.quiet) {
    process.stdout.write(
      `Validated ${attestation.images.length} runtime images for ${attestation.sourceRevision}.\n`,
    );
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_REGISTRY,
  MAX_ATTESTATION_BYTES,
  REQUIRED_IMAGE_NAMES,
  REQUIRED_PLATFORMS,
  readRuntimeImageAttestation,
  validateRuntimeImageAttestation,
};
