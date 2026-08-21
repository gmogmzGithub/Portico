#[rustfmt::skip]
use super::*;
use crate::native::TEST_ENV_LOCK;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::sync::MutexGuard;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

struct TestRoot {
    _guard: MutexGuard<'static, ()>,
    path: PathBuf,
    previous_cwd: PathBuf,
    previous_container_root: Option<String>,
    previous_host_root: Option<String>,
    previous_electron_api_base: Option<String>,
    previous_test_redis: Option<String>,
}

impl TestRoot {
    fn new(name: &str) -> Self {
        let guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        reset_test_redis_state();
        let path = env::temp_dir().join(format!(
            "core-mcp-rust-skills-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(path.join("mcp-configs")).expect("create mcp-configs dir");
        fs::create_dir_all(path.join("mcp-configs-user")).expect("create mcp-configs-user dir");
        fs::create_dir_all(path.join("skills")).expect("create skills dir");
        fs::create_dir_all(path.join("skills-user")).expect("create skills-user dir");
        fs::create_dir_all(path.join("skills-marketplace")).expect("create skills-marketplace dir");
        let path = fs::canonicalize(&path).expect("canonicalize test root");
        let previous_cwd = env::current_dir().expect("get current dir");
        env::set_current_dir(&path).expect("set current dir");

        let previous_container_root = env::var("CONTAINER_PROJECT_ROOT").ok();
        let previous_host_root = env::var("HOST_PROJECT_ROOT").ok();
        let previous_electron_api_base = env::var("ELECTRON_API_BASE").ok();
        let previous_test_redis = env::var("CORE_MCP_TEST_REDIS").ok();
        env::set_var("CONTAINER_PROJECT_ROOT", &path);
        env::set_var("HOST_PROJECT_ROOT", &path);
        env::set_var("CORE_MCP_TEST_REDIS", "memory");

        Self {
            _guard: guard,
            path,
            previous_cwd,
            previous_container_root,
            previous_host_root,
            previous_electron_api_base,
            previous_test_redis,
        }
    }

    fn write_skill(&self, source_dir: &str, skill_path: &str, markdown: &str) -> PathBuf {
        let skill_dir = self.path.join(source_dir).join(skill_path);
        fs::create_dir_all(&skill_dir).expect("create skill dir");
        let skill_md = skill_dir.join("SKILL.md");
        fs::write(&skill_md, markdown).expect("write skill");
        skill_md
    }

    fn write_relative(&self, root: &str, relative: &str, contents: &str) -> PathBuf {
        let path = self.path.join(root).join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(&path, contents).expect("write file");
        path
    }

    fn write_toggles(&self, toggles: &Value) {
        fs::write(
            self.path.join("mcp_toggles.json"),
            serde_json::to_string_pretty(toggles).expect("encode toggles"),
        )
        .expect("write toggles");
    }

    fn set_electron_base(&self, base: &str) {
        env::set_var("ELECTRON_API_BASE", base);
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = env::set_current_dir(&self.previous_cwd);
        reset_test_redis_state();
        if let Some(value) = &self.previous_container_root {
            env::set_var("CONTAINER_PROJECT_ROOT", value);
        } else {
            env::remove_var("CONTAINER_PROJECT_ROOT");
        }
        if let Some(value) = &self.previous_host_root {
            env::set_var("HOST_PROJECT_ROOT", value);
        } else {
            env::remove_var("HOST_PROJECT_ROOT");
        }
        if let Some(value) = &self.previous_electron_api_base {
            env::set_var("ELECTRON_API_BASE", value);
        } else {
            env::remove_var("ELECTRON_API_BASE");
        }
        if let Some(value) = &self.previous_test_redis {
            env::set_var("CORE_MCP_TEST_REDIS", value);
        } else {
            env::remove_var("CORE_MCP_TEST_REDIS");
        }
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[derive(Clone)]
struct MockReply {
    status: &'static str,
    body: Value,
}

#[derive(Debug)]
struct CapturedRequest {
    method: String,
    path: String,
    body: String,
}

fn read_http_chunk(stream: &mut std::net::TcpStream, chunk: &mut [u8]) -> usize {
    let started = Instant::now();
    loop {
        match stream.read(chunk) {
            Ok(read) => return read,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    started.elapsed() < Duration::from_secs(5),
                    "timed out waiting for request bytes"
                );
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => panic!("read request: {error}"),
        }
    }
}

fn read_http_request(stream: &mut std::net::TcpStream) -> CapturedRequest {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    let header_end;
    loop {
        let read = read_http_chunk(stream, &mut chunk);
        assert!(read > 0, "client closed before headers");
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
    }

    let header_text = String::from_utf8(buffer[..header_end].to_vec()).expect("header utf8");
    let request_line = header_text
        .split("\r\n")
        .find(|line| !line.is_empty())
        .expect("missing request line");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let content_length = header_text
        .split("\r\n")
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if !name.eq_ignore_ascii_case("content-length") {
                return None;
            }
            value.trim().parse::<usize>().ok()
        })
        .unwrap_or(0);

    let mut body_bytes = buffer[header_end..].to_vec();
    while body_bytes.len() < content_length {
        let read = read_http_chunk(stream, &mut chunk);
        if read == 0 {
            break;
        }
        body_bytes.extend_from_slice(&chunk[..read]);
    }
    body_bytes.truncate(content_length);

    CapturedRequest {
        method,
        path,
        body: String::from_utf8(body_bytes).expect("body utf8"),
    }
}

fn serve_responses(replies: Vec<MockReply>) -> (String, mpsc::Receiver<CapturedRequest>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    listener
        .set_nonblocking(true)
        .expect("set listener nonblocking");
    let base = format!("http://{}", listener.local_addr().expect("listener addr"));
    let (tx, rx) = mpsc::channel();
    let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
    thread::spawn(move || {
        let mut fallback_reply = replies.lock().expect("lock replies").back().cloned();
        let mut exhausted_at: Option<Instant> = None;
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let reply = {
                        let mut lock = replies.lock().expect("lock replies");
                        if let Some(reply) = lock.pop_front() {
                            fallback_reply = Some(reply.clone());
                            if lock.is_empty() {
                                exhausted_at = Some(Instant::now());
                            }
                            reply
                        } else if let Some(reply) = fallback_reply.clone() {
                            reply
                        } else {
                            return;
                        }
                    };
                    let request = read_http_request(&mut stream);
                    let _ = tx.send(request);
                    let body = serde_json::to_vec(&reply.body).expect("encode reply");
                    let response = format!(
                        "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        reply.status,
                        body.len()
                    );
                    stream
                        .write_all(response.as_bytes())
                        .and_then(|_| stream.write_all(&body))
                        .expect("write response");
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if let Some(started_at) = exhausted_at {
                        if started_at.elapsed() >= Duration::from_millis(250) {
                            return;
                        }
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("accept request: {error}"),
            }
        }
    });
    (base, rx)
}

fn serve_delayed_responses(
    replies: Vec<(u64, MockReply)>,
) -> (String, mpsc::Receiver<CapturedRequest>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    listener
        .set_nonblocking(true)
        .expect("set listener nonblocking");
    let base = format!("http://{}", listener.local_addr().expect("listener addr"));
    let (tx, rx) = mpsc::channel();
    let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
    thread::spawn(move || {
        let mut fallback_reply = replies.lock().expect("lock replies").back().cloned();
        let mut exhausted_at: Option<Instant> = None;
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let (delay_ms, reply) = {
                        let mut lock = replies.lock().expect("lock replies");
                        if let Some(reply) = lock.pop_front() {
                            fallback_reply = Some(reply.clone());
                            if lock.is_empty() {
                                exhausted_at = Some(Instant::now());
                            }
                            reply
                        } else if let Some(reply) = fallback_reply.clone() {
                            reply
                        } else {
                            return;
                        }
                    };
                    let request = read_http_request(&mut stream);
                    let _ = tx.send(request);
                    let body = serde_json::to_vec(&reply.body).expect("encode reply");
                    thread::sleep(Duration::from_millis(delay_ms));
                    let response = format!(
                        "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        reply.status,
                        body.len()
                    );
                    stream
                        .write_all(response.as_bytes())
                        .and_then(|_| stream.write_all(&body))
                        .expect("write response");
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if let Some(started_at) = exhausted_at {
                        if started_at.elapsed() >= Duration::from_millis(250) {
                            return;
                        }
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("accept request: {error}"),
            }
        }
    });
    (base, rx)
}

