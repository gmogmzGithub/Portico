use super::tests::{args, response_payload, EnvGuard, TestEnv};
use super::*;
use crate::native::shared::ToolDispatcher;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;

#[derive(Clone)]
struct RawZipEntry<'a> {
    legacy_name: &'a [u8],
    unicode_name: Option<&'a str>,
    contents: &'a [u8],
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0_u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

fn push_u16(buffer: &mut Vec<u8>, value: u16) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(buffer: &mut Vec<u8>, value: u32) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn unicode_path_extra(legacy_name: &[u8], unicode_name: Option<&str>) -> Vec<u8> {
    let Some(unicode_name) = unicode_name else {
        return Vec::new();
    };
    let mut payload = vec![1_u8];
    push_u32(&mut payload, crc32(legacy_name));
    payload.extend_from_slice(unicode_name.as_bytes());

    let mut extra = Vec::new();
    push_u16(&mut extra, 0x7075);
    push_u16(&mut extra, payload.len() as u16);
    extra.extend_from_slice(&payload);
    extra
}

fn write_raw_zip(path: &Path, entries: &[RawZipEntry<'_>]) {
    let mut bytes = Vec::new();
    let mut central_records = Vec::new();

    for entry in entries {
        let local_offset = bytes.len() as u32;
        let extra = unicode_path_extra(entry.legacy_name, entry.unicode_name);
        let content_crc = crc32(entry.contents);

        push_u32(&mut bytes, 0x0403_4b50);
        push_u16(&mut bytes, 20);
        push_u16(&mut bytes, 0);
        push_u16(&mut bytes, 0);
        push_u16(&mut bytes, 0);
        push_u16(&mut bytes, 0);
        push_u32(&mut bytes, content_crc);
        push_u32(&mut bytes, entry.contents.len() as u32);
        push_u32(&mut bytes, entry.contents.len() as u32);
        push_u16(&mut bytes, entry.legacy_name.len() as u16);
        push_u16(&mut bytes, extra.len() as u16);
        bytes.extend_from_slice(entry.legacy_name);
        bytes.extend_from_slice(&extra);
        bytes.extend_from_slice(entry.contents);

        let mut central = Vec::new();
        push_u32(&mut central, 0x0201_4b50);
        push_u16(&mut central, 20);
        push_u16(&mut central, 20);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0);
        push_u32(&mut central, content_crc);
        push_u32(&mut central, entry.contents.len() as u32);
        push_u32(&mut central, entry.contents.len() as u32);
        push_u16(&mut central, entry.legacy_name.len() as u16);
        push_u16(&mut central, extra.len() as u16);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0);
        push_u32(&mut central, 0);
        push_u32(&mut central, local_offset);
        central.extend_from_slice(entry.legacy_name);
        central.extend_from_slice(&extra);
        central_records.push(central);
    }

    let central_offset = bytes.len() as u32;
    for record in &central_records {
        bytes.extend_from_slice(record);
    }
    let central_size = bytes.len() as u32 - central_offset;
    push_u32(&mut bytes, 0x0605_4b50);
    push_u16(&mut bytes, 0);
    push_u16(&mut bytes, 0);
    push_u16(&mut bytes, entries.len() as u16);
    push_u16(&mut bytes, entries.len() as u16);
    push_u32(&mut bytes, central_size);
    push_u32(&mut bytes, central_offset);
    push_u16(&mut bytes, 0);

    fs::write(path, bytes).unwrap();
}

fn assert_unsafe_archive(error: anyhow::Error) -> String {
    error
        .downcast_ref::<UnsafeArchivePathError>()
        .expect("expected UNSAFE_ARCHIVE_PATH error")
        .member()
        .to_string()
}

#[test]
fn rust_unzip_rejects_unsafe_member_forms_before_creating_destination() {
    let env = TestEnv::new("unzip-unsafe-members");
    let root = env.root.join("workspace");
    fs::create_dir_all(&root).unwrap();
    let cases: &[(&str, &[u8])] = &[
        ("parent", b"../escaped.txt"),
        ("deep-parent", b"../../../../escaped.txt"),
        ("parent-only", b".."),
        ("absolute", b"/absolute.txt"),
        ("drive", b"C:/drive.txt"),
        ("unc-forward", b"//server/share.txt"),
        ("unc-backslash", b"\\\\server\\share.txt"),
        ("backslash", b"folder\\file.txt"),
        ("backslash-parent", b"..\\escaped.txt"),
        ("nul", b"safe\0hidden.txt"),
        ("empty", b""),
        ("dot", b"."),
        ("empty-component", b"folder//file.txt"),
        ("sibling-prefix", b"../extract2/escaped.txt"),
    ];

    for (case, name) in cases {
        let zip_path = root.join(format!("{case}.zip"));
        write_raw_zip(
            &zip_path,
            &[RawZipEntry {
                legacy_name: name,
                unicode_name: None,
                contents: b"blocked",
            }],
        );
        let destination = root.join(format!("extract-{case}"));
        let member =
            assert_unsafe_archive(unzip_into(&zip_path, &root, &destination, 0).unwrap_err());
        assert!(!member.is_empty(), "{case} should name the rejected member");
        assert!(
            !destination.exists(),
            "{case} must be rejected before destination creation"
        );
    }
    assert!(!root.join("escaped.txt").exists());
    assert!(!root.join("extract2/escaped.txt").exists());
}

