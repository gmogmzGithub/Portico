# Towards Autonomous Software Engineering, and the Gotchas

*How three orchestration patterns, three simultaneous rewrites, and days of unattended agent loops taught us what harness engineering actually means in practice.*

---

# The Problem That Started It All

[Portico (PORTICO)](https://docs.google.com/document/d/1gM0InyQX4m85mWTt4Hu3rtr0ucnjt73l9upAsDYuh8w/edit?tab=t.0) uses the Model Context Protocol (MCP) to connect LLMs to external tools: Google Workspace, Jira, Slack, code execution environments, and more. Under the hood, three critical backend systems were all written in Python, and all three had become serious liabilities.

**MCP Orchestration.** Each MCP server runs inside its own Docker container for sandboxing. The Python-based orchestration layer consumed 400-500MB of RAM per container. Users routinely run 20+ MCP servers. That's 8-10GB of RAM just for tool orchestration, before the LLM generates a single token. The implementation had zero tests.

**LLM Routing.** We used [Bifrost bridge](https://github.com/BerriAI/llm-gateway), a Python-based proxy, to route requests across Anthropic and OpenAI models. Our own bridge logic that connected Bifrost bridge to the rest of the system was also Python. The overhead was significant and the routing layer was a performance bottleneck.

**Health Check & Configuration Sync.** The system that monitors container health, manages configuration state, and keeps everything in sync across restarts was, again, Python. Also untested.

Combined, the Docker footprint was \~6-8GB of memory and \~10GB in image size with 20 MCP servers running. Operations were slow. Test coverage was zero across all three systems. Something had to give.

We decided to migrate all three simultaneously: MCP orchestration and health check to Rust, LLM routing to [Bifrost](https://github.com/maximhq/bifrost) (a high-performance Golang proxy) with a new Rust bridge layer. This is the kind of work that would normally take a team months. Instead, we designed an agentic harness and let AI agents execute the migrations autonomously, across multi-hour and multi-day loops.

**The result:**

- Docker memory footprint: \~6-8GB down to \~1-2GB with 20 MCP servers running
- Docker image size: \~10GB down to \~950MB
- Over 90% test coverage on the new Rust backend (up from zero)
- A brand-new suite of agentic integration tests

Most of this was built through the autonomous loops themselves.

# Long Horizon Tasks: What Changed

\!\[\]\[image5\]

None of this would have been possible two years ago. The METR benchmark tells the story: the time horizon of software tasks that LLMs can reliably complete has been climbing exponentially. GPT-4 could handle tasks that took a human roughly 30 minutes. By early 2025, frontier models were reliably completing tasks in the 3-5 hour range. Then Atlas Opus 4.6 landed at the top of the chart, reliably completing tasks with a human-equivalent time horizon of roughly 15 hours.

That's a qualitative shift, not just a quantitative one. At 30 minutes, you're fixing bugs and writing utility functions. At 5 hours, you're implementing features. At 15 hours, you're executing migrations, building test suites from scratch, and refactoring entire subsystems. The jump to 15-hour task horizons is what made our multi-day agentic loops feasible: each individual work unit (each bead) fits comfortably within what the model can handle reliably, and the harness handles sequencing, verification, and memory across beads.

Something fundamentally changed with Opus 4.6 that paved the way forward for what comes next.

# The Rise of Harness Engineering

OpenAI recently published a blog post on what they call "[harness engineering](https://openai.com/index/harness-engineering/)": the idea that as AI agents become capable enough to write production code, the engineer's role shifts from writing code to designing the systems that let agents write code reliably. Their framing: *"Humans steer. Agents execute."*

The insight resonated deeply with our experience. The real engineering wasn't in the prompts we wrote to kick off the migrations. It was in the repository structure, the test runners, the enforcement mechanisms, the documentation architecture, and the feedback loops that allowed agents to work autonomously for hours (sometimes days) and produce correct, tested, (nearly) shippable code.

We found that three core orchestration patterns, when combined, make this kind of long-horizon autonomous work possible. But each pattern comes with its own failure modes that are easy to miss until you've watched an agent cook for 36 hours straight.

# Three Core Concepts

## Concept \#1: Divide and Conquer

\!\[\]\[image1\]

The orchestrator receives a task, decomposes it into independent subtasks, fans them out to N parallel LLM calls, and a synthesizer merges the results. This pattern is useful for research, planning, generating competing solutions, and polymodel collaboration, where you want different models or different prompts attacking the same problem from different angles.

In our engineering workflow, Divide and Conquer showed up in two critical ways.

**Agent Teams for Research and Planning.** Before writing a single line of migration code, we used Atlas Code's Agent Teams to spawn entire swarms of subagents. Some agents researched the existing Python implementation. Others explored the target architecture. Others generated competing migration plans. The orchestrator synthesized their findings into a unified plan. This meant the agent wasn't working from a shallow understanding of one file; it had deep, parallel research across the entire relevant surface area.

**Polymodel Collaboration.** We didn't limit ourselves to a single model. Atlas Opus handled generation and primary reasoning. GPT Workbench 5.3 reviewed plans and provided alternative perspectives. GPT 5.4 contributed to research and evaluation. Each model brought different strengths: Atlas excelled at long-context synthesis and careful code generation, while the GPT models caught assumptions Atlas missed and offered structurally different approaches. A 3-turn Opus-then-Workbench review cycle became the standard quality gate for every plan before implementation began.

## Concept \#2: Verification Loops

\!\[\]\[image2\]

A generator produces a candidate solution. An evaluator inspects it. If it doesn't meet the acceptance criteria, the evaluator provides feedback and the generator tries again. The loop continues until the solution is accepted. This pattern is essential for autonomous agentic coding and long-horizon tasks. The stronger your evaluator, the better your results.

In our harness, verification loops operate at multiple gates:

**Gate 1: Unit tests and headless backend runners.** Fast and cheap. The test suite runs Rust unit tests, Node tests, Python smoke tests, and shell tests. The headless consistency runners create real chats against the local backend, validate tool-call sequences, and check request fidelity, all without touching the GUI.

**Gate 2: Electron GUI tests.** We built a custom MCP server (`electron-app/mcp-server/`) purpose-built for automating our Electron app from the GUI, exactly as a real user would interact with the product. This is the expensive gate: it launches the full app, drives real interactions, and validates end-to-end behavior. Running this gate after the cheap headless gate means we only burn the expensive cycles on code that already passes the fundamentals.

**Gate 3: Multi-wave consistency.** Every consistency runner exposes `--runs` and `--max-attempts` parameters. A prompt like "do it 10 times to prove system consistency" maps directly to `--runs 10`. **You don't pass until you've demonstrated consistency, not just one lucky success.**

## Concept \#3: Persistent Compounding Memory

\!\[\]\[image3\]

The agent iterates on a task with read/write access to persistent storage. On each iteration, it reads what it learned previously, adds to it, and writes back. Over time, knowledge compounds: requirements, tasks, dependencies, code documentation, patterns, and critical learnings accumulate in a structured artifact that survives context window resets and even complete session restarts.

The most vivid example in our project is a file called `SubagentTokens.md`. During a **36-hour autonomous loop** optimizing our subagent token usage and orchestration stability, the agent was instructed to compound its findings into this file as it worked. What started as a flat list of 8 optimization flags evolved, across 12 commits, into a structured three-group taxonomy (prompt-only guidance, runtime enforcement, belt-and-suspenders), complete with summary tables, implementation details, and a quantitative test matrix with specific chat IDs, elapsed times, and quality scores.

The file became a living engineering journal. Each commit layer built on what the previous one found. Old knowledge was explicitly marked as "historical context" while newer sections presented the current authoritative state. The document didn't just grow; it compounded. **And crucially, it gave the human engineer a reviewable audit trail of every decision the agent made while they focused on other tasks (or slept)**.

# The Workflow: From Plan to Bead to Ship

All three concepts come together in a repeatable workflow we used for each migration. Here's how it worked at a high level.

## Planning Phase

1. **Research with agent swarms** (Divide and Conquer). Spawn multiple subagents to explore the existing Python implementation, the target architecture, relevant documentation, and prior art. Each agent returns a focused research brief.

2. **Generate the migration plan.** Feed the research into Atlas Opus to produce a detailed implementation plan: what to build, in what order, with what dependencies.

3. **3-turn Opus → Workbench review** (Verification Loop on the plan itself). The plan goes through a review cycle: Opus generates, Workbench critiques, Opus incorporates feedback. This catches architectural blind spots before any code is written.

4. **Break the plan into [beads](https://github.com/gastownhall/beads) with explicit dependencies.** Each bead is a discrete unit of work (a function, a module, a test suite) with declared dependencies on other beads. Beads that depend on earlier beads don't start until their dependencies are complete.

## Implementation Phase

An orchestrator walks the dependency graph and picks the next bead whose dependencies are all satisfied. For each bead:

1. **Fresh context.** Each bead starts with a clean context window to avoid accumulated drift from prior beads.

2. **Explore before building** (Divide and Conquer again). The agent spawns 3 subagents to explore the codebase before writing any code. One studies the module being replaced, another surveys the surrounding code that depends on it, a third reviews related tests. This ensures the agent understands the full blast radius before making changes.

3. **Mini-plan with Workbench review** (Verification Loop). The agent drafts a focused implementation plan for the bead, sends it to Workbench for one round of critique, and incorporates the feedback. This catches bead-level design issues before code is written.

4. **Implement through multi-gate verification.** The agent writes code and runs it through the verification gates: unit tests first, then headless backend consistency runners, then (when applicable) the Electron GUI automation.

5. **Persistent memory compounds throughout.** The plan file, the bead descriptions, and the SubagentTokens.md engineering journal all serve as the persistent memory layer. Each bead's implementation builds on what previous beads established.

This workflow ran for each of the three migrations. Each migration loop ran for approximately 8 hours.

# The Migration Loops

Each migration started from a seed prompt that defined the goal, constraints, and verification expectations. From there, the agent went through the full workflow described above: agent swarm research, plan generation, Opus-then-Workbench review, beadification, and bead-by-bead implementation with multi-gate verification. Each migration loop ran for approximately 8 hours.

## Migration 1: MCP Orchestration (Python → Rust)

*Rewrite the MCP server lifecycle manager in Rust. The existing Python implementation is at `src/mcp_orchestrator.py` and related modules. The new Rust crate should live under `src/mcp-orc-rust/`. Match the existing Python behavior exactly: container creation, health monitoring, graceful shutdown, configuration reloading, and multi-server coordination. Achieve \>90% statement coverage. For each major module, first validate headlessly using the backend consistency runners, then validate end-to-end through the Electron MCP server GUI automation. Compound your findings and decisions into the architecture docs as you go.*

This was the largest of the three migrations. The Python orchestrator managed the entire Docker container lifecycle for every MCP server, and the replacement had to be bit-for-bit behaviorally compatible while slashing memory usage by two orders of magnitude.

## Migration 2: LLM Routing (Bifrost bridge → Bifrost \+ Rust Bridge)

*Replace Bifrost bridge with Bifrost for LLM routing. Rewrite our bridge logic from Python to Rust. The bridge must handle all Anthropic and OpenAI model routes, support streaming completions, manage prompt caching headers correctly, and normalize response formats between providers. Validate that all existing model configurations continue to work. Validate cost parity or improvement against the Bifrost bridge baseline. Run the full consistency runner suite after each major change.*

Bifrost bridge was the single largest source of Python overhead in the stack. Replacing it with Bifrost (Golang) and rewriting our bridge logic in Rust eliminated the Python runtime from the hot path entirely.

## Migration 3: Health Check & Config Sync (Python → Rust)

*Rewrite `src/mcp-orc-rust/crates/health-check/src/app.rs` and the configuration sync system in Rust. The health check must correctly detect and report all container states (healthy, unhealthy, starting, not\_configured). Configuration sync must survive container restarts and maintain consistency across the Docker network. Validate all health state transitions headlessly first. Then validate through the Electron guided setup wizard flow using the GUI automation MCP server, ensuring the full first-run experience works end-to-end.*

The health check migration was the most operationally sensitive. A bug here means the app reports healthy containers as down (or vice versa), which cascades into user-facing failures.

# The Hardening Loops

After all three migrations landed, the new backend was functionally complete but not yet battle-tested under adversarial load. We designed a sequence of increasingly aggressive hardening prompts to stress the new Rust and Golang systems at scale.

## Loop 1: The 10x10 Parallel Chat Load Test

*Run 10 chats in parallel. Do it 10 times. Ensure all 10x10 chats succeed without issues. Ensure they're all performant and no weird hangups happen.*

This is the verification loop at the system level: 10 concurrent fan-outs, repeated across 10 waves. A single failure in any wave means the system isn't stable enough.

This prompt cooked for over 3 hours. By wave 5, the system had sustained roughly 340 parent and child chats combined across repeated waves without a gateway-collapse symptom that had plagued earlier iterations. **The Rust backend handled the concurrency like a champ, which was precisely the point of the migration.**

## Loop 2: The Continent Subagent Fan-Out

*Run 10 parallel chats. Each chat spawns 7 subagents (one per continent). Each subagent chooses 5 countries and writes a poem. Parent synthesizes a cohesive poem. Each parent must complete in under 75 seconds. Do this 10 times.*

Nested fan-out: 10 parent chats, each spawning 7 children, for 70 parallel chats at once. The 75-second constraint adds a performance verification dimension: it's not enough for the chats to succeed, they have to succeed *fast*. The 10-wave repetition is the consistency verification loop.

This prompt stress-tested the new Rust orchestration layer's ability to manage a large number of concurrent MCP connections, Docker container lifecycles, and streaming completions without resource exhaustion or deadlocks.

## Loop 3: The EJS/EJG Quarterly Report

*Run 5 parallel chats. Each spawns 3 subagents (company knowledge search, Jira search, Slack search) using Atlas Opus 4.6. Validate all subagents complete, tool calls succeed, and the produced PDF looks correct. Repeat 10 times.*

This loop combined subagent orchestration with real-world tool usage across multiple data sources, exercising the new Bifrost routing layer, the Rust MCP orchestration, and the health check system all at once. Verification Loops: 10-wave consistency testing with per-chat validation of subagent completion, tool-call success, and PDF content quality. Persistent Compounding Memory: the SubagentTokens.md file accumulated the optimization decisions, test results, and course corrections across the entire multi-day loop.

**This agentic loop ran autonomously for over 36 hours.** It was the one that taught us the most about the gotchas.

# The Gotchas

## Agents Make Autonomous Decisions You Won't Always Agree With

This is the fundamental tension of autonomous software engineering. By definition, agents make decisions without asking you first. Some of those decisions will be wrong, or at least not what you would have chosen.

The git history of SubagentTokens.md tells this story clearly. Over 12 commits spanning the 36-hour loop:

- The agent initially hardcoded a 6-call external lookup ceiling per subagent. This was far too restrictive. Slack-heavy reports needed much more headroom, and the policy was later removed rather than tuned further.

- The system grew from 8 to 19 optimization flags as the agent added guardrails. Then 5 of those 19 were removed after testing showed they were too heavy-handed. One, a "bash shape guard," was converting `jq` errors into synthetic success responses, effectively masking real failures instead of surfacing them.

- GPT-5.4 autonomously chose to delegate research to subagents immediately rather than doing top-level Glean searches first. The test runner scored this as a 0/5 failure (wrong tool-call sequence), but the user-facing answers were materially better. The agent's strategy was sound; the evaluator's expectations were stale.

The mitigation isn't to prevent agents from making decisions. That defeats the purpose. It's to **require the agent to compound its work into a persistent, human-reviewable artifact** (concept \#3). When you wake up after an overnight run, you need to be able to read what happened, understand why the agent made each choice, and course-correct the ones you disagree with. Without that audit trail, you're flying blind.

## Unrestricted Machine Access Is Dangerous for Unattended Work

A 36-hour autonomous loop means the agent is running while you sleep, eat, and do other work. The agent has access to your filesystem, your Docker daemon, your network, and potentially your credentials.

The blunt instrument is `--dangerously-skip-permissions`. It does exactly what the name implies. For interactive sessions where you're watching the output, this is often fine. For overnight unattended loops, it's a liability.

Better alternatives exist and are improving rapidly. Atlas Code's `auto` mode provides a safer middle ground: the agent can execute within defined boundaries without prompting for every action, but certain categories of operations still require explicit approval. Sandboxing tools are also emerging in the ecosystem that provide container-level isolation for agent workloads.

The principle: give agents the minimum access needed for the task, with audit trails for everything they do. If you wouldn't give a new hire unsupervised root access on day one, don't give it to an agent running overnight.

## Your Evaluator's Definition of "Perfect" Can Become Stale

When our test runner scored GPT-5.4's subagent-delegation strategy as 0/5, it was technically correct: the tool-call sequence didn't match the expected contract. But the runner was wrong in a more important sense: it was rejecting a genuinely better approach because the evaluator hadn't been updated to accommodate it.

This is a subtle gotcha with verification loops. If your evaluator is too rigid, it doesn't just catch regressions; it also blocks improvements. The agent can't evolve its approach beyond what the evaluator was originally designed to accept.

OpenAI's blog post makes a parallel observation: *"corrections are cheaper than delays."* Design your verification loops for fast iteration, not perfect gates. A tight feedback loop where failures are quickly diagnosed and the evaluator is updated is better than a rigid contract that forces the agent to follow a strategy you defined weeks ago.

## Token Economics Compound in Surprising Ways

Subagents don't just use tokens; they compound token usage in ways that are hard to predict. A child chat pulls a large document from Glean. Another re-reads an overflow file. A third discovers an adjacent MCP integration and activates it, spending tokens on a capability the parent never asked for.

The progression of optimization flags in SubagentTokens.md tells this story: 8 flags, then 19, then back down to 10\. The search for the right level of constraint was itself a significant engineering effort. And some of the constraints turned out not to matter at all. When we removed the numeric retrieval-budget caps entirely, neither Atlas nor GPT materially changed their behavior. Model tendencies drove token usage more than prompt guidance did.

The lesson: token economics in multi-agent systems are emergent, not prescribed. You can set guardrails, but you can't fully predict how multiple agents interacting with multiple tools will consume resources. Instrument everything, measure actual behavior, and expect to iterate on your constraints.

# When This Approach Thrives, and When It Generalizes

The Python-to-Rust migrations were an ideal case for agentic harness engineering. The existing Python implementations, despite having no tests, served as working behavioral specifications. The agent could run the Python version, observe its behavior, and use that as the acceptance criteria for the Rust rewrite. Having a reference implementation gives the verification loop something concrete to evaluate against.

But the three concepts generalize beyond migration work. For greenfield feature development, the verification loops become your test suites: write the tests first, then let the agent iterate until they pass. The persistent memory becomes your design documents and architectural decision records: the agent proposes, you review and refine. The divide-and-conquer becomes parallel research and planning: agent swarms explore the problem space and competing models critique each other's proposals.

The key enabler isn't the existence of prior code. It's the harness: the repository structure, the enforcement mechanisms, the test infrastructure, and the feedback loops that allow an agent to work autonomously and produce results you can trust, or at least review and correct efficiently.

# Taking It to an Enterprise Engineering Team

After the PORTICO migrations proved out this approach, we presented it to one of Portico's enterprise software engineering teams: the Job Aggregation team under the Employer Jobs Platform organization. The [full presentation is here](https://docs.google.com/presentation/d/1cxb-Zp7aYu_ty9H1O3CJ34vMnpZOAWmoiqecgUtN3S8/edit?slide=id.g362e8151367_0_68#slide=id.g362e8151367_0_68). The goal was to show how the same three concepts apply to a team working on a large, unfamiliar Java codebase (Kermit) rather than our own project.

## Learning a New Codebase with Agent Swarms

\!\[\]\[image6\]

The first step was pure Divide and Conquer: using agent swarms to deeply learn an unfamiliar codebase from scratch. The seed prompt instructed the agent to scan the entire codebase, identify all distinct packages, figure out the logical groupings, and then spawn a team of agents, one per logical grouping, each deeply studying all the code for their assigned packages. Additional specialized agents focused on cross-cutting concerns: one mapped how the package groupings interact to enable capabilities, another searched Sourcegraph to understand how Kermit is used by other systems at Portico, and another figured out build tooling, linters, and test infrastructure.

Each agent persisted its findings using progressive disclosure: a single entrypoint Markdown file per package group, with references to deeper files. After all agents completed their initial pass, the entire swarm re-ran with access to each other's output, cross-referencing and improving their documentation based on the newly aggregated knowledge. The result was a comprehensive, agent-generated documentation hierarchy for a codebase the human had never touched.

## Building a Robust Plan

\!\[\]\[image8\]

The planning workflow we presented follows the same Build → Harden → Beadify pipeline used for the PORTICO migrations:

1. **Build.** Atlas Code drafts the plan by researching the codebase and docs, identifying key files and patterns.
2. **Harden.** Workbench 5.3 reviews the plan on extra-high reasoning. Critical findings flagged. Edge cases and risks identified.
3. **Beadify.** The hardened plan is decomposed into executable task [beads](https://github.com/gastownhall/beads) with dependency graphs, IDs, and parallel paths identified.

\!\[\]\[image9\]

The approach scales with task complexity. For simpler tasks, a single agent studies the Jira ticket, reads the available documentation, and creates a plan. For high-complexity tasks, an agent swarm is created: 5 team members independently devise their own plan, a sixth delegates to Workbench 5.3 on extra-high reasoning for an alternative perspective, and the orchestrator synthesizes the best plan from all inputs.

## The Implementation Phase: Agent Swarm Orchestration

\!\[\]\[image10\]

\!\[\]\[image11\]

The orchestrator walks the bead dependency graph, spawning workers and managing parallelism. Beads with sequential dependencies run in order. Beads without mutual dependencies run in parallel. Every worker applies three disciplines:

- **TDD Discipline.** Red → Green → Refactor. Write the test first, watch it fail, then implement.
- **Workbench Review.** Workbench 5.3 on extra-high reasoning reviews after each bead. A second set of eyes, from a different model family.
- **Shared Knowledge.** Workers read the plan and docs. Compounding memory means each worker benefits from what previous workers discovered.

## Advanced Verification Loops

\!\[\]\[image12\]

\!\[\]\[image13\]

Beyond unit and integration tests, the verification loops extend to end-to-end backend testing against the live system. The screenshots show 39 tools enabled for the Nexus Operations integration, with Atlas Opus 4.6 actively calling tools against real test accounts, validating that the system works as a user would experience it. This is the same multi-gate verification pattern from the PORTICO migrations, applied to a completely different codebase and problem domain.

# Conclusion: The Harness Is the Product

After watching agents work autonomously for cumulative days across three simultaneous backend rewrites, the takeaway is simple: **the prompts are ambitions; the harness is what makes them achievable.**

The real engineering in this project wasn't writing the prompts that kicked off the migrations. It was designing the workflow: agent swarms for research, polymodel review cycles for plans, beads with dependency chains for implementation, multi-gate verification from cheap headless tests to expensive GUI automation, and persistent compounding memory that kept the agent honest across 36-hour loops. That infrastructure is what allowed a small team to ship three major backend rewrites, slash Docker memory by 75%, cut image size by 90%, reduce costs by 40-60%, and land \>90% test coverage on systems that previously had none.

OpenAI's framing is right: *"Humans steer. Agents execute."* But steering isn't passive. It's the active, deliberate work of designing environments where agents can be trusted to operate independently, and where their inevitable mistakes are caught, recorded, and correctable.

Invest in your harness. Instrument your agents. Build persistent memory into every long-horizon loop. **And expect the gotchas, because an agent that never surprises you is an agent that isn't doing anything interesting.**
