use std::{borrow::Cow, collections::HashMap, sync::Arc, time::Instant};

use futures::{stream::BoxStream, StreamExt};
use http::{header::WWW_AUTHENTICATE, HeaderName, HeaderValue};
use log::{error, warn};
use reqwest::header::ACCEPT;
use rmcp::{
    model::{ClientJsonRpcMessage, ServerJsonRpcMessage},
    transport::{
        common::http_header::{
            EVENT_STREAM_MIME_TYPE, HEADER_LAST_EVENT_ID, HEADER_MCP_PROTOCOL_VERSION,
            HEADER_SESSION_ID, JSON_MIME_TYPE,
        },
        streamable_http_client::{
            AuthRequiredError, InsufficientScopeError, StreamableHttpClient, StreamableHttpError,
            StreamableHttpPostResponse,
        },
    },
};
use sse_stream::{Error as SseError, Sse, SseStream};

#[derive(Clone, Default)]
pub struct CompatibleReqwestStreamableHttpClient {
    inner: reqwest::Client,
}

impl CompatibleReqwestStreamableHttpClient {
    pub fn new(inner: reqwest::Client) -> Self {
        Self { inner }
    }
}

/// Reserved headers that must not be overridden by user-supplied custom headers.
/// `MCP-Protocol-Version` is in this list but is allowed through because the worker
/// injects it after initialization.
const RESERVED_HEADERS: &[&str] = &[
    "accept",
    HEADER_SESSION_ID,
    HEADER_MCP_PROTOCOL_VERSION,
    HEADER_LAST_EVENT_ID,
];
const SAFE_RESPONSE_HEADERS: &[&str] = &[
    "server",
    "via",
    "content-type",
    "content-length",
    "location",
    "www-authenticate",
    "portico-request-id",
    "portico-tracking-key",
    "x-request-id",
    "x-correlation-id",
    "traceparent",
];
const RESPONSE_BODY_SNIPPET_MAX_BYTES: usize = 512;

fn apply_custom_headers(
    mut builder: reqwest::RequestBuilder,
    custom_headers: HashMap<HeaderName, HeaderValue>,
) -> Result<reqwest::RequestBuilder, StreamableHttpError<reqwest::Error>> {
    for (name, value) in custom_headers {
        if RESERVED_HEADERS
            .iter()
            .any(|&reserved| name.as_str().eq_ignore_ascii_case(reserved))
        {
            if name
                .as_str()
                .eq_ignore_ascii_case(HEADER_MCP_PROTOCOL_VERSION)
            {
                builder = builder.header(name, value);
                continue;
            }
            return Err(StreamableHttpError::ReservedHeaderConflict(
                name.to_string(),
            ));
        }
        builder = builder.header(name, value);
    }
    Ok(builder)
}

fn extract_scope_from_header(header: &str) -> Option<String> {
    let header_lowercase = header.to_ascii_lowercase();
    let scope_key = "scope=";

    if let Some(pos) = header_lowercase.find(scope_key) {
        let start = pos + scope_key.len();
        let value_slice = &header[start..];

        if let Some(stripped) = value_slice.strip_prefix('"') {
            if let Some(end_quote) = stripped.find('"') {
                return Some(stripped[..end_quote].to_string());
            }
        } else {
            let end = value_slice
                .find(|c: char| c == ',' || c == ';' || c.is_whitespace())
                .unwrap_or(value_slice.len());
            if end > 0 {
                return Some(value_slice[..end].to_string());
            }
        }
    }

    None
}

fn is_notification_message(message: &ClientJsonRpcMessage) -> bool {
    matches!(message, ClientJsonRpcMessage::Notification(_))
}

fn downstream_target_label(uri: &str) -> String {
    reqwest::Url::parse(uri)
        .ok()
        .map(|parsed| {
            let host = parsed.host_str().unwrap_or("<unknown>");
            format!("{}://{}{}", parsed.scheme(), host, parsed.path())
        })
        .unwrap_or_else(|| uri.to_string())
}

