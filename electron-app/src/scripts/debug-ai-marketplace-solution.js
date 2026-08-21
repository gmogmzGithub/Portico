#!/usr/bin/env node
// Read-only AI Marketplace solution inspector.
// Spans IPC/Communication and Chat UI debugging: compares solution envelopes
// with installable bundle payloads so discover-detail rendering can be checked.

const client = require("../services/ai-marketplace-client");

function parseArgs(argv) {
  const args = {
    solutionId: "",
    viewerEmail: process.env.MARKETPLACE_VIEWER_EMAIL || "",
    printCurl: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === "--viewer-email") {
      args.viewerEmail = argv[index + 1] || "";
      index += 1;
    } else if (entry === "--print-curl") {
      args.printCurl = true;
    } else if (!args.solutionId) {
      args.solutionId = entry;
    }
  }
  return args;
}

function usage() {
  console.error(
    "Usage: node electron-app/src/scripts/debug-ai-marketplace-solution.js <solution-id> [--viewer-email user@example.invalid] [--print-curl]",
  );
}

function stringify(value) {
  return JSON.stringify(value, null, 2);
}

function valueType(value) {
  if (Array.isArray(value)) return "array";
  return value === null ? "null" : typeof value;
}

function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function payloadFromBundle(bundle) {
  const normalized = client.normalizeBundle(bundle);
  const payload = normalized?.payload && typeof normalized.payload === "object"
    ? normalized.payload
    : {};
  const nestedAgent = asObject(payload.agent);
  return Object.keys(nestedAgent).length ? { ...payload, ...nestedAgent } : payload;
}

function payloadSummary(label, bundle) {
  const normalized = client.normalizeBundle(bundle);
  const payload = payloadFromBundle(normalized);
  return {
    label,
    bundle_type: valueType(bundle),
    normalized_bundle_keys: normalized ? Object.keys(normalized) : [],
    normalized_type: normalized?.type || null,
    payload_keys: Object.keys(payload),
    name: payload.name || null,
    base_model_id: payload.base_model_id || null,
    skill_ids: Array.isArray(payload.skill_ids) ? payload.skill_ids : [],
    tool_server_ids: Array.isArray(payload.tool_server_ids)
      ? payload.tool_server_ids
      : [],
    skill_refs: Array.isArray(payload.skill_refs) ? payload.skill_refs : [],
    tool_server_refs: Array.isArray(payload.tool_server_refs)
      ? payload.tool_server_refs
      : [],
    has_system_prompt:
      typeof payload.system_prompt === "string" && payload.system_prompt.length > 0,
    description: payload.description || null,
  };
}

function solutionSummary(solution) {
  return {
    keys: Object.keys(solution || {}),
    id: solution?.id || null,
    name: solution?.name || null,
    type: solution?.type || null,
    author: solution?.author || null,
    has_bundle: solution?.has_bundle,
    bundle_type: valueType(solution?.bundle),
    resolved_bundle_cache_type: valueType(solution?.resolved_bundle_cache),
    allowed_emails: Array.isArray(solution?.allowed_emails)
      ? solution.allowed_emails
      : [],
  };
}

function printCurlCommands({ solutionId, viewerEmail }) {
  const baseUrl = client.getBaseUrl().replace(/\/+$/, "");
  const encodedId = encodeURIComponent(solutionId);
  const viewerHeader = viewerEmail
    ? ` \\\n  -H 'x-remote-user: ${viewerEmail}'`
    : "";
  console.log("\nEquivalent curl commands:");
  console.log(`curl -sS \\
  -H 'Accept: application/json' \\
  -H 'X-API-Key: $AI_MARKETPLACE_API_KEY'${viewerHeader} \\
  '${baseUrl}/api/solutions/${encodedId}' | jq`);
  console.log(`curl -sS \\
  -H 'Accept: application/json' \\
  -H 'X-API-Key: $AI_MARKETPLACE_API_KEY'${viewerHeader} \\
  '${baseUrl}/api/solutions/${encodedId}/bundle' | jq`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.solutionId) {
    usage();
    process.exit(2);
  }

  const options = { viewerEmail: args.viewerEmail };
  console.log(
    stringify({
      solution_id: args.solutionId,
      viewer_email: args.viewerEmail || null,
      base_url: client.getBaseUrl(),
    }),
  );

  const solution = await client.getSolution(args.solutionId, options);
  console.log("\nGET /api/solutions/:id");
  console.log(stringify(solutionSummary(solution)));

  console.log("\nEnvelope bundle locations");
  console.log(
    stringify([
      payloadSummary("solution.bundle", solution.bundle),
      payloadSummary(
        "solution.resolved_bundle_cache",
        solution.resolved_bundle_cache,
      ),
      payloadSummary(
        "solution.resolved_bundle_cache.bundle",
        asObject(solution.resolved_bundle_cache).bundle,
      ),
    ]),
  );

  let directBundle = null;
  try {
    directBundle = await client.request(
      `/api/solutions/${encodeURIComponent(args.solutionId)}/bundle`,
      options,
    );
  } catch (error) {
    console.log("\nGET /api/solutions/:id/bundle failed");
    console.log(
      stringify({
        message: error.message,
        code: error.code || null,
        status: error.status || null,
      }),
    );
  }

  if (directBundle) {
    console.log("\nGET /api/solutions/:id/bundle");
    console.log(stringify(payloadSummary("direct bundle route", directBundle)));
  }

  const installerBundle = await client.getSolutionBundle(args.solutionId, options);
  console.log("\nClient getSolutionBundle() result");
  console.log(stringify(payloadSummary("client selected bundle", installerBundle)));

  if (args.printCurl) {
    printCurlCommands(args);
  }
}

main().catch((error) => {
  console.error(
    stringify({
      message: error.message,
      code: error.code || null,
      status: error.status || null,
      body: error.body || null,
    }),
  );
  process.exit(1);
});