fn response_payload(response: Value) -> Value {
    serde_json::from_str(
        response["content"][0]["text"]
            .as_str()
            .expect("missing response text"),
    )
    .expect("invalid JSON payload")
}

fn args(entries: &[(&str, Value)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

fn skill_chat_args(skill_name: &str, chat_id: &str) -> Map<String, Value> {
    args(&[
        ("skill_name", json!(skill_name)),
        ("chat_id", json!(chat_id)),
    ])
}

fn redis_string_list(key: &str) -> Vec<String> {
    serde_json::from_str(&redis_get_string(key).unwrap().unwrap()).unwrap()
}

fn skill_markdown(name: &str, description: &str, required_mcp_servers: &[&str]) -> String {
    let required = if required_mcp_servers.is_empty() {
        "required_mcp_servers: []".to_string()
    } else {
        format!(
            "required_mcp_servers:\n{}",
            required_mcp_servers
                .iter()
                .map(|server| format!("  - {server}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };

    format!(
        "\
---
name: {name}
description: {description}
license: MIT
compatibility: rust
{required}
metadata:
  priority: high
  triggers:
    - use me
  version: 1.0.0
  author: Test Suite
---
# {name}

Body for {name}.
"
    )
}

macro_rules! call {
    ($handler:ident, $arguments:expr) => {{
        let arguments = $arguments;
        response_payload($handler(&arguments).await.unwrap())
    }};
}

#[test]
fn discovers_skills_and_validates_paths() {
    let root = TestRoot::new("discover");
    let system_md = root.write_skill(
        "skills",
        "writer",
        &skill_markdown("Writer", "System writer", &["server:web-tools"]),
    );
    root.write_relative("skills", "writer/references/guide.md", "guide");
    root.write_relative("skills", "writer/references/nested/tips.txt", "tips");
    root.write_relative("skills", "writer/references/queries.sql", "SELECT 1;");
    root.write_relative("skills", "writer/reference/sdk.md", "singular layout");
    root.write_relative("skills", "writer/scripts/run.py", "print('run')");
    root.write_skill(
        "skills-user",
        "writer",
        &skill_markdown("Writer", "User duplicate", &["server:time"]),
    );
    root.write_skill(
        "skills-marketplace",
        "acme/analyst",
        &skill_markdown("Analyst", "Marketplace analyst", &[]),
    );
    root.write_skill(
        "skills",
        ".hidden",
        &skill_markdown("Hidden", "Should not load", &[]),
    );
    root.write_relative("skills", "broken/SKILL.md", "not frontmatter");

    let (frontmatter, body) = split_frontmatter(&skill_markdown("Split", "desc", &[]));
    assert!(frontmatter.is_some());
    assert!(body.contains("Body for Split"));
    let (frontmatter, body) = split_frontmatter("plain body");
    assert!(frontmatter.is_none());
    assert_eq!(body, "plain body");

    assert_eq!(
        derive_skill_name(&root.path.join("skills"), &system_md, "system").as_deref(),
        Some("writer")
    );
    assert_eq!(
        derive_skill_name(
            &root.path.join("skills-marketplace"),
            &root.path.join("skills-marketplace/acme/analyst/SKILL.md"),
            "marketplace"
        )
        .as_deref(),
        Some("acme/analyst")
    );
    assert!(derive_skill_name(
        &root.path.join("skills"),
        &root.path.join("skills/.hidden/SKILL.md"),
        "system"
    )
    .is_none());

    let parsed = parse_skill_file(&system_md, "system", "writer")
        .unwrap()
        .expect("parsed skill");
    assert_eq!(parsed.name, "writer");
    assert_eq!(
        parsed.references,
        vec![
            "reference/sdk.md",
            "references/guide.md",
            "references/nested/tips.txt",
            "references/queries.sql"
        ]
    );
    assert_eq!(parsed.scripts, vec!["scripts/run.py"]);
    assert_eq!(parsed.required_mcp_servers, vec!["server:web-tools"]);

    let discovered = discover_skills().unwrap();
    let names = discovered
        .iter()
        .map(|skill| skill.name.clone())
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["writer", "acme/analyst"]);
    assert_eq!(find_skill("writer").unwrap().unwrap().source, "system");
    assert_eq!(
        get_skill_required_servers("writer").unwrap(),
        vec!["server:web-tools".to_string()]
    );
    assert!(find_skill("missing-skill").unwrap().is_none());

    assert!(validate_skill_path("", None).is_err());
    assert!(validate_skill_path("writer", Some("../escape.md")).is_err());
    assert!(validate_skill_path("writer", Some("/absolute")).is_err());
    assert_eq!(
        validate_skill_path("writer", Some("references/guide.md")).unwrap(),
        root.path.join("skills-user/writer/references/guide.md")
    );

    let json = parsed.to_json(true);
    assert_eq!(json["name"], json!("writer"));
    assert_eq!(json["source"], json!("system"));
    assert!(json["content"]
        .as_str()
        .unwrap()
        .contains("Body for Writer"));
    assert!(read_skill_markdown(&parsed)
        .unwrap()
        .contains("Body for Writer"));
}

#[tokio::test]
async fn skill_handlers_cover_crud_and_lookup_branches() {
    let root = TestRoot::new("handlers");
    root.write_skill(
        "skills",
        "system-skill",
        &skill_markdown("System Skill", "System provided", &["server:web-tools"]),
    );

    let listed = call!(
        handle_list_skills,
        args(&[
            ("include_content", json!(true)),
            ("filter_source", json!("all"))
        ])
    );
    assert_eq!(listed["success"], json!(true));
    assert_eq!(listed["total"], json!(1));
    assert_eq!(listed["skills"][0]["name"], json!("system-skill"));
    assert!(listed["skills"][0]["content"]
        .as_str()
        .unwrap()
        .contains("Body for System Skill"));

    let filtered = call!(
        handle_list_skills,
        args(&[("filter_source", json!("user"))])
    );
    assert_eq!(filtered["total"], json!(0));

    let missing_read = call!(
        handle_read_skill,
        args(&[("skill_name", json!("missing-skill"))])
    );
    assert_eq!(missing_read["success"], json!(false));

    let missing_update = call!(
        handle_update_skill,
        args(&[
            ("skill_name", json!("missing-skill")),
            ("skill_content", json!("new"))
        ])
    );
    assert_eq!(missing_update["success"], json!(false));

    let blocked_create = call!(
        handle_create_skill,
        args(&[
            ("skill_name", json!("system-skill")),
            ("skill_content", json!("body"))
        ])
    );
    assert_eq!(blocked_create["success"], json!(false));

    root.write_skill(
        "skills-user",
        "user-skill",
        &skill_markdown("User Skill", "User provided", &["server:subagents"]).replace(
            "author: Test Suite\n",
            "author: Test Suite\ncreated_by_email: creator@example.com\n",
        ),
    );

    let duplicate_create = call!(
        handle_create_skill,
        args(&[
            ("skill_name", json!("user-skill")),
            ("skill_content", json!("body"))
        ])
    );
    assert_eq!(duplicate_create["success"], json!(false));
    assert_eq!(duplicate_create["code"], json!("skill_already_exists"));
    assert_eq!(
        duplicate_create["remediation"],
        json!("Choose a unique skill name.")
    );

    let user_list = call!(
        handle_list_skills,
        args(&[("filter_source", json!("user"))])
    );
    assert_eq!(user_list["total"], json!(1));
    assert_eq!(
        user_list["skills"][0]["created_by_email"],
        json!("creator@example.com")
    );

    let read = call!(
        handle_read_skill,
        args(&[("skill_name", json!("user-skill"))])
    );
    assert_eq!(read["success"], json!(true));
    assert_eq!(read["metadata"]["name"], json!("user-skill"));
    assert_eq!(
        read["metadata"]["created_by_email"],
        json!("creator@example.com")
    );
    assert!(read["content"]
        .as_str()
        .unwrap()
        .contains("Body for User Skill"));

    let created_reference = call!(
        handle_create_skill_reference,
        args(&[
            ("skill_name", json!("user-skill")),
            ("reference_path", json!("guide.md")),
            ("content", json!("reference one"))
        ])
    );
    assert_eq!(created_reference["success"], json!(true));
    assert_eq!(
        created_reference["reference_path"],
        json!("references/guide.md")
    );
    let missing_skill_reference_create = call!(
        handle_create_skill_reference,
        args(&[
            ("skill_name", json!("missing-skill")),
            ("reference_path", json!("guide.md")),
            ("content", json!("reference"))
        ])
    );
    assert_eq!(missing_skill_reference_create["success"], json!(false));
    assert_eq!(
        missing_skill_reference_create["error"],
        json!("Skill 'missing-skill' not found in skills-user")
    );

    let updated_reference = call!(
        handle_update_skill_reference,
        args(&[
            ("skill_name", json!("user-skill")),
            ("reference_path", json!("guide.md")),
            ("content", json!("reference two"))
        ])
    );
    assert_eq!(updated_reference["success"], json!(true));
    assert_eq!(
        fs::read_to_string(root.path.join("skills-user/user-skill/references/guide.md")).unwrap(),
        "reference two"
    );

    let missing_reference = call!(
        handle_update_skill_reference,
        args(&[
            ("skill_name", json!("user-skill")),
            ("reference_path", json!("missing.md")),
            ("content", json!("unused"))
        ])
    );
    assert_eq!(missing_reference["success"], json!(false));

    let fetched_reference = call!(
        handle_get_skill_reference,
        args(&[
            ("skill_name", json!("user-skill")),
            ("reference_path", json!("guide.md"))
        ])
    );
    assert_eq!(fetched_reference["success"], json!(true));
    assert_eq!(fetched_reference["reference_path"], json!("guide.md"));
    assert_eq!(fetched_reference["content"], json!("reference two"));

    let missing_reference_lookup = call!(
        handle_get_skill_reference,
        args(&[
            ("skill_name", json!("user-skill")),
            ("reference_path", json!("missing.md"))
        ])
    );
    assert_eq!(missing_reference_lookup["success"], json!(false));
    assert_eq!(
        missing_reference_lookup["error"],
        json!("Reference not found: missing.md")
    );

    let invalid_script = call!(
        handle_create_skill_script,
        args(&[
            ("skill_name", json!("user-skill")),
            ("script_path", json!("not-python.txt")),
            ("content", json!("echo nope"))
        ])
    );
    assert_eq!(invalid_script["success"], json!(false));

    let created_script = call!(
        handle_create_skill_script,
        args(&[
            ("skill_name", json!("user-skill")),
            ("script_path", json!("runner.py")),
            ("content", json!("print(1)"))
        ])
    );
    assert_eq!(created_script["success"], json!(true));
    assert_eq!(created_script["script_path"], json!("scripts/runner.py"));
    let missing_skill_script_create = call!(
        handle_create_skill_script,
        args(&[
            ("skill_name", json!("missing-skill")),
            ("script_path", json!("runner.py")),
            ("content", json!("print(1)"))
        ])
    );
    assert_eq!(missing_skill_script_create["success"], json!(false));
    assert_eq!(
        missing_skill_script_create["error"],
        json!("Skill 'missing-skill' not found in skills-user")
    );

    let updated_script = call!(
        handle_update_skill_script,
        args(&[
            ("skill_name", json!("user-skill")),
            ("script_path", json!("runner.py")),
            ("content", json!("print(2)"))
        ])
    );
    assert_eq!(updated_script["success"], json!(true));
    assert_eq!(
        fs::read_to_string(root.path.join("skills-user/user-skill/scripts/runner.py")).unwrap(),
        "print(2)"
    );

    let missing_script = call!(
        handle_update_skill_script,
        args(&[
            ("skill_name", json!("user-skill")),
            ("script_path", json!("missing.py")),
            ("content", json!("print(0)"))
        ])
    );
    assert_eq!(missing_script["success"], json!(false));

    let deleted_script = call!(
        handle_delete_skill_script,
        args(&[
            ("skill_name", json!("user-skill")),
            ("script_path", json!("runner.py"))
        ])
    );
    assert_eq!(deleted_script["success"], json!(true));

    let missing_deleted_script = call!(
        handle_delete_skill_script,
        args(&[
            ("skill_name", json!("user-skill")),
            ("script_path", json!("runner.py"))
        ])
    );
    assert_eq!(missing_deleted_script["success"], json!(false));

    let deleted_reference = call!(
        handle_delete_skill_reference,
        args(&[
            ("skill_name", json!("user-skill")),
            ("reference_path", json!("guide.md"))
        ])
    );
    assert_eq!(deleted_reference["success"], json!(true));

    let missing_deleted_reference = call!(
        handle_delete_skill_reference,
        args(&[
            ("skill_name", json!("user-skill")),
            ("reference_path", json!("guide.md"))
        ])
    );
    assert_eq!(missing_deleted_reference["success"], json!(false));

    let missing_activation = call!(
        handle_activate_skill,
        args(&[
            ("skill_name", json!("missing-skill")),
            ("chat_id", json!("chat-1"))
        ])
    );
    assert_eq!(missing_activation["success"], json!(false));

    let delete_without_confirm = call!(
        handle_delete_skill,
        args(&[("skill_name", json!("user-skill"))])
    );
    assert_eq!(delete_without_confirm["success"], json!(false));

    let deleted_skill = call!(
        handle_delete_skill,
        args(&[
            ("skill_name", json!("user-skill")),
            ("confirm", json!(true))
        ])
    );
    assert_eq!(deleted_skill["success"], json!(true));
    assert!(!root.path.join("skills-user/user-skill").exists());

    let missing_delete = call!(
        handle_delete_skill,
        args(&[
            ("skill_name", json!("user-skill")),
            ("confirm", json!(true))
        ])
    );
    assert_eq!(missing_delete["success"], json!(false));
}

#[tokio::test]
async fn get_skill_reference_reads_root_level_marketplace_files_and_reference_fallback() {
    let root = TestRoot::new("reference-root-files");
    root.write_skill(
        "skills-marketplace",
        "anthropic-agent-skills/pptx",
        &skill_markdown("PPTX", "Marketplace PowerPoint skill", &[]),
    );
    root.write_relative(
        "skills-marketplace",
        "anthropic-agent-skills/pptx/pptxgenjs.md",
        "root-level pptxgenjs guide",
    );
    root.write_relative(
        "skills-marketplace",
        "anthropic-agent-skills/pptx/references/guide.md",
        "references guide",
    );

    let root_reference = call!(
        handle_get_skill_reference,
        args(&[
            ("skill_name", json!("anthropic-agent-skills/pptx")),
            ("reference_path", json!("pptxgenjs.md")),
            ("chat_id", json!("chat-root-reference"))
        ])
    );
    assert_eq!(root_reference["success"], json!(true));
    assert_eq!(root_reference["reference_path"], json!("pptxgenjs.md"));
    assert_eq!(
        root_reference["content"],
        json!("root-level pptxgenjs guide")
    );
    assert_eq!(
        redis_get_string("skill_ref_content:anthropic-agent-skills/pptx:pptxgenjs.md")
            .unwrap()
            .unwrap(),
        "root-level pptxgenjs guide"
    );

    let fallback_reference = call!(
        handle_get_skill_reference,
        args(&[
            ("skill_name", json!("anthropic-agent-skills/pptx")),
            ("reference_path", json!("guide.md"))
        ])
    );
    assert_eq!(fallback_reference["success"], json!(true));
    assert_eq!(fallback_reference["reference_path"], json!("guide.md"));
    assert_eq!(fallback_reference["content"], json!("references guide"));
}

#[tokio::test]
async fn get_skill_reference_rejects_unsafe_non_file_and_non_text_paths() {
    let root = TestRoot::new("reference-path-safety");
    root.write_skill(
        "skills",
        "safe-skill",
        &skill_markdown("Safe Skill", "System skill", &[]),
    );
    fs::write(root.path.join("outside.md"), "outside").expect("write outside file");
    root.write_relative(
        "skills",
        "safe-skill/references/folder.md/nested.txt",
        "nested",
    );
    fs::write(root.path.join("skills/safe-skill/binary.md"), [0xff, 0xfe])
        .expect("write binary file");

    let unsafe_paths = vec![
        "../outside.md".to_string(),
        root.path.join("outside.md").to_string_lossy().to_string(),
        "references/folder.md".to_string(),
        "binary.md".to_string(),
    ];

    for reference_path in unsafe_paths {
        let result = call!(
            handle_get_skill_reference,
            args(&[
                ("skill_name", json!("safe-skill")),
                ("reference_path", json!(reference_path))
            ])
        );
        assert_eq!(result["success"], json!(false));
        assert!(result.get("content").is_none());
    }
}

#[tokio::test]
async fn create_reference_and_script_require_existing_parent_skill() {
    let _root = TestRoot::new("parent-required");

    let missing_reference_parent = call!(
        handle_create_skill_reference,
        args(&[
            ("skill_name", json!("missing-parent")),
            ("reference_path", json!("guide.md")),
            ("content", json!("reference"))
        ])
    );
    assert_eq!(missing_reference_parent["success"], json!(false));
    assert_eq!(
        missing_reference_parent["error"],
        json!("Skill 'missing-parent' not found in skills-user")
    );

    let missing_script_parent = call!(
        handle_create_skill_script,
        args(&[
            ("skill_name", json!("missing-parent")),
            ("script_path", json!("runner.py")),
            ("content", json!("print('missing')"))
        ])
    );
    assert_eq!(missing_script_parent["success"], json!(false));
    assert_eq!(
        missing_script_parent["error"],
        json!("Skill 'missing-parent' not found in skills-user")
    );
}

#[tokio::test]
async fn export_skill_bundle_includes_all_bundle_files_for_user_and_marketplace_skills() {
    let root = TestRoot::new("export-bundle");
    root.write_skill(
        "skills-user",
        "writer",
        &skill_markdown("Writer", "User writer", &["server:gitlab-mcp"]).replace(
            "author: Test Suite\n",
            "author: Test Suite\ncreated_by_email: creator@example.com\n",
        ),
    );
    root.write_relative("skills-user", "writer/references/guide.md", "reference");
    root.write_relative(
        "skills-user",
        "writer/scripts/publish.py",
        "print('publish')",
    );
    root.write_relative("skills-user", "writer/assets/template.txt", "template");
    root.write_skill(
        "skills-marketplace",
        "acme/analyst",
        &skill_markdown("Analyst", "Marketplace analyst", &[]),
    );
    root.write_relative(
        "skills-marketplace",
        "acme/analyst/references/policy.md",
        "marketplace reference",
    );

    let user_bundle = call!(
        handle_export_skill_bundle,
        args(&[("skill_name", json!("writer"))])
    );
    assert_eq!(user_bundle["success"], json!(true));
    assert_eq!(user_bundle["source"], json!("user"));
    assert_eq!(
        user_bundle["metadata"]["created_by_email"],
        json!("creator@example.com")
    );
    let user_files = user_bundle["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert!(user_files.contains(&"SKILL.md".to_string()));
    assert!(user_files.contains(&"references/guide.md".to_string()));
    assert!(user_files.contains(&"scripts/publish.py".to_string()));
    assert!(user_files.contains(&"assets/template.txt".to_string()));
    assert_eq!(user_bundle["references"].as_array().unwrap().len(), 1);
    assert_eq!(user_bundle["scripts"].as_array().unwrap().len(), 1);

    let marketplace_bundle = call!(
        handle_export_skill_bundle,
        args(&[("skill_name", json!("acme/analyst"))])
    );
    assert_eq!(marketplace_bundle["success"], json!(true));
    assert_eq!(marketplace_bundle["source"], json!("marketplace"));
    assert!(marketplace_bundle["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["path"] == json!("references/policy.md")));
}

#[tokio::test]
async fn replace_user_skill_with_marketplace_install_archives_user_copy_after_install() {
    let root = TestRoot::new("replace-user-with-marketplace");
    root.write_skill(
        "skills-user",
        "writer",
        &skill_markdown("Writer", "Local writer", &["server:gitlab-mcp"]),
    );

    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": true,
            "localPath": "skills-marketplace/trustkit/writer",
            "version": "2.0.0"
        }),
    }]);
    root.set_electron_base(&base);

    let response = call!(
        handle_replace_user_skill_with_marketplace_install,
        args(&[
            ("skill_name", json!("writer")),
            ("marketplace_id", json!("trustkit")),
            ("skill_id", json!("writer")),
            ("skill_path", json!("./skills/writer"))
        ])
    );

    assert_eq!(response["success"], json!(true));
    assert_eq!(response["already_installed"], json!(false));
    assert_eq!(response["version"], json!("2.0.0"));
    assert!(!root.path.join("skills-user/writer").exists());

    let archived_to = response["archived_to"].as_str().expect("archive path");
    assert!(root.path.join(archived_to).exists());

    let request = requests.recv().expect("replace install request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/marketplaces/skills/install");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "marketplace_id": "trustkit",
            "skill_id": "writer",
            "skill_path": "./skills/writer",
            "skill_source": null,
            "plugin_name": null,
        })
    );
}

