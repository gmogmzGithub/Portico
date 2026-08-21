use super::tests::{args, response_payload, write_zip, TestEnv};
use super::*;
use std::fs;

#[test]
fn core_helpers_cover_defaults_activity_and_shared_input_copy() {
    let env = TestEnv::new("branch-core");
    let shared_root = host_chat_workspace_root("chat-1").unwrap();
    fs::create_dir_all(shared_root.join("nested")).unwrap();
    fs::write(shared_root.join("seed.txt"), "shared seed").unwrap();
    fs::write(shared_root.join("nested/extra.txt"), "nested seed").unwrap();

    let workspace = prepare_workspace("chat-1", "vm-1").unwrap();
    assert_eq!(workspace, env.root.join("workspaces/chat-1"));
    assert_eq!(
        fs::read_to_string(shared_root.join("seed.txt")).unwrap(),
        "shared seed"
    );
    assert!(workspace.join("seed.txt").exists());
    assert_eq!(
        fs::read_to_string(shared_root.join("nested/extra.txt")).unwrap(),
        "nested seed"
    );

    fs::create_dir_all(workspace.join("private")).unwrap();
    fs::write(workspace.join("private/seed.txt"), "vm local").unwrap();
    fs::write(shared_root.join("seed.txt"), "new shared seed").unwrap();
    let same_workspace = prepare_workspace("chat-1", "vm-1").unwrap();
    assert_eq!(same_workspace, workspace);
    assert_eq!(
        fs::read_to_string(workspace.join("private/seed.txt")).unwrap(),
        "vm local"
    );
    assert_eq!(
        fs::read_to_string(shared_root.join("seed.txt")).unwrap(),
        "new shared seed"
    );

    let mut vm = env.vm("vm-activity", "chat-1");
    vm.last_activity = 0.0;
    store_vm_info(&vm).unwrap();
    touch_vm_activity("vm-activity").unwrap();
    assert!(load_vm("vm-activity").unwrap().last_activity > 0.0);
    touch_vm_activity("missing-vm").unwrap();

    register_file_read("vm-activity", "notes.txt").unwrap();
    assert!(has_file_been_read("vm-activity", "/work/notes.txt").unwrap());

    let parsed = VmInfo::from_json(&json!({
        "vm_id": "vm-defaults",
        "container_id": "container-defaults",
        "chat_id": "chat-1",
        "created_at": 1.0,
        "last_activity": 2.0,
        "timeout_hours": 3.0,
        "profile": "browser",
        "port_mappings": {
            "3000/tcp": 3000,
            "ignored": "not-a-port"
        }
    }))
    .unwrap();
    assert_eq!(parsed.status, "running");
    assert!(parsed.network_enabled);
    assert!(parsed.to_json().get("profile").is_none());
    assert_eq!(parsed.port_mappings.get("3000/tcp"), Some(&3000));
    assert_eq!(parsed.port_mappings.len(), 1);
}

