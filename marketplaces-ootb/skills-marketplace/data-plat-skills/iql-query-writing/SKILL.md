# IQL Query-Writing Skill

Reference for writing IQL queries against Portico's Datalake.

## Pre-Query Workflow: Dataset Exploration

Before writing a IQL query, use the data-plat MCP tools to understand the dataset:

1. **Find the Datalake table:** `search_data_assets(searchTerm="<term>", system="imhotep")` — each result includes an `irn` (Portico Resource Name, e.g., `irn:v1:imhotep:default/prod/jobsearch`)
2. **Get schema/fields:** `get_data_asset_fields(dataAssetIrn="<irn>")` — use this to pick correct column names and data types
3. **Get query history:** `get_data_asset_query_history(dataAssetIrn="<irn>")` — shows how others query this table, common patterns, and time range conventions
4. **Get metadata (optional):** `get_data_asset_details(dataAssetIrn="<irn>")` — ownership, description, lifecycle info

Use the `irn` from step 1 as the `dataAssetIrn` parameter in steps 2–4. Query history is especially valuable for learning partition column names, common filter patterns.


## 1. How IQL Works

IQL processes data through a pipeline. Understanding this pipeline is essential to writing correct queries.

**The pipeline:**

```
FROM (load docs in time range)
  → WHERE (filter individual docs)
    → GROUP BY (partition remaining docs into groups)
      → SELECT (compute aggregate metrics per group)
```

**Walk-through with a concrete example:**

```
FROM jobsearch 2024-01-01 2024-01-08
WHERE country = 'US' AND platform != 'bot'
GROUP BY job_type[TOP 10]
SELECT COUNT(), AVG(clicks), [revenue]
```

| Stage    | What happens                                                                                  |
|----------|-----------------------------------------------------------------------------------------------|
| FROM     | Load all documents from the `jobsearch` dataset between Jan 1 and Jan 8. The time range is **mandatory** and always goes in the FROM clause — never in WHERE. The start date is **inclusive** and the end date is **exclusive**. |
| WHERE    | For each document, check: is `country` equal to `'US'`? Is `platform` not `'bot'`? Discard documents that fail. These are **doc-level** filters — they see one document at a time. |
| GROUP BY | Partition the surviving documents by their `job_type` field value, keeping only the top 10 groups (ranked by the default metric). |
| SELECT   | For **each group**, compute: `COUNT()` = number of documents; `AVG(clicks)` = mean of the `clicks` field across documents; `[revenue]` = sum of the `revenue` field across documents. These are **aggregate** computations — they operate on the entire group. |

**Key insight:** Everything in WHERE runs per-document. Everything in SELECT runs per-group. GROUP BY is the boundary between the two worlds.

If you omit GROUP BY, all surviving documents form a single group, and SELECT computes one row of output.

**Practical tip:** Always test your query on a small time range first (e.g., `1h today`) before scaling up to larger ranges. IQL is a shared resource and expensive queries affect all users.

---

## 2. The Two-Tier Metric System

This is the most important concept in IQL. There are two kinds of expressions, and they follow different rules.

### Doc Metrics (per-document expressions)

A doc metric is evaluated independently for each document. It produces a number for that document.

| Expression            | Meaning                                           |
|-----------------------|---------------------------------------------------|
| `fieldname`           | The numeric value of that field in this document   |
| `123`                 | The constant 123 for every document                |
| `COUNT()`             | Always 1 (the "weight" of this document)           |
| `field = 'value'`     | 1 if the field equals `'value'`, else 0            |
| `clicks * 100`        | Arithmetic on field values                         |
| `IF country='US' THEN revenue ELSE 0` | Conditional per-document value      |

Doc metrics appear in: WHERE conditions, inside aggregate functions like `AVG(...)`, and inside `[...]` brackets in SELECT.

### Aggregate Metrics (per-group expressions)

An aggregate metric is computed over all documents in a group. It produces a single number for the group.

| Expression            | Meaning                                           |
|-----------------------|---------------------------------------------------|
| `COUNT()`             | Number of documents in the group                   |
| `fieldname`           | **SUM** of that field across all docs in the group |
| `[docMetric]`         | **SUM** of the doc metric across all docs in the group |
| `AVG(docMetric)`      | Mean of the doc metric across docs                 |
| `DISTINCT(field)`     | Count of distinct values of field in the group     |
| `PERCENTILE(field, 95)` | 95th percentile of field values                 |

