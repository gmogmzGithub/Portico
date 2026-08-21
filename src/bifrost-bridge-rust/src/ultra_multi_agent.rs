use axum::http::HeaderMap;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

pub const BETA_HEADER_NAME: &str = "openai-beta";
pub const BETA_HEADER_VALUE: &str = "responses_multi_agent=v1";
pub const KEY_VERSION: &str = "v1";
pub const HEADER_KEY_VERSION: &str = "x-portico-ultra-key-version";
pub const HEADER_TIMESTAMP: &str = "x-portico-ultra-timestamp";
pub const HEADER_CONTEXT_DIGEST: &str = "x-portico-ultra-context";
pub const HEADER_FINGERPRINT: &str = "x-portico-ultra-fingerprint";
pub const HEADER_SIGNATURE: &str = "x-portico-ultra-signature";
pub const REQUEST_METHOD: &str = "POST";
pub const REQUEST_PATH: &str = "/v1/chat/completions";
pub const MAX_CLOCK_SKEW_SECONDS: u64 = 90;
pub const SIGNING_SECRET_PREFIX: &str = "ultra-sign-v1-";
pub const MIN_SIGNING_SECRET_LEN: usize = 70;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustedInteractiveOrigin {
    pub key_version: String,
    pub timestamp: u64,
    pub context_digest: String,
    pub fingerprint: String,
    pub body_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthError {
    MissingSecret,
    WeakSecret,
    MissingHeader(&'static str),
    InvalidHeader(&'static str),
    Expired,
    InvalidSignature,
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingSecret => write!(f, "Ultra signing secret is not configured"),
            Self::WeakSecret => write!(f, "Ultra signing secret is invalid or too weak"),
            Self::MissingHeader(name) => write!(f, "Missing authenticated Ultra header: {name}"),
            Self::InvalidHeader(name) => write!(f, "Invalid authenticated Ultra header: {name}"),
            Self::Expired => write!(
                f,
                "Authenticated Ultra request timestamp is outside the allowed window"
            ),
            Self::InvalidSignature => write!(f, "Authenticated Ultra request signature is invalid"),
        }
    }
}

impl std::error::Error for AuthError {}

pub fn validate_signing_secret(secret: &str) -> Result<(), AuthError> {
    if secret.trim().is_empty() {
        return Err(AuthError::MissingSecret);
    }
    if !secret.starts_with(SIGNING_SECRET_PREFIX) || secret.len() < MIN_SIGNING_SECRET_LEN {
        return Err(AuthError::WeakSecret);
    }
    Ok(())
}

pub fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn body_sha256(body: &[u8]) -> String {
    hex::encode(Sha256::digest(body))
}

fn required_header(headers: &HeaderMap, name: &'static str) -> Result<String, AuthError> {
    let value = headers
        .get(name)
        .ok_or(AuthError::MissingHeader(name))?
        .to_str()
        .map_err(|_| AuthError::InvalidHeader(name))?
        .trim()
        .to_string();
    if value.is_empty() || value.contains('\n') || value.contains('\r') {
        return Err(AuthError::InvalidHeader(name));
    }
    Ok(value)
}

fn required_opaque_digest(headers: &HeaderMap, name: &'static str) -> Result<String, AuthError> {
    let value = required_header(headers, name)?;
    let valid = URL_SAFE_NO_PAD
        .decode(&value)
        .map(|decoded| decoded.len() == 32)
        .unwrap_or(false)
        || hex::decode(&value)
            .map(|decoded| decoded.len() == 32)
            .unwrap_or(false);
    if !valid {
        return Err(AuthError::InvalidHeader(name));
    }
    Ok(value)
}

pub fn canonical_request(origin: &TrustedInteractiveOrigin, method: &str, path: &str) -> String {
    [
        KEY_VERSION,
        method,
        path,
        origin.key_version.as_str(),
        &origin.timestamp.to_string(),
        origin.context_digest.as_str(),
        origin.fingerprint.as_str(),
        origin.body_sha256.as_str(),
    ]
    .join("\n")
}

fn signature_for(secret: &str, canonical: &str) -> Result<String, AuthError> {
    validate_signing_secret(secret)?;
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| AuthError::WeakSecret)?;
    mac.update(canonical.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

pub fn derive_context_digest(
    secret: &str,
    user_id: &str,
    chat_id: &str,
    message_id: &str,
) -> Result<String, AuthError> {
    validate_signing_secret(secret)?;
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| AuthError::WeakSecret)?;
    mac.update(b"portico-ultra-origin-v1\n");
    mac.update(user_id.as_bytes());
    mac.update(b"\n");
    mac.update(chat_id.as_bytes());
    mac.update(b"\n");
    mac.update(message_id.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

pub fn sign_request(
    secret: &str,
    body: &[u8],
    timestamp: u64,
    user_id: &str,
    chat_id: &str,
    message_id: &str,
    fingerprint: &str,
) -> Result<BTreeMap<&'static str, String>, AuthError> {
    let origin = TrustedInteractiveOrigin {
        key_version: KEY_VERSION.to_string(),
        timestamp,
        context_digest: derive_context_digest(secret, user_id, chat_id, message_id)?,
        fingerprint: fingerprint.to_string(),
        body_sha256: body_sha256(body),
    };
    let signature = signature_for(
        secret,
        &canonical_request(&origin, REQUEST_METHOD, REQUEST_PATH),
    )?;
    Ok(BTreeMap::from([
        (HEADER_KEY_VERSION, origin.key_version),
        (HEADER_TIMESTAMP, origin.timestamp.to_string()),
        (HEADER_CONTEXT_DIGEST, origin.context_digest),
        (HEADER_FINGERPRINT, origin.fingerprint),
        (HEADER_SIGNATURE, signature),
    ]))
}

pub fn verify_request(
    secret: &str,
    headers: &HeaderMap,
    body: &[u8],
    now: u64,
) -> Result<TrustedInteractiveOrigin, AuthError> {
    validate_signing_secret(secret)?;
    let key_version = required_header(headers, HEADER_KEY_VERSION)?;
    if key_version != KEY_VERSION {
        return Err(AuthError::InvalidHeader(HEADER_KEY_VERSION));
    }
    let timestamp_text = required_header(headers, HEADER_TIMESTAMP)?;
    let timestamp = timestamp_text
        .parse::<u64>()
        .map_err(|_| AuthError::InvalidHeader(HEADER_TIMESTAMP))?;
    if now.abs_diff(timestamp) > MAX_CLOCK_SKEW_SECONDS {
        return Err(AuthError::Expired);
    }
    let origin = TrustedInteractiveOrigin {
        key_version,
        timestamp,
        context_digest: required_opaque_digest(headers, HEADER_CONTEXT_DIGEST)?,
        fingerprint: required_opaque_digest(headers, HEADER_FINGERPRINT)?,
        body_sha256: body_sha256(body),
    };
    let provided = required_header(headers, HEADER_SIGNATURE)?;
    let provided = URL_SAFE_NO_PAD
        .decode(provided)
        .map_err(|_| AuthError::InvalidSignature)?;
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| AuthError::WeakSecret)?;
    mac.update(canonical_request(&origin, REQUEST_METHOD, REQUEST_PATH).as_bytes());
    mac.verify_slice(&provided)
        .map_err(|_| AuthError::InvalidSignature)?;
    Ok(origin)
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CumulativeUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cached_input_tokens: u64,
    #[serde(default)]
    pub cached_read_tokens: u64,
    #[serde(default)]
    pub cached_write_tokens: u64,
    pub cost_microusd: u64,
    #[serde(default)]
    pub round_ids: BTreeSet<String>,
    // Latest round's input, NOT summed: cumulative input_tokens measures
    // spend across rounds, while the last round's input is the actual
    // context occupancy consumers should show as "context used".
    #[serde(default)]
    pub last_round_input_tokens: u64,
}

impl CumulativeUsage {
    pub fn observe(&mut self, round_id: &str, usage: &Value) -> bool {
        if !self.round_ids.insert(round_id.to_string()) {
            return false;
        }
        let round_input_tokens = read_usage_value(usage, &["input_tokens", "prompt_tokens"]);
        if round_input_tokens > 0 {
            self.last_round_input_tokens = round_input_tokens;
        }
        self.input_tokens = self
            .input_tokens
            .saturating_add(read_usage_value(usage, &["input_tokens", "prompt_tokens"]));
        self.output_tokens = self.output_tokens.saturating_add(read_usage_value(
            usage,
            &["output_tokens", "completion_tokens"],
        ));
        let explicit_total = read_usage_value(usage, &["total_tokens"]);
        self.total_tokens = self.total_tokens.saturating_add(if explicit_total > 0 {
            explicit_total
        } else {
            read_usage_value(usage, &["input_tokens", "prompt_tokens"]).saturating_add(
                read_usage_value(usage, &["output_tokens", "completion_tokens"]),
            )
        });
        self.cached_input_tokens = self.cached_input_tokens.saturating_add(
            usage
                .pointer("/input_tokens_details/cached_tokens")
                .or_else(|| usage.pointer("/prompt_tokens_details/cached_tokens"))
                .and_then(Value::as_u64)
                .unwrap_or_default(),
        );
        self.cached_read_tokens = self.cached_read_tokens.saturating_add(
            usage
                .pointer("/input_tokens_details/cached_read_tokens")
                .or_else(|| usage.pointer("/prompt_tokens_details/cached_read_tokens"))
                .and_then(Value::as_u64)
                .unwrap_or_default(),
        );
        self.cached_write_tokens = self.cached_write_tokens.saturating_add(
            usage
                .pointer("/input_tokens_details/cached_write_tokens")
                .or_else(|| usage.pointer("/prompt_tokens_details/cached_write_tokens"))
                .and_then(Value::as_u64)
                .unwrap_or_default(),
        );
        self.cost_microusd = self.cost_microusd.saturating_add(read_cost_microusd(usage));
        true
    }

    pub fn as_chat_usage(&self) -> Value {
        let mut usage = serde_json::json!({
            "prompt_tokens": self.input_tokens,
            "completion_tokens": self.output_tokens,
            "total_tokens": self.total_tokens,
            "prompt_tokens_details": {
                "cached_tokens": self.cached_input_tokens,
                "cached_read_tokens": self.cached_read_tokens,
                "cached_write_tokens": self.cached_write_tokens,
            },
            "cost": self.cost_microusd as f64 / 1_000_000.0,
        });
        if self.last_round_input_tokens > 0 {
            if let Some(object) = usage.as_object_mut() {
                object.insert(
                    "context_tokens".to_string(),
                    serde_json::json!(self.last_round_input_tokens),
                );
            }
        }
        usage
    }
}

fn read_usage_value(usage: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|key| usage.get(key).and_then(Value::as_u64))
        .unwrap_or_default()
}