#[test]
fn fs_helpers_cover_tmp_paths_and_workspace_payload_variants() {
    let env = TestEnv::new("branch-fs");
    let vm = env.seed_vm("vm-1", "chat-1");
    let workspace_root = vm_workspace_root(&vm);

    fs::create_dir_all(workspace_root.join(".tmp/logs")).unwrap();
    fs::write(workspace_root.join(".tmp/logs/out.txt"), "tmp log").unwrap();
    assert_eq!(
        vm_host_path(&vm, "/tmp/logs/out.txt").unwrap(),
        workspace_root.join(".tmp/logs/out.txt")
    );
    assert_eq!(
        vm_path_string(&vm, &workspace_root.join(".tmp/logs/out.txt")).unwrap(),
        "/work/.tmp/logs/out.txt"
    );
    assert!(vm_host_path(&vm, "/etc/passwd").is_err());
    assert_eq!(
        sanitize_relative(" /nested\\path.txt ").unwrap(),
        "nested/path.txt"
    );
    assert!(create_batch_file(&vm, &json!("bad-file")).is_err());

    let shared_root = workspace_root_for_ids("chat-1", "vm-1").unwrap();
    fs::create_dir_all(shared_root.join("output/folder")).unwrap();
    fs::write(shared_root.join("output/report.txt"), "report contents").unwrap();

    let copied = response_payload(
        workspace_file_payload(&vm, "output/report.txt", "Saved.", Some("/work/report.txt"))
            .unwrap(),
    );
    assert_eq!(copied["success"], json!(true));
    assert_eq!(copied["vm_path"], json!("/work/report.txt"));
    assert_eq!(copied["markdown_image"], Value::Null);
    assert!(copied["message"]
        .as_str()
        .unwrap()
        .contains("markdown_link"));

    let link =
        response_payload(workspace_file_payload(&vm, "output/report.txt", "Saved.", None).unwrap());
    assert_eq!(link["success"], json!(true));
    assert!(link.get("inline_image_included").is_none());
    assert_eq!(link["is_image"], json!(false));
    assert_eq!(link["file_name"], json!("report.txt"));

    fs::create_dir_all(shared_root.join("output/reports")).unwrap();
    fs::write(
        shared_root.join("output/reports/Agg Disco Pipeline 2025 Overview (v2).md"),
        "encoded report",
    )
    .unwrap();

    let encoded = response_payload(
        workspace_file_payload(
            &vm,
            "output/reports/Agg Disco Pipeline 2025 Overview (v2).md",
            "Saved.",
            Some("/work/reports/Agg Disco Pipeline 2025 Overview (v2).md"),
        )
        .unwrap(),
    );
    assert_eq!(encoded["success"], json!(true));
    assert_eq!(
        encoded["download_url"],
        json!(
            "http://localhost:9876/workspace/chat-1/output/reports/Agg%20Disco%20Pipeline%202025%20Overview%20%28v2%29.md"
        )
    );
    assert_eq!(
        encoded["markdown_link"],
        json!(
            "[Download Agg Disco Pipeline 2025 Overview (v2).md](http://localhost:9876/workspace/chat-1/output/reports/Agg%20Disco%20Pipeline%202025%20Overview%20%28v2%29.md)"
        )
    );

    let directory = response_payload(
        workspace_file_payload(&vm, "output/folder", "Saved.", Some("/work/output/folder"))
            .unwrap(),
    );
    assert_eq!(directory["success"], json!(false));
    assert_eq!(directory["error"], json!("Path is a directory, not a file"));

    let missing =
        response_payload(workspace_link_payload("chat-1", "vm-1", "missing.txt").unwrap());
    assert_eq!(missing["success"], json!(false));
    assert_eq!(missing["error"], json!("File does not exist"));

    let zip_path = env.root.join("fully-stripped.zip");
    write_zip(&zip_path, &[("root-only/file.txt", b"ignored")]);
    unzip_into(&zip_path, &env.root, &env.root.join("strip-all"), 2).unwrap();
    assert!(!env.root.join("strip-all/file.txt").exists());
}

