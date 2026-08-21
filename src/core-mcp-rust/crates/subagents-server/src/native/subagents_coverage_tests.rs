use super::*;
use std::time::Duration;

#[test]
fn subagent_run_uses_two_hour_budget_and_five_second_polling() {
    assert_eq!(SUBAGENT_RUN_TIMEOUT_SECONDS, 7_200);
    assert_eq!(POLL_INTERVAL_SECONDS, 5);
}

#[test]
fn helper_edges_cover_missing_tool_ids_bad_yaml_and_prompt_defaults() {
    let env = TestEnv::new("coverage-helpers");
    fs::create_dir_all(env.root.join("mcp-configs/broken")).unwrap();
    fs::write(
        env.root.join("mcp-configs/broken/broken.yaml"),
        "not: [valid",
    )
    .unwrap();

    let tools_map = build_tools_map(&json!([
        { "name": "Missing ID" },
        { "id": "server:broken", "name": "Broken Tool" },
        { "id": "server:plain", "name": "Plain Tool" }
    ]))
    .unwrap();
    assert!(!tools_map.contains_key("Missing ID"));
    assert_eq!(load_mcp_server_description("server:broken"), None);

    let filtered = filter_agent_value(
        &json!({
            "id": "agent-empty-prompt",
            "name": "Agent Empty Prompt",
            "meta": { "description": "demo" },
            "params": {}
        }),
        true,
        &tools_map,
    );
    assert_eq!(filtered["system_prompt"], json!(""));
}

#[test]
fn icon_and_message_helpers_cover_all_branches() {
    let _env = TestEnv::new("icon");
    let app_root = if Path::new("/app").exists() {
        PathBuf::from("/app")
    } else {
        std::env::current_dir().expect("current dir should resolve")
    };
    let assets_dir = app_root.join("assets");
    fs::create_dir_all(&assets_dir).unwrap();
    let icon_path = assets_dir.join("agent-icon.png");
    fs::write(&icon_path, b"png-bytes").unwrap();
    let data_url = load_agent_icon_data_url();
    assert!(data_url.starts_with("data:image/png;base64,"));
    fs::remove_file(&icon_path).unwrap();
    assert_eq!(load_agent_icon_data_url(), "/static/favicon.png");

    assert!(!message_is_complete(
        &json!({ "role": "user", "content": "no" })
    ));
    assert!(message_is_complete(
        &json!({ "role": "assistant", "done": true })
    ));
    assert!(!message_is_complete(
        &json!({ "role": "assistant", "finish_reason": "stop" })
    ));
    assert!(!message_is_complete(
        &json!({ "role": "assistant", "finishReason": "stop" })
    ));
    assert!(!message_is_complete(
        &json!({ "role": "assistant", "lastSentence": "done" })
    ));
    assert!(!message_is_complete(
        &json!({ "role": "assistant", "content": "done" })
    ));
    assert!(message_is_complete(&json!({
        "role": "assistant",
        "content": "done",
        "usage": { "prompt_tokens": 4 }
    })));
    assert!(!message_is_complete(&json!({
        "role": "assistant",
        "contentBlocks": [{
            "type": "tool_calls",
            "content": [{ "id": "tool-1" }],
            "results": [],
        }],
        "usage": { "prompt_tokens": 4 }
    })));
    assert!(!message_is_complete(
        &json!({ "role": "assistant", "content": "" })
    ));
}

