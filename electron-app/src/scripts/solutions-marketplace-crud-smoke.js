#!/usr/bin/env node
// Opt-in AI Marketplace CRUD smoke test.
// Spans IPC/Communication and Agent Skills layers by exercising the same client
// and bundle builder used by the Electron publish/install flow.

const client = require("../services/ai-marketplace-client");
const {
  TYPE_PORTICO_AGENTS,
  buildPublishBundle,
} = require("../services/ai-marketplace-install");

function parseArgs(argv) {
  const args = {
    userEmail: process.env.MARKETPLACE_VIEWER_EMAIL || "",
    author: "",
    baseUrl: process.env.AI_MARKETPLACE_BASE_URL || "",
    apiKey: process.env.AI_MARKETPLACE_API_KEY || "",
    keep: false,
    namePrefix: "PORTICO CRUD Smoke",
  };

  const readOptionValue = (entry, index) => {
    const value = argv[index + 1] || "";
    if (!value || value.startsWith("--")) {
      throw new Error(`${entry} requires a value.`);
    }
    return value;
  };

  for (let index = 2; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === "--user-email" || entry === "--viewer-email") {
      args.userEmail = readOptionValue(entry, index);
      index += 1;
    } else if (entry === "--author") {
      args.author = readOptionValue(entry, index);
      index += 1;
    } else if (entry === "--base-url") {
      args.baseUrl = readOptionValue(entry, index);
      index += 1;
    } else if (entry === "--api-key") {
      args.apiKey = readOptionValue(entry, index);
      index += 1;
    } else if (entry === "--name-prefix") {
      args.namePrefix = readOptionValue(entry, index);
      index += 1;
    } else if (entry === "--keep") {
      args.keep = true;
    } else if (entry === "--help" || entry === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${entry}`);
    }
  }

  args.userEmail = String(args.userEmail || "").trim().toLowerCase();
  args.author = String(args.author || "").trim() || args.userEmail.split("@")[0] || "unknown";
  args.baseUrl = String(args.baseUrl || "").trim();
  args.apiKey = String(args.apiKey || "").trim();
  args.namePrefix = String(args.namePrefix || "").trim() || "PORTICO CRUD Smoke";
  return args;
}

function usage() {
  console.error(`Usage:
  node electron-app/src/scripts/solutions-marketplace-crud-smoke.js --user-email you@example.invalid [options]

Options:
  --viewer-email <email>  Alias for --user-email.
  --author <ldap>         Author field to send. Defaults to the email prefix.
  --base-url <url>        Override AI_MARKETPLACE_BASE_URL.
  --api-key <key>         Override AI_MARKETPLACE_API_KEY.
  --name-prefix <text>    Prefix for the temporary solution name.
  --keep                  Keep the created solution instead of deleting it.
`);
}

function stringify(value) {
  return JSON.stringify(value, null, 2);
}

function responseId(value) {
  return String(value?.id || value?.solution_id || value?.uuid || "").trim();
}

function responseStatus(value) {
  return {
    id: responseId(value) || null,
    code: value?.code || null,
    status: value?.status || null,
    message: value?.message || value?.error || null,
    keys: value && typeof value === "object" ? Object.keys(value) : [],
  };
}

function errorStatus(error) {
  return {
    message: error?.message || String(error),
    code: error?.code || null,
    status: error?.status || null,
    body: error?.body || null,
  };
}

function assertCondition(condition, message, details = null) {
  if (condition) return;
  const error = new Error(message);
  if (details) error.details = details;
  throw error;
}

function isPlausibleEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function assertActiveWrite(value, label, expectedId = "") {
  const summary = responseStatus(value);
  assertCondition(summary.id, `${label} response did not include a solution id.`, value);
  if (expectedId) {
    assertCondition(
      summary.id === expectedId,
      `${label} response returned an unexpected solution id.`,
      value,
    );
  }
  assertCondition(
    summary.status === "active",
    `${label} response did not return active status.`,
    value,
  );
  return summary.id;
}

function makeOptions(args) {
  return {
    apiKey: args.apiKey || null,
    baseUrl: args.baseUrl || null,
    viewerEmail: args.userEmail,
  };
}

async function verifyDeleted({ solutionId, options }) {
  try {
    const solution = await client.getSolution(solutionId, options);
    const status = String(solution?.status || "").trim().toLowerCase();
    if (status === "deleted") {
      return {
        deleted: true,
        verification: {
          mode: "status",
          id: responseId(solution) || solutionId,
          status: solution.status,
        },
      };
    }
    return {
      deleted: false,
      verification: {
        mode: "still_readable",
        id: responseId(solution) || solutionId,
        status: solution?.status || null,
        has_bundle: solution?.has_bundle ?? null,
      },
    };
  } catch (error) {
    if (error.status === 404) {
      return {
        deleted: true,
        verification: {
          mode: "not_found",
          ...errorStatus(error),
        },
      };
    }
    throw error;
  }
}

async function makeSolutionInput({ args, name, description, revision }) {
  const bundle = await buildPublishBundle({
    type: TYPE_PORTICO_AGENTS,
    agent: {
      name,
      description,
      base_model_id: "crud-smoke-model",
      system_prompt: `You are a temporary CRUD smoke test agent. Revision: ${revision}.`,
      allowed_emails: [args.userEmail],
      skill_ids: [],
      skill_refs: [],
      tool_server_ids: [],
      tool_server_refs: [],
      reasoning_effort: null,
      profile_image_url: null,
    },
  });

  return {
    name,
    description,
    author: args.author,
    submitted_by: args.userEmail,
    allowed_emails: [args.userEmail],
    detail_url: `https://solutions.sandbox.example.invalid/?type=${encodeURIComponent(bundle.type)}`,
    type: bundle.type,
    bundle,
  };
}

