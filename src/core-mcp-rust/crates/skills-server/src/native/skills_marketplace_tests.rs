use super::*;

#[tokio::test]
async fn marketplace_handlers_proxy_to_electron_api_with_expected_paths_and_payloads() {
    let root = TestRoot::new("marketplace-handlers");
    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "data": {"marketplaces": [], "installedSkills": []}}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "marketplace": {"id": "trustkit"}}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "marketplace": {"id": "trustkit"}, "skills": []}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "localPath": "skills-marketplace/trustkit/trustkit", "version": "1.0.0"}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "marketplaceId": "trustkit", "removedInstalledSkills": true, "removedSkillsCount": 1}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "marketplace": {"id": "trustkit"}, "hasUpdate": true}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "results": [{"id": "trustkit", "success": true, "hasUpdate": false}]}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "marketplaceId": "trustkit", "skillId": "trustkit"}),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "marketplaceId": "trustkit",
                "skillId": "trustkit",
                "skillName": "trustkit-detached",
                "localPath": "skills-user/trustkit-detached",
                "previousLocalPath": "skills-marketplace/trustkit/trustkit"
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "updates": [], "hasUpdates": false}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "version": "2.0.0"}),
        },
    ]);
    root.set_electron_base(&base);

    let listed = call!(handle_list_marketplaces, args(&[]));
    assert_eq!(listed["success"], json!(true));
    let request = requests.recv().expect("list request");
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, "/api/marketplaces");
    assert_eq!(request.body, "");

    let added = call!(
        handle_add_marketplace,
        args(&[("source_input", json!("squall-mod/trust-kit"))])
    );
    assert_eq!(added["success"], json!(true));
    let request = requests.recv().expect("add request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/marketplaces");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({ "source_input": "squall-mod/trust-kit" })
    );

    let skills = call!(
        handle_get_marketplace_skills,
        args(&[("marketplace_id", json!("trustkit"))])
    );
    assert_eq!(skills["success"], json!(true));
    let request = requests.recv().expect("skills request");
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, "/api/marketplaces/trustkit/skills");

    let installed = call!(
        handle_install_marketplace_skill,
        args(&[
            ("marketplace_id", json!("trustkit")),
            ("skill_id", json!("trustkit")),
            ("skill_path", json!("./.claude/skills/trustkit")),
            (
                "skill_source",
                json!({
                    "type": "gitlab",
                    "host": "example.invalid",
                    "projectPath": "squall-mod/trust-kit"
                })
            )
        ])
    );
    assert_eq!(installed["success"], json!(true));
    let request = requests.recv().expect("install request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/marketplaces/skills/install");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "marketplace_id": "trustkit",
            "skill_id": "trustkit",
            "skill_path": "./.claude/skills/trustkit",
            "skill_source": {
                "type": "gitlab",
                "host": "example.invalid",
                "projectPath": "squall-mod/trust-kit"
            },
            "plugin_name": null
        })
    );

    let removed = call!(
        handle_remove_marketplace,
        args(&[
            ("marketplace_id", json!("trustkit")),
            ("remove_installed_skills", json!(true))
        ])
    );
    assert_eq!(removed["success"], json!(true));
    let request = requests.recv().expect("remove request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/marketplaces/remove");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "marketplace_id": "trustkit",
            "remove_installed_skills": true
        })
    );

    let synced = call!(
        handle_sync_marketplace,
        args(&[("marketplace_id", json!("trustkit"))])
    );
    assert_eq!(synced["success"], json!(true));
    let request = requests.recv().expect("sync request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/marketplaces/sync");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({ "marketplace_id": "trustkit" })
    );

    let synced_all = call!(handle_sync_all_marketplaces, args(&[]));
    assert_eq!(synced_all["success"], json!(true));
    let request = requests.recv().expect("sync-all request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/marketplaces/sync-all");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({})
    );

    let uninstalled = call!(
        handle_uninstall_marketplace_skill,
        args(&[
            ("marketplace_id", json!("trustkit")),
            ("skill_id", json!("trustkit"))
        ])
    );
    assert_eq!(uninstalled["success"], json!(true));
    let request = requests.recv().expect("uninstall request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/marketplaces/skills/uninstall");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "marketplace_id": "trustkit",
            "skill_id": "trustkit",
            "plugin_name": null
        })
    );

    let detached = call!(
        handle_detach_marketplace_skill_to_user_skill,
        args(&[
            ("marketplace_id", json!("trustkit")),
            ("skill_id", json!("trustkit"))
        ])
    );
    assert_eq!(detached["success"], json!(true));
    let request = requests.recv().expect("detach request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/marketplaces/skills/detach");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "marketplace_id": "trustkit",
            "skill_id": "trustkit",
            "target_skill_name": null,
            "plugin_name": null
        })
    );

    let checked = call!(handle_check_marketplace_skill_updates, args(&[]));
    assert_eq!(checked["success"], json!(true));
    let request = requests.recv().expect("check-updates request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/marketplaces/skills/check-updates");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({})
    );

    let updated = call!(
        handle_update_marketplace_skill,
        args(&[
            ("marketplace_id", json!("trustkit")),
            ("skill_id", json!("trustkit")),
            ("force_discard_local_changes", json!(true))
        ])
    );
    assert_eq!(updated["success"], json!(true));
    let request = requests.recv().expect("update request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/marketplaces/skills/update");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "marketplace_id": "trustkit",
            "skill_id": "trustkit",
            "force_discard_local_changes": true,
            "plugin_name": null
        })
    );
}

#[tokio::test]
async fn marketplace_handlers_preserve_structured_errors_and_transport_failures() {
    let root = TestRoot::new("marketplace-errors");
    let (base, requests) = serve_responses(vec![MockReply {
        status: "404 Not Found",
        body: json!({
            "success": false,
            "error": "Marketplace \"missing\" not found",
            "errorCode": "marketplace_not_found"
        }),
    }]);
    root.set_electron_base(&base);

    let missing = call!(
        handle_sync_marketplace,
        args(&[("marketplace_id", json!("missing"))])
    );
    assert_eq!(missing["success"], json!(false));
    assert_eq!(missing["errorCode"], json!("marketplace_not_found"));
    assert_eq!(missing["http_status"], json!(404));
    let request = requests.recv().expect("missing sync request");
    assert_eq!(request.path, "/api/marketplaces/sync");

    root.set_electron_base("http://127.0.0.1:9");
    let unavailable = call!(handle_list_marketplaces, args(&[]));
    assert_eq!(unavailable["success"], json!(false));
    assert!(unavailable["error"]
        .as_str()
        .unwrap_or_default()
        .contains("Failed to list marketplaces"));
}
