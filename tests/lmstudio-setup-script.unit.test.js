const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(
  REPO_ROOT,
  "skills/lm-studio-setup/scripts/lmstudio_setup.py",
);

function runScript(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [SCRIPT, ...args], {
    cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        assert.equal(code, 0, stderr || stdout);
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

test("lmstudio_setup inspect filters embeddings and prefers loaded chat model", async () => {
  await withServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/api/v1/models");
    sendJson(res, 200, {
      data: [
        {
          id: "text-embedding-nomic-embed",
          type: "embedding",
          max_context_length: 8192,
        },
        {
          id: "qwen/qwen3-8b",
          max_context_length: 65536,
          size_bytes: 5000,
        },
        {
          id: "google/gemma-4-e4b",
          max_context_length: 131072,
          quantization: "Q4_K_M",
          size_bytes: 4000,
          loaded_instances: [{ config: { context_length: 98304 } }],
        },
      ],
    });
  }, async (baseUrl) => {
    const output = await runScript(["inspect", "--base-url", baseUrl]);
    assert.equal(output.best_model_id, "google/gemma-4-e4b");
    assert.deepEqual(output.embedding_model_ids, ["text-embedding-nomic-embed"]);
    assert.deepEqual(
      output.loaded_llms.map((model) => model.id),
      ["google/gemma-4-e4b"],
    );
    assert.equal(output.loaded_llms[0].loaded_context_length, 98304);
  });
});

test("lmstudio_setup probe reports reachable server without requiring user input", async () => {
  await withServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/api/v1/models");
    sendJson(res, 200, {
      data: [
        {
          id: "text-embedding-nomic-embed",
          type: "embedding",
        },
        {
          id: "google/gemma-4-e4b",
          max_context_length: 131072,
        },
      ],
    });
  }, async (baseUrl) => {
    const output = await runScript(["probe", "--base-url", baseUrl]);
    assert.equal(output.ok, true);
    assert.equal(output.reachable, true);
    assert.equal(output.model_count, 2);
    assert.equal(output.chat_model_count, 1);
    assert.deepEqual(output.chat_model_ids, ["google/gemma-4-e4b"]);
  });
});

test("lmstudio_setup probe returns structured unreachable result", async () => {
  const output = await runScript(["probe", "--base-url", "http://127.0.0.1:9"]);
  assert.equal(output.ok, true);
  assert.equal(output.reachable, false);
  assert.match(output.error, /failed|refused|timed out|unreachable/i);
});

test("lmstudio_setup load retries context lengths and reports compact JSON", async () => {
  let loadAttempts = 0;
  let loaded = false;
  await withServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/v1/models") {
      sendJson(res, 200, {
        data: [
          {
            id: "google/gemma-4-e4b",
            max_context_length: 131072,
            loaded_instances: loaded
              ? [{ config: { context_length: 65536 } }]
              : [],
          },
        ],
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/models/load") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const body = JSON.parse(raw);
        loadAttempts += 1;
        if (body.context_length === 131072) {
          sendJson(res, 500, { error: "too large" });
        } else {
          assert.equal(body.model, "google/gemma-4-e4b");
          assert.equal(body.context_length, 65536);
          assert.equal(body.echo_load_config, true);
          assert.equal(body.flash_attention, true);
          assert.equal(body.offload_kv_cache_to_gpu, true);
          loaded = true;
          sendJson(res, 200, { ok: true });
        }
      });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }, async (baseUrl) => {
    const output = await runScript([
      "load",
      "--base-url",
      baseUrl,
      "--model-key",
      "google/gemma-4-e4b",
    ]);
    assert.equal(loadAttempts, 2);
    assert.equal(output.loaded, true);
    assert.equal(output.loaded_context_length, 65536);
    assert.deepEqual(output.attempted_context_lengths.slice(0, 2), [131072, 65536]);
  });
});

test("lmstudio_setup load unloads and reloads when loaded context is below max", async () => {
  let unloaded = false;
  let loadedContext = 4096;
  await withServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/v1/models") {
      sendJson(res, 200, {
        models: [
          {
            key: "google/gemma-4-e4b",
            type: "llm",
            max_context_length: 131072,
            loaded_instances: loadedContext
              ? [{ id: "google/gemma-4-e4b", config: { context_length: loadedContext } }]
              : [],
          },
        ],
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/models/unload") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const body = JSON.parse(raw);
        assert.equal(body.instance_id, "google/gemma-4-e4b");
        unloaded = true;
        loadedContext = 0;
        sendJson(res, 200, { instance_id: body.instance_id });
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/models/load") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        assert.equal(unloaded, true);
        const body = JSON.parse(raw);
        assert.equal(body.model, "google/gemma-4-e4b");
        assert.equal(body.context_length, 131072);
        assert.equal(body.flash_attention, true);
        assert.equal(body.offload_kv_cache_to_gpu, true);
        loadedContext = 131072;
        sendJson(res, 200, {
          type: "llm",
          instance_id: "google/gemma-4-e4b",
          status: "loaded",
        });
      });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }, async (baseUrl) => {
    const output = await runScript([
      "load",
      "--base-url",
      baseUrl,
      "--model-key",
      "google/gemma-4-e4b",
    ]);
    assert.equal(output.loaded, true);
    assert.equal(output.already_loaded, false);
    assert.equal(output.reloaded, true);
    assert.equal(output.target_context_length, 131072);
    assert.equal(output.loaded_context_length, 131072);
    assert.deepEqual(
      output.unloaded_instances.map((entry) => entry.instance_id),
      ["google/gemma-4-e4b"],
    );
  });
});

test("lmstudio_setup load skips reload when loaded context already meets max", async () => {
  await withServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/v1/models") {
      sendJson(res, 200, {
        models: [
          {
            key: "google/gemma-4-e4b",
            type: "llm",
            max_context_length: 131072,
            loaded_instances: [
              { id: "google/gemma-4-e4b", config: { context_length: 131072 } },
            ],
          },
        ],
      });
      return;
    }

    sendJson(res, 500, { error: "unexpected write request" });
  }, async (baseUrl) => {
    const output = await runScript([
      "load",
      "--base-url",
      baseUrl,
      "--model-key",
      "google/gemma-4-e4b",
    ]);
    assert.equal(output.loaded, true);
    assert.equal(output.already_loaded, true);
    assert.equal(output.reloaded, false);
    assert.equal(output.loaded_context_length, 131072);
    assert.deepEqual(output.attempted_context_lengths, []);
  });
});
