use super::*;
use chrono::Utc;

pub const DEFAULT_MCP_TOOL_RESULT_MAX_CHARS: usize = 4_000;
pub const DEFAULT_AGENT_VM_TOOL_RESULT_MAX_CHARS: usize = 50_000;
const DEFAULT_OVERFLOW_WRITE_CHUNK_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverflowArtifact {
    pub char_count: usize,
    pub format: &'static str,
    pub path: String,
}

impl OverflowArtifact {
    pub fn pointer_payload(&self, tool_name: &str, vm_id: &str) -> Value {
        json!({
            "overflow_file": true,
            "tool_name": tool_name,
            "char_count": self.char_count,
            "vm_id": vm_id,
            "path": self.path,
            "format": self.format,
            "read_hint": overflow_read_hint(self.format),
        })
    }
}

pub fn build_overflow_artifact(tool_name: &str, rendered: &str) -> OverflowArtifact {
    let format = detect_tool_result_format(rendered);
    let timestamp = Utc::now().format("%Y-%m-%dT%H-%M-%SZ");
    let safe_tool = safe_path_component(tool_name);
    let digest = format!("{:x}", md5::compute(rendered.as_bytes()));
    OverflowArtifact {
        char_count: rendered.chars().count(),
        format,
        path: format!(
            "/work/.mcp-overflow/{timestamp}-{safe_tool}-{}.{}",
            &digest[..8],
            format
        ),
    }
}

pub fn render_tool_result_text(value: &Value) -> Result<String> {
    Ok(match value {
        Value::String(text) => text.clone(),
        // Compact, matching success_text: this text lands in model context
        // (directly or via overflow chunks), so indentation is pure cost.
        _ => serde_json::to_string(value)?,
    })
}

pub fn extract_single_text_tool_response_text(value: &Value) -> Option<&str> {
    let content = value.get("content")?.as_array()?;
    if content.len() != 1 {
        return None;
    }
    let item = content.first()?;
    (item.get("type").and_then(Value::as_str) == Some("text"))
        .then(|| item.get("text").and_then(Value::as_str))
        .flatten()
}

pub fn detect_tool_result_format(rendered: &str) -> &'static str {
    if serde_json::from_str::<Value>(rendered).is_ok() {
        "json"
    } else {
        "txt"
    }
}

pub fn overflow_max_chars_from_env(env_var: &str, default: usize) -> usize {
    env::var(env_var)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

pub fn overflow_enabled_from_env(env_var: &str, default: bool) -> bool {
    env::var(env_var)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .map(|value| !matches!(value.as_str(), "0" | "false" | "no" | "off"))
        .unwrap_or(default)
}

pub fn overflow_write_chunk_bytes() -> usize {
    overflow_max_chars_from_env(
        "MCP_OVERFLOW_WRITE_CHUNK_BYTES",
        DEFAULT_OVERFLOW_WRITE_CHUNK_BYTES,
    )
}

pub fn overflow_read_hint(format: &str) -> &'static str {
    if format == "json" {
        "This MCP result was too large to inline. Do not dump the raw overflow file. Inspect it with grep_file for targeted term lookups, read_fragment for exact slices, or very small jq slices, keep any single inline extract under 2,000 chars, and if you need more detail write a reduced artifact to disk before reading it back. For JSON inspection, bash with jq is available in Agent VM."
    } else {
        "This MCP result was too large to inline. Do not dump the raw overflow file. Inspect it with grep_file for targeted term lookups, read_fragment for exact slices, or very small jq slices, keep any single inline extract under 2,000 chars, and if you need more detail write a reduced artifact to disk before reading it back."
    }
}