#[tokio::test]
async fn replace_user_skill_with_marketplace_install_rolls_back_install_when_archive_fails() {
    let root = TestRoot::new("replace-user-with-marketplace-archive-failure");
    root.write_skill(
        "skills-user",
        "writer",
        &skill_markdown("Writer", "Local writer", &["server:gitlab-mcp"]),
    );
    fs::write(root.path.join("skills-archive"), "blocked").expect("block archive root");

    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "localPath": "skills-marketplace/trustkit/writer",
                "version": "2.0.0"
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true
            }),
        },
    ]);
    root.set_electron_base(&base);

    let response = call!(
        handle_replace_user_skill_with_marketplace_install,
        args(&[
            ("skill_name", json!("writer")),
            ("marketplace_id", json!("trustkit")),
            ("skill_id", json!("writer")),
            ("skill_path", json!("./skills/writer"))
        ])
    );

    assert_eq!(response["success"], json!(false));
    assert!(response["error"]
        .as_str()
        .expect("archive failure")
        .contains("Failed to archive skill 'writer'"));
    assert!(root.path.join("skills-user/writer").exists());

    let install_request = requests.recv().expect("install request");
    assert_eq!(install_request.path, "/api/marketplaces/skills/install");
    let uninstall_request = requests.recv().expect("uninstall request");
    assert_eq!(uninstall_request.path, "/api/marketplaces/skills/uninstall");
    assert_eq!(
        serde_json::from_str::<Value>(&uninstall_request.body).unwrap(),
        json!({
            "marketplace_id": "trustkit",
            "skill_id": "writer",
        })
    );
}

