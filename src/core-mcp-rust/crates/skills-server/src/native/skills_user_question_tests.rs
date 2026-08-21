use super::*;

#[tokio::test]
async fn ask_user_question_handler_posts_questions_and_polls_until_completion() {
    let root = TestRoot::new("ask-user-question");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "202 Accepted",
            body: json!({
                "success": true,
                "started": true,
                "flow_id": "flow-123",
                "timeout_seconds": 120
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "flow_id": "flow-123",
                "status": "in_progress"
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "flow_id": "flow-123",
                "status": "completed",
                "result": {
                    "success": true,
                    "status": "submitted",
                    "answers": [{
                        "question_id": "marketplace",
                        "selected_option_id": "my-agent-skills",
                        "selected_option_label": "My Agent Skills",
                        "freeform_text": "Use my personal marketplace for now."
                    }]
                }
            }),
        },
    ]);
    root.set_electron_base(&base);

    let result = call!(
        handle_ask_user_question,
        args(&[
            ("chat_id", json!("chat-publish-1")),
            (
                "questions",
                json!([{
                    "id": "marketplace",
                    "header": "Marketplace",
                    "question": "Which marketplace should receive this skill?",
                    "freeform_placeholder": "Anything else the publishing flow should know?",
                    "options": [
                        {
                            "id": "my-agent-skills",
                            "label": "My Agent Skills",
                            "description": "Publish to your personal marketplace."
                        },
                        {
                            "id": "portico-ai-marketplace",
                            "label": "portico-ai-marketplace",
                            "description": "Open a contribution MR in the shared marketplace."
                        }
                    ]
                }])
            ),
            ("timeout_seconds", json!(120)),
        ])
    );

    assert_eq!(result["success"], json!(true));
    assert_eq!(result["status"], json!("submitted"));
    assert_eq!(
        result["answers"][0]["selected_option_label"],
        json!("My Agent Skills")
    );

    let request = requests.recv().expect("trigger request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/trigger-user-question-flow");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "chat_id": "chat-publish-1",
            "questions": [{
                "id": "marketplace",
                "header": "Marketplace",
                "question": "Which marketplace should receive this skill?",
                "freeform_placeholder": "Anything else the publishing flow should know?",
                "options": [
                    {
                        "id": "my-agent-skills",
                        "label": "My Agent Skills",
                        "description": "Publish to your personal marketplace.",
                        "component_defaults": null
                    },
                    {
                        "id": "portico-ai-marketplace",
                        "label": "portico-ai-marketplace",
                        "description": "Open a contribution MR in the shared marketplace.",
                        "component_defaults": null
                    }
                ],
                "components": [],
                "components_gated_by_option_id": null
            }],
            "timeout_seconds": 120
        })
    );

    let request = requests.recv().expect("first poll request");
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, "/api/user-question-flow-status/flow-123");

    let request = requests.recv().expect("second poll request");
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, "/api/user-question-flow-status/flow-123");
}

#[tokio::test]
async fn ask_user_question_handler_preserves_structured_flow_in_progress_errors() {
    let root = TestRoot::new("ask-user-question-flow-in-progress");
    let (base, requests) = serve_responses(vec![MockReply {
        status: "409 Conflict",
        body: json!({
            "success": false,
            "errorCode": "FLOW_IN_PROGRESS",
            "error": "Another question flow is already active.",
            "flow_id": "flow-active"
        }),
    }]);
    root.set_electron_base(&base);

    let result = call!(
        handle_ask_user_question,
        args(&[
            ("chat_id", json!("chat-publish-1")),
            (
                "questions",
                json!([{
                    "id": "marketplace",
                    "header": "Marketplace",
                    "question": "Which marketplace should receive this skill?",
                    "options": [
                        { "id": "a", "label": "A" },
                        { "id": "b", "label": "B" }
                    ]
                }])
            ),
        ])
    );

    assert_eq!(result["success"], json!(false));
    assert_eq!(result["errorCode"], json!("FLOW_IN_PROGRESS"));
    assert_eq!(result["http_status"], json!(409));
    let request = requests.recv().expect("conflict request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/trigger-user-question-flow");
}

