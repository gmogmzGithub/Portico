# Trino Query-Writing Skill

Reference for writing Trino queries against Portico's Datalake.

## Table Naming Convention

All Datalake tables follow the format:

```
datalake.<schema>.<table>
```

Example: `datalake.imhotep.jobsearch`

## Partition Filtering (MANDATORY)

Queries on `datalake.imhotep.*` and `datalake.imhotep_qa.*` schemas **MUST** include a time filter. Either:

- Filter on the `unixtime` column using `imhotep_unixtime()` or direct comparison, OR
- Filter on the partition column (`day`, `hour`, `minute`, `month`, or `year`)


Queries without a time filter are **automatically rejected** by the Trino connector with:
> "Query on table X does not filter on unixtime or partition column."

### Always use BETWEEN for unixtime filtering

**The standard pattern** for filtering `datalake.imhotep.*` tables is `BETWEEN` with `imhotep_unixtime()` on both sides. Always prefer this over `>=` / `<` pairs:

```sql
-- CORRECT: BETWEEN gives a bounded range — always use this pattern
WHERE unixtime BETWEEN imhotep_unixtime('7d') AND imhotep_unixtime('today')

-- CORRECT: explicit date bounds
WHERE unixtime BETWEEN imhotep_unixtime('2025-03-01') AND imhotep_unixtime('2025-03-31')

-- WRONG: open-ended range — may be slow or rejected on large tables
WHERE unixtime >= imhotep_unixtime('7d')
```

Every query on `datalake.imhotep.*` should have a `unixtime BETWEEN ... AND ...` clause. When the user wants "the last N days", use `BETWEEN imhotep_unixtime('<N>d') AND imhotep_unixtime('today')`. When they want up to right now, use `imhotep_unixtime('tomorrow')` as the upper bound.

## Timezone Convention

All Portico Trino time operations use **CST-6 (UTC-6)**. This applies to `imhotep_unixtime()`, partition boundaries, and `uid_parse()`. Be aware of this when interpreting timestamps.

## Pre-Query Workflow: Dataset Exploration

Before writing a Trino query, use the data-plat MCP tools to understand the dataset:

1. **Find the Datalake table:** `search_data_assets(searchTerm="<term>", system="glue")` — each result includes an `irn` (Portico Resource Name, e.g., `irn:v1:datalake:default/imhotep/jobsearch`) and `fullyQualifiedName`
2. **Get schema/fields:** `get_data_asset_fields(dataAssetIrn="<irn>")` — use this to pick correct column names and data types
3. **Get query history:** `get_data_asset_query_history(dataAssetIrn="<irn>")` — shows how others query this table, common patterns, and time range conventions
4. **Get metadata (optional):** `get_data_asset_details(dataAssetIrn="<irn>")` — ownership, description, lifecycle info

Use the `irn` from step 1 as the `dataAssetIrn` parameter in steps 2–4. Query history is especially valuable for learning partition column names, common filter patterns, and UDF usage on a specific table.

## Portico Custom UDF Reference

### imhotep_unixtime

Converts timestamps or date strings to Imhotep unixtime (seconds, CST-6).

| Signature | Description |
|-----------|-------------|
| `imhotep_unixtime(TIMESTAMP(3)) → BIGINT` | Convert timestamp to Imhotep unixtime |
| `imhotep_unixtime(TIMESTAMP(3) WITH TIME ZONE) → BIGINT` | Convert zoned timestamp to Imhotep unixtime |
| `imhotep_unixtime(VARCHAR) → BIGINT` | Parse date string to Imhotep unixtime. Accepts: `'yyyy-MM-dd'`, `'yyyy-MM-dd HH:mm:ss'`, and **relative dates** (see below) |

**Relative date syntax:** A positive number means **in the past**. Use `'tomorrow'` for future dates.

| Expression | Meaning |
|-----------|---------|
| `'7d'` | 7 days **ago** |
| `'30d'` | 30 days **ago** |
| `'2w'` | 2 weeks ago |
| `'1M'` | 1 month ago |
| `'1y'` | 1 year ago |
| `'1q'` | 1 quarter ago |
| `'3h'` | 3 hours ago |
| `'today'` | Start of today |
| `'yesterday'` | Start of yesterday |
| `'tomorrow'` | Start of tomorrow |

**Do NOT use negative signs** (e.g., `'-7d'`). Use `'7d'` for 7 days ago.

### jobkey_to_jobid / jobid_to_jobkey

| Signature | Description |
|-----------|-------------|
| `jobkey_to_jobid(VARCHAR) → BIGINT` | Convert job key string to numeric job ID |
| `jobid_to_jobkey(BIGINT) → VARCHAR` | Convert numeric job ID to job key string |

### useragent_parse

