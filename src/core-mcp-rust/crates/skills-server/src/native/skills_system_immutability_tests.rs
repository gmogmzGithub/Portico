use super::*;

fn install_system_skill(root: &TestRoot, skill_name: &str) -> (PathBuf, PathBuf, PathBuf) {
    let skill_md = root.write_skill(
        "skills",
        skill_name,
        &skill_markdown("Built In Skill", "System provided", &["server:web-tools"]),
    );
    let reference = root.write_relative(
        "skills",
        &format!("{skill_name}/references/guide.md"),
        "system guide v1",
    );
    let script = root.write_relative(
        "skills",
        &format!("{skill_name}/scripts/runner.py"),
        "print('system script v1')",
    );
    (skill_md, reference, script)
}

#[tokio::test]
async fn built_in_skill_reads_resolve_system_content() {
    let root = TestRoot::new("system-readonly-reads");
    let (skill_md, reference, script) = install_system_skill(&root, "built-in-skill");

    let read_skill = call!(
        handle_read_skill,
        args(&[("skill_name", json!("built-in-skill"))])
    );
    assert_eq!(read_skill["success"], json!(true));
    assert_eq!(read_skill["metadata"]["name"], json!("built-in-skill"));
    assert_eq!(read_skill["metadata"]["source"], json!("system"));
    assert_eq!(
        read_skill["content"],
        json!(fs::read_to_string(&skill_md).unwrap())
    );

    let read_reference = call!(
        handle_get_skill_reference,
        args(&[
            ("skill_name", json!("built-in-skill")),
            ("reference_path", json!("guide.md"))
        ])
    );
    assert_eq!(read_reference["success"], json!(true));
    assert_eq!(read_reference["skill_name"], json!("built-in-skill"));
    assert_eq!(read_reference["reference_path"], json!("guide.md"));
    assert_eq!(read_reference["content"], json!("system guide v1"));

    assert_eq!(fs::read_to_string(reference).unwrap(), "system guide v1");
    assert_eq!(
        fs::read_to_string(script).unwrap(),
        "print('system script v1')"
    );
    assert!(!root.path.join("skills-user/built-in-skill").exists());
}

#[tokio::test]
async fn built_in_system_skills_reject_all_mutations_and_remain_unchanged() {
    let root = TestRoot::new("system-readonly-mutations");
    let (skill_md, reference, script) = install_system_skill(&root, "built-in-skill");
    let original_skill = fs::read_to_string(&skill_md).unwrap();
    let original_reference = fs::read_to_string(&reference).unwrap();
    let original_script = fs::read_to_string(&script).unwrap();

    let updated_skill = call!(
        handle_update_skill,
        args(&[
            ("skill_name", json!("built-in-skill")),
            ("skill_content", json!("mutated"))
        ])
    );
    assert_eq!(updated_skill["success"], json!(false));
    assert_eq!(updated_skill["code"], json!("system_skill_read_only"));

    let deleted_skill = call!(
        handle_delete_skill,
        args(&[
            ("skill_name", json!("built-in-skill")),
            ("confirm", json!(true))
        ])
    );
    assert_eq!(deleted_skill["success"], json!(false));
    assert_eq!(deleted_skill["code"], json!("system_skill_read_only"));

    let created_reference = call!(
        handle_create_skill_reference,
        args(&[
            ("skill_name", json!("built-in-skill")),
            ("reference_path", json!("nested/new-guide.md")),
            ("content", json!("mutated"))
        ])
    );
    assert_eq!(created_reference["success"], json!(false));
    assert_eq!(created_reference["code"], json!("system_skill_read_only"));

    let updated_reference = call!(
        handle_update_skill_reference,
        args(&[
            ("skill_name", json!("built-in-skill")),
            ("reference_path", json!("guide.md")),
            ("content", json!("mutated"))
        ])
    );
    assert_eq!(updated_reference["success"], json!(false));
    assert_eq!(updated_reference["code"], json!("system_skill_read_only"));

    let deleted_reference = call!(
        handle_delete_skill_reference,
        args(&[
            ("skill_name", json!("built-in-skill")),
            ("reference_path", json!("guide.md"))
        ])
    );
    assert_eq!(deleted_reference["success"], json!(false));
    assert_eq!(deleted_reference["code"], json!("system_skill_read_only"));

    let created_script = call!(
        handle_create_skill_script,
        args(&[
            ("skill_name", json!("built-in-skill")),
            ("script_path", json!("helpers/new_runner.py")),
            ("content", json!("print('mutated')"))
        ])
    );
    assert_eq!(created_script["success"], json!(false));
    assert_eq!(created_script["code"], json!("system_skill_read_only"));

    let updated_script = call!(
        handle_update_skill_script,
        args(&[
            ("skill_name", json!("built-in-skill")),
            ("script_path", json!("runner.py")),
            ("content", json!("print('mutated')"))
        ])
    );
    assert_eq!(updated_script["success"], json!(false));
    assert_eq!(updated_script["code"], json!("system_skill_read_only"));

    let deleted_script = call!(
        handle_delete_skill_script,
        args(&[
            ("skill_name", json!("built-in-skill")),
            ("script_path", json!("runner.py"))
        ])
    );
    assert_eq!(deleted_script["success"], json!(false));
    assert_eq!(deleted_script["code"], json!("system_skill_read_only"));

    assert_eq!(fs::read_to_string(&skill_md).unwrap(), original_skill);
    assert_eq!(fs::read_to_string(&reference).unwrap(), original_reference);
    assert_eq!(fs::read_to_string(&script).unwrap(), original_script);
    assert!(!root.path.join("skills-user/built-in-skill").exists());
    assert!(!root
        .path
        .join("skills-user/built-in-skill/references/nested/new-guide.md")
        .exists());
    assert!(!root
        .path
        .join("skills-user/built-in-skill/scripts/helpers/new_runner.py")
        .exists());

    let reread_skill = call!(
        handle_read_skill,
        args(&[("skill_name", json!("built-in-skill"))])
    );
    assert_eq!(reread_skill["success"], json!(true));
    assert_eq!(reread_skill["metadata"]["source"], json!("system"));
    assert_eq!(reread_skill["content"], json!(original_skill));

    let reread_reference = call!(
        handle_get_skill_reference,
        args(&[
            ("skill_name", json!("built-in-skill")),
            ("reference_path", json!("references/guide.md"))
        ])
    );
    assert_eq!(reread_reference["success"], json!(true));
    assert_eq!(reread_reference["content"], json!(original_reference));
}
