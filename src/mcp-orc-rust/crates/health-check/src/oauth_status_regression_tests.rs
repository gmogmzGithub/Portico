use crate::app::{
    health_status_for_missing_server, lookup_oauth_status_missing, ContainerLogInspector,
    OAuthStatusPayload, ServerMetadata,
};
use serde_json::json;

#[derive(Default)]
struct SilentLogInspector;

impl ContainerLogInspector for SilentLogInspector {
    fn has_errors(&self, _container_name: &str, _lines: usize) -> bool {
        false
    }
}

fn docker_server(server_id: &str) -> ServerMetadata {
    ServerMetadata {
        id: server_id.to_string(),
        name: server_id.to_string(),
        deployment_type: "docker".to_string(),
        is_core: false,
        has_oauth: true,
        user_installed: false,
        is_configured: true,
        config_error: None,
    }
}

#[test]
fn missing_server_uses_active_oauth_entries_even_when_current_points_elsewhere() {
    let payload = OAuthStatusPayload {
        current: Some(json!({
            "server_name": "data-plat-mcp",
            "state": "active",
        })),
        active: vec![
            json!({
                "server_name": "data-plat-mcp",
                "state": "active",
            }),
            json!({
                "server_name": "datadog",
                "state": "active",
            }),
            json!({
                "server_name": "mcp-atlassian",
                "state": "active",
            }),
        ],
        ..OAuthStatusPayload::default()
    };

    assert_eq!(
        lookup_oauth_status_missing("datadog", &payload),
        (Some("active".to_string()), None)
    );
    assert_eq!(
        lookup_oauth_status_missing("mcp-atlassian", &payload),
        (Some("active".to_string()), None)
    );

    let inspector = SilentLogInspector;
    let datadog = health_status_for_missing_server(
        "datadog",
        &docker_server("datadog"),
        &payload,
        &inspector,
    );
    let atlassian = health_status_for_missing_server(
        "mcp-atlassian",
        &docker_server("mcp-atlassian"),
        &payload,
        &inspector,
    );

    assert_eq!(datadog["status"], json!("needs_oauth"));
    assert_eq!(datadog["oauth_state"], json!("active"));
    assert_eq!(atlassian["status"], json!("needs_oauth"));
    assert_eq!(atlassian["oauth_state"], json!("active"));
}
