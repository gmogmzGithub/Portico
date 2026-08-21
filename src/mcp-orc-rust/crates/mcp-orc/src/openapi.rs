use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

use crate::app::ToolRoute;

fn titleize_route(route_name: &str) -> String {
    route_name
        .split('_')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let mut chars = segment.chars();
            let first = chars.next().expect("empty segments are filtered above");
            format!("{}{}", first.to_ascii_uppercase(), chars.as_str())
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn build_response_schema(tool: &ToolRoute) -> Value {
    match tool.output_schema.as_ref() {
        Some(schema) => json!({
            "description": "Successful response",
            "content": {
                "application/json": {
                    "schema": schema
                }
            }
        }),
        None => json!({
            "description": "Successful response",
            "content": {
                "application/json": {
                    "schema": {
                        "oneOf": [
                            { "type": "object" },
                            { "type": "array" },
                            { "type": "string" },
                            { "type": "number" },
                            { "type": "boolean" },
                            { "type": "null" }
                        ]
                    }
                }
            }
        }),
    }
}

fn build_request_body(tool: &ToolRoute) -> Value {
    json!({
        "required": false,
        "content": {
            "application/json": {
                "schema": tool.input_schema
            }
        }
    })
}

pub fn build_server_openapi(
    server_id: &str,
    server_title: &str,
    server_version: Option<&str>,
    tools: &BTreeMap<String, ToolRoute>,
) -> Value {
    let mut paths = Map::new();

    for tool in tools.values() {
        let summary = tool
            .display_name
            .clone()
            .or_else(|| tool.title.clone())
            .unwrap_or_else(|| titleize_route(&tool.route_name));
        let mut operation = Map::new();
        operation.insert("summary".to_string(), Value::String(summary));
        operation.insert(
            "operationId".to_string(),
            Value::String(tool.route_name.clone()),
        );
        operation.insert(
            "description".to_string(),
            Value::String(tool.description.clone().unwrap_or_default()),
        );
        operation.insert("requestBody".to_string(), build_request_body(tool));
        operation.insert(
            "responses".to_string(),
            json!({
                "200": build_response_schema(tool),
                "404": {
                    "description": "Tool not found"
                },
                "500": {
                    "description": "Tool execution failed"
                },
                "504": {
                    "description": "Tool execution timed out"
                }
            }),
        );
        operation.insert(
            "x-mcp-original-tool-name".to_string(),
            Value::String(tool.original_name.clone()),
        );
        if let Some(display_name) = tool.display_name.as_ref() {
            operation.insert(
                "x-mcp-display-name".to_string(),
                Value::String(display_name.clone()),
            );
        }

        paths.insert(
            format!("/{}", tool.route_name),
            json!({
                "post": Value::Object(operation)
            }),
        );
    }

    json!({
        "openapi": "3.1.0",
        "info": {
            "title": server_title,
            "version": server_version.unwrap_or("1.0"),
            "description": format!("{server_id} MCP Server")
        },
        "paths": Value::Object(paths)
    })
}

pub fn build_root_openapi(server_ids: &[String]) -> Value {
    let mut paths = Map::new();
    paths.insert(
        "/oauth/status".to_string(),
        json!({
            "get": {
                "operationId": "oauth_status",
                "summary": "OAuth status"
            }
        }),
    );
    paths.insert(
        "/oauth/current".to_string(),
        json!({
            "get": {
                "operationId": "oauth_current",
                "summary": "Current OAuth handshake"
            }
        }),
    );
    paths.insert(
        "/oauth/pending".to_string(),
        json!({
            "get": {
                "operationId": "oauth_pending",
                "summary": "Pending OAuth handshakes"
            }
        }),
    );
    paths.insert(
        "/oauth/callback".to_string(),
        json!({
            "post": {
                "operationId": "oauth_callback",
                "summary": "OAuth callback"
            }
        }),
    );
    paths.insert(
        "/oauth/refresh/{server_name}".to_string(),
        json!({
            "post": {
                "operationId": "oauth_refresh",
                "summary": "Refresh OAuth URL"
            }
        }),
    );
    paths.insert(
        "/servers".to_string(),
        json!({
            "get": {
                "operationId": "servers_list",
                "summary": "List mounted MCP servers"
            }
        }),
    );

    for server_id in server_ids {
        let label = titleize_route(server_id);
        paths.insert(
            format!("/{server_id}/openapi.json"),
            json!({
                "get": {
                    "operationId": format!("{server_id}_openapi"),
                    "summary": format!("{label} OpenAPI")
                }
            }),
        );
        paths.insert(
            format!("/{server_id}/docs"),
            json!({
                "get": {
                    "operationId": format!("{server_id}_docs"),
                    "summary": format!("{label} Docs")
                }
            }),
        );
    }

    let mounted_servers = if server_ids.is_empty() {
        "Mounted servers: none".to_string()
    } else {
        format!(
            "Mounted servers: {}",
            server_ids
                .iter()
                .map(|id| format!("[{id}]"))
                .collect::<String>()
        )
    };

    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "MCP OpenAPI Proxy",
            "version": "1.0.0",
            "description": format!(
                "Root control-plane routes for the MCP OpenAPI Proxy. {mounted_servers}"
            )
        },
        "paths": Value::Object(paths)
    })
}