fn summarize_safe_response_headers(headers: &reqwest::header::HeaderMap) -> String {
    let mut parts = Vec::new();
    for header_name in SAFE_RESPONSE_HEADERS {
        if let Some(value) = headers.get(*header_name) {
            let rendered = value.to_str().unwrap_or("<non-utf8>");
            parts.push(format!("{header_name}={rendered}"));
        }
    }
    if parts.is_empty() {
        "<none>".to_string()
    } else {
        parts.join(", ")
    }
}

fn escape_log_value(raw: &str) -> String {
    raw.chars().flat_map(|ch| ch.escape_default()).collect()
}

fn summarize_response_body_snippet(body: &[u8]) -> String {
    let truncated = body.len() > RESPONSE_BODY_SNIPPET_MAX_BYTES;
    let snippet = String::from_utf8_lossy(&body[..body.len().min(RESPONSE_BODY_SNIPPET_MAX_BYTES)])
        .into_owned();
    let snippet = escape_log_value(&snippet);
    if truncated {
        format!("{snippet}...[truncated]")
    } else {
        snippet
    }
}

fn response_content_type(headers: &reqwest::header::HeaderMap) -> String {
    headers
        .get(reqwest::header::CONTENT_TYPE)
        .map(|value| String::from_utf8_lossy(value.as_bytes()).to_string())
        .unwrap_or_else(|| "<missing>".to_string())
}

fn log_downstream_http_failure(
    method: &str,
    uri: &str,
    started_at: Instant,
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    body_snippet: Option<&str>,
    has_session_id: bool,
    has_auth: bool,
) {
    warn!(
        "downstream streamable-http {} failure target={} status={} elapsed_ms={} has_session_id={} has_auth={} content_type={} response_headers={} body_snippet={}",
        method,
        downstream_target_label(uri),
        status,
        started_at.elapsed().as_millis(),
        has_session_id,
        has_auth,
        response_content_type(headers),
        summarize_safe_response_headers(headers),
        body_snippet.unwrap_or("<omitted>"),
    );
}