pub fn utf8_chunks<'a>(text: &'a str, max_bytes: usize) -> Vec<&'a str> {
    if text.is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let remaining = &text[start..];
        if remaining.len() <= max_bytes {
            chunks.push(remaining);
            break;
        }

        let mut end = 0;
        for (idx, ch) in remaining.char_indices() {
            let next = idx + ch.len_utf8();
            if next > max_bytes {
                break;
            }
            end = next;
        }

        if end == 0 {
            end = remaining
                .chars()
                .next()
                .map(|ch| ch.len_utf8())
                .unwrap_or(remaining.len());
        }

        chunks.push(&remaining[..end]);
        start += end;
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EnvGuard {
        previous: Vec<(String, Option<String>)>,
    }

    impl EnvGuard {
        fn set(entries: &[(&str, Option<&str>)]) -> Self {
            let mut previous = Vec::new();
            for (key, value) in entries {
                previous.push(((*key).to_string(), std::env::var(key).ok()));
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
            Self { previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in self.previous.drain(..) {
                match value {
                    Some(value) => std::env::set_var(&key, value),
                    None => std::env::remove_var(&key),
                }
            }
        }
    }

    #[test]
    fn build_overflow_artifact_preserves_existing_pointer_shape() {
        let artifact = build_overflow_artifact("demo_echo", "{\"ok\":true}");
        let pointer = artifact.pointer_payload("demo_echo", "vm-1");
        assert_eq!(pointer["overflow_file"], json!(true));
        assert_eq!(pointer["tool_name"], json!("demo_echo"));
        assert_eq!(pointer["vm_id"], json!("vm-1"));
        assert_eq!(pointer["format"], json!("json"));
        assert!(pointer["path"]
            .as_str()
            .unwrap()
            .starts_with("/work/.mcp-overflow/"));
        assert!(pointer["read_hint"]
            .as_str()
            .unwrap()
            .contains("Do not dump the raw overflow file"));
    }

    #[test]
    fn render_and_extract_text_helpers_match_expected_payload_shapes() {
        let success = success_text(json!({"ok": true})).unwrap();
        let rendered = render_tool_result_text(&json!({"ok": true})).unwrap();
        // Round-trip instead of pinning serialization style (compact today).
        assert_eq!(
            serde_json::from_str::<Value>(&rendered).unwrap(),
            json!({"ok": true})
        );
        assert_eq!(
            serde_json::from_str::<Value>(
                extract_single_text_tool_response_text(&success).unwrap()
            )
            .unwrap(),
            json!({"ok": true})
        );

        let image_payload = json!({
            "content": [
                { "type": "image", "data": "abc", "mimeType": "image/png" },
                { "type": "text", "text": "{\"ok\":true}" }
            ],
            "structuredContent": Value::Null,
            "isError": false,
        });
        assert!(extract_single_text_tool_response_text(&image_payload).is_none());
    }

    #[test]
    fn utf8_chunks_preserves_utf8_boundaries() {
        let chunks = utf8_chunks("a😀bc", 5);
        assert_eq!(chunks, vec!["a😀", "bc"]);
    }

    #[test]
    fn utf8_chunks_handles_single_multibyte_char_larger_than_limit() {
        let chunks = utf8_chunks("😀", 1);
        assert_eq!(chunks, vec!["😀"]);
    }

    #[test]
    fn overflow_max_chars_reads_env_override() {
        let _lock = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let _env = EnvGuard::set(&[("EXAMPLE_MAX", None)]);
        assert_eq!(overflow_max_chars_from_env("EXAMPLE_MAX", 123), 123);

        let _env = EnvGuard::set(&[("EXAMPLE_MAX", Some("4321"))]);
        assert_eq!(overflow_max_chars_from_env("EXAMPLE_MAX", 123), 4321);
    }

    #[test]
    fn overflow_enabled_defaults_and_honors_env_override() {
        let _lock = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let _env = EnvGuard::set(&[("EXAMPLE_ENABLED", None)]);
        assert!(overflow_enabled_from_env("EXAMPLE_ENABLED", true));
        assert!(!overflow_enabled_from_env("EXAMPLE_ENABLED", false));

        let _env = EnvGuard::set(&[("EXAMPLE_ENABLED", Some("false"))]);
        assert!(!overflow_enabled_from_env("EXAMPLE_ENABLED", true));
    }
}
