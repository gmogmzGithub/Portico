use std::collections::HashMap;

use anyhow::{Context, Result};
use log::{debug, info, warn};
use reqwest::{Client, Url};
use rmcp::transport::auth::AuthorizationMetadata;
use serde::Deserialize;
use serde_json::Value;

use super::logging::{oauth_info, oauth_warn};

const MCP_PROTOCOL_VERSION_HEADER: &str = "MCP-Protocol-Version";
const MCP_PROTOCOL_VERSION_VALUE: &str = "2024-11-05";

#[derive(Debug, Clone, Default)]
pub struct OAuthDiscovery {
    pub metadata: Option<AuthorizationMetadata>,
    pub resource: Option<String>,
    pub challenge_scopes: Vec<String>,
    pub protected_resource_scopes: Vec<String>,
    pub authorization_servers: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct WwwAuthenticateParams {
    resource_metadata_url: Option<Url>,
    scope: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct ProtectedResourceMetadata {
    authorization_server: Option<String>,
    authorization_servers: Option<Vec<String>>,
    scopes_supported: Option<Vec<String>>,
    authorization_endpoint: Option<String>,
    token_endpoint: Option<String>,
    registration_endpoint: Option<String>,
    resource: Option<String>,
    #[serde(flatten)]
    extra: HashMap<String, Value>,
}

pub async fn discover_from_auth_challenge(
    client: &Client,
    server_name: &str,
    auth_header: &str,
    mcp_url: &str,
) -> Result<Option<OAuthDiscovery>> {
    let base_url = Url::parse(mcp_url).with_context(|| format!("invalid MCP url '{mcp_url}'"))?;
    let parsed = parse_www_authenticate(auth_header, &base_url);
    let challenge_scopes = parsed
        .scope
        .as_deref()
        .map(split_scope_string)
        .unwrap_or_default();
    info!(
        "[{}] evaluating OAuth auth challenge; resource_metadata={:?}",
        server_name,
        parsed.resource_metadata_url.as_ref().map(Url::as_str)
    );
    oauth_info(format!(
        "[{server_name}] evaluating OAuth auth challenge (resource_metadata={:?})",
        parsed.resource_metadata_url.as_ref().map(Url::as_str)
    ));

    for resource_metadata_url in resource_metadata_urls(&base_url, parsed.resource_metadata_url) {
        if let Some(discovery) =
            discover_via_resource_metadata(client, server_name, &resource_metadata_url).await?
        {
            let mut discovery = discovery;
            if discovery.challenge_scopes.is_empty() {
                discovery.challenge_scopes = challenge_scopes.clone();
            }
            return Ok(Some(discovery));
        }
    }

    let provider_base = well_known_provider_base(&base_url);
    for candidate in authorization_metadata_urls(&base_url).into_iter().chain(
        provider_base
            .into_iter()
            .flat_map(|url| authorization_metadata_urls(&url)),
    ) {
        if let Some(metadata) =
            fetch_authorization_metadata(client, server_name, &candidate).await?
        {
            return Ok(Some(OAuthDiscovery {
                metadata: Some(metadata),
                resource: None,
                challenge_scopes: challenge_scopes.clone(),
                protected_resource_scopes: Vec::new(),
                authorization_servers: Vec::new(),
            }));
        }
    }

    if !challenge_scopes.is_empty() {
        return Ok(Some(OAuthDiscovery {
            metadata: None,
            resource: None,
            challenge_scopes,
            protected_resource_scopes: Vec::new(),
            authorization_servers: Vec::new(),
        }));
    }

    Ok(None)
}

pub async fn discover_from_base_url(
    client: &Client,
    server_name: &str,
    mcp_url: &str,
) -> Result<Option<OAuthDiscovery>> {
    let base_url = Url::parse(mcp_url).with_context(|| format!("invalid MCP url '{mcp_url}'"))?;

    for resource_metadata_url in resource_metadata_urls(&base_url, None) {
        if let Some(discovery) =
            discover_via_resource_metadata(client, server_name, &resource_metadata_url).await?
        {
            return Ok(Some(discovery));
        }
    }

    let provider_base = well_known_provider_base(&base_url);
    for candidate in authorization_metadata_urls(&base_url).into_iter().chain(
        provider_base
            .into_iter()
            .flat_map(|url| authorization_metadata_urls(&url)),
    ) {
        if let Some(metadata) =
            fetch_authorization_metadata(client, server_name, &candidate).await?
        {
            return Ok(Some(OAuthDiscovery {
                metadata: Some(metadata),
                resource: None,
                challenge_scopes: Vec::new(),
                protected_resource_scopes: Vec::new(),
                authorization_servers: Vec::new(),
            }));
        }
    }

    Ok(None)
}

async fn discover_via_resource_metadata(
    client: &Client,
    server_name: &str,
    resource_metadata_url: &Url,
) -> Result<Option<OAuthDiscovery>> {
    let Some(resource_metadata) =
        fetch_protected_resource_metadata(client, server_name, resource_metadata_url).await?
    else {
        return Ok(None);
    };

    let resource = resource_metadata
        .resource
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(resource) = resource.as_deref() {
        info!(
            "[{}] discovered OAuth protected resource binding '{}'",
            server_name, resource
        );
        oauth_info(format!(
            "[{server_name}] discovered OAuth protected resource binding '{resource}'"
        ));
    }

    let authorization_servers =
        authorization_server_candidates(&resource_metadata, resource_metadata_url);
    let protected_resource_scopes = normalize_scope_list(
        resource_metadata
            .scopes_supported
            .clone()
            .unwrap_or_default(),
    );
    if !authorization_servers.is_empty() {
        info!(
            "[{}] protected-resource metadata advertised authorization servers: {:?}",
            server_name, authorization_servers
        );
    }

    if let Some(metadata) = metadata_from_resource_metadata(&resource_metadata) {
        info!(
            "[{}] using authorization metadata embedded in protected-resource metadata",
            server_name
        );
        oauth_info(format!(
            "[{server_name}] using authorization metadata embedded in protected-resource metadata"
        ));
        return Ok(Some(OAuthDiscovery {
            metadata: Some(metadata),
            resource,
            challenge_scopes: Vec::new(),
            protected_resource_scopes,
            authorization_servers: authorization_servers
                .iter()
                .map(|url| url.as_str().to_string())
                .collect(),
        }));
    }

    for authorization_server in &authorization_servers {
        if let Some(metadata) =
            fetch_authorization_metadata_from_server(client, server_name, authorization_server)
                .await?
        {
            let mut metadata = metadata;
            if metadata.scopes_supported.is_none() {
                metadata.scopes_supported = resource_metadata.scopes_supported.clone();
            }
            if metadata.registration_endpoint.is_none() {
                metadata.registration_endpoint = resource_metadata.registration_endpoint.clone();
            }
            return Ok(Some(OAuthDiscovery {
                metadata: Some(metadata),
                resource,
                challenge_scopes: Vec::new(),
                protected_resource_scopes,
                authorization_servers: authorization_servers
                    .iter()
                    .map(|url| url.as_str().to_string())
                    .collect(),
            }));
        }
    }

    if resource.is_some() {
        warn!(
            "[{}] protected-resource metadata did not yield authorization metadata; keeping discovered resource only",
            server_name
        );
        oauth_warn(format!(
            "[{server_name}] protected-resource metadata did not yield authorization metadata; keeping discovered resource only"
        ));
        return Ok(Some(OAuthDiscovery {
            metadata: None,
            resource,
            challenge_scopes: Vec::new(),
            protected_resource_scopes,
            authorization_servers: authorization_servers
                .iter()
                .map(|url| url.as_str().to_string())
                .collect(),
        }));
    }

    Ok(None)
}

fn normalize_scope_list(scopes: Vec<String>) -> Vec<String> {
    let mut normalized: Vec<String> = Vec::new();
    for scope in scopes {
        let trimmed = scope.trim();
        if trimmed.is_empty()
            || normalized
                .iter()
                .any(|existing| existing.as_str() == trimmed)
        {
            continue;
        }
        normalized.push(trimmed.to_string());
    }
    normalized
}

fn metadata_from_resource_metadata(
    resource_metadata: &ProtectedResourceMetadata,
) -> Option<AuthorizationMetadata> {
    let authorization_endpoint = resource_metadata
        .authorization_endpoint
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let token_endpoint = resource_metadata
        .token_endpoint
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    Some(AuthorizationMetadata {
        authorization_endpoint,
        token_endpoint,
        registration_endpoint: resource_metadata.registration_endpoint.clone(),
        issuer: None,
        jwks_uri: None,
        scopes_supported: resource_metadata.scopes_supported.clone(),
        response_types_supported: None,
        code_challenge_methods_supported: Some(vec!["S256".to_string()]),
        additional_fields: resource_metadata.extra.clone(),
    })
}

fn authorization_server_candidates(
    resource_metadata: &ProtectedResourceMetadata,
    resource_metadata_url: &Url,
) -> Vec<Url> {
    let mut candidates = Vec::new();
    if let Some(single) = resource_metadata.authorization_server.as_deref() {
        push_authorization_server_candidate(&mut candidates, single, resource_metadata_url);
    }
    if let Some(list) = resource_metadata.authorization_servers.as_ref() {
        for entry in list {
            push_authorization_server_candidate(&mut candidates, entry, resource_metadata_url);
        }
    }
    candidates
}

fn push_authorization_server_candidate(
    candidates: &mut Vec<Url>,
    candidate: &str,
    resource_metadata_url: &Url,
) {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return;
    }
    let parsed = Url::parse(trimmed).or_else(|_| resource_metadata_url.join(trimmed));
    let Ok(parsed) = parsed else {
        return;
    };
    if !candidates.iter().any(|existing| existing == &parsed) {
        candidates.push(parsed);
    }
}

async fn fetch_protected_resource_metadata(
    client: &Client,
    server_name: &str,
    resource_metadata_url: &Url,
) -> Result<Option<ProtectedResourceMetadata>> {
    info!(
        "[{}] fetching OAuth protected-resource metadata from {}",
        server_name, resource_metadata_url
    );
    oauth_info(format!(
        "[{server_name}] fetching OAuth protected-resource metadata from {resource_metadata_url}"
    ));
    let response = client
        .get(resource_metadata_url.clone())
        .header(MCP_PROTOCOL_VERSION_HEADER, MCP_PROTOCOL_VERSION_VALUE)
        .send()
        .await
        .with_context(|| format!("failed to GET {resource_metadata_url}"))?;
    if !response.status().is_success() {
        debug!(
            "[{}] protected-resource metadata request returned HTTP {} for {}",
            server_name,
            response.status(),
            resource_metadata_url
        );
        return Ok(None);
    }
    let parsed = response
        .json::<ProtectedResourceMetadata>()
        .await
        .context("protected-resource metadata returned invalid JSON")?;
    Ok(Some(parsed))
}

async fn fetch_authorization_metadata_from_server(
    client: &Client,
    server_name: &str,
    authorization_server: &Url,
) -> Result<Option<AuthorizationMetadata>> {
    if authorization_server.path().contains("/.well-known/") {
        return fetch_authorization_metadata(client, server_name, authorization_server).await;
    }

    for candidate in authorization_metadata_urls(authorization_server) {
        if let Some(metadata) =
            fetch_authorization_metadata(client, server_name, &candidate).await?
        {
            return Ok(Some(metadata));
        }
    }
    warn!(
        "[{}] no OAuth authorization metadata discovered from authorization server {}",
        server_name, authorization_server
    );
    Ok(None)
}

async fn fetch_authorization_metadata(
    client: &Client,
    server_name: &str,
    discovery_url: &Url,
) -> Result<Option<AuthorizationMetadata>> {
    info!(
        "[{}] fetching OAuth authorization metadata from {}",
        server_name, discovery_url
    );
    let response = client
        .get(discovery_url.clone())
        .header(MCP_PROTOCOL_VERSION_HEADER, MCP_PROTOCOL_VERSION_VALUE)
        .send()
        .await
        .with_context(|| format!("failed to GET {discovery_url}"))?;
    if !response.status().is_success() {
        debug!(
            "[{}] authorization metadata request returned HTTP {} for {}",
            server_name,
            response.status(),
            discovery_url
        );
        return Ok(None);
    }
    let metadata = response
        .json::<AuthorizationMetadata>()
        .await
        .with_context(|| format!("failed to parse authorization metadata from {discovery_url}"))?;
    Ok(Some(metadata))
}

fn parse_www_authenticate(header: &str, base_url: &Url) -> WwwAuthenticateParams {
    WwwAuthenticateParams {
        resource_metadata_url: extract_header_param(header, "resource_metadata").and_then(
            |value| {
                Url::parse(&value)
                    .ok()
                    .or_else(|| base_url.join(&value).ok())
            },
        ),
        scope: extract_header_param(header, "scope"),
    }
}

fn extract_header_param(header: &str, key: &str) -> Option<String> {
    let key_marker = format!("{key}=");
    let lowercase = header.to_ascii_lowercase();
    let mut search_offset = 0usize;
    while let Some(relative_pos) = lowercase[search_offset..].find(&key_marker) {
        let start = search_offset + relative_pos + key_marker.len();
        let value_slice = &header[start..];
        let value = if let Some(stripped) = value_slice.strip_prefix('"') {
            stripped.split('"').next().map(str::to_string)
        } else {
            value_slice
                .split([',', ' '])
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            return Some(value);
        }
        search_offset = start;
    }
    None
}

fn resource_metadata_urls(base_url: &Url, explicit: Option<Url>) -> Vec<Url> {
    let mut urls = Vec::new();
    if let Some(explicit) = explicit {
        urls.push(explicit);
    }
    for candidate_path in well_known_paths(base_url.path(), "oauth-protected-resource") {
        push_url_candidate(&mut urls, base_url, &candidate_path);
    }
    urls
}

fn authorization_metadata_urls(base_url: &Url) -> Vec<Url> {
    let mut urls = Vec::new();
    let path = base_url.path();
    let trimmed = path.trim_start_matches('/').trim_end_matches('/');
    if trimmed.is_empty() {
        push_url_candidate(
            &mut urls,
            base_url,
            "/.well-known/oauth-authorization-server",
        );
        push_url_candidate(&mut urls, base_url, "/.well-known/openid-configuration");
        return urls;
    }

    push_url_candidate(
        &mut urls,
        base_url,
        &format!("/.well-known/oauth-authorization-server/{trimmed}"),
    );
    push_url_candidate(
        &mut urls,
        base_url,
        &format!("/.well-known/openid-configuration/{trimmed}"),
    );
    push_url_candidate(
        &mut urls,
        base_url,
        &format!("/{trimmed}/.well-known/openid-configuration"),
    );
    push_url_candidate(
        &mut urls,
        base_url,
        "/.well-known/oauth-authorization-server",
    );
    urls
}

fn push_url_candidate(urls: &mut Vec<Url>, base_url: &Url, path: &str) {
    let mut candidate = base_url.clone();
    candidate.set_query(None);
    candidate.set_fragment(None);
    candidate.set_path(path);
    if !urls.iter().any(|existing| existing == &candidate) {
        urls.push(candidate);
    }
}

fn well_known_paths(base_path: &str, resource: &str) -> Vec<String> {
    let trimmed = base_path.trim_start_matches('/').trim_end_matches('/');
    let mut candidates = Vec::new();
    let canonical = format!("/.well-known/{resource}");

    let mut push_candidate = |candidate: String| {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    };

    if trimmed.is_empty() {
        push_candidate(canonical);
        return candidates;
    }

    push_candidate(format!("{canonical}/{trimmed}"));
    push_candidate(format!("/{trimmed}/.well-known/{resource}"));
    push_candidate(canonical);
    candidates
}

fn well_known_provider_base(base_url: &Url) -> Option<Url> {
    let host = base_url.host_str()?.to_ascii_lowercase();
    let mapped = if host == "mcp.atlassian.com" || host.ends_with(".atlassian.com") {
        Some("https://auth.atlassian.com")
    } else if host == "api.github.com" || host.ends_with(".github.com") {
        Some("https://github.com")
    } else if host == "graph.microsoft.com" || host.ends_with(".microsoft.com") {
        Some("https://login.microsoftonline.com/common/v2.0")
    } else {
        None
    }?;
    Url::parse(mapped).ok()
}

fn split_scope_string(raw: &str) -> Vec<String> {
    raw.split_whitespace()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
#[path = "discovery_tests.rs"]
mod tests;
