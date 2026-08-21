use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;

fn serve_notification_capture() -> (String, mpsc::Receiver<(String, String, String)>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let base = format!("http://{}", listener.local_addr().expect("listener addr"));
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept request");
        let mut buffer = Vec::new();
        let mut chunk = [0_u8; 1024];
        let header_end = loop {
            let read = stream.read(&mut chunk).expect("read request");
            assert!(read > 0, "client closed before headers");
            buffer.extend_from_slice(&chunk[..read]);
            if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };

        let headers = String::from_utf8(buffer[..header_end].to_vec()).expect("header utf8");
        let request_line = headers.split("\r\n").next().expect("request line");
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or_default().to_string();
        let path = parts.next().unwrap_or_default().to_string();
        let content_length = headers
            .split("\r\n")
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(|value| value.trim().parse::<usize>().expect("content length"))
            })
            .unwrap_or(0);
        let mut body = buffer[header_end..].to_vec();
        while body.len() < content_length {
            let read = stream.read(&mut chunk).expect("read body");
            assert!(read > 0, "client closed before body complete");
            body.extend_from_slice(&chunk[..read]);
        }
        tx.send((method, path, String::from_utf8(body).expect("body utf8")))
            .expect("send request");
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            )
            .expect("write response");
    });
    (base, rx)
}

#[test]
fn helper_edges_cover_no_port_messages_redis_increment_and_nested_archive_parent() {
    let root = TestRoot::new("coverage-helpers");

    let mut info = sample_info();
    info.host_port = None;
    info.status = STATUS_STOPPED.to_string();
    let payload = create_version_payload(&info, 4, 12.5, "note");
    assert_eq!(payload["message"], json!("Version 4 created."));

    let _redis = EnvVarGuard::set("CORE_MCP_TEST_REDIS", "memory");
    assert_eq!(next_host_port().unwrap(), ARTIFACT_PORT_START as u16);
    assert_eq!(next_host_port().unwrap(), (ARTIFACT_PORT_START + 1) as u16);
    drop(_redis);

    let source = root.path.join("nested-source");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("index.html"), "hello").unwrap();
    let archive = root.path.join("archives/deep/demo.tar.gz");
    tar_directory(&source, &archive).unwrap();
    assert!(archive.exists());
}

#[tokio::test]
async fn notification_and_missing_delete_paths_are_covered() {
    let _root = TestRoot::new("coverage-notify");
    let _enabled = EnvVarGuard::set("DISABLE_ELECTRON_NOTIFICATIONS", "0");
    let _timeout = EnvVarGuard::set("ARTIFACT_ELECTRON_NOTIFY_TIMEOUT_SECS", "invalid");
    let (base, requests) = serve_notification_capture();
    let _electron_base = EnvVarGuard::set("ELECTRON_API_BASE", &base);

    maybe_notify_electron(
        "/api/artifact/open",
        &json!({ "artifact_id": "artifact-1" }),
    )
    .await;

    let (method, path, body) = requests.recv().expect("captured request");
    assert_eq!(method, "POST");
    assert_eq!(path, "/api/artifact/open");
    assert!(body.contains("\"artifact_id\":\"artifact-1\""));

    let error = handle_delete_artifact(&args(&[
        ("artifact_id", json!("missing-artifact")),
        ("chat_id", json!("chat-missing")),
        ("confirm", json!(true)),
    ]))
    .await
    .unwrap_err();
    assert!(error.to_string().contains("artifact not found"));
}
