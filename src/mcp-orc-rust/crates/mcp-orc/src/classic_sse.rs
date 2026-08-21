use std::collections::HashMap;
use std::sync::Arc;

use futures::{stream::BoxStream, StreamExt};
use http::{HeaderName, HeaderValue};
use log::{debug, info, warn};
use reqwest::header::{ACCEPT, WWW_AUTHENTICATE};
use reqwest::{StatusCode, Url};
use rmcp::model::{ClientJsonRpcMessage, ServerJsonRpcMessage};
use rmcp::transport::worker::{
    Worker, WorkerConfig, WorkerContext, WorkerQuitReason, WorkerSendRequest, WorkerTransport,
};
use rmcp::RoleClient;
use sse_stream::{Error as SseError, Sse, SseStream};
use tokio::task::JoinSet;

const EVENT_STREAM_MIME_TYPE: &str = "text/event-stream";
const JSON_MIME_TYPE: &str = "application/json";

type BoxedSseStream = BoxStream<'static, Result<Sse, SseError>>;

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum ClassicSseTransportError {
    #[error("SSE error: {0}")]
    Sse(#[from] SseError),
    #[error("client error: {0}")]
    Client(#[from] reqwest::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("transport channel closed")]
    TransportChannelClosed,
    #[error("tokio join error: {0}")]
    TokioJoinError(#[from] tokio::task::JoinError),
    #[error("missing endpoint event from SSE server")]
    MissingEndpointEvent,
    #[error("endpoint origin does not match connection origin: {0}")]
    EndpointOriginMismatch(String),
    #[error("unexpected server response: {0}")]
    UnexpectedServerResponse(String),
    #[error("unexpected content type: {0:?}")]
    UnexpectedContentType(Option<String>),
    #[error("unauthorized")]
    Unauthorized {
        www_authenticate_header: Option<String>,
    },
    #[error("insufficient scope")]
    InsufficientScope {
        www_authenticate_header: Option<String>,
    },
    #[error("reserved header conflict: {0}")]
    ReservedHeaderConflict(String),
}

impl ClassicSseTransportError {
    pub fn www_authenticate_header(&self) -> Option<&str> {
        match self {
            Self::Unauthorized {
                www_authenticate_header,
            }
            | Self::InsufficientScope {
                www_authenticate_header,
            } => www_authenticate_header.as_deref(),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClassicSseClientConfig {
    pub uri: Arc<str>,
    pub auth_header: Option<String>,
    pub custom_headers: HashMap<HeaderName, HeaderValue>,
    pub channel_buffer_capacity: usize,
}

impl ClassicSseClientConfig {
    pub fn with_uri(uri: impl Into<Arc<str>>) -> Self {
        Self {
            uri: uri.into(),
            auth_header: None,
            custom_headers: HashMap::new(),
            channel_buffer_capacity: 16,
        }
    }

    pub fn auth_header<T: Into<String>>(mut self, value: T) -> Self {
        self.auth_header = Some(value.into());
        self
    }

    pub fn custom_headers(mut self, headers: HashMap<HeaderName, HeaderValue>) -> Self {
        self.custom_headers = headers;
        self
    }
}

#[derive(Debug, Clone)]
pub struct ClassicSseClientWorker {
    client: reqwest::Client,
    config: ClassicSseClientConfig,
}

impl ClassicSseClientWorker {
    pub fn new(client: reqwest::Client, config: ClassicSseClientConfig) -> Self {
        Self { client, config }
    }

    async fn connect_stream(&self) -> Result<(Arc<str>, BoxedSseStream), ClassicSseTransportError> {
        debug!(
            "connecting native classic SSE transport to {}",
            self.config.uri
        );
        let mut request = self
            .client
            .get(self.config.uri.as_ref())
            .header(ACCEPT, EVENT_STREAM_MIME_TYPE);
        if let Some(auth_header) = self.config.auth_header.as_ref() {
            request = request.bearer_auth(auth_header);
        }
        request = apply_custom_headers(request, self.config.custom_headers.clone())?;

        let response = request.send().await?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED {
            return Err(ClassicSseTransportError::Unauthorized {
                www_authenticate_header: header_to_string(response.headers().get(WWW_AUTHENTICATE)),
            });
        }
        if status == StatusCode::FORBIDDEN {
            return Err(ClassicSseTransportError::InsufficientScope {
                www_authenticate_header: header_to_string(response.headers().get(WWW_AUTHENTICATE)),
            });
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(ClassicSseTransportError::UnexpectedServerResponse(format!(
                "HTTP {status}: {body}"
            )));
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if !content_type
            .as_deref()
            .map(|value| value.starts_with(EVENT_STREAM_MIME_TYPE))
            .unwrap_or(false)
        {
            return Err(ClassicSseTransportError::UnexpectedContentType(
                content_type,
            ));
        }

        let mut stream = SseStream::from_byte_stream(response.bytes_stream()).boxed();
        while let Some(event) = stream.next().await {
            let event = event?;
            match event.event.as_deref() {
                Some("endpoint") => {
                    let endpoint = event.data.unwrap_or_default();
                    let joined = join_endpoint_url(self.config.uri.as_ref(), &endpoint)?;
                    info!(
                        "native classic SSE transport received endpoint '{}'",
                        joined
                    );
                    return Ok((Arc::<str>::from(joined), stream));
                }
                Some("message") | Some("") | None => {
                    if event.data.as_deref().unwrap_or_default().trim().is_empty() {
                        continue;
                    }
                    warn!(
                        "classic SSE server '{}' emitted message before endpoint event; ignoring until endpoint is announced",
                        self.config.uri
                    );
                }
                Some(other) => {
                    debug!(
                        "classic SSE server '{}' emitted control event '{}' before endpoint",
                        self.config.uri, other
                    );
                }
            }
        }

        Err(ClassicSseTransportError::MissingEndpointEvent)
    }

    async fn execute_sse_stream(
        stream: BoxedSseStream,
        sse_worker_tx: tokio::sync::mpsc::Sender<ServerJsonRpcMessage>,
        ct: tokio_util::sync::CancellationToken,
    ) -> Result<(), ClassicSseTransportError> {
        let mut stream = std::pin::pin!(stream);
        loop {
            let event = tokio::select! {
                item = stream.next() => item,
                _ = ct.cancelled() => break,
            };
            let Some(event) = event else {
                return Err(ClassicSseTransportError::TransportChannelClosed);
            };
            let event = event?;
            match event.event.as_deref() {
                Some("message") | Some("") | None => {
                    let payload = event.data.unwrap_or_default();
                    if payload.trim().is_empty() {
                        continue;
                    }
                    let message = serde_json::from_str::<ServerJsonRpcMessage>(&payload)?;
                    log_server_message(&message);
                    if sse_worker_tx.send(message).await.is_err() {
                        return Err(ClassicSseTransportError::TransportChannelClosed);
                    }
                }
                Some("endpoint") => {
                    debug!("ignoring duplicate classic SSE endpoint control event");
                }
                Some(other) => {
                    debug!("ignoring classic SSE control event '{}'", other);
                }
            }
        }
        Ok(())
    }

    async fn post_message(
        &self,
        endpoint_url: &str,
        message: ClientJsonRpcMessage,
    ) -> Result<(), ClassicSseTransportError> {
        log_client_message(endpoint_url, &message);
        let mut request = self
            .client
            .post(endpoint_url)
            .header(ACCEPT, JSON_MIME_TYPE);
        if let Some(auth_header) = self.config.auth_header.as_ref() {
            request = request.bearer_auth(auth_header);
        }
        request = apply_custom_headers(request, self.config.custom_headers.clone())?;

        let response = request.json(&message).send().await?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED {
            return Err(ClassicSseTransportError::Unauthorized {
                www_authenticate_header: header_to_string(response.headers().get(WWW_AUTHENTICATE)),
            });
        }
        if status == StatusCode::FORBIDDEN {
            return Err(ClassicSseTransportError::InsufficientScope {
                www_authenticate_header: header_to_string(response.headers().get(WWW_AUTHENTICATE)),
            });
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(ClassicSseTransportError::UnexpectedServerResponse(format!(
                "HTTP {status}: {body}"
            )));
        }

        log_client_post_accepted(endpoint_url, &message, status);

        Ok(())
    }
}

impl Worker for ClassicSseClientWorker {
    type Role = RoleClient;
    type Error = ClassicSseTransportError;

    fn err_closed() -> Self::Error {
        ClassicSseTransportError::TransportChannelClosed
    }

    fn err_join(error: tokio::task::JoinError) -> Self::Error {
        ClassicSseTransportError::TokioJoinError(error)
    }

    fn config(&self) -> WorkerConfig {
        WorkerConfig {
            name: Some("ClassicSseClientWorker".to_string()),
            channel_buffer_capacity: self.config.channel_buffer_capacity,
        }
    }

    async fn run(
        self,
        mut context: WorkerContext<Self>,
    ) -> Result<(), WorkerQuitReason<Self::Error>> {
        let (endpoint_url, stream) =
            self.connect_stream()
                .await
                .map_err(WorkerQuitReason::fatal_context(
                    "connect classic SSE stream",
                ))?;

        let (sse_worker_tx, mut sse_worker_rx) =
            tokio::sync::mpsc::channel::<ServerJsonRpcMessage>(self.config.channel_buffer_capacity);
        let transport_task_ct = context.cancellation_token.clone();
        let mut tasks = JoinSet::new();
        tasks.spawn(Self::execute_sse_stream(
            stream,
            sse_worker_tx,
            transport_task_ct.child_token(),
        ));

        loop {
            enum Event {
                ClientMessage(WorkerSendRequest<ClassicSseClientWorker>),
                ServerMessage(ServerJsonRpcMessage),
                StreamResult(Result<(), ClassicSseTransportError>),
            }

            let event = tokio::select! {
                _ = transport_task_ct.cancelled() => return Err(WorkerQuitReason::Cancelled),
                message = context.recv_from_handler() => match message {
                    Ok(message) => Event::ClientMessage(message),
                    Err(error) => return Err(error),
                },
                message = sse_worker_rx.recv() => match message {
                    Some(message) => Event::ServerMessage(message),
                    None => return Err(WorkerQuitReason::TransportClosed),
                },
                task = tasks.join_next(), if !tasks.is_empty() => match task {
                    Some(result) => Event::StreamResult(
                        result
                            .map_err(ClassicSseTransportError::TokioJoinError)
                            .and_then(std::convert::identity)
                    ),
                    None => continue,
                }
            };

            match event {
                Event::ClientMessage(WorkerSendRequest {
                    message, responder, ..
                }) => {
                    let result = self.post_message(&endpoint_url, message).await;
                    let transport_failed = result.is_err();
                    let _ = responder.send(result);
                    if transport_failed {
                        return Err(WorkerQuitReason::fatal(
                            ClassicSseTransportError::TransportChannelClosed,
                            "classic SSE POST failed",
                        ));
                    }
                }
                Event::ServerMessage(message) => {
                    context.send_to_handler(message).await?;
                }
                Event::StreamResult(Ok(())) => {
                    return Err(WorkerQuitReason::TransportClosed);
                }
                Event::StreamResult(Err(error)) => {
                    return Err(WorkerQuitReason::fatal(
                        error,
                        "classic SSE reader terminated",
                    ));
                }
            }
        }
    }
}

pub type ClassicSseClientTransport = WorkerTransport<ClassicSseClientWorker>;

pub fn classic_sse_transport_with_client(
    client: reqwest::Client,
    config: ClassicSseClientConfig,
) -> ClassicSseClientTransport {
    WorkerTransport::spawn(ClassicSseClientWorker::new(client, config))
}

fn apply_custom_headers(
    mut builder: reqwest::RequestBuilder,
    custom_headers: HashMap<HeaderName, HeaderValue>,
) -> Result<reqwest::RequestBuilder, ClassicSseTransportError> {
    const RESERVED: &[&str] = &["accept", "authorization", "content-type"];

    for (name, value) in custom_headers {
        if RESERVED
            .iter()
            .any(|reserved| name.as_str().eq_ignore_ascii_case(reserved))
        {
            return Err(ClassicSseTransportError::ReservedHeaderConflict(
                name.to_string(),
            ));
        }
        builder = builder.header(name, value);
    }

    Ok(builder)
}

fn header_to_string(value: Option<&HeaderValue>) -> Option<String> {
    value
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

fn client_message_log_fields(message: &ClientJsonRpcMessage) -> (Option<String>, Option<String>) {
    let value = serde_json::to_value(message).unwrap_or(serde_json::Value::Null);
    let message_id = value.get("id").map(|item| item.to_string());
    let method = value
        .get("method")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    (message_id, method)
}

fn server_message_log_fields(
    message: &ServerJsonRpcMessage,
) -> (Option<String>, Option<String>, &'static str) {
    let value = serde_json::to_value(message).unwrap_or(serde_json::Value::Null);
    let message_id = value.get("id").map(|item| item.to_string());
    let method = value
        .get("method")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let kind = if value.get("result").is_some() {
        "response"
    } else if value.get("error").is_some() {
        "error"
    } else {
        "notification"
    };
    (message_id, method, kind)
}

fn log_client_message(endpoint_url: &str, message: &ClientJsonRpcMessage) {
    let (message_id, method) = client_message_log_fields(message);
    let log_line = format!(
        "classic SSE POST dispatch endpoint={} method={:?} request_id={:?}",
        endpoint_url, method, message_id
    );
    if method.as_deref() == Some("tools/call") {
        info!("{log_line}");
    } else {
        debug!("{log_line}");
    }
}

fn log_client_post_accepted(
    endpoint_url: &str,
    message: &ClientJsonRpcMessage,
    status: StatusCode,
) {
    let (message_id, method) = client_message_log_fields(message);
    let log_line = format!(
        "classic SSE POST accepted endpoint={} status={} method={:?} request_id={:?}",
        endpoint_url, status, method, message_id
    );
    if method.as_deref() == Some("tools/call") {
        info!("{log_line}");
    } else {
        debug!("{log_line}");
    }
}

fn log_server_message(message: &ServerJsonRpcMessage) {
    let (message_id, method, kind) = server_message_log_fields(message);
    let log_line = format!(
        "classic SSE received {} method={:?} request_id={:?}",
        kind, method, message_id
    );
    if kind == "response" || kind == "error" {
        info!("{log_line}");
    } else {
        debug!("{log_line}");
    }
}

fn join_endpoint_url(base_url: &str, endpoint: &str) -> Result<String, ClassicSseTransportError> {
    let base = Url::parse(base_url).map_err(|error| {
        ClassicSseTransportError::UnexpectedServerResponse(format!(
            "invalid SSE url '{base_url}': {error}"
        ))
    })?;
    let joined = base.join(endpoint).map_err(|error| {
        ClassicSseTransportError::UnexpectedServerResponse(format!(
            "invalid endpoint event '{endpoint}': {error}"
        ))
    })?;
    if base.scheme() != joined.scheme()
        || base.host_str() != joined.host_str()
        || base.port_or_known_default() != joined.port_or_known_default()
    {
        return Err(ClassicSseTransportError::EndpointOriginMismatch(
            joined.to_string(),
        ));
    }
    Ok(joined.to_string())
}

#[cfg(test)]
#[path = "classic_sse_tests.rs"]
mod tests;
