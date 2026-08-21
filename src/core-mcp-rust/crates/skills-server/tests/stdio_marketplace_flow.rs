use anyhow::{Context, Result};
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::{transport::TokioChildProcess, ServiceExt};
use serde_json::{json, Map, Value};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use uuid::Uuid;

struct TempRoot {
    path: PathBuf,
}

impl TempRoot {
    fn new(name: &str) -> Result<Self> {
        let path = env::temp_dir().join(format!(
            "core-mcp-rust-skills-marketplace-stdio-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(path.join("mcp-configs"))?;
        fs::create_dir_all(path.join("mcp-configs-user"))?;
        fs::create_dir_all(path.join("skills"))?;
        fs::create_dir_all(path.join("skills-user"))?;
        fs::create_dir_all(path.join("skills-marketplace"))?;
        Ok(Self { path })
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[derive(Debug)]
struct CapturedRequest {
    method: String,
    path: String,
    body: String,
}

#[derive(Clone)]
struct MockReply {
    status: &'static str,
    body: Value,
}

fn read_http_request(stream: &mut std::net::TcpStream) -> CapturedRequest {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    let header_end;
    loop {
        let read = stream.read(&mut chunk).expect("read request");
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
        let read = stream.read(&mut chunk).expect("read request body");
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
    let base = format!("http://{}", listener.local_addr().expect("listener addr"));
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for reply in replies {
            let (mut stream, _) = listener.accept().expect("accept request");
            let request = read_http_request(&mut stream);
            tx.send(request).expect("send request");
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
    });
    (base, rx)
}

fn args(entries: &[(&str, Value)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

fn tool_request(name: &'static str, arguments: Map<String, Value>) -> CallToolRequestParams {
    CallToolRequestParams::new(name).with_arguments(arguments)
}

fn payload(result: CallToolResult) -> Result<Value> {
    let text = result
        .content
        .first()
        .context("missing tool result content")?
        .raw
        .as_text()
        .context("expected text tool result")?
        .text
        .as_ref();
    serde_json::from_str(text).context("tool result should be JSON")
}

macro_rules! call_tool_json {
    ($client:expr, $name:expr, $args:expr) => {
        payload($client.call_tool(tool_request($name, $args)).await?)
    };
}

#[tokio::test]
async fn stdio_marketplace_tools_proxy_to_electron_api() -> Result<()> {
    let root = TempRoot::new("marketplace-flow")?;
    fs::create_dir_all(root.path.join("skills-user/writer/references"))?;
    fs::create_dir_all(root.path.join("skills-user/writer/scripts"))?;
    fs::write(
        root.path.join("skills-user/writer/SKILL.md"),
        "\
---
name: Writer
description: Local writer
required_mcp_servers: []
---
# Writer
Local writer body
",
    )?;
    fs::write(
        root.path.join("skills-user/writer/references/guide.md"),
        "reference",
    )?;
    fs::write(
        root.path.join("skills-user/writer/scripts/publish.py"),
        "print('publish')",
    )?;

    let (base, requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "data": {"marketplaces": [], "installedSkills": []}}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "marketplace": {"id": "trustkit"}}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "marketplace": {"id": "trustkit"}, "skills": []}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "localPath": "skills-marketplace/trustkit/trustkit", "version": "1.0.0"}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "localPath": "skills-marketplace/trustkit/writer", "version": "1.1.0"}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "version": "2.0.0"}),
        },
        MockReply {
            status: "200 OK",
            body: json!({
                "success": true,
                "marketplaceId": "trustkit",
                "skillId": "trustkit",
                "skillName": "trustkit-detached",
                "localPath": "skills-user/trustkit-detached"
            }),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "marketplaceId": "trustkit", "skillId": "trustkit"}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"success": true, "marketplaceId": "trustkit", "removedInstalledSkills": true, "removedSkillsCount": 1}),
        },
    ]);

    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_skills-server"));
    command.current_dir(&root.path);
    command.env("CONTAINER_PROJECT_ROOT", &root.path);
    command.env("HOST_PROJECT_ROOT", &root.path);
    command.env("CORE_MCP_TEST_REDIS", "memory");
    command.env("ELECTRON_API_BASE", &base);

    let transport = TokioChildProcess::new(command)?;
    let client = ().serve(transport).await?;

    let listed = call_tool_json!(client, "list_marketplaces", args(&[]))?;
    assert_eq!(listed["success"], json!(true));
    let request = requests.recv().expect("list request");
    assert_eq!(request.method, "GET");
    assert_eq!(request.path, "/api/marketplaces");

    let added = call_tool_json!(
        client,
        "add_marketplace",
        args(&[("source_input", json!("squall-mod/trust-kit"))])
    )?;
    assert_eq!(added["success"], json!(true));
    let request = requests.recv().expect("add request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/marketplaces");

    let skills = call_tool_json!(
        client,
        "get_marketplace_skills",
        args(&[("marketplace_id", json!("trustkit"))])
    )?;
    assert_eq!(skills["success"], json!(true));
    let request = requests.recv().expect("skills request");
    assert_eq!(request.path, "/api/marketplaces/trustkit/skills");

    let installed = call_tool_json!(
        client,
        "install_marketplace_skill",
        args(&[
            ("marketplace_id", json!("trustkit")),
            ("skill_id", json!("trustkit")),
            ("skill_path", json!("./.atlas/skills/trustkit")),
        ])
    )?;
    assert_eq!(installed["version"], json!("1.0.0"));
    let request = requests.recv().expect("install request");
    assert_eq!(request.path, "/api/marketplaces/skills/install");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "marketplace_id": "trustkit",
            "skill_id": "trustkit",
            "skill_path": "./.atlas/skills/trustkit",
            "skill_source": null,
            "plugin_name": null,
        })
    );

    let exported = call_tool_json!(
        client,
        "export_skill_bundle",
        args(&[("skill_name", json!("writer"))])
    )?;
    assert_eq!(exported["success"], json!(true));
    assert!(exported["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["path"] == json!("scripts/publish.py")));

    let replaced = call_tool_json!(
        client,
        "replace_user_skill_with_marketplace_install",
        args(&[
            ("skill_name", json!("writer")),
            ("marketplace_id", json!("trustkit")),
            ("skill_id", json!("writer")),
            ("skill_path", json!("./skills/writer")),
        ])
    )?;
    assert_eq!(replaced["success"], json!(true));
    assert!(!root.path.join("skills-user/writer").exists());
    let archived_to = replaced["archived_to"].as_str().expect("archive path");
    assert!(root.path.join(archived_to).exists());
    let request = requests.recv().expect("replace install request");
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

    let updated = call_tool_json!(
        client,
        "update_marketplace_skill",
        args(&[
            ("marketplace_id", json!("trustkit")),
            ("skill_id", json!("trustkit")),
            ("force_discard_local_changes", json!(true)),
        ])
    )?;
    assert_eq!(updated["version"], json!("2.0.0"));
    let request = requests.recv().expect("update request");
    assert_eq!(request.path, "/api/marketplaces/skills/update");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "marketplace_id": "trustkit",
            "skill_id": "trustkit",
            "force_discard_local_changes": true,
            "plugin_name": null,
        })
    );

    let detached = call_tool_json!(
        client,
        "detach_marketplace_skill_to_user_skill",
        args(&[
            ("marketplace_id", json!("trustkit")),
            ("skill_id", json!("trustkit")),
        ])
    )?;
    assert_eq!(detached["success"], json!(true));
    let request = requests.recv().expect("detach request");
    assert_eq!(request.path, "/api/marketplaces/skills/detach");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "marketplace_id": "trustkit",
            "skill_id": "trustkit",
            "target_skill_name": null,
            "plugin_name": null,
        })
    );

    let uninstalled = call_tool_json!(
        client,
        "uninstall_marketplace_skill",
        args(&[
            ("marketplace_id", json!("trustkit")),
            ("skill_id", json!("trustkit")),
        ])
    )?;
    assert_eq!(uninstalled["success"], json!(true));
    let request = requests.recv().expect("uninstall request");
    assert_eq!(request.path, "/api/marketplaces/skills/uninstall");

    let removed = call_tool_json!(
        client,
        "remove_marketplace",
        args(&[
            ("marketplace_id", json!("trustkit")),
            ("remove_installed_skills", json!(true)),
        ])
    )?;
    assert_eq!(removed["success"], json!(true));
    let request = requests.recv().expect("remove request");
    assert_eq!(request.path, "/api/marketplaces/remove");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "marketplace_id": "trustkit",
            "remove_installed_skills": true,
        })
    );

    client.cancel().await?;
    Ok(())
}