#[test]
fn rust_unzip_preflight_cannot_be_bypassed_by_strip_or_unicode_name_collisions() {
    let env = TestEnv::new("unzip-unicode-collisions");
    let root = env.root.join("workspace");
    fs::create_dir_all(&root).unwrap();

    let cases = [
        (
            "safe-legacy-unsafe-effective",
            vec![RawZipEntry {
                legacy_name: b"safe.txt",
                unicode_name: Some("../escaped.txt"),
                contents: b"blocked",
            }],
        ),
        (
            "unsafe-legacy-safe-effective",
            vec![RawZipEntry {
                legacy_name: b"../escaped.txt",
                unicode_name: Some("safe.txt"),
                contents: b"blocked",
            }],
        ),
        (
            "collapsed-duplicate",
            vec![
                RawZipEntry {
                    legacy_name: b"../escaped.txt",
                    unicode_name: Some("safe.txt"),
                    contents: b"blocked",
                },
                RawZipEntry {
                    legacy_name: b"safe.txt",
                    unicode_name: None,
                    contents: b"safe",
                },
            ],
        ),
        (
            "ordinary-duplicate",
            vec![
                RawZipEntry {
                    legacy_name: b"same.txt",
                    unicode_name: None,
                    contents: b"first",
                },
                RawZipEntry {
                    legacy_name: b"same.txt",
                    unicode_name: None,
                    contents: b"second",
                },
            ],
        ),
        (
            "strip-parent",
            vec![RawZipEntry {
                legacy_name: b"../escaped.txt",
                unicode_name: None,
                contents: b"blocked",
            }],
        ),
    ];

    for (case, entries) in cases {
        let zip_path = root.join(format!("{case}.zip"));
        write_raw_zip(&zip_path, &entries);
        let destination = root.join(format!("extract-{case}"));
        assert_unsafe_archive(
            unzip_into(
                &zip_path,
                &root,
                &destination,
                usize::from(case == "strip-parent"),
            )
            .unwrap_err(),
        );
        assert!(!destination.exists(), "{case} left extraction residue");
    }
    assert!(!root.join("escaped.txt").exists());

    let valid_zip = root.join("valid-unicode.zip");
    write_raw_zip(
        &valid_zip,
        &[RawZipEntry {
            legacy_name: b"cafe.txt",
            unicode_name: Some("caf\u{e9}.txt"),
            contents: b"unicode",
        }],
    );
    let valid_destination = root.join("valid-unicode");
    let summary = unzip_into(&valid_zip, &root, &valid_destination, 0).unwrap();
    assert_eq!(summary.files_extracted, 1);
    assert_eq!(
        fs::read_to_string(valid_destination.join("caf\u{e9}.txt")).unwrap(),
        "unicode"
    );
}

#[cfg(unix)]
#[test]
fn rust_unzip_rejects_symlinked_parent_and_final_target_before_writing_files() {
    use std::os::unix::fs::symlink;

    let env = TestEnv::new("unzip-symlinks");
    let root = env.root.join("workspace");
    let outside = env.root.join("outside");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&outside).unwrap();

    let parent_zip = root.join("parent.zip");
    write_raw_zip(
        &parent_zip,
        &[
            RawZipEntry {
                legacy_name: b"safe.txt",
                unicode_name: None,
                contents: b"must-not-land",
            },
            RawZipEntry {
                legacy_name: b"link/escaped.txt",
                unicode_name: None,
                contents: b"blocked",
            },
        ],
    );
    let parent_dest = root.join("parent-dest");
    fs::create_dir_all(&parent_dest).unwrap();
    symlink(&outside, parent_dest.join("link")).unwrap();
    assert_unsafe_archive(unzip_into(&parent_zip, &root, &parent_dest, 0).unwrap_err());
    assert!(!parent_dest.join("safe.txt").exists());
    assert!(!outside.join("escaped.txt").exists());

    let final_zip = root.join("final.zip");
    write_raw_zip(
        &final_zip,
        &[
            RawZipEntry {
                legacy_name: b"safe.txt",
                unicode_name: None,
                contents: b"must-not-land",
            },
            RawZipEntry {
                legacy_name: b"final.txt",
                unicode_name: None,
                contents: b"blocked",
            },
        ],
    );
    let final_dest = root.join("final-dest");
    fs::create_dir_all(&final_dest).unwrap();
    let outside_file = outside.join("outside.txt");
    fs::write(&outside_file, "preserved").unwrap();
    symlink(&outside_file, final_dest.join("final.txt")).unwrap();
    assert_unsafe_archive(unzip_into(&final_zip, &root, &final_dest, 0).unwrap_err());
    assert!(!final_dest.join("safe.txt").exists());
    assert_eq!(fs::read_to_string(outside_file).unwrap(), "preserved");
}

