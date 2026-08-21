use anyhow::{anyhow, Result};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value as JsonValue};
use serde_yaml::Mapping;
use sha2::{Digest, Sha256};
use std::env;
#[cfg(test)]
use std::sync::{Mutex, OnceLock};

pub const USER_ID_HEADER: &str = "x-portico-userid";
pub const REDACT_ALLOW_HEADER: &str = "x-portico-redact-allow";
pub const APP_ID_HEADER: &str = "x-portico-appid";
pub const TRACK_HEADER: &str = "x-portico-track";
pub const LOG_REQUEST_HEADER: &str = "x-portico-log-request";
pub const LOG_RESPONSE_HEADER: &str = "x-portico-log-response";
pub const CONTENT_TYPE_HEADER: &str = "content-type";

pub const USER_ID_PRESENT_AUDIT_HEADER: &str = "x-bf-lh-portico-userid-present";
pub const USER_ID_FINGERPRINT_AUDIT_HEADER: &str = "x-bf-lh-portico-userid-fingerprint";
pub const REDACT_ALLOW_PRESENT_AUDIT_HEADER: &str = "x-bf-lh-portico-redact-allow-present";
pub const REDACT_ALLOW_FINGERPRINT_AUDIT_HEADER: &str = "x-bf-lh-portico-redact-allow-fingerprint";

pub const REQUIRED_BIFROST_HEADERS: [&str; 7] = [
    USER_ID_HEADER,
    REDACT_ALLOW_HEADER,
    APP_ID_HEADER,
    TRACK_HEADER,
    LOG_REQUEST_HEADER,
    LOG_RESPONSE_HEADER,
    CONTENT_TYPE_HEADER,
];

pub const BIFROST_LOGGING_HEADERS: [&str; 23] = [
    APP_ID_HEADER,
    TRACK_HEADER,
    LOG_REQUEST_HEADER,
    LOG_RESPONSE_HEADER,
    CONTENT_TYPE_HEADER,
    "x-openwebui-chat-id",
    "x-openwebui-session-id",
    "x-openwebui-message-id",
    "x-openwebui-debug-request-id",
    "x-openwebui-upstream-request-id",
    "x-openwebui-prompt-submitted-at-ms",
    "x-openwebui-request-phase",
    "x-openwebui-followup-index",
    "x-openwebui-outer-message-id",
    "x-openwebui-trigger-message-id",
    "x-openwebui-transcript-anchor-kind",
    "x-openwebui-transcript-anchor-message-id",
    "x-openwebui-transcript-anchor-tool-block-index",
    "traceparent",
    USER_ID_PRESENT_AUDIT_HEADER,
    USER_ID_FINGERPRINT_AUDIT_HEADER,
    REDACT_ALLOW_PRESENT_AUDIT_HEADER,
    REDACT_ALLOW_FINGERPRINT_AUDIT_HEADER,
];

