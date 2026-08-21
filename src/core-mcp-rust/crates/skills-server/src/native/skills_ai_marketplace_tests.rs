use super::*;

// Batch 8 item 6 (headless integration): the native AI-Marketplace proxy tools
// drive the full "publish → read back → install" loop against a FAKE marketplace
// (the mock Electron API returns scripted { success, data } envelopes). This
// exercises the real proxy handlers end-to-end without a live stack.
#[tokio::test]
async fn ai_marketplace_publish_read_back_install_roundtrip() {
    let root = TestRoot::new("ai-marketplace-roundtrip");
    let (base, requests) = serve_responses(vec![
        // 1) publish_skill → the marketplace allocated + persisted the solution.
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "data": { "id": "sol-1", "status": "active", "has_bundle": true }
            }),
        },
        // 2) search_marketplace_solutions → the freshly published solution is discoverable.
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "data": { "solutions": [
                    { "id": "sol-1", "name": "My Skill", "type": "skill", "submitted_by": "me@example.invalid" }
                ] }
            }),
        },
        // 3) get_marketplace_solution → full details.
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "data": { "id": "sol-1", "name": "My Skill", "type": "skill" }
            }),
        },
        // 4) install_marketplace_solution → pulled it back down locally.
        MockReply {
            status: "200 OK",
            body: json!({ "success": true, "data": { "installed": true, "solution_id": "sol-1" } }),
        },
        // 5) list_published_skills → the viewer's own live skills.
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "data": { "solutions": [
                    { "id": "sol-1", "name": "My Skill", "type": "skills", "submitted_by": "me" }
                ], "viewer_email": "me@example.invalid" }
            }),
        },
    ]);
    root.set_electron_base(&base);

    // Publish a local skill.
    let published = call!(
        handle_publish_skill,
        args(&[("skill_id", json!("my-skill"))])
    );
    assert_eq!(published["id"], json!("sol-1"));
    assert_eq!(published["status"], json!("active"));
    let request = requests.recv().expect("publish request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/ai-marketplace/publish-skill");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap()["skill_id"],
        json!("my-skill")
    );

    // Read it back via search.
    let found = call!(
        handle_search_marketplace_solutions,
        args(&[("query", json!("My"))])
    );
    assert_eq!(found["solutions"][0]["id"], json!("sol-1"));
    let request = requests.recv().expect("search request");
    assert_eq!(request.path, "/api/ai-marketplace/search");
    let search_body = serde_json::from_str::<Value>(&request.body).unwrap();
    // Round 11: solutions are STORED as type "skills" (plural) and the
    // marketplace filter is an exact match — the singular "skill" matched
    // nothing and hid every published skill from chat.
    assert_eq!(search_body["params"]["filters"]["type"], json!("skills"));

    // Fetch the full solution.
    let solution = call!(
        handle_get_marketplace_solution,
        args(&[("solution_id", json!("sol-1"))])
    );
    assert_eq!(solution["name"], json!("My Skill"));
    let request = requests.recv().expect("get request");
    assert_eq!(request.path, "/api/ai-marketplace/get-solution");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap()["expected_type"],
        json!("skills")
    );

    // Install (pull down).
    let installed = call!(
        handle_install_marketplace_solution,
        args(&[("solution_id", json!("sol-1"))])
    );
    assert_eq!(installed["installed"], json!(true));
    let request = requests.recv().expect("install request");
    assert_eq!(request.path, "/api/ai-marketplace/install");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({ "id": "sol-1", "expected_type": "skills" })
    );

    // List the viewer's own published skills (the "what have I published?" tool).
    let listed = call!(handle_list_published_skills, Map::new());
    assert_eq!(listed["solutions"][0]["id"], json!("sol-1"));
    let request = requests.recv().expect("list-published request");
    assert_eq!(request.path, "/api/ai-marketplace/list-published");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap()["type"],
        json!("skills")
    );
}