impl StreamableHttpClient for CompatibleReqwestStreamableHttpClient {
    type Error = reqwest::Error;

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        last_event_id: Option<String>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<BoxStream<'static, Result<Sse, SseError>>, StreamableHttpError<Self::Error>> {
        let started_at = Instant::now();
        let has_auth = auth_token.is_some();
        let mut request_builder = self
            .inner
            .get(uri.as_ref())
            .header(ACCEPT, [EVENT_STREAM_MIME_TYPE, JSON_MIME_TYPE].join(", "))
            .header(HEADER_SESSION_ID, session_id.as_ref());
        if let Some(last_event_id) = last_event_id {
            request_builder = request_builder.header(HEADER_LAST_EVENT_ID, last_event_id);
        }
        if let Some(auth_header) = auth_token {
            request_builder = request_builder.bearer_auth(auth_header);
        }
        request_builder = apply_custom_headers(request_builder, custom_headers)?;
        let response = request_builder
            .send()
            .await
            .map_err(StreamableHttpError::Client)?;
        if response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            return Err(StreamableHttpError::ServerDoesNotSupportSse);
        }
        if let Err(error) = response.error_for_status_ref() {
            let status = response.status();
            let headers = response.headers().clone();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "<failed to read response body>".to_owned());
            let body_snippet = summarize_response_body_snippet(body.as_bytes());
            log_downstream_http_failure(
                "GET",
                uri.as_ref(),
                started_at,
                status,
                &headers,
                Some(&body_snippet),
                true,
                has_auth,
            );
            return Err(StreamableHttpError::Client(error));
        }
        match response.headers().get(reqwest::header::CONTENT_TYPE) {
            Some(ct) => {
                if !ct.as_bytes().starts_with(EVENT_STREAM_MIME_TYPE.as_bytes())
                    && !ct.as_bytes().starts_with(JSON_MIME_TYPE.as_bytes())
                {
                    return Err(StreamableHttpError::UnexpectedContentType(Some(
                        String::from_utf8_lossy(ct.as_bytes()).to_string(),
                    )));
                }
            }
            None => return Err(StreamableHttpError::UnexpectedContentType(None)),
        }
        Ok(SseStream::from_byte_stream(response.bytes_stream()).boxed())
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session: Arc<str>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), StreamableHttpError<Self::Error>> {
        let started_at = Instant::now();
        let has_auth = auth_token.is_some();
        let mut request_builder = self.inner.delete(uri.as_ref());
        if let Some(auth_header) = auth_token {
            request_builder = request_builder.bearer_auth(auth_header);
        }
        request_builder = request_builder.header(HEADER_SESSION_ID, session.as_ref());
        request_builder = apply_custom_headers(request_builder, custom_headers)?;
        let response = request_builder
            .send()
            .await
            .map_err(StreamableHttpError::Client)?;
        if response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            return Ok(());
        }
        if let Err(error) = response.error_for_status_ref() {
            let status = response.status();
            let headers = response.headers().clone();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "<failed to read response body>".to_owned());
            let body_snippet = summarize_response_body_snippet(body.as_bytes());
            log_downstream_http_failure(
                "DELETE",
                uri.as_ref(),
                started_at,
                status,
                &headers,
                Some(&body_snippet),
                true,
                has_auth,
            );
            return Err(StreamableHttpError::Client(error));
        }
        Ok(())
    }

    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        let is_notification = is_notification_message(&message);
        let started_at = Instant::now();
        let has_auth = auth_token.is_some();
        let has_session_id = session_id.is_some();
        let mut request = self
            .inner
            .post(uri.as_ref())
            .header(ACCEPT, [EVENT_STREAM_MIME_TYPE, JSON_MIME_TYPE].join(", "));
        if let Some(auth_header) = auth_token {
            request = request.bearer_auth(auth_header);
        }

        request = apply_custom_headers(request, custom_headers)?;
        if let Some(session_id) = session_id {
            request = request.header(HEADER_SESSION_ID, session_id.as_ref());
        }
        let response = request
            .json(&message)
            .send()
            .await
            .map_err(StreamableHttpError::Client)?;
        let status = response.status();
        let response_headers = response.headers().clone();
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            log_downstream_http_failure(
                "POST",
                uri.as_ref(),
                started_at,
                status,
                &response_headers,
                None,
                has_session_id,
                has_auth,
            );
            if let Some(header) = response_headers.get(WWW_AUTHENTICATE) {
                let header = header
                    .to_str()
                    .map_err(|_| {
                        StreamableHttpError::UnexpectedServerResponse(Cow::from(
                            "invalid www-authenticate header value",
                        ))
                    })?
                    .to_string();
                return Err(StreamableHttpError::AuthRequired(AuthRequiredError {
                    www_authenticate_header: header,
                }));
            }
        }
        if response.status() == reqwest::StatusCode::FORBIDDEN {
            log_downstream_http_failure(
                "POST",
                uri.as_ref(),
                started_at,
                status,
                &response_headers,
                None,
                has_session_id,
                has_auth,
            );
            if let Some(header) = response_headers.get(WWW_AUTHENTICATE) {
                let header_str = header.to_str().map_err(|_| {
                    StreamableHttpError::UnexpectedServerResponse(Cow::from(
                        "invalid www-authenticate header value",
                    ))
                })?;
                return Err(StreamableHttpError::InsufficientScope(
                    InsufficientScopeError {
                        www_authenticate_header: header_str.to_string(),
                        required_scope: extract_scope_from_header(header_str),
                    },
                ));
            }
        }

        if matches!(
            status,
            reqwest::StatusCode::ACCEPTED | reqwest::StatusCode::NO_CONTENT
        ) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "<failed to read response body>".to_owned());
            let body_snippet = summarize_response_body_snippet(body.as_bytes());
            log_downstream_http_failure(
                "POST",
                uri.as_ref(),
                started_at,
                status,
                &response_headers,
                Some(&body_snippet),
                has_session_id,
                has_auth,
            );
            return Err(StreamableHttpError::UnexpectedServerResponse(Cow::Owned(
                format!("HTTP {status}: {body}"),
            )));
        }

        let content_type = response_headers
            .get(reqwest::header::CONTENT_TYPE)
            .map(|value| String::from_utf8_lossy(value.as_bytes()).to_string());
        let session_id = response
            .headers()
            .get(HEADER_SESSION_ID)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_string());

        match content_type.as_deref() {
            Some(content_type) if content_type.starts_with(EVENT_STREAM_MIME_TYPE) => {
                let event_stream = SseStream::from_byte_stream(response.bytes_stream()).boxed();
                Ok(StreamableHttpPostResponse::Sse(event_stream, session_id))
            }
            Some(content_type) if content_type.starts_with(JSON_MIME_TYPE) => {
                match response.json::<ServerJsonRpcMessage>().await {
                    Ok(message) => Ok(StreamableHttpPostResponse::Json(message, session_id)),
                    Err(error) => {
                        warn!(
                            "could not parse JSON response as ServerJsonRpcMessage, treating as accepted: {error}"
                        );
                        Ok(StreamableHttpPostResponse::Accepted)
                    }
                }
            }
            _ => {
                let body = response
                    .bytes()
                    .await
                    .map_err(StreamableHttpError::Client)?;
                if is_notification && body.is_empty() {
                    warn!(
                        "treating successful empty-body notification response as accepted despite unexpected content type: {:?}",
                        content_type
                    );
                    return Ok(StreamableHttpPostResponse::Accepted);
                }
                error!("unexpected content type: {:?}", content_type);
                Err(StreamableHttpError::UnexpectedContentType(content_type))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        downstream_target_label, extract_scope_from_header, summarize_response_body_snippet,
        summarize_safe_response_headers,
    };
    use http::header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE, SERVER};
    use rmcp::transport::streamable_http_client::InsufficientScopeError;

    #[test]
    fn extract_scope_quoted() {
        let header = r#"Bearer error="insufficient_scope", scope="files:read files:write""#;
        assert_eq!(
            extract_scope_from_header(header),
            Some("files:read files:write".to_string())
        );
    }

    #[test]
    fn extract_scope_unquoted() {
        let header = r#"Bearer scope=read:data, error="insufficient_scope""#;
        assert_eq!(
            extract_scope_from_header(header),
            Some("read:data".to_string())
        );
    }

    #[test]
    fn extract_scope_missing() {
        let header = r#"Bearer error="invalid_token""#;
        assert_eq!(extract_scope_from_header(header), None);
    }

    #[test]
    fn extract_scope_empty_header() {
        assert_eq!(extract_scope_from_header("Bearer"), None);
    }

    #[test]
    fn insufficient_scope_error_can_upgrade() {
        let with_scope = InsufficientScopeError {
            www_authenticate_header: "Bearer scope=\"admin\"".to_string(),
            required_scope: Some("admin".to_string()),
        };
        assert!(with_scope.can_upgrade());
        assert_eq!(with_scope.get_required_scope(), Some("admin"));

        let without_scope = InsufficientScopeError {
            www_authenticate_header: "Bearer error=\"insufficient_scope\"".to_string(),
            required_scope: None,
        };
        assert!(!without_scope.can_upgrade());
        assert_eq!(without_scope.get_required_scope(), None);
    }

    #[test]
    fn summarize_safe_response_headers_filters_and_formats_allowed_headers() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(SERVER, HeaderValue::from_static("nginx"));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/html"));
        headers.insert("x-request-id", HeaderValue::from_static("req-123"));
        headers.insert(AUTHORIZATION, HeaderValue::from_static("secret"));

        let summary = summarize_safe_response_headers(&headers);

        assert!(summary.contains("server=nginx"));
        assert!(summary.contains("content-type=text/html"));
        assert!(summary.contains("x-request-id=req-123"));
        assert!(!summary.contains("authorization"));
        assert!(!summary.contains("secret"));
    }

    #[test]
    fn summarize_response_body_snippet_truncates_and_escapes() {
        let body = vec![b'a'; 600];
        let mut body_with_newline = b"gateway timeout\n".to_vec();
        body_with_newline.extend(body);

        let summary = summarize_response_body_snippet(&body_with_newline);

        assert!(summary.contains("gateway timeout\\n"));
        assert!(summary.ends_with("...[truncated]"));
    }

    #[test]
    fn downstream_target_label_drops_query_string() {
        assert_eq!(
            downstream_target_label("https://example.test/mcp?token=secret"),
            "https://example.test/mcp"
        );
    }
}