```sql
useragent_parse(VARCHAR) → ROW(
  tokens          array(varchar),
  urlDecoded      varchar,
  browserName     varchar,
  browserFamily   varchar,
  releaseVersion  varchar,
  osFamily        varchar,
  osReleaseVersion varchar,
  phone           boolean,
  tablet          boolean,
  iPad            boolean,
  android         boolean,
  ios             boolean,
  windowsPhone    boolean,
  mobileDevice    boolean,
  smartPhone      boolean,
  dumbPhone       boolean,
  chrome          boolean,
  chromeForIOS    boolean,
  safari          boolean,
  safariForIOS    boolean,
  jobSearchApp    boolean,
  employerApp     boolean,
  androidJobSearchApp boolean,
  androidEmployerApp  boolean,
  iPadJobSearchApp    boolean,
  iOSJobSearchApp     boolean,
  iOSEmployerApp      boolean,
  bot             boolean,
  googleWebLight  boolean,
  fileUploadCapable   boolean,
  geolocationCapable  boolean
)
```

Parse user-agent string into 31 typed fields covering browser, OS, device type, and Portico app detection.

### uid_parse

```sql
uid_parse(VARCHAR) → ROW(
  allbit    varchar,   -- always "1"
  yyyymmdd  integer,   -- date in YYYYMMDD format
  hhmm      varchar,   -- time in HHMM format
  unixtime  integer,   -- unix time (seconds, CST-6)
  timestamp bigint,    -- timestamp (milliseconds)
  svr       integer,   -- server ID
  ssvr      integer,   -- sub-server ID
  gpid      integer    -- global process ID
)
```

Parse Portico UID into components. Times are in CST-6.

### email_hash

| Signature | Description |
|-----------|-------------|
| `email_hash(VARCHAR) → BIGINT` | Hash an email address (lowercased) to BIGINT |

## ROW Type Access Syntax (CRITICAL)

When accessing fields from UDFs that return ROW types, you **MUST** wrap the function call in parentheses:

```sql
-- CORRECT: parentheses around function call
SELECT (useragent_parse(user_agent)).browserFamily FROM ...
SELECT (uid_parse(uid)).yyyymmdd FROM ...

-- WRONG: missing parentheses → syntax error
SELECT useragent_parse(user_agent).browserFamily FROM ...
```

## Example Queries

### Last 7 days of job searches, filtered by mobile

```sql
SELECT day, COUNT(*) AS searches
FROM datalake.imhotep.jobsearch
WHERE unixtime BETWEEN imhotep_unixtime('7d') AND imhotep_unixtime('today')
  AND (useragent_parse(useragent)).mobileDevice = true
GROUP BY day
ORDER BY day
```

### Parse UIDs to find user creation dates

```sql
WITH parsed AS (
  SELECT uid, (uid_parse(uid)).yyyymmdd AS created_date
  FROM datalake.imhotep.mydata
  WHERE unixtime BETWEEN imhotep_unixtime('30d') AND imhotep_unixtime('today')
)
SELECT created_date, COUNT(*) FROM parsed GROUP BY created_date
```

### Convert job keys to IDs

```sql
SELECT jobkey, jobkey_to_jobid(jobkey) AS job_id
FROM datalake.imhotep.jobsearch
WHERE unixtime BETWEEN imhotep_unixtime('yesterday') AND imhotep_unixtime('today')
LIMIT 100
```

## Arithmetic & Type Casting

### The `1.0` trap

In Trino, the literal `1.0` is `DECIMAL(2,1)` — **not** `DOUBLE`. Multiplying by `1.0` keeps the result in decimal arithmetic, which can still truncate to zero.

### Integer division truncation

`BIGINT / BIGINT` performs integer division and truncates toward zero. This means expressions like `SUM(x) / COUNT(*)` silently return `0` whenever the true result is between -1 and 1.

### The correct pattern

Cast at least the numerator to `DOUBLE` to get floating-point division:

```sql
-- WRONG: 1.0 is DECIMAL, not DOUBLE — result can still be 0
SELECT 1.0 * SUM(converted) / COUNT(*) AS rate
FROM datalake.imhotep.events
WHERE unixtime BETWEEN imhotep_unixtime('7d') AND imhotep_unixtime('today')

-- CORRECT: CAST to DOUBLE guarantees floating-point division
SELECT CAST(SUM(converted) AS DOUBLE) / COUNT(*) AS rate
FROM datalake.imhotep.events
WHERE unixtime BETWEEN imhotep_unixtime('7d') AND imhotep_unixtime('today')
```

## Anti-Patterns to Avoid

- **No time filter on imhotep tables** — query is automatically rejected
- **Open-ended unixtime range** (e.g., `unixtime >= X` without upper bound) — may be rejected or extremely slow. Always use `BETWEEN` with both a lower and upper bound
- **Calling ROW UDFs redundantly** in SELECT, WHERE, and GROUP BY — use a CTE or subquery to call the UDF once
- **Missing parentheses on ROW field access** — causes a syntax error
- **Using `1.0 * x / y` to force floating-point division** — `1.0` is `DECIMAL`, not `DOUBLE`; result can still truncate to zero. Use `CAST(numerator AS DOUBLE) / denominator` instead