#[tokio::test]
async fn create_skill_delegates_to_electron_and_ignores_legacy_author_values() {
    let root = TestRoot::new("create-app-owned");
    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": true,
            "skill_name": "test-skill",
            "created_by_email": "session.user@example.org",
        }),
    }]);
    root.set_electron_base(&base);
    let content = "# Test Skill\n\nBody content.\n";

    let created = call!(
        handle_create_skill,
        args(&[
            ("skill_name", json!("test-skill")),
            ("skill_content", json!(content)),
            ("author", json!("Spoofed Caller"))
        ])
    );
    assert_eq!(created["success"], json!(true));
    assert_eq!(
        created["created_by_email"],
        json!("session.user@example.org")
    );
    assert!(!root.path.join("skills-user/test-skill").exists());

    let request = requests.recv().expect("create request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/user-skills/create");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "skill_name": "test-skill",
            "skill_content": content,
        })
    );
}

#[tokio::test]
async fn copy_skill_delegates_by_id_and_preserves_reset_provenance_response() {
    let root = TestRoot::new("copy-app-owned");
    let source = root.write_skill(
        "skills-marketplace",
        "ai-marketplace/installed-source",
        &skill_markdown("Installed Source", "Marketplace skill", &[]),
    );
    let original = fs::read_to_string(&source).unwrap();
    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": true,
            "source_skill_id": "ai-marketplace/installed-source",
            "skill_name": "editable-copy",
            "source": "user",
            "created_by_email": "session.user@example.org",
            "marketplace_relationship": null,
            "marketplace_solution_id": null,
            "is_read_only": false,
        }),
    }]);
    root.set_electron_base(&base);

    let copied = call!(
        handle_copy_skill,
        args(&[
            ("source_skill_id", json!("ai-marketplace/installed-source")),
            ("new_skill_name", json!("editable-copy"))
        ])
    );
    assert_eq!(copied["success"], json!(true));
    assert_eq!(copied["source"], json!("user"));
    assert_eq!(
        copied["created_by_email"],
        json!("session.user@example.org")
    );
    assert_eq!(copied["marketplace_relationship"], Value::Null);
    assert_eq!(copied["marketplace_solution_id"], Value::Null);
    assert_eq!(copied["is_read_only"], json!(false));
    assert_eq!(fs::read_to_string(&source).unwrap(), original);

    let request = requests.recv().expect("copy request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/user-skills/copy");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "source_skill_id": "ai-marketplace/installed-source",
            "new_skill_name": "editable-copy",
        })
    );
}