#[tokio::test]
async fn ask_user_question_handler_rejects_duplicate_question_ids_before_calling_electron() {
    let arguments = args(&[
        ("chat_id", json!("chat-publish-1")),
        (
            "questions",
            json!([
                {
                    "id": "duplicate",
                    "header": "One",
                    "question": "First question?",
                    "options": [
                        { "id": "a", "label": "A" },
                        { "id": "b", "label": "B" }
                    ]
                },
                {
                    "id": "duplicate",
                    "header": "Two",
                    "question": "Second question?",
                    "options": [
                        { "id": "c", "label": "C" },
                        { "id": "d", "label": "D" }
                    ]
                }
            ]),
        ),
    ]);

    let error = handle_ask_user_question(&arguments)
        .await
        .expect_err("duplicate question ids should fail validation");
    assert!(error.to_string().contains("Duplicate question id"));
}

#[tokio::test]
async fn ask_user_question_handler_rejects_reserved_none_of_the_above_option_id() {
    let arguments = args(&[
        ("chat_id", json!("chat-publish-1")),
        (
            "questions",
            json!([{
                "id": "marketplace",
                "header": "Marketplace",
                "question": "Which marketplace should receive this skill?",
                "options": [
                    { "id": "none_of_the_above", "label": "Reserved" },
                    { "id": "b", "label": "B" }
                ]
            }]),
        ),
    ]);

    let error = handle_ask_user_question(&arguments)
        .await
        .expect_err("reserved option id should fail validation");
    assert!(error
        .to_string()
        .contains("cannot use reserved option id \"none_of_the_above\""));
}

#[tokio::test]
async fn ask_user_question_handler_accepts_five_caller_supplied_options() {
    let root = TestRoot::new("ask-user-question-five-options");
    let (base, requests) = serve_responses(vec![MockReply {
        status: "409 Conflict",
        body: json!({
            "success": false,
            "errorCode": "FLOW_IN_PROGRESS",
            "error": "Another question flow is already active.",
            "flow_id": "flow-active"
        }),
    }]);
    root.set_electron_base(&base);

    let result = call!(
        handle_ask_user_question,
        args(&[
            ("chat_id", json!("chat-publish-1")),
            (
                "questions",
                json!([{
                    "id": "marketplace",
                    "header": "Marketplace",
                    "question": "Which marketplace should receive this skill?",
                    "options": [
                        { "id": "a", "label": "A" },
                        { "id": "b", "label": "B" },
                        { "id": "c", "label": "C" },
                        { "id": "d", "label": "D" },
                        { "id": "e", "label": "E" }
                    ]
                }])
            ),
        ])
    );

    assert_eq!(result["success"], json!(false));
    assert_eq!(result["errorCode"], json!("FLOW_IN_PROGRESS"));

    let request = requests.recv().expect("trigger request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/trigger-user-question-flow");
}

#[tokio::test]
async fn ask_user_question_handler_requires_chat_id() {
    let arguments = args(&[(
        "questions",
        json!([{
            "id": "marketplace",
            "header": "Marketplace",
            "question": "Which marketplace should receive this skill?",
            "options": [
                { "id": "a", "label": "A" },
                { "id": "b", "label": "B" }
            ]
        }]),
    )]);

    let error = handle_ask_user_question(&arguments)
        .await
        .expect_err("missing chat_id should fail validation");
    assert!(error.to_string().contains("chat_id is required"));
}

#[tokio::test]
async fn ask_user_question_handler_defaults_timeout_to_one_hour() {
    let root = TestRoot::new("ask-user-question-default-timeout");
    let (base, requests) = serve_responses(vec![MockReply {
        status: "409 Conflict",
        body: json!({
            "success": false,
            "errorCode": "FLOW_IN_PROGRESS",
            "error": "Another question flow is already active.",
            "flow_id": "flow-active"
        }),
    }]);
    root.set_electron_base(&base);

    let result = call!(
        handle_ask_user_question,
        args(&[
            ("chat_id", json!("chat-publish-1")),
            (
                "questions",
                json!([{
                    "id": "marketplace",
                    "header": "Marketplace",
                    "question": "Which marketplace should receive this skill?",
                    "options": [
                        { "id": "a", "label": "A" },
                        { "id": "b", "label": "B" }
                    ]
                }])
            ),
        ])
    );

    assert_eq!(result["success"], json!(false));
    assert_eq!(result["errorCode"], json!("FLOW_IN_PROGRESS"));

    let request = requests.recv().expect("conflict request");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap()["timeout_seconds"],
        json!(3600)
    );
}