fn read_cost_microusd(usage: &Value) -> u64 {
    usage
        .get("cost")
        .or_else(|| usage.pointer("/extra_fields/cost"))
        .and_then(Value::as_f64)
        .filter(|cost| cost.is_finite() && *cost >= 0.0)
        .map(|cost| (cost * 1_000_000.0).round() as u64)
        .unwrap_or_default()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UltraToolCall {
    pub output_index: usize,
    pub item_id: String,
    pub call_id: String,
    pub name: String,
    pub namespace: Option<String>,
    pub registered_name: String,
    pub arguments: String,
    pub agent_name: String,
    pub payload_digest: String,
}

impl UltraToolCall {
    fn from_item(output_index: usize, item: &Value) -> Result<Self, AssembleError> {
        let item_id = string_field(item, "id")?;
        let call_id = string_field(item, "call_id")?;
        let name = string_field(item, "name")?;
        let arguments = string_field(item, "arguments")?;
        let parsed_arguments = serde_json::from_str::<Value>(&arguments)
            .map_err(|_| AssembleError::InvalidFunctionArguments(call_id.clone()))?;
        if !parsed_arguments.is_object() {
            return Err(AssembleError::InvalidFunctionArguments(call_id));
        }
        let namespace = match item.get("namespace") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
            _ => {
                return Err(AssembleError::InvalidSequence(
                    "function call namespace is invalid".to_string(),
                ))
            }
        };
        let registered_name = namespace
            .as_ref()
            .map(|namespace| format!("{namespace}_{name}"))
            .unwrap_or_else(|| name.clone());
        let agent_name = agent_name(item)
            .filter(|name| *name == "/root")
            .ok_or_else(|| {
                AssembleError::InvalidSequence(
                    "function call must originate from the canonical /root agent".to_string(),
                )
            })?
            .to_string();
        let payload_digest = body_sha256(
            format!(
                "{output_index}\n{item_id}\n{call_id}\n{}\n{name}\n{registered_name}\n{arguments}",
                namespace.as_deref().unwrap_or("")
            )
            .as_bytes(),
        );
        Ok(Self {
            output_index,
            item_id,
            call_id,
            name,
            namespace,
            registered_name,
            arguments,
            agent_name,
            payload_digest,
        })
    }

    pub fn bind_to_tool_snapshot(&mut self, tools: &Value) -> Result<(), AssembleError> {
        let entries = tools.as_array().ok_or_else(|| {
            AssembleError::InvalidSequence("Ultra tool snapshot is missing".to_string())
        })?;
        let matched = if let Some(namespace) = self.namespace.as_deref() {
            let namespaces = entries
                .iter()
                .filter(|entry| {
                    entry.get("type").and_then(Value::as_str) == Some("namespace")
                        && entry.get("name").and_then(Value::as_str) == Some(namespace)
                })
                .collect::<Vec<_>>();
            if namespaces.len() != 1 {
                return Err(AssembleError::InvalidSequence(
                    "function namespace is absent or ambiguous in the request snapshot".to_string(),
                ));
            }
            namespaces[0]
                .get("tools")
                .and_then(Value::as_array)
                .map(|tools| {
                    tools
                        .iter()
                        .filter(|tool| {
                            tool.get("type").and_then(Value::as_str) == Some("function")
                                && tool.get("name").and_then(Value::as_str)
                                    == Some(self.name.as_str())
                        })
                        .count()
                })
                .unwrap_or_default()
        } else {
            entries
                .iter()
                .filter(|tool| {
                    tool.get("type").and_then(Value::as_str) == Some("function")
                        && tool.get("name").and_then(Value::as_str) == Some(self.name.as_str())
                })
                .count()
        };
        if matched != 1 {
            return Err(AssembleError::InvalidSequence(
                "function name is absent or ambiguous in the request tool snapshot".to_string(),
            ));
        }
        self.registered_name = self
            .namespace
            .as_ref()
            .map(|namespace| format!("{namespace}_{}", self.name))
            .unwrap_or_else(|| self.name.clone());
        self.payload_digest = body_sha256(
            format!(
                "{}\n{}\n{}\n{}\n{}\n{}\n{}",
                self.output_index,
                self.item_id,
                self.call_id,
                self.namespace.as_deref().unwrap_or(""),
                self.name,
                self.registered_name,
                self.arguments,
            )
            .as_bytes(),
        );
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OpaqueRoundState {
    pub version: u8,
    pub origin_fingerprint: String,
    pub transcript: Vec<Value>,
    pub cumulative_usage: CumulativeUsage,
    #[serde(default)]
    pub seen_calls: BTreeMap<String, String>,
}

impl OpaqueRoundState {
    pub fn new(origin_fingerprint: String, transcript: Vec<Value>) -> Self {
        Self {
            version: 1,
            origin_fingerprint,
            transcript,
            cumulative_usage: CumulativeUsage::default(),
            seen_calls: BTreeMap::new(),
        }
    }

    pub fn add_unique_calls(&mut self, calls: &[UltraToolCall]) -> Result<(), StateError> {
        for call in calls {
            if let Some(previous_digest) = self.seen_calls.get(&call.call_id) {
                return if previous_digest == &call.payload_digest {
                    Err(StateError::DuplicateCall(call.call_id.clone()))
                } else {
                    Err(StateError::PayloadDrift(call.call_id.clone()))
                };
            }
            if self
                .seen_calls
                .values()
                .any(|digest| digest == &call.payload_digest)
            {
                return Err(StateError::DuplicateCall(call.call_id.clone()));
            }
        }
        for call in calls {
            self.seen_calls
                .insert(call.call_id.clone(), call.payload_digest.clone());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StateError {
    DuplicateCall(String),
    PayloadDrift(String),
    InvalidTransition(&'static str),
    OutOfOrderCall,
    DuplicateDispatch(String),
    UnknownCall(String),
}

impl fmt::Display for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateCall(id) => write!(f, "Duplicate Ultra tool call: {id}"),
            Self::PayloadDrift(id) => write!(f, "Ultra tool payload changed for call: {id}"),
            Self::InvalidTransition(message) => {
                write!(f, "Invalid Ultra dispatch transition: {message}")
            }
            Self::OutOfOrderCall => write!(f, "Ultra call IDs must be reserved in output order"),
            Self::DuplicateDispatch(id) => write!(
                f,
                "Ultra call already dispatched; outcome is ambiguous: {id}"
            ),
            Self::UnknownCall(id) => write!(f, "Unknown Ultra call: {id}"),
        }
    }
}

impl std::error::Error for StateError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DispatchPoll {
    Reserved,
    InFlight,
    Completed,
    ExpiredSafe,
    ExpiredAmbiguous,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum BatchPhase {
    Reserved,
    Claimed,
    CallsReserved,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DispatchCall {
    call_id: String,
    payload_digest: String,
    started: bool,
    completed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderedBatchAdmission {
    batch_id: String,
    expected_calls: usize,
    phase: BatchPhase,
    stable_response_id: Option<String>,
    calls: Vec<DispatchCall>,
    heartbeat_epoch: u64,
    expired: bool,
}

impl OrderedBatchAdmission {
    pub fn reserve_batch(
        batch_id: impl Into<String>,
        expected_calls: usize,
        now: u64,
    ) -> Result<Self, StateError> {
        if expected_calls == 0 {
            return Err(StateError::InvalidTransition("empty batch"));
        }
        Ok(Self {
            batch_id: batch_id.into(),
            expected_calls,
            phase: BatchPhase::Reserved,
            stable_response_id: None,
            calls: Vec::with_capacity(expected_calls),
            heartbeat_epoch: now,
            expired: false,
        })
    }

    pub fn batch_id(&self) -> &str {
        &self.batch_id
    }

    pub fn stable_response_id(&self) -> Option<&str> {
        self.stable_response_id.as_deref()
    }

    pub fn claim_stable_response_id(&mut self, response_id: &str) -> Result<(), StateError> {
        if self.phase != BatchPhase::Reserved || response_id.trim().is_empty() {
            return Err(StateError::InvalidTransition(
                "batch must be reserved before response ID claim",
            ));
        }
        self.stable_response_id = Some(response_id.to_string());
        self.phase = BatchPhase::Claimed;
        Ok(())
    }

    pub fn reserve_call(
        &mut self,
        output_index: usize,
        call_id: &str,
        payload_digest: &str,
    ) -> Result<(), StateError> {
        if !matches!(self.phase, BatchPhase::Claimed | BatchPhase::CallsReserved) {
            return Err(StateError::InvalidTransition(
                "stable response ID must be claimed before calls",
            ));
        }
        if output_index != self.calls.len() || output_index >= self.expected_calls {
            return Err(StateError::OutOfOrderCall);
        }
        if self
            .calls
            .iter()
            .any(|call| call.call_id == call_id || call.payload_digest == payload_digest)
        {
            return Err(StateError::DuplicateCall(call_id.to_string()));
        }
        self.calls.push(DispatchCall {
            call_id: call_id.to_string(),
            payload_digest: payload_digest.to_string(),
            started: false,
            completed: false,
        });
        if self.calls.len() == self.expected_calls {
            self.phase = BatchPhase::CallsReserved;
        }
        Ok(())
    }

    pub fn start_dispatch(&mut self, call_id: &str, now: u64) -> Result<(), StateError> {
        if self.phase != BatchPhase::CallsReserved {
            return Err(StateError::InvalidTransition(
                "all ordered call IDs must be reserved before dispatch",
            ));
        }
        let call = self
            .calls
            .iter_mut()
            .find(|call| call.call_id == call_id)
            .ok_or_else(|| StateError::UnknownCall(call_id.to_string()))?;
        if call.started {
            return Err(StateError::DuplicateDispatch(call_id.to_string()));
        }
        call.started = true;
        self.heartbeat_epoch = now;
        Ok(())
    }

    pub fn heartbeat(&mut self, call_id: &str, now: u64) -> Result<(), StateError> {
        let call = self
            .calls
            .iter()
            .find(|call| call.call_id == call_id)
            .ok_or_else(|| StateError::UnknownCall(call_id.to_string()))?;
        if !call.started || call.completed || self.expired {
            return Err(StateError::InvalidTransition(
                "heartbeat requires an active dispatch",
            ));
        }
        self.heartbeat_epoch = now;
        Ok(())
    }

    pub fn complete(&mut self, call_id: &str, now: u64) -> Result<(), StateError> {
        let call = self
            .calls
            .iter_mut()
            .find(|call| call.call_id == call_id)
            .ok_or_else(|| StateError::UnknownCall(call_id.to_string()))?;
        if !call.started || call.completed || self.expired {
            return Err(StateError::InvalidTransition(
                "completion requires one active dispatch",
            ));
        }
        call.completed = true;
        self.heartbeat_epoch = now;
        Ok(())
    }

    pub fn expire(&mut self) {
        self.expired = true;
    }

    pub fn poll(&self) -> DispatchPoll {
        if self.expired {
            if self.calls.iter().any(|call| call.started) {
                return DispatchPoll::ExpiredAmbiguous;
            }
            return DispatchPoll::ExpiredSafe;
        }
        if !self.calls.is_empty() && self.calls.iter().all(|call| call.completed) {
            return DispatchPoll::Completed;
        }
        if self.calls.iter().any(|call| call.started) {
            return DispatchPoll::InFlight;
        }
        DispatchPoll::Reserved
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum BufferedOutcome {
    RootFinal {
        response_id: String,
        text: String,
        usage: Value,
        output: Vec<Value>,
    },
    ToolBatch {
        response_id: String,
        calls: Vec<UltraToolCall>,
        usage: Value,
        output: Vec<Value>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AssembleError {
    InvalidSse(String),
    InvalidSequence(String),
    InvalidFunctionArguments(String),
    MissingRootFinal,
    MixedFinalAndTools,
    Incomplete,
}

impl fmt::Display for AssembleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSse(message) => write!(f, "Invalid Ultra SSE: {message}"),
            Self::InvalidSequence(message) => write!(f, "Invalid Ultra event sequence: {message}"),
            Self::InvalidFunctionArguments(call_id) => {
                write!(
                    f,
                    "Ultra function call {call_id} has invalid JSON arguments"
                )
            }
            Self::MissingRootFinal => {
                write!(f, "Ultra response completed without a root final answer")
            }
            Self::MixedFinalAndTools => write!(
                f,
                "Ultra response mixed a root final answer with tool calls"
            ),
            Self::Incomplete => write!(f, "Ultra response ended before a completed terminal event"),
        }
    }
}

impl std::error::Error for AssembleError {}

#[derive(Clone, Debug)]
struct ItemAssembly {
    item_id: String,
    item_type: String,
    stable_digest: String,
    added: bool,
    done: bool,
    done_digest: Option<String>,
    arguments: String,
}

#[derive(Default)]
pub struct UltraEventAssembler {
    items: BTreeMap<usize, ItemAssembly>,
    response_id: Option<String>,
    terminal: Option<BufferedOutcome>,
    failed: bool,
}

impl UltraEventAssembler {
    pub fn push(&mut self, event_name: &str, payload: Value) -> Result<(), AssembleError> {
        if self.terminal.is_some() || self.failed {
            return Err(AssembleError::InvalidSequence(
                "event received after terminal event".to_string(),
            ));
        }
        let payload_event = payload
            .get("type")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AssembleError::InvalidSse("event has no type".to_string()))?
            .to_string();
        if event_name.is_empty() {
            return Err(AssembleError::InvalidSse(
                "SSE event label is missing".to_string(),
            ));
        }
        if event_name != payload_event {
            return Err(AssembleError::InvalidSequence(format!(
                "SSE event label {event_name} differs from payload type {payload_event}"
            )));
        }
        self.observe_response_identity(&payload, &payload_event)?;
        let event_name = payload_event.as_str();
        match event_name {
            "response.created" | "response.in_progress" => Ok(()),
            "response.output_item.added" => self.add_item(&payload),
            "response.function_call_arguments.delta" => self.add_arguments_delta(&payload),
            "response.function_call_arguments.done" => self.finish_arguments(&payload),
            "response.output_item.done" => self.finish_item(&payload),
            "response.completed" => {
                let response = payload.get("response").ok_or_else(|| {
                    AssembleError::InvalidSse("completed event lacks response".to_string())
                })?;
                let outcome = self.project_completed(response)?;
                self.terminal = Some(outcome);
                Ok(())
            }
            "response.failed" | "response.incomplete" | "response.error" | "error" => {
                self.failed = true;
                Err(AssembleError::Incomplete)
            }
            "response.output_text.delta"
            | "response.output_text.done"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_summary_text.done"
            | "response.reasoning.delta"
            | "response.reasoning.done"
            | "response.content_part.added"
            | "response.content_part.done"
            | "response.refusal.delta"
            | "response.refusal.done" => Ok(()),
            "" => Err(AssembleError::InvalidSse("event has no type".to_string())),
            _ => Err(AssembleError::InvalidSequence(format!(
                "unrecognized event type: {event_name}"
            ))),
        }
    }

    fn observe_response_identity(
        &mut self,
        payload: &Value,
        event_name: &str,
    ) -> Result<(), AssembleError> {
        let top_level_id = payload.get("response_id").and_then(Value::as_str);
        let nested_id = payload.pointer("/response/id").and_then(Value::as_str);
        if let (Some(top_level_id), Some(nested_id)) = (top_level_id, nested_id) {
            if top_level_id != nested_id {
                return Err(AssembleError::InvalidSequence(
                    "event carries conflicting response identities".to_string(),
                ));
            }
        }
        if let Some(response_id) = top_level_id.or(nested_id) {
            if response_id.is_empty() {
                return Err(AssembleError::InvalidSse(
                    "event carries an empty response identity".to_string(),
                ));
            }
            match &self.response_id {
                Some(expected) if expected != response_id => {
                    return Err(AssembleError::InvalidSequence(
                        "response identity changed within one stream".to_string(),
                    ))
                }
                None => self.response_id = Some(response_id.to_string()),
                _ => {}
            }
        }

        if let Some(status) = payload.pointer("/response/status").and_then(Value::as_str) {
            let status_is_valid = match event_name {
                "response.created" => matches!(status, "queued" | "in_progress"),
                "response.in_progress" => status == "in_progress",
                "response.completed" => status == "completed",
                "response.failed" => status == "failed",
                "response.incomplete" => status == "incomplete",
                _ => true,
            };
            if !status_is_valid {
                return Err(AssembleError::InvalidSequence(format!(
                    "response status {status} is invalid for event {event_name}"
                )));
            }
        }
        Ok(())
    }

    fn add_item(&mut self, payload: &Value) -> Result<(), AssembleError> {
        let index = output_index(payload)?;
        if self.items.contains_key(&index) {
            return Err(AssembleError::InvalidSequence(format!(
                "duplicate output_item.added at index {index}"
            )));
        }
        let item = payload
            .get("item")
            .ok_or_else(|| AssembleError::InvalidSse("output_item.added lacks item".to_string()))?;
        let item_id = string_field(item, "id")?;
        let item_type = string_field(item, "type")?;
        let stable_digest = stable_item_digest(item)?;
        self.items.insert(
            index,
            ItemAssembly {
                item_id,
                item_type,
                stable_digest,
                added: true,
                done: false,
                done_digest: None,
                arguments: String::new(),
            },
        );
        Ok(())
    }

    fn add_arguments_delta(&mut self, payload: &Value) -> Result<(), AssembleError> {
        let index = output_index(payload)?;
        let item_id = string_field(payload, "item_id")?;
        let delta = payload
            .get("delta")
            .and_then(Value::as_str)
            .ok_or_else(|| AssembleError::InvalidSse("argument delta is not text".to_string()))?;
        let item = self.items.get_mut(&index).ok_or_else(|| {
            AssembleError::InvalidSequence("arguments before item.added".to_string())
        })?;
        if item.item_id != item_id || item.item_type != "function_call" || item.done {
            return Err(AssembleError::InvalidSequence(
                "argument delta identity/type mismatch".to_string(),
            ));
        }
        item.arguments.push_str(delta);
        Ok(())
    }

    fn finish_arguments(&mut self, payload: &Value) -> Result<(), AssembleError> {
        let index = output_index(payload)?;
        let item_id = string_field(payload, "item_id")?;
        let arguments = string_field(payload, "arguments")?;
        let item = self.items.get_mut(&index).ok_or_else(|| {
            AssembleError::InvalidSequence("arguments.done before item.added".to_string())
        })?;
        if item.item_id != item_id || item.item_type != "function_call" || item.done {
            return Err(AssembleError::InvalidSequence(
                "arguments.done identity/type mismatch".to_string(),
            ));
        }
        if !item.arguments.is_empty() && item.arguments != arguments {
            return Err(AssembleError::InvalidSequence(
                "arguments.done differs from legal deltas".to_string(),
            ));
        }
        item.arguments = arguments;
        Ok(())
    }

    fn finish_item(&mut self, payload: &Value) -> Result<(), AssembleError> {
        let index = output_index(payload)?;
        let completed = payload
            .get("item")
            .ok_or_else(|| AssembleError::InvalidSse("output_item.done lacks item".to_string()))?;
        let completed_id = string_field(completed, "id")?;
        let completed_type = string_field(completed, "type")?;
        let item = self.items.get_mut(&index).ok_or_else(|| {
            AssembleError::InvalidSequence("item.done before item.added".to_string())
        })?;
        if !item.added
            || item.done
            || item.item_id != completed_id
            || item.stable_digest != stable_item_digest(completed)?
            || item.item_type != completed_type
        {
            return Err(AssembleError::InvalidSequence(
                "output_item.done identity/type mismatch".to_string(),
            ));
        }
        if completed_type == "function_call" {
            let arguments = string_field(completed, "arguments")?;
            if !item.arguments.is_empty() && item.arguments != arguments {
                return Err(AssembleError::InvalidSequence(
                    "completed function arguments differ from legal deltas".to_string(),
                ));
            }
            item.arguments = arguments;
        }
        item.done_digest = Some(body_sha256(&serde_json::to_vec(completed).map_err(
            |_| AssembleError::InvalidSse("item is not serializable".to_string()),
        )?));
        item.done = true;
        Ok(())
    }

    fn project_completed(&self, response: &Value) -> Result<BufferedOutcome, AssembleError> {
        let response_id = string_field(response, "id")?;
        let output = response
            .get("output")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                AssembleError::InvalidSse("completed response lacks output".to_string())
            })?
            .clone();
        if self.items.len() != output.len() {
            return Err(AssembleError::InvalidSequence(
                "terminal output does not match added item count".to_string(),
            ));
        }
        let usage = response
            .get("usage")
            .filter(|usage| {
                match (
                    usage.get("input_tokens").and_then(Value::as_u64),
                    usage.get("output_tokens").and_then(Value::as_u64),
                    usage.get("total_tokens").and_then(Value::as_u64),
                ) {
                    (Some(input), Some(output), Some(total)) => input
                        .checked_add(output)
                        .is_some_and(|minimum_total| total >= minimum_total),
                    _ => false,
                }
            })
            .cloned()
            .ok_or_else(|| {
                AssembleError::InvalidSse(
                    "completed response lacks nonnegative token usage".to_string(),
                )
            })?;
        let mut root_text = String::new();
        let mut root_final_count = 0usize;
        let mut calls = Vec::new();

        for (index, item) in output.iter().enumerate() {
            let item_id = string_field(item, "id")?;
            let item_type = string_field(item, "type")?;
            let assembly = self.items.get(&index).ok_or_else(|| {
                AssembleError::InvalidSequence(format!(
                    "terminal item at index {index} was not legally added"
                ))
            })?;
            let terminal_digest = body_sha256(&serde_json::to_vec(item).map_err(|_| {
                AssembleError::InvalidSse("terminal item is not serializable".to_string())
            })?);
            if !assembly.done
                || assembly.item_id != item_id
                || assembly.item_type != item_type
                || assembly.done_digest.as_deref() != Some(terminal_digest.as_str())
            {
                return Err(AssembleError::InvalidSequence(format!(
                    "terminal item at index {index} differs from output_item.done"
                )));
            }
            match item.get("type").and_then(Value::as_str).unwrap_or("") {
                "message" => {
                    if is_root_final(item) {
                        root_final_count = root_final_count.saturating_add(1);
                        if root_final_count > 1 {
                            return Err(AssembleError::InvalidSequence(
                                "multiple root final answers are forbidden".to_string(),
                            ));
                        }
                        let text = message_text(item);
                        if text.trim().is_empty() {
                            return Err(AssembleError::MissingRootFinal);
                        }
                        root_text = text;
                    }
                }
                "function_call" => {
                    let assembly = self.items.get(&index).ok_or_else(|| {
                        AssembleError::InvalidSequence(format!(
                            "function call at index {index} lacks output_item.added"
                        ))
                    })?;
                    if !assembly.done {
                        return Err(AssembleError::InvalidSequence(format!(
                            "function call at index {index} lacks output_item.done"
                        )));
                    }
                    let call = UltraToolCall::from_item(index, item)?;
                    if assembly.item_id != call.item_id || assembly.arguments != call.arguments {
                        return Err(AssembleError::InvalidSequence(format!(
                            "completed function call at index {index} differs from assembled event"
                        )));
                    }
                    calls.push(call);
                }
                "reasoning"
                | "multi_agent_call"
                | "multi_agent_call_output"
                | "agent_message"
                | "computer_call"
                | "web_search_call"
                | "file_search_call"
                | "code_interpreter_call" => {}
                other => {
                    return Err(AssembleError::InvalidSequence(format!(
                        "unrecognized output item type: {other}"
                    )))
                }
            }
        }

        if !calls.is_empty() && root_final_count > 0 {
            return Err(AssembleError::MixedFinalAndTools);
        }
        if !calls.is_empty() {
            return Ok(BufferedOutcome::ToolBatch {
                response_id,
                calls,
                usage,
                output,
            });
        }
        if root_final_count != 1 || root_text.trim().is_empty() {
            return Err(AssembleError::MissingRootFinal);
        }
        Ok(BufferedOutcome::RootFinal {
            response_id,
            text: root_text,
            usage,
            output,
        })
    }

    pub fn finish(self) -> Result<BufferedOutcome, AssembleError> {
        if self.failed {
            return Err(AssembleError::Incomplete);
        }
        self.terminal.ok_or(AssembleError::Incomplete)
    }
}

fn stable_item_digest(item: &Value) -> Result<String, AssembleError> {
    let canonical = serde_json::json!({
        "id": string_field(item, "id")?,
        "type": string_field(item, "type")?,
        "call_id": item.get("call_id").and_then(Value::as_str).unwrap_or(""),
        "name": item.get("name").and_then(Value::as_str).unwrap_or(""),
        "namespace": item.get("namespace").and_then(Value::as_str).unwrap_or(""),
        "role": item.get("role").and_then(Value::as_str).unwrap_or(""),
        "agent_name": agent_name(item).unwrap_or(""),
        "phase": item_phase(item).unwrap_or(""),
    });
    let encoded = serde_json::to_vec(&canonical)
        .map_err(|_| AssembleError::InvalidSse("item identity is not serializable".to_string()))?;
    Ok(body_sha256(&encoded))
}

fn output_index(payload: &Value) -> Result<usize, AssembleError> {
    payload
        .get("output_index")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| AssembleError::InvalidSse("event lacks a valid output_index".to_string()))
}

fn string_field(value: &Value, key: &'static str) -> Result<String, AssembleError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AssembleError::InvalidSse(format!("missing string field: {key}")))
}

fn agent_name(item: &Value) -> Option<&str> {
    item.pointer("/agent/agent_name")
        .and_then(Value::as_str)
        .or_else(|| item.get("agent_name").and_then(Value::as_str))
}

fn item_phase(item: &Value) -> Option<&str> {
    item.get("phase")
        .and_then(Value::as_str)
        .or_else(|| item.pointer("/agent/phase").and_then(Value::as_str))
}

fn is_root_final(item: &Value) -> bool {
    agent_name(item) == Some("/root") && item_phase(item) == Some("final_answer")
}

fn message_text(item: &Value) -> String {
    item.get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| match part.get("type").and_then(Value::as_str) {
            Some("output_text") | Some("text") => part.get("text").and_then(Value::as_str),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

pub fn parse_buffered_sse(bytes: &[u8]) -> Result<BufferedOutcome, AssembleError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| AssembleError::InvalidSse("stream is not UTF-8".to_string()))?;
    let mut assembler = UltraEventAssembler::default();
    let normalized = text.replace("\r\n", "\n");
    for frame in normalized.split("\n\n") {
        let mut event_name = String::new();
        let mut data_lines = Vec::new();
        for line in frame.lines() {
            if let Some(value) = line.strip_prefix("event:") {
                event_name = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("data:") {
                data_lines.push(value.trim_start());
            }
        }
        if data_lines.is_empty() {
            continue;
        }
        let data = data_lines.join("\n");
        if data.trim() == "[DONE]" {
            continue;
        }
        let payload: Value = serde_json::from_str(&data)
            .map_err(|error| AssembleError::InvalidSse(format!("invalid JSON event: {error}")))?;
        assembler.push(&event_name, payload)?;
    }
    assembler.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    const SECRET: &str =
        "ultra-sign-v1-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";

    fn signed_headers(body: &[u8], timestamp: u64) -> HeaderMap {
        let fingerprint = body_sha256(b"fingerprint-1");
        let values = sign_request(
            SECRET,
            body,
            timestamp,
            "user-1",
            "chat-1",
            "message-1",
            &fingerprint,
        )
        .unwrap();
        let mut headers = HeaderMap::new();
        for (name, value) in values {
            headers.insert(name, HeaderValue::from_str(&value).unwrap());
        }
        headers
    }

    #[test]
    fn signature_binds_exact_body_method_path_identity_and_version() {
        let body = br#"{"model":"gpt-5.6-sol","messages":[]}"#;
        let headers = signed_headers(body, 1_000);
        let origin = verify_request(SECRET, &headers, body, 1_020).unwrap();
        assert_eq!(
            origin.context_digest,
            derive_context_digest(SECRET, "user-1", "chat-1", "message-1").unwrap()
        );
        assert_eq!(origin.body_sha256, body_sha256(body));
        let header_dump = format!("{headers:?}");
        assert!(!header_dump.contains("user-1"));
        assert!(!header_dump.contains("chat-1"));
        assert_eq!(
            verify_request(
                SECRET,
                &headers,
                br#"{"messages":[],"model":"gpt-5.6-sol"}"#,
                1_020
            ),
            Err(AuthError::InvalidSignature)
        );
        assert_eq!(
            verify_request(SECRET, &headers, body, 2_000),
            Err(AuthError::Expired)
        );
    }

    #[test]
    fn separate_strong_key_format_is_required() {
        assert_eq!(
            validate_signing_secret("sk-bifrost-local-not-a-signing-secret"),
            Err(AuthError::WeakSecret)
        );
        assert_eq!(
            validate_signing_secret("ultra-sign-v1-short"),
            Err(AuthError::WeakSecret)
        );
        assert!(validate_signing_secret(SECRET).is_ok());
    }

    #[test]
    fn in_memory_state_dedupes_usage_call_ids_and_payload_drift() {
        let mut state = OpaqueRoundState::new(
            "fp".to_string(),
            vec![serde_json::json!({"type":"message"})],
        );
        assert!(state.cumulative_usage.observe(
            "round-1",
            &serde_json::json!({
                "prompt_tokens": 3,
                "completion_tokens": 5,
                "total_tokens": 8,
                "prompt_tokens_details": {
                    "cached_tokens": 2,
                    "cached_read_tokens": 2,
                    "cached_write_tokens": 1
                },
                "cost": 0.000123
            })
        ));
        assert_eq!(state.cumulative_usage.cached_input_tokens, 2);
        assert_eq!(state.cumulative_usage.cached_read_tokens, 2);
        assert_eq!(state.cumulative_usage.cached_write_tokens, 1);
        assert_eq!(state.cumulative_usage.cost_microusd, 123);
        assert!(!state.cumulative_usage.observe(
            "round-1",
            &serde_json::json!({"input_tokens": 30, "output_tokens": 50})
        ));
        let call = UltraToolCall {
            output_index: 0,
            item_id: "item-1".to_string(),
            call_id: "call-1".to_string(),
            name: "calendar_read".to_string(),
            namespace: None,
            registered_name: "calendar_read".to_string(),
            arguments: "{}".to_string(),
            agent_name: "/root".to_string(),
            payload_digest: "digest-1".to_string(),
        };
        state.add_unique_calls(&[call.clone()]).unwrap();
        assert_eq!(
            state.add_unique_calls(&[call.clone()]),
            Err(StateError::DuplicateCall("call-1".to_string()))
        );
        let mut drift = call;
        drift.payload_digest = "digest-2".to_string();
        assert_eq!(
            state.add_unique_calls(&[drift]),
            Err(StateError::PayloadDrift("call-1".to_string()))
        );
    }

    #[test]
    fn cumulative_usage_tracks_last_round_context_separately_from_summed_input() {
        let mut usage = CumulativeUsage::default();
        assert!(usage.observe(
            "round-0",
            &serde_json::json!({"input_tokens": 60_000, "output_tokens": 10})
        ));
        assert!(usage.observe(
            "round-1",
            &serde_json::json!({"input_tokens": 61_000, "output_tokens": 12})
        ));

        assert_eq!(usage.input_tokens, 121_000);
        assert_eq!(usage.last_round_input_tokens, 61_000);

        let chat_usage = usage.as_chat_usage();
        assert_eq!(chat_usage["prompt_tokens"], serde_json::json!(121_000));
        assert_eq!(chat_usage["context_tokens"], serde_json::json!(61_000));

        // Legacy serialized state without the field deserializes to 0 and
        // omits context_tokens from the chat usage payload.
        let legacy: CumulativeUsage = serde_json::from_str(
            r#"{"input_tokens":5,"output_tokens":1,"total_tokens":6,"cached_input_tokens":0,"cost_microusd":0}"#,
        )
        .unwrap();
        assert_eq!(legacy.last_round_input_tokens, 0);
        assert!(legacy.as_chat_usage().get("context_tokens").is_none());
    }

    #[test]
    fn dispatch_order_prevents_double_send_and_marks_started_expiry_ambiguous() {
        let mut batch = OrderedBatchAdmission::reserve_batch("batch-1", 2, 10).unwrap();
        assert_eq!(
            batch.reserve_call(0, "call-1", "digest-1"),
            Err(StateError::InvalidTransition(
                "stable response ID must be claimed before calls"
            ))
        );
        batch.claim_stable_response_id("resp-1").unwrap();
        assert_eq!(
            batch.reserve_call(1, "call-2", "digest-2"),
            Err(StateError::OutOfOrderCall)
        );
        batch.reserve_call(0, "call-1", "digest-1").unwrap();
        batch.reserve_call(1, "call-2", "digest-2").unwrap();
        batch.start_dispatch("call-1", 11).unwrap();
        assert_eq!(
            batch.start_dispatch("call-1", 12),
            Err(StateError::DuplicateDispatch("call-1".to_string()))
        );
        batch.expire();
        assert_eq!(batch.poll(), DispatchPoll::ExpiredAmbiguous);
    }

    #[test]
    fn legal_incremental_calls_are_buffered_and_child_text_never_projects() {
        let frames = [
            serde_json::json!({
                "type":"response.output_item.added",
                "output_index":0,
                "item":{"id":"child","type":"message","agent":{"agent_name":"/researcher"},"phase":"final_answer","content":[]}
            }),
            serde_json::json!({
                "type":"response.output_item.done",
                "output_index":0,
                "item":{"id":"child","type":"message","agent":{"agent_name":"/researcher"},"phase":"final_answer","content":[{"type":"output_text","text":"private"}]}
            }),
            serde_json::json!({
                "type":"response.output_item.added",
                "output_index":1,
                "item":{"id":"fc-1","type":"function_call","call_id":"call-1","name":"calendar_read","arguments":"","agent":{"agent_name":"/root"}}
            }),
            serde_json::json!({
                "type":"response.function_call_arguments.delta",
                "output_index":1,
                "item_id":"fc-1",
                "delta":"{\"day\":"
            }),
            serde_json::json!({
                "type":"response.function_call_arguments.delta",
                "output_index":1,
                "item_id":"fc-1",
                "delta":"\"today\"}"
            }),
            serde_json::json!({
                "type":"response.function_call_arguments.done",
                "output_index":1,
                "item_id":"fc-1",
                "arguments":"{\"day\":\"today\"}"
            }),
            serde_json::json!({
                "type":"response.output_item.done",
                "output_index":1,
                "item":{"id":"fc-1","type":"function_call","call_id":"call-1","name":"calendar_read","arguments":"{\"day\":\"today\"}","agent":{"agent_name":"/root"}}
            }),
            serde_json::json!({
                "type":"response.completed",
                "response":{
                    "id":"resp-1",
                    "usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12},
                    "output":[
                        {"id":"child","type":"message","agent":{"agent_name":"/researcher"},"phase":"final_answer","content":[{"type":"output_text","text":"private"}]},
                        {"id":"fc-1","type":"function_call","call_id":"call-1","name":"calendar_read","arguments":"{\"day\":\"today\"}","agent":{"agent_name":"/root"}}
                    ]
                }
            }),
        ];
        let wire = frames
            .iter()
            .map(|frame| {
                let event_type = frame.get("type").and_then(Value::as_str).unwrap();
                format!(
                    "event: {event_type}\ndata: {}\n\n",
                    serde_json::to_string(frame).unwrap()
                )
            })
            .collect::<String>();
        let BufferedOutcome::ToolBatch { calls, .. } = parse_buffered_sse(wire.as_bytes()).unwrap()
        else {
            panic!("expected tool batch");
        };
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].arguments, "{\"day\":\"today\"}");
    }

    #[test]
    fn only_root_final_answer_is_projected_after_terminal_completion() {
        let completed = serde_json::json!({
            "type":"response.completed",
            "response":{
                "id":"resp-2",
                "usage":{"input_tokens":4,"output_tokens":3,"total_tokens":7},
                "output":[
                    {"id":"m1","type":"message","agent":{"agent_name":"/worker"},"phase":"final_answer","content":[{"type":"output_text","text":"do not leak"}]},
                    {"id":"internal","type":"agent_message","content":[{"type":"output_text","text":"also private"}]},
                    {"id":"m2","type":"message","agent":{"agent_name":"/root"},"phase":"final_answer","content":[{"type":"output_text","text":"safe final"}]}
                ]
            }
        });
        let output = completed
            .pointer("/response/output")
            .and_then(Value::as_array)
            .unwrap();
        let mut wire = String::new();
        for (output_index, item) in output.iter().enumerate() {
            for event_type in ["response.output_item.added", "response.output_item.done"] {
                let event = serde_json::json!({
                    "type": event_type,
                    "output_index": output_index,
                    "item": item,
                });
                wire.push_str(&format!(
                    "event: {event_type}\ndata: {}\n\n",
                    serde_json::to_string(&event).unwrap()
                ));
            }
        }
        wire.push_str(&format!("event: response.completed\ndata: {completed}\n\n"));
        let BufferedOutcome::RootFinal { text, .. } = parse_buffered_sse(wire.as_bytes()).unwrap()
        else {
            panic!("expected root final");
        };
        assert_eq!(text, "safe final");
    }

    #[test]
    fn child_owned_function_calls_fail_closed() {
        assert!(matches!(
            UltraToolCall::from_item(
                0,
                &serde_json::json!({
                    "id": "fc-child",
                    "type": "function_call",
                    "call_id": "call-child",
                    "name": "calendar_read",
                    "arguments": "{}",
                    "agent": {"agent_name": "/root/researcher"},
                }),
            ),
            Err(AssembleError::InvalidSequence(_))
        ));
    }

    #[test]
    fn completed_usage_requires_nonnegative_consistent_token_counters() {
        fn completed_wire(usage: Option<Value>) -> String {
            let item = serde_json::json!({
                "id": "root-final",
                "type": "message",
                "agent": {"agent_name": "/root"},
                "phase": "final_answer",
                "content": [{"type": "output_text", "text": "safe"}],
            });
            let mut response = serde_json::json!({
                "id": "resp-usage",
                "status": "completed",
                "output": [item.clone()],
            });
            if let Some(usage) = usage {
                response["usage"] = usage;
            }
            [
                serde_json::json!({
                    "type": "response.output_item.added",
                    "output_index": 0,
                    "item": item.clone(),
                }),
                serde_json::json!({
                    "type": "response.output_item.done",
                    "output_index": 0,
                    "item": item,
                }),
                serde_json::json!({"type": "response.completed", "response": response}),
            ]
            .iter()
            .map(|event| {
                let event_type = event.get("type").and_then(Value::as_str).unwrap();
                format!("event: {event_type}\ndata: {event}\n\n")
            })
            .collect()
        }

        let invalid = [
            None,
            Some(Value::Null),
            Some(serde_json::json!({"input_tokens":1,"output_tokens":2})),
            Some(serde_json::json!({"input_tokens":-1,"output_tokens":2,"total_tokens":1})),
            Some(serde_json::json!({"input_tokens":1.5,"output_tokens":2,"total_tokens":4})),
            Some(serde_json::json!({"input_tokens":"1","output_tokens":2,"total_tokens":3})),
            Some(serde_json::json!({"input_tokens":2,"output_tokens":2,"total_tokens":3})),
        ];
        for usage in invalid {
            assert!(matches!(
                parse_buffered_sse(completed_wire(usage).as_bytes()),
                Err(AssembleError::InvalidSse(_))
            ));
        }
        assert!(matches!(
            parse_buffered_sse(
                completed_wire(Some(
                    serde_json::json!({"input_tokens":1,"output_tokens":2,"total_tokens":3})
                ))
                .as_bytes()
            ),
            Ok(BufferedOutcome::RootFinal { .. })
        ));
    }

    #[test]
    fn tool_snapshot_binding_preserves_namespaces_and_rejects_ambiguous_or_scalar_args() {
        let mut namespaced = UltraToolCall::from_item(
            2,
            &serde_json::json!({
                "id": "fc-ns",
                "type": "function_call",
                "call_id": "call-ns",
                "namespace": "glean",
                "name": "search",
                "arguments": "{\"query\":\"rust\"}",
                "agent": {"agent_name": "/root"},
            }),
        )
        .unwrap();
        let snapshot = serde_json::json!([
            {
                "type": "namespace",
                "name": "glean",
                "tools": [{"type": "function", "name": "search"}]
            },
            {"type": "function", "name": "skills_read"},
            {"type": "tool_search"}
        ]);
        namespaced.bind_to_tool_snapshot(&snapshot).unwrap();
        assert_eq!(namespaced.namespace.as_deref(), Some("glean"));
        assert_eq!(namespaced.name, "search");
        assert_eq!(namespaced.registered_name, "glean_search");

        let mut core = UltraToolCall::from_item(
            0,
            &serde_json::json!({
                "id": "fc-core",
                "type": "function_call",
                "call_id": "call-core",
                "name": "skills_read",
                "arguments": "{}",
                "agent": {"agent_name": "/root"},
            }),
        )
        .unwrap();
        core.bind_to_tool_snapshot(&snapshot).unwrap();
        assert_eq!(core.registered_name, "skills_read");

        let ambiguous = serde_json::json!([
            {"type": "namespace", "name": "glean", "tools": [{"type": "function", "name": "search"}]},
            {"type": "namespace", "name": "glean", "tools": [{"type": "function", "name": "search"}]}
        ]);
        assert!(matches!(
            namespaced.bind_to_tool_snapshot(&ambiguous),
            Err(AssembleError::InvalidSequence(_))
        ));
        assert_eq!(
            UltraToolCall::from_item(
                0,
                &serde_json::json!({
                    "id":"fc-array", "call_id":"call-array", "name":"read",
                    "arguments":"[]", "agent":{"agent_name":"/root"}
                })
            ),
            Err(AssembleError::InvalidFunctionArguments(
                "call-array".to_string()
            ))
        );
    }

    #[test]
    fn duplicate_or_empty_root_finals_and_private_protocol_drift_fail_closed() {
        fn completed_wire(output: Vec<Value>) -> String {
            let mut wire = String::new();
            for (output_index, item) in output.iter().enumerate() {
                for event_type in ["response.output_item.added", "response.output_item.done"] {
                    wire.push_str(&format!(
                        "event: {event_type}\ndata: {}\n\n",
                        serde_json::to_string(&serde_json::json!({
                            "type": event_type,
                            "output_index": output_index,
                            "item": item,
                        }))
                        .unwrap()
                    ));
                }
            }
            wire.push_str(&format!(
                "event: response.completed\ndata: {}\n\n",
                serde_json::to_string(&serde_json::json!({
                    "type": "response.completed",
                    "response": {
                        "id": "resp",
                        "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
                        "output": output
                    },
                }))
                .unwrap()
            ));
            wire
        }

        let root = |id: &str, text: &str| {
            serde_json::json!({
                "id": id,
                "type": "message",
                "phase": "final_answer",
                "agent": {"agent_name": "/root"},
                "content": [{"type": "output_text", "text": text}],
            })
        };
        assert!(matches!(
            parse_buffered_sse(completed_wire(vec![root("a", "one"), root("b", "two")]).as_bytes()),
            Err(AssembleError::InvalidSequence(_))
        ));
        assert_eq!(
            parse_buffered_sse(completed_wire(vec![root("empty", "  ")]).as_bytes()),
            Err(AssembleError::MissingRootFinal)
        );
        assert!(matches!(
            parse_buffered_sse(
                b"event: response.private_payload.delta\ndata: {\"type\":\"response.private_payload.delta\"}\n\n"
            ),
            Err(AssembleError::InvalidSequence(_))
        ));

        let unknown_item = serde_json::json!({"id": "unknown", "type": "secret_payload"});
        assert!(matches!(
            parse_buffered_sse(completed_wire(vec![unknown_item]).as_bytes()),
            Err(AssembleError::InvalidSequence(_))
        ));
        let invalid_provenance = serde_json::json!({
            "id": "fc",
            "type": "function_call",
            "call_id": "call",
            "name": "read",
            "arguments": "{}",
            "agent": {"agent_name": "/worker"},
        });
        assert!(matches!(
            parse_buffered_sse(completed_wire(vec![invalid_provenance]).as_bytes()),
            Err(AssembleError::InvalidSequence(_))
        ));

        let terminal = root("mismatch", "safe");
        let added = serde_json::json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": terminal,
        });
        let drifted = root("mismatch", "changed");
        let done = serde_json::json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": drifted,
        });
        let completed = serde_json::json!({
            "type": "response.completed",
            "response": {
                "id": "resp",
                "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
                "output": [terminal]
            },
        });
        let wire = [added, done, completed]
            .iter()
            .map(|event| {
                let event_type = event.get("type").and_then(Value::as_str).unwrap();
                format!(
                    "event: {event_type}\ndata: {}\n\n",
                    serde_json::to_string(event).unwrap()
                )
            })
            .collect::<String>();
        assert!(matches!(
            parse_buffered_sse(wire.as_bytes()),
            Err(AssembleError::InvalidSequence(_))
        ));
    }
    #[test]
    fn sse_labels_response_identity_status_and_item_identity_cannot_drift() {
        let mut label = UltraEventAssembler::default();
        assert!(matches!(
            label.push(
                "response.created",
                serde_json::json!({"type": "response.in_progress"})
            ),
            Err(AssembleError::InvalidSequence(_))
        ));

        let mut missing_label = UltraEventAssembler::default();
        assert!(matches!(
            missing_label.push("", serde_json::json!({"type": "response.created"})),
            Err(AssembleError::InvalidSse(_))
        ));

        let mut identity = UltraEventAssembler::default();
        identity
            .push(
                "response.created",
                serde_json::json!({
                    "type": "response.created",
                    "response": {"id": "resp-a", "status": "in_progress"}
                }),
            )
            .unwrap();
        assert!(matches!(
            identity.push(
                "response.output_text.delta",
                serde_json::json!({
                    "type": "response.output_text.delta",
                    "response_id": "resp-b",
                    "delta": "private"
                }),
            ),
            Err(AssembleError::InvalidSequence(_))
        ));

        let mut status = UltraEventAssembler::default();
        assert!(matches!(
            status.push(
                "response.completed",
                serde_json::json!({
                    "type": "response.completed",
                    "response": {"id": "resp", "status": "in_progress", "output": []}
                }),
            ),
            Err(AssembleError::InvalidSequence(_))
        ));

        let mut item_identity = UltraEventAssembler::default();
        item_identity
            .push(
                "response.output_item.added",
                serde_json::json!({
                    "type": "response.output_item.added",
                    "output_index": 0,
                    "item": {
                        "id": "fc",
                        "type": "function_call",
                        "call_id": "call",
                        "namespace": "safe",
                        "name": "read",
                        "arguments": "",
                        "agent": {"agent_name": "/root"}
                    }
                }),
            )
            .unwrap();
        assert!(matches!(
            item_identity.push(
                "response.output_item.done",
                serde_json::json!({
                    "type": "response.output_item.done",
                    "output_index": 0,
                    "item": {
                        "id": "fc",
                        "type": "function_call",
                        "call_id": "call",
                        "namespace": "unsafe",
                        "name": "read",
                        "arguments": "{}",
                        "agent": {"agent_name": "/root"}
                    }
                }),
            ),
            Err(AssembleError::InvalidSequence(_))
        ));
    }

    #[test]
    fn illegal_argument_delta_sequence_fails_closed() {
        let wire = concat!(
            "event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"item_id\":\"fc\",\"delta\":\"{}\"}\n\n",
            "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"output\":[]}}\n\n"
        );
        assert!(matches!(
            parse_buffered_sse(wire.as_bytes()),
            Err(AssembleError::InvalidSequence(_))
        ));
    }
}