Aggregate metrics appear in: SELECT, HAVING, and TOP/BOTTOM BY expressions.

### The Implicit SUM Rule

**This is the #1 source of mistakes.** When a bare field name or doc metric appears in an aggregate context (SELECT), it becomes the **SUM** of that value across the group — not the raw value.

```
-- In this query:
FROM data 1d today GROUP BY category SELECT revenue

-- `revenue` in SELECT = SUM(revenue) for each category group
-- NOT the revenue of a single document
```

To be explicit about the sum, use bracket notation: `[revenue]` — this is identical to bare `revenue` in SELECT but makes the intent clearer.

### How Aggregate Functions Consume Doc Metrics

Aggregate functions like `AVG()`, `VARIANCE()`, and `STDEV()` take **doc metrics** as input. The doc metric is evaluated per-document, then the aggregate function reduces those per-document values into a single group-level result.

```
-- AVG(clicks) means:
--   1. For each doc in the group, get its `clicks` value (doc metric)
--   2. Compute the average of all those values (aggregate reduction)

-- AVG(clicks * revenue) means:
--   1. For each doc, compute clicks * revenue (doc metric: arithmetic)
--   2. Average the results (aggregate reduction)
```

---

## 3. Key Differences from SQL

If you know SQL, these differences will trip you up. Read carefully.

| SQL                                    | IQL                                      | Why it matters                           |
|----------------------------------------|------------------------------------------|------------------------------------------|
| `SELECT SUM(revenue)`                  | `SELECT revenue` or `SELECT [revenue]`   | There is **no `SUM()` function**. A bare field in SELECT is already an implicit SUM. |
| `WHERE date BETWEEN ...`               | `FROM dataset 2024-01-01 2024-01-31`     | Time range goes in FROM, never in WHERE. |
| `WHERE name LIKE '%foo%'`              | `WHERE name =~ 'foo'`                    | Use `=~` for regex matching, not `LIKE`. |
| `SELECT field` returns raw values      | `SELECT field` returns SUM(field)        | In IQL, SELECT always aggregates. There is no way to return raw per-document values. |
| Keywords are case-insensitive          | Keywords are also case-insensitive       | `SELECT`, `select`, `Select` all work. UPPERCASE is conventional for readability but not required. |
| `HAVING` filters on aggregate values   | Same — but syntax differs                | IQL HAVING uses aggregate filter syntax (see Section 4). |
| `COUNT(*)` counts rows                 | `COUNT()` counts documents               | No `*` inside COUNT. |

**Additional IQL-specific syntax:**
- `[docMetric]` bracket notation explicitly sums a doc metric in aggregate context
- `COUNT()` in a doc metric context = 1 (per-doc weight); in aggregate context = document count
- `field = 'value'` in SELECT returns SUM of (1 for each doc where field='value') — i.e., a count of matches
- `M(filter)` converts a boolean filter into a metric (1 if true, 0 if false)

---

## 4. Syntax Reference

### Query Structure

```
[QUALIFIER qualifier]
[TIMEZONE timezone]
[SELECT selectContents]
FROM fromContents
[WHERE whereContents]
[GROUP BY groupByContents]
[SELECT selectContents]
[OPTIONS '[' options ']']
[TIMEZONE timezone]
[LIMIT limit]
[OPTIONS '[' options ']']
```

Note: SELECT can appear before FROM and/or after GROUP BY. TIMEZONE and OPTIONS can appear in multiple positions.

### Time and Date Formats

#### Time Intervals
- Single unit: `1d`, `2w`, `3M`, `1y`
- Combined units: `1w2d`, `1d12h`, `1h30m` (no spaces between units)
- Time units:
  - `s` or `second(s)` — seconds
  - `m` or `minute(s)` — minutes (NOT `M` which is months)
  - `h` or `hour(s)` — hours
  - `d` or `day(s)` — days
  - `w` or `week(s)` — weeks
  - `M` or `mo` or `month(s)` — months
  - `y` or `year(s)` — years
  - `q` or `quarter(s)` — quarters

