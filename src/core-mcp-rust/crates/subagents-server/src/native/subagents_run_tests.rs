use super::*;

fn read_workspace_settings() -> Value {
    serde_json::from_str(
        &fs::read_to_string(chat_workspace_settings_path().unwrap())
            .expect("workspace settings should exist"),
    )
    .expect("workspace settings should be JSON")
}

fn path_string(path: impl AsRef<std::path::Path>) -> String {
    path.as_ref().to_string_lossy().to_string()
}

#[test]
fn subagent_context_window_helpers_cover_supported_models_and_clamping() {
    assert_eq!(max_context_tokens_for_model("Atlas Sonnet 5"), 1_000_000);
    assert_eq!(max_context_tokens_for_model("Atlas Sonnet 4.6"), 1_000_000);
    assert_eq!(max_context_tokens_for_model("Atlas Opus 5"), 1_000_000);
    assert_eq!(
        max_context_tokens_for_model("us.anthropic.atlas-opus-5"),
        1_000_000
    );
    assert_eq!(max_context_tokens_for_model("Atlas Opus 4.8"), 1_000_000);
    assert_eq!(max_context_tokens_for_model("Atlas Opus 4.7"), 1_000_000);
    assert_eq!(max_context_tokens_for_model("Atlas Opus 4.6"), 1_000_000);
    assert_eq!(max_context_tokens_for_model("GPT-5.6 Sol"), 1_050_000);
    assert_eq!(max_context_tokens_for_model("GPT-5.6 Sol Pro"), 1_050_000);
    assert_eq!(max_context_tokens_for_model("GPT-5.6 Terra"), 1_050_000);
    assert_eq!(max_context_tokens_for_model("GPT-5.6 Luna"), 1_050_000);
    assert_eq!(
        max_context_tokens_for_model("openai/responses/gpt-5.6-sol:latest"),
        1_050_000
    );
    assert_eq!(max_context_tokens_for_model("Atlas Sonnet 4.5"), 200_000);
    assert_eq!(max_context_tokens_for_model("Atlas Opus 4.5"), 200_000);
    assert_eq!(max_context_tokens_for_model("Atlas Haiku 4.5"), 200_000);

    assert_eq!(
        normalize_context_tokens_for_window(3034894, 1_000_000),
        1_000_000
    );
    assert_eq!(
        normalize_context_tokens_for_window(879408, 1_000_000),
        879_408
    );
    assert_eq!(normalize_context_tokens_for_window(-15, 1_000_000), 0);
}