#[tokio::test]
async fn workspace_handlers_cover_failure_warning_and_validation_branches() {
    let env = TestEnv::new("branch-workspace");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);

    let missing_copy_args = response_payload(
        handle_copy_from_workspace(&args(&[("vm_id", json!("vm-1"))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        missing_copy_args["error"],
        json!("vm_id and workspace_path are required")
    );

    let missing_copy_vm = response_payload(
        handle_copy_from_workspace(&args(&[
            ("vm_id", json!("missing-vm")),
            ("workspace_path", json!("input/source.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_copy_vm["success"], json!(false));

    let failed_copy = response_payload(
        handle_copy_from_workspace(&args(&[
            ("vm_id", json!("vm-1")),
            ("workspace_path", json!("input/missing.txt")),
            ("vm_path", json!("/work/copied.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(failed_copy["success"], json!(false));

    let missing_copy_out_args = response_payload(
        handle_copy_to_workspace(&args(&[("vm_id", json!("vm-1"))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        missing_copy_out_args["error"],
        json!("vm_id, vm_path, and workspace_path are required")
    );

    let missing_copy_out_vm = response_payload(
        handle_copy_to_workspace(&args(&[
            ("vm_id", json!("missing-vm")),
            ("vm_path", json!("/work/file.txt")),
            ("workspace_path", json!("output/file.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_copy_out_vm["success"], json!(false));

    fs::write(root.join("ready.txt"), "ready").unwrap();
    let warned_copy = response_payload(
        handle_copy_to_workspace(&args(&[
            ("vm_id", json!("vm-1")),
            ("vm_path", json!("/work/ready.txt")),
            ("workspace_path", json!("/absolute.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(warned_copy["success"], json!(true));
    assert_eq!(
        fs::read_to_string(
            workspace_root_for_ids("chat-1", "vm-1")
                .unwrap()
                .join("absolute.txt")
        )
        .unwrap(),
        "ready"
    );

    let missing_list_chat =
        response_payload(handle_list_workspace_files(&args(&[])).await.unwrap());
    assert_eq!(missing_list_chat["error"], json!("chat_id is required"));

    let missing_list_vm = response_payload(
        handle_list_workspace_files(&args(&[("chat_id", json!("chat-1"))]))
            .await
            .unwrap(),
    );
    assert_eq!(missing_list_vm["success"], json!(true));

    let invalid_directory = response_payload(
        handle_write_to_workspace(&args(&[
            ("chat_id", json!("chat-1")),
            ("content", json!("nope")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(invalid_directory["error"], json!("path is required"));

    let missing_filename = response_payload(
        handle_write_to_workspace(&args(&[("chat_id", json!("chat-1"))]))
            .await
            .unwrap(),
    );
    assert_eq!(missing_filename["error"], json!("path is required"));

    let skills_root = env.root.join("skills/demo/scripts");
    fs::create_dir_all(&skills_root).unwrap();
    fs::write(
        skills_root.join("fail.py"),
        "import sys\nsys.stderr.write('skill failed')\nsys.exit(2)\n",
    )
    .unwrap();
    fs::write(
        skills_root.join("sleep.py"),
        "import time\ntime.sleep(2)\nprint('done')\n",
    )
    .unwrap();

    let bad_skill = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("../bad-skill")),
            ("script_name", json!("run.py")),
            ("vm_id", json!("vm-1")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(bad_skill["success"], json!(false));
    assert!(bad_skill["error"]
        .as_str()
        .unwrap()
        .contains("Skill directory not found"));

    let bad_script = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("demo")),
            ("script_name", json!("../escape.py")),
            ("vm_id", json!("vm-1")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(bad_script["success"], json!(false));
    assert!(bad_script["error"]
        .as_str()
        .unwrap()
        .contains("Script not found"));

    let failed_script = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("demo")),
            ("script_name", json!("fail.py")),
            ("vm_id", json!("vm-1")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(failed_script["success"], json!(false));
    assert_eq!(failed_script["exit_code"], json!(2));
    assert!(failed_script["error"]
        .as_str()
        .unwrap()
        .contains("skill failed"));

    let timed_out = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("demo")),
            ("script_name", json!("sleep.py")),
            ("vm_id", json!("vm-1")),
            ("timeout_seconds", json!(1)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(timed_out["success"], json!(false));
    assert_eq!(timed_out["error"], json!("Execution failed: timed out"));

    let missing_link_args = response_payload(
        handle_get_workspace_file_link(&args(&[
            ("vm_id", json!("vm-1")),
            ("chat_id", json!("chat-1")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        missing_link_args["error"],
        json!("vm_id and file_path are required")
    );

    fs::write(root.join("bad.zip"), "not a zip").unwrap();
    let unzip_failure = response_payload(
        handle_unzip_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("zip_path", json!("/work/bad.zip")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(unzip_failure["success"], json!(false));
    assert!(unzip_failure["error"]
        .as_str()
        .unwrap()
        .contains("Extraction failed"));

    let missing_find_args = response_payload(handle_find_files(&args(&[])).await.unwrap());
    assert_eq!(
        missing_find_args["error"],
        json!("vm_id and pattern are required")
    );

    let missing_find_vm = response_payload(
        handle_find_files(&args(&[
            ("vm_id", json!("missing-vm")),
            ("pattern", json!("*.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_find_vm["success"], json!(false));

    let invalid_find_root = response_payload(
        handle_find_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("pattern", json!("*.txt")),
            ("path", json!("/etc")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(invalid_find_root["success"], json!(false));

    let missing_search_args = response_payload(handle_grep(&args(&[])).await.unwrap());
    assert_eq!(
        missing_search_args["error"],
        json!("vm_id and pattern are required")
    );

    let missing_search_vm = response_payload(
        handle_grep(&args(&[
            ("vm_id", json!("missing-vm")),
            ("pattern", json!("ready")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_search_vm["success"], json!(false));

    let invalid_search_root = response_payload(
        handle_grep(&args(&[
            ("vm_id", json!("vm-1")),
            ("pattern", json!("ready")),
            ("path", json!("/etc")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(invalid_search_root["success"], json!(false));

    let missing_file_match_args = response_payload(handle_grep_file(&args(&[])).await.unwrap());
    assert_eq!(
        missing_file_match_args["error"],
        json!("vm_id, path, and patterns are required")
    );

    let invalid_file_match_root = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/etc/passwd")),
            ("patterns", json!(["ready"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(invalid_file_match_root["success"], json!(false));
}

#[tokio::test]
async fn agent_vm_handlers_cover_missing_vm_noop_and_error_branches() {
    let env = TestEnv::new("branch-handlers");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);

    let failure = response_payload(failure_response("boom").unwrap());
    assert_eq!(failure["success"], json!(false));
    assert_eq!(failure["error"], json!("boom"));
    assert_eq!(batch_message(2, 2, "all good", "Applied"), "all good");
    assert_eq!(
        batch_message(1, 3, "unused", "Applied"),
        "Applied 1/3. 2 failed."
    );

    let missing_bash_args = handle_bash(&args(&[])).await.unwrap();
    assert_eq!(
        missing_bash_args["content"][0]["text"],
        json!("Error: vm_id and command are required")
    );

    let missing_bash_vm = response_payload(
        handle_bash(&args(&[
            ("vm_id", json!("missing-vm")),
            ("command", json!("echo hi")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_bash_vm["success"], json!(false));

    let missing_python_args = response_payload(handle_python(&args(&[])).await.unwrap());
    assert_eq!(
        missing_python_args["error"],
        json!("vm_id and script are required")
    );

    let missing_python_vm = response_payload(
        handle_python(&args(&[
            ("vm_id", json!("missing-vm")),
            ("script", json!("print('hi')")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_python_vm["success"], json!(false));

    let failed_python = response_payload(
        handle_python(&args(&[
            ("vm_id", json!("vm-1")),
            ("script", json!("raise SystemExit(3)")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(failed_python["success"], json!(false));
    assert_eq!(failed_python["exit_code"], json!(3));

    let missing_create_path = response_payload(
        handle_create_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("content", json!("hello")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        missing_create_path["error"],
        json!("vm_id, path, and content are required")
    );

    let create_missing_vm = response_payload(
        handle_create_file(&args(&[
            ("vm_id", json!("missing-vm")),
            ("path", json!("/work/new.txt")),
            ("content", json!("hello")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(create_missing_vm["success"], json!(false));

    let create_invalid_path = response_payload(
        handle_create_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/etc/passwd")),
            ("content", json!("hello")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(create_invalid_path["success"], json!(false));

    let batch_create_missing_vm = response_payload(
        handle_create_files(&args(&[
            ("vm_id", json!("missing-vm")),
            (
                "files",
                json!([{"path": "/work/new.txt", "content": "hello"}]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(batch_create_missing_vm["success"], json!(false));
    assert_eq!(batch_create_missing_vm["failed_count"], json!(1));

    let missing_read_path = response_payload(
        handle_read_file(&args(&[("vm_id", json!("vm-1"))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        missing_read_path["error"],
        json!("vm_id and path are required")
    );

    let read_missing_vm = response_payload(
        handle_read_file(&args(&[
            ("vm_id", json!("missing-vm")),
            ("path", json!("/work/file.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(read_missing_vm["success"], json!(false));

    fs::create_dir_all(root.join("folder")).unwrap();
    fs::write(root.join("raw.bin"), [0xff_u8, 0x00, 0x10]).unwrap();
    let batch_read = response_payload(
        handle_read_files(&args(&[
            ("vm_id", json!("vm-1")),
            (
                "paths",
                json!(["/work/folder", "/work/raw.bin", "/etc/passwd"]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(batch_read["success"], json!(false));
    assert_eq!(batch_read["failed_count"], json!(3));

    let empty_batch_path = response_payload(
        handle_read_files(&args(&[("vm_id", json!("vm-1")), ("paths", json!([""]))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        empty_batch_path["error"],
        json!("paths[0] must be a non-empty string")
    );

    fs::write(root.join("notes.txt"), "alpha").unwrap();
    fs::write(root.join("unread.txt"), "draft").unwrap();
    crate::native::shared::redis_delete("agent_vm_file_reads:vm-1").unwrap();
    let noop_edit = response_payload(
        handle_edit_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_path", json!("/work/notes.txt")),
            ("old_string", json!("alpha")),
            ("new_string", json!("alpha")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(noop_edit["success"], json!(true));
    assert_eq!(noop_edit["replacements_made"], json!(0));

    let missing_edit_vm = response_payload(
        handle_edit_file(&args(&[
            ("vm_id", json!("missing-vm")),
            ("file_path", json!("/work/unread.txt")),
            ("old_string", json!("alpha")),
            ("new_string", json!("beta")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_edit_vm["success"], json!(false));

    let unread_edit = response_payload(
        handle_edit_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_path", json!("/work/unread.txt")),
            ("old_string", json!("draft")),
            ("new_string", json!("beta")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(unread_edit["success"], json!(false));
    assert_eq!(
        unread_edit["error"],
        json!("File must be read before editing")
    );

    let batch_edit_noop = response_payload(
        handle_edit_files(&args(&[
            ("vm_id", json!("vm-1")),
            (
                "edits",
                json!([{
                    "file_path": "/work/notes.txt",
                    "old_string": "alpha",
                    "new_string": "alpha"
                }]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        batch_edit_noop["error"],
        json!("edits[0] has old_string equal to new_string (no-op)")
    );

    let batch_edit_missing_vm = response_payload(
        handle_edit_files(&args(&[
            ("vm_id", json!("missing-vm")),
            (
                "edits",
                json!([{
                    "file_path": "/work/notes.txt",
                    "old_string": "alpha",
                    "new_string": "beta"
                }]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(batch_edit_missing_vm["success"], json!(false));
    assert_eq!(batch_edit_missing_vm["failed_count"], json!(1));

    let delete_missing_vm = response_payload(
        handle_delete_file(&args(&[
            ("vm_id", json!("missing-vm")),
            ("path", json!("/work/file.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(delete_missing_vm["success"], json!(false));

    let delete_invalid_path = response_payload(
        handle_delete_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/etc/passwd")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(delete_invalid_path["success"], json!(false));

    let list_missing_vm = response_payload(
        handle_list_files(&args(&[("vm_id", json!("missing-vm"))]))
            .await
            .unwrap(),
    );
    assert_eq!(list_missing_vm["success"], json!(false));

    let list_missing_dir = response_payload(
        handle_list_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("directory", json!("/work/missing-dir")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(list_missing_dir["success"], json!(false));
    assert_eq!(
        list_missing_dir["error"],
        json!("Directory not found: /work/missing-dir")
    );
}
