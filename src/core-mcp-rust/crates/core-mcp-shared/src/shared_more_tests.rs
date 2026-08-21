use super::*;
use crate::TEST_ENV_LOCK;
use bollard::models::{ContainerCreateBody, HostConfig};
use bollard::query_parameters::{
    CreateContainerOptions, CreateImageOptions, InspectContainerOptions, RemoveContainerOptions,
    StartContainerOptions,
};
use bollard::Docker;
use futures_util::TryStreamExt;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;
use uuid::Uuid;

struct EnvGuard {
    _guard: MutexGuard<'static, ()>,
    root: PathBuf,
    previous_cwd: PathBuf,
    previous_container_root: Option<String>,
    previous_host_root: Option<String>,
    previous_test_redis: Option<String>,
    previous_redis_host: Option<String>,
    previous_redis_port: Option<String>,
    previous_electron_api_base: Option<String>,
    previous_openwebui_base_url: Option<String>,
    previous_app_support_dir: Option<String>,
    previous_docker_host: Option<String>,
}

impl EnvGuard {
    fn new(name: &str) -> Self {
        let guard = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let root = env::temp_dir().join(format!(
            "core-mcp-rust-shared-more-{name}-{}",
            Uuid::new_v4().simple()
        ));
        for dir in [
            "mcp-configs",
            "mcp-configs-user",
            "skills",
            "skills-user",
            "skills-marketplace",
        ] {
            fs::create_dir_all(root.join(dir)).expect("create dir");
        }
        let previous_cwd = env::current_dir().expect("current dir");
        let previous_container_root = env::var("CONTAINER_PROJECT_ROOT").ok();
        let previous_host_root = env::var("HOST_PROJECT_ROOT").ok();
        let previous_test_redis = env::var("CORE_MCP_TEST_REDIS").ok();
        let previous_redis_host = env::var("REDIS_HOST").ok();
        let previous_redis_port = env::var("REDIS_PORT").ok();
        let previous_electron_api_base = env::var("ELECTRON_API_BASE").ok();
        let previous_openwebui_base_url = env::var("OPENWEBUI_BASE_URL").ok();
        let previous_app_support_dir = env::var("PORTICO_APP_SUPPORT_DIR").ok();
        let previous_docker_host = env::var("DOCKER_HOST").ok();
        env::set_current_dir(&root).expect("set current dir");
        env::set_var("CONTAINER_PROJECT_ROOT", &root);
        env::set_var("HOST_PROJECT_ROOT", &root);
        env::set_var("CORE_MCP_TEST_REDIS", "memory");
        env::remove_var("REDIS_HOST");
        env::remove_var("REDIS_PORT");
        env::remove_var("PORTICO_APP_SUPPORT_DIR");
        env::remove_var("DOCKER_HOST");
        Self {
            _guard: guard,
            root,
            previous_cwd,
            previous_container_root,
            previous_host_root,
            previous_test_redis,
            previous_redis_host,
            previous_redis_port,
            previous_electron_api_base,
            previous_openwebui_base_url,
            previous_app_support_dir,
            previous_docker_host,
        }
    }

    fn set_electron_base(&self, base: &str) {
        env::set_var("ELECTRON_API_BASE", base);
    }

