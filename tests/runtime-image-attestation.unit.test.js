"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  REQUIRED_IMAGE_NAMES,
  REQUIRED_PLATFORMS,
  validateRuntimeImageAttestation,
} = require("../src/scripts/validate-runtime-image-attestation");

const sourceRevision = "a".repeat(40);
const tag = sourceRevision;
const digest = (character) => `sha256:${character.repeat(64)}`;

function validAttestation() {
  return {
    schemaVersion: 1,
    sourceRevision,
    tag,
    images: REQUIRED_IMAGE_NAMES.map((name, imageIndex) => ({
      name,
      reference: `harbor.example.invalid/portico/${name}:${tag}`,
      indexDigest: digest(String((imageIndex % 9) + 1)),
      platforms: Object.fromEntries(
        REQUIRED_PLATFORMS.map((platformName, platformIndex) => [
          platformName,
          {
            digest: digest(platformIndex === 0 ? "b" : "c"),
            revision: sourceRevision,
            version: tag,
          },
        ]),
      ),
    })),
  };
}

test("accepts the exact seven-image, two-platform release attestation", () => {
  const attestation = validAttestation();
  assert.equal(
    validateRuntimeImageAttestation(attestation, {
      expectedSourceRevision: sourceRevision,
      expectedTag: tag,
    }),
    attestation,
  );
});

test("accepts an exact merge-request image tag", () => {
  const attestation = validAttestation();
  const mrTag = `mr-123-${sourceRevision}`;
  attestation.tag = mrTag;
  for (const image of attestation.images) {
    image.reference = `harbor.example.invalid/portico/${image.name}:${mrTag}`;
    for (const platformName of REQUIRED_PLATFORMS) {
      image.platforms[platformName].version = mrTag;
    }
  }
  assert.equal(
    validateRuntimeImageAttestation(attestation, {
      expectedSourceRevision: sourceRevision,
      expectedTag: mrTag,
    }),
    attestation,
  );
});

test("rejects a missing image", () => {
  const attestation = validAttestation();
  attestation.images.pop();
  assert.throws(
    () => validateRuntimeImageAttestation(attestation),
    /exactly 7 images/,
  );
});

test("rejects a platform digest with mismatched provenance labels", () => {
  const attestation = validAttestation();
  attestation.images[0].platforms["linux/arm64"].revision = "d".repeat(40);
  assert.throws(
    () => validateRuntimeImageAttestation(attestation),
    /revision mismatch/,
  );
});

test("rejects extra fields so secret-bearing data cannot ride in the attestation", () => {
  const attestation = validAttestation();
  attestation.images[0].token = "must-not-be-accepted";
  assert.throws(
    () => validateRuntimeImageAttestation(attestation),
    /must contain exactly/,
  );
});

test("rejects an attestation from another commit or tag", () => {
  const attestation = validAttestation();
  assert.throws(
    () =>
      validateRuntimeImageAttestation(attestation, {
        expectedSourceRevision: "e".repeat(40),
        expectedTag: tag,
      }),
    /sourceRevision mismatch/,
  );
});
