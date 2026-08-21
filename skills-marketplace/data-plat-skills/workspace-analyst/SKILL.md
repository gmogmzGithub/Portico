# Workspace Analyst Skill

This skill teaches you how to fully "load" an idash workspace into your session context so that you can answer questions about its data intelligently — reusing existing queries, understanding the datasets involved, and executing or adapting queries as needed.

---

## When This Skill Is Invoked

The user will provide an idash workspace ID or URL (e.g., `https://data.example.invalid/idash/workspace/108713` or just `108713`). Your job is to:

1. **Load the workspace** — extract all queries, visualizations, dataset references, and metadata.
2. **Build a knowledge map** — understand what each query measures, what datasets it touches, and how they relate.
3. **Answer questions** — use the loaded context to answer questions, run queries, or build new analyses.

---

## Phase 1: Load the Workspace

### Step 1 — Check Permissions
Always check permissions before accessing any workspace content:
```
get_workspace_permissions(workspaceId=<id>)
```

If the result shows no `VIEW` or `EDIT` permission (and `defaultPermission` is not `VIEW`), stop and inform the user they don't have access.

### Step 2 — List Queries and Visualizations (in parallel)
```
list_workspace_queries(workspaceId=<id>)
list_workspace_visualizations(workspaceId=<id>)
```

From the queries, extract:
- **Query names** and **descriptions** (if present)
- **Query engine** (IQL2, Trino, Snowflake)
- **Full query text** — found inside the nested `contents` JSON string on each query object. Parse `contents` as JSON to access `name`, `engine`, and `text` fields.
- **All dataset/table references** — scan for:
  - IQL: bare table name after `From` keyword (e.g., `From crystal_chat_exchanges 7d 1d`)
  - Trino: fully qualified names like `datalake.imhotep.table_name` or `logrepo.log.table_name`
  - Snowflake: `DATABASE.SCHEMA.TABLE_NAME` patterns
  - CTEs and subqueries — recursively extract base table names, not CTE aliases
- **Section header queries** — queries whose `text` is `--` or blank are section dividers, skip them

From the visualizations, extract:
- **Visualization names** and **descriptions**
- Which `inputQueryId` each visualization references
- Whether it's `onDashboard: true`
- Chart type (MegaPlot, Table, Markdown)

### Step 3 — Fetch Dataset Metadata (in parallel, for all unique datasets)
For each unique base dataset found in Step 2:
```
search_data_assets(searchTerm="<dataset_name>")   # get the IRN
get_data_asset_details(dataAssetIrn="<irn>")       # description, owner, lifecycle
get_data_asset_fields(dataAssetIrn="<irn>")        # full schema with field names and types
```

Run all of these in parallel to minimize wait time. Use the `irn` from `search_data_assets` as input to the detail/field calls.

---

## Phase 2: Build a Knowledge Map

After loading, maintain a structured internal understanding of the workspace:

```
WORKSPACE KNOWLEDGE MAP
Workspace ID: <id>

QUERIES:
[Q0] "<Query Name>" (Engine: Trino/IQL2/Snowflake)
  Description: <if available>
  Datasets: <list of base tables>
  Measures: <what metrics this query computes>
  Filters: <key filters applied>
  Groupings: <GROUP BY dimensions>

[Q1] ...

VISUALIZATIONS:
[V0] "<Viz Name>" → references Q<n>
  Chart type: bar/line/table/etc
  On dashboard: yes/no
  Description: <if available>

DATASETS:
<dataset_name>
  IRN: <irn>
  Owner: <team>
  Description: <summary>
  Key fields: <important columns with types>
  Time range available: <firstOutputDate> → <lastOutputDate>
```

You don't need to print this map to the user — it's your internal working memory for answering questions.

---

## Phase 3: Answering Questions

Once the workspace is loaded, use the knowledge map to answer user questions. Follow this decision logic:

### If the user asks a question that a workspace query already answers:
1. Identify which query (Q0, Q1, etc.) is most relevant.
2. **Re-execute that query** using `run_query` to get fresh results (do not assume the data is current just because you've read the query text).
3. Use `run_python` to process results and present a clear answer.
4. Cite the query name so the user can refer back to it.

### If the user asks a question that requires adapting an existing query:
1. Take the closest existing query as a base.
2. Modify it (adjust filters, time range, grouping, metric) to answer the specific question.
3. Execute the adapted query with `run_query`.
4. Explain what you changed from the original query.

### If the user asks a question that isn't covered by any existing query:
1. Identify which dataset(s) from the workspace knowledge map are most relevant.
2. Write a new query from scratch using the field schema you've already loaded.
3. Choose the appropriate engine (IQL for aggregations, Trino for row-level or joins).
4. Execute and return results.

### If the user asks about what the workspace covers or how it's structured:
Summarize from the knowledge map:
- What datasets are tracked
- What the key queries measure
- What visualizations are available and what they show
- The time range of available data

---

## Handling Workspace URLs

If the user provides a full URL like `https://data.example.invalid/idash/workspace/108713`, extract the numeric ID (`108713`) and proceed normally.

---

## Key Behaviors

- **Always re-execute queries** to get fresh data — never present query text as if it were results.
- **Respect dataset ownership and lifecycle** — if `get_data_asset_details` shows a dataset is deprecated or has notices, inform the user.
- **Use parallel tool calls** wherever possible (loading multiple dataset schemas, running multiple queries) to minimize latency.
- **Be explicit about what you know** — if a query description is missing, infer its purpose from the query logic and note the inference.
- **Preserve query intent** — when adapting queries, stay as close to the original logic as possible unless the user explicitly asks you to change the approach.
- **Never fabricate field names** — always use the schema from `get_data_asset_fields`. If you're unsure about a field, check the schema before writing a query.
- **Surface visualization context** — if a visualization exists for a query, mention it when presenting results so the user knows they can view it in idash.
- **Do not query for PII** — even if fields like email, phone, or address exist in the schema, never select or display them.
- **Parse query contents correctly** — each query object returned by `list_workspace_queries` has a `contents` field that is a JSON-encoded string. Always parse it with `json.loads()` before accessing `name`, `engine`, or `text`.

---

## Example Invocation

**User:** `/workspace-analyst 108713 — what are my daily active users over the past 30 days?`

**Your workflow:**
1. `get_workspace_permissions(108713)` ✓
2. `list_workspace_queries(108713)` + `list_workspace_visualizations(108713)` in parallel
3. Parse `contents` JSON on each query → identify Q3 "DAUs, MAUs, WAUs" as most relevant
4. Note it references `crystal_chat_exchanges`; schema already loaded
5. Re-execute Q3 with `run_query`
6. Return a clean table/chart of DAU with a note referencing the source query and visualization

---

## Notes on idash Engine Names

When re-executing or creating workspace queries via `create_workspace_query`, use the correct engine name:
- IQL queries → `engine: "IQL2"`
- Trino queries → `engine: "Trino"`
- Snowflake queries → `engine: "Snowflake"`

When executing via `run_query`, map accordingly:
- IQL2 → `query_type: "IQL"`
- Trino → `query_type: "TRINO"`
- Snowflake → `query_type: "SNOWFLAKE"`
