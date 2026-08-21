use super::*;

use async_trait::async_trait;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, ErrorData, ListToolsResult, PaginatedRequestParams,
    ServerInfo, Tool,
};
use rmcp::service::RequestContext;
use rmcp::service::ServiceExt;
use rmcp::transport::stdio;
use rmcp::{RoleServer, ServerHandler};

#[async_trait]
pub trait ToolDispatcher: Send + Sync {
    async fn call(&self, tool_name: &str, arguments: &Map<String, Value>) -> Result<Option<Value>>;
}

pub struct StaticToolServer<D> {
    server_name: &'static str,
    tools: Vec<Tool>,
    dispatcher: D,
}

impl<D> StaticToolServer<D>
where
    D: ToolDispatcher,
{
    pub fn new(
        server_name: &'static str,
        tool_spec_json: &'static str,
        dispatcher: D,
    ) -> Result<Self> {
        Ok(Self {
            server_name,
            tools: load_tool_specs(tool_spec_json)?,
            dispatcher,
        })
    }

    fn bridge_error(&self, error: impl std::fmt::Display) -> ErrorData {
        ErrorData::internal_error(error.to_string(), None)
    }

    fn info(&self) -> ServerInfo {
        ServerInfo::default()
    }

    fn list_tools_result(&self) -> ListToolsResult {
        ListToolsResult::with_all_items(self.tools.clone())
    }

    async fn call_tool_impl(
        &self,
        request: CallToolRequestParams,
    ) -> Result<CallToolResult, ErrorData> {
        let arguments = request.arguments.clone().unwrap_or_default();
        let raw = self
            .dispatcher
            .call(&request.name, &arguments)
            .await
            .map_err(|error| self.bridge_error(error))?
            .ok_or_else(|| {
                self.bridge_error(format!(
                    "unknown native tool for {}: {}",
                    self.server_name, request.name
                ))
            })?;
        info!("handled {}.{}", self.server_name, request.name);
        serde_json::from_value(raw).map_err(|error| self.bridge_error(error))
    }
}

impl<D> ServerHandler for StaticToolServer<D>
where
    D: ToolDispatcher + 'static,
{
    fn get_info(&self) -> ServerInfo {
        self.info()
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(self.list_tools_result())
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.call_tool_impl(request).await
    }
}

pub async fn serve_stdio_server<D>(
    server_name: &'static str,
    tool_spec_json: &'static str,
    dispatcher: D,
) -> Result<()>
where
    D: ToolDispatcher + 'static,
{
    let service = StaticToolServer::new(server_name, tool_spec_json, dispatcher)?
        .serve(stdio())
        .await
        .context("failed to serve stdio transport")?;
    service
        .waiting()
        .await
        .context("rmcp stdio service join failed")?;
    Ok(())
}