    fn set_openwebui_base(&self, base: &str) {
        env::set_var("OPENWEBUI_BASE_URL", base);
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        let _ = env::set_current_dir(&self.previous_cwd);
        for (key, value) in [
            ("CONTAINER_PROJECT_ROOT", &self.previous_container_root),
            ("HOST_PROJECT_ROOT", &self.previous_host_root),
            ("CORE_MCP_TEST_REDIS", &self.previous_test_redis),
            ("REDIS_HOST", &self.previous_redis_host),
            ("REDIS_PORT", &self.previous_redis_port),
            ("ELECTRON_API_BASE", &self.previous_electron_api_base),
            ("OPENWEBUI_BASE_URL", &self.previous_openwebui_base_url),
            (
                "PORTICO_APP_SUPPORT_DIR",
                &self.previous_app_support_dir,
            ),
            ("DOCKER_HOST", &self.previous_docker_host),
        ] {
            if let Some(value) = value {
                env::set_var(key, value);
            } else {
                env::remove_var(key);
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn docker_client_helper_honors_docker_host_proxy() {
    let _env = EnvGuard::new("docker-host-proxy");
    env::set_var("DOCKER_HOST", "tcp://docker-socket-proxy:2375");

    let docker = connect_docker_client().expect("connect docker client from DOCKER_HOST");
    let debug = format!("{docker:?}");

    assert!(
        debug.contains("client_type: Http"),
        "expected HTTP Docker client for DOCKER_HOST proxy, got {debug}"
    );
    assert!(
        debug.contains("client_addr: \"docker-socket-proxy:2375\""),
        "expected Docker client to target docker-socket-proxy, got {debug}"
    );
}

#[derive(Clone)]
struct MockReply {
    status: &'static str,
    body: Value,
}

#[derive(Debug)]
struct Request {
    method: String,
    path: String,
    body: String,
}

fn map(entries: &[(&str, Value)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

fn read_request(stream: &mut std::net::TcpStream) -> Request {
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
    let header = String::from_utf8(buffer[..header_end].to_vec()).expect("header utf8");
    let request_line = header
        .split("\r\n")
        .find(|line| !line.is_empty())
        .expect("missing request line");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let content_length = header
        .split("\r\n")
        .find_map(|line| {
            let lower = line.to_ascii_lowercase();
            lower
                .strip_prefix("content-length:")
                .map(|value| value.trim().parse::<usize>().expect("content length"))
        })
        .unwrap_or(0);
    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk).expect("read body");
        assert!(read > 0, "client closed before body");
        body.extend_from_slice(&chunk[..read]);
    }
    Request {
        method,
        path,
        body: String::from_utf8(body).expect("body utf8"),
    }
}

fn serve_responses(replies: Vec<MockReply>) -> (String, mpsc::Receiver<Request>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let base = format!("http://{}", listener.local_addr().expect("listener addr"));
    let (tx, rx) = mpsc::channel();
    let replies = Arc::new(Mutex::new(replies));
    thread::spawn(move || loop {
        let reply = {
            let mut lock = replies.lock().expect("lock replies");
            if lock.is_empty() {
                return;
            }
            lock.remove(0)
        };
        let (mut stream, _) = listener.accept().expect("accept");
        let request = read_request(&mut stream);
        let _ = tx.send(request);
        let body = serde_json::to_vec(&reply.body).expect("encode body");
        let response = format!(
            "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            reply.status,
            body.len()
        );
        stream
            .write_all(response.as_bytes())
            .and_then(|_| stream.write_all(&body))
            .expect("write response");
    });
    (base, rx)
}

#[test]
fn text_path_yaml_and_toggle_helpers_cover_pure_branches() {
    let env = EnvGuard::new("pure");
    fs::create_dir_all(env.root.join("open-webui-data/app-support/scheduled_tasks")).unwrap();

    let success = success_text(json!({"ok": true})).unwrap();
    assert_eq!(success["isError"], json!(false));
    // Confirmed-write failure envelopes surface as tool ERRORS with the
    // envelope verbatim — a denied/expired approval must never read as
    // success to the model (2026-08-03 incident).
    let error = error_text(json!({"success": false, "code": "approval_timed_out"})).unwrap();
    assert_eq!(error["isError"], json!(true));
    assert!(error["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("approval_timed_out"));
    assert_eq!(plain_text("hello")["content"][0]["text"], json!("hello"));
    assert_eq!(
        fs::canonicalize(app_root().unwrap()).unwrap(),
        fs::canonicalize(&env.root).unwrap()
    );
    assert_eq!(
        fs::canonicalize(mcp_configs_dir().unwrap()).unwrap(),
        fs::canonicalize(env.root.join("mcp-configs")).unwrap()
    );
    assert_eq!(
        fs::canonicalize(mcp_configs_user_dir().unwrap()).unwrap(),
        fs::canonicalize(env.root.join("mcp-configs-user")).unwrap()
    );
    assert_eq!(
        fs::canonicalize(skills_system_dir().unwrap()).unwrap(),
        fs::canonicalize(env.root.join("skills")).unwrap()
    );
    assert_eq!(
        fs::canonicalize(skills_user_dir().unwrap()).unwrap(),
        fs::canonicalize(env.root.join("skills-user")).unwrap()
    );
    assert_eq!(
        fs::canonicalize(skills_marketplace_dir().unwrap()).unwrap(),
        fs::canonicalize(env.root.join("skills-marketplace")).unwrap()
    );
    assert_eq!(
        fs::canonicalize(app_support_dir().unwrap()).unwrap(),
        fs::canonicalize(env.root.join("open-webui-data/app-support")).unwrap()
    );
    assert_eq!(
        fs::canonicalize(scheduled_tasks_dir().unwrap()).unwrap(),
        fs::canonicalize(env.root.join("open-webui-data/app-support/scheduled_tasks")).unwrap()
    );
    assert_eq!(electron_api_base(), "http://host.docker.internal:9876");
    assert_eq!(openwebui_base_url(), "http://open-webui:8080");
    assert_eq!(safe_path_component("../a/b\\c\0"), "abc");
    assert_eq!(safe_path_component(&"x".repeat(300)).len(), 255);
    assert_eq!(
        path_to_unix_string(&env.root, &env.root.join("nested/file.txt")).as_deref(),
        Some("nested/file.txt")
    );
    assert!(
        path_to_unix_string(&env.root.join("other"), &env.root.join("nested/file.txt")).is_none()
    );

    let yaml_path = env.root.join("config.yaml");
    fs::write(
        &yaml_path,
        "name: Demo\nenabled: true\nitems:\n  - one\n  - two\n",
    )
    .unwrap();
    let yaml = yaml_map(&yaml_path).unwrap();
    assert_eq!(yaml_string(&yaml, "name").as_deref(), Some("Demo"));
    assert_eq!(yaml_bool(&yaml, "enabled"), Some(true));
    assert_eq!(yaml_array_strings(&yaml, "items"), vec!["one", "two"]);
    fs::write(&yaml_path, "[]").unwrap();
    assert!(yaml_map(&yaml_path).is_err());

    let yaml_value: serde_yaml::Value = serde_yaml::from_str("? [1, 2]\n: value\n").unwrap();
    assert_eq!(yaml_value_to_json(&yaml_value), Value::Null);

    write_json_atomic(&env.root.join("nested/data.json"), &json!({"answer": 42})).unwrap();
    assert_eq!(
        read_json_file(&env.root.join("nested/data.json")).unwrap()["answer"],
        json!(42)
    );
    env::set_var(
        "PORTICO_APP_SUPPORT_DIR",
        env.root.join("custom-app-support"),
    );
    fs::create_dir_all(env.root.join("custom-app-support")).unwrap();
    assert_eq!(
        fs::canonicalize(app_support_dir().unwrap()).unwrap(),
        fs::canonicalize(env.root.join("custom-app-support")).unwrap()
    );
    env::remove_var("PORTICO_APP_SUPPORT_DIR");
    fs::write(env.root.join("bad.json"), "{").unwrap();
    assert!(read_json_file(&env.root.join("bad.json")).is_err());
    write_yaml_atomic(&env.root.join("config.yaml"), &json!({"name": "saved"})).unwrap();
    assert!(fs::read_to_string(env.root.join("config.yaml"))
        .unwrap()
        .contains("name: saved"));

    assert_eq!(
        array_strings(Some(&json!([" one ", "", "two", 3]))),
        vec!["one".to_string(), "two".to_string()]
    );
    assert_eq!(
        map_arg(&map(&[("value", json!({"ok": true}))]), "value").unwrap()["ok"],
        json!(true)
    );
    assert!(map_arg(&Map::new(), "value").is_err());
    assert_eq!(
        string_arg(&map(&[("name", json!("demo"))]), "name").unwrap(),
        "demo"
    );
    assert!(string_arg(&Map::new(), "name").is_err());
    assert!(bool_arg(&Map::new(), "flag", true));
    assert_eq!(float_arg(&Map::new(), "amount", 1.5), 1.5);
    assert_eq!(int_arg(&Map::new(), "count", 2), 2);

    let toggles = HashMap::from([("time".to_string(), false)]);
    save_mcp_toggles(&toggles).unwrap();
    let core_dir = env.root.join("mcp-configs/skills");
    fs::create_dir_all(&core_dir).unwrap();
    fs::write(
        core_dir.join("skills.yaml"),
        "name: Skills\nis_core: true\n",
    )
    .unwrap();
    assert_eq!(toggle_file_candidates().unwrap().len(), 2);
    assert_eq!(load_mcp_toggles().get("time"), Some(&false));
    assert_eq!(bare_server_id("server:time"), "time");
    assert!(!is_server_enabled_in_toggles("server:time"));
    assert!(is_server_enabled_in_toggles("skills"));
    assert!(is_server_enabled_in_toggles("server:missing"));
    fs::write(env.root.join("mcp_toggles.json"), "not-json").unwrap();
    assert!(load_mcp_toggles().is_empty());
    fs::remove_file(env.root.join("mcp_toggles.json")).unwrap();
    fs::create_dir_all(env.root.join("mcp_toggles.json")).unwrap();
    assert!(load_mcp_toggles().is_empty());
}

#[test]
fn yaml_toggle_and_atomic_write_helpers_cover_extra_fallbacks() {
    let env = EnvGuard::new("yaml-toggle-extra");

    let missing_yaml = env.root.join("missing.yaml");
    let missing_error = yaml_map(&missing_yaml).unwrap_err();
    assert!(missing_error
        .to_string()
        .contains("failed to read YAML config"));

    let invalid_yaml = env.root.join("invalid.yaml");
    fs::write(&invalid_yaml, "name: [").unwrap();
    let parse_error = yaml_map(&invalid_yaml).unwrap_err();
    assert!(parse_error
        .to_string()
        .contains("failed to parse YAML config"));

    let container_root = env.root.join("container-root");
    let host_root = env.root.join("host-root");
    for root in [&container_root, &host_root] {
        fs::create_dir_all(root.join("mcp-configs")).unwrap();
        fs::create_dir_all(root.join("mcp-configs-user")).unwrap();
    }
    env::set_current_dir(&container_root).expect("set current dir");
    env::set_var("CONTAINER_PROJECT_ROOT", &container_root);
    env::set_var("HOST_PROJECT_ROOT", &host_root);

    fs::write(host_root.join("mcp_toggles.json"), "{\"host\":true}").unwrap();
    assert_eq!(load_mcp_toggles().get("host"), Some(&true));

    let replacement = HashMap::from([("host".to_string(), false)]);
    save_mcp_toggles(&replacement).unwrap();
    let saved_host = serde_json::from_str::<HashMap<String, bool>>(
        &fs::read_to_string(host_root.join("mcp_toggles.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(saved_host.get("host"), Some(&false));

    write_text_atomic(&env.root.join("no-extension"), "plain text").unwrap();
    assert_eq!(
        fs::read_to_string(env.root.join("no-extension")).unwrap(),
        "plain text"
    );

    let blocking_parent = env.root.join("blocking-parent");
    fs::write(&blocking_parent, "not a directory").unwrap();
    let create_dir_error =
        write_text_atomic(&blocking_parent.join("child.txt"), "value").unwrap_err();
    assert!(create_dir_error
        .to_string()
        .contains("failed to create parent dir"));
}

#[test]
fn argument_and_toggle_helpers_cover_explicit_values_and_fallback_save_path() {
    let env = EnvGuard::new("argument-values");

    assert!(array_strings(None).is_empty());
    assert_eq!(
        array_strings(Some(&json!([" one ", "two ", " ", null, 7]))),
        vec!["one".to_string(), "two".to_string()]
    );

    let arguments = map(&[
        ("settings", json!({"enabled": true})),
        ("flag", json!(false)),
        ("amount", json!(2.25)),
        ("count", json!(7)),
    ]);
    assert_eq!(
        map_arg(&arguments, "settings").unwrap()["enabled"],
        json!(true)
    );
    assert_eq!(bool_arg(&arguments, "flag", true), false);
    assert_eq!(float_arg(&arguments, "amount", 1.0), 2.25);
    assert_eq!(int_arg(&arguments, "count", 1), 7);
    assert!(map_arg(&map(&[("settings", json!("oops"))]), "settings").is_err());

    fs::remove_file(env.root.join("mcp_toggles.json")).unwrap_or_default();
    write_text_atomic(&env.root.join("nested/noext"), "seed").unwrap();
    fs::remove_file(env.root.join("nested/noext")).unwrap();

    let toggles = HashMap::from([("time".to_string(), true)]);
    save_mcp_toggles(&toggles).unwrap();
    let saved = serde_json::from_str::<HashMap<String, bool>>(
        &fs::read_to_string(env.root.join("mcp_toggles.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(saved.get("time"), Some(&true));
}

#[test]
fn app_root_redis_and_header_helpers_cover_error_paths() {
    let _env = EnvGuard::new("errors");

    let orphan = env::temp_dir().join(format!("core-mcp-rust-orphan-{}", Uuid::new_v4()));
    fs::create_dir_all(&orphan).unwrap();
    let previous_cwd = env::current_dir().unwrap();
    env::set_current_dir(&orphan).unwrap();
    let root_error = app_root().unwrap_err();
    assert!(root_error
        .to_string()
        .contains("failed to locate project root"));
    env::set_current_dir(previous_cwd).unwrap();
    let _ = fs::remove_dir_all(&orphan);

    let app_dir = Path::new("/app");
    let app_created = if app_dir.exists() {
        false
    } else {
        fs::create_dir_all(app_dir).is_ok()
    };
    if app_dir.exists() {
        assert_eq!(app_root().unwrap(), PathBuf::from("/app"));
    }
    if app_created && app_dir.exists() {
        let _ = fs::remove_dir_all(app_dir);
    }

    env::remove_var("CORE_MCP_TEST_REDIS");
    env::set_var("REDIS_HOST", "does-not-exist.invalid");
    env::set_var("REDIS_PORT", "6399");
    assert_eq!(redis_url(), "redis://does-not-exist.invalid:6399/");
    assert!(redis_connection().is_err());
    assert!(redis_get_string("key").is_err());
    assert!(redis_setex_string("key", "value", 5).is_err());
    assert!(redis_delete("key").is_err());
    assert!(redis_scan_keys("key*").is_err());
    assert!(redis_smembers("key").is_err());
    assert!(redis_set_string("key", "value").is_err());
    assert!(redis_ttl("key").is_err());
    assert!(redis_sadd("set", "value").is_err());
    assert!(redis_srem("set", "value").is_err());
    assert!(redis_sismember("set", "value").is_err());
    assert!(redis_incr("counter").is_err());
    env::set_var("CORE_MCP_TEST_REDIS", "memory");

    let headers = auth_headers("token").unwrap();
    assert_eq!(headers["content-type"], "application/json");
    assert_eq!(headers["authorization"], "Bearer token");
    assert!(auth_headers("").unwrap().get("authorization").is_none());
    assert!(auth_headers("bad\nheader").is_err());
}

#[test]
fn memory_redis_helpers_cover_ttl_sets_and_incr() {
    let _env = EnvGuard::new("memory-redis");

    assert!(!test_redis_enabled() == false);
    assert!(redis_get_string("missing").unwrap().is_none());
    redis_setex_string("expires", "value", 60).unwrap();
    assert_eq!(
        redis_get_string("expires").unwrap().as_deref(),
        Some("value")
    );
    redis_set_string("alpha:1", "one").unwrap();
    redis_set_string("alpha:2", "two").unwrap();
    redis_sadd("alpha:set", "member").unwrap();
    assert_eq!(
        redis_scan_keys("alpha:*").unwrap(),
        vec![
            "alpha:1".to_string(),
            "alpha:2".to_string(),
            "alpha:set".to_string()
        ]
    );
    assert!(redis_ttl("expires").unwrap() > 0);
    assert!(redis_persist("expires").unwrap());
    assert_eq!(redis_ttl("expires").unwrap(), -1);
    assert!(!redis_persist("expires").unwrap());
    assert!(!redis_persist("missing").unwrap());
    redis_set_string("plain", "value").unwrap();
    assert_eq!(redis_ttl("plain").unwrap(), -1);
    redis_sadd("group", "b").unwrap();
    redis_sadd("group", "a").unwrap();
    assert_eq!(
        redis_smembers("group").unwrap(),
        vec!["a".to_string(), "b".to_string()]
    );
    assert!(redis_sismember("group", "a").unwrap());
    redis_srem("group", "a").unwrap();
    assert!(!redis_sismember("group", "a").unwrap());
    redis_sadd("solo", "value").unwrap();
    redis_srem("solo", "value").unwrap();
    assert!(redis_smembers("solo").unwrap().is_empty());
    assert_eq!(redis_incr("counter").unwrap(), 1);
    assert_eq!(redis_incr("counter").unwrap(), 2);
    redis_set_string("bad-counter", "oops").unwrap();
    assert!(redis_incr("bad-counter").is_err());
    redis_delete("plain").unwrap();
    assert!(redis_get_string("plain").unwrap().is_none());

    with_test_redis(|state| {
        state.strings.insert(
            "expired".to_string(),
            TestRedisString {
                value: "gone".to_string(),
                expires_at: Some(now_epoch_seconds() - 1.0),
            },
        );
    });
    assert!(redis_get_string("expired").unwrap().is_none());
    assert_eq!(redis_ttl("expired").unwrap(), -2);

    env::remove_var("CORE_MCP_TEST_REDIS");
    assert!(with_test_redis(|_| 42).is_none());
    env::set_var("CORE_MCP_TEST_REDIS", "memory");
}

#[tokio::test]
async fn live_redis_helpers_cover_socket_client_paths() {
    let _env = EnvGuard::new("live-redis");
    env::remove_var("CORE_MCP_TEST_REDIS");

    let docker = match Docker::connect_with_local_defaults() {
        Ok(client) => client,
        Err(_) => return,
    };
    let image = "redis:7-alpine";
    let _ = docker
        .create_image(
            Some(CreateImageOptions {
                from_image: Some(image.to_string()),
                ..Default::default()
            }),
            None,
            None,
        )
        .try_collect::<Vec<_>>()
        .await;

    let container_name = format!("core-mcp-rust-shared-redis-{}", Uuid::new_v4().simple());
    let config = ContainerCreateBody {
        image: Some(image.to_string()),
        cmd: Some(vec![
            "redis-server".to_string(),
            "--save".to_string(),
            "".to_string(),
            "--appendonly".to_string(),
            "no".to_string(),
        ]),
        host_config: Some(HostConfig {
            auto_remove: Some(true),
            ..Default::default()
        }),
        ..Default::default()
    };
    docker
        .create_container(
            Some(CreateContainerOptions {
                name: Some(container_name.clone()),
                platform: String::new(),
            }),
            config,
        )
        .await
        .expect("create redis container");
    docker
        .start_container(&container_name, None::<StartContainerOptions>)
        .await
        .expect("start redis container");

    let mut redis_host = None;
    for _ in 0..20 {
        let inspect = serde_json::to_value(
            docker
                .inspect_container(&container_name, None::<InspectContainerOptions>)
                .await
                .expect("inspect redis container"),
        )
        .expect("serialize inspect response");
        redis_host = inspect
            .get("network_settings")
            .or_else(|| inspect.get("NetworkSettings"))
            .and_then(|value| value.get("ip_address"))
            .or_else(|| {
                inspect
                    .get("network_settings")
                    .or_else(|| inspect.get("NetworkSettings"))
                    .and_then(|value| value.get("IPAddress"))
            })
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                inspect
                    .get("network_settings")
                    .or_else(|| inspect.get("NetworkSettings"))
                    .and_then(|value| value.get("networks"))
                    .or_else(|| {
                        inspect
                            .get("network_settings")
                            .or_else(|| inspect.get("NetworkSettings"))
                            .and_then(|value| value.get("Networks"))
                    })
                    .and_then(Value::as_object)
                    .and_then(|networks| {
                        networks.values().find_map(|network| {
                            network
                                .get("ip_address")
                                .or_else(|| network.get("IPAddress"))
                                .and_then(Value::as_str)
                                .filter(|value| !value.is_empty())
                                .map(str::to_string)
                        })
                    })
            });
        if redis_host.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let redis_host = redis_host.expect("redis container IP address");
    env::set_var("REDIS_HOST", &redis_host);
    env::set_var("REDIS_PORT", "6379");

    let mut connected = false;
    for _ in 0..20 {
        if redis_connection().is_ok() {
            connected = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(connected, "redis client should connect to live redis");

    redis_setex_string("live:ttl", "value", 60).unwrap();
    assert_eq!(
        redis_get_string("live:ttl").unwrap().as_deref(),
        Some("value")
    );
    assert!(redis_ttl("live:ttl").unwrap() > 0);
    assert!(redis_persist("live:ttl").unwrap());
    assert_eq!(redis_ttl("live:ttl").unwrap(), -1);
    redis_set_string("live:plain", "value").unwrap();
    assert_eq!(
        redis_get_string("live:plain").unwrap().as_deref(),
        Some("value")
    );
    redis_sadd("live:set", "a").unwrap();
    redis_sadd("live:set", "b").unwrap();
    assert_eq!(
        redis_smembers("live:set").unwrap(),
        vec!["a".to_string(), "b".to_string()]
    );
    assert!(redis_sismember("live:set", "a").unwrap());
    redis_srem("live:set", "a").unwrap();
    assert!(!redis_sismember("live:set", "a").unwrap());
    assert_eq!(redis_incr("live:counter").unwrap(), 1);
    assert_eq!(redis_incr("live:counter").unwrap(), 2);

    // Exercise the production eviction policy against a disposable Redis.
    // VM state must be ineligible for volatile-lru while debug events remain
    // evictable under memory pressure.
    redis_set_string("agent_vm_info:eviction-vm", r#"{"vm_id":"eviction-vm"}"#).unwrap();
    redis_set_string("agent_vm:eviction-chat", "eviction-vm").unwrap();
    let mut conn = redis_connection().unwrap();
    let memory_info: String = redis::cmd("INFO").arg("memory").query(&mut conn).unwrap();
    let used_memory = memory_info
        .lines()
        .find_map(|line| line.strip_prefix("used_memory:"))
        .and_then(|value| value.trim().parse::<u64>().ok())
        .expect("used_memory in Redis INFO");
    let maxmemory = used_memory + (1024 * 1024);
    let _: () = redis::cmd("CONFIG")
        .arg("SET")
        .arg("maxmemory")
        .arg(maxmemory)
        .query(&mut conn)
        .unwrap();
    let _: () = redis::cmd("CONFIG")
        .arg("SET")
        .arg("maxmemory-policy")
        .arg("volatile-lru")
        .query(&mut conn)
        .unwrap();

    let debug_body = "x".repeat(64 * 1024);
    let inserted_debug_keys = 64;
    for index in 0..inserted_debug_keys {
        redis_setex_string(
            &format!("llm_debug:evict:{index}"),
            &format!("{index}:{debug_body}"),
            60,
        )
        .unwrap();
    }

    let stats_info: String = redis::cmd("INFO").arg("stats").query(&mut conn).unwrap();
    let evicted_keys = stats_info
        .lines()
        .find_map(|line| line.strip_prefix("evicted_keys:"))
        .and_then(|value| value.trim().parse::<u64>().ok())
        .expect("evicted_keys in Redis INFO");
    assert!(evicted_keys > 0, "volatile-lru should evict debug keys");
    assert!(
        redis_scan_keys("llm_debug:evict:*").unwrap().len() < inserted_debug_keys,
        "at least one expiring debug key should be evicted"
    );
    assert_eq!(
        redis_get_string("agent_vm_info:eviction-vm")
            .unwrap()
            .as_deref(),
        Some(r#"{"vm_id":"eviction-vm"}"#)
    );
    assert_eq!(
        redis_get_string("agent_vm:eviction-chat")
            .unwrap()
            .as_deref(),
        Some("eviction-vm")
    );
    assert_eq!(redis_ttl("agent_vm_info:eviction-vm").unwrap(), -1);
    assert_eq!(redis_ttl("agent_vm:eviction-chat").unwrap(), -1);

    redis_delete("live:plain").unwrap();
    assert!(redis_get_string("live:plain").unwrap().is_none());

    let _ = docker
        .remove_container(
            &container_name,
            Some(RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await;
}

#[tokio::test]
async fn http_helpers_cover_success_and_failure_paths() {
    let env = EnvGuard::new("http");
    let (electron_base, electron_requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({"ok": true}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"posted": true}),
        },
        MockReply {
            status: "500 ERROR",
            body: json!({"error": "bad"}),
        },
        MockReply {
            status: "500 ERROR",
            body: json!({"error": "bad"}),
        },
    ]);
    env.set_electron_base(&electron_base);
    assert_eq!(
        electron_get_json("/status", 5.0).await.unwrap()["ok"],
        json!(true)
    );
    assert_eq!(
        electron_post_json("/submit", &json!({"value": 1}), 5.0)
            .await
            .unwrap()["posted"],
        json!(true)
    );
    assert!(electron_get_json("/bad", 5.0).await.is_err());
    assert!(electron_post_json("/bad", &json!({}), 5.0).await.is_err());
    assert_eq!(electron_requests.recv().unwrap().path, "/status");
    let post = electron_requests.recv().unwrap();
    assert_eq!(post.method, "POST");
    assert_eq!(post.path, "/submit");
    assert!(post.body.contains("\"value\":1"));

    let (openwebui_base, openwebui_requests) = serve_responses(vec![
        MockReply {
            status: "200 OK",
            body: json!({"id": 1}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"created": true}),
        },
        MockReply {
            status: "200 OK",
            body: json!({"deleted": true}),
        },
        MockReply {
            status: "500 ERROR",
            body: json!({"error": "bad"}),
        },
        MockReply {
            status: "500 ERROR",
            body: json!({"error": "bad"}),
        },
        MockReply {
            status: "500 ERROR",
            body: json!({"error": "bad"}),
        },
    ]);
    env.set_openwebui_base(&openwebui_base);
    assert_eq!(
        openwebui_get_json("/items", "abc").await.unwrap()["id"],
        json!(1)
    );
    assert_eq!(
        openwebui_post_json("/items", "abc", &json!({"name": "demo"}), 5.0)
            .await
            .unwrap()["created"],
        json!(true)
    );
    assert_eq!(
        openwebui_delete_json("/items/1", "abc", Some(&json!({"force": true})))
            .await
            .unwrap()["deleted"],
        json!(true)
    );
    assert!(openwebui_get_json("/bad", "abc").await.is_err());
    assert!(openwebui_post_json("/bad", "abc", &json!({}), 5.0)
        .await
        .is_err());
    assert!(openwebui_delete_json("/bad", "abc", None).await.is_err());
    assert_eq!(openwebui_requests.recv().unwrap().path, "/items");
    assert_eq!(openwebui_requests.recv().unwrap().path, "/items");
    let delete = openwebui_requests.recv().unwrap();
    assert_eq!(delete.method, "DELETE");
    assert_eq!(delete.path, "/items/1");
    assert!(delete.body.contains("\"force\":true"));
}

#[test]
fn parse_disable_modes_payload_is_tolerant_and_accepts_the_snapshot_wrapper() {
    // Invalid JSON / non-object payloads signal "try the next candidate".
    assert!(parse_disable_modes_payload("{not json").is_none());
    assert!(parse_disable_modes_payload("[1,2]").is_none());

    // Bare map: only string "hard" entries survive (trimmed, case-folded).
    let bare =
        parse_disable_modes_payload(r#"{"n8n":"HARD ","slack":"soft","x":true}"#).unwrap();
    assert_eq!(bare.get("n8n").map(String::as_str), Some("hard"));
    assert!(!bare.contains_key("slack"));
    assert!(!bare.contains_key("x"));

    // Snapshot wrapper written by the Electron store / compose seeding.
    let wrapped = parse_disable_modes_payload(
        r#"{"schemaVersion":1,"revision":"sha256:x","capturedAt":"t","modes":{"n8n":"hard"}}"#,
    )
    .unwrap();
    assert_eq!(wrapped.len(), 1);
    assert_eq!(wrapped.get("n8n").map(String::as_str), Some("hard"));

    assert!(parse_disable_modes_payload("{}").unwrap().is_empty());
}