#### Relative Time
- `today` (or `t`, `to`, `tod`, `toda`)
- `yesterday` (or `y`, `ye`, `yes`, `yest`, etc.)
- `tomorrow` (or `tom`, `tomo`, `tomor`, etc.)
- Days of week: `sunday`/`sun`, `monday`/`mon`, etc.
- Relative past: `1d`, `2w` (means 1 day ago, 2 weeks ago)

#### Date/DateTime Formats
- Unix timestamp: `1234567890`
- Date: `2024-01-15`
- DateTime: `2024-01-15 14:30:00` or `2024-01-15T14:30:00`
- Full datetime with timezone: `2024-01-15 14:30:00.123+05:00`

### FROM Clause

```
dataset: index [( whereContents )] startTime endTime [AS name] [aliases]
```

The time range is **start-inclusive, end-exclusive**. The first dataset requires a time range. Additional datasets (comma-separated) inherit the time range if omitted.

Datasets can be referenced by short name or fully qualified: `catalog.namespace.dataset` (e.g., `datalake.imhotep.jobsearch`). Alternatively, use the `QUALIFIER` clause to set the namespace for short names.

Examples:
```
FROM myindex 1d today
FROM myindex "2024-01-01" "2024-01-31"
FROM index1 1w today, index2 2w 1w
FROM myindex(WHERE field = 'value') yesterday today AS ds1
FROM organic 1d 0d AS o1, organic AS o2   -- o2 inherits time range from o1

/* Fully qualified dataset name */
FROM datalake.imhotep.jobsearch 7d today
```

#### Aliases
```
ALIASING (field1 AS alias1, field2 AS alias2, ...)
```

### WHERE Clause (Document Filters)

All WHERE expressions are evaluated per-document and return true/false.

**Important:** String values are **case-sensitive**. Using the wrong case returns zero results with no error. Case conventions vary by dataset (e.g., some use `country='us'`, others `country='US'`).

**Performance:** Prefer `field IN ('a', 'b')` over `field =~ 'a|b'` — regex is significantly more expensive, especially on high-cardinality fields or long time ranges. Combine multiple regex on the same field into one: `field =~ '(pattern1|pattern2)'` instead of separate filters.

#### Basic Comparisons
- `field = 'stringvalue'` or `field = 123` — equality
- `field != 'stringvalue'` or `field != 123` — not equal
- `field =~ 'regex'` — regex match
- `field !=~ 'regex'` — regex not match
- `field1 = field2` — field equality
- `field1 != field2` — field not equal

#### IN Operator
- `field IN ('val1', 'val2', 'val3')`
- `field NOT IN (1, 2, 3)`
- `field IN (FROM dataset ... GROUP BY field2)` — subquery
- `field IN (FROM SAME GROUP BY field2)` — subquery referencing same dataset

#### Numeric Comparisons
- `metric1 < metric2`, `metric1 <= metric2`
- `metric1 > metric2`, `metric1 >= metric2`
- `metric1 = metric2`, `metric1 != metric2`

#### Special Functions
- `HASSTR(field, 'value')` — equivalent to `field = 'value'`
- `HASINT(field, 123)` — equivalent to `field = 123`
- `HASSTRFIELD(field)` — check if string field exists (returns 0 or 1)
- `HASINTFIELD(field)` — check if int field exists (returns 0 or 1)

**Important:** `HASSTR`, `HASINT`, `HASSTRFIELD`, and `HASINTFIELD` are **doc metrics that return 0 or 1**, not boolean filters. Always use them with an explicit `= 1` comparison in WHERE:
```
WHERE HASSTRFIELD(field) = 1
WHERE HASINTFIELD(field) = 1
WHERE HASSTR(field, 'value') = 1
WHERE HASINT(field, 123) = 1
```
- `LUCENE('lucene query')` or `QUERY('lucene query')`
- `BETWEEN(metric, lowerBound, upperBound)`
- `SAMPLE(field, numerator [, denominator [, seed]])`
- `STANDARD_FILTERS(filter1, filter2, ...)`
- `VERSION(field [, 'regex']) < VERSION('1.2.3')`

#### Logical Operators
- `filter1 AND filter2` or `filter1 && filter2`
- `filter1 OR filter2` or `filter1 || filter2`
- `!filter` or `NOT(filter)` or `-filter`
- Parentheses for grouping: `(filter1 OR filter2) AND filter3`

#### Constants
- `TRUE`
- `FALSE`

### GROUP BY Clause

