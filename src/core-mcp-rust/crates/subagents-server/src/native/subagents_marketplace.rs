// AI Marketplace tools for the Subagents MCP server. These are thin proxies to
// the Electron localhost HTTP API (ai-marketplace-operations.js), which owns the
// API key, viewer identity, install bookkeeping, and the publish/unpublish
// confirmation modal. Publishing an agent means publishing an existing LOCAL
// agent by id; the Electron side fetches it (via get_agent), builds the bundle,
// and asks the human to confirm before it goes out.
use super::*;

const AGENT_SOLUTION_TYPE: &str = "portico-agents";

// Proxy a request to the Electron marketplace API and unwrap the { success,
// data } envelope. Semantic failures remain structured JSON so callers through
// the Host MCP Bridge retain code/error/remediation instead of receiving a
// flattened transport error.
async fn proxy_marketplace(path: &str, payload: Value) -> Result<Value> {
    let response = electron_post_json(path, &payload, 120.0).await?;
    if response.get("success").and_then(Value::as_bool) == Some(false) {
        return success_text(response);
    }
    success_text(response.get("data").cloned().unwrap_or(response))
}

// Confirmation-gated writes (publish / unpublish) go through the app's
// standard long-flow contract instead of one blocking POST: the route answers
// with a pending flow id and electron_marketplace_confirmed_write polls the
// flow status while the user decides in the modal (300s decision window +
// publish execution — see marketplace-publish-confirm-flows.js).
async fn proxy_marketplace_confirmed(path: &str, payload: Value) -> Result<Value> {
    let response = electron_marketplace_confirmed_write(path, &payload).await?;
    if response.get("success").and_then(Value::as_bool) == Some(false) {
        // Tool ERROR, envelope verbatim: a denied/expired approval or failed
        // publish must never read as success to the model.
        return error_text(response);
    }
    success_text(response.get("data").cloned().unwrap_or(response))
}

pub(super) async fn handle_publish_agent(arguments: &Map<String, Value>) -> Result<Value> {
    let agent_id = string_arg(arguments, "agent_id")?;
    let mut payload = json!({ "agent_id": agent_id });
    if let Some(emails) = arguments.get("allowed_emails") {
        payload["allowed_emails"] = emails.clone();
    }
    if let Some(existing) = arguments.get("existing_solution_id") {
        payload["existing_solution_id"] = existing.clone();
    }
    proxy_marketplace_confirmed("/api/ai-marketplace/publish-agent", payload).await
}

pub(super) async fn handle_unpublish_agent(arguments: &Map<String, Value>) -> Result<Value> {
    let solution_id = string_arg(arguments, "solution_id")?;
    proxy_marketplace_confirmed(
        "/api/ai-marketplace/unpublish",
        json!({ "id": solution_id, "expected_type": AGENT_SOLUTION_TYPE }),
    )
    .await
}

pub(super) async fn handle_install_agent(arguments: &Map<String, Value>) -> Result<Value> {
    let solution_id = string_arg(arguments, "solution_id")?;
    let mut payload = json!({
        "id": solution_id,
        "expected_type": AGENT_SOLUTION_TYPE,
    });
    if let Some(existing) = arguments.get("existing_agent_id") {
        payload["existing_agent_id"] = existing.clone();
    }
    proxy_marketplace("/api/ai-marketplace/install", payload).await
}

// In-place installed→editable conversion (the control plane's "Convert to
// editable copy"). Local-only and non-destructive, so it uses the plain proxy
// — no confirmation flow, same policy as install_agent.
pub(super) async fn handle_reclaim_agent(arguments: &Map<String, Value>) -> Result<Value> {
    let agent_id = string_arg(arguments, "agent_id")?;
    proxy_marketplace(
        "/api/ai-marketplace/reclaim-agent",
        json!({ "agent_id": agent_id }),
    )
    .await
}

pub(super) async fn handle_search_marketplace_agents(
    arguments: &Map<String, Value>,
) -> Result<Value> {
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let payload = json!({
        "params": { "query": query, "filters": { "type": AGENT_SOLUTION_TYPE } }
    });
    proxy_marketplace("/api/ai-marketplace/search", payload).await
}

pub(super) async fn handle_get_marketplace_agent(arguments: &Map<String, Value>) -> Result<Value> {
    let solution_id = string_arg(arguments, "solution_id")?;
    proxy_marketplace(
        "/api/ai-marketplace/get-solution",
        json!({ "id": solution_id, "expected_type": AGENT_SOLUTION_TYPE }),
    )
    .await
}

pub(super) async fn handle_list_published_agents(_arguments: &Map<String, Value>) -> Result<Value> {
    proxy_marketplace(
        "/api/ai-marketplace/list-published",
        json!({ "type": AGENT_SOLUTION_TYPE }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn publish_agent_requires_agent_id() {
        let result = handle_publish_agent(&Map::new()).await;
        assert!(result.is_err(), "publish_agent should require agent_id");
    }

    #[tokio::test]
    async fn unpublish_and_get_require_solution_id() {
        assert!(handle_unpublish_agent(&Map::new()).await.is_err());
        assert!(handle_get_marketplace_agent(&Map::new()).await.is_err());
        assert!(handle_install_agent(&Map::new()).await.is_err());
    }

    #[tokio::test]
    async fn reclaim_agent_requires_agent_id() {
        assert!(handle_reclaim_agent(&Map::new()).await.is_err());
    }

    #[test]
    fn agent_solution_type_matches_publish_builder() {
        // Must match TYPE_PORTICO_AGENTS on the Electron side so search /
        // list filter the right solutions.
        assert_eq!(AGENT_SOLUTION_TYPE, "portico-agents");
    }
}
