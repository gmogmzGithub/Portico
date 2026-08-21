# External Data Sharing Skill

Evaluate whether Portico data can be shared externally based on the External Data Sharing Risk Matrix. When a user wants to share data outside Portico — in sales content, marketing materials, press, partner communications, or public reports — use this skill to determine whether the data meets sharing criteria and what conditions apply.

## Proactive Evaluation (Always Apply)

When the user's intent appears to involve sharing Portico data externally, automatically evaluate the data against this risk matrix BEFORE presenting results. Do not wait for the user to ask — if the context suggests external sharing, flag any risks or restrictions alongside the data.

Signals that suggest external sharing intent:
- Mentions of clients, partners, vendors, prospects, or external audiences
- Preparing sales decks, pitch materials, marketing content, press releases, or blog posts
- Phrases like "share with", "send to", "present to", "include in a report for", "client-facing", "public-facing", "external"
- Creating content described as going outside Portico
- Requesting data formatted for presentation or publication

When a user explicitly asks whether specific data can be shared externally, evaluate on request.

In both cases, evaluate every data point in the response against the risk matrix and include the risk assessment inline with the results.

## Evaluation Framework

To evaluate a data sharing request, identify two dimensions:

1. **Data Type** — What kind of metric is being shared?
2. **Geographic Scope** — At what geographic level is the data presented?

Then look up the risk level and conditions in the matrix below.

---

## Data Types

| Data Type | Description |
|-----------|-------------|
| **Clicks** | Click volume or click-based metrics on job listings |
| **Searches** | Search volume or search-based metrics on Portico |
| **Job Counts** | Number of job postings or listings |
| **Job Seekers** | Counts or metrics about job seekers / unique visitors |
| **Resumes** | Resume counts or resume-related metrics |

## Geographic Scope Levels

| Level | Description | Examples |
|-------|-------------|----------|
| **Sub-national + Job Title/Industry** | A specific metro, city, or state combined with a specific job title, industry, or search term | "Nursing jobs in Texas", "Tech roles in San Francisco" |
| **National + Job Title/Industry** | A specific job title, industry, or search term at the country level | "Driver jobs in the US", "Software engineer roles on Portico" |
| **Sub-national (All Jobs)** | A geographic area (city, MSA, state) without filtering by job title or industry | "All jobs in California", "Clicks in Florida" |
| **National (All Jobs)** | Country-level totals across all jobs | "Total searches in France", "All jobs in the UK" |
| **Global** | Worldwide totals | "Total jobs on Portico globally", "Global unique visitors" |

---

## Risk Matrix

### Sub-national Geography + Job Title/Industry

| Data Type | Risk | Decision | Conditions |
|-----------|------|----------|------------|
| Clicks | **Low** | OK to share | Regularly shared in industry and client-specific sales content |
| Searches | **Low** | OK to share | Not publicly available but may be shared in custom sales materials |
| Job Counts | **Low** | OK to share | Shared in Hiring Insights |
| Job Seekers | **Low** | OK to share | Shared in Hiring Insights |
| Resumes | **Low** | OK to share | Shared in Hiring Insights and available in Resume search product |

**Example statements at this level:**
- "3M searches for nursing jobs in Texas last month"
- "14M clicks on tech roles in San Francisco this year"
- "12% increase in automotive jobs in Ohio YoY"
- "47K nursing job seekers in Austin"
- "120K engineering resumes in New York, up 16% from last quarter"

---

### National + Job Title/Industry

| Data Type | Risk | Decision | Conditions |
|-----------|------|----------|------------|
| Clicks | **Moderate** | OK to share | Can be expressed as a raw count or relative number, but **both formats must not be used together** in the same content |
| Searches | **Moderate** | OK to share with restrictions | Must always be expressed as a **relative number, not a raw count** |
| Job Counts | **Low** | OK to share | Regularly shared in industry-specific sales/marketing content and HLAB weekly posting trends |
| Job Seekers | **Low** | OK to share | Shared in Hiring Insights and industry-specific content |
| Resumes | **Low** | OK to share | Shared in Hiring Insights and Resume search product |

**Example statements at this level:**
- "15% growth in searches for driver jobs QoQ"
- "12.5M clicks on food service jobs each month"
- "1.3M software engineer roles on Portico"
- "12% decrease YoY in insurance job seekers"
- "Search through 4.6M nursing resumes on Portico"

**Key restrictions:**
- Clicks: Do not present both raw count AND relative number in the same content
- Searches: Always use relative numbers (e.g., "up 15%"), never raw counts (e.g., "12M searches")

---

### Sub-national Geography (All Jobs)