#[tokio::test]
async fn ask_user_question_handler_rejects_unknown_component_type() {
    let arguments = args(&[
        ("chat_id", json!("chat-c")),
        (
            "questions",
            json!([{
                "id": "caps",
                "header": "Capabilities",
                "question": "What capabilities should your agent have?",
                "components": [{ "type": "wat_picker", "id": "w" }]
            }]),
        ),
    ]);
    let error = handle_ask_user_question(&arguments)
        .await
        .expect_err("unknown component type should fail validation");
    assert!(error.to_string().contains("is not a supported component"));
}

#[tokio::test]
async fn ask_user_question_handler_requires_options_or_components() {
    let arguments = args(&[
        ("chat_id", json!("chat-c")),
        (
            "questions",
            json!([{ "id": "q", "header": "H", "question": "Q?" }]),
        ),
    ]);
    let error = handle_ask_user_question(&arguments)
        .await
        .expect_err("a question with neither options nor components should fail");
    assert!(error.to_string().contains("either options"));
}

#[tokio::test]
async fn ask_user_question_handler_accepts_component_only_question() {
    // A component-only question must PASS validation (options optional) and reach
    // the Electron POST; the mock returns FLOW_IN_PROGRESS so we assert it got
    // past validation without needing a full flow.
    let root = TestRoot::new("ask-user-question-component-only");
    let (base, _requests) = serve_responses(vec![MockReply {
        status: "409 Conflict",
        body: json!({
            "success": false,
            "errorCode": "FLOW_IN_PROGRESS",
            "error": "Another question flow is already active.",
            "flow_id": "flow-active"
        }),
    }]);
    root.set_electron_base(&base);
    let result = call!(
        handle_ask_user_question,
        args(&[
            ("chat_id", json!("chat-c")),
            (
                "questions",
                json!([{
                    "id": "caps",
                    "header": "Capabilities",
                    "question": "What capabilities should your agent have?",
                    "components": [
                        { "type": "skill_picker", "id": "skills" },
                        { "type": "model_picker", "id": "model", "multiple": false },
                        { "type": "reasoning_effort_picker", "id": "effort", "multiple": false }
                    ]
                }])
            ),
        ])
    );
    // Reached the Electron flow (which reported an in-progress conflict) — proof
    // validation accepted the component-only question.
    assert_eq!(result["success"], json!(false));
}

#[tokio::test]
async fn ask_user_question_handler_accepts_component_gate_and_forwards_it_to_electron() {
    let root = TestRoot::new("ask-user-question-component-gate");
    let (base, requests) = serve_responses(vec![MockReply {
        status: "409 Conflict",
        body: json!({
            "success": false,
            "errorCode": "FLOW_IN_PROGRESS",
            "error": "Another question flow is already active.",
            "flow_id": "flow-active"
        }),
    }]);
    root.set_electron_base(&base);
    let result = call!(
        handle_ask_user_question,
        args(&[
            ("chat_id", json!("chat-c")),
            (
                "questions",
                json!([{
                    "id": "capabilities",
                    "header": "Capabilities",
                    "question": "What capabilities should your agent have?",
                    "options": [
                        { "id": "let_agent_decide", "label": "Let the agent enable capabilities as needed" },
                        { "id": "specify", "label": "I'll specify capabilities" }
                    ],
                    "components": [
                        { "type": "skill_picker", "id": "skills", "label": "Skills" },
                        { "type": "mcp_server_picker", "id": "servers", "label": "Tool servers" }
                    ],
                    "components_gated_by_option_id": "specify"
                }])
            ),
        ])
    );
    // Reached the Electron flow — proof validation accepted the gated question.
    assert_eq!(result["success"], json!(false));

    // The normalized payload forwarded to Electron carries the gate.
    let request = requests.recv().expect("trigger request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/trigger-user-question-flow");
    let body = serde_json::from_str::<Value>(&request.body).unwrap();
    assert_eq!(
        body["questions"][0]["components_gated_by_option_id"],
        json!("specify")
    );
}