#[tokio::test]
async fn copy_skill_rejects_missing_and_duplicate_ids_before_electron_mutation() {
    let root = TestRoot::new("copy-preflight");
    root.write_skill(
        "skills",
        "source-skill",
        &skill_markdown("Source", "Source skill", &[]),
    );
    root.write_skill(
        "skills-user",
        "taken-name",
        &skill_markdown("Taken", "Existing skill", &[]),
    );

    let missing = call!(
        handle_copy_skill,
        args(&[
            ("source_skill_id", json!("missing-skill")),
            ("new_skill_name", json!("unused-copy"))
        ])
    );
    assert_eq!(missing["success"], json!(false));
    assert_eq!(missing["code"], json!("skill_not_found"));

    let duplicate = call!(
        handle_copy_skill,
        args(&[
            ("source_skill_id", json!("source-skill")),
            ("new_skill_name", json!("taken-name"))
        ])
    );
    assert_eq!(duplicate["success"], json!(false));
    assert_eq!(duplicate["code"], json!("skill_already_exists"));
}

#[tokio::test]
async fn missing_electron_identity_prevents_creation_without_local_mutation() {
    let root = TestRoot::new("create-missing-identity");
    let (base, requests) = serve_responses(vec![MockReply {
        status: "503 Service Unavailable",
        body: json!({
            "success": false,
            "code": "missing_user_identity",
            "error": "identity unavailable",
        }),
    }]);
    root.set_electron_base(&base);

    let result = call!(
        handle_create_skill,
        args(&[
            ("skill_name", json!("must-not-exist")),
            ("skill_content", json!("# Body\n"))
        ])
    );
    assert_eq!(result["success"], json!(false));
    assert_eq!(result["code"], json!("missing_user_identity"));
    assert_eq!(result["error"], json!("identity unavailable"));
    assert!(!root.path.join("skills-user/must-not-exist").exists());
    assert_eq!(
        requests.recv().expect("create request").path,
        "/api/user-skills/create"
    );
}

#[tokio::test]
async fn update_skill_delegates_to_electron_and_ignores_legacy_author_values() {
    let root = TestRoot::new("update-app-owned");
    root.write_skill(
        "skills-user",
        "existing-skill",
        &skill_markdown("Existing", "Original", &[]),
    );
    let original =
        fs::read_to_string(root.path.join("skills-user/existing-skill/SKILL.md")).unwrap();
    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": true,
            "skill_name": "existing-skill",
            "created_by_email": "original.creator@example.org",
        }),
    }]);
    root.set_electron_base(&base);
    let new_content = "\
---
name: existing-skill
author: Descriptive Author
description: Updated description
---
# Existing Skill
Updated body.
";

    let updated = call!(
        handle_update_skill,
        args(&[
            ("skill_name", json!("existing-skill")),
            ("skill_content", json!(new_content)),
            ("author", json!("Spoofed Caller"))
        ])
    );
    assert_eq!(updated["success"], json!(true));
    assert_eq!(
        fs::read_to_string(root.path.join("skills-user/existing-skill/SKILL.md")).unwrap(),
        original
    );
    let request = requests.recv().expect("update request");
    assert_eq!(request.path, "/api/user-skills/update");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "skill_name": "existing-skill",
            "skill_content": new_content,
        })
    );
}