#[test]
fn subagent_workspace_inheritance_binds_custom_parent_workspace() {
    let env = TestEnv::new("workspace-inherit-custom");
    let custom_workspace = env.root.join("custom workspace");
    let settings_path = chat_workspace_settings_path().unwrap();
    fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
    fs::write(
        &settings_path,
        serde_json::to_string_pretty(&json!({
            "chats": {
                "parent-chat": {
                    "source": "custom",
                    "host_path": path_string(&custom_workspace),
                    "selected_at": "2026-05-14T00:00:00.000Z"
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let inheritance = persist_subagent_workspace_inheritance(Some("parent-chat"), "child-chat")
        .unwrap()
        .unwrap();
    let settings = read_workspace_settings();

    assert_eq!(inheritance.parent_chat_id, "parent-chat");
    assert_eq!(inheritance.root_parent_chat_id, "parent-chat");
    assert_eq!(inheritance.root_workspace_host_path, custom_workspace);
    assert_eq!(
        settings["chats"]["child-chat"]["host_path"],
        json!(path_string(env.root.join("custom workspace")))
    );
    assert_eq!(
        settings["chats"]["child-chat"]["root_parent_chat_id"],
        json!("parent-chat")
    );
    assert_eq!(
        settings["chats"]["parent-chat"]["host_path"],
        json!(path_string(env.root.join("custom workspace")))
    );
}

#[test]
fn subagent_workspace_inheritance_binds_to_root_canonical_workspace() {
    let env = TestEnv::new("workspace-inherit-canonical");

    let inheritance = persist_subagent_workspace_inheritance(Some("root-chat"), "child-chat")
        .unwrap()
        .unwrap();
    let settings = read_workspace_settings();
    let expected_root_workspace = env.root.join("workspaces").join("root-chat");

    assert_eq!(inheritance.root_parent_chat_id, "root-chat");
    assert_eq!(
        inheritance.root_workspace_host_path,
        expected_root_workspace
    );
    assert_eq!(
        settings["chats"]["child-chat"]["host_path"],
        json!(path_string(env.root.join("workspaces").join("root-chat")))
    );
    assert_eq!(settings["chats"]["child-chat"]["source"], json!("custom"));
    assert_eq!(
        settings["chats"].get("root-chat"),
        None,
        "canonical root parent should not need a settings entry"
    );
}

#[test]
fn nested_subagent_workspace_inheritance_reuses_root_parent_workspace() {
    let env = TestEnv::new("workspace-inherit-nested");
    let root_workspace = env.root.join("root custom");
    redis_set_string(
        "subagent_chat:child-chat",
        &json!({
            "parent_chat_id": "root-chat",
            "root_parent_chat_id": "root-chat",
            "root_workspace_host_path": path_string(&root_workspace),
        })
        .to_string(),
    )
    .unwrap();

    let inheritance = persist_subagent_workspace_inheritance(Some("child-chat"), "grandchild-chat")
        .unwrap()
        .unwrap();
    let settings = read_workspace_settings();

    assert_eq!(inheritance.parent_chat_id, "child-chat");
    assert_eq!(inheritance.root_parent_chat_id, "root-chat");
    assert_eq!(inheritance.root_workspace_host_path, root_workspace);
    assert_eq!(
        settings["chats"]["grandchild-chat"]["host_path"],
        json!(path_string(env.root.join("root custom")))
    );
}

#[test]
fn subagent_workspace_inheritance_is_per_child_and_absent_without_parent() {
    let env = TestEnv::new("workspace-inherit-retry-and-direct");
    let first = persist_subagent_workspace_inheritance(Some("root-chat"), "child-one")
        .unwrap()
        .unwrap();
    let second = persist_subagent_workspace_inheritance(Some("root-chat"), "child-two")
        .unwrap()
        .unwrap();
    let direct = persist_subagent_workspace_inheritance(None, "direct-child").unwrap();
    let settings = read_workspace_settings();
    let expected_root_workspace = env.root.join("workspaces").join("root-chat");

    assert_eq!(first.root_workspace_host_path, expected_root_workspace);
    assert_eq!(
        second.root_workspace_host_path,
        env.root.join("workspaces").join("root-chat")
    );
    assert!(direct.is_none());
    assert_eq!(
        settings["chats"]["child-one"]["host_path"],
        settings["chats"]["child-two"]["host_path"]
    );
    assert_eq!(settings["chats"].get("direct-child"), None);
}

#[test]
fn merge_subagent_tool_ids_unions_explicit_and_skill_required_servers() {
    let merged = merge_subagent_tool_ids(
        &[
            "server:glean".to_string(),
            "server:agent-vm".to_string(),
            "server:google_workspace".to_string(),
        ],
        &["server:glean".to_string(), "server:agent-vm".to_string()],
        true,
    );
    assert_eq!(
        merged,
        vec![
            "server:glean".to_string(),
            "server:agent-vm".to_string(),
            "server:google_workspace".to_string(),
            "server:mcp-assistant".to_string(),
            "server:subagents".to_string(),
            "server:skills".to_string(),
        ]
    );
}

#[test]
fn merge_subagent_tool_ids_always_includes_all_four_core_servers() {
    // The unified context-engineering contract: Agent VM, MCP Assistant,
    // Skills, and Subagents auto-activate for EVERY subagent chat.
    let merged = merge_subagent_tool_ids(&[], &[], true);
    assert_eq!(
        merged,
        vec![
            "server:mcp-assistant".to_string(),
            "server:subagents".to_string(),
            "server:skills".to_string(),
            "server:agent-vm".to_string(),
        ]
    );
}

#[test]
fn merge_subagent_tool_ids_preserves_explicit_tools_without_skills() {
    let merged = merge_subagent_tool_ids(
        &[
            "server:required".to_string(),
            "server:user-tool".to_string(),
        ],
        &["server:required".to_string()],
        true,
    );
    assert_eq!(
        merged,
        vec![
            "server:required".to_string(),
            "server:user-tool".to_string(),
            "server:mcp-assistant".to_string(),
            "server:subagents".to_string(),
            "server:skills".to_string(),
            "server:agent-vm".to_string(),
        ]
    );
}

#[test]
fn merge_subagent_tool_ids_can_skip_core_tools_for_text_only_smoke_tests() {
    let merged = merge_subagent_tool_ids(
        &["server:user-tool".to_string()],
        &["server:required".to_string()],
        false,
    );
    assert_eq!(
        merged,
        vec![
            "server:user-tool".to_string(),
            "server:required".to_string(),
        ]
    );
}

#[test]
fn subagent_image_urls_are_limited_normalized_and_sent_as_content_blocks() {
    let image_urls = subagent_image_urls_arg(&args(&[(
        "image_urls",
        json!([
            "http://localhost:9876/workspace/chat-1/output/slide-1.png",
            "http://127.0.0.1:9876/workspace/chat-1/output/slide-2.png",
            "https://example.com/slide-3.png",
        ]),
    )]))
    .unwrap();

    assert_eq!(
        image_urls,
        vec![
            "http://host.docker.internal:9876/workspace/chat-1/output/slide-1.png".to_string(),
            "http://host.docker.internal:9876/workspace/chat-1/output/slide-2.png".to_string(),
            "https://example.com/slide-3.png".to_string(),
        ]
    );
    assert_eq!(
        subagent_user_content("Inspect these slides", &image_urls),
        json!([
            { "type": "text", "text": "Inspect these slides" },
            {
                "type": "image_url",
                "image_url": {
                    "url": "http://host.docker.internal:9876/workspace/chat-1/output/slide-1.png"
                }
            },
            {
                "type": "image_url",
                "image_url": {
                    "url": "http://host.docker.internal:9876/workspace/chat-1/output/slide-2.png"
                }
            },
            {
                "type": "image_url",
                "image_url": { "url": "https://example.com/slide-3.png" }
            }
        ])
    );
    assert_eq!(
        display_content_for_chat(&subagent_user_content("Inspect these slides", &image_urls)),
        json!(
            "Inspect these slides\n\nImage inputs attached for model analysis:\n1. http://localhost:9876/workspace/chat-1/output/slide-1.png\n2. http://localhost:9876/workspace/chat-1/output/slide-2.png\n3. https://example.com/slide-3.png"
        )
    );
    assert_eq!(subagent_user_content("Text only", &[]), json!("Text only"));
}

#[tokio::test]
async fn run_subagent_rejects_more_than_twenty_image_urls_before_dispatch() {
    let image_urls = (1..=21)
        .map(|index| format!("http://localhost:9876/workspace/chat/output/slide-{index}.png"))
        .collect::<Vec<_>>();

    assert_err_contains(
        handle_run_subagent(&args(&[
            ("prompt", json!("Inspect these images")),
            ("image_urls", json!(image_urls)),
        ]))
        .await,
        "image_urls supports at most 20 images",
    );
}

#[test]
fn lm_studio_openai_config_merge_preserves_existing_provider() {
    let resolved = LmStudioResolvedConfig {
        port: 1234,
        host_base_url: "http://127.0.0.1:1234/v1".to_string(),
        docker_base_url: "http://host.docker.internal:1234/v1".to_string(),
        api_key: String::new(),
    };
    let aliases = BTreeMap::from([("local/foo".to_string(), "foo".to_string())]);
    let merged = merge_lm_studio_openai_config(
        json!({
            "ENABLE_OPENAI_API": true,
            "OPENAI_API_BASE_URLS": ["https://api.openai.com/v1"],
            "OPENAI_API_KEYS": ["existing"],
            "OPENAI_API_CONFIGS": { "0": { "enable": true, "model_ids": ["GPT-5.4"] } }
        }),
        &resolved,
        true,
        &["local/foo".to_string()],
        &aliases,
    );

    assert_eq!(
        merged["OPENAI_API_BASE_URLS"][0],
        "https://api.openai.com/v1"
    );
    assert_eq!(merged["OPENAI_API_KEYS"][0], "existing");
    assert_eq!(
        merged["OPENAI_API_BASE_URLS"][1],
        "http://host.docker.internal:1234/v1"
    );
    assert_eq!(
        merged["OPENAI_API_CONFIGS"]["1"]["portico_provider"],
        "lm_studio"
    );
    assert_eq!(
        merged["OPENAI_API_CONFIGS"]["1"]["model_aliases"]["local/foo"],
        "foo"
    );
}

#[test]
fn lm_studio_internal_model_id_uses_local_prefix_only_on_collision() {
    let non_local = json!({ "id": "foo", "owned_by": "openai" });
    let local = json!({ "id": "bar", "meta": { "local_provider": "lm_studio" } });

    assert_eq!(
        lm_studio_internal_model_id("foo", &[non_local]),
        "local/foo"
    );
    assert_eq!(lm_studio_internal_model_id("bar", &[local]), "bar");
}

#[test]
fn lm_studio_probe_filters_embedding_models_and_marks_context_window() {
    assert!(!is_lm_studio_embedding_model_entry(
        &json!({ "id": "google/gemma-4-e4b" })
    ));
    assert!(is_lm_studio_embedding_model_entry(&json!({
        "id": "text-embedding-nomic-embed-text-v1.5",
        "type": "embedding"
    })));

    let payload = build_lm_studio_model_payload(
        "google/gemma-4-e4b",
        "google/gemma-4-e4b",
        true,
        Some(98_304),
        Some(131_072),
    );
    assert_eq!(payload["meta"]["max_context_tokens"], json!(98304));
    assert_eq!(
        payload["meta"]["lm_studio_max_context_tokens"],
        json!(131072)
    );
    assert_eq!(payload["params"], json!({}));
}

#[test]
fn lm_studio_native_model_helpers_sync_only_loaded_chat_models() {
    let payload = json!({
        "data": [
            {
                "id": "google/gemma-4-e4b",
                "max_context_length": 131072,
                "loaded_instances": [{ "config": { "context_length": 98304 } }]
            },
            {
                "id": "qwen/qwen3-8b",
                "max_context_length": 65536,
                "loaded_instances": []
            },
            {
                "id": "text-embedding-nomic-embed",
                "type": "embedding",
                "loaded_instances": [{ "config": { "context_length": 8192 } }]
            }
        ]
    });
    let entries = lm_studio_model_entries(&payload);
    let loaded_chat = entries
        .into_iter()
        .filter(|model| !is_lm_studio_embedding_model_entry(model))
        .filter(|model| lm_studio_native_model_is_loaded(model))
        .map(|model| {
            (
                lm_studio_model_entry_id(model).unwrap(),
                lm_studio_loaded_context_tokens(model),
                lm_studio_max_context_tokens(model),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        loaded_chat,
        vec![(
            "google/gemma-4-e4b".to_string(),
            Some(98_304),
            Some(131_072)
        )]
    );
}

#[test]
fn lm_studio_missing_model_lookup_errors_are_optional() {
    assert!(is_missing_model_lookup_error_message(
        "GET /api/v1/models/model?id=google%2Fgemma returned error 422 not found"
    ));
    assert!(is_missing_model_lookup_error_message("HTTP 404"));
    assert!(!is_missing_model_lookup_error_message(
        "HTTP 500 internal server error"
    ));
}

#[tokio::test]
async fn get_system_information_routes_to_electron_endpoint() {
    let env = TestEnv::new("get-system-information");
    let electron = MockServer::start(|request| {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/system-information") => MockResponse::json(json!({
                "success": true,
                "system": {
                    "os": { "platform": "darwin" },
                    "cpu": { "architecture": "arm64", "family": "apple_silicon", "logical_cores": 12 },
                    "memory": { "total_bytes": 68719476736u64 },
                    "gpu": [{ "name": "Apple M3 Max" }]
                }
            })),
            _ => MockResponse {
                status: 404,
                body: json!({ "error": "unexpected" }),
            },
        }
    });
    env.set_electron_api_base(&electron.base_url());

    let response = handle_get_system_information(&Map::new()).await.unwrap();
    let payload = response_payload(response);
    assert_eq!(payload["success"], json!(true));
    assert_eq!(payload["system"]["cpu"]["family"], json!("apple_silicon"));
}

#[test]
fn full_subagent_response_preserves_large_reports() {
    let short = full_subagent_response("Short response");
    assert_eq!(short, ("Short response".to_string(), 14, false));

    let long_text = "A".repeat(13_373);
    let (response, char_count, truncated) = full_subagent_response(&long_text);
    assert_eq!(response, long_text);
    assert_eq!(char_count, 13_373);
    assert!(!truncated);
}

#[tokio::test]
async fn run_subagent_covers_validation_default_model_skill_tools_and_parent_tracking() {
    let env = TestEnv::new("run-subagent");
    redis_delete(OPENWEBUI_TOKEN_KEY).unwrap();
    assert_err_contains(
        handle_run_subagent(&args(&[("prompt", json!("Investigate"))])).await,
        "Open WebUI API token not available in Redis",
    );
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("cached-user");
    assert_err_contains(handle_run_subagent(&Map::new()).await, "prompt is required");
    env.write_skill(
        "planner",
        "Plans work and needs extra tools",
        &["server:required", "server:skills"],
    );
    let server = MockServer::start(|request| {
        if request.method == "GET" && request.path.starts_with("/api/models") {
            MockResponse::json(
                json!({ "data": [{ "id": "default-model", "is_default": true, "name": "Default" }, { "id": "backup-model", "name": "Backup" }] }),
            )
        } else {
            match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/folders/") => {
                    MockResponse::json(json!([{ "id": "folder-run", "name": "Sub-agents" }]))
                }
                ("POST", "/api/v1/chats/new") => MockResponse::json(json!({ "id": "chat-run" })),
                ("POST", "/api/chat/completions") => {
                    MockResponse::json(json!({ "task_id": "task-123" }))
                }
                ("POST", "/api/v1/chats/chat-run") => {
                    MockResponse::json(json!({ "success": true }))
                }
                ("GET", "/api/v1/chats/chat-run") => MockResponse::json(json!({
                    "chat": {
                        "models": ["default-model"],
                        "history": {
                            "messages": {
                                "user-1": {
                                    "id": "user-1",
                                    "role": "user",
                                    "content": "Investigate this request",
                                    "timestamp": 123,
                                    "models": ["default-model"]
                                },
                                "assistant-1": {
                                    "id": "assistant-1",
                                    "role": "assistant",
                                    "content": "Subagent done",
                                    "finishReason": "stop",
                                    "usage": { "prompt_tokens": 4 }
                                }
                            }
                        },
                        "messages": [
                            { "role": "user", "content": "Investigate this request" },
                            {
                                "role": "assistant",
                                "content": "Subagent done",
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
            }
        }
    });
    env.set_openwebui_base_url(server.base_url());
    let result = response_payload(
        handle_run_subagent(&args(&[
            ("prompt", json!("Investigate this request")),
            (
                "image_urls",
                json!(["http://localhost:9876/workspace/chat-run/output/slide-1.png"]),
            ),
            (
                "tool_server_ids",
                json!(["server:required", "server:user-tool"]),
            ),
            ("skill_ids", json!(["planner", "missing-skill", "planner"])),
            ("parent_tool_call_id", json!("parent-123")),
            ("parent_chat_id", json!("parent-chat")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(result["model"], json!("default-model"));
    assert_eq!(result["response"], json!("Subagent done"));
    assert_eq!(result["response_char_count"], json!(13));
    assert_eq!(result["response_truncated"], json!(false));
    assert_eq!(result["chat_id"], json!("chat-run"));
    assert_eq!(result["task_id"], json!("task-123"));
    assert_eq!(result["tool_call_count"], json!(0));
    assert_eq!(result["usage_tokens"], json!(4));
    assert_eq!(result["context_tokens"], json!(4));
    assert_eq!(result["max_context_tokens"], json!(200000));
    assert!(!result["session_id"].as_str().unwrap_or_default().is_empty());
    let requests = server.requests();
    let chat_body: Value = serde_json::from_str(
        &requests
            .iter()
            .find(|request| request.method == "POST" && request.path == "/api/v1/chats/new")
            .expect("expected chat create request")
            .body,
    )
    .unwrap();
    let completion_body: Value = serde_json::from_str(
        &requests
            .iter()
            .find(|request| request.method == "POST" && request.path == "/api/chat/completions")
            .expect("expected completion request")
            .body,
    )
    .unwrap();
    assert_eq!(chat_body["chat"]["models"], json!(["default-model"]));
    assert_eq!(
        chat_body["chat"]["meta"]["subagent"]["parent_chat_id"],
        json!("parent-chat")
    );
    assert_eq!(
        chat_body["chat"]["meta"]["subagent"]["root_parent_chat_id"],
        json!("parent-chat")
    );
    assert_eq!(
        chat_body["chat"]["meta"]["subagent"]["parent_tool_call_id"],
        json!("parent-123")
    );
    let expected_content = json!([
        { "type": "text", "text": "Investigate this request" },
        {
            "type": "image_url",
            "image_url": {
                "url": "http://host.docker.internal:9876/workspace/chat-run/output/slide-1.png"
            }
        }
    ]);
    assert_eq!(
        chat_body["chat"]["messages"][0]["content"],
        json!(
            "Investigate this request\n\nImage inputs attached for model analysis:\n1. http://localhost:9876/workspace/chat-run/output/slide-1.png"
        )
    );
    assert_eq!(
        chat_body["chat"]["history"]["messages"]
            .as_object()
            .unwrap()
            .values()
            .find(|message| message["role"] == json!("user"))
            .unwrap()["content"],
        json!(
            "Investigate this request\n\nImage inputs attached for model analysis:\n1. http://localhost:9876/workspace/chat-run/output/slide-1.png"
        )
    );
    assert_eq!(completion_body["model_item"]["id"], json!("default-model"));
    assert_eq!(completion_body["messages"][0]["role"], json!("user"));
    assert_eq!(completion_body["messages"][0]["content"], expected_content);
    assert_eq!(
        completion_body["tool_ids"],
        json!([
            "server:required",
            "server:user-tool",
            "server:mcp-assistant",
            "server:subagents",
            "server:skills",
            "server:agent-vm"
        ])
    );
    assert_eq!(
        serde_json::from_str::<Vec<String>>(
            redis_get_string("chat_tools:chat-run")
                .unwrap()
                .as_deref()
                .unwrap()
        )
        .unwrap(),
        vec![
            "server:required".to_string(),
            "server:user-tool".to_string(),
            "server:mcp-assistant".to_string(),
            "server:subagents".to_string(),
            "server:skills".to_string(),
            "server:agent-vm".to_string(),
        ]
    );
    assert_eq!(
        serde_json::from_str::<Vec<String>>(
            redis_get_string("subagent_explicit_skills:chat-run")
                .unwrap()
                .as_deref()
                .unwrap()
        )
        .unwrap(),
        vec!["planner".to_string(), "missing-skill".to_string()]
    );
    assert_eq!(completion_body["session_id"], result["session_id"]);
    assert_eq!(
        completion_body["variables"]["{{USER_NAME}}"],
        json!("Sub-Agent")
    );
    assert_eq!(
        completion_body["variables"]["{{CURRENT_TIMEZONE}}"],
        json!("America/New_York")
    );
    assert!(
        completion_body["variables"]["timestamp"].is_string(),
        "completion variables must remain string-typed for Open WebUI template replacement"
    );
    assert_eq!(
        completion_body["variables"]["timestamp"],
        Value::String(chat_body["chat"]["messages"][0]["timestamp"].to_string())
    );
    assert_eq!(
        serde_json::from_str::<Vec<String>>(
            redis_get_string("chat_skills:chat-run")
                .unwrap()
                .as_deref()
                .unwrap()
        )
        .unwrap(),
        vec!["planner".to_string()]
    );
    let parent: Value = serde_json::from_str(
        redis_get_string("subagent_tool_call:parent-123")
            .unwrap()
            .as_deref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(parent["chat_id"], json!("chat-run"));
    assert!(parent["created_at"].as_f64().unwrap_or_default() > 0.0);
    let reverse: Value = serde_json::from_str(
        redis_get_string("subagent_chat:chat-run")
            .unwrap()
            .as_deref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(reverse["parent_tool_call_id"], json!("parent-123"));
    assert_eq!(reverse["parent_chat_id"], json!("parent-chat"));
    assert_eq!(reverse["root_parent_chat_id"], json!("parent-chat"));
    assert_eq!(
        reverse["root_workspace_host_path"],
        json!(path_string(env.root.join("workspaces").join("parent-chat")))
    );
    assert_eq!(
        reverse["allowed_tool_server_ids"],
        json!([
            "server:required",
            "server:user-tool",
            "server:mcp-assistant",
            "server:subagents",
            "server:skills",
            "server:agent-vm"
        ])
    );
    assert_eq!(
        reverse["explicit_skill_ids"],
        json!(["planner", "missing-skill"])
    );
    assert!(requests
        .iter()
        .any(|request| request.method == "POST" && request.path == "/api/v1/chats/chat-run"));
    let settings = read_workspace_settings();
    assert_eq!(
        settings["chats"]["chat-run"]["host_path"],
        json!(path_string(env.root.join("workspaces").join("parent-chat")))
    );
    assert_eq!(
        settings["chats"]["chat-run"]["root_parent_chat_id"],
        json!("parent-chat")
    );
}

#[tokio::test]
async fn run_subagent_include_core_tools_false_sends_no_tool_ids() {
    let env = TestEnv::new("run-subagent-no-core-tools");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("cached-user");
    let server = MockServer::start(|request| {
        if request.method == "GET" && request.path.starts_with("/api/models") {
            MockResponse::json(json!({
                "data": [{ "id": "local-model", "is_default": true, "name": "Local Model" }]
            }))
        } else {
            match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/folders/") => {
                    MockResponse::json(json!([{ "id": "folder-run", "name": "LM Studio Setup" }]))
                }
                ("POST", "/api/v1/chats/new") => MockResponse::json(json!({ "id": "chat-run" })),
                ("POST", "/api/chat/completions") => {
                    MockResponse::json(json!({ "task_id": "task-123" }))
                }
                ("POST", "/api/v1/chats/chat-run") => {
                    MockResponse::json(json!({ "success": true }))
                }
                ("GET", "/api/v1/chats/chat-run") => MockResponse::json(json!({
                    "chat": {
                        "models": ["local-model"],
                        "history": {
                            "messages": {
                                "assistant-1": {
                                    "id": "assistant-1",
                                    "role": "assistant",
                                    "content": "Local model is responding.",
                                    "finishReason": "stop",
                                    "usage": { "prompt_tokens": 3 }
                                }
                            }
                        },
                        "messages": [{
                            "role": "assistant",
                            "content": "Local model is responding.",
                            "finishReason": "stop",
                            "usage": { "prompt_tokens": 3 }
                        }]
                    }
                })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            }
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let result = run_subagent(RunSubagentRequest {
        model: Some("local-model".to_string()),
        prompt: "Smoke test".to_string(),
        include_core_tools: false,
        folder_name: Some("LM Studio Setup".to_string()),
        ..RunSubagentRequest::default()
    })
    .await
    .unwrap();
    assert_eq!(result.response, "Local model is responding.");

    let completion_body: Value = serde_json::from_str(
        &server
            .requests()
            .iter()
            .find(|request| request.method == "POST" && request.path == "/api/chat/completions")
            .expect("expected completion request")
            .body,
    )
    .unwrap();
    assert_eq!(completion_body["tool_ids"], json!([]));
    assert_eq!(
        serde_json::from_str::<Vec<String>>(
            redis_get_string("chat_tools:chat-run")
                .unwrap()
                .as_deref()
                .unwrap()
        )
        .unwrap(),
        Vec::<String>::new()
    );
}

#[tokio::test]
async fn run_subagent_supports_folder_name_override() {
    let env = TestEnv::new("run-subagent-folder-override");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("cached-user");
    let server = MockServer::start(|request| {
        if request.method == "GET" && request.path.starts_with("/api/models") {
            MockResponse::json(
                json!({ "data": [{ "id": "default-model", "is_default": true, "name": "Default" }] }),
            )
        } else {
            match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/folders/") => MockResponse::json(json!([
                    { "id": "scheduled-folder", "name": "Scheduled Tasks", "parent_id": null, "created_at": 1.0 },
                    { "id": "subagent-folder", "name": "Sub-agents", "parent_id": null, "created_at": 1.0 }
                ])),
                ("POST", "/api/v1/chats/new") => {
                    MockResponse::json(json!({ "id": "chat-scheduled" }))
                }
                ("POST", "/api/chat/completions") => {
                    MockResponse::json(json!({ "task_id": "task-scheduled" }))
                }
                ("POST", "/api/v1/chats/chat-scheduled") => {
                    MockResponse::json(json!({ "success": true }))
                }
                ("GET", "/api/v1/chats/chat-scheduled") => MockResponse::json(json!({
                    "chat": {
                        "models": ["default-model"],
                        "history": {
                            "messages": {
                                "assistant-1": {
                                    "id": "assistant-1",
                                    "role": "assistant",
                                    "content": "Scheduled run complete",
                                    "finishReason": "stop",
                                    "usage": { "prompt_tokens": 3 }
                                }
                            }
                        },
                        "messages": [
                            {
                                "role": "assistant",
                                "content": "Scheduled run complete",
                                "finishReason": "stop",
                                "usage": { "prompt_tokens": 3 }
                            }
                        ]
                    }
                })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            }
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let result = response_payload(
        handle_run_subagent(&args(&[
            ("prompt", json!("Run the scheduled job")),
            ("folder_name", json!("Scheduled Tasks")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(result["chat_id"], json!("chat-scheduled"));
    assert_eq!(result["response"], json!("Scheduled run complete"));

    let requests = server.requests();
    let chat_body: Value = serde_json::from_str(
        &requests
            .iter()
            .find(|request| request.method == "POST" && request.path == "/api/v1/chats/new")
            .expect("expected chat create request")
            .body,
    )
    .unwrap();
    assert_eq!(chat_body["folder_id"], json!("scheduled-folder"));
}

#[tokio::test]
async fn run_subagent_prefers_clean_parent_facing_response_from_chat_data() {
    let env = TestEnv::new("run-subagent-clean-preview");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("cached-user");
    let long_report = format!(
        "## Executive summary\n- Clean synthesis\n- Actionable next steps\n{}",
        "Detailed evidence line.\n".repeat(300)
    );
    let raw_content = format!(
        "I will inspect the overflow artifact first.to=functions.vm_execute_bash json\n{{\"vm_id\":\"abc\"}}\n{}",
        long_report
    );
    let server = MockServer::start(move |request| {
        let raw_content = raw_content.clone();
        if request.method == "GET" && request.path.starts_with("/api/models") {
            MockResponse::json(json!({
                "data": [{ "id": "default-model", "is_default": true, "name": "Default" }]
            }))
        } else {
            match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/folders/") => {
                    MockResponse::json(json!([{ "id": "folder-run", "name": "Sub-agents" }]))
                }
                ("POST", "/api/v1/chats/new") => MockResponse::json(json!({ "id": "chat-run" })),
                ("POST", "/api/chat/completions") => {
                    MockResponse::json(json!({ "task_id": "task-123" }))
                }
                ("POST", "/api/v1/chats/chat-run") => {
                    MockResponse::json(json!({ "success": true }))
                }
                ("GET", "/api/v1/chats/chat-run") => MockResponse::json(json!({
                    "chat": {
                        "models": ["default-model"],
                        "history": {
                            "messages": {
                                "user-1": {
                                    "id": "user-1",
                                    "role": "user",
                                    "content": "Investigate this request",
                                    "timestamp": 123,
                                    "models": ["default-model"]
                                },
                                "assistant-1": {
                                    "id": "assistant-1",
                                    "role": "assistant",
                                    "content": raw_content.clone(),
                                    "contentBlocks": [
                                        {
                                            "type": "text",
                                            "content": raw_content.clone()
                                        }
                                    ],
                                    "finishReason": "stop",
                                    "usage": { "prompt_tokens": 42 }
                                }
                            }
                        },
                        "messages": [
                            { "role": "user", "content": "Investigate this request" },
                            {
                                "role": "assistant",
                                "content": raw_content.clone(),
                                "contentBlocks": [
                                    {
                                        "type": "text",
                                        "content": raw_content.clone()
                                    }
                                ],
                                "finishReason": "stop",
                                "usage": { "prompt_tokens": 42 }
                            }
                        ]
                    }
                })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            }
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let result = response_payload(
        handle_run_subagent(&args(&[("prompt", json!("Investigate this request"))]))
            .await
            .unwrap(),
    );

    let response = result["response"].as_str().unwrap_or_default();
    let expected_response = long_report.trim();
    assert_eq!(response, expected_response);
    assert!(response.contains("Clean synthesis"));
    assert!(!response.contains("to=functions.vm_execute_bash"));
    assert_eq!(
        result["response_char_count"],
        json!(expected_response.chars().count())
    );
    assert_eq!(result["response_truncated"], json!(false));
    assert_eq!(result["chat_id"], json!("chat-run"));
    assert_eq!(result["usage_tokens"], json!(42));
}

#[tokio::test]
async fn run_subagent_merges_saved_defaults_overrides_reasoning_and_persists_effort_on_chat_record() {
    let env = TestEnv::new("run-subagent-saved-defaults");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("cached-user");
    env.write_skill(
        "planner",
        "Plans work and needs extra tools",
        &["server:required", "server:skills"],
    );
    env.write_model_catalog(
        r#"model_list:
  - model_name: "GPT-5.4 pro"
    model_info:
      supports_reasoning: true
      reasoning_effort_options: ["medium", "high", "max"]
"#,
    );

    let chat_state_server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("PUT", "/api/v1/chat-state/chat-saved") => {
                    MockResponse::json(json!({ "success": true }))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_chat_state_api_base_url(chat_state_server.base_url());

    let openwebui_server = MockServer::start(|request| {
        if request.method == "GET" && request.path.starts_with("/api/models") {
            MockResponse::json(json!({
                "data": [
                    { "id": "gpt-5.4-pro", "name": "GPT-5.4 pro" },
                    {
                        "id": "writer-agent",
                        "name": "Writer Agent",
                        "base_model_id": "gpt-5.4-pro",
                        "meta": {
                            "subagent_tool_server_ids": ["server:time"],
                            "subagent_skill_ids": ["planner"],
                            "subagent_reasoning_effort": "high"
                        }
                    }
                ]
            }))
        } else {
            match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/folders/") => {
                    MockResponse::json(json!([{ "id": "folder-saved", "name": "Sub-agents" }]))
                }
                ("POST", "/api/v1/chats/new") => MockResponse::json(json!({ "id": "chat-saved" })),
                ("POST", "/api/chat/completions") => {
                    MockResponse::json(json!({ "task_id": "task-saved" }))
                }
                ("POST", "/api/v1/chats/chat-saved") => {
                    MockResponse::json(json!({ "success": true }))
                }
                ("GET", "/api/v1/chats/chat-saved") => MockResponse::json(json!({
                    "chat": {
                        "models": ["writer-agent"],
                        "history": {
                            "messages": {
                                "user-1": {
                                    "id": "user-1",
                                    "role": "user",
                                    "content": "Investigate this request",
                                    "timestamp": 123,
                                    "models": ["writer-agent"]
                                },
                                "assistant-1": {
                                    "id": "assistant-1",
                                    "role": "assistant",
                                    "content": "Saved defaults applied",
                                    "finishReason": "stop",
                                    "usage": { "prompt_tokens": 9 }
                                }
                            }
                        },
                        "messages": [
                            { "role": "user", "content": "Investigate this request" },
                            {
                                "role": "assistant",
                                "content": "Saved defaults applied",
                                "finishReason": "stop",
                                "usage": { "prompt_tokens": 9 }
                            }
                        ]
                    }
                })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            }
        }
    });
    env.set_openwebui_base_url(openwebui_server.base_url());

    let result = response_payload(
        handle_run_subagent(&args(&[
            ("prompt", json!("Investigate this request")),
            ("model", json!("writer-agent")),
            ("tool_server_ids", json!(["server:user-tool"])),
            ("skill_ids", json!(["missing-skill"])),
            ("reasoning_effort", json!("max")),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(result["model"], json!("writer-agent"));
    assert_eq!(result["response"], json!("Saved defaults applied"));
    assert_eq!(result["usage_tokens"], json!(9));

    let openwebui_requests = openwebui_server.requests();
    let completion_body: Value = serde_json::from_str(
        &openwebui_requests
            .iter()
            .find(|request| request.method == "POST" && request.path == "/api/chat/completions")
            .expect("expected completion request")
            .body,
    )
    .unwrap();
    assert_eq!(completion_body["reasoning_effort"], json!("max"));
    assert_eq!(
        completion_body["tool_ids"],
        json!([
            "server:time",
            "server:user-tool",
            "server:mcp-assistant",
            "server:subagents",
            "server:skills",
            "server:agent-vm",
            "server:required"
        ])
    );
    assert_eq!(
        serde_json::from_str::<Vec<String>>(
            redis_get_string("chat_tools:chat-saved")
                .unwrap()
                .as_deref()
                .unwrap()
        )
        .unwrap(),
        vec![
            "server:time".to_string(),
            "server:user-tool".to_string(),
            "server:mcp-assistant".to_string(),
            "server:subagents".to_string(),
            "server:skills".to_string(),
            "server:agent-vm".to_string(),
            "server:required".to_string(),
        ]
    );
    assert_eq!(
        serde_json::from_str::<Vec<String>>(
            redis_get_string("chat_skills:chat-saved")
                .unwrap()
                .as_deref()
                .unwrap()
        )
        .unwrap(),
        vec!["planner".to_string()]
    );
    assert_eq!(
        serde_json::from_str::<Vec<String>>(
            redis_get_string("subagent_explicit_skills:chat-saved")
                .unwrap()
                .as_deref()
                .unwrap()
        )
        .unwrap(),
        vec!["planner".to_string(), "missing-skill".to_string()]
    );

    // The resolved effort is persisted on the chat RECORD's params (what a
    // delegated subagent view reads to display the effort). We intentionally do
    // NOT PUT chat-state at creation, so assert the /chats/new payload instead.
    let create_chat_request = openwebui_server
        .requests()
        .into_iter()
        .find(|request| request.method == "POST" && request.path == "/api/v1/chats/new")
        .expect("expected chat-create request");
    let create_chat_body: Value = serde_json::from_str(&create_chat_request.body).unwrap();
    assert_eq!(
        create_chat_body["chat"]["params"]["reasoning_effort"],
        json!("max")
    );
}

#[tokio::test]
async fn run_subagent_rejects_missing_default_and_unknown_requested_models() {
    let env = TestEnv::new("run-subagent-model-errors");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("cached-user");

    let no_models = MockServer::start(|request| {
        if request.method == "GET" && request.path.starts_with("/api/models") {
            MockResponse::json(json!({ "data": [] }))
        } else {
            MockResponse {
                status: 404,
                body: json!({ "error": "unexpected" }),
            }
        }
    });
    env.set_openwebui_base_url(no_models.base_url());
    assert_err_contains(
        handle_run_subagent(&args(&[("prompt", json!("Investigate"))])).await,
        "No model specified and no default model available",
    );
    drop(no_models);

    let missing_model = MockServer::start(|request| {
        if request.method == "GET" && request.path.starts_with("/api/models") {
            MockResponse::json(json!({ "data": [{ "id": "fallback-model", "name": "Fallback" }] }))
        } else {
            MockResponse {
                status: 404,
                body: json!({ "error": "unexpected" }),
            }
        }
    });
    env.set_openwebui_base_url(missing_model.base_url());
    assert_err_contains(
        handle_run_subagent(&args(&[
            ("prompt", json!("Investigate")),
            ("model", json!("missing-model")),
        ]))
        .await,
        "Model 'missing-model' not found in available models",
    );
}

#[tokio::test]
async fn run_subagent_skips_disabled_default_and_rejects_disabled_requested_models() {
    let env = TestEnv::new("run-subagent-disabled-models");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("cached-user");

    let fallback_server = MockServer::start(|request| {
        if request.method == "GET" && request.path.starts_with("/api/models") {
            MockResponse::json(json!({
                "data": [
                    {
                        "id": "gpt-5.4-pro",
                        "name": "GPT-5.4 pro",
                        "is_default": true,
                        "meta": {
                            "disabled": true,
                            "disabled_reason": "Temporarily disabled due to high costs"
                        }
                    },
                    { "id": "fallback-model", "name": "Fallback Model" }
                ]
            }))
        } else {
            match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/folders/") => {
                    MockResponse::json(json!([{ "id": "folder-disabled", "name": "Sub-agents" }]))
                }
                ("POST", "/api/v1/chats/new") => {
                    MockResponse::json(json!({ "id": "chat-disabled-default" }))
                }
                ("POST", "/api/chat/completions") => {
                    MockResponse::json(json!({ "task_id": "task-disabled-default" }))
                }
                ("POST", "/api/v1/chats/chat-disabled-default") => {
                    MockResponse::json(json!({ "success": true }))
                }
                ("GET", "/api/v1/chats/chat-disabled-default") => MockResponse::json(json!({
                    "chat": {
                        "models": ["fallback-model"],
                        "history": {
                            "messages": {
                                "assistant-1": {
                                    "id": "assistant-1",
                                    "role": "assistant",
                                    "content": "Fallback response",
                                    "done": true
                                }
                            }
                        },
                        "messages": [
                            { "role": "assistant", "content": "Fallback response", "done": true }
                        ]
                    }
                })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            }
        }
    });
    env.set_openwebui_base_url(fallback_server.base_url());
    let result = response_payload(
        handle_run_subagent(&args(&[("prompt", json!("Investigate"))]))
            .await
            .unwrap(),
    );
    assert_eq!(result["model"], json!("fallback-model"));

    let disabled_server = MockServer::start(|request| {
        if request.method == "GET" && request.path.starts_with("/api/models") {
            MockResponse::json(json!({
                "data": [
                    {
                        "id": "gpt-5.4-pro",
                        "name": "GPT-5.4 pro",
                        "meta": {
                            "disabled": true,
                            "disabled_reason": "Temporarily disabled due to high costs"
                        }
                    }
                ]
            }))
        } else {
            MockResponse {
                status: 404,
                body: json!({ "error": "unexpected" }),
            }
        }
    });
    env.set_openwebui_base_url(disabled_server.base_url());
    assert_err_contains(
        handle_run_subagent(&args(&[
            ("prompt", json!("Investigate")),
            ("model", json!("gpt-5.4-pro")),
        ]))
        .await,
        "Model 'gpt-5.4-pro' is disabled: Temporarily disabled due to high costs",
    );
}

#[tokio::test]
async fn run_subagent_persists_all_requested_skills() {
    let env = TestEnv::new("run-subagent-skill-cap");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("cached-user");
    for index in 1..=5 {
        env.write_skill(
            &format!("skill-{index}"),
            "Demo skill",
            &[&format!("server:required-{index}")],
        );
    }
    let server = MockServer::start(|request| {
        if request.method == "GET" && request.path.starts_with("/api/models") {
            MockResponse::json(json!({ "data": [{ "id": "default-model", "is_default": true }] }))
        } else {
            match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/folders/") => {
                    MockResponse::json(json!([{ "id": "folder-cap", "name": "Sub-agents" }]))
                }
                ("POST", "/api/v1/chats/new") => {
                    MockResponse::json(json!({ "id": "chat-skill-cap" }))
                }
                ("POST", "/api/chat/completions") => {
                    MockResponse::json(json!({ "task_id": "task-cap" }))
                }
                ("POST", "/api/v1/chats/chat-skill-cap") => {
                    MockResponse::json(json!({ "success": true }))
                }
                ("GET", "/api/v1/chats/chat-skill-cap") => MockResponse::json(json!({
                    "chat": {
                        "models": ["default-model"],
                        "history": {
                            "messages": {
                                "user-1": {
                                    "id": "user-1",
                                    "role": "user",
                                    "content": "Investigate this request",
                                    "timestamp": 123,
                                    "models": ["default-model"]
                                },
                                "assistant-1": {
                                    "id": "assistant-1",
                                    "role": "assistant",
                                    "content": "Subagent done",
                                    "done": true
                                }
                            }
                        },
                        "messages": [
                            { "role": "user", "content": "Investigate this request" },
                            { "role": "assistant", "content": "Subagent done", "done": true }
                        ]
                    }
                })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            }
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let result = response_payload(
        handle_run_subagent(&args(&[
            ("prompt", json!("Investigate this request")),
            (
                "skill_ids",
                json!(["skill-1", "skill-2", "skill-3", "skill-4", "skill-5"]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(result["success"], json!(true));
    let activated_skills: Vec<String> = serde_json::from_str(
        redis_get_string("chat_skills:chat-skill-cap")
            .unwrap()
            .as_deref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(activated_skills.len(), 5);
    assert_eq!(
        activated_skills,
        vec![
            "skill-1".to_string(),
            "skill-2".to_string(),
            "skill-3".to_string(),
            "skill-4".to_string(),
            "skill-5".to_string(),
        ]
    );
}

#[tokio::test]
async fn run_subagent_rejects_missing_or_unknown_models() {
    let env = TestEnv::new("run-subagent-model-errors");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("cached-user");
    let empty_models_server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/models?") => MockResponse::json(json!({ "data": [] })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(empty_models_server.base_url());
    assert_err_contains(
        handle_run_subagent(&args(&[("prompt", json!("Investigate"))])).await,
        "No model specified and no default model available",
    );

    let model_server =
        MockServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/models?") => MockResponse::json(json!({
                    "data": [{ "id": "default-model", "is_default": true, "name": "Default" }]
                })),
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            },
        );
    env.set_openwebui_base_url(model_server.base_url());
    assert_err_contains(
        handle_run_subagent(&args(&[
            ("prompt", json!("Investigate")),
            ("model", json!("missing-model")),
        ]))
        .await,
        "Model 'missing-model' not found in available models",
    );
}

#[tokio::test]
async fn run_subagent_parallel_calls_share_a_single_folder_create() {
    let env = TestEnv::new("run-subagent-parallel-folder-lock");
    env.set_openwebui_token("token");
    env.set_openwebui_user_id("cached-user");
    let folder_created = Arc::new(Mutex::new(false));
    let folder_post_count = Arc::new(Mutex::new(0_usize));
    let next_chat = Arc::new(Mutex::new(0_usize));
    let server = MockServer::start({
        let folder_created = Arc::clone(&folder_created);
        let folder_post_count = Arc::clone(&folder_post_count);
        let next_chat = Arc::clone(&next_chat);
        move |request| {
            if request.method == "GET" && request.path.starts_with("/api/models") {
                return MockResponse::json(json!({
                    "data": [{ "id": "default-model", "is_default": true, "name": "Default" }]
                }));
            }
            if request.method == "GET" && request.path.starts_with("/api/v1/chats/") {
                let chat_id = request.path.trim_start_matches("/api/v1/chats/");
                return MockResponse::json(json!({
                    "chat": {
                        "models": ["default-model"],
                        "history": {
                            "messages": {
                                "assistant-1": {
                                    "id": "assistant-1",
                                    "role": "assistant",
                                    "content": format!("Done for {chat_id}"),
                                    "finishReason": "stop",
                                    "usage": { "prompt_tokens": 4 }
                                }
                            }
                        },
                        "messages": [{
                            "role": "assistant",
                            "content": format!("Done for {chat_id}"),
                            "finishReason": "stop",
                            "usage": { "prompt_tokens": 4 }
                        }]
                    }
                }));
            }
            match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/folders/") => {
                    if *folder_created
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                    {
                        MockResponse::json(json!([{
                            "id": "folder-parallel",
                            "name": "Loupe Update Research",
                            "parent_id": null,
                            "created_at": 1.0
                        }]))
                    } else {
                        MockResponse::json(json!([]))
                    }
                }
                ("POST", "/api/v1/folders/") => {
                    *folder_post_count
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner()) += 1;
                    *folder_created
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner()) = true;
                    MockResponse::json(json!({ "id": "folder-parallel" }))
                }
                ("POST", "/api/v1/chats/new") => {
                    let mut chat_counter = next_chat
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    *chat_counter += 1;
                    MockResponse::json(json!({ "id": format!("chat-{}", *chat_counter) }))
                }
                ("POST", "/api/chat/completions") => {
                    let body: Value = serde_json::from_str(&request.body).expect("completion body");
                    MockResponse::json(json!({
                        "task_id": format!("task-{}", body["chat_id"].as_str().unwrap_or("unknown"))
                    }))
                }
                ("POST", path) if path.starts_with("/api/v1/chats/") => {
                    MockResponse::json(json!({ "success": true }))
                }
                _ => MockResponse {
                    status: 404,
                    body: json!({ "error": "unexpected" }),
                },
            }
        }
    });
    env.set_openwebui_base_url(server.base_url());

    let arguments = args(&[
        ("prompt", json!("Investigate")),
        ("folder_name", json!("Loupe Update Research")),
    ]);
    let (first, second, third) = tokio::join!(
        handle_run_subagent(&arguments),
        handle_run_subagent(&arguments),
        handle_run_subagent(&arguments),
    );

    for result in [first, second, third] {
        let payload = response_payload(result.unwrap());
        assert_eq!(payload["model"], json!("default-model"));
        assert_eq!(payload["success"], json!(true));
        assert_eq!(payload["response_truncated"], json!(false));
        assert!(payload["chat_id"]
            .as_str()
            .unwrap_or_default()
            .starts_with("chat-"));
    }

    assert_eq!(
        *folder_post_count
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()),
        1
    );
    assert_eq!(
        server
            .requests()
            .iter()
            .filter(|request| request.method == "POST" && request.path == "/api/v1/folders/")
            .count(),
        1
    );
}

#[test]
fn linked_started_chat_parent_resolves_root_current_workspace_for_subagents() {
    let env = TestEnv::new("workspace-linked-parent");
    let settings_path = chat_workspace_settings_path().unwrap();
    fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
    let write_settings = |root_path: &str| {
        fs::write(
            &settings_path,
            serde_json::to_string_pretty(&json!({
                "chats": {
                    "root-chat": {
                        "source": "custom",
                        "host_path": root_path,
                        "selected_at": "2026-08-05T00:00:00.000Z"
                    },
                    "started-chat": {
                        "source": "custom",
                        "host_path": "/tmp/stale-snapshot",
                        "selected_at": "2026-08-05T00:00:00.000Z",
                        "linked_workspace": true,
                        "inherited_from_chat_id": "root-chat",
                        "root_parent_chat_id": "root-chat"
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
    };

    let first_root = env.root.join("root-dir-a");
    write_settings(&path_string(&first_root));
    let inheritance = persist_subagent_workspace_inheritance(Some("started-chat"), "grandchild-a")
        .unwrap()
        .unwrap();
    assert_eq!(inheritance.parent_chat_id, "started-chat");
    assert_eq!(inheritance.root_parent_chat_id, "root-chat");
    assert_eq!(inheritance.root_workspace_host_path, first_root);

    // The root rebinds its workspace; a later subagent spawned from the SAME
    // started chat snapshots the root's NEW dir (dynamic follow at spawn).
    let second_root = env.root.join("root-dir-b");
    write_settings(&path_string(&second_root));
    let inheritance = persist_subagent_workspace_inheritance(Some("started-chat"), "grandchild-b")
        .unwrap()
        .unwrap();
    assert_eq!(inheritance.root_parent_chat_id, "root-chat");
    assert_eq!(inheritance.root_workspace_host_path, second_root);
}