#[tokio::test]
async fn ask_user_question_handler_forwards_component_defaults_and_default_selected() {
    // FLOW_IN_PROGRESS mock: we only need the normalized trigger body.
    let root = TestRoot::new("ask-user-question-defaults");
    let (base, requests) = serve_responses(vec![MockReply {
        status: "409 Conflict",
        body: json!({
            "success": false,
            "errorCode": "FLOW_IN_PROGRESS",
            "error": "Another question flow is already active.",
            "flow_id": "flow-active"
        }),
    }]);
    root.set_electron_base(&base);
    let result = call!(
        handle_ask_user_question,
        args(&[
            ("chat_id", json!("chat-c")),
            (
                "questions",
                json!([{
                    "id": "capabilities",
                    "header": "Capabilities",
                    "question": "How should we set up capabilities?",
                    "options": [
                        {
                            "id": "recommended",
                            "label": "Start from the recommended set (adjust below)",
                            "component_defaults": {
                                "skills": ["company-knowledge", "web-search"],
                                "servers": []
                            }
                        },
                        { "id": "scratch", "label": "Start from scratch" }
                    ],
                    "components": [
                        {
                            "type": "skill_picker",
                            "id": "skills",
                            "label": "Skills",
                            "default_selected": ["fallback-skill"]
                        },
                        { "type": "mcp_server_picker", "id": "servers", "default_selected": [] }
                    ],
                    "components_gated_by_option_id": "scratch"
                }])
            ),
        ])
    );
    assert_eq!(result["success"], json!(false));

    let request = requests.recv().expect("trigger request");
    let body = serde_json::from_str::<Value>(&request.body).unwrap();
    let question = &body["questions"][0];
    assert_eq!(
        question["options"][0]["component_defaults"],
        json!({ "skills": ["company-knowledge", "web-search"], "servers": [] })
    );
    assert_eq!(question["options"][1]["component_defaults"], json!(null));
    assert_eq!(
        question["components"][0]["default_selected"],
        json!(["fallback-skill"])
    );
    // An empty default_selected normalizes away, unlike explicit
    // component_defaults entries where [] means "reveal this picker empty".
    assert_eq!(question["components"][1]["default_selected"], json!(null));
    assert_eq!(question["components_gated_by_option_id"], json!("scratch"));
}

#[tokio::test]
async fn ask_user_question_handler_rejects_component_defaults_for_unknown_component_id() {
    let arguments = args(&[
        ("chat_id", json!("chat-c")),
        (
            "questions",
            json!([{
                "id": "capabilities",
                "header": "Capabilities",
                "question": "How should we set up capabilities?",
                "options": [
                    {
                        "id": "recommended",
                        "label": "Recommended",
                        "component_defaults": { "wat": ["company-knowledge"] }
                    },
                    { "id": "scratch", "label": "Start from scratch" }
                ],
                "components": [{ "type": "skill_picker", "id": "skills" }]
            }]),
        ),
    ]);
    let error = handle_ask_user_question(&arguments)
        .await
        .expect_err("component_defaults with an unknown key should fail validation");
    assert!(error
        .to_string()
        .contains("component_defaults key \"wat\" does not match any component id"));
}

#[tokio::test]
async fn ask_user_question_handler_rejects_component_defaults_without_components() {
    let arguments = args(&[
        ("chat_id", json!("chat-c")),
        (
            "questions",
            json!([{
                "id": "capabilities",
                "header": "Capabilities",
                "question": "How should we set up capabilities?",
                "options": [
                    {
                        "id": "recommended",
                        "label": "Recommended",
                        "component_defaults": { "skills": ["company-knowledge"] }
                    },
                    { "id": "scratch", "label": "Start from scratch" }
                ]
            }]),
        ),
    ]);
    let error = handle_ask_user_question(&arguments)
        .await
        .expect_err("component_defaults without components should fail validation");
    assert!(error
        .to_string()
        .contains("component_defaults requires components"));
}