#[tokio::test]
async fn get_skill_assets_serves_only_activated_skill_images() {
    let root = TestRoot::new("asset-tool");
    root.write_skill(
        "skills",
        "asset-skill",
        &skill_markdown("Asset Skill", "Uses assets", &[]),
    );
    let assets_dir = root.path.join("skills/asset-skill/assets");
    fs::create_dir_all(&assets_dir).unwrap();
    fs::write(assets_dir.join("terminal.png"), b"fake png bytes").unwrap();
    fs::write(assets_dir.join("confirm.png"), b"fake confirm bytes").unwrap();
    fs::write(assets_dir.join("notes.txt"), b"not an image").unwrap();
    redis_set_string("chat_skills:chat-assets", r#"["asset-skill"]"#).unwrap();

    let response = handle_get_skill_assets(&args(&[
        ("skill_name", json!("asset-skill")),
        (
            "asset_paths",
            json!(["assets/terminal.png", "assets/confirm.png"]),
        ),
        ("chat_id", json!("chat-assets")),
    ]))
    .await
    .unwrap();
    let payload: Value =
        serde_json::from_str(response["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(payload["success"], json!(true));
    assert_eq!(payload["assets"].as_array().unwrap().len(), 2);
    assert_eq!(
        payload["assets"][0]["asset_path"],
        json!("assets/terminal.png")
    );
    assert_eq!(
        payload["assets"][0]["workspace_path"],
        json!("skill-assets/asset-skill/terminal.png")
    );
    assert_eq!(
        payload["assets"][0]["download_url"],
        json!("http://localhost:9876/workspace/chat-assets/skill-assets/asset-skill/terminal.png")
    );
    assert_eq!(
        payload["assets"][0]["markdown_image"],
        json!("![terminal.png](http://localhost:9876/workspace/chat-assets/skill-assets/asset-skill/terminal.png)")
    );
    assert_eq!(
        payload["assets"][1]["asset_path"],
        json!("assets/confirm.png")
    );
    assert_eq!(
        payload["assets"][1]["markdown_image"],
        json!("![confirm.png](http://localhost:9876/workspace/chat-assets/skill-assets/asset-skill/confirm.png)")
    );
    assert_eq!(
        fs::read(
            root.path
                .join("workspaces/chat-assets/skill-assets/asset-skill/terminal.png")
        )
        .unwrap(),
        b"fake png bytes"
    );
    assert_eq!(
        fs::read(
            root.path
                .join("workspaces/chat-assets/skill-assets/asset-skill/confirm.png")
        )
        .unwrap(),
        b"fake confirm bytes"
    );
    let serialized = serde_json::to_string(&response).unwrap();
    assert!(!serialized.contains("data:image"));
    assert!(!serialized.contains("base64"));
    assert!(!serialized.contains("ZmFrZSBwbmcgYnl0ZXM="));

    let inactive = call!(
        handle_get_skill_assets,
        args(&[
            ("skill_name", json!("asset-skill")),
            ("asset_paths", json!(["terminal.png"])),
            ("chat_id", json!("other-chat"))
        ])
    );
    assert_eq!(inactive["success"], json!(false));

    let missing = call!(
        handle_get_skill_assets,
        args(&[
            ("skill_name", json!("asset-skill")),
            ("asset_paths", json!(["missing.png"])),
            ("chat_id", json!("chat-assets"))
        ])
    );
    assert_eq!(missing["success"], json!(false));
    assert_eq!(
        missing["error"],
        json!("Asset not found: assets/missing.png")
    );

    let wrong_mime = call!(
        handle_get_skill_assets,
        args(&[
            ("skill_name", json!("asset-skill")),
            ("asset_paths", json!(["notes.txt"])),
            ("chat_id", json!("chat-assets"))
        ])
    );
    assert_eq!(wrong_mime["success"], json!(false));
    assert!(wrong_mime["error"]
        .as_str()
        .unwrap()
        .contains("Only PNG, JPEG, GIF, and WebP"));

    let traversal = call!(
        handle_get_skill_assets,
        args(&[
            ("skill_name", json!("asset-skill")),
            ("asset_paths", json!(["../SKILL.md"])),
            ("chat_id", json!("chat-assets"))
        ])
    );
    assert_eq!(traversal["success"], json!(false));
    assert_eq!(
        traversal["error"],
        json!("asset_path must stay within assets/")
    );
}

#[tokio::test]
async fn installed_skill_reads_export_authoritative_provenance() {
    let root = TestRoot::new("installed-provenance");
    root.write_skill(
        "skills-marketplace",
        "trustkit/installed-skill",
        "\
---
name: Installed Skill
description: Foreign installed skill
created_by_email: foreign@example.invalid
version: 2.1.0
---
# Installed Skill
Read only.
",
    );
    root.write_relative(
        "skills-marketplace",
        "trustkit/installed-skill/references/guide.md",
        "# Guide\n",
    );
    let provenance_response = MockReply {
        status: "200 OK",
        body: json!({
            "success": true,
            "data": {
                "skill_links": {},
                "installed_skills": [{
                    "marketplace_id": "trustkit",
                    "skill_id": "installed-skill",
                    "local_path": "skills-marketplace/trustkit/installed-skill",
                    "marketplace_solution_id": "foreign-skill-solution",
                    "source_type": "ai-marketplace-solution"
                }]
            }
        }),
    };
    let (base, requests) = serve_responses(vec![
        provenance_response.clone(),
        provenance_response.clone(),
        provenance_response,
    ]);
    root.set_electron_base(&base);
    env::remove_var("CORE_MCP_TEST_REDIS");

    let listed = call!(
        handle_list_skills,
        args(&[("filter_source", json!("marketplace"))])
    );
    let listed_skill = &listed["skills"][0];
    assert_eq!(listed_skill["source"], json!("marketplace"));
    assert_eq!(
        listed_skill["created_by_email"],
        json!("foreign@example.invalid")
    );
    assert_eq!(listed_skill["marketplace_relationship"], json!("installed"));
    assert_eq!(
        listed_skill["marketplace_solution_id"],
        json!("foreign-skill-solution")
    );
    assert_eq!(listed_skill["is_read_only"], json!(true));

    let read = call!(
        handle_read_skill,
        args(&[("skill_name", json!("trustkit/installed-skill"))])
    );
    assert_eq!(read["source"], json!("marketplace"));
    assert_eq!(read["marketplace_relationship"], json!("installed"));
    assert_eq!(
        read["marketplace_solution_id"],
        json!("foreign-skill-solution")
    );
    assert_eq!(read["is_read_only"], json!(true));

    let exported = call!(
        handle_export_skill_bundle,
        args(&[("skill_name", json!("trustkit/installed-skill"))])
    );
    assert_eq!(exported["source"], json!("marketplace"));
    assert_eq!(exported["created_by_email"], json!("foreign@example.invalid"));
    assert_eq!(exported["marketplace_relationship"], json!("installed"));
    assert_eq!(
        exported["marketplace_solution_id"],
        json!("foreign-skill-solution")
    );
    assert_eq!(exported["is_read_only"], json!(true));
    assert_eq!(
        exported["references"][0]["path"],
        json!("references/guide.md")
    );

    for _ in 0..3 {
        let request = requests.recv().expect("provenance request");
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/api/ai-marketplace/skill-provenance");
    }
}

#[tokio::test]
async fn installed_skill_rejects_every_content_mutation_without_file_changes() {
    let root = TestRoot::new("installed-mutation-guard");
    let skill_md = root.write_skill(
        "skills-marketplace",
        "trustkit/installed-skill",
        &skill_markdown("Installed Skill", "Read only", &[]),
    );
    let reference = root.write_relative(
        "skills-marketplace",
        "trustkit/installed-skill/references/guide.md",
        "# Original guide\n",
    );
    let script = root.write_relative(
        "skills-marketplace",
        "trustkit/installed-skill/scripts/runner.py",
        "print('original')\n",
    );
    let original_skill = fs::read_to_string(&skill_md).unwrap();
    let original_reference = fs::read_to_string(&reference).unwrap();
    let original_script = fs::read_to_string(&script).unwrap();
    let skill_name = "trustkit/installed-skill";

    let failures = vec![
        call!(
            handle_update_skill,
            args(&[
                ("skill_name", json!(skill_name)),
                (
                    "skill_content",
                    json!("---\nname: Installed Skill\ndescription: Changed\n---\n# Changed\n")
                )
            ])
        ),
        call!(
            handle_create_skill_reference,
            args(&[
                ("skill_name", json!(skill_name)),
                ("reference_path", json!("new.md")),
                ("content", json!("new"))
            ])
        ),
        call!(
            handle_update_skill_reference,
            args(&[
                ("skill_name", json!(skill_name)),
                ("reference_path", json!("guide.md")),
                ("content", json!("changed"))
            ])
        ),
        call!(
            handle_delete_skill_reference,
            args(&[
                ("skill_name", json!(skill_name)),
                ("reference_path", json!("guide.md"))
            ])
        ),
        call!(
            handle_create_skill_script,
            args(&[
                ("skill_name", json!(skill_name)),
                ("script_path", json!("new.py")),
                ("content", json!("print('new')"))
            ])
        ),
        call!(
            handle_update_skill_script,
            args(&[
                ("skill_name", json!(skill_name)),
                ("script_path", json!("runner.py")),
                ("content", json!("print('changed')"))
            ])
        ),
        call!(
            handle_delete_skill_script,
            args(&[
                ("skill_name", json!(skill_name)),
                ("script_path", json!("runner.py"))
            ])
        ),
    ];
    for failure in failures {
        assert_eq!(failure["success"], json!(false));
        assert_eq!(failure["code"], json!("installed_copy_read_only"));
        assert!(failure["remediation"]
            .as_str()
            .unwrap()
            .contains("editable user copy"));
    }

    assert_eq!(fs::read_to_string(&skill_md).unwrap(), original_skill);
    assert_eq!(fs::read_to_string(&reference).unwrap(), original_reference);
    assert_eq!(fs::read_to_string(&script).unwrap(), original_script);
    assert!(!root
        .path
        .join("skills-marketplace/trustkit/installed-skill/references/new.md")
        .exists());
    assert!(!root
        .path
        .join("skills-marketplace/trustkit/installed-skill/scripts/new.py")
        .exists());
}

#[tokio::test]
async fn installed_skill_delete_delegates_local_cleanup_and_never_unpublishes() {
    let root = TestRoot::new("installed-local-delete");
    root.write_skill(
        "skills-marketplace",
        "trustkit/installed-skill",
        &skill_markdown("Installed Skill", "Read only", &[]),
    );
    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": true,
            "data": {
                "success": true,
                "skill_id": "trustkit/installed-skill",
                "source": "marketplace",
                "marketplace_relationship": "installed",
                "marketplace_solution_id": "foreign-skill-solution",
                "remote_solution_deleted": false
            }
        }),
    }]);
    root.set_electron_base(&base);

    let deleted = call!(
        handle_delete_skill,
        args(&[
            ("skill_name", json!("trustkit/installed-skill")),
            ("confirm", json!(true))
        ])
    );
    assert_eq!(deleted["success"], json!(true));
    assert_eq!(deleted["source"], json!("marketplace"));
    assert_eq!(deleted["local_deleted"], json!(true));
    assert_eq!(deleted["remote_solution_deleted"], json!(false));
    assert_eq!(
        deleted["marketplace_solution_id"],
        json!("foreign-skill-solution")
    );

    let request = requests.recv().expect("local delete request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/ai-marketplace/delete-local-skill");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({ "skill_id": "trustkit/installed-skill" })
    );
}

