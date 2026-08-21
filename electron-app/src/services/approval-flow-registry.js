// Approval-gated tool registry — IPC/Communication layer.
//
// The single maintained list of agentic operations that require USER APPROVAL
// through the in-app batchable approval modal (the marketplace confirmed-write
// flow: route registers a flow in marketplacePublishFlowResults, the renderer
// batch modal collects every pending flow into one dialog, the MCP proxy polls
// flow status). Enrolling a NEW operation = add a descriptor here, build its
// confirm payload in the route (mode/title/summary/card payload/solutionId),
// and — if it introduces a new mode string — extend the normalizer in
// marketplace-publish-confirm-flows.js. The renderer needs no changes: the
// batch modal renders items purely from the broadcast payload fields.
//
// ---------------------------------------------------------------------------
// Full approval-mechanism inventory (audited 2026-07-31, chat ef7c937c):
//
// A. In-app batchable approval modal (THIS registry):
//    subagents_publish_agent, subagents_unpublish_agent,
//    skills_publish_skill,   skills_unpublish_skill
//
// B. Other native-input modal kinds (deliberately NOT approvals — different
//    semantics, own flows): skills_ask_user_question (multi-question input),
//    agent-vm request_sensitive_information (secret entry),
//    agent-vm set_chat_workspace (chat-keyed consent grant).
//
// C. Model-side confirm=true parameter gates (the MODEL confirms with the
//    user in chat; no app modal): skills_delete_skill,
//    subagents_delete_agent, artifacts_delete_artifact,
//    mcp_assistant_delete_user_mcp_server,
//    mcp_assistant_configure_host_mcp_bridge_clients,
//    skills_apply_marketplace_sync_removals (second phase of a destructive
//    marketplace sync: the sync response's pendingRemovals list is relayed to
//    the user; the GUI equivalent is the sync-removal consent modal in
//    marketplace-sync-removal-modal.js).
//
// D. Credentialing flows (interactive grants, never batchable approvals):
//    mcp_assistant_authorize_integration (OAuth wizard),
//    mcp_assistant_trigger_guided_setup (config form),
//    git-marketplace routes' interactive GitLab auth.
//
// Known UNGATED destructive gaps (follow-up candidates for enrollment here):
//    skills_remove_marketplace (cascades installed skills),
//    skills_uninstall_marketplace_skill, scheduling delete_task.
// ---------------------------------------------------------------------------

const APPROVAL_FLOW_KINDS = Object.freeze({
  marketplace_publish: Object.freeze({
    kind: "marketplace_publish",
    modes: Object.freeze({
      "publish-agent": Object.freeze({
        tools: Object.freeze(["subagents_publish_agent"]),
        route: "/api/ai-marketplace/publish-agent",
        actionLabel: (request) => (request?.republish ? "Republish" : "Publish"),
        itemType: () => "agents",
        destructive: false,
        outwardFacing: true,
      }),
      "publish-skill": Object.freeze({
        tools: Object.freeze(["skills_publish_skill"]),
        route: "/api/ai-marketplace/publish-skill",
        actionLabel: (request) => (request?.republish ? "Republish" : "Publish"),
        itemType: () => "skills",
        destructive: false,
        outwardFacing: true,
      }),
      unpublish: Object.freeze({
        tools: Object.freeze([
          "subagents_unpublish_agent",
          "skills_unpublish_skill",
        ]),
        route: "/api/ai-marketplace/unpublish",
        actionLabel: () => "Unpublish",
        itemType: (request) => request?.solutionType || null,
        destructive: true,
        outwardFacing: true,
      }),
    }),
  }),
});

function approvalModesForKind(kind) {
  const entry = APPROVAL_FLOW_KINDS[kind];
  return entry ? Object.keys(entry.modes) : [];
}

function approvalDescriptor(kind, mode) {
  return APPROVAL_FLOW_KINDS[kind]?.modes?.[mode] || null;
}

module.exports = {
  APPROVAL_FLOW_KINDS,
  approvalModesForKind,
  approvalDescriptor,
};