pub fn swagger_ui_html(server_id: &str) -> String {
    let spec_url = format!("/{server_id}/openapi.json");
    format!(
        r##"<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>{server_id} Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      body {{
        margin: 0;
        background: #faf7f1;
      }}
      .topbar {{
        display: none;
      }}
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({{
        url: "{spec_url}",
        dom_id: "#swagger-ui",
        deepLinking: true
      }});
    </script>
  </body>
</html>"##
    )
}

#[cfg(test)]
mod tests {
    use super::{build_root_openapi, build_server_openapi, swagger_ui_html};
    use crate::app::ToolRoute;
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn builds_server_spec_with_tool_route() {
        let mut tools = BTreeMap::new();
        tools.insert(
            "time_get_current_time".to_string(),
            ToolRoute {
                route_name: "time_get_current_time".to_string(),
                original_name: "get_current_time".to_string(),
                display_name: None,
                title: None,
                description: Some("Get current time".to_string()),
                input_schema: json!({"type":"object","properties":{}}),
                output_schema: Some(json!({"type":"object"})),
            },
        );
        let spec = build_server_openapi("time", "time", Some("1.2.3"), &tools);
        assert_eq!(spec["info"]["version"], "1.2.3");
        assert_eq!(
            spec["paths"]["/time_get_current_time"]["post"]["summary"],
            "Time Get Current Time"
        );
        assert!(spec["paths"]["/time_get_current_time"]["post"].is_object());
    }

    #[test]
    fn builds_root_spec_with_oauth_routes() {
        let spec = build_root_openapi(&["chrome-devtools".to_string()]);
        assert!(spec["paths"]["/oauth/status"]["get"].is_object());
        assert!(spec["paths"]["/oauth/callback"]["post"].is_object());
        assert!(spec["paths"]["/oauth/refresh/{server_name}"]["post"].is_object());
        assert!(spec["paths"]["/servers"]["get"].is_object());
        assert!(spec["paths"]["/chrome-devtools/docs"]["get"].is_object());
        assert!(spec["info"]["description"]
            .as_str()
            .unwrap()
            .contains("[chrome-devtools]"));
    }

    #[test]
    fn prefers_display_name_and_supports_missing_output_schema() {
        let mut tools = BTreeMap::new();
        tools.insert(
            "glean_lookup".to_string(),
            ToolRoute {
                route_name: "glean_lookup".to_string(),
                original_name: "lookup".to_string(),
                display_name: Some("Glean Lookup".to_string()),
                title: Some("Ignored".to_string()),
                description: Some("Finds documents".to_string()),
                input_schema: json!({"type":"object"}),
                output_schema: None,
            },
        );

        let openapi = build_server_openapi("glean", "Glean", None, &tools);
        assert_eq!(openapi["info"]["version"], "1.0");
        assert_eq!(
            openapi["paths"]["/glean_lookup"]["post"]["summary"],
            "Glean Lookup"
        );
        assert_eq!(
            openapi["paths"]["/glean_lookup"]["post"]["responses"]["200"]["content"]
                ["application/json"]["schema"]["oneOf"]
                .as_array()
                .unwrap()
                .len(),
            6
        );
        assert_eq!(
            openapi["paths"]["/glean_lookup"]["post"]["x-mcp-display-name"],
            "Glean Lookup"
        );
    }

    #[test]
    fn prefers_title_before_titleized_route_name() {
        let mut tools = BTreeMap::new();
        tools.insert(
            "__odd__route__name__".to_string(),
            ToolRoute {
                route_name: "__odd__route__name__".to_string(),
                original_name: "odd_route_name".to_string(),
                display_name: None,
                title: Some("Custom Tool Title".to_string()),
                description: None,
                input_schema: json!({"type":"object"}),
                output_schema: Some(json!({"type":"object"})),
            },
        );

        let openapi = build_server_openapi("demo", "Demo", None, &tools);
        assert_eq!(
            openapi["paths"]["/__odd__route__name__"]["post"]["summary"],
            "Custom Tool Title"
        );
    }

    #[test]
    fn builds_swagger_ui_html() {
        let html = swagger_ui_html("time");
        assert!(html.contains("<title>time Docs</title>"));
        assert!(html.contains("url: \"/time/openapi.json\""));
        assert!(html.contains("swagger-ui"));
    }
}