pub fn load_tool_specs(tool_spec_json: &str) -> Result<Vec<Tool>> {
    let value: Value = serde_json::from_str(tool_spec_json).context("invalid tool spec JSON")?;
    serde_json::from_value(value).context("failed to decode tool spec payload")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::RequestId;
    use rmcp::service::{serve_directly, RequestContext};

    struct NoopDispatcher;

    struct ErrorDispatcher;

    struct InvalidDispatcher;

    struct EchoDispatcher;

    #[async_trait]
    impl ToolDispatcher for NoopDispatcher {
        async fn call(
            &self,
            tool_name: &str,
            _arguments: &Map<String, Value>,
        ) -> Result<Option<Value>> {
            if tool_name == "ping" {
                success_text(json!({"ok": true})).map(Some)
            } else {
                Ok(None)
            }
        }
    }

    #[async_trait]
    impl ToolDispatcher for ErrorDispatcher {
        async fn call(
            &self,
            _tool_name: &str,
            _arguments: &Map<String, Value>,
        ) -> Result<Option<Value>> {
            bail!("dispatcher failed")
        }
    }

    #[async_trait]
    impl ToolDispatcher for InvalidDispatcher {
        async fn call(
            &self,
            _tool_name: &str,
            _arguments: &Map<String, Value>,
        ) -> Result<Option<Value>> {
            Ok(Some(json!({"unexpected": true})))
        }
    }

    #[async_trait]
    impl ToolDispatcher for EchoDispatcher {
        async fn call(
            &self,
            _tool_name: &str,
            arguments: &Map<String, Value>,
        ) -> Result<Option<Value>> {
            success_text(json!({ "received": arguments })).map(Some)
        }
    }

    #[test]
    fn load_tool_specs_accepts_valid_specs() {
        let specs = load_tool_specs(
            r#"[{"name":"ping","inputSchema":{"type":"object"},"description":"Ping"}]"#,
        )
        .unwrap();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].name, "ping");
    }

    #[test]
    fn load_tool_specs_rejects_invalid_specs() {
        let error = load_tool_specs(r#"{"not":"a tool list"}"#).unwrap_err();
        assert!(error
            .to_string()
            .contains("failed to decode tool spec payload"));
    }

    #[test]
    fn load_tool_specs_rejects_malformed_json() {
        let error = load_tool_specs("{").unwrap_err();
        assert!(error.to_string().contains("invalid tool spec JSON"));
    }

    #[test]
    fn static_tool_server_initializes() {
        let server = StaticToolServer::new(
            "test-server",
            r#"[{"name":"ping","inputSchema":{"type":"object"},"description":"Ping"}]"#,
            NoopDispatcher,
        )
        .unwrap();
        assert_eq!(server.server_name, "test-server");
        assert_eq!(server.tools.len(), 1);
    }

    #[test]
    fn static_tool_server_exposes_server_info_and_tools() {
        let server = StaticToolServer::new(
            "test-server",
            r#"[{"name":"ping","inputSchema":{"type":"object"},"description":"Ping"}]"#,
            NoopDispatcher,
        )
        .unwrap();
        assert_eq!(server.get_info(), ServerInfo::default());
        assert_eq!(server.list_tools_result().tools.len(), 1);
    }

    #[tokio::test]
    async fn call_tool_impl_returns_structured_result() {
        let server = StaticToolServer::new(
            "test-server",
            r#"[{"name":"ping","inputSchema":{"type":"object"},"description":"Ping"}]"#,
            NoopDispatcher,
        )
        .unwrap();
        let result = server
            .call_tool_impl(CallToolRequestParams::new("ping"))
            .await
            .unwrap();
        assert!(!result.content.is_empty());
    }

    #[tokio::test]
    async fn call_tool_impl_rejects_unknown_tools() {
        let server = StaticToolServer::new(
            "test-server",
            r#"[{"name":"ping","inputSchema":{"type":"object"},"description":"Ping"}]"#,
            NoopDispatcher,
        )
        .unwrap();
        let error = server
            .call_tool_impl(CallToolRequestParams::new("missing"))
            .await
            .unwrap_err();
        assert!(error.message.contains("unknown native tool"));
    }

    #[tokio::test]
    async fn call_tool_impl_bridges_dispatcher_errors() {
        let server = StaticToolServer::new(
            "test-server",
            r#"[{"name":"ping","inputSchema":{"type":"object"},"description":"Ping"}]"#,
            ErrorDispatcher,
        )
        .unwrap();
        let error = server
            .call_tool_impl(CallToolRequestParams::new("ping"))
            .await
            .unwrap_err();
        assert!(error.message.contains("dispatcher failed"));
    }

    #[tokio::test]
    async fn call_tool_impl_rejects_invalid_payloads() {
        let server = StaticToolServer::new(
            "test-server",
            r#"[{"name":"ping","inputSchema":{"type":"object"},"description":"Ping"}]"#,
            InvalidDispatcher,
        )
        .unwrap();
        let error = server
            .call_tool_impl(CallToolRequestParams::new("ping"))
            .await
            .unwrap_err();
        assert!(error.message.contains("missing field"));
    }

    #[tokio::test]
    async fn call_tool_impl_passes_arguments_through_to_dispatcher() {
        let server = StaticToolServer::new(
            "test-server",
            r#"[{"name":"ping","inputSchema":{"type":"object"},"description":"Ping"}]"#,
            EchoDispatcher,
        )
        .unwrap();
        let result = server
            .call_tool_impl(
                CallToolRequestParams::new("ping")
                    .with_arguments(Map::from_iter([("value".to_string(), json!(42))])),
            )
            .await
            .unwrap();
        let payload: Value = serde_json::from_str(
            result.content[0]
                .raw
                .as_text()
                .expect("text content")
                .text
                .as_ref(),
        )
        .expect("JSON tool result");
        assert_eq!(payload["received"]["value"], json!(42));
    }

    #[tokio::test]
    async fn serve_stdio_server_rejects_invalid_specs_before_starting_transport() {
        let error = serve_stdio_server("bad-server", "{", NoopDispatcher)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("invalid tool spec JSON"));
    }

    #[tokio::test]
    async fn server_handler_methods_forward_to_internal_helpers() {
        let (server_transport, client_transport) = tokio::io::duplex(4096);
        let mut running = serve_directly(
            StaticToolServer::new(
                "test-server",
                r#"[{"name":"ping","inputSchema":{"type":"object"},"description":"Ping"}]"#,
                NoopDispatcher,
            )
            .unwrap(),
            server_transport,
            None,
        );
        let peer = running.peer().clone();

        let listed = ServerHandler::list_tools(
            running.service(),
            None,
            RequestContext::new(RequestId::Number(1), peer.clone()),
        )
        .await
        .unwrap();
        assert_eq!(listed.tools.len(), 1);

        let called = ServerHandler::call_tool(
            running.service(),
            CallToolRequestParams::new("ping"),
            RequestContext::new(RequestId::Number(2), peer),
        )
        .await
        .unwrap();
        assert!(!called.content.is_empty());

        drop(client_transport);
        running.close().await.expect("close running service");
    }
}