#[cfg(test)]
pub(crate) fn test_env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderHeaderTemplate {
    pub user_id: String,
    pub redact_allow: String,
    pub app_id: String,
    pub track: String,
    pub log_request: String,
    pub log_response: String,
    pub content_type: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedProviderHeaders {
    pub user_id: String,
    pub redact_allow: String,
    pub app_id: String,
    pub track: String,
    pub log_request: String,
    pub log_response: String,
    pub content_type: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeaderAuditSummary {
    pub user_id_present: bool,
    pub user_id_fingerprint: String,
    pub redact_allow_present: bool,
    pub redact_allow_fingerprint: String,
}

impl ProviderHeaderTemplate {
    pub fn from_yaml_mapping(mapping: &Mapping) -> Result<Self> {
        Ok(Self {
            user_id: required_header(mapping, USER_ID_HEADER)?,
            redact_allow: required_header(mapping, REDACT_ALLOW_HEADER)?,
            app_id: required_header(mapping, APP_ID_HEADER)?,
            track: required_header(mapping, TRACK_HEADER)?,
            log_request: required_header(mapping, LOG_REQUEST_HEADER)?,
            log_response: required_header(mapping, LOG_RESPONSE_HEADER)?,
            content_type: required_header(mapping, CONTENT_TYPE_HEADER)?,
        })
    }

    pub fn resolve(&self) -> Result<ResolvedProviderHeaders> {
        Ok(ResolvedProviderHeaders {
            user_id: resolve_header_value(&self.user_id)?,
            redact_allow: resolve_header_value(&self.redact_allow)?,
            app_id: resolve_header_value(&self.app_id)?,
            track: resolve_header_value(&self.track)?,
            log_request: resolve_header_value(&self.log_request)?,
            log_response: resolve_header_value(&self.log_response)?,
            content_type: resolve_header_value(&self.content_type)?,
        })
    }

    pub fn mismatch_fields(&self, other: &Self) -> Vec<&'static str> {
        let mut fields = Vec::new();
        if self.user_id != other.user_id {
            fields.push(USER_ID_HEADER);
        }
        if self.redact_allow != other.redact_allow {
            fields.push(REDACT_ALLOW_HEADER);
        }
        if self.app_id != other.app_id {
            fields.push(APP_ID_HEADER);
        }
        if self.track != other.track {
            fields.push(TRACK_HEADER);
        }
        if self.log_request != other.log_request {
            fields.push(LOG_REQUEST_HEADER);
        }
        if self.log_response != other.log_response {
            fields.push(LOG_RESPONSE_HEADER);
        }
        if self.content_type != other.content_type {
            fields.push(CONTENT_TYPE_HEADER);
        }
        fields
    }
}

impl ResolvedProviderHeaders {
    pub fn to_bifrost_json(&self) -> JsonValue {
        json!({
            USER_ID_HEADER: self.user_id,
            REDACT_ALLOW_HEADER: self.redact_allow,
            APP_ID_HEADER: self.app_id,
            TRACK_HEADER: self.track,
            LOG_REQUEST_HEADER: self.log_request,
            LOG_RESPONSE_HEADER: self.log_response,
            CONTENT_TYPE_HEADER: self.content_type,
        })
    }

    pub fn upstream_headers(&self, api_key: &str) -> Result<HeaderMap> {
        self.request_headers(Some(api_key), false)
    }

    pub fn bifrost_headers(&self) -> Result<HeaderMap> {
        self.request_headers(None, true)
    }

    pub fn bifrost_headers_with_auth(&self, api_key: &str) -> Result<HeaderMap> {
        self.request_headers(Some(api_key), true)
    }

    pub fn audit_summary(&self) -> HeaderAuditSummary {
        HeaderAuditSummary {
            user_id_present: !self.user_id.is_empty(),
            user_id_fingerprint: fingerprint(&self.user_id),
            redact_allow_present: !self.redact_allow.is_empty(),
            redact_allow_fingerprint: fingerprint(&self.redact_allow),
        }
    }

    fn request_headers(
        &self,
        api_key: Option<&str>,
        include_bifrost_audit_headers: bool,
    ) -> Result<HeaderMap> {
        let mut headers = HeaderMap::new();
        if let Some(api_key) = api_key {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {api_key}"))?,
            );
        }
        headers.insert(USER_ID_HEADER, HeaderValue::from_str(&self.user_id)?);
        headers.insert(
            REDACT_ALLOW_HEADER,
            HeaderValue::from_str(&self.redact_allow)?,
        );
        headers.insert(APP_ID_HEADER, HeaderValue::from_str(&self.app_id)?);
        headers.insert(TRACK_HEADER, HeaderValue::from_str(&self.track)?);
        headers.insert(
            LOG_REQUEST_HEADER,
            HeaderValue::from_str(&self.log_request)?,
        );
        headers.insert(
            LOG_RESPONSE_HEADER,
            HeaderValue::from_str(&self.log_response)?,
        );
        headers.insert(CONTENT_TYPE, HeaderValue::from_str(&self.content_type)?);

        if include_bifrost_audit_headers {
            let audit = self.audit_summary();
            headers.insert(
                USER_ID_PRESENT_AUDIT_HEADER,
                HeaderValue::from_static("true"),
            );
            headers.insert(
                USER_ID_FINGERPRINT_AUDIT_HEADER,
                HeaderValue::from_str(&audit.user_id_fingerprint)?,
            );
            headers.insert(
                REDACT_ALLOW_PRESENT_AUDIT_HEADER,
                HeaderValue::from_static("true"),
            );
            headers.insert(
                REDACT_ALLOW_FINGERPRINT_AUDIT_HEADER,
                HeaderValue::from_str(&audit.redact_allow_fingerprint)?,
            );
        }

        Ok(headers)
    }
}

pub fn bifrost_required_headers_json() -> JsonValue {
    JsonValue::Array(
        REQUIRED_BIFROST_HEADERS
            .iter()
            .map(|header| JsonValue::String((*header).to_string()))
            .collect(),
    )
}

pub fn bifrost_logging_headers_json() -> JsonValue {
    JsonValue::Array(
        BIFROST_LOGGING_HEADERS
            .iter()
            .map(|header| JsonValue::String((*header).to_string()))
            .collect(),
    )
}

fn required_header(mapping: &Mapping, key: &str) -> Result<String> {
    let value = find_header_value(mapping, key)
        .ok_or_else(|| anyhow!("missing required provider header {key}"))?;
    normalize_header_value(value)
}

fn find_header_value<'a>(mapping: &'a Mapping, key: &str) -> Option<&'a str> {
    mapping.iter().find_map(|(header_name, header_value)| {
        let header_name = header_name.as_str()?;
        if !header_name.eq_ignore_ascii_case(key) {
            return None;
        }
        header_value.as_str()
    })
}

fn normalize_header_value(value: &str) -> Result<String> {
    let normalized = if let Some(stripped) = value.strip_prefix("os.environ/") {
        format!("env.{stripped}")
    } else {
        value.to_string()
    };
    if normalized.trim().is_empty() {
        Err(anyhow!("provider header values must not be blank"))
    } else {
        Ok(normalized)
    }
}

fn resolve_header_value(value: &str) -> Result<String> {
    let resolved = if let Some(env_name) = value.strip_prefix("env.") {
        env::var(env_name)
            .map_err(|_| anyhow!("Missing required environment variable: {env_name}"))?
    } else {
        value.to_string()
    };
    if resolved.trim().is_empty() {
        Err(anyhow!("Resolved provider header values must not be blank"))
    } else {
        Ok(resolved)
    }
}