async function run() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }
  if (!args.userEmail) {
    usage();
    throw new Error("--user-email is required so create/update/delete use the same owner identity.");
  }
  if (!isPlausibleEmail(args.userEmail)) {
    throw new Error("--user-email must be an email address.");
  }

  const suffix = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${process.pid}`;
  const initialName = `${args.namePrefix} ${suffix}`;
  const updatedName = `${initialName} Updated`;
  const options = makeOptions(args);
  const baseUrl = args.baseUrl || client.getBaseUrl();
  let createdId = "";
  let deleted = false;

  console.log(
    stringify({
      base_url: baseUrl,
      user_email: args.userEmail,
      author: args.author,
      keep: args.keep,
      name: initialName,
    }),
  );

  try {
    const createInput = await makeSolutionInput({
      args,
      name: initialName,
      description: "Temporary solution created by Portico CRUD smoke test.",
      revision: "create",
    });

    console.log("\nCREATE POST /api/solutions");
    const created = await client.createSolution(createInput, options);
    console.log(stringify(responseStatus(created)));
    createdId = assertActiveWrite(created, "Create");

    console.log("\nREAD GET /api/solutions/:id");
    const readCreated = await client.getSolution(createdId, options);
    console.log(stringify(responseStatus(readCreated)));
    assertCondition(
      responseId(readCreated) === createdId || readCreated?.id === createdId,
      "Read after create returned an unexpected solution id.",
      readCreated,
    );
    assertCondition(
      readCreated?.status === "active",
      "Read after create did not return active status.",
      readCreated,
    );

    const updateInput = await makeSolutionInput({
      args,
      name: updatedName,
      description: "Temporary solution updated by Portico CRUD smoke test.",
      revision: "update",
    });

    console.log("\nUPDATE PUT /api/solutions/:id");
    const updated = await client.updateSolution(createdId, updateInput, options);
    console.log(stringify(responseStatus(updated)));
    assertActiveWrite(updated, "Update", createdId);

    console.log("\nREAD GET /api/solutions/:id after update");
    const readUpdated = await client.getSolution(createdId, options);
    console.log(
      stringify({
        ...responseStatus(readUpdated),
        name: readUpdated?.name || null,
        type: readUpdated?.type || null,
        has_bundle: readUpdated?.has_bundle ?? null,
      }),
    );
    assertCondition(
      readUpdated?.name === updatedName,
      "Read after update did not return the updated name.",
      readUpdated,
    );
    assertCondition(
      readUpdated?.status === "active",
      "Read after update did not return active status.",
      readUpdated,
    );
    assertCondition(
      readUpdated?.has_bundle === true,
      "Read after update did not report has_bundle=true.",
      readUpdated,
    );

    console.log("\nREAD BUNDLE client.getSolutionBundle()");
    const bundle = await client.getSolutionBundle(createdId, options);
    console.log(
      stringify({
        type: bundle?.type || null,
        payload_name: bundle?.payload?.name || null,
        payload_keys: bundle?.payload ? Object.keys(bundle.payload) : [],
      }),
    );
    assertCondition(
      bundle?.payload?.name === updatedName,
      "Bundle read did not return the updated payload.",
      bundle,
    );

    console.log("\nSEARCH POST /api/solutions/search");
    const search = await client.search(
      {
        query: updatedName,
        filters: { type: [TYPE_PORTICO_AGENTS] },
        page: 1,
        pageSize: 5,
      },
      options,
    );
    const searchResults = Array.isArray(search?.results) ? search.results : [];
    const searchResultIds = searchResults.map((entry) => responseId(entry) || entry?.id || null);
    const searchContainsCreatedId = searchResultIds.includes(createdId);
    console.log(
      stringify({
        total: search?.total ?? null,
        result_ids: searchResultIds,
        contains_created_id: searchContainsCreatedId,
        diagnostic:
          searchContainsCreatedId
            ? "Search returned the created solution."
            : "Search did not return the created solution; direct read/bundle routes remain authoritative.",
      }),
    );

    if (args.keep) {
      console.log(`\nKEEP requested; leaving solution ${createdId} in the marketplace.`);
      return;
    }

    console.log("\nDELETE DELETE /api/solutions/:id");
    const deletedResponse = await client.deleteSolution(createdId, {
      ...options,
      submittedBy: args.userEmail,
    });
    console.log(stringify(responseStatus(deletedResponse)));

    console.log("\nVERIFY DELETE GET /api/solutions/:id");
    const deleteVerification = await verifyDeleted({
      solutionId: createdId,
      options,
    });
    console.log(stringify(deleteVerification.verification));
    if (!deleteVerification.deleted) {
      const error = new Error("Deleted solution was still active/readable.");
      error.details = deleteVerification.verification;
      throw error;
    }
    deleted = true;
  } finally {
    if (createdId && !args.keep && !deleted) {
      console.log(`\nCLEANUP DELETE /api/solutions/:id (${createdId})`);
      try {
        await client.deleteSolution(createdId, {
          ...options,
          submittedBy: args.userEmail,
        });
        const cleanupVerification = await verifyDeleted({
          solutionId: createdId,
          options,
        });
        console.log(stringify({ cleanup: cleanupVerification.verification }));
      } catch (cleanupError) {
        console.error("cleanup failed:");
        console.error(stringify(errorStatus(cleanupError)));
      }
    }
  }
}

run().catch((error) => {
  console.error("\nCRUD smoke failed:");
  console.error(
    stringify({
      ...errorStatus(error),
      details: error.details || null,
    }),
  );
  process.exit(1);
});
