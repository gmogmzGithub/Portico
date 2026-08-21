import ast
import logging
import re
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]


def _load_display_name_helper():
    source_path = (
        ROOT / "src" / "patches" / "backend" / "open_webui" / "routers" / "chats.py"
    )
    module_ast = ast.parse(source_path.read_text())
    selected_nodes = [
        node
        for node in module_ast.body
        if isinstance(node, ast.FunctionDef) and node.name == "_format_server_display_name"
    ]

    namespace = {
        "MCP_CONFIGS_DIR": ROOT / "mcp-configs",
        "MCP_CONFIGS_USER_DIR": ROOT / "mcp-configs-user",
        "YAML_AVAILABLE": True,
        "Path": Path,
        "log": logging.getLogger("test-chat-capabilities"),
        "re": re,
        "yaml": yaml,
    }
    exec(
        compile(ast.Module(body=selected_nodes, type_ignores=[]), str(source_path), "exec"),
        namespace,
    )
    return namespace["_format_server_display_name"], namespace


def test_chat_capabilities_display_name_prefers_yaml_metadata():
    format_display_name, _namespace = _load_display_name_helper()

    assert format_display_name("server:google_workspace") == "Google Workspace"
    assert format_display_name("server:chrome-devtools") == "Chrome DevTools"


def test_chat_capabilities_display_name_falls_back_to_underscore_split():
    format_display_name, namespace = _load_display_name_helper()
    missing_dir = ROOT / "does-not-exist"
    namespace["MCP_CONFIGS_DIR"] = missing_dir
    namespace["MCP_CONFIGS_USER_DIR"] = missing_dir

    assert format_display_name("server:google_workspace") == "Google Workspace"


def _load_skill_enrichment_helpers():
    source_path = (
        ROOT / "src" / "patches" / "backend" / "open_webui" / "routers" / "chats.py"
    )
    module_ast = ast.parse(source_path.read_text())
    wanted = {
        "_skill_catalog_index",
        "_enrich_active_skill",
        "_default_skill_display_name",
    }
    selected_nodes = [
        node
        for node in module_ast.body
        if isinstance(node, ast.FunctionDef) and node.name in wanted
    ]
    assert {node.name for node in selected_nodes} == wanted

    namespace = {}
    exec(
        compile(ast.Module(body=selected_nodes, type_ignores=[]), str(source_path), "exec"),
        namespace,
    )
    return namespace["_skill_catalog_index"], namespace["_enrich_active_skill"]


_CATALOG = [
    {
        "name": "web-search",
        "display_name": "Web Search",
        "source": "system",
        "marketplace_relationship": None,
    },
    {
        "name": "release-notes-sample",
        "display_name": "Release Notes Sample",
        "source": "user",
        "marketplace_relationship": "published",
    },
    {
        "name": "anthropic-agent-skills/document-skills/docx",
        "display_name": "Docx",
        "source": "marketplace",
        "marketplace_relationship": "installed",
    },
    {
        "name": "ai-marketplace/chief-of-staff",
        "display_name": "Chief Of Staff Runtime Surface",
        "source": "marketplace",
        "marketplace_relationship": "installed",
    },
    # Two marketplaces shipping the same leaf name: leaf lookups must refuse
    # to guess between them.
    {"name": "repo-a/dupe-skill", "source": "marketplace"},
    {"name": "repo-b/tools/dupe-skill", "source": "marketplace"},
]


def test_active_skill_enrichment_exact_fqn_match():
    index_fn, enrich = _load_skill_enrichment_helpers()
    index = index_fn(_CATALOG)

    row = enrich("anthropic-agent-skills/document-skills/docx", index)
    assert row == {
        "name": "anthropic-agent-skills/document-skills/docx",
        "display_name": "Docx",
        "source": "marketplace",
        "marketplace_relationship": "installed",
        "marketplace_id": "anthropic-agent-skills",
    }

    user_row = enrich("release-notes-sample", index)
    assert user_row["source"] == "user"
    assert user_row["marketplace_relationship"] == "published"
    assert user_row["marketplace_id"] is None


def test_active_skill_enrichment_resolves_legacy_and_leaf_aliases():
    index_fn, enrich = _load_skill_enrichment_helpers()
    index = index_fn(_CATALOG)

    # Legacy 2-segment alias for a 3-segment plugin skill.
    legacy = enrich("anthropic-agent-skills/docx", index)
    assert legacy["source"] == "marketplace"
    assert legacy["marketplace_id"] == "anthropic-agent-skills"
    assert legacy["name"] == "anthropic-agent-skills/docx"

    # Bare leaf resolving a unique catalog entry.
    leaf = enrich("chief-of-staff", index)
    assert leaf["source"] == "marketplace"
    assert leaf["marketplace_id"] == "ai-marketplace"
    assert leaf["display_name"] == "Chief Of Staff Runtime Surface"


def test_active_skill_enrichment_ambiguous_leaf_stays_unenriched():
    index_fn, enrich = _load_skill_enrichment_helpers()
    index = index_fn(_CATALOG)

    row = enrich("dupe-skill", index)
    assert row == {"name": "dupe-skill", "display_name": "Dupe Skill"}


def test_active_skill_enrichment_display_name_fallbacks():
    index_fn, enrich = _load_skill_enrichment_helpers()
    # Catalog entry without a frontmatter display_name: fall back to the
    # title-cased leaf, not the full path.
    index = index_fn([{"name": "repo-x/plug/pdf-tools", "source": "marketplace"}])

    row = enrich("repo-x/plug/pdf-tools", index)
    assert row["display_name"] == "Pdf Tools"
    assert row["marketplace_id"] == "repo-x"


def test_active_skill_enrichment_passthrough_without_catalog():
    index_fn, enrich = _load_skill_enrichment_helpers()

    assert enrich("some-skill", None) == {
        "name": "some-skill",
        "display_name": "Some Skill",
    }
    empty_index = index_fn([])
    assert enrich("repo/skill", empty_index) == {
        "name": "repo/skill",
        "display_name": "Repo/Skill",
    }