#[tokio::test]
async fn skill_envelopes_always_carry_a_display_name() {
    let root = TestRoot::new("display-name");
    root.write_skill(
        "skills-user",
        "epic-voice-booster",
        &skill_markdown("epic-voice-booster", "Elevates text", &[]),
    );

    let read = call!(
        handle_read_skill,
        args(&[("skill_name", json!("epic-voice-booster"))])
    );
    assert_eq!(read["display_name"], json!("Epic Voice Booster"));
    assert_eq!(read["metadata"]["display_name"], json!("Epic Voice Booster"));

    let listed = call!(
        handle_list_skills,
        args(&[("filter_source", json!("all"))])
    );
    assert_eq!(
        listed["skills"][0]["display_name"],
        json!("Epic Voice Booster")
    );

    let exported = call!(
        handle_export_skill_bundle,
        args(&[("skill_name", json!("epic-voice-booster"))])
    );
    assert_eq!(exported["display_name"], json!("Epic Voice Booster"));

    let reference = call!(
        handle_create_skill_reference,
        args(&[
            ("skill_name", json!("epic-voice-booster")),
            ("reference_path", json!("guide.md")),
            ("content", json!("guide"))
        ])
    );
    assert_eq!(reference["display_name"], json!("Epic Voice Booster"));

    let script = call!(
        handle_create_skill_script,
        args(&[
            ("skill_name", json!("epic-voice-booster")),
            ("script_path", json!("run.py")),
            ("content", json!("print('hi')"))
        ])
    );
    assert_eq!(script["display_name"], json!("Epic Voice Booster"));

    let read_reference = call!(
        handle_get_skill_reference,
        args(&[
            ("skill_name", json!("epic-voice-booster")),
            ("reference_path", json!("guide.md"))
        ])
    );
    assert_eq!(read_reference["display_name"], json!("Epic Voice Booster"));

    let activated = call!(
        handle_activate_skill,
        skill_chat_args("epic-voice-booster", "chat-display")
    );
    assert_eq!(activated["display_name"], json!("Epic Voice Booster"));
    assert_eq!(
        activated["skill_info"]["display_name"],
        json!("Epic Voice Booster")
    );

    let listed_active = call!(
        handle_get_activated_skills,
        args(&[("chat_id", json!("chat-display"))])
    );
    assert_eq!(
        listed_active["activated_skills"][0]["display_name"],
        json!("Epic Voice Booster")
    );

    let deactivated = call!(
        handle_deactivate_skill,
        skill_chat_args("epic-voice-booster", "chat-display")
    );
    assert_eq!(deactivated["display_name"], json!("Epic Voice Booster"));

    // An authored frontmatter title beats derivation.
    root.write_skill(
        "skills-user",
        "custom-title",
        &skill_markdown("custom-title", "Custom", &[]).replace(
            "description: Custom\n",
            "description: Custom\ndisplay_name: A Handsome Title\n",
        ),
    );
    let custom = call!(
        handle_read_skill,
        args(&[("skill_name", json!("custom-title"))])
    );
    assert_eq!(custom["display_name"], json!("A Handsome Title"));

    // The memory-redis delete path names the deleted skill.
    let deleted = call!(
        handle_delete_skill,
        args(&[
            ("skill_name", json!("epic-voice-booster")),
            ("confirm", json!(true))
        ])
    );
    assert_eq!(deleted["success"], json!(true));
    assert_eq!(deleted["display_name"], json!("Epic Voice Booster"));

    // Redis remembers an activated skill whose directory is gone: the
    // metadata-unavailable fallback row still derives a display name.
    let orphan_setup = call!(
        handle_activate_skill,
        skill_chat_args("custom-title", "chat-orphan")
    );
    assert_eq!(orphan_setup["success"], json!(true));
    fs::remove_dir_all(root.path.join("skills-user/custom-title")).unwrap();
    let orphaned = call!(
        handle_get_activated_skills,
        args(&[("chat_id", json!("chat-orphan"))])
    );
    assert_eq!(
        orphaned["activated_skills"][0]["display_name"],
        json!("Custom Title")
    );
}

#[path = "skills_activation_tests.rs"]
mod activation_tests;

#[path = "skills_parse_tests.rs"]
mod parse_tests;

#[path = "skills_system_immutability_tests.rs"]
mod system_immutability_tests;

#[path = "skills_ai_marketplace_tests.rs"]
mod ai_marketplace_tests;
#[path = "skills_marketplace_tests.rs"]
mod marketplace_tests;
#[path = "skills_user_question_tests.rs"]
mod user_question_tests;
#[path = "skills_wait_tests.rs"]
mod wait_tests;