#[tokio::test]
async fn ask_user_question_handler_rejects_bad_default_id_lists() {
    // Too many entries.
    let too_many: Vec<String> = (0..21).map(|i| format!("skill-{i}")).collect();
    let arguments = args(&[
        ("chat_id", json!("chat-c")),
        (
            "questions",
            json!([{
                "id": "capabilities",
                "header": "Capabilities",
                "question": "How should we set up capabilities?",
                "components": [
                    { "type": "skill_picker", "id": "skills", "default_selected": too_many }
                ]
            }]),
        ),
    ]);
    let error = handle_ask_user_question(&arguments)
        .await
        .expect_err("oversized default_selected should fail validation");
    assert!(error.to_string().contains("must contain at most 20 items"));

    // Duplicate entries.
    let arguments = args(&[
        ("chat_id", json!("chat-c")),
        (
            "questions",
            json!([{
                "id": "capabilities",
                "header": "Capabilities",
                "question": "How should we set up capabilities?",
                "components": [
                    { "type": "skill_picker", "id": "skills", "default_selected": ["dup", "dup"] }
                ]
            }]),
        ),
    ]);
    let error = handle_ask_user_question(&arguments)
        .await
        .expect_err("duplicate default ids should fail validation");
    assert!(error.to_string().contains("Duplicate id in"));

    // Non-string entries.
    let arguments = args(&[
        ("chat_id", json!("chat-c")),
        (
            "questions",
            json!([{
                "id": "capabilities",
                "header": "Capabilities",
                "question": "How should we set up capabilities?",
                "components": [
                    { "type": "skill_picker", "id": "skills", "default_selected": [42] }
                ]
            }]),
        ),
    ]);
    let error = handle_ask_user_question(&arguments)
        .await
        .expect_err("non-string default ids should fail validation");
    assert!(error.to_string().contains("must be a string"));
}

#[tokio::test]
async fn ask_user_question_handler_rejects_gate_that_matches_no_option_id() {
    let arguments = args(&[
        ("chat_id", json!("chat-c")),
        (
            "questions",
            json!([{
                "id": "capabilities",
                "header": "Capabilities",
                "question": "What capabilities should your agent have?",
                "options": [
                    { "id": "let_agent_decide", "label": "Let the agent decide" },
                    { "id": "specify", "label": "I'll specify capabilities" }
                ],
                "components": [{ "type": "skill_picker", "id": "skills" }],
                "components_gated_by_option_id": "wat"
            }]),
        ),
    ]);
    let error = handle_ask_user_question(&arguments)
        .await
        .expect_err("a gate that matches no option id should fail validation");
    assert!(error
        .to_string()
        .contains("\"wat\" does not match any option id"));
}

#[tokio::test]
async fn ask_user_question_handler_rejects_gate_without_components() {
    let arguments = args(&[
        ("chat_id", json!("chat-c")),
        (
            "questions",
            json!([{
                "id": "capabilities",
                "header": "Capabilities",
                "question": "What capabilities should your agent have?",
                "options": [
                    { "id": "let_agent_decide", "label": "Let the agent decide" },
                    { "id": "specify", "label": "I'll specify capabilities" }
                ],
                "components_gated_by_option_id": "specify"
            }]),
        ),
    ]);
    let error = handle_ask_user_question(&arguments)
        .await
        .expect_err("a gate without components should fail validation");
    assert!(error.to_string().contains("requires components"));
}

#[tokio::test]
async fn ask_user_question_handler_rejects_gate_without_options() {
    let arguments = args(&[
        ("chat_id", json!("chat-c")),
        (
            "questions",
            json!([{
                "id": "capabilities",
                "header": "Capabilities",
                "question": "What capabilities should your agent have?",
                "components": [{ "type": "skill_picker", "id": "skills" }],
                "components_gated_by_option_id": "specify"
            }]),
        ),
    ]);
    let error = handle_ask_user_question(&arguments)
        .await
        .expect_err("a gate without options should fail validation");
    assert!(error.to_string().contains("requires options"));
}