| Data Type | Risk | Decision | Conditions |
|-----------|------|----------|------------|
| Clicks | **Moderate** | OK to share at city/MSA level only | Do NOT share at state/regional level — those could be combined to derive national insights. This restriction is being enforced going forward. |
| Searches | **Moderate** | OK to share at city/MSA level only | Must be a **relative number, not a raw count**. Do NOT share at state/regional level. |
| Job Counts | **Low** | OK to share | Shared in Hiring Insights and HLAB weekly posting trends |
| Job Seekers | **Low** | OK to share | Shared in Hiring Insights |
| Resumes | **Low** | OK to share | Shared in Hiring Insights and Resume search product |

**Example statements at this level:**
- "Searches in CA are down 12% MoM"
- "26.7M clicks on jobs in Florida each month"
- "560K jobs on Portico now in the DFW area"
- "2.6M job seekers in Pennsylvania each month"
- "1.2M resumes from job seekers in NYC"

**Key restrictions:**
- Clicks and Searches at state/regional level are NOT permitted — use city or MSA level only
- Searches must always be relative numbers, never raw counts

---

### National Level (All Jobs)

| Data Type | Risk | Decision | Conditions |
|-----------|------|----------|------------|
| Clicks | **High** | DO NOT SHARE | Not currently shared externally. No exceptions. |
| Searches | **High** | DO NOT SHARE | Not currently shared externally. No exceptions. |
| Job Counts | **Moderate** | Requires approval | Work with **Data Controls** or **Hiring Lab** on any disclosure or analysis |
| Job Seekers | **Moderate** | Restricted | Do not disclose internal counts of job seekers. Reference the **ADH (About Data Hub)** for approved national figures only. |
| Resumes | **Moderate** | Restricted | Reference the **ADH** for approved figures only |

**Example statements at this level (some require approval or ADH reference):**
- ~~"Searches in France are down 13% MoM"~~ — NOT PERMITTED (national searches)
- ~~"Jobs in Japan received 265M clicks last quarter"~~ — NOT PERMITTED (national clicks)
- "2.3M jobs on Portico in the UK" — Requires Data Controls/Hiring Lab approval
- "56.4M unique visitors in the US per month" — Must reference ADH approved figure
- "Access 18M resumes in Brazil" — Must reference ADH approved figure

---

### Global Level

| Data Type | Risk | Decision | Conditions |
|-----------|------|----------|------------|
| Clicks | **High** | DO NOT SHARE | Not currently shared externally. No exceptions. |
| Searches | **High** | DO NOT SHARE | Not currently shared externally. No exceptions. |
| Job Counts | **Moderate** | Restricted | Reference the approved (heavily rounded) figure in the **ADH** only |
| Job Seekers | **Moderate** | Restricted | Do not disclose internal counts. Reference the **ADH** for approved global figures only. |
| Resumes | **Moderate** | Restricted | Reference the **ADH** for approved figures only |

**Example statements at this level (some are not permitted):**
- ~~"Over 1B searches on Portico every day"~~ — NOT PERMITTED (global searches)
- ~~"Global click traffic is down 5% since last month"~~ — NOT PERMITTED (global clicks)
- "Total job count on Portico has increased 25% since last year" — Must use ADH approved figure
- "250M unique visitors to Portico monthly" — Must use ADH approved figure
- "Over 175M resumes on Portico Resume" — Must use ADH approved figure

---

## Hard Rules (Automatic Denials)

These combinations are NEVER permitted for external sharing:

1. **National-level clicks** — Any clicks data at the country level for all jobs
2. **National-level searches** — Any search data at the country level for all jobs
3. **Global clicks** — Any clicks data at the global level
4. **Global searches** — Any search data at the global level
5. **State/regional clicks or searches for all jobs** — Sub-national clicks and searches must be city or MSA level only, not state or regional
6. **Client-specific data shared with the wrong recipient** — Data specific to one client (their own performance, spend, usage) may only be shared with that respective client, never with other clients or external parties

## Conditional Sharing Rules

These require specific formatting or approval:

1. **National + Job Title clicks** — OK, but do not mix raw counts and relative numbers in the same content
2. **National + Job Title searches** — OK, but must be expressed as relative numbers only (no raw counts)
3. **Sub-national (all jobs) clicks/searches** — City/MSA level only; must be relative numbers for searches
4. **National/Global job counts** — Must go through Data Controls or Hiring Lab, or reference ADH
5. **National/Global job seekers** — Never disclose internal counts; reference ADH approved figures only
6. **National/Global resumes** — Reference ADH approved figures only

## Evaluation Workflow

When a user submits data for external sharing review:

