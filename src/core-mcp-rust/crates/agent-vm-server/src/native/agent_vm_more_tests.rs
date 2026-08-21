use super::*;

#[tokio::test]
async fn destroy_and_batch_argument_validation_cover_missing_inputs() {
    let env = TestEnv::new("more-args");
    env.seed_vm("vm-1", "chat-1");

    let missing_requester = handle_destroy(&args(&[("vm_id", json!("vm-1"))]))
        .await
        .unwrap();
    assert_eq!(
        missing_requester["content"][0]["text"],
        json!("Error: vm_id and requester_chat_id are required")
    );

    let missing_vm = response_payload(
        handle_destroy(&args(&[
            ("vm_id", json!("missing")),
            ("requester_chat_id", json!("chat-1")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_vm["success"], json!(false));
    assert_eq!(missing_vm["error"], json!("VM not found or unauthorized"));

    let no_paths = response_payload(
        handle_read_files(&args(&[("vm_id", json!("vm-1"))]))
            .await
            .unwrap(),
    );
    assert_eq!(no_paths["success"], json!(false));
    assert_eq!(
        no_paths["error"],
        json!("paths array is required and must not be empty")
    );

    let no_edits = response_payload(
        handle_edit_files(&args(&[("vm_id", json!("vm-1"))]))
            .await
            .unwrap(),
    );
    assert_eq!(no_edits["success"], json!(false));
    assert_eq!(
        no_edits["error"],
        json!("edits array is required and must not be empty")
    );
}

#[test]
fn low_level_helpers_cover_missing_root_single_replace_and_directory_unzip() {
    let env = TestEnv::new("more-low-level");
    let vm = env.seed_vm("vm-1", "chat-1");
    let missing_root = env.root.join("missing-root");
    assert!(ensure_within(&missing_root, &missing_root.join("nested/file.txt")).is_ok());

    fs::write(vm_workspace_root(&vm).join("single.txt"), "alpha beta").unwrap();
    register_file_read("vm-1", "/work/single.txt").unwrap();
    assert_eq!(
        edit_file_impl(&vm, "/work/single.txt", "alpha", "omega", false).unwrap(),
        1
    );
    assert_eq!(
        fs::read_to_string(vm_workspace_root(&vm).join("single.txt")).unwrap(),
        "omega beta"
    );

    let zip_path = env.root.join("directory-entry.zip");
    write_zip(
        &zip_path,
        &[
            ("bundle/nested/", b""),
            ("bundle/nested/file.txt", b"payload"),
        ],
    );
    unzip_into(&zip_path, &env.root, &env.root.join("unzipped-dir"), 1).unwrap();
    assert!(env.root.join("unzipped-dir/nested").is_dir());
    assert_eq!(
        fs::read_to_string(env.root.join("unzipped-dir/nested/file.txt")).unwrap(),
        "payload"
    );
}

#[tokio::test]
async fn list_write_find_and_search_default_paths_are_covered() {
    let env = TestEnv::new("more-defaults");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);

    fs::write(root.join("top.txt"), "top level").unwrap();
    fs::create_dir_all(root.join("nested")).unwrap();
    fs::write(root.join("nested/deep.txt"), "needle in deep file").unwrap();
    fs::write(root.join("single-edit.txt"), "before").unwrap();
    register_file_read("vm-1", "/work/single-edit.txt").unwrap();

    let edited = response_payload(
        handle_edit_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_path", json!("/work/single-edit.txt")),
            ("old_string", json!("before")),
            ("new_string", json!("after")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(edited["replacements_made"], json!(1));

    let listed = response_payload(
        handle_list_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("directory", json!("/work")),
        ]))
        .await
        .unwrap(),
    );
    let file_paths = listed["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    assert!(file_paths.contains(&"top.txt"));
    assert!(!file_paths.contains(&"deep.txt"));

    let written = response_payload(
        handle_write_to_workspace(&args(&[
            ("chat_id", json!("chat-1")),
            ("path", json!("default.txt")),
            ("content", json!("workspace default")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(written["path"], json!("default.txt"));
    assert_eq!(
        fs::read_to_string(
            workspace_root_for_ids("chat-1", "vm-1")
                .unwrap()
                .join("default.txt")
        )
        .unwrap(),
        "workspace default"
    );

    let found = response_payload(
        handle_find_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("pattern", json!("**/*.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert!(found["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item == "/work/nested/deep.txt"));

    let searched = response_payload(
        handle_grep(&args(&[
            ("vm_id", json!("vm-1")),
            ("pattern", json!("needle")),
        ]))
        .await
        .unwrap(),
    );
    assert!(searched["matches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item.as_str().unwrap().starts_with("/work/nested/deep.txt:")));
}

#[tokio::test]
async fn execution_and_file_handlers_cover_missing_vm_partial_and_guard_paths() {
    let env = TestEnv::new("more-handler-edges");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);

    let missing_bash = handle_bash(&args(&[])).await.unwrap();
    assert_eq!(
        missing_bash["content"][0]["text"],
        json!("Error: vm_id and command are required")
    );
    let missing_python = response_payload(handle_python(&Map::new()).await.unwrap());
    assert_eq!(missing_python["success"], json!(false));
    assert_eq!(
        missing_python["error"],
        json!("vm_id and script are required")
    );

    let bash_missing_vm = response_payload(
        handle_bash(&args(&[
            ("vm_id", json!("missing")),
            ("command", json!("printf nope")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(bash_missing_vm["success"], json!(false));
    assert_eq!(bash_missing_vm["exit_code"], json!(-1));

    let python_failure = response_payload(
        handle_python(&args(&[
            ("vm_id", json!("vm-1")),
            ("script", json!("raise SystemExit(3)")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(python_failure["success"], json!(false));
    assert_eq!(python_failure["exit_code"], json!(3));

    let missing_vm_create = response_payload(
        handle_create_file(&args(&[
            ("vm_id", json!("missing")),
            ("path", json!("/work/file.txt")),
            ("content", json!("value")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_vm_create["success"], json!(false));

    let escaped_create = response_payload(
        handle_create_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("../../escape.txt")),
            ("content", json!("value")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(escaped_create["success"], json!(false));

    let batch_missing_vm = response_payload(
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
    assert_eq!(batch_missing_vm["success"], json!(false));
    assert_eq!(batch_missing_vm["failed_count"], json!(2));

    let batch_partial = response_payload(
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
    assert_eq!(batch_partial["success"], json!(false));
    assert_eq!(batch_partial["created_count"], json!(1));
    assert_eq!(batch_partial["failed_count"], json!(1));

    fs::write(root.join("plain.txt"), "alpha").unwrap();
    fs::create_dir_all(root.join("dir")).unwrap();
    fs::write(root.join("binary.bin"), [0xff, 0x00, 0x10]).unwrap();
    register_file_read("vm-1", "/work/plain.txt").unwrap();

    let read_missing_vm = response_payload(
        handle_read_file(&args(&[
            ("vm_id", json!("missing")),
            ("path", json!("/work/plain.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(read_missing_vm["success"], json!(false));

    let batch_read = response_payload(
        handle_read_files(&args(&[
            ("vm_id", json!("vm-1")),
            (
                "paths",
                json!([
                    "/work/plain.txt",
                    "/work/dir",
                    "/work/binary.bin",
                    "/etc/passwd"
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(batch_read["success"], json!(false));
    assert_eq!(batch_read["read_count"], json!(1));
    assert_eq!(batch_read["failed_count"], json!(3));
    let failed = batch_read["failed"].as_array().unwrap();
    assert!(failed
        .iter()
        .any(|item| item["error"] == json!("Path is a directory, not a file")));
    assert!(failed.iter().any(|item| {
        item["error"]
            .as_str()
            .unwrap_or_default()
            .contains("binary or uses unsupported encoding")
    }));
    assert!(failed
        .iter()
        .any(|item| item["error"] == json!("Path must be within /work or /tmp")));

    let noop_edit = response_payload(
        handle_edit_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_path", json!("/work/plain.txt")),
            ("old_string", json!("alpha")),
            ("new_string", json!("alpha")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(noop_edit["success"], json!(true));
    assert_eq!(noop_edit["replacements_made"], json!(0));

    let unread_edit = response_payload(
        handle_edit_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_path", json!("/work/good.txt")),
            ("old_string", json!("good")),
            ("new_string", json!("better")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(unread_edit["success"], json!(false));
    assert_eq!(
        unread_edit["error"],
        json!("File must be read before editing")
    );

    let batch_edit_missing_vm = response_payload(
        handle_edit_files(&args(&[
            ("vm_id", json!("missing")),
            (
                "edits",
                json!([
                    {"file_path": "/work/plain.txt", "old_string": "alpha", "new_string": "omega"}
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(batch_edit_missing_vm["success"], json!(false));
    assert_eq!(batch_edit_missing_vm["failed_count"], json!(1));

    let batch_edit_partial = response_payload(
        handle_edit_files(&args(&[
            ("vm_id", json!("vm-1")),
            (
                "edits",
                json!([
                    {"file_path": "/work/plain.txt", "old_string": "alpha", "new_string": "omega"},
                    {"file_path": "/work/missing.txt", "old_string": "x", "new_string": "y"}
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(batch_edit_partial["success"], json!(false));
    assert_eq!(batch_edit_partial["edited_count"], json!(1));
    assert_eq!(batch_edit_partial["failed_count"], json!(1));

    let delete_missing_vm = response_payload(
        handle_delete_file(&args(&[
            ("vm_id", json!("missing")),
            ("path", json!("/work/plain.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(delete_missing_vm["success"], json!(false));

    let listed_missing_dir = response_payload(
        handle_list_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("directory", json!("/work/not-there")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(listed_missing_dir["success"], json!(false));
}

#[test]
fn low_level_path_and_batch_helpers_cover_remaining_edge_cases() {
    let env = TestEnv::new("low-level-edges");
    let vm = env.seed_vm("vm-1", "chat-1");
    let tmp_root = vm_workspace_root(&vm).join(".tmp");
    fs::create_dir_all(&tmp_root).unwrap();
    fs::write(tmp_root.join("temp.txt"), "tmp").unwrap();

    assert_eq!(batch_message(2, 2, "all good", "Created"), "all good");
    assert!(vm_host_path(&vm, "/etc/passwd").is_err());
    assert_eq!(vm_path_string(&vm, &tmp_root).unwrap(), "/work/.tmp");
    assert_eq!(
        vm_path_string(&vm, &tmp_root.join("temp.txt")).unwrap(),
        "/work/.tmp/temp.txt"
    );
    assert!(create_batch_file(&vm, &json!({"path": "/work/only-path.txt"})).is_err());
}

#[tokio::test]
async fn execute_create_read_edit_delete_handlers_cover_missing_vm_and_input_errors() {
    let env = TestEnv::new("handler-errors");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);

    let missing_bash = handle_bash(&args(&[])).await.unwrap();
    assert_eq!(
        missing_bash["content"][0]["text"],
        json!("Error: vm_id and command are required")
    );

    let missing_python = response_payload(handle_python(&args(&[])).await.unwrap());
    assert_eq!(missing_python["success"], json!(false));
    assert_eq!(
        missing_python["error"],
        json!("vm_id and script are required")
    );

    let mut missing_workspace_vm = env.vm("vm-missing", "chat-1");
    missing_workspace_vm.work_bind_source = Some(
        env.root
            .join("workspaces/missing-chat")
            .display()
            .to_string(),
    );
    store_vm_info(&missing_workspace_vm).unwrap();
    let bash_failure = response_payload(
        handle_bash(&args(&[
            ("vm_id", json!("vm-missing")),
            ("command", json!("printf never-runs")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(bash_failure["success"], json!(false));
    assert!(bash_failure["error"]
        .as_str()
        .unwrap()
        .contains("Execution failed"));

    let python_failure = response_payload(
        handle_python(&args(&[
            ("vm_id", json!("vm-missing")),
            ("script", json!("print('never-runs')")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(python_failure["success"], json!(false));
    assert!(python_failure["error"]
        .as_str()
        .unwrap()
        .contains("Execution failed"));

    let missing_create = response_payload(
        handle_create_file(&args(&[
            ("vm_id", json!("missing")),
            ("path", json!("/work/file.txt")),
            ("content", json!("data")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_create["success"], json!(false));

    let invalid_create = response_payload(
        handle_create_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/etc/passwd")),
            ("content", json!("data")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(invalid_create["success"], json!(false));

    let missing_read = response_payload(
        handle_read_file(&args(&[
            ("vm_id", json!("missing")),
            ("path", json!("/work/file.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_read["success"], json!(false));

    let invalid_read = response_payload(
        handle_read_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/etc/passwd")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(invalid_read["success"], json!(false));

    fs::write(root.join("binary.bin"), [0xff, 0x00, 0x10]).unwrap();
    let binary_chunk = response_payload(
        handle_read_fragment(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/work/binary.bin")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(binary_chunk["success"], json!(false));
    assert_eq!(
        binary_chunk["error"],
        json!("File appears to be binary or uses unsupported encoding")
    );

    fs::write(root.join("edit.txt"), "alpha beta").unwrap();
    let no_op = response_payload(
        handle_edit_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_path", json!("/work/edit.txt")),
            ("old_string", json!("beta")),
            ("new_string", json!("beta")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(no_op["replacements_made"], json!(0));

    let not_read = response_payload(
        handle_edit_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_path", json!("/work/edit.txt")),
            ("old_string", json!("beta")),
            ("new_string", json!("omega")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(not_read["success"], json!(false));
    assert_eq!(not_read["error"], json!("File must be read before editing"));

    register_file_read("vm-1", "/work/edit.txt").unwrap();
    let missing_old = response_payload(
        handle_edit_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("file_path", json!("/work/edit.txt")),
            ("old_string", json!("missing")),
            ("new_string", json!("omega")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_old["success"], json!(false));
    assert!(missing_old["error"]
        .as_str()
        .unwrap()
        .contains("old_string not found"));

    let missing_delete = response_payload(
        handle_delete_file(&args(&[
            ("vm_id", json!("missing")),
            ("path", json!("/work/file.txt")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_delete["success"], json!(false));

    let invalid_delete = response_payload(
        handle_delete_file(&args(&[
            ("vm_id", json!("vm-1")),
            ("path", json!("/etc/passwd")),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(invalid_delete["success"], json!(false));
}

#[tokio::test]
async fn batch_handlers_cover_validation_missing_vm_and_partial_failures() {
    let env = TestEnv::new("batch-errors");
    let vm = env.seed_vm("vm-1", "chat-1");
    let root = vm_workspace_root(&vm);

    let empty_paths = response_payload(
        handle_read_files(&args(&[("vm_id", json!("vm-1")), ("paths", json!([]))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        empty_paths["error"],
        json!("paths array is required and must not be empty")
    );

    let bad_path = response_payload(
        handle_read_files(&args(&[("vm_id", json!("vm-1")), ("paths", json!([""]))]))
            .await
            .unwrap(),
    );
    assert_eq!(
        bad_path["error"],
        json!("paths[0] must be a non-empty string")
    );

    let missing_vm_create = response_payload(
        handle_create_files(&args(&[
            ("vm_id", json!("missing")),
            (
                "files",
                json!([
                    {"path": "/work/a.txt", "content": "a"},
                    {"path": "/work/b.txt", "content": "b"}
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_vm_create["success"], json!(false));
    assert_eq!(missing_vm_create["failed_count"], json!(2));

    let malformed_create = response_payload(
        handle_create_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("files", json!(["bad-entry"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        malformed_create["error"],
        json!("files[0] must be an object with path and content")
    );

    let partial_create = response_payload(
        handle_create_files(&args(&[
            ("vm_id", json!("vm-1")),
            (
                "files",
                json!([
                    {"path": "/work/good.txt", "content": "good"},
                    {"path": "/etc/passwd", "content": "bad"}
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(partial_create["success"], json!(false));
    assert_eq!(partial_create["created_count"], json!(1));
    assert_eq!(partial_create["failed_count"], json!(1));

    fs::write(root.join("text.txt"), "plain text").unwrap();
    fs::write(root.join("binary.bin"), [0_u8, 159, 146, 150]).unwrap();
    fs::create_dir_all(root.join("folder")).unwrap();
    let batch_read = response_payload(
        handle_read_files(&args(&[
            ("vm_id", json!("vm-1")),
            (
                "paths",
                json!([
                    "/work/text.txt",
                    "/work/folder",
                    "/work/binary.bin",
                    "/work/missing.txt",
                    "/etc/passwd"
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(batch_read["read_count"], json!(1));
    assert_eq!(batch_read["failed_count"], json!(4));

    register_file_read("vm-1", "/work/text.txt").unwrap();
    let batch_edit = response_payload(
        handle_edit_files(&args(&[
            ("vm_id", json!("vm-1")),
            (
                "edits",
                json!([
                    {
                        "file_path": "/work/text.txt",
                        "old_string": "plain",
                        "new_string": "updated"
                    },
                    {
                        "file_path": "/work/text.txt",
                        "old_string": "missing",
                        "new_string": "x"
                    }
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(batch_edit["success"], json!(false));
    assert_eq!(batch_edit["edited_count"], json!(1));
    assert_eq!(batch_edit["failed_count"], json!(1));

    let missing_vm_edit = response_payload(
        handle_edit_files(&args(&[
            ("vm_id", json!("missing")),
            (
                "edits",
                json!([
                    {
                        "file_path": "/work/text.txt",
                        "old_string": "plain",
                        "new_string": "updated"
                    }
                ]),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(missing_vm_edit["success"], json!(false));
    assert_eq!(missing_vm_edit["failed_count"], json!(1));

    let invalid_edit_shape = response_payload(
        handle_edit_files(&args(&[
            ("vm_id", json!("vm-1")),
            ("edits", json!(["bad-entry"])),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(
        invalid_edit_shape["error"],
        json!("edits[0] must be an object")
    );
}