fn fingerprint(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    hex::encode(digest)[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_portico_env(test: impl FnOnce()) {
        let _guard = test_env_lock().lock().unwrap();
        let previous_user_id = std::env::var("PORTICO_USER_ID").ok();
        let previous_redact_allow = std::env::var("PORTICO_REDACT_ALLOW").ok();
        let previous_build_track = std::env::var("PORTICO_BUILD_TRACK").ok();

        std::env::set_var("PORTICO_USER_ID", "user");
        std::env::set_var("PORTICO_REDACT_ALLOW", "false");
        std::env::set_var("PORTICO_BUILD_TRACK", "dev-build");

        test();

        restore_env("PORTICO_USER_ID", previous_user_id);
        restore_env("PORTICO_REDACT_ALLOW", previous_redact_allow);
        restore_env("PORTICO_BUILD_TRACK", previous_build_track);
    }

    fn restore_env(name: &str, previous: Option<String>) {
        if let Some(value) = previous {
            std::env::set_var(name, value);
        } else {
            std::env::remove_var(name);
        }
    }

    fn header_mapping() -> Mapping {
        serde_yaml::from_str(
            r#"
x-portico-userid: os.environ/PORTICO_USER_ID
x-portico-redact-allow: os.environ/PORTICO_REDACT_ALLOW
x-portico-appid: portico
x-portico-track: os.environ/PORTICO_BUILD_TRACK
x-portico-log-request: "false"
x-portico-log-response: "false"
Content-Type: application/json
"#,
        )
        .unwrap()
    }

    #[test]
    fn template_parsing_normalizes_required_headers() {
        let template = ProviderHeaderTemplate::from_yaml_mapping(&header_mapping()).unwrap();
        assert_eq!(template.user_id, "env.PORTICO_USER_ID");
        assert_eq!(template.redact_allow, "env.PORTICO_REDACT_ALLOW");
        assert_eq!(template.app_id, "portico");
        assert_eq!(template.track, "env.PORTICO_BUILD_TRACK");
        assert_eq!(template.log_request, "false");
        assert_eq!(template.log_response, "false");
        assert_eq!(template.content_type, "application/json");
    }

    #[test]
    fn resolved_headers_build_upstream_and_bifrost_header_maps() {
        let resolved = ResolvedProviderHeaders {
            user_id: "user".to_string(),
            redact_allow: "false".to_string(),
            app_id: "portico".to_string(),
            track: "dev-build".to_string(),
            log_request: "false".to_string(),
            log_response: "false".to_string(),
            content_type: "application/json".to_string(),
        };

        let upstream = resolved.upstream_headers("secret").unwrap();
        assert_eq!(upstream.get("authorization").unwrap(), "Bearer secret");
        assert_eq!(upstream.get(USER_ID_HEADER).unwrap(), "user");
        assert_eq!(upstream.get(CONTENT_TYPE).unwrap(), "application/json");

        let bifrost = resolved.bifrost_headers().unwrap();
        assert!(bifrost.get("authorization").is_none());
        assert_eq!(bifrost.get(USER_ID_PRESENT_AUDIT_HEADER).unwrap(), "true");
        assert!(bifrost.get(USER_ID_FINGERPRINT_AUDIT_HEADER).is_some());
        assert_eq!(
            bifrost.get(REDACT_ALLOW_PRESENT_AUDIT_HEADER).unwrap(),
            "true"
        );
        assert!(bifrost.get(REDACT_ALLOW_FINGERPRINT_AUDIT_HEADER).is_some());

        let bifrost_with_auth = resolved.bifrost_headers_with_auth("secret").unwrap();
        assert_eq!(
            bifrost_with_auth.get("authorization").unwrap(),
            "Bearer secret"
        );
        assert_eq!(
            bifrost_with_auth.get(USER_ID_PRESENT_AUDIT_HEADER).unwrap(),
            "true"
        );
        assert!(bifrost_with_auth
            .get(USER_ID_FINGERPRINT_AUDIT_HEADER)
            .is_some());
        assert_eq!(
            bifrost_with_auth
                .get(REDACT_ALLOW_PRESENT_AUDIT_HEADER)
                .unwrap(),
            "true"
        );
        assert!(bifrost_with_auth
            .get(REDACT_ALLOW_FINGERPRINT_AUDIT_HEADER)
            .is_some());
    }

    #[test]
    fn resolving_template_requires_environment_values() {
        with_portico_env(|| {
            let template = ProviderHeaderTemplate::from_yaml_mapping(&header_mapping()).unwrap();
            let resolved = template.resolve().unwrap();
            assert_eq!(resolved.user_id, "user");
            assert_eq!(resolved.track, "dev-build");
            assert_eq!(
                resolved.to_bifrost_json()[CONTENT_TYPE_HEADER],
                json!("application/json")
            );
            assert_eq!(resolved.to_bifrost_json()[USER_ID_HEADER], json!("user"));
        });
    }
}
