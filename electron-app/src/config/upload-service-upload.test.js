const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

function freshConfig(envValue) {
  delete require.cache[require.resolve("./upload-service-config")];
  if (envValue === undefined) {
    delete process.env.portico_UPLOAD_SERVICE_URL;
  } else {
    process.env.portico_UPLOAD_SERVICE_URL = envValue;
  }
  return require("./upload-service-config");
}

test("upload ZIP file to service endpoint", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portico-upload-test-"));
  const zipPath = path.join(tmpDir, "debug-logs.zip");
  fs.writeFileSync(zipPath, Buffer.from("PK\x03\x04fake-zip-content-for-testing"));

  let receivedBody = null;
  let receivedHeaders = null;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      receivedBody = Buffer.concat(chunks).toString();
      receivedHeaders = req.headers;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, id: "test-upload-id" }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const config = freshConfig(`http://127.0.0.1:${port}`);
    assert.equal(config.UPLOAD_ENDPOINT, `http://127.0.0.1:${port}/upload`);

    const boundary = `----porticoBoundary${crypto.randomBytes(16).toString("hex")}`;
    const fileName = path.basename(zipPath);
    const fileData = fs.readFileSync(zipPath);

    const parts = [];
    const addField = (name, value) => {
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      );
    };
    addField("description", "Test upload description");
    addField("reporter", "test-user");
    addField("severity", "low");

    const fileHeader = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/zip\r\n\r\n`
    );
    const fileTail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const textParts = Buffer.from(parts.join(""));
    const body = Buffer.concat([textParts, fileHeader, fileData, fileTail]);

    const url = new URL(config.UPLOAD_ENDPOINT);

    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length,
          },
          timeout: 5000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(JSON.parse(data)));
        }
      );
      req.on("timeout", () => { req.destroy(); reject(new Error("Upload timed out")); });
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    assert.deepStrictEqual(result, { success: true, id: "test-upload-id" });

    assert.ok(receivedHeaders["content-type"].includes("multipart/form-data"));
    assert.ok(receivedBody.includes("Test upload description"));
    assert.ok(receivedBody.includes("test-user"));
    assert.ok(receivedBody.includes("low"));
    assert.ok(receivedBody.includes('filename="debug-logs.zip"'));
    assert.ok(receivedBody.includes("application/zip"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