#[tokio::test]
async fn update_agent_covers_existing_params_branch() {
    let env = TestEnv::new("coverage-update");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("user-99");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/models/model?id=agent-existing-params") => {
                    MockResponse::json(json!({
                        "id": "agent-existing-params",
                        "name": "Existing Agent",
                        "base_model_id": "base-old",
                        "params": { "temperature": 0.3 },
                        "meta": {
                            "description": "before",
                            "toolIds": [],
                            "subagent_creation_source": "local",
                            "subagent_created_by_email": "user@example.invalid"
                        },
                        "user": { "id": "user-99" }
                    }))
                }
                ("POST", "/api/v1/models/model/update?id=agent%2Dexisting%2Dparams") => {
                    MockResponse::json(json!({
                        "id": "agent-existing-params",
                        "name": "Updated Agent",
                        "base_model_id": "base-old",
                        "params": { "temperature": 0.3, "system": "Be precise." },
                        "meta": { "description": "after", "toolIds": [] }
                    }))
                }
                ("GET", "/api/v1/tools/") => MockResponse::json(json!([])),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    let updated = response_payload(
        handle_update_agent(&args(&[
            ("model_id", json!("agent-existing-params")),
            ("system_prompt", json!("Be precise.")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(updated["id"], json!("agent-existing-params"));

    let request = server
        .requests()
        .into_iter()
        .find(|request| {
            request.method == "POST"
                && request.path == "/api/v1/models/model/update?id=agent%2Dexisting%2Dparams"
        })
        .expect("missing update request");
    let body: Value = serde_json::from_str(&request.body).unwrap();
    assert_eq!(body["params"]["temperature"], json!(0.3));
    assert_eq!(body["params"]["system"], json!("Be precise."));
}

#[tokio::test]
async fn agent_handlers_skip_tool_enrichment_when_tools_endpoint_fails() {
    let env = TestEnv::new("coverage-tool-fallback");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("user-42");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/agent-attribution/current-user") => {
                    MockResponse::json(json!({ "email": "user@example.invalid" }))
                }
                ("GET", "/api/models?") => MockResponse::json(json!({
                    "data": [{ "id": "base-model", "name": "Base Model" }]
                })),
                ("GET", "/api/v1/models/model?id=agent-fallback") => MockResponse::json(json!({
                    "id": "agent-fallback",
                    "name": "Fallback Agent",
                    "base_model_id": "base-model",
                    "meta": { "description": "fallback", "toolIds": ["server:time"] },
                    "params": { "system": "Be precise." }
                })),
                ("POST", "/api/v1/models/create") => MockResponse::json(json!({
                    "id": "agent-create",
                    "name": "Agent Create",
                    "base_model_id": "base-model",
                    "meta": { "description": "created", "toolIds": ["server:time"] },
                    "params": { "system": "Create prompt" }
                })),
                ("GET", "/api/v1/models/model?id=agent-update") => MockResponse::json(json!({
                    "id": "agent-update",
                    "name": "Agent Update",
                    "base_model_id": "base-model",
                    "meta": {
                        "description": "before",
                        "toolIds": ["server:time"],
                        "subagent_creation_source": "local",
                        "subagent_created_by_email": "user@example.invalid"
                    },
                    "params": { "system": "before" },
                    "user": { "id": "user-42" }
                })),
                ("POST", "/api/v1/models/model/update?id=agent%2Dupdate") => {
                    MockResponse::json(json!({
                        "id": "agent-update",
                        "name": "Agent Update",
                        "base_model_id": "base-model",
                        "meta": { "description": "after", "toolIds": ["server:time"] },
                        "params": { "system": "after" }
                    }))
                }
                ("GET", "/api/v1/tools/") => MockResponse {
                    status: 500,
                    body: json!({ "error": "tools unavailable" }),
                },
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let fetched = response_payload(
        handle_get_agent(&args(&[("model_id", json!("agent-fallback"))]))
            .await
            .unwrap(),
    );
    assert_eq!(fetched["tools"], json!([]));

    let created = response_payload(
        handle_create_agent(&args(&[
            ("name", json!("Agent Create")),
            ("base_model_id", json!("base-model")),
            ("system_prompt", json!("Create prompt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(created["id"], json!("agent-create"));
    assert_eq!(created["tools"], json!([]));

    let updated = response_payload(
        handle_update_agent(&args(&[
            ("model_id", json!("agent-update")),
            ("description", json!("after")),
            ("system_prompt", json!("after")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(updated["id"], json!("agent-update"));
    assert_eq!(updated["tools"], json!([]));
}

#[tokio::test]
async fn timeout_helper_covers_incomplete_chat_path() {
    let env = TestEnv::new("coverage-timeout");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/chats/chat-timeout") => MockResponse::json(json!({
                    "chat": {
                        "models": ["default-model"],
                        "history": { "messages": {} },
                        "messages": [{ "role": "assistant", "content": "", "done": false }]
                    }
                })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    assert_err_contains(
        poll_subagent_completion_with_timeout(
            "token",
            "chat-timeout",
            "Claude Opus 4.6",
            None,
            Duration::ZERO,
            Duration::from_millis(0),
        )
        .await,
        "Chat did not complete",
    );
}

#[tokio::test]
async fn poll_helper_covers_retry_sleep_then_success_path() {
    let env = TestEnv::new("coverage-retry");
    let pending = json!({
        "chat": {
            "models": ["default-model"],
            "history": { "messages": {} },
            "messages": [{ "role": "assistant", "content": "", "done": false }]
        }
    });
    let completed = json!({
        "chat": {
            "models": ["default-model"],
            "history": { "messages": {} },
            "messages": [{ "role": "assistant", "lastSentence": "done", "done": true }]
        }
    });
    let responses = std::sync::Arc::new(std::sync::Mutex::new(vec![
        pending.clone(),
        completed.clone(),
        completed.clone(),
        completed.clone(),
        completed.clone(),
    ]));
    let fallback = completed.clone();
    let server = MockServer::start({
        let responses = std::sync::Arc::clone(&responses);
        let fallback = fallback.clone();
        move |request| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/v1/chats/chat-retry") => {
                let response = {
                    let mut responses = responses
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    if responses.len() > 1 {
                        responses.remove(0)
                    } else {
                        responses
                            .first()
                            .cloned()
                            .unwrap_or_else(|| fallback.clone())
                    }
                };
                MockResponse::json(response)
            }
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "unexpected" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let result = poll_subagent_completion_with_timeout(
        "token",
        "chat-retry",
        "Claude Opus 4.6",
        None,
        Duration::from_millis(500),
        Duration::from_millis(1),
    )
    .await
    .unwrap();
    assert_eq!(result["response"], json!("done"));
}

#[tokio::test]
async fn poll_helper_treats_done_messages_with_stale_tool_finish_reason_as_complete() {
    let env = TestEnv::new("coverage-stale-tool-finish-reason");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/chats/chat-stale-tool-finish-reason") => {
                    MockResponse::json(json!({
                        "chat": {
                            "models": ["default-model"],
                            "history": { "messages": {} },
                            "messages": [{
                                "role": "assistant",
                                "lastSentence": "done",
                                "content": "done",
                                "done": true,
                                "finish_reason": "tool_calls",
                                "usage": { "prompt_tokens": 7 }
                            }]
                        }
                    }))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    let result = poll_subagent_completion_with_timeout(
        "token",
        "chat-stale-tool-finish-reason",
        "Claude Opus 4.6",
        None,
        Duration::from_millis(100),
        Duration::from_millis(1),
    )
    .await
    .unwrap();
    assert_eq!(result["response"], json!("done"));
}

#[tokio::test]
async fn poll_helper_aborts_when_parent_cancel_signal_exists() {
    let env = TestEnv::new("coverage-cancel");
    env.set_openwebui_base_url("http://127.0.0.1:9");
    redis_set_string("subagent_cancel:chat-cancel", "1").unwrap();
    assert_err_contains(
        poll_subagent_completion_with_timeout(
            "token",
            "chat-cancel",
            "Claude Opus 4.6",
            None,
            Duration::from_secs(1),
            Duration::from_millis(1),
        )
        .await,
        "Parent task cancelled",
    );
    assert_eq!(
        redis_get_string("subagent_cancel:chat-cancel").unwrap(),
        None
    );
}

#[tokio::test]
async fn poll_helper_returns_partial_response_for_context_window_errors() {
    let env = TestEnv::new("coverage-context-window");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/chats/chat-context-window") => MockResponse::json(json!({
                    "chat": {
                        "models": ["default-model"],
                        "history": {
                            "messages": {
                                "assistant-1": {
                                    "role": "assistant",
                                    "content": "Partial answer",
                                    "error": {"message": "Context window exceeded"},
                                    "usage": { "prompt_tokens": 321 }
                                }
                            }
                        },
                        "messages": []
                    }
                })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    let result = poll_subagent_completion_with_timeout(
        "token",
        "chat-context-window",
        "Claude Opus 4.6",
        None,
        Duration::from_secs(1),
        Duration::from_millis(1),
    )
    .await
    .unwrap();
    assert_eq!(result["success"], json!(false));
    assert_eq!(result["response"], json!("Partial answer"));
    assert!(result["error"]
        .as_str()
        .unwrap_or_default()
        .contains("partial response"));
    assert_eq!(extract_usage_from_chat(&result["chat_data"]), 321);
}

#[tokio::test]
async fn poll_helper_returns_structured_transient_failure_for_upstream_stream_errors() {
    let env = TestEnv::new("coverage-transient-upstream");
    let server = MockServer::start(|request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/v1/chats/chat-transient-upstream") => MockResponse::json(json!({
                "chat": {
                    "models": ["default-model"],
                    "history": {
                        "messages": {
                            "assistant-1": {
                                "role": "assistant",
                                "content": "Partial answer",
                                "error": {"content": "Upstream model provider stream failed. Please retry."},
                                "usage": { "prompt_tokens": 42 }
                            }
                        }
                    },
                    "messages": []
                }
            })),
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "unexpected" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let result = poll_subagent_completion_with_timeout(
        "token",
        "chat-transient-upstream",
        "Claude Opus 4.6",
        None,
        Duration::from_secs(1),
        Duration::from_millis(1),
    )
    .await
    .unwrap();
    assert_eq!(result["success"], json!(false));
    assert_eq!(result["response"], json!("Partial answer"));
    assert_eq!(result["transient_upstream_failure"], json!(true));
    assert!(result["error"]
        .as_str()
        .unwrap_or_default()
        .contains("Transient sub-agent completion failure"));
    assert_eq!(extract_usage_from_chat(&result["chat_data"]), 42);
}

#[tokio::test]
async fn agent_handlers_fall_back_when_tools_lookup_fails() {
    let env = TestEnv::new("coverage-tools-fallback");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("user-42");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/agent-attribution/current-user") => {
                    MockResponse::json(json!({ "email": "user@example.invalid" }))
                }
                ("GET", "/api/models") => MockResponse::json(json!([
                    {
                        "id": "agent-listed",
                        "name": "Listed Agent",
                        "base_model_id": "base-model",
                        "meta": { "description": "Listed", "toolIds": ["server:missing"] }
                    }
                ])),
                ("GET", "/api/models?") => MockResponse::json(json!({
                    "data": [{ "id": "base-model", "name": "Base Model" }]
                })),
                ("GET", "/api/v1/tools/") => MockResponse {
                    status: 500,
                    body: json!({ "error": "tools unavailable" }),
                },
                ("GET", "/api/v1/models/model?id=agent-lookup") => MockResponse::json(json!({
                    "id": "agent-lookup",
                    "name": "Lookup Agent",
                    "base_model_id": "base-model",
                    "meta": { "description": "Lookup", "toolIds": ["server:missing"] }
                })),
                ("GET", "/api/v1/models/model?id=agent-update") => MockResponse::json(json!({
                    "id": "agent-update",
                    "name": "Agent Update",
                    "base_model_id": "base-model",
                    "meta": {
                        "description": "Before",
                        "toolIds": ["server:missing"],
                        "subagent_creation_source": "local",
                        "subagent_created_by_email": "user@example.invalid"
                    },
                    "params": {}
                })),
                ("POST", "/api/v1/models/create") => MockResponse::json(json!({
                    "id": "agent-created",
                    "name": "Agent Created",
                    "base_model_id": "base-model",
                    "meta": { "description": "Created", "toolIds": ["server:missing"] },
                    "params": { "system": "Be precise." }
                })),
                ("POST", "/api/v1/models/model/update?id=agent%2Dupdate") => {
                    MockResponse::json(json!({
                        "id": "agent-update",
                        "name": "Agent Update",
                        "base_model_id": "base-model",
                        "meta": { "description": "After", "toolIds": ["server:missing"] },
                        "params": { "system": "Updated." }
                    }))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let listed = response_payload(handle_list_agents(&Map::new()).await.unwrap());
    let fetched = response_payload(
        handle_get_agent(&args(&[("model_id", json!("agent-lookup"))]))
            .await
            .unwrap(),
    );
    let created = response_payload(
        handle_create_agent(&args(&[
            ("name", json!("Agent Created")),
            ("base_model_id", json!("base-model")),
            ("description", json!("Created")),
        ]))
        .await
        .unwrap(),
    );
    let updated = response_payload(
        handle_update_agent(&args(&[
            ("model_id", json!("agent-update")),
            ("description", json!("After")),
            ("system_prompt", json!("Updated.")),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(listed[0]["tools"], json!([]));
    assert_eq!(fetched["tools"], json!([]));
    assert_eq!(created["tools"], json!([]));
    assert_eq!(updated["tools"], json!([]));
}

#[tokio::test]
async fn poll_helper_stops_when_parent_cancel_signal_is_present() {
    let _env = TestEnv::new("coverage-cancel");
    redis_set_string("subagent_cancel:chat-cancel", "1").unwrap();
    assert_err_contains(
        poll_subagent_completion_with_timeout(
            "token",
            "chat-cancel",
            "Claude Opus 4.6",
            None,
            Duration::from_secs(1),
            Duration::from_millis(1),
        )
        .await,
        "Parent task cancelled",
    );
    assert_eq!(
        redis_get_string("subagent_cancel:chat-cancel").unwrap(),
        None
    );
}

#[tokio::test]
async fn delete_agent_can_succeed_even_if_model_lookup_fails() {
    let env = TestEnv::new("coverage-delete-fallback");
    env.set_openwebui_token("token");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/models/model?id=agent%2Dorphan") => MockResponse {
                    status: 404,
                    body: json!({ "error": "missing" }),
                },
                ("GET", "/api/models/agent%2Dorphan") => MockResponse {
                    status: 404,
                    body: json!({ "error": "missing" }),
                },
                ("GET", "/api/v1/models/agent%2Dorphan") => MockResponse {
                    status: 404,
                    body: json!({ "error": "missing" }),
                },
                ("POST", "/api/v1/models/model/delete") => MockResponse {
                    status: 500,
                    body: json!({ "error": "nope" }),
                },
                ("DELETE", "/api/v1/models/model/delete?id=agent%2Dorphan") => {
                    MockResponse::json(json!({ "success": true }))
                }
                ("POST", "/api/ai-marketplace/clear-deleted-agent-link") => {
                    MockResponse::json(json!({ "success": true, "data": { "cleared": true } }))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let deleted = response_payload(
        handle_delete_agent(&args(&[("model_id", json!("agent-orphan")), ("confirm", json!(true))]))
            .await
            .unwrap(),
    );
    assert_eq!(deleted["success"], json!(true));
}

#[tokio::test]
async fn delete_agent_uses_legacy_query_delete_when_lookup_fails() {
    let env = TestEnv::new("coverage-delete-query");
    env.set_openwebui_token("token");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/models/model?id=agent-legacy") => MockResponse {
                    status: 404,
                    body: json!({ "error": "missing" }),
                },
                ("GET", "/api/models/agent%2Dlegacy") => MockResponse {
                    status: 404,
                    body: json!({ "error": "missing" }),
                },
                ("GET", "/api/v1/models/agent%2Dlegacy") => MockResponse {
                    status: 404,
                    body: json!({ "error": "missing" }),
                },
                ("POST", "/api/v1/models/model/delete") => MockResponse {
                    status: 500,
                    body: json!({ "error": "retry" }),
                },
                ("DELETE", "/api/v1/models/model/delete?id=agent%2Dlegacy") => {
                    MockResponse::json(json!({ "success": true }))
                }
                ("POST", "/api/ai-marketplace/clear-deleted-agent-link") => {
                    MockResponse::json(json!({ "success": true, "data": { "cleared": true } }))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let deleted = response_payload(
        handle_delete_agent(&args(&[("model_id", json!("agent-legacy")), ("confirm", json!(true))]))
            .await
            .unwrap(),
    );
    assert_eq!(deleted["success"], json!(true));
    assert!(server.requests().iter().any(|request| {
        request.method == "DELETE"
            && request.path == "/api/v1/models/model/delete?id=agent%2Dlegacy"
    }));
}

#[tokio::test]
async fn agent_handlers_fallback_when_tool_lookup_fails() {
    let env = TestEnv::new("coverage-tool-fallback");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("user-1");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/agent-attribution/current-user") => {
                    MockResponse::json(json!({ "email": "user@example.invalid" }))
                }
                ("GET", "/api/models") => MockResponse::json(json!([{
                    "id": "derived-agent",
                    "name": "Derived Agent",
                    "is_active": true,
                    "base_model_id": "base-model",
                    "meta": { "description": "fallback" }
                }])),
                ("GET", "/api/models?") => MockResponse::json(json!({
                    "data": [{ "id": "base-model", "name": "Base Model" }]
                })),
                ("GET", "/api/v1/models/model?id=derived-agent") => MockResponse::json(json!({
                    "id": "derived-agent",
                    "name": "Derived Agent",
                    "base_model_id": "base-model",
                    "meta": {
                        "description": "fallback",
                        "toolIds": ["server:time"],
                        "subagent_creation_source": "local",
                        "subagent_created_by_email": "user@example.invalid"
                    }
                })),
                ("POST", "/api/v1/models/create") => MockResponse::json(json!({
                    "id": "created-agent",
                    "name": "Created Agent",
                    "base_model_id": "base-model",
                    "meta": { "description": "created", "toolIds": ["server:time"] }
                })),
                ("POST", "/api/v1/models/model/update?id=derived%2Dagent") => {
                    MockResponse::json(json!({
                        "id": "derived-agent",
                        "name": "Derived Agent",
                        "base_model_id": "base-model",
                        "meta": { "description": "updated", "toolIds": ["server:time"] }
                    }))
                }
                ("GET", "/api/v1/tools/") => MockResponse {
                    status: 500,
                    body: json!({ "error": "tools unavailable" }),
                },
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let listed = response_payload(
        handle_list_agents(&args(&[("filter_type", json!("all"))]))
            .await
            .unwrap(),
    );
    assert_eq!(listed[0]["id"], json!("derived-agent"));
    assert_eq!(listed[0]["tools"], json!([]));

    let fetched = response_payload(
        handle_get_agent(&args(&[("model_id", json!("derived-agent"))]))
            .await
            .unwrap(),
    );
    assert_eq!(fetched["tools"], json!([]));

    let created = response_payload(
        handle_create_agent(&args(&[
            ("name", json!("Created Agent")),
            ("base_model_id", json!("base-model")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(created["id"], json!("created-agent"));
    assert_eq!(created["tools"], json!([]));

    let updated = response_payload(
        handle_update_agent(&args(&[
            ("model_id", json!("derived-agent")),
            ("description", json!("updated")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(updated["description"], json!("updated"));
    assert_eq!(updated["tools"], json!([]));
}

#[tokio::test]
async fn poll_helper_respects_parent_cancellation_signal() {
    let env = TestEnv::new("coverage-cancel");
    redis_set_string("subagent_cancel:chat-cancel", "1").unwrap();
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/chats/chat-cancel") => {
                    MockResponse::json(json!({ "unexpected": true }))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    assert_err_contains(
        poll_subagent_completion_with_timeout(
            "token",
            "chat-cancel",
            "Claude Opus 4.6",
            None,
            Duration::from_secs(1),
            Duration::from_millis(1),
        )
        .await,
        "Parent task cancelled",
    );
    assert_eq!(
        redis_get_string("subagent_cancel:chat-cancel").unwrap(),
        None
    );
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn delete_agent_uses_python_compatibility_delete_fallbacks() {
    let env = TestEnv::new("coverage-delete-fallback");
    env.set_openwebui_token("token");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/models/model?id=agent-delete") => MockResponse {
                    status: 404,
                    body: json!({ "error": "missing" }),
                },
                ("GET", "/api/models/agent%2Ddelete") => MockResponse {
                    status: 404,
                    body: json!({ "error": "missing" }),
                },
                ("GET", "/api/v1/models/agent%2Ddelete") => MockResponse {
                    status: 404,
                    body: json!({ "error": "missing" }),
                },
                ("POST", "/api/v1/models/model/delete") => MockResponse {
                    status: 500,
                    body: json!({ "error": "post failed" }),
                },
                ("DELETE", "/api/v1/models/model/delete?id=agent%2Ddelete") => {
                    MockResponse::json(json!({ "success": true }))
                }
                ("POST", "/api/ai-marketplace/clear-deleted-agent-link") => {
                    MockResponse::json(json!({ "success": true, "data": { "cleared": true } }))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());
    env.set_electron_api_base(server.base_url());

    let result = response_payload(
        handle_delete_agent(&args(&[("model_id", json!("agent-delete")), ("confirm", json!(true))]))
            .await
            .unwrap(),
    );
    assert_eq!(result["success"], json!(true));
    let delete_paths = server
        .requests()
        .into_iter()
        .filter(|request| request.method == "DELETE" || request.path.contains("/delete"))
        .map(|request| request.path)
        .collect::<Vec<_>>();
    assert!(delete_paths.contains(&"/api/v1/models/model/delete?id=agent%2Ddelete".to_string()));
}

#[tokio::test]
async fn poll_helper_bails_on_non_context_window_errors() {
    let env = TestEnv::new("coverage-chat-error");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/chats/chat-error") => MockResponse::json(json!({
                    "chat": {
                        "models": ["default-model"],
                        "history": {
                            "messages": {
                                "assistant-1": {
                                    "role": "assistant",
                                    "content": "partial output",
                                    "error": { "detail": "Upstream failed hard" }
                                }
                            }
                        }
                    }
                })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    assert_err_contains(
        poll_subagent_completion_with_timeout(
            "token",
            "chat-error",
            "Claude Opus 4.6",
            None,
            Duration::from_secs(1),
            Duration::from_millis(0),
        )
        .await,
        "Chat completion failed: Upstream failed hard",
    );
}

#[tokio::test]
async fn run_subagent_retries_transient_upstream_failures() {
    let env = TestEnv::new("coverage-run-subagent-retry");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("user-1");

    let created_chat_ids = std::sync::Arc::new(std::sync::Mutex::new(vec![
        "chat-retry-1".to_string(),
        "chat-retry-2".to_string(),
    ]));
    let created_task_ids = std::sync::Arc::new(std::sync::Mutex::new(vec![
        "task-retry-1".to_string(),
        "task-retry-2".to_string(),
    ]));

    let server = MockServer::start({
        let created_chat_ids = std::sync::Arc::clone(&created_chat_ids);
        let created_task_ids = std::sync::Arc::clone(&created_task_ids);
        move |request| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/models?") => MockResponse::json(json!({
                "data": [{ "id": "Claude Opus 4.6", "name": "Claude Opus 4.6" }]
            })),
            ("GET", "/api/v1/folders/") => {
                MockResponse::json(json!([{ "id": "folder-subagents", "name": "Sub-agents" }]))
            }
            ("POST", "/api/v1/chats/new") => {
                let chat_id = created_chat_ids
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .remove(0);
                MockResponse::json(json!({ "id": chat_id }))
            }
            ("POST", "/api/chat/completions") => {
                let task_id = created_task_ids
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .remove(0);
                MockResponse::json(json!({ "task_id": task_id }))
            }
            ("GET", "/api/v1/chats/chat-retry-1") => MockResponse::json(json!({
                "chat": {
                    "models": ["Claude Opus 4.6"],
                    "history": {
                        "messages": {
                            "assistant-1": {
                                "role": "assistant",
                                "content": "Partial answer from interrupted stream",
                                "error": { "content": "Upstream model provider stream failed. Please retry." },
                                "usage": { "prompt_tokens": 11 }
                            }
                        }
                    },
                    "messages": []
                }
            })),
            ("GET", "/api/v1/chats/chat-retry-2") => MockResponse::json(json!({
                "chat": {
                    "models": ["Claude Opus 4.6"],
                    "history": {
                        "messages": {
                            "user-1": {
                                "id": "user-1",
                                "role": "user",
                                "content": "Investigate",
                                "timestamp": 123,
                                "models": ["Claude Opus 4.6"]
                            },
                            "assistant-2": {
                                "id": "assistant-2",
                                "role": "assistant",
                                "content": "Recovered report",
                                "finishReason": "stop",
                                "usage": { "prompt_tokens": 7 }
                            }
                        }
                    },
                    "messages": [
                        { "role": "user", "content": "Investigate" },
                        {
                            "role": "assistant",
                            "content": "Recovered report",
                            "finishReason": "stop",
                            "usage": { "prompt_tokens": 7 }
                        }
                    ]
                }
            })),
            ("POST", "/api/v1/chats/chat-retry-2") => {
                MockResponse::json(json!({ "success": true }))
            }
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "unexpected" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let result = response_payload(
        handle_run_subagent(&args(&[
            ("prompt", json!("Investigate")),
            ("model", json!("Claude Opus 4.6")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(result["success"], json!(true));
    assert_eq!(result["chat_id"], json!("chat-retry-2"));
    assert_eq!(result["task_id"], json!("task-retry-2"));
    assert_eq!(result["response"], json!("Recovered report"));

    let completion_calls = server
        .requests()
        .into_iter()
        .filter(|request| request.method == "POST" && request.path == "/api/chat/completions")
        .count();
    assert_eq!(completion_calls, 2);
}

#[tokio::test]
async fn run_subagent_timeout_budget_is_shared_across_transient_retries() {
    let env = TestEnv::new("coverage-run-subagent-shared-timeout");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("user-1");

    let server = MockServer::start(|request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/models?") => MockResponse::json(json!({
                "data": [{ "id": "Claude Opus 4.6", "name": "Claude Opus 4.6" }]
            })),
            ("GET", "/api/v1/folders/") => {
                MockResponse::json(json!([{ "id": "folder-subagents", "name": "Sub-agents" }]))
            }
            ("POST", "/api/v1/chats/new") => {
                MockResponse::json(json!({ "id": "chat-shared-timeout" }))
            }
            ("POST", "/api/chat/completions") => {
                MockResponse::json(json!({ "task_id": "task-shared-timeout" }))
            }
            ("GET", "/api/v1/chats/chat-shared-timeout") => MockResponse::json(json!({
                "chat": {
                    "models": ["Claude Opus 4.6"],
                    "history": {
                        "messages": {
                            "assistant-1": {
                                "role": "assistant",
                                "content": "Partial answer from interrupted stream",
                                "error": {
                                    "content": "Upstream model provider stream failed. Please retry."
                                }
                            }
                        }
                    },
                    "messages": []
                }
            })),
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "unexpected" }),
            },
        }
    });
    env.set_openwebui_base_url(server.base_url());

    assert_err_contains(
        run_subagent_with_timeout(
            RunSubagentRequest {
                model: Some("Claude Opus 4.6".to_string()),
                prompt: "Investigate".to_string(),
                ..RunSubagentRequest::default()
            },
            Duration::from_millis(250),
        )
        .await,
        "Chat did not complete within 250ms",
    );

    let completion_calls = server
        .requests()
        .into_iter()
        .filter(|request| request.method == "POST" && request.path == "/api/chat/completions")
        .count();
    assert_eq!(
        completion_calls, 1,
        "retry backoff must share the run deadline"
    );
    assert_eq!(
        redis_get_string("subagent_cancel:chat-shared-timeout").unwrap(),
        None,
        "timing out the tool wait must not cancel the child chat"
    );
}

#[tokio::test]
async fn run_subagent_uses_requested_model_branch_for_sonnet_variants() {
    let env = TestEnv::new("coverage-requested-model");
    env.set_openwebui_token("token");
    let server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", path) if path.starts_with("/api/models") => MockResponse::json(json!({
                    "data": [
                        { "id": "Claude Sonnet 4.5", "name": "Claude Sonnet 4.5" },
                        { "id": "backup-model", "name": "Backup" }
                    ]
                })),
                ("GET", "/api/v1/folders/") => {
                    MockResponse::json(json!([{ "id": "folder-sonnet", "name": "Sub-agents" }]))
                }
                ("POST", "/api/v1/chats/new") => MockResponse::json(json!({ "id": "chat-sonnet" })),
                ("POST", "/api/chat/completions") => {
                    MockResponse::json(json!({ "task_id": "task-sonnet" }))
                }
                ("POST", "/api/v1/chats/chat-sonnet") => {
                    MockResponse::json(json!({ "success": true }))
                }
                ("GET", "/api/v1/chats/chat-sonnet") => MockResponse::json(json!({
                    "chat": {
                        "models": ["Claude Sonnet 4.5"],
                        "history": {
                            "messages": {
                                "user-1": {
                                    "id": "user-1",
                                    "role": "user",
                                    "content": "Investigate",
                                    "timestamp": 123,
                                    "models": ["Claude Sonnet 4.5"]
                                },
                                "assistant-1": {
                                    "id": "assistant-1",
                                    "role": "assistant",
                                    "content": "Requested model done",
                                    "finishReason": "stop",
                                    "usage": { "prompt_tokens": 4 }
                                }
                            }
                        },
                        "messages": [
                            { "role": "user", "content": "Investigate" },
                            {
                                "role": "assistant",
                                "content": "Requested model done",
                                "finishReason": "stop",
                                "usage": { "prompt_tokens": 4 }
                            }
                        ]
                    }
                })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(server.base_url());

    let result = response_payload(
        handle_run_subagent(&args(&[
            ("prompt", json!("Investigate")),
            ("model", json!("Claude Sonnet 4.5")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(result["model"], json!("Claude Sonnet 4.5"));
    assert_eq!(result["task_id"], json!("task-sonnet"));

    let completion_request = server
        .requests()
        .into_iter()
        .find(|request| request.method == "POST" && request.path == "/api/chat/completions")
        .expect("expected completion request");
    let completion_body: Value =
        serde_json::from_str(&completion_request.body).expect("completion request body");
    assert_eq!(completion_body["model"], json!("Claude Sonnet 4.5"));
    assert_eq!(
        completion_body["model_item"]["id"],
        json!("Claude Sonnet 4.5")
    );
}
