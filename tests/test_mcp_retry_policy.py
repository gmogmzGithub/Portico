from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
ATLASSIAN_YAML = (
    REPO_ROOT / "mcp-configs" / "mcp-atlassian" / "mcp-atlassian.yaml"
)

EXPECTED_ATLASSIAN_RETRYABLE_TOOLS = [
    "atlassianUserInfo",
    "fetch",
    "getAccessibleAtlassianResources",
    "getCompassComponent",
    "getCompassComponents",
    "getCompassCustomFieldDefinitions",
    "getConfluenceCommentChildren",
    "getConfluencePage",
    "getConfluencePageDescendants",
    "getConfluencePageFooterComments",
    "getConfluencePageInlineComments",
    "getConfluenceSpaces",
    "getIssueLinkTypes",
    "getJiraIssue",
    "getJiraIssueRemoteIssueLinks",
    "getJiraIssueTypeMetaWithFields",
    "getJiraProjectIssueTypesMetadata",
    "getPagesInConfluenceSpace",
    "getTeamworkGraphContext",
    "getTeamworkGraphObject",
    "getTransitionsForJiraIssue",
    "getVisibleJiraProjects",
    "lookupJiraAccountId",
    "search",
    "searchConfluenceUsingCql",
    "searchJiraIssuesUsingJql",
]


def _top_level_list(raw: str, key: str) -> list[str]:
    lines = raw.splitlines()
    marker = f"{key}:"
    start = lines.index(marker) + 1
    values: list[str] = []
    for line in lines[start:]:
        if line and not line[0].isspace():
            break
        stripped = line.strip()
        if stripped.startswith("- "):
            values.append(stripped[2:].strip())
    return values


def test_atlassian_is_the_only_server_with_retry_policy_during_pilot():
    configured = []
    for path in sorted((REPO_ROOT / "mcp-configs").glob("*/*.yaml")):
        if "\nretryable_tools:" in f"\n{path.read_text(encoding='utf-8')}":
            configured.append(path.relative_to(REPO_ROOT).as_posix())
    assert configured == [
        "mcp-configs/mcp-atlassian/mcp-atlassian.yaml"
    ]


def test_atlassian_retry_policy_is_exact_read_only_allowlist_and_timeout_stays_60():
    raw = ATLASSIAN_YAML.read_text(encoding="utf-8")
    assert "\ntool_call_timeout: 60\n" in f"\n{raw}"
    assert _top_level_list(raw, "retryable_tools") == EXPECTED_ATLASSIAN_RETRYABLE_TOOLS
    assert len(set(EXPECTED_ATLASSIAN_RETRYABLE_TOOLS)) == 26
    assert not any(
        tool.lower().startswith(
            ("add", "create", "edit", "transition", "update")
        )
        for tool in EXPECTED_ATLASSIAN_RETRYABLE_TOOLS
    )