// Destructive-sync second phase: the confirm gate answers WITHOUT touching the
// Electron API, and a confirmed call proxies the exact removal payload.
#[tokio::test]
async fn stdio_apply_sync_removals_requires_confirm_then_proxies() -> Result<()> {
    let root = TempRoot::new("apply-sync-removals")?;

    let (base, requests) = serve_responses(vec![MockReply {
        status: "200 OK",
        body: json!({
            "success": true,
            "removed": [{"skillId": "accessibility-quality", "pluginName": "ux-quality-beta"}],
            "skipped": [],
            "agentsUpdated": [],
            "agentsFlagged": [{"id": "agent-ro", "name": "RO Agent"}],
            "agentsSkipped": [],
        }),
    }]);

    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_skills-server"));
    command.current_dir(&root.path);
    command.env("CONTAINER_PROJECT_ROOT", &root.path);
    command.env("HOST_PROJECT_ROOT", &root.path);
    command.env("CORE_MCP_TEST_REDIS", "memory");
    command.env("ELECTRON_API_BASE", &base);

    let transport = TokioChildProcess::new(command)?;
    let client = ().serve(transport).await?;

    let removals = json!([{ "skillId": "accessibility-quality", "pluginName": "ux-quality-beta" }]);

    // 1) Gate: confirm absent → soft failure envelope, no HTTP call consumed.
    let gated = call_tool_json!(
        client,
        "apply_marketplace_sync_removals",
        args(&[
            ("marketplace_id", json!("portico-ai-marketplace")),
            ("removals", removals.clone()),
        ])
    )?;
    assert_eq!(gated["success"], json!(false));
    assert!(
        gated["error"]
            .as_str()
            .unwrap_or_default()
            .contains("confirm=true"),
        "gate names the confirm contract: {gated}"
    );

    // 2) Confirmed: proxies POST with the exact payload; the mock's single
    // reply being consumed HERE also proves the gated call above never
    // reached the transport.
    let applied = call_tool_json!(
        client,
        "apply_marketplace_sync_removals",
        args(&[
            ("marketplace_id", json!("portico-ai-marketplace")),
            ("removals", removals.clone()),
            ("confirm", json!(true)),
        ])
    )?;
    assert_eq!(applied["success"], json!(true));
    assert_eq!(applied["agentsFlagged"][0]["id"], json!("agent-ro"));

    let request = requests.recv().expect("apply request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/marketplaces/apply-sync-removals");
    let body: Value = serde_json::from_str(&request.body)?;
    assert_eq!(body["marketplace_id"], json!("portico-ai-marketplace"));
    assert_eq!(body["removals"], removals);

    client.cancel().await?;
    Ok(())
}