#[test]
fn rust_unzip_counts_only_files_written_by_this_call() {
    let env = TestEnv::new("unzip-accounting");
    let root = env.root.join("workspace");
    let destination = root.join("extract");
    fs::create_dir_all(&destination).unwrap();
    fs::write(destination.join("preexisting.txt"), "existing").unwrap();

    let zip_path = root.join("valid.zip");
    write_raw_zip(
        &zip_path,
        &[
            RawZipEntry {
                legacy_name: b"folder/",
                unicode_name: None,
                contents: b"",
            },
            RawZipEntry {
                legacy_name: b"folder/inside.txt",
                unicode_name: None,
                contents: b"inside",
            },
            RawZipEntry {
                legacy_name: b"top.txt",
                unicode_name: None,
                contents: b"top",
            },
        ],
    );

    let summary = unzip_into(&zip_path, &root, &destination, 0).unwrap();
    assert_eq!(summary.files_extracted, 2);
    assert_eq!(
        summary.top_level_files,
        vec!["preexisting.txt".to_string(), "top.txt".to_string()]
    );
    assert_eq!(summary.top_level_directories, vec!["folder".to_string()]);
}

fn run_vm_file_script(payload: Value) -> Value {
    let encoded_payload = BASE64_STANDARD.encode(serde_json::to_vec(&payload).unwrap());
    let output = ProcessCommand::new("python3")
        .args([
            "-c",
            VM_FILE_SCRIPT,
            "vm-file-script",
            &encoded_payload,
        ])
        .output()
        .expect("python3 is required to validate the shipped Agent VM file script");
    assert!(
        output.status.success(),
        "VM_FILE_SCRIPT failed with status {:?}; stdout: {}; stderr: {}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[cfg(unix)]
#[test]
fn python_vm_file_script_matches_rust_preflight_and_symlink_policy() {
    use std::os::unix::fs::symlink;

    let root = PathBuf::from("/tmp").join(format!(
        "portico-283-python-unzip-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&root).unwrap();

    let unsafe_cases = [
        (
            "plain-traversal",
            vec![
                RawZipEntry {
                    legacy_name: b"safe.txt",
                    unicode_name: None,
                    contents: b"must-not-land",
                },
                RawZipEntry {
                    legacy_name: b"../escaped.txt",
                    unicode_name: None,
                    contents: b"blocked",
                },
            ],
        ),
        (
            "unsafe-effective",
            vec![RawZipEntry {
                legacy_name: b"safe.txt",
                unicode_name: Some("../escaped.txt"),
                contents: b"blocked",
            }],
        ),
        (
            "unsafe-original",
            vec![RawZipEntry {
                legacy_name: b"../escaped.txt",
                unicode_name: Some("safe.txt"),
                contents: b"blocked",
            }],
        ),
        (
            "duplicate-collision",
            vec![
                RawZipEntry {
                    legacy_name: b"../escaped.txt",
                    unicode_name: Some("safe.txt"),
                    contents: b"blocked",
                },
                RawZipEntry {
                    legacy_name: b"safe.txt",
                    unicode_name: None,
                    contents: b"safe",
                },
            ],
        ),
    ];
    for (case, entries) in unsafe_cases {
        let zip_path = root.join(format!("{case}.zip"));
        let destination = root.join(format!("dest-{case}"));
        write_raw_zip(&zip_path, &entries);
        let result = run_vm_file_script(json!({
            "op": "unzip",
            "zip_path": zip_path,
            "dest_path": destination,
            "strip_components": 1,
        }));
        assert_eq!(result["success"], json!(false), "{case}");
        assert_eq!(result["error_code"], json!(UNSAFE_ARCHIVE_PATH_ERROR_CODE));
        assert!(result["unsafe_member"]
            .as_str()
            .is_some_and(|name| !name.is_empty()));
        assert!(!destination.exists(), "{case} created a destination");
    }

    let outside = root.join("outside");
    fs::create_dir_all(&outside).unwrap();
    let symlink_zip = root.join("symlink.zip");
    write_raw_zip(
        &symlink_zip,
        &[
            RawZipEntry {
                legacy_name: b"safe.txt",
                unicode_name: None,
                contents: b"must-not-land",
            },
            RawZipEntry {
                legacy_name: b"link/escaped.txt",
                unicode_name: None,
                contents: b"blocked",
            },
        ],
    );
    let symlink_dest = root.join("symlink-dest");
    fs::create_dir_all(&symlink_dest).unwrap();
    symlink(&outside, symlink_dest.join("link")).unwrap();
    let symlink_result = run_vm_file_script(json!({
        "op": "unzip",
        "zip_path": symlink_zip,
        "dest_path": symlink_dest,
    }));
    assert_eq!(
        symlink_result["error_code"],
        json!(UNSAFE_ARCHIVE_PATH_ERROR_CODE)
    );
    assert!(!symlink_dest.join("safe.txt").exists());
    assert!(!outside.join("escaped.txt").exists());

    let final_zip = root.join("final-symlink.zip");
    write_raw_zip(
        &final_zip,
        &[
            RawZipEntry {
                legacy_name: b"safe.txt",
                unicode_name: None,
                contents: b"must-not-land",
            },
            RawZipEntry {
                legacy_name: b"final.txt",
                unicode_name: None,
                contents: b"blocked",
            },
        ],
    );
    let final_dest = root.join("final-symlink-dest");
    fs::create_dir_all(&final_dest).unwrap();
    let outside_file = outside.join("outside.txt");
    fs::write(&outside_file, "preserved").unwrap();
    symlink(&outside_file, final_dest.join("final.txt")).unwrap();
    let final_result = run_vm_file_script(json!({
        "op": "unzip",
        "zip_path": final_zip,
        "dest_path": final_dest,
    }));
    assert_eq!(
        final_result["error_code"],
        json!(UNSAFE_ARCHIVE_PATH_ERROR_CODE)
    );
    assert!(!final_dest.join("safe.txt").exists());
    assert_eq!(fs::read_to_string(outside_file).unwrap(), "preserved");

    let valid_zip = root.join("valid.zip");
    let valid_dest = root.join("valid-dest");
    write_raw_zip(
        &valid_zip,
        &[RawZipEntry {
            legacy_name: b"cafe.txt",
            unicode_name: Some("caf\u{e9}.txt"),
            contents: b"unicode",
        }],
    );
    let valid_result = run_vm_file_script(json!({
        "op": "unzip",
        "zip_path": valid_zip,
        "dest_path": valid_dest,
    }));
    assert_eq!(valid_result["success"], json!(true));
    assert_eq!(valid_result["files_extracted"], json!(1));
    assert_eq!(valid_result["top_level_files"], json!(["caf\u{e9}.txt"]));
    assert_eq!(valid_result["top_level_directories"], json!([]));
    assert_eq!(
        fs::read_to_string(valid_dest.join("caf\u{e9}.txt")).unwrap(),
        "unicode"
    );

    fs::remove_dir_all(&root).unwrap();
}

#[tokio::test]
async fn dispatcher_preserves_structured_unsafe_archive_failure_without_spilling() {
    let env = TestEnv::new("unzip-dispatcher-error");
    let _overflow_env = EnvGuard::set(&[
        ("AGENT_VM_TOOL_RESULT_MAX_CHARS", Some("10")),
        ("AGENT_VM_TOOL_RESULT_OVERFLOW_ENABLED", Some("true")),
    ]);
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);
    let zip_path = root.join("unsafe.zip");
    let long_member = format!("../{}.txt", "x".repeat(256));
    write_raw_zip(
        &zip_path,
        &[RawZipEntry {
            legacy_name: long_member.as_bytes(),
            unicode_name: None,
            contents: b"blocked",
        }],
    );

    let dispatcher = crate::native::Dispatcher;
    let response = dispatcher
        .call(
            "unzip_file",
            &args(&[
                ("vm_id", json!("vm-1")),
                ("zip_path", json!("/work/unsafe.zip")),
                ("dest_path", json!("/work/extract")),
            ]),
        )
        .await
        .unwrap()
        .unwrap();
    let payload = response_payload(response);
    assert_eq!(payload["success"], json!(false));
    assert_eq!(payload["error_code"], json!(UNSAFE_ARCHIVE_PATH_ERROR_CODE));
    assert!(payload.get("overflow_file").is_none());
    assert!(payload["unsafe_member"].as_str().unwrap().len() < long_member.len());
    assert!(!root.join("extract").exists());
    assert!(!root.join(".mcp-overflow").exists());
}