#### Field Grouping
- `field` — all values
- `field[TOP n]` — top n values
- `field[BOTTOM n]` — bottom n values
- `field[TOP n BY metric]` — top n by aggregate metric. **Restriction:** the metric must be computable incrementally during regrouping — use `COUNT()`, bare field names (implicit sums), or arithmetic on these. Do NOT use `DISTINCT()`, `PERCENTILE()`, `FIELD_MIN()`, `FIELD_MAX()`, or `SUM_OVER()` here — they require a separate computation pass and will error.
- `field[TOP n BY metric HAVING filter]` — with aggregate filter
- `field WITH DEFAULT` — include a default group for unmatched
- `field WITH NONEMPTY DEFAULT groupname` — non-empty default with name
- `LOWER_CASE(field)` or `UPPER_CASE(field)` — case transform before grouping

#### Time Grouping
- `TIME()` or `TIMEBUCKETS()` — auto buckets
- `TIME(1d)` — specific bucket size
- `TIME(1d RELATIVE)` — relative time buckets
- `TIME(1d RELATIVE ALLOW PARTIAL)` — allow partial buckets (use when your date range doesn't divide evenly by the bucket size, e.g., 365 days with 4-week buckets)
- `TIME(1d, 'format')` — with format string
- `TIME(1d, DEFAULT, metricField, startTime, endTime)` — full specification
- `DAYOFWEEK()` — day of week

#### Bucket Grouping
- `BUCKET(metric, min, max, interval)` or `BUCKETS(...)`
- `BUCKET(metric, min, max, interval, guttername)` — with gutter

#### Statistical Grouping
- `QUANTILES(field, n)` — n quantiles
- `AGGREGATE_BUCKET(field [HAVING filter], metric, min, max, interval [, gutter])`
- `AGGREGATE_QUANTILES(field [HAVING filter], metric, n)`

#### IN Grouping
- `field IN ('A', 'B', 'C')` — group by specified values only
- `field NOT IN ('X', 'Y')` — exclude specific values
- `field IN (FROM ... GROUP BY otherfield)` — subquery
- Can use WITH DEFAULT: `field IN ('A', 'B') WITH DEFAULT 'Other'`

#### Special Grouping
- `DATASET()` — group by dataset (useful with multi-dataset FROM)
- `docFilter` — group by boolean filter result (true/false groups)
- `RANDOM(field, k [, salt])` — random k buckets
- `MULTI(field)` — multi-value field (document counted in multiple groups)
- `TOPTERMS(field [, limit [, metric [, order]]])` — top terms
  - order: `TOP`, `BOTTOM`, `ASCENDING`/`ASC`, `DESCENDING`/`DESC`

#### Group Entry Format
Each GROUP BY entry can have:
```
groupByElement [HAVING aggregateFilter] [AS alias]
```

**Best practices:**
- Order groupings from smallest to largest cardinality: `country, device, query` — not `query, device, country`. The last (largest) grouping can be streamed instead of stored in memory.
- Before running a GROUP BY on an unfamiliar field, check its cardinality first: `SELECT DISTINCT(field)` returns the number of unique values (= number of groups you'd get).

### SELECT Clause (Metrics)

#### Document Metrics (per-document — used inside aggregate functions and brackets)

**Basic:**
- `fieldname` — field value
- `123` — constant
- `COUNT()` — always 1 (per-doc weight)
- `DOCID()` — document ID

**Field Operations:**
- `field = 'value'` — returns 1 or 0
- `field = 123` — returns 1 or 0
- `HASSTR(field, 'value')` — returns 1 or 0
- `HASINT(field, 123)` — returns 1 or 0
- `HASSTRFIELD(field)` — returns 1 if string field exists, else 0
- `HASINTFIELD(field)` — returns 1 if int field exists, else 0
- `field != 'value'` — returns 1 or 0
- `field =~ 'regex'` — returns 1 or 0
- `LEN(field)` — string length
- `INTTERMCOUNT(field)` — count of int terms
- `STRTERMCOUNT(field)` — count of string terms
- `FLOATSCALE(field [, mult [, add]])`
- `EXTRACT(field, 'regex' [, groupNum])`
- `UID_TO_UNIXTIME(field)`

**Math Functions:**
- `ABS(metric)`, `SIGNUM(metric)`
- `LOG(metric [, scale])`, `EXP(metric [, scale])`
- `MIN(metric1, metric2, ...)`, `MAX(metric1, metric2, ...)`

**Operators:**
- `-metric` (negation)
- `metric1 + metric2`, `metric1 - metric2`
- `metric1 * metric2`, `metric1 / metric2`, `metric1 % metric2`

**Comparisons (return 1 or 0):**
- `metric1 = metric2`, `metric1 != metric2`
- `metric1 < metric2`, `metric1 <= metric2`
- `metric1 > metric2`, `metric1 >= metric2`

**Special:**
- `RANDOM(field, max [, seed])`, `RANDOM(metric, max [, seed])`
- `LUCENE('query')` or `QUERY('query')`
- `IF filter THEN metric1 ELSE metric2`
- `M(filter)` — converts boolean filter to 1 or 0
- `DATETIME_TO_UNIXTIME(dateTime)`
- `TIME_INTERVAL_TO_SECOND(timeInterval)`

#### Aggregate Metrics (per-group — used in SELECT, HAVING, TOP BY)

**Basic:**
- `COUNT()` — count of documents in group
- `fieldname` — implicit SUM of field values
- `[docMetric]` — explicit SUM of doc metric
- `123` — constant

**Statistical:**
- `AVG(docMetric)` — mean
- `VARIANCE(docMetric)` — variance
- `STDEV(docMetric)` — standard deviation
- `PERCENTILE(field, percentile)` or `PERCENTILE(docMetric, percentile)`
- `MEDIAN(field)` or `MEDIAN(docMetric)` — same as PERCENTILE(..., 50)
- `DISTINCT(field [HAVING filter])` — count of distinct values

**Window Functions:**
- `LAG(n, metric [, default])` — value from n groups ago
- `RUNNING(metric)` or `RUNNING_SUM(metric)` — cumulative sum
- `PARENT(metric)` — parent group's value
- `WINDOW(n, metric)` or `WINDOW_SUM(n, metric)` — sliding window sum
- `DISTINCT_WINDOW(n, field [HAVING filter])` — distinct count in window
- `RUNNING_DISTINCT(field [HAVING filter])` — running distinct count

**Cross-Group Operations:**
- `SUM_OVER(groupByElement, metric)` — sum across all groups
- `SUM_OVER(field [HAVING filter], metric)`
- `AVG_OVER(field [HAVING filter], metric)`
- `PERCENTILE_OVER(field [HAVING filter], metric, percentile)`
- `MEDIAN_OVER(field [HAVING filter], metric)`
- `MIN_OVER(field [HAVING filter], metric)`
- `MAX_OVER(field [HAVING filter], metric)`

**Field Extremes:**
- `FIELD_MIN(field [BY metric] [HAVING filter])` — field value with minimum metric
- `FIELD_MAX(field [BY metric] [HAVING filter])` — field value with maximum metric

**Math Functions:**
- `ABS(metric)`, `LOG(metric)`
- `FLOOR(metric [, digits])`, `CEIL(metric [, digits])`, `ROUND(metric [, digits])`
- `MIN(metric1, metric2, ...)`, `MAX(metric1, metric2, ...)`

**Operators:**
- `-metric` (negation)
- `metric1 ^ metric2` (power)
- `metric1 * metric2`, `metric1 / metric2`, `metric1 % metric2`
- `metric1 + metric2`, `metric1 - metric2`

**Comparisons:**
- `PDIFF(expected, actual)` — percentage difference
- `DIFF(control, test)` — absolute difference
- `RATIODIFF(controlClc, controlImp, testClc, testImp)`

**Scoring Functions:**
- `SINGLESCORE(control, test)`
- `RATIOSCORE(controlClc, controlImp, testClc, testImp)`
- `RMSERROR(predicted, actual, total, grouping, lower, upper, step [, useRatio])`
- `LOGLOSS(labelFilter, scoreMetric, scale)`
- `NORM_ENTROPY(labelFilter, scoreMetric, scale)`
- `AUC(field, docFilter)`

**Special:**
- `COUNT_IF(whereContents)` — count documents matching a filter
- `RATE_OF(whereContents)` — fraction of documents matching
- `IF filter THEN metric1 ELSE metric2` — conditional aggregate
- `M(filter)` — filter as metric (1 if true aggregate filter, 0 if false)
- `metric AS name` — aliasing

**Scoping (multi-dataset queries):**
- `scope.metric` — single dataset scope (e.g., `o1.COUNT()`)
- `[dataset1, dataset2].metric` — multiple dataset scope

#### Formatting
- `PRINTF('format', metric)` — formatted output
- `ROUNDING n` — round to n decimal places (at end of SELECT, applies to all metrics)

### Aggregate Filters (HAVING)

Used in GROUP BY HAVING and inside aggregate functions that accept HAVING.

- `TERM() = value` — group term equals value
- `TERM() =~ 'regex'` — group term matches regex
- `metric1 = metric2`, `metric1 != metric2`
- `metric1 < metric2`, `metric1 <= metric2`
- `metric1 > metric2`, `metric1 >= metric2`
- `ISNAN(metric)`
- `!filter` or `NOT(filter)`
- `filter1 AND filter2` or `filter1 && filter2`
- `filter1 OR filter2` or `filter1 || filter2`
- `ALL_DOCS(docFilter)` — all docs in group match the doc-level filter
- `ANY_DOC(docFilter)` — at least one doc in group matches
- `TRUE`, `FALSE`
- `field =~ 'regex'` (deprecated — prefer `TERM() =~ 'regex'`)

### Other Clauses

#### QUALIFIER
- `QUALIFIER catalog.namespace` — sets the namespace for dataset names in the query
- Alternative to fully qualified dataset names in FROM (e.g., `QUALIFIER datalake.cloudcost` then `FROM aws_costandusage ...`)

#### TIMEZONE
- Default timezone is **UTC-6** if not specified
- `TIMEZONE UTC`, `TIMEZONE GMT`
- `TIMEZONE UTC+5:30`, `TIMEZONE GMT-8`

#### OPTIONS
- `OPTIONS ['option1', 'option2', ...]`

#### LIMIT
- `LIMIT 100` — limit number of result rows

---

## 5. Examples

### Basic Queries

```
-- Count documents in a dataset over the last day
FROM myindex yesterday today
SELECT COUNT()

-- Multiple metrics without GROUP BY = single row of totals
FROM myindex 1w today
WHERE status = 'active'
SELECT COUNT(), [revenue], AVG(response_time)
-- COUNT()  = total docs
-- revenue  = SUM of revenue (implicit SUM rule)
-- AVG(...) = mean response_time per doc
```

### Grouping and Aggregation

```
-- Top 10 categories by document count
FROM myindex yesterday today
GROUP BY category[TOP 10]
SELECT COUNT()

-- Group by time buckets (hourly)
FROM logs 1w today
WHERE error != 1
GROUP BY TIME(1h)
SELECT COUNT(), AVG(response_time)

-- Top 10 products by revenue, also broken down by region
FROM sales "2024-01-01" "2024-01-31"
WHERE region IN ('US', 'EU', 'ASIA')
GROUP BY product[TOP 10 BY [revenue]], region
SELECT COUNT() AS orders, [revenue] AS total_revenue,
       PERCENTILE(revenue, 95) AS p95_revenue,
       FIELD_MAX(customer_id BY [revenue]) AS top_customer
```

### Window Functions and Running Totals

```
-- Rolling 7-day window and cumulative count
FROM events 30d today
GROUP BY TIME(1d)
SELECT COUNT(),
       WINDOW(7, COUNT()) AS rolling_7d,
       RUNNING(COUNT()) AS cumulative
```

### Cross-Group Analysis (Percentage of Total)

```
-- Each category's percentage of total
FROM dataset 1M today
GROUP BY category, country
SELECT COUNT(),
       SUM_OVER(category, COUNT()) AS category_total,
       100.0 * COUNT() / SUM_OVER(category, COUNT()) AS pct_of_category
```

### Multi-Dataset Comparison

```
-- Compare two time periods side by side
FROM organic 2w 1w AS last_week, organic 1w today AS this_week
GROUP BY DATASET()
SELECT COUNT(), [clicks], [revenue]

-- Compare with scoped metrics
FROM organic 1d 0d AS o1, organic AS o2
GROUP BY oji
SELECT COUNT() AS total_count, o1.COUNT(), o1.oji + o2.ojc AS add
```

### A/B Test Comparison

```
-- Compare control vs test using inline FROM filters
FROM myindex (variant = 'control') 1w today AS control,
     myindex (variant = 'test') AS test
WHERE country = 'us'
SELECT control.COUNT(), test.COUNT(),
       control.[clicks] / control.COUNT() AS control_ctr,
       test.[clicks] / test.COUNT() AS test_ctr
```

### Percentage of Parent Group

```
-- What fraction of each group's total does each row represent?
FROM myindex yesterday today
WHERE status = 'active'
GROUP BY category, subcategory
SELECT COUNT(),
       100 * COUNT() / PARENT(COUNT()) AS pct_of_category
```

### Subqueries with IN

```
-- Filter to only terms that appear in the same dataset
FROM organic yesterday today
WHERE tk IN (FROM SAME GROUP BY tk)

-- Filter using a subquery with its own WHERE
FROM organic yesterday today
WHERE tk IN (FROM SAME WHERE tk = 'a' GROUP BY tk)

-- Filter using a different time range
FROM organic yesterday today
WHERE tk IN (FROM organic 60m 0m GROUP BY tk)
```

### Conditional Metrics

```
-- Count documents matching specific conditions
FROM dataset 1d today
GROUP BY category
SELECT COUNT(),
       COUNT_IF(status = 'error') AS error_count,
       RATE_OF(status = 'error') AS error_rate

-- Conditional aggregation with IF/THEN/ELSE
FROM dataset 1d today
GROUP BY region
SELECT COUNT(),
       [IF country = 'US' THEN revenue ELSE 0] AS us_revenue,
       [IF country = 'US' THEN 1 ELSE 0] AS us_count
```

### HAVING Filters

```
-- Only keep groups with at least 4 documents
FROM organic yesterday today
GROUP BY tk HAVING COUNT() >= 4
SELECT COUNT()

-- HAVING with aggregate metric comparison
FROM organic yesterday today
GROUP BY time(12h) HAVING [label = 1] / COUNT() > 0
SELECT [label = 1] / COUNT()

-- TOP with HAVING
FROM organic 1d 0d
GROUP BY country[TOP BY ojc HAVING oji > 0], tk
SELECT COUNT(), oji
```

### Anti-Patterns: Don't Write This → Write This

```
-- WRONG: Time range in WHERE (SQL habit)
FROM myindex
WHERE date BETWEEN '2024-01-01' AND '2024-01-31'
SELECT COUNT()

-- CORRECT: Time range in FROM
FROM myindex "2024-01-01" "2024-01-31"
SELECT COUNT()
```

```
-- WRONG: Using SUM() function (does not exist in IQL)
FROM myindex 1d today
GROUP BY category
SELECT SUM(revenue)

-- CORRECT: Bare field name = implicit SUM
FROM myindex 1d today
GROUP BY category
SELECT revenue
-- Or use explicit bracket notation:
SELECT [revenue]
```

```
-- WRONG: Expecting raw field values in SELECT
FROM myindex 1d today
GROUP BY user_id
SELECT email
-- This returns SUM(email), not the email string!

-- CORRECT: Use FIELD_MAX or FIELD_MIN to get a field value
FROM myindex 1d today
GROUP BY user_id
SELECT FIELD_MAX(email)
```

```
-- WRONG: Using LIKE for pattern matching
FROM myindex 1d today
WHERE name LIKE '%smith%'

-- CORRECT: Use regex operator
FROM myindex 1d today
WHERE name =~ 'smith'
```

```
-- WRONG: COUNT(*) with asterisk
SELECT COUNT(*)

-- CORRECT: Empty parens
SELECT COUNT()
```

```
-- WRONG: Double quotes for alias with special characters
SELECT 100 * [mobile] / COUNT() AS "% mobile"

-- CORRECT: Use backticks for aliases with special characters
SELECT 100 * [mobile] / COUNT() AS `% mobile`
-- Plain aliases without special characters need no quoting:
SELECT COUNT() AS total
```

```
-- WORKS but harder to read:
from myindex yesterday today where status = 'active' select count()

-- RECOMMENDED: UPPERCASE keywords for readability
FROM myindex yesterday today WHERE status = 'active' SELECT COUNT()
```

```
-- WRONG: Curly braces around parameter name (shell/template variable style)
WHERE devicePlatform = '${devicePlatform}'

-- CORRECT: Dollar sign only, no curly braces
WHERE devicePlatform = '$devicePlatform'
-- For numeric params (no quotes):
WHERE count > $minCount
```

---

## 6. Regex in IQL

### Regex Engine

IQL uses the **brics automaton** library — **not** `java.util.regex`. Some Java regex features (lookaheads, backreferences, etc.) will not work. Test patterns at [regexr.com](https://regexr.com/) but be aware of engine differences.

**Performance warning:** Regex forces a full scan of all documents before filtering. Always prefer `field IN ('a', 'b')` or exact equality when possible. When you must use regex, test on a small time range first.

### Unsupported Syntax

Because IQL uses brics automaton (not java.util.regex), these common Java/Python regex features **do not work**:

| Don't use | Use instead |
|-----------|-------------|
| `\s` (whitespace) | `[ ]` or a literal space |
| `\d` (digit) | `[0-9]` |
| `\w` (word char) | `[a-zA-Z0-9_]` |
| `(?i)` (case-insensitive flag) | `[Nn]urse` bracket alternatives |
| Lookaheads / lookbehinds | Not supported |
| Backreferences | Not supported |

### Common Patterns

```
-- Substring match (contains "part time" anywhere in the value)
WHERE qnorm =~ '.*part time.*'

-- Alternative terms (assistant OR secretary)
WHERE qnorm =~ '.*(assistant|secretary).*'

-- Case-insensitive match (no (?i) flag — use bracket alternatives instead)
WHERE metadataExperience =~ '.*[Ee]xperienced.*'

-- Character range
WHERE nbid =~ '62.*[0-3]'

-- Minimum occurrences: 4+ whitespace-separated tokens
WHERE normTitle =~ '[^ ]+( +[^ ]+){3,}'
```

Quantifier syntax:
- `{n}` — exactly n occurrences
- `{n,m}` — between n and m occurrences
- `{n,}` — n or more occurrences

### Escaping Special Characters

Special regex characters (`*`, `?`, `.`, etc.) must be escaped with a backslash. The number of backslashes depends on the IQL version and quote style:

| Context | Example | Escape needed |
|---------|---------|---------------|
| IQL v1, single quotes | `qnorm =~ '.*\*.*'` | Single backslash `\` |
| IQL v1, double quotes | `qnorm =~ ".*\\*.*"` | Double backslash `\\` |
| IQL2 (either quote) | `qnorm =~ '.*\\*.*'` | Double backslash `\\` |

When in doubt, use double backslashes — they work in IQL2 regardless of quote style.

### Regex on Multi-Valued Fields

To filter a multi-valued field so only matching terms are returned (not all terms on the document), use `HAVING TERM()=~` in GROUP BY rather than WHERE:

```
-- Extract only the values from additional_info_tokens that look like email addresses
FROM resumedata 2011-01-01 today
WHERE searchable = 'yes'
GROUP BY additional_info_tokens HAVING TERM() =~ '.*[^ ]\\@[^ ]+\\.[^ ]+.*'
SELECT COUNT()
```

A WHERE filter on a multi-valued field includes the document if *any* term matches; the HAVING approach restricts the *groups* to only matching term values.

### Common Mistakes

```
-- WRONG: operator order reversed — gives zero results silently, no error
WHERE labels ~= '.*fixit.*'

-- CORRECT
WHERE labels =~ '.*fixit.*'
```

---

## Important Grammar Notes

1. Keywords are **case-insensitive**: `SELECT`, `select`, `Select` all work. UPPERCASE is conventional for readability. Field names and string literal values remain case-sensitive.
2. **Backticks are for identifiers** (field names and aliases): `` `field name with spaces` ``, `` COUNT() AS `% of total` ``. Use backticks whenever an identifier contains spaces, `%`, `-`, or other special characters.
3. **Quotes are for string literals** (values): `'string'` or `"string"`. Do NOT use double quotes for aliases — `AS "my alias"` is a syntax error; use `` AS `my alias` `` instead.
4. Comments: `/* multi-line */` or `-- single line`
5. Identifiers can include most keywords as field names (the grammar is permissive with identifier naming).
6. The `SAME` keyword in subqueries refers to the current dataset: `FROM SAME GROUP BY field`.
7. **Parameters use `$paramName` syntax** (no curly braces): `WHERE field = '$myParam'`. Do NOT use `${myParam}` — IQL does not support shell-style brace expansion.

