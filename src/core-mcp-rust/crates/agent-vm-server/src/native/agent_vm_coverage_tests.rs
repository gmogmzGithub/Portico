use super::tests::{args, response_payload, write_zip, TestEnv};
use super::*;
use std::fs;

fn text_response(response: &Value) -> &Value {
    &response["content"][0]["text"]
}

#[tokio::test]
async fn file_and_batch_handlers_cover_missing_vm_and_partial_failure_paths() {
    let env = TestEnv::new("coverage-file-batches");
    let vm = env.seed_vm("vm-1", "chat-1");

    assert_eq!(batch_message(2, 2, "all good", "Created"), "all good");
    assert_eq!(
        batch_message(1, 2, "all good", "Created"),
        "Created 1/2. 1 failed."
    );

    let missing_bash = handle_bash(&args(&[("vm_id", json!("vm-1"))]))
        .await
        .unwrap();
    assert_eq!(
        text_response(&missing_bash),
        &json!("Error: vm_id and command are required")
    );

    let missing_vm_bash = response_payload(
        handle_bash(&args(&[
            ("vm_id", json!("missing")),
            ("command", json!("echo hi")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_vm_bash["success"], json!(false));
    assert!(missing_vm_bash["error"]
        .as_str()
        .unwrap()
        .contains("Create one first"));

    let missing_python = response_payload(
        handle_python(&args(&[("vm_id", json!("vm-1"))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        missing_python["error"],
        json!("vm_id and script are required")
    );

    let missing_vm_python = response_payload(
        handle_python(&args(&[
            ("vm_id", json!("missing")),
            ("script", json!("print('hi')")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_vm_python["success"], json!(false));
    assert!(missing_vm_python["error"]
        .as_str()
        .unwrap()
        .contains("Create one first"));

    let missing_create_content = response_payload(
        handle_create_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/demo.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        missing_create_content["error"],
        json!("vm_id, path, and content are required")
    );

    let missing_vm_create = response_payload(
        handle_create_file(&args(&[
            ("vm_id", json!("missing")),
            ("path", json!("/work/demo.txt")),
            ("content", json!("payload")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_vm_create["success"], json!(false));
    assert_eq!(missing_vm_create["path"], json!("/work/demo.txt"));

    let escaped_create = response_payload(
        handle_create_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("../../escape.txt")),
            ("content", json!("payload")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(escaped_create["success"], json!(false));

    let invalid_batch_entry = response_payload(
        handle_create_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("files", json!(["bad-entry"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        invalid_batch_entry["error"],
        json!("files[0] must be an object with path and content")
    );

    let missing_vm_batch = response_payload(
        handle_create_files(&args(&[
            ("vm_id", json!("missing")),
            (
                "files",
                json!([
                    {"path": "/work/one.txt", "content": "one"},
                    {"path": "/work/two.txt", "content": "two"}
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_vm_batch["success"], json!(false));
    assert_eq!(missing_vm_batch["failed_count"], json!(2));
    assert!(missing_vm_batch["message"]
        .as_str()
        .unwrap()
        .contains("Created 0/2"));

    let partial_batch = response_payload(
        handle_create_files(&args(&[
            ("vm_id", json!("vm-1")),
            (
                "files",
                json!([
                    {"path": "/work/good.txt", "content": "good"},
                    {"path": "../../bad.txt", "content": "bad"}
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(partial_batch["success"], json!(false));
    assert_eq!(partial_batch["created_count"], json!(1));
    assert_eq!(partial_batch["failed_count"], json!(1));
    assert!(partial_batch["message"]
        .as_str()
        .unwrap()
        .contains("Created 1/2"));
    assert_eq!(
        fs::read_to_string(vm_workspace_root(&vm).join("good.txt")).unwrap(),
        "good"
    );

    let missing_vm_delete = response_payload(
        handle_delete_file(&args(&[
            ("vm_id", json!("missing")),
            ("path", json!("/work/demo.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_vm_delete["success"], json!(false));

    let invalid_delete = response_payload(
        handle_delete_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("../../escape.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(invalid_delete["success"], json!(false));

    let missing_vm_list = response_payload(
        handle_list_files(&args(&[("vm_id", json!("missing"))]))
            .await
            .unwrap(),
    );
    assert!(missing_vm_list["error"]
        .as_str()
        .unwrap()
        .contains("No VM found"));

    let missing_dir = response_payload(
        handle_list_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("directory", json!("/work/missing")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        missing_dir["error"],
        json!("Directory not found: /work/missing")
    );
}

#[tokio::test]
async fn read_and_edit_handlers_cover_validation_binary_and_partial_batch_paths() {
    let env = TestEnv::new("coverage-read-edit");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);
    fs::create_dir_all(root.join("dir")).unwrap();
    fs::write(root.join("notes.txt"), "alpha\nalpha\n").unwrap();
    fs::write(root.join("single.txt"), "solo").unwrap();
    fs::write(root.join("fresh.txt"), "fresh").unwrap();
    fs::write(root.join("dir/child.txt"), "child").unwrap();
    fs::write(root.join("binary.bin"), [0xff, 0x00, 0x10]).unwrap();

    let missing_read_path = response_payload(
        handle_read_file(&args(&[("vm_id", json!("vm-1"))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        missing_read_path["error"],
        json!("vm_id and path are required")
    );

    let missing_vm_read = response_payload(
        handle_read_file(&args(&[
            ("vm_id", json!("missing")),
            ("path", json!("/work/notes.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_vm_read["success"], json!(false));

    let escaped_read = response_payload(
        handle_read_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("../../escape.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(escaped_read["success"], json!(false));

    let missing_file_read = response_payload(
        handle_read_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/missing.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_file_read["success"], json!(false));

    let empty_batch = response_payload(
        handle_read_files(&args(&[("vm_id", json!("vm-1")), ("paths", json!([]))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        empty_batch["error"],
        json!("paths array is required and must not be empty")
    );

    let invalid_batch_item = response_payload(
        handle_read_files(&args(&[("vm_id", json!("vm-1")), ("paths", json!([""]))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        invalid_batch_item["error"],
        json!("paths[0] must be a non-empty string")
    );

    let missing_vm_batch = response_payload(
        handle_read_files(&args(&[
            ("vm_id", json!("missing")),
            ("paths", json!(["/work/notes.txt"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_vm_batch["failed_count"], json!(1));

    let mixed_batch = response_payload(
        handle_read_files(&args(&[
            ("vm_id", json!("vm-1")),
            (
                "paths",
                json!([
                    "/etc/passwd",
                    "/work/dir",
                    "/work/binary.bin",
                    "/work/missing.txt",
                    "/work/notes.txt"
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(mixed_batch["success"], json!(false));
    assert_eq!(mixed_batch["read_count"], json!(1));
    let failures = mixed_batch["failed"].as_array().unwrap();
    assert!(failures
        .iter()
        .any(|item| item["error"] == "Path must be within /work or /tmp"));
    assert!(failures
        .iter()
        .any(|item| item["error"] == "Path is a directory, not a file"));
    assert!(failures.iter().any(|item| {
        item["error"]
            .as_str()
            .unwrap_or_default()
            .contains("binary or uses unsupported encoding")
    }));
    assert!(failures.iter().any(|item| {
        item["error"]
            .as_str()
            .unwrap_or_default()
            .contains("File not found")
    }));

    let no_op_edit = response_payload(
        handle_edit_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_path", json!("/work/notes.txt")),
            ("old_string", json!("alpha")),
            ("new_string", json!("alpha")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(no_op_edit["success"], json!(true));
    assert_eq!(no_op_edit["replacements_made"], json!(0));

    let missing_old = response_payload(
        handle_edit_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_path", json!("/work/notes.txt")),
            ("new_string", json!("beta")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        missing_old["error"],
        json!("vm_id, file_path, old_string, and new_string are required")
    );

    let missing_vm_edit = response_payload(
        handle_edit_file(&args(&[
            ("vm_id", json!("missing")),
            ("file_path", json!("/work/notes.txt")),
            ("old_string", json!("alpha")),
            ("new_string", json!("beta")),
        ]))
        .await
        .unwrap(),
    );
    assert!(missing_vm_edit["error"]
        .as_str()
        .unwrap()
        .contains("Create one first"));

    let unread_edit = response_payload(
        handle_edit_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_path", json!("/work/fresh.txt")),
            ("old_string", json!("fresh")),
            ("new_string", json!("updated")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(unread_edit["success"], json!(false));
    assert_eq!(unread_edit["hint"], json!("Use agent_vm_read_file to read the file first. This ensures edits are based on current file content."));

    register_file_read("vm-1", "/work/notes.txt").unwrap();
    crate::native::shared::redis_delete("agent_vm_file_reads:vm-1").unwrap();
    register_file_read("vm-1", "/work/single.txt").unwrap();
    let failed_edit = response_payload(
        handle_edit_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_path", json!("/work/notes.txt")),
            ("old_string", json!("missing")),
            ("new_string", json!("beta")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(failed_edit["success"], json!(false));
    assert!(!failed_edit["error"].as_str().unwrap().is_empty());

    let invalid_edit_batch = response_payload(
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
        invalid_edit_batch["error"],
        json!("edits[0] has old_string equal to new_string (no-op)")
    );

    let missing_vm_edit_batch = response_payload(
        handle_edit_files(&args(&[
            ("vm_id", json!("missing")),
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
    assert_eq!(missing_vm_edit_batch["failed_count"], json!(1));

    crate::native::shared::redis_delete("agent_vm_file_reads:vm-1").unwrap();
    register_file_read("vm-1", "/work/single.txt").unwrap();
    let partial_edit_batch = response_payload(
        handle_edit_files(&args(&[
            ("vm_id", json!("vm-1")),
            (
                "edits",
                json!([
                    {
                        "file_path": "/work/single.txt",
                        "old_string": "solo",
                        "new_string": "beta"
                    },
                    {
                        "file_path": "/work/fresh.txt",
                        "old_string": "fresh",
                        "new_string": "updated"
                    }
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(partial_edit_batch["success"], json!(false));
    assert_eq!(partial_edit_batch["edited_count"], json!(1));
    assert_eq!(partial_edit_batch["failed_count"], json!(1));
    assert!(partial_edit_batch["message"]
        .as_str()
        .unwrap()
        .contains("Applied 1/2"));
    assert_eq!(fs::read_to_string(root.join("single.txt")).unwrap(), "beta");
}

#[tokio::test]
async fn workspace_handlers_cover_validation_and_failure_branches() {
    let env = TestEnv::new("coverage-workspace");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);
    fs::create_dir_all(root.join("input")).unwrap();
    fs::create_dir_all(root.join("output")).unwrap();
    fs::create_dir_all(root.join("input/nested")).unwrap();
    fs::write(root.join("output/existing.txt"), "workspace").unwrap();
    fs::write(root.join("archive.bad.zip"), "not a zip").unwrap();

    let missing_copy_from = response_payload(
        handle_copy_from_workspace(&args(&[("vm_id", json!("vm-1"))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        missing_copy_from["error"],
        json!("vm_id and workspace_path are required")
    );

    let missing_vm_copy_from = response_payload(
        handle_copy_from_workspace(&args(&[
            ("vm_id", json!("missing")),
            ("workspace_path", json!("input/source.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_vm_copy_from["success"], json!(false));

    let failed_copy_from = response_payload(
        handle_copy_from_workspace(&args(&[
            ("vm_id", json!("vm-1")),
            ("workspace_path", json!("input/missing.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(failed_copy_from["success"], json!(false));

    let missing_copy_to = response_payload(
        handle_copy_to_workspace(&args(&[("vm_id", json!("vm-1"))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        missing_copy_to["error"],
        json!("vm_id, vm_path, and workspace_path are required")
    );

    let missing_vm_copy_to = response_payload(
        handle_copy_to_workspace(&args(&[
            ("vm_id", json!("missing")),
            ("vm_path", json!("/work/output/existing.txt")),
            ("workspace_path", json!("input/copied.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_vm_copy_to["success"], json!(false));

    let failed_copy_to = response_payload(
        handle_copy_to_workspace(&args(&[
            ("vm_id", json!("vm-1")),
            ("vm_path", json!("/work/missing.txt")),
            ("workspace_path", json!("input/copied.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(failed_copy_to["success"], json!(false));

    let missing_chat_list = response_payload(
        handle_list_workspace_files(&args(&[("vm_id", json!("vm-1"))]))
            .await
            .unwrap(),
    );
    assert_eq!(missing_chat_list["error"], json!("chat_id is required"));

    let missing_vm_list = response_payload(
        handle_list_workspace_files(&args(&[("chat_id", json!("chat-1"))]))
            .await
            .unwrap(),
    );
    assert_eq!(missing_vm_list["success"], json!(true));

    let shared_root = workspace_root_for_ids("chat-1", "vm-1").unwrap();
    fs::create_dir_all(shared_root.join("output/subdir")).unwrap();
    fs::write(shared_root.join("output/large.bin"), vec![b'x'; 2048]).unwrap();
    let listed = response_payload(
        handle_list_workspace_files(&args(&[
            ("chat_id", json!("chat-1")),
            ("path", json!("output")),
        ]))
        .await
        .unwrap(),
    );
    assert!(listed["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| { entry["name"] == "large.bin" && entry["size_formatted"] == "2.0 KB" }));

    let missing_filename = response_payload(
        handle_write_to_workspace(&args(&[("chat_id", json!("chat-1"))]))
            .await
            .unwrap(),
    );
    assert_eq!(missing_filename["error"], json!("path is required"));

    let invalid_directory = response_payload(
        handle_write_to_workspace(&args(&[("chat_id", json!("chat-1"))]))
            .await
            .unwrap(),
    );
    assert_eq!(invalid_directory["error"], json!("path is required"));

    let large_write = response_payload(
        handle_write_to_workspace(&args(&[
            ("chat_id", json!("chat-1")),
            ("path", json!("output/large.txt")),
            ("content", json!("x".repeat(2048))),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(large_write["size_formatted"], json!("2.0 KB"));

    let missing_link = response_payload(
        handle_get_workspace_file_link(&args(&[
            ("chat_id", json!("chat-1")),
            ("vm_id", json!("vm-1")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        missing_link["error"],
        json!("vm_id and file_path are required")
    );

    let missing_unzip = response_payload(handle_unzip_file(&Map::new()).await.unwrap());
    assert_eq!(
        missing_unzip["error"],
        json!("vm_id and zip_path are required")
    );

    let missing_vm_unzip = response_payload(
        handle_unzip_file(&args(&[
            ("vm_id", json!("missing")),
            ("zip_path", json!("/work/archive.bad.zip")),
        ]))
        .await
        .unwrap(),
    );
    assert!(missing_vm_unzip["error"]
        .as_str()
        .unwrap()
        .contains("No VM found"));

    let bad_unzip = response_payload(
        handle_unzip_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("zip_path", json!("/work/archive.bad.zip")),
        ]))
        .await
        .unwrap(),
    );
    assert!(bad_unzip["error"]
        .as_str()
        .unwrap()
        .contains("Extraction failed"));
}

#[tokio::test]
async fn skill_and_search_handlers_cover_timeout_nonzero_and_validation_paths() {
    let env = TestEnv::new("coverage-skill-search");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);
    fs::create_dir_all(root.join("search")).unwrap();
    fs::write(root.join("search/one.txt"), "Alpha\nneedle\nalpha").unwrap();
    fs::write(root.join("search/two.txt"), "needle twice\nneedle").unwrap();

    let missing_skill_args =
        response_payload(handle_execute_skill_script(&Map::new()).await.unwrap());
    assert_eq!(
        missing_skill_args["error"],
        json!("skill_name and script_name are required")
    );

    let absolute_skill = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("/tmp/absolute")),
            ("script_name", json!("run.py")),
            ("vm_id", json!("vm-1")),
        ]))
        .await
        .unwrap(),
    );
    assert!(absolute_skill["error"]
        .as_str()
        .unwrap()
        .contains("Skill directory not found"));

    let missing_skill = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("missing-skill")),
            ("script_name", json!("run.py")),
            ("vm_id", json!("vm-1")),
        ]))
        .await
        .unwrap(),
    );
    assert!(missing_skill["error"]
        .as_str()
        .unwrap()
        .contains("Skill directory not found"));

    let script_dir = env.root.join("skills-user/demo/scripts");
    fs::create_dir_all(&script_dir).unwrap();

    let invalid_script_path = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("demo")),
            ("script_name", json!("../escape.py")),
            ("vm_id", json!("vm-1")),
        ]))
        .await
        .unwrap(),
    );
    assert!(invalid_script_path["error"]
        .as_str()
        .unwrap()
        .contains("Script not found"));

    let missing_script = response_payload(
        handle_execute_skill_script(&args(&[
            ("skill_name", json!("demo")),
            ("script_name", json!("missing.py")),
            ("vm_id", json!("vm-1")),
        ]))
        .await
        .unwrap(),
    );
    assert!(missing_script["error"]
        .as_str()
        .unwrap()
        .contains("Script not found"));

    fs::write(
        script_dir.join("fail.py"),
        "import sys\nsys.stderr.write('fail stderr')\nsys.exit(2)\n",
    )
    .unwrap();
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
    assert!(failed_script["error"]
        .as_str()
        .unwrap()
        .contains("fail stderr"));

    fs::write(
        script_dir.join("sleep.py"),
        "import time\ntime.sleep(2)\nprint('done')\n",
    )
    .unwrap();
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

    let missing_find_args = response_payload(handle_find_files(&Map::new()).await.unwrap());
    assert_eq!(
        missing_find_args["error"],
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

    let invalid_glob = response_payload(
        handle_find_files(&args(&[("vm_id", json!("vm-1")), ("pattern", json!("["))]))
            .await
            .unwrap(),
    );
    assert!(!invalid_glob["success"].as_bool().unwrap());

    let escaped_find = response_payload(
        handle_find_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("pattern", json!("*.txt")),
            ("path", json!("../../escape")),
        ]))
        .await
        .unwrap(),
    );
    assert!(!escaped_find["success"].as_bool().unwrap());

    let truncated_find = response_payload(
        handle_find_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("pattern", json!("*.txt")),
            ("path", json!("/work/search")),
            ("max_results", json!(1)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(truncated_find["count"], json!(1));
    assert_eq!(truncated_find["truncated"], json!(true));

    let missing_search_args = response_payload(handle_grep(&Map::new()).await.unwrap());
    assert_eq!(
        missing_search_args["error"],
        json!("vm_id and pattern are required")
    );

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

    let invalid_regex = response_payload(
        handle_grep(&args(&[("vm_id", json!("vm-1")), ("pattern", json!("("))]))
            .await
            .unwrap(),
    );
    assert!(!invalid_regex["success"].as_bool().unwrap());

    let escaped_search = response_payload(
        handle_grep(&args(&[
            ("vm_id", json!("vm-1")),
            ("pattern", json!("needle")),
            ("path", json!("../../escape")),
        ]))
        .await
        .unwrap(),
    );
    assert!(!escaped_search["success"].as_bool().unwrap());

    let files_only = response_payload(
        handle_grep(&args(&[
            ("vm_id", json!("vm-1")),
            ("pattern", json!("NEEDLE")),
            ("path", json!("/work/search")),
            ("case_insensitive", json!(true)),
            ("output_mode", json!("files")),
            ("max_results", json!(1)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(files_only["count"], json!(1));

    let counted = response_payload(
        handle_grep(&args(&[
            ("vm_id", json!("vm-1")),
            ("pattern", json!("needle")),
            ("path", json!("/work/search")),
            ("output_mode", json!("count")),
            ("file_pattern", json!("*.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert!(counted["total"].as_u64().unwrap() >= 3);

    let contextual = response_payload(
        handle_grep(&args(&[
            ("vm_id", json!("vm-1")),
            ("pattern", json!("needle")),
            ("path", json!("/work/search")),
            ("context_lines", json!(1)),
        ]))
        .await
        .unwrap(),
    );
    assert!(contextual["matches"]
        .as_array()
        .unwrap()
        .iter()
        .any(
            |item| item.as_str().unwrap().contains("-1-") || item.as_str().unwrap().contains(":2:")
        ));

    let missing_file_match_args = response_payload(handle_grep_file(&Map::new()).await.unwrap());
    assert_eq!(
        missing_file_match_args["error"],
        json!("vm_id, path, and patterns are required")
    );

    let missing_vm_file_match = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("missing")),
            ("path", json!("/work/search/one.txt")),
            ("patterns", json!(["needle"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_vm_file_match["success"], json!(false));

    let invalid_match_mode = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/search/one.txt")),
            ("patterns", json!(["needle"])),
            ("match_mode", json!("glob")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        invalid_match_mode["error"],
        json!("match_mode must be either 'literal' or 'regex'")
    );

    let invalid_pattern_type = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/search/one.txt")),
            ("patterns", json!(["needle", 7])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        invalid_pattern_type["error"],
        json!("patterns[1] must be a string")
    );

    let invalid_regex_pattern = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/search/one.txt")),
            ("patterns", json!(["("])),
            ("match_mode", json!("regex")),
        ]))
        .await
        .unwrap(),
    );
    assert!(invalid_regex_pattern["error"]
        .as_str()
        .unwrap()
        .contains("Invalid regex pattern '('"));

    let directory_path = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/search")),
            ("patterns", json!(["needle"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(directory_path["success"], json!(false));
    assert!(directory_path["error"]
        .as_str()
        .unwrap()
        .contains("Path is a directory"));

    fs::write(root.join("search/binary.bin"), [0xff, 0x00, 0x10]).unwrap();
    let binary_file = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/search/binary.bin")),
            ("patterns", json!(["needle"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(binary_file["success"], json!(false));
    assert_eq!(
        binary_file["error"],
        json!("File appears to be binary or uses unsupported encoding")
    );

    let zero_matches = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/search/one.txt")),
            ("patterns", json!(["zzz"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(zero_matches["success"], json!(true));
    assert_eq!(zero_matches["matched_any"], json!(false));
    assert_eq!(
        zero_matches["results_by_pattern"]["zzz"]["total_matches"],
        json!(0)
    );

    let case_insensitive_literal = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/search/one.txt")),
            ("patterns", json!(["alpha"])),
            ("case_insensitive", json!(true)),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(case_insensitive_literal["matched_any"], json!(true));
    assert_eq!(
        case_insensitive_literal["results_by_pattern"]["alpha"]["total_matches"],
        json!(2)
    );

    let regex_mode = response_payload(
        handle_grep_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/search/one.txt")),
            ("patterns", json!(["Alpha|needle"])),
            ("match_mode", json!("regex")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        regex_mode["results_by_pattern"]["Alpha|needle"]["total_matches"],
        json!(2)
    );

    let zip_path = root.join("search.zip");
    write_zip(&zip_path, &[("bundle/a.txt", b"a"), ("bundle/b.txt", b"b")]);
    let unzip_success = response_payload(
        handle_unzip_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("zip_path", json!("/work/search.zip")),
            ("dest_path", json!("/work/unpacked")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(unzip_success["success"], json!(true));
    assert_eq!(unzip_success["files_extracted"], json!("2"));
}
