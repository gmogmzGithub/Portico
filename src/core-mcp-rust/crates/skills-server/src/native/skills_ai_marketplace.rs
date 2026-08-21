// AI Marketplace (native REST) tools for the Skills MCP server. These proxy to
// the Electron localhost HTTP API (ai-marketplace-operations.js) — the SAME
// endpoints the Subagents server uses — which owns the API key, viewer identity,
// install bookkeeping, and the publish confirmation modal.
//
// These are DISTINCT from the git-backed marketplace tools (list_marketplaces,
// install_marketplace_skill, ...): those operate on git repos; these are the
// native AI Marketplace, which is the DEFAULT (GitLab-free) way to share skills.
use super::*;

// Marketplace solutions are STORED with the plural type "skills"
// (publishSkillBundle in ai-marketplace-install.js) and the marketplace search
// filter is an exact string match — the historical singular "skill" matched
// nothing, hiding every published skill from chat.
const SKILL_SOLUTION_TYPE: &str = "skills";

async fn proxy_marketplace(path: &str, payload: Value) -> Result<Value> {
    let response = electron_post_json(path, &payload, 120.0).await?;
    if response.get("success").and_then(Value::as_bool) == Some(false) {
        return success_text(response);
    }
    success_text(response.get("data").cloned().unwrap_or(response))
}

// Confirmation-gated writes (publish / unpublish) use the app's standard
// long-flow contract instead of one blocking POST: the route answers with a
// pending flow id and electron_marketplace_confirmed_write polls the flow
// status while the user decides in the modal (300s decision window + publish
// execution — see marketplace-publish-confirm-flows.js).
async fn proxy_marketplace_confirmed(path: &str, payload: Value) -> Result<Value> {
    let response = electron_marketplace_confirmed_write(path, &payload).await?;
    if response.get("success").and_then(Value::as_bool) == Some(false) {
        // Tool ERROR, envelope verbatim: a denied/expired approval or failed
        // publish must never read as success to the model.
        return error_text(response);
    }
    success_text(response.get("data").cloned().unwrap_or(response))
}

pub(super) async fn handle_publish_skill(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_id = string_arg(arguments, "skill_id")?;
    let mut payload = json!({ "skill_id": skill_id });
    if let Some(existing) = arguments.get("existing_solution_id") {
        payload["existing_solution_id"] = existing.clone();
    }
    proxy_marketplace_confirmed("/api/ai-marketplace/publish-skill", payload).await
}

pub(super) async fn handle_unpublish_skill(arguments: &Map<String, Value>) -> Result<Value> {
    let solution_id = string_arg(arguments, "solution_id")?;
    proxy_marketplace_confirmed(
        "/api/ai-marketplace/unpublish",
        json!({ "id": solution_id, "expected_type": SKILL_SOLUTION_TYPE }),
    )
    .await
}

// In-place installed→editable conversion (the control plane's "Convert to
// editable copy"): detach into skills-user + relink to the same solution so
// Published state survives. Local-only and non-destructive, so it uses the
// plain proxy — no confirmation flow, same policy as install.
pub(super) async fn handle_reclaim_skill(arguments: &Map<String, Value>) -> Result<Value> {
    let skill_id = string_arg(arguments, "skill_id")?;
    proxy_marketplace(
        "/api/ai-marketplace/reclaim-skill",
        json!({ "skill_id": skill_id }),
    )
    .await
}

pub(super) async fn handle_install_marketplace_solution(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    let solution_id = string_arg(arguments, "solution_id")?;
    proxy_marketplace(
        "/api/ai-marketplace/install",
        json!({
            "id": solution_id,
            "expected_type": SKILL_SOLUTION_TYPE,
        }),
    )
    .await
}

pub(super) async fn handle_search_marketplace_solutions(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let payload = json!({
        "params": { "query": query, "filters": { "type": SKILL_SOLUTION_TYPE } }
    });
    proxy_marketplace("/api/ai-marketplace/search", payload).await
}

pub(super) async fn handle_get_marketplace_solution(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    let solution_id = string_arg(arguments, "solution_id")?;
    proxy_marketplace(
        "/api/ai-marketplace/get-solution",
        json!({ "id": solution_id, "expected_type": SKILL_SOLUTION_TYPE }),
    )
    .await
}

pub(super) async fn handle_get_marketplace_bundle(arguments: &Map<String, Value>) -> Result<Value> {
    let solution_id = string_arg(arguments, "solution_id")?;
    proxy_marketplace(
        "/api/ai-marketplace/get-bundle",
        json!({ "id": solution_id, "expected_type": SKILL_SOLUTION_TYPE }),
    )
    .await
}

pub(super) async fn handle_list_published_skills(_arguments: &Map<String, Value>) -> Result<Value> {
    proxy_marketplace(
        "/api/ai-marketplace/list-published",
        json!({ "type": SKILL_SOLUTION_TYPE }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn publish_skill_requires_skill_id() {
        assert!(handle_publish_skill(&Map::new()).await.is_err());
    }

    #[tokio::test]
    async fn id_taking_tools_require_solution_id() {
        assert!(handle_unpublish_skill(&Map::new()).await.is_err());
        assert!(handle_install_marketplace_solution(&Map::new())
            .await
            .is_err());
        assert!(handle_get_marketplace_solution(&Map::new()).await.is_err());
        assert!(handle_get_marketplace_bundle(&Map::new()).await.is_err());
    }

    #[tokio::test]
    async fn reclaim_skill_requires_skill_id() {
        assert!(handle_reclaim_skill(&Map::new()).await.is_err());
    }
}
