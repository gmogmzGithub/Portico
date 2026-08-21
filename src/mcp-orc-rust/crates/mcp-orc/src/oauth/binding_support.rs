use rmcp::transport::streamable_http_client::StreamableHttpError;

use super::binding::OAuthTransportError;
use super::config::{LoadedCredentials, OAuthConfig};
use super::storage::CompatClientInfo;

pub(super) fn map_streamable_error<E>(
    error: StreamableHttpError<E>,
) -> StreamableHttpError<OAuthTransportError<E>>
where
    E: std::error::Error + Send + Sync + 'static,
{
    match error {
        StreamableHttpError::Sse(value) => StreamableHttpError::Sse(value),
        StreamableHttpError::Io(value) => StreamableHttpError::Io(value),
        StreamableHttpError::Client(value) => {
            StreamableHttpError::Client(OAuthTransportError::Client(value))
        }
        StreamableHttpError::UnexpectedEndOfStream => StreamableHttpError::UnexpectedEndOfStream,
        StreamableHttpError::UnexpectedServerResponse(value) => {
            StreamableHttpError::UnexpectedServerResponse(value)
        }
        StreamableHttpError::UnexpectedContentType(value) => {
            StreamableHttpError::UnexpectedContentType(value)
        }
        StreamableHttpError::ServerDoesNotSupportSse => {
            StreamableHttpError::ServerDoesNotSupportSse
        }
        StreamableHttpError::ServerDoesNotSupportDeleteSession => {
            StreamableHttpError::ServerDoesNotSupportDeleteSession
        }
        StreamableHttpError::TokioJoinError(value) => StreamableHttpError::TokioJoinError(value),
        StreamableHttpError::Deserialize(value) => StreamableHttpError::Deserialize(value),
        StreamableHttpError::TransportChannelClosed => StreamableHttpError::TransportChannelClosed,
        StreamableHttpError::MissingSessionIdInResponse => {
            StreamableHttpError::MissingSessionIdInResponse
        }
        StreamableHttpError::Auth(value) => StreamableHttpError::Auth(value),
        StreamableHttpError::AuthRequired(value) => StreamableHttpError::AuthRequired(value),
        StreamableHttpError::InsufficientScope(value) => {
            StreamableHttpError::InsufficientScope(value)
        }
        StreamableHttpError::ReservedHeaderConflict(value) => {
            StreamableHttpError::ReservedHeaderConflict(value)
        }
        _ => StreamableHttpError::UnexpectedServerResponse(
            "unsupported streamable-http transport error".into(),
        ),
    }
}

pub(super) fn build_client_info_from_credentials(
    oauth_config: &OAuthConfig,
    credentials: LoadedCredentials,
) -> CompatClientInfo {
    let scopes = if credentials.scopes.is_empty() {
        oauth_config.configured_scopes()
    } else {
        credentials.scopes
    };
    CompatClientInfo {
        redirect_uris: oauth_config.redirect_uris(),
        token_endpoint_auth_method: if credentials.client_secret.is_some() {
            Some("client_secret_post".to_string())
        } else {
            Some("none".to_string())
        },
        grant_types: oauth_config.grant_types(),
        response_types: oauth_config.response_types(),
        scope: joined_scope(scopes),
        client_name: Some(oauth_config.client_name()),
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        ..Default::default()
    }
}

pub(super) fn resolve_redirect_uri(
    oauth_config: &OAuthConfig,
    client_info: &CompatClientInfo,
) -> String {
    let active = oauth_config.active_redirect_uri();
    if client_info.redirect_uris.contains(&active) {
        return active;
    }
    if client_info
        .redirect_uris
        .contains(&"http://localhost:3834/callback".to_string())
    {
        return "http://localhost:3834/callback".to_string();
    }
    client_info.redirect_uris.first().cloned().unwrap_or(active)
}

pub(super) fn joined_scope(scopes: Vec<String>) -> Option<String> {
    if scopes.is_empty() {
        None
    } else {
        Some(scopes.join(" "))
    }
}
