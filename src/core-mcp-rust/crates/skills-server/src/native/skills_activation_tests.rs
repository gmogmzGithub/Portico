use super::*;
use std::time::Duration;

fn drain_request_paths(requests: &std::sync::mpsc::Receiver<CapturedRequest>) -> Vec<String> {
    let mut paths = Vec::new();
    while let Ok(request) = requests.recv_timeout(Duration::from_millis(100)) {
        paths.push(request.path);
    }
    paths
}

#[tokio::test]
async fn activation_and_deactivation_cover_stateful_skill_branches() {
    let root = TestRoot::new("activation-state");
    root.write_skill(
        "skills",
        "activatable",
        &skill_markdown("Activatable", "Ready to activate", &[]),
    );
    root.write_skill(
        "skills",
        "second-skill",
        &skill_markdown("Second Skill", "Also ready", &[]),
    );

    redis_set_string("chat_skills:chat-state", "not-json").unwrap();
    redis_set_string("chat_tools:chat-state", "not-json").unwrap();

    let activated = call!(
        handle_activate_skill,
        skill_chat_args("activatable", "chat-state")
    );
    assert_eq!(activated["success"], json!(true));
    assert_eq!(activated["activated_skills"], json!(["activatable"]));
    assert_eq!(activated["enabled_mcp_servers"], json!([]));
    assert_eq!(activated["newly_enabled_mcp_servers"], json!([]));
    assert_eq!(activated["already_enabled_mcp_servers"], json!([]));
    assert_eq!(
        redis_string_list("chat_skills:chat-state"),
        vec!["activatable".to_string()]
    );
    assert_eq!(
        redis_string_list("chat_tools:chat-state"),
        Vec::<String>::new()
    );
    assert!(redis_get_string("skill_content:activatable")
        .unwrap()
        .unwrap()
        .contains("Body for Activatable"));

    let already_activated = call!(
        handle_activate_skill,
        skill_chat_args("activatable", "chat-state")
    );
    assert_eq!(already_activated["success"], json!(true));
    assert_eq!(
        already_activated["message"],
        json!("Skill 'activatable' already activated")
    );
    assert_eq!(already_activated["total_activated"], json!(1));

    let second = call!(
        handle_activate_skill,
        skill_chat_args("second-skill", "chat-state")
    );
    assert_eq!(second["success"], json!(true));
    assert_eq!(
        second["activated_skills"],
        json!(["activatable", "second-skill"])
    );

    let listed = call!(
        handle_get_activated_skills,
        args(&[("chat_id", json!("chat-state"))])
    );
    assert_eq!(listed["success"], json!(true));
    assert_eq!(listed["total"], json!(2));
    assert!(listed.get("max_skills").is_none());
    assert_eq!(listed["activated_skills"][0]["name"], json!("activatable"));
    assert_eq!(
        listed["activated_skills"][0]["description"],
        json!("Ready to activate")
    );
    assert_eq!(listed["activated_skills"][1]["name"], json!("second-skill"));

    let missing = call!(
        handle_deactivate_skill,
        skill_chat_args("missing-skill", "chat-state")
    );
    assert_eq!(missing["success"], json!(false));
    assert_eq!(
        missing["activated_skills"],
        json!(["activatable", "second-skill"])
    );

    let removed_one = call!(
        handle_deactivate_skill,
        skill_chat_args("activatable", "chat-state")
    );
    assert_eq!(removed_one["success"], json!(true));
    assert_eq!(removed_one["remaining_skills"], json!(["second-skill"]));
    assert_eq!(
        redis_string_list("chat_skills:chat-state"),
        vec!["second-skill".to_string()]
    );

    let removed_last = call!(
        handle_deactivate_skill,
        skill_chat_args("second-skill", "chat-state")
    );
    assert_eq!(removed_last["success"], json!(true));
    assert_eq!(removed_last["remaining_skills"], json!([]));
    assert!(redis_get_string("chat_skills:chat-state")
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn activation_covers_blocked_integrations_and_unbounded_skill_activation() {
    let root = TestRoot::new("activation-blocked");
    root.write_relative("mcp-configs", "calendar/calendar.yaml", "name: Calendar\n");
    root.write_relative("mcp-configs", "notes/notes.yaml", "name: Notes\n");
    root.write_skill(
        "skills",
        "calendar-blocked",
        &skill_markdown("Calendar Blocked", "Needs calendar", &["server:calendar"]),
    );
    root.write_skill(
        "skills",
        "restart-blocked",
        &skill_markdown("Restart Blocked", "Needs notes", &["server:notes"]),
    );
    root.write_skill(
        "skills",
        "limit-extra",
        &skill_markdown("Limit Extra", "Should hit max", &[]),
    );

    root.write_toggles(&json!({ "calendar": false }));
    let disabled = call!(
        handle_activate_skill,
        skill_chat_args("calendar-blocked", "chat-disabled")
    );
    assert_eq!(disabled["success"], json!(false));
    assert_eq!(disabled["activated_skills"], json!([]));
    assert_eq!(
        disabled["blocked_integrations"][0]["tool_server_id"],
        json!("server:calendar")
    );
    assert_eq!(
        disabled["blocked_integrations"][0]["readiness_phase"],
        json!(READINESS_PHASE_DISABLED)
    );
    assert_eq!(
        disabled["blocked_integrations"][0]["recovery_hint"],
        json!("integration_disabled")
    );
    assert_eq!(
        disabled["message"],
        json!("One or more MCP servers required by this skill are not ready yet because the dependency is disabled.")
    );
    assert!(disabled["next_steps"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item
            .as_str()
            .unwrap()
            .contains("mcp_assistant_toggle_integration")));

    root.write_toggles(&json!({}));
    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({"healthy": false, "readiness_phase": "failed", "discovered": true}),
    }]);
    root.set_electron_base(&base);
    let restart = call!(
        handle_activate_skill,
        skill_chat_args("restart-blocked", "chat-restart")
    );
    assert_eq!(restart["success"], json!(false));
    assert_eq!(
        restart["blocked_integrations"][0]["recovery_hint"],
        json!("restart_recommended")
    );
    assert_eq!(
        restart["message"],
        json!("One or more MCP servers required by this skill are not ready yet. At least one blocked dependency is not actively starting, so waiting longer will not fix it by itself.")
    );
    let paths = drain_request_paths(&requests);
    assert!(paths.contains(&"/api/server-readiness/notes".to_string()));

    redis_setex_string(
        "chat_skills:chat-limit",
        &serde_json::to_string(&vec!["one", "two", "three", "four"]).unwrap(),
        60,
    )
    .unwrap();
    let limited = call!(
        handle_activate_skill,
        skill_chat_args("limit-extra", "chat-limit")
    );
    assert_eq!(limited["success"], json!(true));
    assert!(limited.get("max_skills").is_none());
    assert_eq!(
        limited["activated_skills"],
        json!(["one", "two", "three", "four", "limit-extra"])
    );
    assert_eq!(limited["total_activated"], json!(5));
}

