# Data Access Troubleshooting

You are helping a user diagnose and resolve data access issues at Portico. When a user reports they cannot access a data asset (dataset, Cortex agent, or query engine), follow this workflow.

---

## PHASE 1 — Check Principal Tags

First, ask the user for their LDAP username. Then fetch their current tags:

```
GET https://principaltags.sandbox.example.invalid/principal_tags/<ldap>
```

The response looks like:

```json
{"user": "<ldap>", "tags": {"D0": "abc"}}
```

- Each character in the tag value represents a tag the user has been granted.
- If the response contains only the `user` field with no `tags` (or empty tags), the user has **no data access tags at all**.

---

## PHASE 2A — Dataset Access Issues

### Case 1: User has no tags (or is missing tags `b` and `c`)

The user needs **tags `b` and `c`** to access most datasets. Without these, they cannot query via IQL, Trino, or Snowflake.

**Instruct the user to:**

1. File a JSM request for software & system access: [Request Access](https://portico.atlassian.net/servicedesk/customer/portal/1/group/1041/create/1169)
2. When prompted to "Select software for which you are requesting access", select the **DataLake** icon.
3. Tickets are routed to the requestor's manager and automatically provisioned upon manager approval.

For detailed step-by-step instructions, refer the user to the wiki: [Data Lake Access Request Process](https://portico.atlassian.net/wiki/spaces/DataOrg/pages/216214948/Data+lake+Access+Request+Process)

**What tags `b` and `c` unlock:**

- Query access to most datasets via **IQL**, **Trino**, and **Snowflake**
- Automatic assignment of the **CRYSTAL_ANALYST** Snowflake role

### Case 2: User needs access to Logrepo datasets

Logrepo datasets require **tag `a`** in addition to tags `b` and `c`.

**Instruct the user to:**

Follow the same [Data Lake Access Request Process](https://portico.atlassian.net/wiki/spaces/DataOrg/pages/216214948/Data+lake+Access+Request+Process) wiki to request access to tag `a`.

### Case 3: User needs other specialized tags

The [Data Lake Access Request Process](https://portico.atlassian.net/wiki/spaces/DataOrg/pages/216214948/Data+lake+Access+Request+Process) wiki contains detailed instructions for all available tags and their purposes. Direct the user there for any tags beyond `a`, `b`, and `c`.

### Case 4: User already has the required tags but still cannot access

If the user has the expected tags but is still denied access:

1. Refer the user to the [Data Lake Access Request Process](https://portico.atlassian.net/wiki/spaces/DataOrg/pages/216214948/Data+lake+Access+Request+Process) wiki for troubleshooting guidance.
2. If the wiki does not resolve the issue, direct the user to ask in the **#help-data-access** Slack channel.

---

## PHASE 2B — Cortex Agent Access Issues

### Case 5: User cannot access a Crystal_Analyst Cortex agent

The **CRYSTAL_ANALYST** Snowflake role grants access to popular Cortex agents including:

- **REVXPERT** — revenue analytics
- **JAMXPERT** — job and marketplace analytics
- **WORKFORCE_ORGANIZATIONAL_EFFECTIVENESS_AGENT** — workforce and org analytics

The CRYSTAL_ANALYST role is **automatically assigned** when a user has principal tags `b` and `c`. If the user cannot access one of these agents, check their tags in Phase 1:

- **If tags `b` and `c` are missing:** follow **Case 1** above to request DataLake access via JSM. Once approved, the CRYSTAL_ANALYST role is granted automatically.
- **If tags `b` and `c` are present but access is still denied:** follow **Case 4** — refer to the wiki and then the **#help-data-access** Slack channel.

### Case 6: User needs access to a Cortex agent NOT covered by Crystal_Analyst

Some Cortex agents are gated by Snowflake roles other than CRYSTAL_ANALYST. To access these agents, the user must have the appropriate Snowflake role granted by the role owner.

**If you have access to a Confluence MCP tool** (e.g., `mcp__confluence__*` tools are available):

1. Create a subagent to fetch and read this wiki page: [How to Request Snowflake User Access Change](https://portico.atlassian.net/wiki/spaces/SF/pages/190975478/How+to+Request+Snowflake+User+Access+Change)
2. Extract the specific instructions and role owner contact information relevant to the user's requested role.
3. Provide the user with the exact steps and contact person from the wiki.

**If you do NOT have access to a Confluence MCP tool:**

Instruct the user to either:

1. **Enable the Confluence MCP server** so the agent can read the wiki directly and provide specific guidance, OR
2. **Open the wiki page themselves** to find the role owner and follow the instructions: [How to Request Snowflake User Access Change](https://portico.atlassian.net/wiki/spaces/SF/pages/190975478/How+to+Request+Snowflake+User+Access+Change)

The role owner listed on that page can grant the user the required Snowflake role for the agent.

---

## QUICK REFERENCE

### Dataset Access

| Tag | Grants Access To |
|-----|-----------------|
| `b` + `c` | Most datasets (IQL, Trino, Snowflake) + CRYSTAL_ANALYST Snowflake role |
| `a` | Logrepo datasets |
| Others | See [Data Lake Access Request Process](https://portico.atlassian.net/wiki/spaces/DataOrg/pages/216214948/Data+lake+Access+Request+Process) wiki |

| Action | How |
|--------|-----|
| Request any tag | [JSM Portal](https://portico.atlassian.net/servicedesk/customer/portal/1/group/1041/create/1169) → select **DataLake** |
| Detailed instructions | [Data Lake Access Request Process wiki](https://portico.atlassian.net/wiki/spaces/DataOrg/pages/216214948/Data+lake+Access+Request+Process) |
| Dataset-specific access issues | Check [wiki](https://portico.atlassian.net/wiki/spaces/DataOrg/pages/216214948/Data+lake+Access+Request+Process) first, then ask in **#help-data-access** Slack channel |

### Cortex Agent Access

| Agent Type | How to Get Access |
|------------|------------------|
| Crystal_Analyst agents (REVXPERT, JAMXPERT, WORKFORCE_ORGANIZATIONAL_EFFECTIVENESS_AGENT) | Request tags `b` + `c` via [JSM Portal](https://portico.atlassian.net/servicedesk/customer/portal/1/group/1041/create/1169) — role is auto-assigned |
| Other Cortex agents | Contact the Snowflake role owner via [How to Request Snowflake User Access Change](https://portico.atlassian.net/wiki/spaces/SF/pages/190975478/How+to+Request+Snowflake+User+Access+Change) wiki |