// -----------------------------------------------------------------------------
// 2026-08-01 sharing-plan S7 regression: reference/script mutations are bundle
// content, so each successful one must report the skill to the Electron
// mark-dirty route (published links track has_unpublished_changes). Failed
// mutations must not.
// -----------------------------------------------------------------------------
#[tokio::test]
async fn reference_and_script_mutations_mark_the_skill_link_dirty() {
    let root = TestRoot::new("mark-dirty-on-bundle-content");
    root.write_skill(
        "skills-user",
        "linked-skill",
        "---\nname: linked-skill\ndescription: Linked\n---\n\n# Linked\n",
    );
    let marked = MockReply {
        status: "200 OK",
        body: json!({ "success": true, "marked": true }),
    };
    let (base, requests) = serve_responses(vec![
        marked.clone(),
        marked.clone(),
        marked.clone(),
        marked.clone(),
        marked.clone(),
        marked,
    ]);
    root.set_electron_base(&base);
    // Leave memory-redis test mode so the electron notification actually fires.
    env::remove_var("CORE_MCP_TEST_REDIS");

    let assert_marked = |label: &str, requests: &mpsc::Receiver<CapturedRequest>| {
        let request = requests.recv().expect("mark-dirty request");
        assert_eq!(request.method, "POST", "{label}");
        assert_eq!(request.path, "/api/user-skills/mark-dirty", "{label}");
        assert_eq!(
            serde_json::from_str::<Value>(&request.body).unwrap(),
            json!({ "skill_name": "linked-skill" }),
            "{label}",
        );
    };

    let created = call!(
        handle_create_skill_reference,
        args(&[
            ("skill_name", json!("linked-skill")),
            ("reference_path", json!("guide.md")),
            ("content", json!("# Guide v1\n")),
        ])
    );
    assert_eq!(created["success"], json!(true));
    assert_marked("create reference", &requests);

    let updated = call!(
        handle_update_skill_reference,
        args(&[
            ("skill_name", json!("linked-skill")),
            ("reference_path", json!("guide.md")),
            ("content", json!("# Guide v2\n")),
        ])
    );
    assert_eq!(updated["success"], json!(true));
    assert_marked("update reference", &requests);

    let script_created = call!(
        handle_create_skill_script,
        args(&[
            ("skill_name", json!("linked-skill")),
            ("script_path", json!("run.py")),
            ("content", json!("print('v1')\n")),
        ])
    );
    assert_eq!(script_created["success"], json!(true));
    assert_marked("create script", &requests);

    let script_updated = call!(
        handle_update_skill_script,
        args(&[
            ("skill_name", json!("linked-skill")),
            ("script_path", json!("run.py")),
            ("content", json!("print('v2')\n")),
        ])
    );
    assert_eq!(script_updated["success"], json!(true));
    assert_marked("update script", &requests);

    let script_deleted = call!(
        handle_delete_skill_script,
        args(&[
            ("skill_name", json!("linked-skill")),
            ("script_path", json!("run.py")),
        ])
    );
    assert_eq!(script_deleted["success"], json!(true));
    assert_marked("delete script", &requests);

    let reference_deleted = call!(
        handle_delete_skill_reference,
        args(&[
            ("skill_name", json!("linked-skill")),
            ("reference_path", json!("guide.md")),
        ])
    );
    assert_eq!(reference_deleted["success"], json!(true));
    assert_marked("delete reference", &requests);

    // A FAILED mutation (missing reference) must not mark anything.
    let missing = call!(
        handle_update_skill_reference,
        args(&[
            ("skill_name", json!("linked-skill")),
            ("reference_path", json!("nope.md")),
            ("content", json!("x")),
        ])
    );
    assert_eq!(missing["success"], json!(false));
    assert!(
        requests.try_recv().is_err(),
        "failed mutations must not send mark-dirty requests"
    );
}

// -----------------------------------------------------------------------------
// rename_skill (2026-08-01 sharing-plan S9 / ISSUE-4): local gates + Electron
// proxy contract.
// -----------------------------------------------------------------------------
#[tokio::test]
async fn rename_skill_gates_locally_and_proxies_to_electron() {
    let root = TestRoot::new("rename-skill");
    root.write_skill(
        "skills-user",
        "foo",
        "---\nname: foo\ndescription: Local foo\n---\n\n# Mine\n",
    );
    root.write_skill(
        "skills-user",
        "taken",
        "---\nname: taken\ndescription: t\n---\n\n# t\n",
    );
    root.write_skill(
        "skills-marketplace/trustkit",
        "installed-skill",
        "---\nname: installed-skill\ndescription: i\n---\n\n# i\n",
    );
    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": true,
            "skill_name": "foo-local",
            "previous_skill_name": "foo",
            "marketplace_link_moved": false
        }),
    }]);
    root.set_electron_base(&base);

    // Installed marketplace copies keep their names.
    let read_only = call!(
        handle_rename_skill,
        args(&[
            ("skill_name", json!("trustkit/installed-skill")),
            ("new_skill_name", json!("my-skill")),
        ])
    );
    assert_eq!(read_only["success"], json!(false));
    assert_eq!(read_only["code"], json!("installed_copy_read_only"));

    // Unknown source fails before any proxying.
    let missing = call!(
        handle_rename_skill,
        args(&[
            ("skill_name", json!("nope")),
            ("new_skill_name", json!("my-skill")),
        ])
    );
    assert_eq!(missing["success"], json!(false));
    assert_eq!(missing["code"], json!("skill_not_found"));

    // Name collisions across any local source fail before proxying.
    let collision = call!(
        handle_rename_skill,
        args(&[
            ("skill_name", json!("foo")),
            ("new_skill_name", json!("taken")),
        ])
    );
    assert_eq!(collision["success"], json!(false));
    assert_eq!(collision["code"], json!("skill_already_exists"));

    // Happy path proxies to the Electron rename route with both names.
    let renamed = call!(
        handle_rename_skill,
        args(&[
            ("skill_name", json!("foo")),
            ("new_skill_name", json!("foo-local")),
        ])
    );
    assert_eq!(renamed["success"], json!(true));
    assert_eq!(renamed["skill_name"], json!("foo-local"));
    let request = requests.recv().expect("rename request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/user-skills/rename");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({ "skill_name": "foo", "new_skill_name": "foo-local" })
    );
}

// -----------------------------------------------------------------------------
// R2-1 regression (2026-08-02): reference metadata used to enumerate only an
// extension allowlist under `references/` while the write/read surfaces accept
// any extension AND the singular `reference/` layout — so list/read callers
// never learned those files existed. Enumeration must now mirror exactly what
// get_skill_reference will serve.
// -----------------------------------------------------------------------------
#[tokio::test]
async fn reference_metadata_reports_every_servable_file_across_both_layouts() {
    let root = TestRoot::new("reference-enumeration");
    root.write_skill(
        "skills-user",
        "data-analyst",
        &skill_markdown("Data Analyst", "Analyzes warehouse data", &[]),
    );
    root.write_relative(
        "skills-user",
        "data-analyst/references/queries/top.sql",
        "SELECT 1;\n",
    );
    root.write_relative("skills-user", "data-analyst/references/rows.csv", "a,b\n1,2\n");
    root.write_relative("skills-user", "data-analyst/references/guide.md", "# Guide\n");
    // Marketplace-style singular layout (e.g. anthropic mcp-builder).
    root.write_relative("skills-user", "data-analyst/reference/nested/sdk.md", "# SDK\n");
    // Reference-material-only SKILL.md: never a phantom skill, and never
    // advertised (get_skill_reference refuses nested SKILL.md paths).
    root.write_relative(
        "skills-user",
        "data-analyst/reference/nested/SKILL.md",
        "---\nname: phantom\ndescription: Reference material\n---\n# Phantom\n",
    );

    let expected = json!([
        "reference/nested/sdk.md",
        "references/guide.md",
        "references/queries/top.sql",
        "references/rows.csv",
    ]);

    let listed = call!(handle_list_skills, args(&[("filter_source", json!("all"))]));
    assert_eq!(listed["total"], json!(1), "reference dirs must not create phantom skills");
    assert_eq!(listed["skills"][0]["name"], json!("data-analyst"));
    assert_eq!(listed["skills"][0]["references"], expected);

    let read = call!(
        handle_read_skill,
        args(&[("skill_name", json!("data-analyst"))])
    );
    assert_eq!(read["metadata"]["references"], expected);

    // Every advertised entry is fetchable through the read surface.
    for reference_path in [
        "reference/nested/sdk.md",
        "references/queries/top.sql",
        "references/rows.csv",
    ] {
        let fetched = call!(
            handle_get_skill_reference,
            args(&[
                ("skill_name", json!("data-analyst")),
                ("reference_path", json!(reference_path))
            ])
        );
        assert_eq!(
            fetched["success"],
            json!(true),
            "advertised reference must be servable: {reference_path}"
        );
    }

    // The export bundle's references group carries the same enumeration.
    let bundle = call!(
        handle_export_skill_bundle,
        args(&[("skill_name", json!("data-analyst"))])
    );
    assert_eq!(bundle["success"], json!(true));
    let bundle_references = bundle["references"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        bundle_references,
        vec![
            "reference/nested/sdk.md",
            "references/guide.md",
            "references/queries/top.sql",
            "references/rows.csv",
        ]
    );
}