#[tokio::test]
async fn activation_tracks_newly_enabled_and_existing_mcp_servers() {
    let root = TestRoot::new("activation-tools");
    root.write_relative("mcp-configs", "already/already.yaml", "name: Already\n");
    root.write_relative("mcp-configs", "new/new.yaml", "name: New\n");
    root.write_skill(
        "skills",
        "tool-skill",
        &skill_markdown(
            "Tool Skill",
            "Needs MCP servers",
            &["server:already", "server:new"],
        ),
    );

    redis_setex_string(
        "chat_tools:chat-tools",
        &serde_json::to_string(&vec!["server:already"]).unwrap(),
        60,
    )
    .unwrap();
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({"healthy": true, "readiness_phase": READINESS_PHASE_TOOL_READY}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"healthy": true, "readiness_phase": READINESS_PHASE_TOOL_READY}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"healthy": true, "readiness_phase": READINESS_PHASE_TOOL_READY}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"healthy": true, "readiness_phase": READINESS_PHASE_TOOL_READY}),
        },
    ]);
    root.set_electron_base(&base);

    let activated = call!(
        handle_activate_skill,
        skill_chat_args("tool-skill", "chat-tools")
    );
    assert_eq!(activated["success"], json!(true));
    assert_eq!(activated["activated_skills"], json!(["tool-skill"]));
    assert_eq!(
        activated["enabled_mcp_servers"],
        json!(["server:already", "server:new"])
    );
    assert_eq!(
        activated["newly_enabled_mcp_servers"],
        json!(["server:new"])
    );
    assert_eq!(
        activated["already_enabled_mcp_servers"],
        json!(["server:already"])
    );
    assert_eq!(
        activated["skill_info"]["required_mcp_servers"],
        json!(["server:already", "server:new"])
    );
    let paths = drain_request_paths(&requests);
    assert!(paths.contains(&"/api/server-readiness/already".to_string()));
    assert!(paths.contains(&"/api/server-readiness/new".to_string()));
    assert_eq!(
        redis_string_list("chat_tools:chat-tools"),
        vec!["server:already".to_string(), "server:new".to_string()]
    );

    let reactivated = call!(
        handle_activate_skill,
        skill_chat_args("tool-skill", "chat-tools")
    );
    assert_eq!(reactivated["success"], json!(true));
    assert_eq!(
        reactivated["message"],
        json!("Skill 'tool-skill' was already activated and its MCP dependencies are ready")
    );
    let paths = drain_request_paths(&requests);
    assert!(paths.contains(&"/api/server-readiness/already".to_string()));
    assert!(paths.contains(&"/api/server-readiness/new".to_string()));
}