// reclaim_skill proxies the in-place installed→editable conversion: the
// success payload's local_skill_id is authoritative (may be suffixed on
// collision), and ownership failures keep their structured envelope so the
// model can pivot to copy_skill.
#[tokio::test]
async fn ai_marketplace_reclaim_skill_proxies_and_preserves_failures() {
    let root = TestRoot::new("ai-marketplace-reclaim");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "data": {
                    "local_skill_id": "example-skill-2",
                    "solution_id": "sol-1",
                    "previous_local_path": "skills-marketplace/ai-marketplace/example-skill"
                }
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": false,
                "code": "not_owner",
                "error": "The current viewer does not own this AI Marketplace solution.",
                "remediation": "Use list_published_agents or list_published_skills and choose a solution owned by the current viewer."
            }),
        },
    ]);
    root.set_electron_base(&base);

    let reclaimed = call!(
        handle_reclaim_skill,
        args(&[("skill_id", json!("ai-marketplace/example-skill"))])
    );
    assert_eq!(reclaimed["local_skill_id"], json!("example-skill-2"));
    assert_eq!(reclaimed["solution_id"], json!("sol-1"));
    let request = requests.recv().expect("reclaim request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/ai-marketplace/reclaim-skill");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({ "skill_id": "ai-marketplace/example-skill" })
    );

    let foreign = call!(
        handle_reclaim_skill,
        args(&[("skill_id", json!("ai-marketplace/example-skill"))])
    );
    assert_eq!(foreign["success"], json!(false));
    assert_eq!(foreign["code"], json!("not_owner"));
}

// A user-denied publish preserves the structured Electron failure envelope so
// bridge callers can distinguish a denial from a transport failure.
#[tokio::test]
async fn ai_marketplace_publish_surfaces_user_denial_as_error() {
    let root = TestRoot::new("ai-marketplace-denied");
    let (base, _requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": false,
            "denied": true,
            "error": "Publish was not confirmed by the user."
        }),
    }]);
    root.set_electron_base(&base);

    let denied = response_payload(
        handle_publish_skill(&args(&[("skill_id", json!("my-skill"))]))
            .await
            .unwrap(),
    );
    assert_eq!(denied["success"], json!(false));
    assert_eq!(denied["denied"], json!(true));
    assert_eq!(
        denied["error"],
        json!("Publish was not confirmed by the user.")
    );
}

#[tokio::test]
async fn ai_marketplace_proxy_preserves_structured_lifecycle_failures() {
    let root = TestRoot::new("ai-marketplace-structured-failure");
    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": false,
            "code": "solution_type_mismatch",
            "error": "Expected a skill solution.",
            "remediation": "Use a solution id whose Marketplace type matches this tool."
        }),
    }]);
    root.set_electron_base(&base);

    let failed = call!(
        handle_get_marketplace_bundle,
        args(&[("solution_id", json!("agent-solution"))])
    );
    assert_eq!(failed["success"], json!(false));
    assert_eq!(failed["code"], json!("solution_type_mismatch"));
    assert_eq!(
        failed["remediation"],
        json!("Use a solution id whose Marketplace type matches this tool.")
    );

    let request = requests.recv().expect("bundle request");
    assert_eq!(request.path, "/api/ai-marketplace/get-bundle");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({ "id": "agent-solution", "expected_type": "skills" })
    );
}

// PORTICO display_name round: the Electron read layer enriches skill solutions
// with display_name; the Value-passthrough proxy must not drop it.
#[tokio::test]
async fn marketplace_reads_pass_through_display_name_from_electron() {
    let root = TestRoot::new("ai-marketplace-display-name");
    let (base, _requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": true,
            "data": { "solutions": [
                {
                    "id": "sol-1",
                    "name": "epic-voice-booster",
                    "display_name": "Epic Voice Booster",
                    "type": "skills",
                    "submitted_by": "me"
                }
            ], "viewer_email": "me@example.invalid" }
        }),
    }]);
    root.set_electron_base(&base);

    let listed = call!(handle_list_published_skills, Map::new());
    assert_eq!(
        listed["solutions"][0]["display_name"],
        json!("Epic Voice Booster")
    );
}
