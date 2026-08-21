use super::*;

#[tokio::test]
async fn parsing_helpers_cover_invalid_frontmatter_and_conflicts() {
    let root = TestRoot::new("parse-edges");

    let broken_skill = root.write_skill(
        "skills-user",
        "broken-skill",
        "---\nname: Broken\ndescription: [\n---\nBody\n",
    );
    assert!(discover_skills()
        .unwrap()
        .iter()
        .all(|skill| skill.name != "broken-skill"));

    let malformed = split_frontmatter("---\nname: Missing terminator");
    assert_eq!(malformed.0, None);

    let sequence_skill = root.write_skill(
        "skills-user",
        "sequence-skill",
        "---\n- not-a-map\n---\nBody\n",
    );
    assert!(parse_skill_file(&sequence_skill, "user", "sequence-skill")
        .unwrap()
        .is_none());

    let missing_description = root.write_skill(
        "skills-user",
        "missing-description",
        "---\nname: Missing Description\n---\nBody\n",
    );
    assert!(
        parse_skill_file(&missing_description, "user", "missing-description")
            .unwrap()
            .is_none()
    );

    root.write_skill(
        "skills",
        "system-only",
        &skill_markdown("System Only", "System-provided", &[]),
    );
    let conflict = response_payload(
        handle_create_skill(&args(&[
            ("skill_name", json!("system-only")),
            (
                "skill_content",
                json!(skill_markdown("System Only", "User body", &[])),
            ),
        ]))
        .await
        .unwrap(),
    );
    assert_eq!(conflict["success"], json!(false));
    assert!(conflict["error"].as_str().unwrap().contains("system skill"));

    assert_eq!(
        derive_skill_name(&root.path.join("skills"), &broken_skill, "marketplace"),
        None
    );
}

#[test]
fn parsing_helpers_cover_reference_collection_and_name_derivation() {
    let root = TestRoot::new("parse-success");
    let skill_md = root.write_skill(
        "skills-marketplace",
        "vendor/demo-skill",
        &skill_markdown("Demo Skill", "Collect references", &["server:time"]),
    );
    root.write_relative(
        "skills-marketplace",
        "vendor/demo-skill/references/guide.md",
        "# Guide",
    );
    root.write_relative(
        "skills-marketplace",
        "vendor/demo-skill/scripts/run.py",
        "print('hi')\n",
    );

    let parsed = parse_skill_file(&skill_md, "marketplace", "vendor/demo-skill")
        .unwrap()
        .unwrap();
    assert_eq!(parsed.references, vec!["references/guide.md".to_string()]);
    assert_eq!(parsed.scripts, vec!["scripts/run.py".to_string()]);
    assert_eq!(parsed.required_mcp_servers, vec!["server:time".to_string()]);
    assert_eq!(
        derive_skill_name(
            &root.path.join("skills-marketplace"),
            &skill_md,
            "marketplace"
        ),
        Some("vendor/demo-skill".to_string())
    );

    let shallow_marketplace = root.write_skill(
        "skills-marketplace",
        "broken-depth",
        &skill_markdown("Broken Depth", "Wrong nesting", &[]),
    );
    assert_eq!(
        derive_skill_name(
            &root.path.join("skills-marketplace"),
            &shallow_marketplace,
            "marketplace"
        ),
        None
    );
}

#[tokio::test]
async fn duplicate_frontmatter_keys_use_last_value_and_show_up_in_list_skills() {
    let root = TestRoot::new("duplicate-frontmatter");
    let skill_md = root.write_skill(
        "skills-marketplace",
        "trust-kit/shared-trino",
        concat!(
            "---\n",
            "name: shared-trino\n",
            "description: Shared Trino skill\n",
            "version: 2.1\n",
            "priority: low\n",
            "priority: high\n",
            "author: first-author\n",
            "author: second-author\n",
            "triggers:\n",
            "  - trino\n",
            "---\n",
            "# Shared Trino\n"
        ),
    );

    let parsed = parse_skill_file(&skill_md, "marketplace", "trust-kit/shared-trino")
        .unwrap()
        .unwrap();
    assert_eq!(parsed.priority, "high");
    assert_eq!(parsed.version.as_deref(), Some("2.1"));
    assert_eq!(parsed.author.as_deref(), Some("second-author"));
    assert_eq!(parsed.triggers, vec!["trino".to_string()]);

    let listed = response_payload(
        handle_list_skills(&args(&[("filter_source", json!("marketplace"))]))
            .await
            .unwrap(),
    );
    assert_eq!(listed["success"], json!(true));
    assert_eq!(listed["total"], json!(1));
    assert_eq!(listed["skills"][0]["name"], json!("trust-kit/shared-trino"));
    assert_eq!(listed["skills"][0]["priority"], json!("high"));
    assert_eq!(listed["skills"][0]["version"], json!("2.1"));
    assert_eq!(listed["skills"][0]["author"], json!("second-author"));
    assert_eq!(listed["skills"][0]["triggers"], json!(["trino"]));
}