#[tokio::test]
async fn concurrent_activate_skill_calls_merge_chat_state() {
    let root = TestRoot::new("activation-race");
    root.write_relative("mcp-configs", "pdf/pdf.yaml", "name: PDF\n");
    root.write_skill(
        "skills",
        "delayed-skill",
        &skill_markdown("Delayed Skill", "Waits on readiness", &["server:pdf"]),
    );
    root.write_skill(
        "skills",
        "fast-skill",
        &skill_markdown("Fast Skill", "No MCP dependency", &[]),
    );

    let (base, requests) = serve_delayed_responses(vec![(
        200,
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": true,
                "readiness_phase": READINESS_PHASE_TOOL_READY,
                "discovered": true
            }),
        },
    )]);
    root.set_electron_base(&base);

    let delayed_args = skill_chat_args("delayed-skill", "chat-race");
    let delayed = tokio::spawn(async move {
        response_payload(handle_activate_skill(&delayed_args).await.unwrap())
    });

    tokio::time::sleep(Duration::from_millis(25)).await;

    let fast_args = skill_chat_args("fast-skill", "chat-race");
    let fast =
        tokio::spawn(
            async move { response_payload(handle_activate_skill(&fast_args).await.unwrap()) },
        );

    let delayed = delayed.await.unwrap();
    let fast = fast.await.unwrap();

    assert_eq!(delayed["success"], json!(true));
    assert_eq!(fast["success"], json!(true));
    assert_eq!(
        redis_string_list("chat_skills:chat-race"),
        vec!["delayed-skill".to_string(), "fast-skill".to_string()]
    );
    assert_eq!(
        redis_string_list("chat_tools:chat-race"),
        vec!["server:pdf".to_string()]
    );
    let paths = drain_request_paths(&requests);
    assert!(paths.contains(&"/api/server-readiness/pdf".to_string()));
}

