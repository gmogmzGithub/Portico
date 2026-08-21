const test = require("node:test");
const assert = require("node:assert/strict");

function freshConfig(envValue) {
  delete require.cache[require.resolve("./upload-service-config")];
  if (envValue === undefined) {
    delete process.env.portico_UPLOAD_SERVICE_URL;
  } else {
    process.env.portico_UPLOAD_SERVICE_URL = envValue;
  }
  return require("./upload-service-config");
}

test("UPLOAD_SERVICE_BASE_URL defaults to prod when portico_UPLOAD_SERVICE_URL is unset", () => {
  const config = freshConfig(undefined);
  assert.equal(config.UPLOAD_SERVICE_BASE_URL, "https://portico-service.sandbox.example.invalid");
});

test("portico_UPLOAD_SERVICE_URL env var overrides the default base URL", () => {
  const config = freshConfig("https://custom.example.com");
  assert.equal(config.UPLOAD_SERVICE_BASE_URL, "https://custom.example.com");
});

test("UPLOAD_ENDPOINT equals UPLOAD_SERVICE_BASE_URL + /upload (default case)", () => {
  const config = freshConfig(undefined);
  assert.equal(config.UPLOAD_ENDPOINT, "https://portico-service.sandbox.example.invalid/upload");
});

test("UPLOAD_ENDPOINT equals UPLOAD_SERVICE_BASE_URL + /upload (override case)", () => {
  const config = freshConfig("https://custom.example.com");
  assert.equal(config.UPLOAD_ENDPOINT, "https://custom.example.com/upload");
});

test("UPLOAD_MAX_SIZE_BYTES equals 50 MB", () => {
  const config = freshConfig(undefined);
  assert.equal(config.UPLOAD_MAX_SIZE_BYTES, 50 * 1024 * 1024);
});
