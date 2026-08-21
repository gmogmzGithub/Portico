// MCP stdio broker: spawns the real Rust core MCP server binaries
// (skills-server, subagents-server) as children, speaks newline-delimited
// JSON-RPC 2.0 MCP to them (initialize -> notifications/initialized ->
// tools/list | tools/call), and exposes a tiny local HTTP surface so an agent
// (or the headless Electron API host) can invoke tools:
//
//   POST /call   {"server":"skills","tool":"list_skills","arguments":{...}}
//     -> { ok:true, payload:<parsed content[0].text JSON>, raw:<CallToolResult> }
//     -> { ok:false, error:{code,message} } for JSON-RPC-level errors
//   GET  /tools?server=skills -> tools/list result
//
// This mirrors mcpo's production role (long-lived stdio servers behind an
// HTTP proxy) without any Docker dependency.

"use strict";

const http = require("node:http");
const { spawn } = require("node:child_process");

class McpStdioClient {
  constructor(name, command, { args = [], env = {}, cwd, log = () => {} } = {}) {
    this.name = name;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.buffer = "";
    this.child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = false;
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.log(`[broker] ${name} exited code=${code} signal=${signal}`);
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`${name} exited (code=${code})`));
      }
      this.pending.clear();
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this._onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) this.log(`[${name} stderr] ${line}`);
      }
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.log(`[broker] ${this.name} non-JSON stdout line: ${line.slice(0, 200)}`);
        continue;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.resolve(message);
      }
    }
  }

  _send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, { timeoutMs = 600_000 } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  }

  notify(method, params) {
    this._send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  async initialize() {
    const response = await this.request(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "agentic-harness", version: "0.0.1" },
      },
      { timeoutMs: 15_000 },
    );
    if (response.error) {
      throw new Error(`${this.name} initialize failed: ${JSON.stringify(response.error)}`);
    }
    this.notify("notifications/initialized");
    return response.result;
  }

  async listTools() {
    const response = await this.request("tools/list", {}, { timeoutMs: 15_000 });
    if (response.error) throw new Error(JSON.stringify(response.error));
    return response.result;
  }

  async callTool(tool, args, { timeoutMs } = {}) {
    const response = await this.request(
      "tools/call",
      { name: tool, arguments: args || {} },
      { timeoutMs },
    );
    if (response.error) {
      return { ok: false, error: response.error };
    }
    const result = response.result || {};
    let payload = null;
    const text = result?.content?.[0]?.text;
    if (typeof text === "string") {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    return { ok: true, payload, raw: result };
  }

  async close() {
    try {
      this.child.stdin.end();
    } catch {}
    if (!this.exited) {
      await new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          try {
            this.child.kill("SIGKILL");
          } catch {}
          resolve();
        }, 2000);
        this.child.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
  }
}

async function startMcpBroker({ servers, port = 0, host = "127.0.0.1", log = () => {} }) {
  const clients = new Map();
  for (const [name, spec] of Object.entries(servers)) {
    const client = new McpStdioClient(name, spec.command, {
      args: spec.args,
      env: spec.env,
      cwd: spec.cwd,
      log,
    });
    await client.initialize();
    clients.set(name, client);
    log(`[broker] ${name} initialized`);
  }

  const readJson = (req) =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : null);
        } catch {
          resolve(null);
        }
      });
    });

  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}`);
    if (req.method === "POST" && url.pathname === "/call") {
      const body = await readJson(req);
      const client = clients.get(body?.server);
      if (!client) {
        return send(res, 400, { ok: false, error: { message: `unknown server ${body?.server}` } });
      }
      try {
        const outcome = await client.callTool(body.tool, body.arguments, {
          timeoutMs: body.timeoutMs,
        });
        return send(res, 200, outcome);
      } catch (error) {
        return send(res, 200, { ok: false, error: { message: error.message } });
      }
    }
    if (req.method === "GET" && url.pathname === "/tools") {
      const client = clients.get(url.searchParams.get("server"));
      if (!client) return send(res, 400, { error: "unknown server" });
      try {
        return send(res, 200, await client.listTools());
      } catch (error) {
        return send(res, 500, { error: error.message });
      }
    }
    return send(res, 404, { error: "not found" });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    baseUrl: `http://${host}:${server.address().port}`,
    port: server.address().port,
    clients,
    close: async () => {
      await new Promise((done) => server.close(done));
      for (const client of clients.values()) await client.close();
    },
  };
}

module.exports = { McpStdioClient, startMcpBroker };