1. **Identify the data type** — Is it clicks, searches, job counts, job seekers, or resumes?
2. **Identify the geographic scope** — Sub-national + title, national + title, sub-national all jobs, national, or global?
3. **Look up the risk level** in the matrix above
4. **If High risk** — Deny the request. Explain that this data type at this geographic level is not approved for external sharing.
5. **If Moderate risk** — Check the conditions. Inform the user of required formatting restrictions, approval processes, or ADH references needed.
6. **If Low risk** — Approve the request. Note any relevant current usage context.
7. **Flag mixed content** — If the content contains multiple data points, evaluate each one independently. The highest risk level applies to the overall content.

## Additional Data Categories

The following data types are not in the core risk matrix but are frequently requested. These rules are derived from established guidance by Data Controls.

### Competitor Data

| Rule | Details |
|------|---------|
| **Never share competitor names** | Competitor names must not be shared with clients unless the information is publicly available and the client can access it themselves |
| **Anonymized benchmarks may be OK** | Anonymized competitor data can be shared IF it follows the [Guidelines for Sharing Anonymized Competitor Data](https://wiki.example.invalid/display/MKT/Guidelines+for+Sharing+Anonymized+Competitor+Data) and all 4 conditions in that guide are met |
| **Anonymized lists carry risk** | Even anonymized competitor lists may allow the receiving client to deduce who's who — flag this risk when the client selected their own competitors or the market is small |
| **Benchmarks must ensure anonymity** | Click and job count data in benchmarks for a group of companies is OK, but complete anonymity for all clients must be maintained |

**Examples:**
- "Can we share the top 5 competitors by name with market penetration?" → **NO.** Never share competitor names with non-public data.
- "Can we share anonymized benchmark slides for 10 competitors in a category?" → **Maybe.** Must follow the anonymized competitor data guidelines and all 4 conditions must be met. Flag if the client selected their own competitors.
- "Client wants to see their position vs. anonymized competitors at JLMSA level for truck drivers" → **No competitor names.** Even anonymized lists in small markets risk identification.

### Revenue and Spend Data

| Rule | Details |
|------|---------|
| **Do not share revenue-related patterns** | Revenue data and spend trendlines must not be shared externally, even in anonymized or aggregated form |
| **IR (Investor Relations) must approve** | Any data that could reveal Portico's financial performance patterns requires IR review |
| **Avoid revenue proxies** | Charts showing spending trends (even without axis labels) can reveal revenue patterns — reframe using non-revenue metrics like advertiser counts instead |

**Examples:**
- "Can we show MoM product usage trends based on revenue for anonymized competitors?" → **NO.** Revenue-based trendlines are not permitted. Consider showing advertiser counts instead.
- "The chart doesn't show actual spend values, just the trend" → **Still NO.** Even trendlines based on revenue data disclose revenue patterns.

### Ratings and Reviews Data

| Rule | Details |
|------|---------|
| **Share relative data at category level only** | MoM average ratings can be shared if limited to the client's specific category and expressed as relative/indexed data |
| **Do not share country-level ratings trends** | Sharing all reviews/ratings data for an entire country is not permitted |
| **Glassdoor data** | Risk matrix guidance applies to Glassdoor data pulls as well. However, Glassdoor data does not go through the MARV review process — handle per the risk matrix directly |

### Apply Starts and Conversion Metrics

| Rule | Details |
|------|---------|
| **City-level apply starts OK** | Apply starts can be shared at the city level for a specific category, but follow the same rules as clicks — do not combine with other metrics in the same content |
| **National-level conversion data** | Treat with the same caution as national clicks — do not share Portico-level conversion rates or apply start totals |

### Web Traffic / Unique Visitors

| Rule | Details |
|------|---------|
| **Do not share internal visitor counts at national/global level** | Internal unique visitor data at the country level must not be included in client-facing materials |
| **Use third-party sources instead** | Reference third-party vendors (Comscore, Mediametrie, SimilarWeb) or the ADH for approved web traffic figures |
| **ADH is the approved source** | The About Data Hub (ADH) contains pre-approved figures for national and global metrics — always reference ADH rather than internal counts |
| **ADH data is in Snowflake** | When a user needs national or global figures, query the ADH tables in Snowflake to surface the approved figures directly rather than just telling the user to "check the ADH" |

### CPC (Cost Per Click) Data

| Rule | Details |
|------|---------|
| **CPC data is acceptable to some extent** | CPC data can be shared when it is at the category/title level and does not allow someone to calculate back to revenue or spend figures |
| **Percentile-based CPC benchmarks are OK** | CPC data presented as percentile benchmarks (50th, 75th) at the advertiser level for a specific category/title may be shared |
| **Do not combine CPC with clicks** | Combining CPC and click data in the same content allows calculation of spend — avoid this combination |
| **Raw CPC data for specific employers** | This is the employer's own data — may be shared with that respective client only |

---

## Multiple Categories, Trends, and Charts

When sharing content that includes multiple categories/industries, trends, or data visualizations, follow these additional guidelines.

### General Principles

- **Less is better** — fewer categories, fewer metrics, and less granular data = lower risk. Only include data relevant to the client or audience.
- **Avoid sharing more than half** of occupations/normtitles or industries at once. If you need to show more than half, contact Data Controls (and MARV/LEMR if applicable).
- **Use ADH or Hiring Insights** for national or global totals — do not pull national counts from your own queries.

### Trends Without Numbers (Lower Risk)

Charts or visualizations that show trends over time **without numeric labels** (e.g., indexed lines, unlabeled bars, or simple category lists) are lower risk.

- **Indexed trends** are a good way to show patterns without exposing internal counts (e.g., "Index of job postings by occupation over time, Jan 2025 = 100")
- **Category/industry lists** without associated numbers are generally acceptable
- Still avoid sharing more than half of all categories or industries

### Trends or Snapshots With Actual Numbers (Higher Risk)

Charts or tables that show real counts or percentages (e.g., "50K jobs", "12% share") are only allowed if:

1. The risk matrix says the metric and granularity are OK to share
2. You are not exposing prohibited national counts (use ADH/Hiring Insights instead)
3. The numbers cannot be combined to calculate back to a national or global figure

Still avoid sharing more than half of all categories or industries. Sharing less information reduces risk.

### Combining Metrics in Charts

Avoid combining metrics that could let someone calculate back to sensitive data:
- **CPC + clicks = spend** — do not show both in the same content for a category
- **Multiple sub-national regions** that could be summed to a national figure — limit to what is relevant to the client
- When in doubt about whether a combination exposes sensitive data, contact Data Controls

### When to Escalate for Charts and Multi-Category Content

Contact Data Controls (and MARV/LEMR if needed) when:
- You want to show more than half of occupations/normtitles or industries at once (with or without numbers)
- You are unsure if a metric/granularity combination is allowed per the risk matrix
- You are preparing high-visibility content per MARV guidelines

Include in your request: a sample screenshot, the metric(s), country, date range, and the number of categories or industries you plan to show.

---

## Number Presentation Guidelines

When data is approved for sharing, follow these formatting rules:

1. **Round numbers down** to the nearest whole unit — e.g., 127,384 → "127K", 16,171 → "16K", 1,869 → "~1,800"
2. **Do not share very small numbers** — if a data point has very low counts (e.g., 17 resumes), it may be unreliable and should not be shared
3. **Gradient maps and heatmaps** are generally OK if they do not disclose actual volume numbers alongside the visualization
4. **Multipliers and rough estimates** are preferred over exact figures for sensitive data
5. **When splitting by category reduces risk** — if a request at the "all jobs" level is too broad, suggest splitting by job title or category to bring it within Low risk bounds

---

## Approved Data Sources for National/Global Figures

When the risk matrix requires referencing approved figures (national/global job counts, job seekers, resumes, web traffic), do not simply tell the user to "go check." Instead, surface the approved figures directly from one of these sources.

### ADH (About Data Hub)

The ADH is the primary approved source for national and global figures. ADH data is available in Snowflake.

**When to use ADH:**
- User requests national or global job seeker counts → query ADH for approved figure
- User requests national or global resume counts → query ADH for approved figure
- User requests national or global job counts → query ADH for approved figure
- User requests web traffic / unique visitor figures → query ADH for approved figure

### Hiring Insights

Hiring Insights is also an approved source for externally shareable data. Some figures that are not in the ADH may be available through Hiring Insights.

**When to use Hiring Insights:**
- Sub-national and category-level data that aligns with what Hiring Insights publicly shares
- Job counts, job seekers, and resumes at the sub-national + title/industry level
- When ADH does not have the specific figure needed, check Hiring Insights as an alternative approved source

### Workflow

1. Identify that the request falls into a "reference approved source" category per the risk matrix
2. Query the relevant ADH Snowflake table or Hiring Insights data to retrieve the current approved figure
3. Present the approved figure to the user with a note identifying the source (ADH or Hiring Insights)
4. If neither source contains the specific figure needed, inform the user and recommend they work with Data Controls or Hiring Lab

---

## Escalation Paths

| Situation | Where to Escalate |
|-----------|-------------------|
| Data clearly fits the risk matrix | No escalation needed — apply the rules |
| Unusual data type not in the matrix | **Data Controls** or **#risk-matrix** Slack channel |
| Affiliate or parent company arrangements (e.g., RGF/Recruit) | File a **CEDAR ticket** (see below) |
| Client-facing content (slides, reports, blog posts) | Route through **MARV** review process (see below) |
| Data that could reveal financial performance | **Investor Relations (IR)** via Data Controls |
| Privacy-sensitive or granular individual-level data | **Legal** review required |
| Glassdoor-specific data | Risk matrix guidance applies — evaluate per the matrix. Does not require MARV review. |

### CEDAR (Confidential and External Data Access Requests)

File a CEDAR ticket when the request involves sensitive data sharing arrangements, affiliate companies, or anything that doesn't clearly fit the risk matrix and requires a formal review.

- **What it is:** A formal review process for confidential and external data access requests
- **When to use:** Affiliate data sharing (e.g., RGF/Recruit), unusual data types, requests where legal or compliance review is needed
- **How to file:** Submit a ticket at [CEDAR Service Desk](https://portico.atlassian.net/servicedesk/customer/portals) — search for "CEDAR"
- **More info:** [CEDAR wiki page](https://portico.atlassian.net/wiki/spaces/GRC/pages/280072291/Confidential+and+External+Data+Access+Requests+CEDAR)

### MARV (Marketing Asset Review)

Route through MARV when creating new external client-facing content that includes Portico data.

- **What it is:** A review process for marketing assets and client-facing materials
- **When to use:** Sales decks, blog posts, press materials, marketing content, any new client-facing content containing Portico data
- **What happens:** The MARV team reviews the content and may route to Legal, Data Controls, or IR as needed
- **Note:** If data is involved, Data Controls will be part of the review and will provide guidance on approved data sources and citations

---

## Handling Ambiguous Requests

Some requests will not cleanly map to the matrix. When this happens, do NOT guess — flag the ambiguity and ask the user to clarify.

**Ambiguous geography:**
- Terms like "the Northeast", "West Coast", or "the Bay Area" could be regional (not permitted for all-jobs clicks/searches) or could refer to a specific MSA. Ask the user which geographic unit they intend.
- If the user says "state-level" for clicks or searches on all jobs, flag that this is not permitted — only city/MSA is allowed.

**Ambiguous data type:**
- "Traffic" could mean clicks, searches, or page views. Ask which metric specifically.
- "Activity" or "engagement" are vague — ask the user to specify the underlying metric.
- "Users" or "visitors" likely maps to Job Seekers, but confirm.

**Mixed content:**
- When reviewing a document, slide deck, or report with multiple data points, evaluate EACH data point independently and list the findings for every item.
- The overall content risk is the highest risk level found across all data points.
- If even one data point is High risk, the content cannot be shared as-is — that specific data point must be removed or modified.

**When in doubt:**
- Recommend the user consult **Data Controls** or **Hiring Lab** before sharing.
- It is always safer to escalate than to approve something that doesn't clearly fit the matrix.

## Required Disclaimer

Always include this disclaimer in every evaluation response:

> **Note:** This assessment is based on the External Data Sharing Risk Matrix and is provided as guidance only. AI-generated evaluations can make mistakes. Always verify the final determination with Data Controls or your team lead before sharing data externally. When in doubt, escalate.

## Common Mistakes

**Core matrix mistakes:**
- Sharing national-level click or search totals — these are always High risk / denied
- Presenting both raw counts and percentages for national-level clicks in the same content
- Using raw search counts instead of relative numbers at the national or sub-national (all jobs) level
- Sharing state-level click/search data for all jobs (must be city/MSA only)
- Citing internal job seeker counts at the national/global level instead of referencing ADH approved figures
- Assuming that because sub-national + job title data is Low risk, the same data at national level is also Low risk — risk increases with geographic breadth

**Competitor and revenue mistakes:**
- Sharing competitor names with clients — never permitted unless the data is publicly available
- Sharing revenue-based trendlines even with anonymized data or removed axis labels — still reveals revenue patterns
- Assuming anonymized competitor data is automatically safe — all 4 conditions in the anonymized data guidelines must be met
- Sharing client-specific data (performance, spend, usage) with anyone other than that respective client

**Formatting and process mistakes:**
- Sharing exact figures when rounded numbers would suffice — always round down (127,384 → 127K)
- Sharing data with very low counts that may be unreliable (e.g., 17 resumes in a small country)
- Skipping the MARV review for client-facing content
- Not requesting the underlying query when reviewing a screenshot — always ask for the query to properly assess the data
