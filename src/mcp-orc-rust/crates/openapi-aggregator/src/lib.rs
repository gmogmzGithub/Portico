mod config;
mod handlers;
mod oauth;
mod openapi;
mod status;

pub use config::{invalidate_caches, AppConfig, AppState, SharedState};
pub use handlers::{create_app, run};
pub use oauth::{fetch_oauth_current, fetch_oauth_status, merge_oauth_statuses};
pub use openapi::{
    discover_mcpo_servers, fetch_openapi_spec, get_aggregated_spec, merge_openapi_specs,
};
pub use status::{classify_server_status, ProbeResult};

#[cfg(test)]
mod tests {
    use super::{classify_server_status, merge_oauth_statuses, merge_openapi_specs, ProbeResult};
    use serde_json::json;

    #[test]
    fn merge_openapi_specs_prefixes_paths_and_schema_refs() {
        let specs = vec![(
            "time".to_string(),
            Some(json!({
                "paths": {
                    "/time_get_current_time": {
                        "post": {
                            "operationId": "get_current_time",
                            "requestBody": {
                                "content": {
                                    "application/json": {
                                        "schema": {
                                            "$ref": "#/components/schemas/get_current_time_form_model"
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                "components": {
                    "schemas": {
                        "get_current_time_form_model": {
                            "type": "object"
                        }
                    }
                }
            })),
        )];

        let merged = merge_openapi_specs(&specs);
        assert!(
            merged["paths"]["/time/time_get_current_time"]["post"]["operationId"]
                .as_str()
                .unwrap()
                .starts_with("time_")
        );
        assert_eq!(
            merged["paths"]["/time/time_get_current_time"]["post"]["requestBody"]["content"]
                ["application/json"]["schema"]["$ref"],
            "#/components/schemas/time_get_current_time_form_model"
        );
        assert!(merged["components"]["schemas"]["time_get_current_time_form_model"].is_object());
    }

    #[test]
    fn merge_oauth_statuses_collects_active_and_pending() {
        let merged = merge_oauth_statuses(&[
            (
                "google_workspace".to_string(),
                Some(json!({
                    "current": {
                        "server_name": "google_workspace",
                        "state": "active",
                        "authorization_url": "https://example.test/auth?state=abc",
                    },
                    "pending": [
                        {
                            "server_name": "google_workspace",
                            "state": "active",
                        }
                    ]
                })),
            ),
            ("time".to_string(), None),
        ]);

        assert_eq!(merged["servers_queried"], 2);
        assert_eq!(merged["servers_responding"], 1);
        assert_eq!(merged["active"].as_array().unwrap().len(), 1);
        assert_eq!(merged["pending"].as_array().unwrap().len(), 1);
        assert_eq!(merged["current"]["_source_container"], "google_workspace");
    }

    #[test]
    fn classify_status_marks_tool_ready_only_when_proxy_probe_succeeds() {
        let spec = json!({
            "paths": {
                "/time_get_current_time": {
                    "post": {}
                }
            }
        });
        let status = classify_server_status(
            "time",
            Some(&spec),
            None,
            &ProbeResult {
                ok: true,
                status: Some(422),
                tool_path: Some("/time_get_current_time".to_string()),
                error: None,
            },
        );

        assert_eq!(status["status"], "healthy");
        assert_eq!(status["readiness_phase"], "tool_ready");
        assert_eq!(status["tools_count"], 1);
    }

    #[test]
    fn classify_status_keeps_servers_starting_when_proxy_probe_fails() {
        let spec = json!({
            "paths": {
                "/google_workspace_get_events": {
                    "post": {}
                }
            }
        });
        let status = classify_server_status(
            "google_workspace",
            Some(&spec),
            None,
            &ProbeResult {
                ok: false,
                status: None,
                tool_path: Some("/google_workspace/openapi.json".to_string()),
                error: Some("fetch failed".to_string()),
            },
        );

        assert_eq!(status["status"], "starting");
        assert_eq!(status["readiness_phase"], "starting");
        assert_eq!(status["healthy"], false);
        assert_eq!(
            status["proxy_probe_tool_path"],
            "/google_workspace/openapi.json"
        );
    }

    #[test]
    fn classify_status_prioritizes_oauth_needs_over_tool_probe_health() {
        let spec = json!({
            "paths": {
                "/data_plat_mcp_execute_query": {
                    "post": {}
                }
            }
        });
        let oauth_status = json!({
            "active": [
                {
                    "server_name": "data-plat-mcp",
                    "state": "active",
                    "authorization_url": "https://example.test/auth"
                }
            ]
        });
        let status = classify_server_status(
            "data-plat-mcp",
            Some(&spec),
            Some(&oauth_status),
            &ProbeResult {
                ok: true,
                status: Some(200),
                tool_path: Some("/data-plat-mcp/openapi.json".to_string()),
                error: None,
            },
        );

        assert_eq!(status["status"], "needs_oauth");
        assert_eq!(status["readiness_phase"], "needs_oauth");
        assert_eq!(status["healthy"], false);
        assert_eq!(status["authorization_url_available"], true);
    }

    #[test]
    fn classify_status_marks_active_oauth_url_as_needs_oauth_despite_unauthorized_probe() {
        let oauth_status = json!({
            "active": [
                {
                    "server_name": "datadog",
                    "state": "active",
                    "authorization_url": "https://auth.example.test/authorize"
                }
            ]
        });
        let status = classify_server_status(
            "datadog",
            None,
            Some(&oauth_status),
            &ProbeResult {
                ok: false,
                status: Some(401),
                tool_path: Some("/datadog/openapi.json".to_string()),
                error: Some("http_401".to_string()),
            },
        );

        assert_eq!(status["status"], "needs_oauth");
        assert_eq!(status["readiness_phase"], "needs_oauth");
        assert_eq!(status["healthy"], false);
        assert_eq!(status["authorization_url_available"], true);
        assert_eq!(status["oauth_state"], "active");
    }

    #[test]
    fn classify_status_prioritizes_waiting_callback_over_tool_probe_health() {
        let spec = json!({
            "paths": {
                "/google_workspace_get_events": {
                    "post": {}
                }
            }
        });
        let oauth_status = json!({
            "waiting_callback": [
                {
                    "server_name": "google_workspace",
                    "state": "waiting_callback",
                    "authorization_url": "https://example.test/auth"
                }
            ]
        });
        let status = classify_server_status(
            "google_workspace",
            Some(&spec),
            Some(&oauth_status),
            &ProbeResult {
                ok: true,
                status: Some(200),
                tool_path: Some("/google_workspace/openapi.json".to_string()),
                error: None,
            },
        );

        assert_eq!(status["status"], "waiting_callback");
        assert_eq!(status["readiness_phase"], "waiting_callback");
        assert_eq!(status["healthy"], false);
    }

    #[test]
    fn classify_status_marks_needs_oauth_without_openapi_spec_when_oauth_is_pending() {
        let oauth_status = json!({
            "active": [
                {
                    "server_name": "portico-taxonomy",
                    "state": "active",
                    "authorization_url": "https://example.test/auth"
                }
            ]
        });
        let status = classify_server_status(
            "portico-taxonomy",
            None,
            Some(&oauth_status),
            &ProbeResult {
                ok: false,
                status: None,
                tool_path: None,
                error: None,
            },
        );

        assert_eq!(status["status"], "needs_oauth");
        assert_eq!(status["readiness_phase"], "needs_oauth");
        assert_eq!(status["healthy"], false);
        assert_eq!(status["openapi_available"], false);
        assert_eq!(status["authorization_url_available"], true);
    }

    #[test]
    fn classify_status_marks_waiting_callback_without_openapi_spec() {
        let oauth_status = json!({
            "waiting_callback": [
                {
                    "server_name": "portico-taxonomy",
                    "state": "waiting_callback",
                    "authorization_url": "https://example.test/auth"
                }
            ]
        });
        let status = classify_server_status(
            "portico-taxonomy",
            None,
            Some(&oauth_status),
            &ProbeResult {
                ok: false,
                status: None,
                tool_path: None,
                error: None,
            },
        );

        assert_eq!(status["status"], "waiting_callback");
        assert_eq!(status["readiness_phase"], "waiting_callback");
        assert_eq!(status["healthy"], false);
        assert_eq!(status["openapi_available"], false);
    }
}