#[tokio::test]
async fn missing_skill_dependencies_fail_before_lock_and_return_all_missing_servers() {
    let root = TestRoot::new("activation-missing-before-lock");
    root.write_skill(
        "skills",
        "delayed-skill",
        &skill_markdown("Delayed Skill", "Waits on readiness", &["server:known"]),
    );
    root.write_skill(
        "skills",
        "missing-skill",
        &skill_markdown(
            "Missing Skill",
            "Depends on removed servers",
            &[
                "server:missing-one",
                "server:missing-two",
                "server:missing-one",
            ],
        ),
    );
    root.write_relative("mcp-configs", "known/known.yaml", "name: Known\n");

    let (base, requests) = serve_delayed_responses(vec![(
        1000,
        MockReply {
            status: "200 OK",
            body: json!({
                "healthy": true,
                "readiness_phase": READINESS_PHASE_TOOL_READY,
                "discovered": true
            }),
        },
    )]);
    root.set_electron_base(&base);

    let delayed_args = skill_chat_args("delayed-skill", "chat-missing");
    let delayed = tokio::spawn(async move {
        response_payload(handle_activate_skill(&delayed_args).await.unwrap())
    });

    tokio::time::sleep(Duration::from_millis(25)).await;

    let missing_args = skill_chat_args("missing-skill", "chat-missing");
    let missing = tokio::time::timeout(Duration::from_millis(250), async move {
        response_payload(handle_activate_skill(&missing_args).await.unwrap())
    })
    .await
    .expect("missing dependency activation should fail before waiting on the lock");

    assert_eq!(missing["success"], json!(false));
    assert_eq!(
        missing["message"],
        json!("One or more MCP servers required by this skill are not installed in this app.")
    );
    assert_eq!(
        missing["blocked_integrations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["tool_server_id"].as_str().unwrap().to_string())
            .collect::<Vec<_>>(),
        vec![
            "server:missing-one".to_string(),
            "server:missing-two".to_string()
        ]
    );
    assert!(missing["next_steps"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item.as_str().unwrap().contains("service_not_found")));
    assert!(redis_get_string("chat_skills:chat-missing")
        .unwrap()
        .is_none());
    assert!(redis_get_string("chat_tools:chat-missing")
        .unwrap()
        .is_none());

    let delayed = delayed.await.unwrap();
    assert_eq!(delayed["success"], json!(true));
    let paths = drain_request_paths(&requests);
    assert!(paths.contains(&"/api/server-readiness/known".to_string()));
    assert!(!paths
        .iter()
        .any(|path| path.contains("missing-one") || path.contains("missing-two")));
}

#[tokio::test]
async fn prefixed_reference_and_script_paths_cover_cache_and_fallback_branches() {
    let root = TestRoot::new("prefixed-paths");

    root.write_skill(
        "skills-user",
        "prefixed-skill",
        &skill_markdown("Prefixed Skill", "User managed", &[]),
    );

    let created_reference = call!(
        handle_create_skill_reference,
        args(&[
            ("skill_name", json!("prefixed-skill")),
            ("reference_path", json!("references/nested/guide.md")),
            ("content", json!("reference v1"))
        ])
    );
    assert_eq!(created_reference["success"], json!(true));
    assert_eq!(
        created_reference["reference_path"],
        json!("references/nested/guide.md")
    );

    let updated_reference = call!(
        handle_update_skill_reference,
        args(&[
            ("skill_name", json!("prefixed-skill")),
            ("reference_path", json!("references/nested/guide.md")),
            ("content", json!("reference v2"))
        ])
    );
    assert_eq!(updated_reference["success"], json!(true));

    let missing_skill_reference = call!(
        handle_get_skill_reference,
        args(&[
            ("skill_name", json!("missing-skill")),
            ("reference_path", json!("guide.md"))
        ])
    );
    assert_eq!(missing_skill_reference["success"], json!(false));

    let fetched_reference = call!(
        handle_get_skill_reference,
        args(&[
            ("skill_name", json!("prefixed-skill")),
            ("reference_path", json!("references/nested/guide.md")),
            ("chat_id", json!("chat-ref-cache"))
        ])
    );
    assert_eq!(fetched_reference["success"], json!(true));
    assert_eq!(fetched_reference["content"], json!("reference v2"));
    assert_eq!(
        redis_get_string("skill_ref_content:prefixed-skill:references/nested/guide.md")
            .unwrap()
            .unwrap(),
        "reference v2"
    );
    assert_eq!(
        redis_string_list("chat_skill_refs:chat-ref-cache"),
        vec!["skill_ref_content:prefixed-skill:references/nested/guide.md".to_string()]
    );

    let fetched_reference_again = call!(
        handle_get_skill_reference,
        args(&[
            ("skill_name", json!("prefixed-skill")),
            ("reference_path", json!("references/nested/guide.md")),
            ("chat_id", json!("chat-ref-cache"))
        ])
    );
    assert_eq!(fetched_reference_again["success"], json!(true));
    assert_eq!(
        redis_string_list("chat_skill_refs:chat-ref-cache"),
        vec!["skill_ref_content:prefixed-skill:references/nested/guide.md".to_string()]
    );

    let deleted_reference = call!(
        handle_delete_skill_reference,
        args(&[
            ("skill_name", json!("prefixed-skill")),
            ("reference_path", json!("references/nested/guide.md"))
        ])
    );
    assert_eq!(deleted_reference["success"], json!(true));
    assert!(!root
        .path
        .join("skills-user/prefixed-skill/references/nested/guide.md")
        .exists());

    let created_script = call!(
        handle_create_skill_script,
        args(&[
            ("skill_name", json!("prefixed-skill")),
            ("script_path", json!("scripts/nested/task.py")),
            ("content", json!("print('one')"))
        ])
    );
    assert_eq!(created_script["success"], json!(true));
    assert_eq!(
        created_script["script_path"],
        json!("scripts/nested/task.py")
    );

    let updated_script = call!(
        handle_update_skill_script,
        args(&[
            ("skill_name", json!("prefixed-skill")),
            ("script_path", json!("scripts/nested/task.py")),
            ("content", json!("print('two')"))
        ])
    );
    assert_eq!(updated_script["success"], json!(true));
    assert_eq!(
        fs::read_to_string(
            root.path
                .join("skills-user/prefixed-skill/scripts/nested/task.py")
        )
        .unwrap(),
        "print('two')"
    );

    let deleted_script = call!(
        handle_delete_skill_script,
        args(&[
            ("skill_name", json!("prefixed-skill")),
            ("script_path", json!("scripts/nested/task.py"))
        ])
    );
    assert_eq!(deleted_script["success"], json!(true));
    assert!(!root
        .path
        .join("skills-user/prefixed-skill/scripts/nested/task.py")
        .exists());

    redis_setex_string(
        "chat_skills:chat-metadata",
        &serde_json::to_string(&vec!["ghost-skill"]).unwrap(),
        60,
    )
    .unwrap();
    let missing_metadata = call!(
        handle_get_activated_skills,
        args(&[("chat_id", json!("chat-metadata"))])
    );
    assert_eq!(missing_metadata["success"], json!(true));
    assert_eq!(missing_metadata["total"], json!(1));
    assert_eq!(
        missing_metadata["activated_skills"][0]["name"],
        json!("ghost-skill")
    );
    assert_eq!(
        missing_metadata["activated_skills"][0]["description"],
        json!("Metadata unavailable")
    );

    redis_set_string("chat_skills:chat-bad-json", "not-json").unwrap();
    let invalid_json = call!(
        handle_get_activated_skills,
        args(&[("chat_id", json!("chat-bad-json"))])
    );
    assert_eq!(invalid_json["success"], json!(true));
    assert_eq!(invalid_json["activated_skills"], json!([]));
    assert_eq!(invalid_json["total"], json!(0));
}

#[tokio::test]
async fn activation_reports_oauth_block_message() {
    let root = TestRoot::new("activation-oauth");
    root.write_relative("mcp-configs", "drive/drive.yaml", "name: Drive\n");
    root.write_skill(
        "skills",
        "oauth-skill",
        &skill_markdown("Oauth Skill", "Needs OAuth", &["server:drive"]),
    );

    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "healthy": false,
            "readiness_phase": READINESS_PHASE_NEEDS_OAUTH,
            "discovered": true
        }),
    }]);
    root.set_electron_base(&base);

    let blocked = call!(
        handle_activate_skill,
        skill_chat_args("oauth-skill", "chat-oauth")
    );
    assert_eq!(blocked["success"], json!(false));
    assert_eq!(
        blocked["blocked_integrations"][0]["recovery_hint"],
        json!("oauth_required")
    );
    assert_eq!(
        blocked["message"],
        json!("One or more MCP servers required by this skill are not ready yet because OAuth authorization is still required.")
    );
    let paths = drain_request_paths(&requests);
    assert!(paths.contains(&"/api/server-readiness/drive".to_string()));
}
