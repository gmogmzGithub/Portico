use super::tests::{args, response_payload, write_zip, EnvGuard, TestEnv};
use super::*;
use crate::native::shared::ToolDispatcher;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

#[derive(Debug)]
struct CapturedRequest {
    method: String,
    path: String,
    body: String,
}

fn read_http_request(stream: &mut std::net::TcpStream) -> CapturedRequest {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("set read timeout");
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
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);

    let mut body_bytes = buffer[header_end..].to_vec();
    while body_bytes.len() < content_length {
        let read = stream.read(&mut chunk).expect("read body");
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

fn serve_sensitive_info_flow(secret: &'static str) -> (String, mpsc::Receiver<CapturedRequest>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let base = format!("http://{}", listener.local_addr().expect("listener addr"));
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let replies = vec![
            json!({
                "success": true,
                "started": true,
                "flow_id": "sensitive-flow-123",
                "timeout_seconds": 120
            }),
            json!({
                "success": true,
                "flow_id": "sensitive-flow-123",
                "status": "completed",
                "result": {
                    "success": true,
                    "status": "submitted",
                    "flow_id": "sensitive-flow-123",
                    "sensitive_value": secret,
                    "message": "Sensitive information submitted."
                }
            }),
        ];
        for reply in replies {
            let (mut stream, _) = listener.accept().expect("accept request");
            let request = read_http_request(&mut stream);
            let _ = tx.send(request);
            let body = serde_json::to_vec(&reply).expect("encode reply");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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

fn serve_chat_workspace_consent_flow(result: Value) -> (String, mpsc::Receiver<CapturedRequest>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let base = format!("http://{}", listener.local_addr().expect("listener addr"));
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let replies = vec![
            json!({
                "success": true,
                "started": true,
                "flow_id": "workspace-flow-123",
                "timeout_seconds": 120,
                "display_path": "~/Selected Workspace"
            }),
            json!({
                "success": true,
                "flow_id": "workspace-flow-123",
                "status": "completed",
                "result": result
            }),
        ];
        for reply in replies {
            let (mut stream, _) = listener.accept().expect("accept request");
            let request = read_http_request(&mut stream);
            let _ = tx.send(request);
            let body = serde_json::to_vec(&reply).expect("encode reply");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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

#[tokio::test]
async fn workspace_handlers_cover_copy_write_links_search_and_unzip() {
    let env = TestEnv::new("workspace");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);
    let shared_root = workspace_root_for_ids("chat-1", "vm-1").unwrap();
    fs::create_dir_all(shared_root.join("input")).unwrap();
    fs::write(shared_root.join("input/source.txt"), "workspace source").unwrap();
    fs::create_dir_all(shared_root.join("images")).unwrap();
    fs::write(
        shared_root.join("images/picture.png"),
        b"\x89PNG\r\n\x1a\nPNGDATA",
    )
    .unwrap();
    write_zip(
        &root.join("bundle.zip"),
        &[
            ("root/data.txt", b"zip-data"),
            ("root/more/info.txt", b"more"),
        ],
    );

    let copied_in = response_payload(
        handle_copy_from_workspace(&args(&[
            ("vm_id", json!("vm-1")),
            ("workspace_path", json!("input/source.txt")),
            ("vm_path", json!("/work/copied/source.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(copied_in["vm_path"], json!("/work/copied/source.txt"));
    assert_eq!(
        fs::read_to_string(root.join("copied/source.txt")).unwrap(),
        "workspace source"
    );

    let copied_out = response_payload(
        handle_copy_to_workspace(&args(&[
            ("vm_id", json!("vm-1")),
            ("vm_path", json!("/work/copied/source.txt")),
            ("workspace_path", json!("output/copied.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(copied_out["success"], json!(true));
    assert_eq!(copied_out["workspace_path"], json!("output/copied.txt"));
    assert_eq!(copied_out["vm_path"], json!("/work/copied/source.txt"));

    let other_chat_list = response_payload(
        handle_list_workspace_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("chat_id", json!("other-chat")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(other_chat_list["success"], json!(true));
    assert_eq!(other_chat_list["count"], json!(0));

    let listed = response_payload(
        handle_list_workspace_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("chat_id", json!("chat-1")),
            ("directory", json!("all")),
        ]))
        .await
        .unwrap(),
    );
    assert!(listed["count"].as_u64().unwrap() >= 2);

    let wrote_text = response_payload(
        handle_write_to_workspace(&args(&[
            ("chat_id", json!("chat-1")),
            ("path", json!("input/notes.txt")),
            ("content", json!("plain text")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(wrote_text["size"], json!(10));
    assert_eq!(wrote_text["message"], json!("File written successfully."));

    let wrote_binary = response_payload(
        handle_write_to_workspace(&args(&[
            ("chat_id", json!("chat-1")),
            ("path", json!("output/bytes.bin")),
            ("content", json!(BASE64_STANDARD.encode([1_u8, 2, 3]))),
            ("is_base64", json!(true)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(wrote_binary["size"], json!(3));

    let other_chat_write = response_payload(
        handle_write_to_workspace(&args(&[
            ("chat_id", json!("other-chat")),
            ("path", json!("bad.txt")),
            ("content", json!("nope")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(other_chat_write["success"], json!(true));
    assert_eq!(
        fs::read_to_string(
            workspace_root_for_ids("other-chat", "vm-1")
                .unwrap()
                .join("bad.txt")
        )
        .unwrap(),
        "nope"
    );

    let invalid_base64 = response_payload(
        handle_write_to_workspace(&args(&[
            ("chat_id", json!("chat-1")),
            ("path", json!("bad.bin")),
            ("content", json!("%%%")),
            ("is_base64", json!(true)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(invalid_base64["success"], json!(false));
    assert!(invalid_base64["error"]
        .as_str()
        .unwrap()
        .contains("Invalid base64 content"));

    let link_value = handle_get_workspace_file_link(&args(&[
        ("vm_id", json!("vm-1")),
        ("file_path", json!("/work/images/picture.png")),
    ]))
    .await
    .unwrap();
    let link = response_payload(link_value.clone());
    assert_eq!(link["success"], json!(true));
    assert!(link.get("inline_image_included").is_none());
    assert_eq!(link["is_image"], json!(true));
    assert_eq!(link_value["content"].as_array().unwrap().len(), 1);
    assert_eq!(link_value["content"][0]["type"], json!("text"));
    assert!(!serde_json::to_string(&link_value)
        .unwrap()
        .contains("\"data\""));

    let displayed = response_payload(
        handle_display_files(&args(&[
            ("vm_id", json!("vm-1")),
            (
                "file_paths",
                json!(["/work/images/picture.png", "/work/input/source.txt"]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(displayed["success"], json!(true));
    assert_eq!(displayed["display_files"], json!(true));
    let displayed_files = displayed["files"].as_array().unwrap();
    assert_eq!(displayed_files.len(), 2);
    assert_eq!(displayed_files[0]["is_image"], json!(true));
    assert_eq!(displayed_files[0]["model_image_url"], Value::Null);
    assert_eq!(
        displayed_files[0]["download_url"],
        json!("http://localhost:9876/workspace/chat-1/images/picture.png")
    );
    assert_eq!(
        displayed_files[0]["browser_url"],
        json!("http://localhost:9876/workspace/chat-1/images/picture.png?inline=1")
    );
    assert_eq!(displayed_files[0]["url"], displayed_files[0]["browser_url"]);
    assert_eq!(
        displayed_files[1]["browser_url"],
        displayed_files[1]["download_url"]
    );
    assert!(!serde_json::to_string(&displayed)
        .unwrap()
        .contains("base64"));

    let requested_images = response_payload(
        handle_request_images(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_paths", json!(["/work/images/picture.png"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(requested_images["success"], json!(true));
    assert_eq!(requested_images["request_images"], json!(true));
    let image = &requested_images["images"].as_array().unwrap()[0];
    assert_eq!(image["is_image"], json!(true));
    assert_eq!(
        image["download_url"],
        json!("http://localhost:9876/workspace/chat-1/images/picture.png")
    );
    assert_eq!(
        image["browser_url"],
        json!("http://localhost:9876/workspace/chat-1/images/picture.png?inline=1")
    );
    assert_eq!(
        image["url"],
        json!("http://localhost:9876/workspace/chat-1/images/picture.png?inline=1")
    );
    assert_eq!(
        image["model_image_url"],
        json!("http://host.docker.internal:9876/workspace/chat-1/images/picture.png")
    );
    assert!(image["model_image_url"]
        .as_str()
        .unwrap()
        .contains("/workspace/chat-1/images/picture.png"));
    assert!(!serde_json::to_string(&requested_images)
        .unwrap()
        .contains("base64"));

    let display_missing = response_payload(
        handle_display_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_paths", json!(["/work/images/missing.png"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(display_missing["success"], json!(false));
    assert!(display_missing["error"]
        .as_str()
        .unwrap()
        .contains("file does not exist"));

    let display_directory = response_payload(
        handle_display_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_paths", json!(["/work/images"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(display_directory["success"], json!(false));
    assert!(display_directory["error"]
        .as_str()
        .unwrap()
        .contains("directory"));

    let request_non_image = response_payload(
        handle_request_images(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_paths", json!(["/work/input/source.txt"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(request_non_image["success"], json!(false));
    assert!(request_non_image["error"]
        .as_str()
        .unwrap()
        .contains("only accepts image"));

    fs::write(
        shared_root.join("images/large.png"),
        vec![0_u8; MAX_INLINE_IMAGE_SIZE as usize + 1],
    )
    .unwrap();
    let request_large_image = response_payload(
        handle_request_images(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_paths", json!(["/work/images/large.png"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(request_large_image["success"], json!(false));
    assert!(request_large_image["error"]
        .as_str()
        .unwrap()
        .contains("too large"));

    let missing_link =
        response_payload(workspace_link_payload("chat-1", "vm-1", "missing.txt").unwrap());
    assert_eq!(missing_link["success"], json!(false));

    let other_chat_link = response_payload(
        handle_get_workspace_file_link(&args(&[
            ("chat_id", json!("other-chat")),
            ("file_path", json!("bad.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(other_chat_link["success"], json!(false));

    let unzip = response_payload(
        handle_unzip_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("zip_path", json!("/work/bundle.zip")),
            ("dest_path", json!("/work/unpacked")),
            ("strip_components", json!(1)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(unzip["success"], json!(true));
    assert_eq!(unzip["files_extracted"], json!("2"));
    assert_eq!(
        fs::read_to_string(root.join("unpacked/data.txt")).unwrap(),
        "zip-data"
    );

    fs::write(root.join("search-one.txt"), "alpha beta gamma").unwrap();
    fs::write(root.join("search-two.log"), "beta beta").unwrap();
    let find = response_payload(
        handle_find_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("pattern", json!("*.txt")),
            ("path", json!("/work")),
            ("max_results", json!(10)),
        ]))
        .await
        .unwrap(),
    );
    assert!(find["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item == "/work/search-one.txt"));
    let invalid_find = response_payload(
        handle_find_files(&args(&[("vm_id", json!("vm-1")), ("pattern", json!("["))]))
            .await
            .unwrap(),
    );
    assert_eq!(invalid_find["success"], json!(false));

    let search_content = response_payload(
        handle_grep(&args(&[
            ("vm_id", json!("vm-1")),
            ("pattern", json!("beta")),
            ("path", json!("/work")),
            ("file_pattern", json!("*.txt")),
            ("output_mode", json!("content")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(search_content["matches"].as_array().unwrap().len(), 1);

    let grep_count = response_payload(
        handle_grep(&args(&[
            ("vm_id", json!("vm-1")),
            ("pattern", json!("beta")),
            ("path", json!("/work")),
            ("output_mode", json!("count")),
        ]))
        .await
        .unwrap(),
    );
    assert!(grep_count["counts"]
        .as_object()
        .unwrap()
        .values()
        .any(|item| item.as_u64().unwrap() >= 1));

    let grep_files = response_payload(
        handle_grep(&args(&[
            ("vm_id", json!("vm-1")),
            ("pattern", json!("beta")),
            ("path", json!("/work")),
            ("output_mode", json!("files")),
            ("max_results", json!(1)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(grep_files["files"].as_array().unwrap().len(), 1);
    let invalid_grep = response_payload(
        handle_grep(&args(&[("vm_id", json!("vm-1")), ("pattern", json!("("))]))
            .await
            .unwrap(),
    );
    assert_eq!(invalid_grep["success"], json!(false));
}

#[tokio::test]
async fn request_sensitive_information_stores_file_metadata_and_redacts_outputs() {
    let env = TestEnv::new("sensitive-info");
    let vm = env.seed_vm("vm-sensitive", "chat-sensitive");
    store_default_vm_mapping(&vm).unwrap();

    let missing_prompt =
        handle_request_sensitive_information(&args(&[("chat_id", json!("chat-sensitive"))]))
            .await
            .unwrap_err();
    assert!(missing_prompt.to_string().contains("prompt is required"));

    let wrong_chat = response_payload(
        handle_request_sensitive_information(&args(&[
            ("chat_id", json!("other-chat")),
            ("vm_id", json!("vm-sensitive")),
            ("prompt", json!("Enter the test API key.")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(wrong_chat["success"], json!(false));
    assert!(wrong_chat["error"]
        .as_str()
        .unwrap()
        .contains("VM vm-sensitive belongs to chat chat-sensitive, not other-chat"));

    let bad_timeout = handle_request_sensitive_information(&args(&[
        ("chat_id", json!("chat-sensitive")),
        ("prompt", json!("Enter the test API key.")),
        ("timeout_seconds", json!(1)),
    ]))
    .await
    .unwrap_err();
    assert!(bad_timeout
        .to_string()
        .contains("timeout_seconds must be between"));

    let oversized_preamble = handle_request_sensitive_information(&args(&[
        ("chat_id", json!("chat-sensitive")),
        ("prompt", json!("Enter the test API key.")),
        ("preamble", json!("x".repeat(4001))),
    ]))
    .await
    .unwrap_err();
    assert!(oversized_preamble
        .to_string()
        .contains("preamble must be 4000 characters or fewer"));

    let secret = "sk-live-do-not-return-123";
    let (base, requests) = serve_sensitive_info_flow(secret);
    let _electron_guard = EnvGuard::set(&[("ELECTRON_API_BASE", Some(base.as_str()))]);

    let result = response_payload(
        handle_request_sensitive_information(&args(&[
            ("chat_id", json!("chat-sensitive")),
            ("vm_id", json!("vm-sensitive")),
            ("prompt", json!("Enter the test API key.")),
            (
                "preamble",
                json!("1. [Open settings](https://example.test/settings).\n2. Generate a key."),
            ),
            ("label", json!("API Key")),
            ("timeout_seconds", json!(120)),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(result["success"], json!(true));
    assert_eq!(result["chat_id"], json!("chat-sensitive"));
    assert_eq!(result["vm_id"], json!("vm-sensitive"));
    assert_eq!(result["ttl_seconds"], json!(900));
    let rendered_result = serde_json::to_string(&result).unwrap();
    assert!(!rendered_result.contains(secret));
    let vm_path = result["vm_path"].as_str().unwrap();
    assert!(vm_path.starts_with("/work/.sensitive/api-key-"));
    assert!(vm_path.ends_with(".txt"));

    let file_path = vm_host_path(&vm, vm_path).unwrap();
    assert_eq!(fs::read_to_string(&file_path).unwrap(), secret);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&file_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let metadata_dir = core_mcp_shared::app_support_dir()
        .unwrap()
        .join("agent-vm-sensitive-info");
    let metadata_files = fs::read_dir(&metadata_dir)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(metadata_files.len(), 1);
    let metadata_path = metadata_files[0].path();
    let mut metadata: Value =
        serde_json::from_str(&fs::read_to_string(&metadata_path).unwrap()).unwrap();
    assert_eq!(metadata["chat_id"], json!("chat-sensitive"));
    assert_eq!(metadata["relative_path"], result["relative_path"]);
    assert!(!fs::read_to_string(&metadata_path).unwrap().contains(secret));

    let direct_read = response_payload(
        handle_read_file(&args(&[
            ("vm_id", json!("vm-sensitive")),
            ("path", json!(vm_path)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(direct_read["success"], json!(false));
    assert!(direct_read["error"]
        .as_str()
        .unwrap()
        .contains("Sensitive workspace files cannot be read directly"));

    let link = response_payload(
        handle_get_workspace_file_link(&args(&[
            ("vm_id", json!("vm-sensitive")),
            ("file_path", json!(vm_path)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(link["success"], json!(false));
    assert!(link["error"]
        .as_str()
        .unwrap()
        .contains("Sensitive workspace files cannot be linked"));

    let redacted = redact_agent_vm_sensitive_values(
        &args(&[("vm_id", json!("vm-sensitive"))]),
        success_text(json!({
            "success": true,
            "stdout": format!("token={secret}"),
            "stderr": secret,
            "nested": {"value": format!("before {secret} after")}
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let redacted_payload = response_payload(redacted);
    let rendered_redacted = serde_json::to_string(&redacted_payload).unwrap();
    assert!(!rendered_redacted.contains(secret));
    assert!(rendered_redacted.contains("[REDACTED SENSITIVE INFORMATION]"));

    metadata["expires_at"] = json!(0.0);
    fs::write(
        &metadata_path,
        serde_json::to_string_pretty(&metadata).unwrap(),
    )
    .unwrap();
    assert_eq!(
        cleanup_expired_sensitive_info_files_once().await.unwrap(),
        1
    );
    assert!(!file_path.exists());
    assert!(!metadata_path.exists());

    let request_1 = requests.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(request_1.method, "POST");
    assert_eq!(request_1.path, "/api/trigger-sensitive-info-flow");
    let request_payload: Value = serde_json::from_str(&request_1.body).unwrap();
    assert_eq!(request_payload["prompt"], json!("Enter the test API key."));
    assert_eq!(
        request_payload["preamble"],
        json!("1. [Open settings](https://example.test/settings).\n2. Generate a key.")
    );
    assert!(!request_1.body.contains(secret));
    let request_2 = requests.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(request_2.method, "GET");
    assert_eq!(
        request_2.path,
        "/api/sensitive-info-flow-status/sensitive-flow-123"
    );
}

#[tokio::test]
async fn request_sensitive_information_uses_custom_vm_workspace_outside_runtime_workspaces() {
    let env = TestEnv::new("sensitive-info-custom-workspace");
    let host_root = env.root.join("host-project-root");
    let container_root = env.root.join("container-project-root");
    let workspace_cfg = env.root.join("workspace-cfg");
    let custom = env.root.join("external").join(".snowflake");
    fs::create_dir_all(&host_root).unwrap();
    fs::create_dir_all(&container_root).unwrap();
    fs::create_dir_all(&workspace_cfg).unwrap();
    fs::create_dir_all(&custom).unwrap();
    fs::write(
        workspace_cfg.join("chat-workspaces.json"),
        json!({
            "chats": {
                "chat-custom-sensitive": {
                    "source": "custom",
                    "host_path": custom.display().to_string()
                }
            }
        })
        .to_string(),
    )
    .unwrap();

    let secret = "snowflake-pat-do-not-return";
    let (base, _requests) = serve_sensitive_info_flow(secret);
    let _guard = EnvGuard::set(&[
        ("HOST_PROJECT_ROOT", Some(host_root.to_str().unwrap())),
        (
            "CONTAINER_PROJECT_ROOT",
            Some(container_root.to_str().unwrap()),
        ),
        (
            "PORTICO_WORKSPACE_CFG_DIR",
            Some(workspace_cfg.to_str().unwrap()),
        ),
        ("ELECTRON_API_BASE", Some(base.as_str())),
    ]);

    assert!(local_workspace_path(&custom).is_err());
    let vm = env.seed_vm("vm-sensitive-custom", "chat-custom-sensitive");
    assert_eq!(
        vm.work_bind_source.as_deref(),
        Some(custom.to_string_lossy().as_ref())
    );
    assert_eq!(resolve_work_bind_source(&vm).unwrap(), custom);

    let result = response_payload(
        handle_request_sensitive_information(&args(&[
            ("chat_id", json!("chat-custom-sensitive")),
            ("vm_id", json!("vm-sensitive-custom")),
            ("prompt", json!("Paste your Snowflake PAT.")),
            ("label", json!("Snowflake PAT")),
            ("timeout_seconds", json!(120)),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(result["success"], json!(true));
    assert_eq!(result["chat_id"], json!("chat-custom-sensitive"));
    assert_eq!(result["vm_id"], json!("vm-sensitive-custom"));
    let rendered_result = serde_json::to_string(&result).unwrap();
    assert!(!rendered_result.contains(secret));

    let vm_path = result["vm_path"].as_str().unwrap();
    assert!(vm_path.starts_with("/work/.sensitive/snowflake-pat-"));
    assert!(vm_path.ends_with(".txt"));
    let relative = vm_path.trim_start_matches("/work").trim_start_matches('/');
    let file_path = custom.join(relative);
    assert_eq!(fs::read_to_string(&file_path).unwrap(), secret);
    assert!(!host_root
        .join("workspaces/chat-custom-sensitive/.sensitive")
        .exists());

    let metadata_dir = core_mcp_shared::app_support_dir()
        .unwrap()
        .join("agent-vm-sensitive-info");
    let metadata_files = fs::read_dir(&metadata_dir)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(metadata_files.len(), 1);
    let metadata_path = metadata_files[0].path();
    let mut metadata: Value =
        serde_json::from_str(&fs::read_to_string(&metadata_path).unwrap()).unwrap();
    assert_eq!(metadata["chat_id"], json!("chat-custom-sensitive"));
    assert_eq!(metadata["vm_id"], json!("vm-sensitive-custom"));
    assert_eq!(metadata["relative_path"], result["relative_path"]);
    assert!(!fs::read_to_string(&metadata_path).unwrap().contains(secret));

    let redacted = redact_agent_vm_sensitive_values(
        &args(&[("vm_id", json!("vm-sensitive-custom"))]),
        success_text(json!({
            "success": true,
            "stdout": format!("token={secret}"),
            "stderr": secret,
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let rendered_redacted = serde_json::to_string(&response_payload(redacted)).unwrap();
    assert!(!rendered_redacted.contains(secret));
    assert!(rendered_redacted.contains("[REDACTED SENSITIVE INFORMATION]"));

    metadata["expires_at"] = json!(0.0);
    fs::write(
        &metadata_path,
        serde_json::to_string_pretty(&metadata).unwrap(),
    )
    .unwrap();
    assert_eq!(
        cleanup_expired_sensitive_info_files_once().await.unwrap(),
        1
    );
    assert!(!file_path.exists());
    assert!(!metadata_path.exists());
}

#[tokio::test]
async fn set_chat_workspace_posts_consent_flow_and_returns_applied_result() {
    let env = TestEnv::new("set-chat-workspace");
    let host_path = env.root.join(".snowflake");
    let (base, requests) = serve_chat_workspace_consent_flow(json!({
        "success": true,
        "status": "applied",
        "flow_id": "workspace-flow-123",
        "chat_id": "chat-workspace",
        "host_path": host_path.display().to_string(),
        "display_path": "~/.snowflake",
        "selection": {
            "chatId": "chat-workspace",
            "isCustom": true,
            "hostPath": host_path.display().to_string()
        },
        "rebind": {
            "success": true,
            "reboundCount": 0
        }
    }));
    let _electron_guard = EnvGuard::set(&[
        ("ELECTRON_API_BASE", Some(base.as_str())),
        ("HOME", Some("/app/mcpo-runtime-homes/core/agent-vm")),
    ]);

    let result = response_payload(
        handle_set_chat_workspace(&args(&[
            ("chat_id", json!("chat-workspace")),
            ("host_path", json!("~/.snowflake")),
            (
                "preamble",
                json!("Snowflake setup needs **folder access** before inspecting configuration."),
            ),
            ("timeout_seconds", json!(120)),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(result["success"], json!(true));
    assert_eq!(result["status"], json!("applied"));
    assert_eq!(result["selection"]["isCustom"], json!(true));

    let request = requests.recv().expect("trigger request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/trigger-chat-workspace-consent-flow");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        json!({
            "chat_id": "chat-workspace",
            "host_path": "~/.snowflake",
            "preamble": "Snowflake setup needs **folder access** before inspecting configuration.",
            "timeout_seconds": 120
        })
    );

    let request = requests.recv().expect("poll request");
    assert_eq!(request.method, "GET");
    assert_eq!(
        request.path,
        "/api/chat-workspace-consent-flow-status/workspace-flow-123"
    );
}

#[tokio::test]
async fn set_chat_workspace_preserves_home_relative_project_path_for_electron() {
    let env = TestEnv::new("set-chat-workspace-home-project");
    let host_path = env.root.join("Projects/foo");
    let (base, requests) = serve_chat_workspace_consent_flow(json!({
        "success": true,
        "status": "applied",
        "flow_id": "workspace-flow-123",
        "chat_id": "chat-workspace",
        "host_path": host_path.display().to_string(),
        "display_path": "~/Projects/foo"
    }));
    let _electron_guard = EnvGuard::set(&[
        ("ELECTRON_API_BASE", Some(base.as_str())),
        ("HOME", Some("/app/mcpo-runtime-homes/core/agent-vm")),
    ]);

    let result = response_payload(
        handle_set_chat_workspace(&args(&[
            ("chat_id", json!("chat-workspace")),
            ("host_path", json!("~/Projects/foo")),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(result["success"], json!(true));
    assert_eq!(result["status"], json!("applied"));

    let request = requests.recv().expect("trigger request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/api/trigger-chat-workspace-consent-flow");
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap()["host_path"],
        json!("~/Projects/foo")
    );
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap()["preamble"],
        Value::Null
    );
}

#[tokio::test]
async fn set_chat_workspace_validates_optional_preamble_before_calling_electron() {
    let oversized = handle_set_chat_workspace(&args(&[
        ("chat_id", json!("chat-workspace")),
        ("host_path", json!("~/.snowflake")),
        ("preamble", json!("x".repeat(4001))),
    ]))
    .await
    .unwrap_err();
    assert!(oversized
        .to_string()
        .contains("preamble must be 4000 characters or fewer"));

    let wrong_type = handle_set_chat_workspace(&args(&[
        ("chat_id", json!("chat-workspace")),
        ("host_path", json!("~/.snowflake")),
        ("preamble", json!(42)),
    ]))
    .await
    .unwrap_err();
    assert!(wrong_type.to_string().contains("preamble must be a string"));
}

#[tokio::test]
async fn set_chat_workspace_rejects_unsupported_tilde_user_path() {
    let error = handle_set_chat_workspace(&args(&[
        ("chat_id", json!("chat-workspace")),
        ("host_path", json!("~other/workspace")),
    ]))
    .await
    .unwrap_err();

    assert!(error
        .to_string()
        .contains("host_path uses unsupported '~user' expansion"));
}

#[tokio::test]
async fn set_chat_workspace_rejects_relative_path_before_calling_electron() {
    let error = handle_set_chat_workspace(&args(&[
        ("chat_id", json!("chat-workspace")),
        ("host_path", json!("relative/workspace")),
    ]))
    .await
    .unwrap_err();

    assert!(error
        .to_string()
        .contains("host_path must be an absolute path"));
}

#[tokio::test]
async fn set_chat_workspace_rejects_internal_container_path_before_calling_electron() {
    let error = handle_set_chat_workspace(&args(&[
        ("chat_id", json!("chat-workspace")),
        (
            "host_path",
            json!("/app/mcpo-runtime-homes/core/agent-vm/.snowflake"),
        ),
    ]))
    .await
    .unwrap_err();

    assert!(error
        .to_string()
        .contains("host_path points to an internal container path"));
}

#[tokio::test]
async fn set_chat_workspace_returns_non_success_for_timeout_result() {
    let env = TestEnv::new("set-chat-workspace-timeout");
    let host_path = env.root.join("Selected Workspace");
    let (base, _requests) = serve_chat_workspace_consent_flow(json!({
        "success": false,
        "status": "timeout",
        "flow_id": "workspace-flow-123",
        "chat_id": "chat-workspace",
        "host_path": host_path.display().to_string(),
        "display_path": "~/Selected Workspace",
        "error": "User did not approve the workspace change before the modal timed out"
    }));
    let _electron_guard = EnvGuard::set(&[("ELECTRON_API_BASE", Some(base.as_str()))]);

    let result = response_payload(
        handle_set_chat_workspace(&args(&[
            ("chat_id", json!("chat-workspace")),
            ("host_path", json!(host_path.display().to_string())),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(result["success"], json!(false));
    assert_eq!(result["status"], json!("timeout"));
}

#[tokio::test]
async fn dispatcher_keeps_workspace_file_links_link_only() {
    let env = TestEnv::new("workspace-link-only");
    env.seed_vm("vm-1", "chat-1");
    let shared_root = workspace_root_for_ids("chat-1", "vm-1").unwrap();
    fs::create_dir_all(shared_root.join("images")).unwrap();
    fs::write(
        shared_root.join("images/picture.png"),
        b"\x89PNG\r\n\x1a\nPNGDATA",
    )
    .unwrap();

    let dispatcher = crate::native::Dispatcher;
    let response = dispatcher
        .call(
            "get_workspace_file_link",
            &args(&[
                ("vm_id", json!("vm-1")),
                ("chat_id", json!("chat-1")),
                ("file_path", json!("images/picture.png")),
            ]),
        )
        .await
        .unwrap()
        .unwrap();
    let payload = response_payload(response.clone());
    assert_eq!(payload["success"], json!(true));
    assert!(payload.get("inline_image_included").is_none());
    assert_eq!(payload["is_image"], json!(true));
    assert_eq!(payload["vm_id"], json!("vm-1"));
    assert_eq!(payload["vm_id_changed"], json!(false));
    assert_eq!(response["content"].as_array().unwrap().len(), 1);
    assert_eq!(response["content"][0]["type"], json!("text"));
}

#[test]
fn workspace_payload_helpers_cover_not_found_directory_and_tmp_image_branches() {
    let env = TestEnv::new("workspace-payloads");
    let vm = env.seed_vm("vm-1", "chat-1");
    let workspace_root = workspace_root_for_ids("chat-1", "vm-1").unwrap();
    fs::create_dir_all(workspace_root.join("images")).unwrap();
    fs::write(
        workspace_root.join("images/pic.png"),
        b"\x89PNG\r\n\x1a\npayload",
    )
    .unwrap();

    let missing =
        response_payload(workspace_link_payload("chat-1", "vm-1", "missing.txt").unwrap());
    assert_eq!(missing["success"], json!(false));
    assert_eq!(missing["error"], json!("File does not exist"));

    let directory = response_payload(workspace_link_payload("chat-1", "vm-1", "images").unwrap());
    assert_eq!(directory["success"], json!(false));
    assert_eq!(directory["error"], json!("Path is a directory, not a file"));

    let payload =
        workspace_file_payload(&vm, "images/pic.png", "Image ready.", Some("/tmp/pic.png"))
            .unwrap();
    let structured = response_payload(payload);
    assert_eq!(structured["success"], json!(true));
    assert_eq!(structured["vm_path"], json!("/tmp/pic.png"));
    assert_eq!(structured["is_image"], json!(true));
    assert_eq!(
        structured["visual_analysis_requires_image_input"],
        json!(true)
    );
    assert!(structured["message"]
        .as_str()
        .unwrap()
        .contains("agent_vm_display_files"));
    assert!(structured["message"]
        .as_str()
        .unwrap()
        .contains("agent_vm_request_images"));
    assert!(structured["message"]
        .as_str()
        .unwrap()
        .contains("markdown links alone do not provide pixels"));
}

#[tokio::test]
async fn copy_handlers_cover_missing_vm_failure_and_warning_paths() {
    let env = TestEnv::new("copy-errors");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);
    fs::write(root.join("source.txt"), "vm source").unwrap();
    let shared_root = workspace_root_for_ids("chat-1", "vm-1").unwrap();
    fs::create_dir_all(shared_root.join("input")).unwrap();
    fs::write(shared_root.join("input/source.txt"), "workspace source").unwrap();

    let missing_copy_from = response_payload(handle_copy_from_workspace(&args(&[])).await.unwrap());
    assert_eq!(
        missing_copy_from["error"],
        json!("vm_id and workspace_path are required")
    );

    let no_vm_copy_from = response_payload(
        handle_copy_from_workspace(&args(&[
            ("vm_id", json!("missing")),
            ("workspace_path", json!("input/source.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(no_vm_copy_from["success"], json!(false));

    let missing_source = response_payload(
        handle_copy_from_workspace(&args(&[
            ("vm_id", json!("vm-1")),
            ("workspace_path", json!("input/missing.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_source["success"], json!(false));

    let missing_copy_to = response_payload(handle_copy_to_workspace(&args(&[])).await.unwrap());
    assert_eq!(
        missing_copy_to["error"],
        json!("vm_id, vm_path, and workspace_path are required")
    );

    let no_vm_copy_to = response_payload(
        handle_copy_to_workspace(&args(&[
            ("vm_id", json!("missing")),
            ("vm_path", json!("/work/source.txt")),
            ("workspace_path", json!("output/source.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(no_vm_copy_to["success"], json!(false));

    let missing_vm_path = response_payload(
        handle_copy_to_workspace(&args(&[
            ("vm_id", json!("vm-1")),
            ("vm_path", json!("/work/missing.txt")),
            ("workspace_path", json!("output/missing.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_vm_path["success"], json!(false));

    let warning_copy = response_payload(
        handle_copy_to_workspace(&args(&[
            ("vm_id", json!("vm-1")),
            ("vm_path", json!("/work/source.txt")),
            ("workspace_path", json!("nested\\copied.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(warning_copy["success"], json!(true));
    assert_eq!(
        fs::read_to_string(
            workspace_root_for_ids("chat-1", "vm-1")
                .unwrap()
                .join("nested/copied.txt"),
        )
        .unwrap(),
        "vm source"
    );
}

#[tokio::test]
async fn workspace_handlers_use_container_workspace_when_host_root_differs() {
    let env_ctx = TestEnv::new("workspace-container-root-parity");
    let divergent_host_root = env_ctx.root.join("host-project-root");
    fs::create_dir_all(&divergent_host_root).unwrap();
    env::set_var("HOST_PROJECT_ROOT", &divergent_host_root);

    let vm = env_ctx.seed_vm("vm-1", "chat-1");
    let shared_container_root = workspace_root_for_ids("chat-1", "vm-1").unwrap();
    let private_root = vm_workspace_root(&vm);
    let host_only_root = divergent_host_root.join("workspaces/chat-1");

    let wrote_workspace = response_payload(
        handle_write_to_workspace(&args(&[
            ("chat_id", json!("chat-1")),
            ("path", json!("output/message.txt")),
            ("content", json!("workspace hello")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(wrote_workspace["success"], json!(true));
    assert_eq!(
        fs::read_to_string(shared_container_root.join("output/message.txt")).unwrap(),
        "workspace hello"
    );
    assert!(!host_only_root.join("output/message.txt").exists());

    let copied_from_workspace = response_payload(
        handle_copy_from_workspace(&args(&[
            ("vm_id", json!("vm-1")),
            ("workspace_path", json!("output/message.txt")),
            ("vm_path", json!("copied/message.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(copied_from_workspace["success"], json!(true));
    assert_eq!(
        fs::read_to_string(private_root.join("copied/message.txt")).unwrap(),
        "workspace hello"
    );

    let workspace_link = response_payload(
        handle_get_workspace_file_link(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_path", json!("/work/output/message.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(workspace_link["success"], json!(true));
    assert!(workspace_link["download_url"]
        .as_str()
        .unwrap()
        .contains("/workspace/chat-1/output/message.txt"));
}

#[tokio::test]
async fn get_workspace_file_link_uses_vm_work_stat_for_custom_workspace_root_file() {
    let env = TestEnv::new("workspace-link-custom-root");
    let workspace_cfg = env.root.join("workspace-cfg");
    let custom = env.root.join("selected workspace");
    fs::create_dir_all(&custom).unwrap();
    fs::create_dir_all(&workspace_cfg).unwrap();
    fs::write(
        workspace_cfg.join("chat-workspaces.json"),
        json!({
            "chats": {
                "chat-custom": {
                    "source": "custom",
                    "host_path": custom.display().to_string()
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    let _guard = EnvGuard::set(&[(
        "PORTICO_WORKSPACE_CFG_DIR",
        Some(workspace_cfg.to_str().unwrap()),
    )]);

    let vm = env.seed_vm("vm-custom", "chat-custom");
    assert_eq!(vm_workspace_root(&vm), custom);
    fs::write(custom.join("Portico-Deck.pptx"), b"pptx bytes").unwrap();
    assert!(!env
        .root
        .join("workspaces/chat-custom/Portico-Deck.pptx")
        .exists());

    let link_value = handle_get_workspace_file_link(&args(&[
        ("vm_id", json!("vm-custom")),
        ("file_path", json!("Portico-Deck.pptx")),
    ]))
    .await
    .unwrap();
    let link = response_payload(link_value.clone());
    assert_eq!(link["success"], json!(true));
    assert_eq!(link["file_name"], json!("Portico-Deck.pptx"));
    assert_eq!(link["file_path"], json!("Portico-Deck.pptx"));
    assert_eq!(link["file_size"], json!(10));
    assert_eq!(link["chat_id"], json!("chat-custom"));
    assert_eq!(link["vm_id"], json!("vm-custom"));
    assert_eq!(
        link["download_url"],
        json!("http://localhost:9876/workspace/chat-custom/Portico-Deck.pptx")
    );
    assert_eq!(
        link["markdown_link"],
        json!("[Download Portico-Deck.pptx](http://localhost:9876/workspace/chat-custom/Portico-Deck.pptx)")
    );
    assert!(link.get("inline_image_included").is_none());
    assert_eq!(link_value["content"].as_array().unwrap().len(), 1);
    assert_eq!(link_value["content"][0]["type"], json!("text"));
    assert!(!serde_json::to_string(&link_value)
        .unwrap()
        .contains("base64"));
}

#[tokio::test]
async fn workspace_handlers_encode_download_urls_for_nested_filenames() {
    let env = TestEnv::new("workspace-encoded-download-urls");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);
    fs::create_dir_all(root.join("reports")).unwrap();
    fs::write(root.join("reports/diagram (v2).md"), "mermaid graph").unwrap();

    let copied = response_payload(
        handle_copy_to_workspace(&args(&[
            ("vm_id", json!("vm-1")),
            ("vm_path", json!("/work/reports/diagram (v2).md")),
            (
                "workspace_path",
                json!("output/reports/Agg Disco Pipeline 2025 Overview (v2).md"),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(copied["success"], json!(true));
    assert_eq!(
        copied["download_url"],
        json!(
            "http://localhost:9876/workspace/chat-1/output/reports/Agg%20Disco%20Pipeline%202025%20Overview%20%28v2%29.md"
        )
    );
    assert_eq!(
        copied["markdown_link"],
        json!(
            "[Download Agg Disco Pipeline 2025 Overview (v2).md](http://localhost:9876/workspace/chat-1/output/reports/Agg%20Disco%20Pipeline%202025%20Overview%20%28v2%29.md)"
        )
    );

    let linked = response_payload(
        handle_get_workspace_file_link(&args(&[
            ("vm_id", json!("vm-1")),
            (
                "file_path",
                json!("/work/output/reports/Agg Disco Pipeline 2025 Overview (v2).md"),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(linked["success"], json!(true));
    assert_eq!(linked["download_url"], copied["download_url"]);
    assert_eq!(linked["markdown_link"], copied["markdown_link"]);
}

#[tokio::test]
async fn workspace_handlers_treat_same_path_aliases_as_noops() {
    let env = TestEnv::new("workspace-same-path");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);
    let shared_root = workspace_root_for_ids("chat-1", "vm-1").unwrap();
    let pdf_bytes = b"%PDF-1.4\n%same-path\n";
    fs::write(root.join("report.pdf"), pdf_bytes).unwrap();

    let copied_out = response_payload(
        handle_copy_to_workspace(&args(&[
            ("vm_id", json!("vm-1")),
            ("vm_path", json!("/work/report.pdf")),
            ("workspace_path", json!("report.pdf")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(copied_out["success"], json!(true));
    assert_eq!(copied_out["file_size"], json!(pdf_bytes.len() as u64));
    assert_eq!(fs::read(root.join("report.pdf")).unwrap(), pdf_bytes);
    assert_eq!(fs::read(shared_root.join("report.pdf")).unwrap(), pdf_bytes);

    fs::create_dir_all(shared_root.join("input")).unwrap();
    fs::write(shared_root.join("input/source.txt"), "workspace source").unwrap();
    let copied_in = response_payload(
        handle_copy_from_workspace(&args(&[
            ("vm_id", json!("vm-1")),
            ("workspace_path", json!("input/source.txt")),
            ("vm_path", json!("/work/input/source.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(copied_in["success"], json!(true));
    assert_eq!(
        fs::read_to_string(root.join("input/source.txt")).unwrap(),
        "workspace source"
    );
}

#[tokio::test]
async fn shared_workspace_handlers_hide_and_reject_live_private_vm_roots() {
    let env = TestEnv::new("workspace-private-root-guards");
    let vm = env.seed_vm("vm-1", "chat-1");
    let sibling_vm = env.seed_vm("vm-2", "chat-1");
    let shared_root = workspace_root_for_ids("chat-1", "vm-1").unwrap();
    fs::write(shared_root.join("visible.txt"), "shared").unwrap();
    fs::write(vm_workspace_root(&sibling_vm).join("secret.txt"), "secret").unwrap();
    fs::write(vm_workspace_root(&vm).join("export.txt"), "export").unwrap();

    let listed = response_payload(
        handle_list_workspace_files(&args(&[
            ("chat_id", json!("chat-1")),
            ("recursive", json!(false)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(listed["success"], json!(true));
    assert!(listed["files"]
        .as_array()
        .unwrap()
        .iter()
        .all(|entry| entry["name"] != json!("vm-2")));

    let hidden_private_root = response_payload(
        handle_list_workspace_files(&args(&[
            ("chat_id", json!("chat-1")),
            ("path", json!("vm-2")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(hidden_private_root["success"], json!(true));
    assert_eq!(hidden_private_root["count"], json!(0));

    let write_private = response_payload(
        handle_write_to_workspace(&args(&[
            ("chat_id", json!("chat-1")),
            ("path", json!("vm-2/new.txt")),
            ("content", json!("nope")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(write_private["success"], json!(false));
    assert!(write_private["error"]
        .as_str()
        .unwrap()
        .contains("private VM workspace"));

    let copy_from_private = response_payload(
        handle_copy_from_workspace(&args(&[
            ("vm_id", json!("vm-1")),
            ("workspace_path", json!("vm-2/secret.txt")),
            ("vm_path", json!("/work/copied.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(copy_from_private["success"], json!(false));
    assert!(copy_from_private["error"]
        .as_str()
        .unwrap()
        .contains("private VM workspace"));

    let copy_to_private = response_payload(
        handle_copy_to_workspace(&args(&[
            ("vm_id", json!("vm-1")),
            ("vm_path", json!("/work/export.txt")),
            ("workspace_path", json!("vm-2/export.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(copy_to_private["success"], json!(false));
    assert!(copy_to_private["error"]
        .as_str()
        .unwrap()
        .contains("private VM workspace"));

    let link_private = response_payload(
        handle_get_workspace_file_link(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_path", json!("/work/vm-2/secret.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(link_private["success"], json!(false));
    assert!(link_private["error"]
        .as_str()
        .unwrap()
        .contains("File does not exist"));
}

#[tokio::test]
async fn skill_execution_and_workspace_handlers_cover_error_paths() {
    let env = TestEnv::new("workspace-errors");
    let vm = env.seed_vm("vm-1", "chat-1");
    let skills_user = std::env::current_dir()
        .unwrap()
        .join("skills-user/demo-skill/scripts");
    fs::create_dir_all(&skills_user).unwrap();
    fs::write(
        skills_user.join("fail.py"),
        "import sys\nsys.stderr.write('boom')\nsys.exit(7)\n",
    )
    .unwrap();
    fs::write(
        skills_user.join("sleep.py"),
        "import time\ntime.sleep(2)\nprint('late')\n",
    )
    .unwrap();

    let missing_skill_args =
        response_payload(handle_execute_skill_script(&args(&[])).await.unwrap());
    assert_eq!(
        missing_skill_args["error"],
        json!("skill_name and script_name are required")
    );

    let missing_skill = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("/absolute-skill")),
            ("script_name", json!("run.py")),
            ("vm_id", json!("vm-1")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_skill["success"], json!(false));
    assert!(missing_skill["error"]
        .as_str()
        .unwrap()
        .contains("Skill directory not found"));

    let script_escape = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("demo-skill")),
            ("script_name", json!("../escape.py")),
            ("vm_id", json!("vm-1")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(script_escape["success"], json!(false));
    assert!(script_escape["error"]
        .as_str()
        .unwrap()
        .contains("Script not found"));

    let failed_execution = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("demo-skill")),
            ("script_name", json!("fail.py")),
            ("vm_id", json!("vm-1")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(failed_execution["success"], json!(false));
    assert_eq!(failed_execution["exit_code"], json!(7));
    assert_eq!(failed_execution["error"], json!("boom"));

    let timed_out = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("demo-skill")),
            ("script_name", json!("sleep.py")),
            ("vm_id", json!("vm-1")),
            ("timeout_seconds", json!(1)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(timed_out["success"], json!(false));
    assert_eq!(timed_out["error"], json!("Execution failed: timed out"));

    let missing_link_args =
        response_payload(handle_get_workspace_file_link(&args(&[])).await.unwrap());
    assert_eq!(
        missing_link_args["error"],
        json!("vm_id and file_path are required")
    );

    let bad_directory_write = response_payload(
        handle_write_to_workspace(&args(&[
            ("chat_id", json!("chat-1")),
            ("content", json!("nope")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(bad_directory_write["success"], json!(false));

    let missing_unzip_args = response_payload(handle_unzip_file(&args(&[])).await.unwrap());
    assert_eq!(
        missing_unzip_args["error"],
        json!("vm_id and zip_path are required")
    );

    let missing_unzip_vm = response_payload(
        handle_unzip_file(&args(&[
            ("vm_id", json!("missing")),
            ("zip_path", json!("/work/archive.zip")),
        ]))
        .await
        .unwrap(),
    );
    assert!(missing_unzip_vm["error"]
        .as_str()
        .unwrap()
        .contains("No VM found"));

    fs::write(vm_workspace_root(&vm).join("not-a-zip.txt"), "plain text").unwrap();
    let bad_zip = response_payload(
        handle_unzip_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("zip_path", json!("/work/not-a-zip.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert!(bad_zip["error"]
        .as_str()
        .unwrap()
        .contains("Extraction failed"));
}

#[tokio::test]
async fn find_and_search_handlers_cover_missing_vm_and_path_failures() {
    let _env = TestEnv::new("search-errors");

    let missing_find = response_payload(handle_find_files(&args(&[])).await.unwrap());
    assert_eq!(
        missing_find["error"],
        json!("vm_id and pattern are required")
    );

    let missing_search = response_payload(handle_grep(&args(&[])).await.unwrap());
    assert_eq!(
        missing_search["error"],
        json!("vm_id and pattern are required")
    );

    let missing_vm_find = response_payload(
        handle_find_files(&args(&[
            ("vm_id", json!("missing")),
            ("pattern", json!("*.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert!(missing_vm_find["error"]
        .as_str()
        .unwrap()
        .contains("No VM found"));

    let missing_vm_search = response_payload(
        handle_grep(&args(&[
            ("vm_id", json!("missing")),
            ("pattern", json!("needle")),
        ]))
        .await
        .unwrap(),
    );
    assert!(missing_vm_search["error"]
        .as_str()
        .unwrap()
        .contains("No VM found"));
}

#[tokio::test]
async fn grep_file_handler_groups_offsets_and_registers_reads() {
    let env = TestEnv::new("search-file-matches");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);
    fs::write(root.join("match-target.txt"), "0123beta7890betaXYZ").unwrap();

    let response = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("match-target.txt")),
            ("patterns", json!(["beta", "7890", "beta"])),
            ("before_chars", json!(2)),
            ("after_chars", json!(3)),
            ("max_results_per_pattern", json!(1)),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(response["success"], json!(true));
    assert_eq!(response["path"], json!("/work/match-target.txt"));
    assert_eq!(response["total_chars"], json!(19));
    assert_eq!(response["matched_any"], json!(true));

    let results = response["results_by_pattern"].as_object().unwrap();
    assert_eq!(results.len(), 2);

    let beta = &results["beta"];
    assert_eq!(beta["total_matches"], json!(2));
    assert_eq!(beta["returned_matches"], json!(1));
    assert_eq!(beta["truncated"], json!(true));
    assert_eq!(beta["matches"][0]["start_offset_chars"], json!(4));
    assert_eq!(beta["matches"][0]["end_offset_chars"], json!(8));
    assert_eq!(beta["matches"][0]["excerpt_start_offset_chars"], json!(2));
    assert_eq!(beta["matches"][0]["excerpt_end_offset_chars"], json!(11));
    assert_eq!(beta["matches"][0]["before"], json!("23"));
    assert_eq!(beta["matches"][0]["match"], json!("beta"));
    assert_eq!(beta["matches"][0]["after"], json!("789"));

    let digits = &results["7890"];
    assert_eq!(digits["total_matches"], json!(1));
    assert_eq!(digits["returned_matches"], json!(1));
    assert_eq!(digits["truncated"], json!(false));
    assert_eq!(digits["matches"][0]["start_offset_chars"], json!(8));
    assert_eq!(digits["matches"][0]["end_offset_chars"], json!(12));

    assert!(has_file_been_read("vm-1", "match-target.txt").unwrap());
}

#[tokio::test]
async fn grep_file_handler_supports_unicode_offsets_and_window_boundaries() {
    let env = TestEnv::new("search-file-unicode");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);
    fs::write(root.join("unicode.txt"), "😀betaéβ").unwrap();

    let response = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("unicode.txt")),
            ("patterns", json!(["beta"])),
            ("before_chars", json!(1)),
            ("after_chars", json!(2)),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(response["success"], json!(true));
    assert_eq!(response["total_chars"], json!(7));
    let beta = &response["results_by_pattern"]["beta"];
    assert_eq!(beta["total_matches"], json!(1));
    assert_eq!(beta["matches"][0]["start_offset_chars"], json!(1));
    assert_eq!(beta["matches"][0]["end_offset_chars"], json!(5));
    assert_eq!(beta["matches"][0]["excerpt_start_offset_chars"], json!(0));
    assert_eq!(beta["matches"][0]["excerpt_end_offset_chars"], json!(7));
    assert_eq!(beta["matches"][0]["before"], json!("😀"));
    assert_eq!(beta["matches"][0]["match"], json!("beta"));
    assert_eq!(beta["matches"][0]["after"], json!("éβ"));
}

#[tokio::test]
async fn grep_file_handler_distinguishes_literal_regex_and_non_overlapping_matches() {
    let env = TestEnv::new("search-file-modes");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);
    fs::write(root.join("modes.txt"), "a.c abc aaa").unwrap();

    let literal = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("modes.txt")),
            ("patterns", json!(["a.c", "aa"])),
            ("before_chars", json!(0)),
            ("after_chars", json!(0)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        literal["results_by_pattern"]["a.c"]["total_matches"],
        json!(1)
    );
    assert_eq!(
        literal["results_by_pattern"]["aa"]["total_matches"],
        json!(1)
    );

    let regex = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("modes.txt")),
            ("patterns", json!(["a.c", "aa"])),
            ("match_mode", json!("regex")),
            ("before_chars", json!(0)),
            ("after_chars", json!(0)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        regex["results_by_pattern"]["a.c"]["total_matches"],
        json!(2)
    );
    assert_eq!(regex["results_by_pattern"]["aa"]["total_matches"], json!(1));
}

#[tokio::test]
async fn grep_file_handler_clamps_context_and_result_limits_per_pattern() {
    let env = TestEnv::new("search-file-clamps");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);
    fs::write(root.join("clamps.txt"), "needle middle needle tail").unwrap();

    let response = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("clamps.txt")),
            ("patterns", json!(["needle", "tail"])),
            ("before_chars", json!(-9)),
            ("after_chars", json!(10_000)),
            ("max_results_per_pattern", json!(0)),
        ]))
        .await
        .unwrap(),
    );

    assert_eq!(response["before_chars"], json!(0));
    assert_eq!(response["after_chars"], json!(1000));
    assert_eq!(response["max_results_per_pattern"], json!(1));
    assert_eq!(
        response["results_by_pattern"]["needle"]["total_matches"],
        json!(2)
    );
    assert_eq!(
        response["results_by_pattern"]["needle"]["returned_matches"],
        json!(1)
    );
    assert_eq!(
        response["results_by_pattern"]["needle"]["truncated"],
        json!(true)
    );
    assert_eq!(
        response["results_by_pattern"]["tail"]["returned_matches"],
        json!(1)
    );
    assert_eq!(
        response["results_by_pattern"]["tail"]["matches"][0]["excerpt_end_offset_chars"],
        response["total_chars"]
    );
}

#[tokio::test]
async fn grep_file_handler_handles_empty_and_missing_files() {
    let env = TestEnv::new("search-file-empty-missing");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);
    fs::write(root.join("empty.txt"), "").unwrap();

    let empty = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("empty.txt")),
            ("patterns", json!(["needle"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(empty["success"], json!(true));
    assert_eq!(empty["total_chars"], json!(0));
    assert_eq!(empty["matched_any"], json!(false));
    assert_eq!(
        empty["results_by_pattern"]["needle"]["matches"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    let missing = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("missing.txt")),
            ("patterns", json!(["needle"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing["success"], json!(false));
    assert!(missing["error"]
        .as_str()
        .unwrap()
        .contains("Failed to read file or file not found"));
}

#[tokio::test]
async fn resolve_vm_for_request_recovers_stale_vm_for_custom_workspace_chat() {
    let env = TestEnv::new("recover-stale-custom-workspace");
    let host_root = env.root.join("host-project-root");
    let container_root = env.root.join("container-project-root");
    let workspace_cfg = env.root.join("workspace-cfg");
    let custom = env.root.join("external").join("portico-wf");
    fs::create_dir_all(&host_root).unwrap();
    fs::create_dir_all(&container_root).unwrap();
    fs::create_dir_all(&workspace_cfg).unwrap();
    fs::create_dir_all(&custom).unwrap();
    fs::write(
        workspace_cfg.join("chat-workspaces.json"),
        json!({
            "chats": {
                "chat-custom-recovery": {
                    "source": "custom",
                    "host_path": custom.display().to_string()
                }
            }
        })
        .to_string(),
    )
    .unwrap();

    let _guard = EnvGuard::set(&[
        ("HOST_PROJECT_ROOT", Some(host_root.to_str().unwrap())),
        (
            "CONTAINER_PROJECT_ROOT",
            Some(container_root.to_str().unwrap()),
        ),
        (
            "PORTICO_WORKSPACE_CFG_DIR",
            Some(workspace_cfg.to_str().unwrap()),
        ),
    ]);

    // The custom dir is deliberately OUTSIDE the runtime workspaces tree, so
    // host-side translation of it must fail — recovery has to cope with that.
    assert!(local_workspace_path(&custom).is_err());

    // Leftover generated chat dir (from before the user pointed the chat at a
    // custom folder): this is what steers recovery into the legacy-copy step
    // that used to bail with "workspace root ... is not accessible".
    let generated_chat_dir = container_root
        .join("workspaces")
        .join("chat-custom-recovery");
    fs::create_dir_all(&generated_chat_dir).unwrap();
    fs::write(generated_chat_dir.join("stale.txt"), "pre-custom leftovers").unwrap();

    let stale_vm = env.seed_vm("vm-stale-custom", "chat-custom-recovery");
    assert_eq!(
        stale_vm.work_bind_source.as_deref(),
        Some(custom.to_string_lossy().as_ref())
    );
    seed_fake_vm_container(
        &stale_vm.container_id,
        &format!("agent-vm-{}", stale_vm.vm_id),
        "exited",
    );

    let resolved = resolve_vm_for_request("vm-stale-custom", Some("chat-custom-recovery"))
        .await
        .unwrap()
        .expect("recovered vm");
    let recovered_vm = resolved.effective_vm;
    assert_ne!(recovered_vm.vm_id, stale_vm.vm_id);
    assert_eq!(recovered_vm.chat_id, "chat-custom-recovery");
    // Recovery rebinds the SAME live custom dir...
    assert_eq!(
        recovered_vm.work_bind_source.as_deref(),
        Some(custom.to_string_lossy().as_ref())
    );
    // ...and must NOT copy stale generated content into the user's folder.
    assert!(!custom.join("stale.txt").exists());
    assert!(fs::read_dir(&custom).unwrap().next().is_none());
}

#[tokio::test]
async fn oversized_tool_results_survive_custom_workspaces_outside_runtime_tree() {
    let env = TestEnv::new("overflow-custom-workspace");
    let host_root = env.root.join("host-project-root");
    let container_root = env.root.join("container-project-root");
    let workspace_cfg = env.root.join("workspace-cfg");
    let custom = env.root.join("external").join("portico-wf-overflow");
    fs::create_dir_all(&host_root).unwrap();
    fs::create_dir_all(&container_root).unwrap();
    fs::create_dir_all(&workspace_cfg).unwrap();
    fs::create_dir_all(&custom).unwrap();
    fs::write(
        workspace_cfg.join("chat-workspaces.json"),
        json!({
            "chats": {
                "chat-custom-overflow": {
                    "source": "custom",
                    "host_path": custom.display().to_string()
                }
            }
        })
        .to_string(),
    )
    .unwrap();

    let _guard = EnvGuard::set(&[
        ("HOST_PROJECT_ROOT", Some(host_root.to_str().unwrap())),
        (
            "CONTAINER_PROJECT_ROOT",
            Some(container_root.to_str().unwrap()),
        ),
        (
            "PORTICO_WORKSPACE_CFG_DIR",
            Some(workspace_cfg.to_str().unwrap()),
        ),
        ("AGENT_VM_TOOL_RESULT_MAX_CHARS", Some("64")),
    ]);
    assert!(local_workspace_path(&custom).is_err());

    let _vm = env.seed_vm("vm-overflow-custom", "chat-custom-overflow");
    let arguments = args(&[
        ("vm_id", json!("vm-overflow-custom")),
        ("chat_id", json!("chat-custom-overflow")),
    ]);

    // Target resolution must fall back to the write-through-the-VM sink
    // instead of bailing on the host-inaccessible custom root.
    let target = crate::native::resolve_agent_vm_overflow_target(&arguments, "{}")
        .unwrap()
        .expect("overflow target");
    assert!(matches!(
        target.sink,
        crate::native::AgentVmOverflowSink::Vm(_)
    ));

    // The spill wrapper must never turn an oversized SUCCESS into an error.
    // (In fake-docker mode the VM write cannot reach the custom dir either,
    // so it degrades to returning the original inline value.)
    let oversized = success_text(json!({
        "success": true,
        "content": "x".repeat(200),
    }))
    .unwrap();
    let result = crate::native::maybe_spill_agent_vm_tool_result(
        "read_file",
        &arguments,
        oversized.clone(),
    )
    .await
    .unwrap();
    assert_eq!(result, oversized);
}
