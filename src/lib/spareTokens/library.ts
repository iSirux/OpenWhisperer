/**
 * Spare Tokens — built-in prompt library.
 *
 * A curated set of generic, high-value maintenance prompts the user can run to
 * spend leftover subscription usage near a rate-limit reset. Entries ship in
 * code (so they improve across app updates); the store layer tracks per-item
 * auto-run state separately.
 *
 * Read-only entries produce a reviewable report and are the only ones eligible
 * for autonomous (auto-mode) launches. Write entries (`readOnly: false`) produce
 * a diff, require a worktree, and are never auto-fired.
 */

export interface SpareTokensPrompt {
  /** Stable kebab-case identifier (used as the key in per-item auto state). */
  id: string;
  title: string;
  /** One-line summary for UI. */
  description: string;
  /** Full prompt body (the preamble is prepended at launch). */
  prompt: string;
  /** false = produces a diff (worktree required, never auto-fired). */
  readOnly: boolean;
  appetite: 'small' | 'medium' | 'large';
  /** Benefits from parallel subagent fan-out. */
  fanOut: boolean;
}

/**
 * Shared prefix prepended to every spare-tokens launch. Establishes the
 * autonomous, review-shaped contract that keeps unattended runs from producing
 * slop (no questions, no outward actions, severity-ranked, scannable).
 */
export const SPARE_TOKENS_PREAMBLE = `This is an autonomous maintenance run on spare subscription capacity — no one is watching it. Work end to end without stopping and produce a single, complete, reviewable deliverable in your final message. Never ask the user questions or wait for input: make reasonable assumptions and note them inline. Never push, create pull requests, run destructive git commands, or touch anything outside this repository. Skip anything a linter or formatter would already catch (style, naming, import order, formatting) and focus only on substantive findings. Rank every finding Critical > High > Medium > Low, lead with the most important, and collapse clean or low-signal areas to a single line so the report stays scannable. If you find nothing of substance in an area, say so in one line rather than padding.`;

export const SPARE_TOKENS_LIBRARY: SpareTokensPrompt[] = [
  {
    id: 'multi-lens-review',
    title: 'Multi-lens review of recent changes',
    description: 'Parallel reviewers over the diff since main, merged and severity-ranked.',
    readOnly: true,
    appetite: 'medium',
    fanOut: true,
    prompt: `Review the diff between the current working tree and the main branch (compute it with git; if the branch is already up to date with main, review the most recent commits instead). Fan out parallel subagents, one per lens, and have them work concurrently: (1) security — injection, authz, secret handling, unsafe input; (2) performance — needless work on hot paths, N+1 patterns, blocking calls; (3) correctness & quality — logic bugs, edge cases, resource leaks; (4) test quality — whether the change is actually covered and whether the tests assert intent; (5) simplification — code that could be materially simpler or reuse an existing helper. Merge every lens into one report, de-duplicate overlapping findings, and rank the merged list by severity. For each finding give the file and line, a one-sentence explanation of why it matters, and a concrete suggested fix. Skip anything a linter would flag; a clean lens gets a single-line "no issues".`,
  },
  {
    id: 'refactoring-audit',
    title: 'Refactoring opportunity audit',
    description: 'Surface high-value refactors ranked by maintenance risk, not style.',
    readOnly: true,
    appetite: 'large',
    fanOut: true,
    prompt: `Audit the codebase for refactoring opportunities that reduce real future maintenance risk — patterns that are correct today but are liabilities as the code grows (duplicated logic that keeps drifting, overgrown functions/modules doing too much, leaky abstractions, tangled dependencies, primitive-obsession, copy-paste that should be a shared helper). Fan out parallel subagents by top-level directory/subsystem so the whole tree is covered concurrently, then merge their findings. For each opportunity give the location, the concrete smell, why it will cost more later, a proposed refactor, and a rough blast radius (how many call sites move). Explicitly skip anything a linter or formatter catches and skip cosmetic renames. Rank by severity/leverage and present the top items first; note the handful that are both high-value and low-risk as quick wins.`,
  },
  {
    id: 'security-review',
    title: 'Security review',
    description: 'Injection, authz, secrets, and leaky errors with exploitability notes.',
    readOnly: true,
    appetite: 'medium',
    fanOut: true,
    prompt: `Perform a focused security review of this repository. Fan out parallel subagents by category and run them concurrently: injection (SQL/command/path/template), cross-site scripting and unsafe rendering, authentication and authorization flaws, hardcoded secrets and credential handling, insecure deserialization, SSRF and unvalidated outbound requests, and information disclosure through error messages or logs. For every finding, explain concrete exploitability (who can trigger it and what they gain), not just theoretical risk, and propose a specific remediation. Aggressively filter false positives — do not report something that is not actually reachable or exploitable, and prefer a short "considered and cleared" note over a speculative flag. Rank findings by severity and lead with anything Critical or High.`,
  },
  {
    id: 'test-coverage-gaps',
    title: 'Test-coverage gap analysis',
    description: 'Which critical paths and error branches have no tests, ranked by risk.',
    readOnly: true,
    appetite: 'medium',
    fanOut: false,
    prompt: `Analyze this repository's test coverage by risk, not by percentage. FIRST establish how testing actually works here rather than assuming: discover the test framework(s), runner, and conventions in use, where tests live (co-located, a tests/ tree, integration/e2e suites, doctests, snapshot files), and what layers are and aren't exercised — so gap analysis and any suggested tests match the project's real setup. Then identify the critical paths, public APIs, and error/edge branches that currently have no meaningful tests, and rank them by how much damage a regression there would cause (data loss, auth bypass, money, corruption, user-facing breakage rank highest). For each gap, name the specific function or flow, describe the untested behavior, explain the risk, and sketch the one or two test cases that would most cheaply cover it — in the style the project already uses. Ignore trivial code that does not need tests. Deliver a prioritized list — the goal is to tell the reader exactly where to spend the next hour of test-writing, not to chase a coverage number.`,
  },
  {
    id: 'dead-code-hunt',
    title: 'Dead-code hunt',
    description: 'Unused exports, unreachable branches, orphaned files, stale flags.',
    readOnly: true,
    appetite: 'medium',
    fanOut: true,
    prompt: `Hunt for dead code across the repository: unused exports and functions, unreachable branches, orphaned files that nothing imports, commented-out blocks, and stale feature flags or config that no longer gates anything. Fan out parallel subagents by directory/subsystem so the whole tree is checked concurrently, then merge the results. For each candidate, give the location, your confidence that it is truly dead (accounting for dynamic imports, reflection, string-keyed lookups, public API surface, and test-only usage), and the blast radius of removing it. Separate high-confidence removals from "looks unused but verify" items. Do not delete anything — this is a report only. Rank by confidence × cleanup value.`,
  },
  {
    id: 'performance-audit',
    title: 'Performance audit',
    description: 'Hot-path inefficiencies, N+1s, unbounded caches, quadratic loops.',
    readOnly: true,
    appetite: 'medium',
    fanOut: true,
    prompt: `Audit the codebase for performance problems that would actually bite in production: N+1 query patterns, blocking or synchronous calls on hot paths, accidentally-quadratic loops, unbounded caches or memory growth, repeated expensive work that could be memoized, and chatty I/O that could be batched. Fan out parallel subagents by subsystem and run them concurrently, then merge. For each finding, cite the specific code, explain the mechanism and the conditions under which it degrades (scale, input shape, concurrency), estimate the impact, and propose a concrete fix. Prefer evidence from the code over speculation; skip micro-optimizations that a profiler would never surface. Rank by expected real-world impact.`,
  },
  {
    id: 'error-handling-review',
    title: 'Error-handling & logging review',
    description: 'Swallowed exceptions, empty catches, missing propagation, leaky logs.',
    readOnly: true,
    appetite: 'medium',
    fanOut: true,
    prompt: `Review error handling and logging discipline across the repository. Fan out parallel subagents by subsystem and run them concurrently to find: swallowed exceptions and empty catch blocks, errors that are logged but not propagated (or propagated but not logged), overly broad catches that hide real failures, missing handling around I/O and external calls, retries without backoff or bounds, and logs that leak secrets or personal data. For each finding, give the location, describe what breaks or gets masked when it fires, and propose the correct handling. Note any place where a failure would fail silently — those rank highest. Merge, de-duplicate, and rank by severity.`,
  },
  {
    id: 'dependency-audit',
    title: 'Dependency audit',
    description: 'Outdated deps, breaking changes, security fixes, upgrade effort.',
    readOnly: true,
    appetite: 'small',
    fanOut: false,
    prompt: `Audit this project's third-party dependencies. Read the manifest/lockfiles to list direct dependencies, compare each against its current latest release, and for the meaningfully outdated ones summarize what changed between our version and latest: breaking changes, notable security fixes, and deprecations. For each, estimate upgrade effort (drop-in vs. code changes required) and flag anything that is a security concern or is unmaintained/abandoned. Produce a prioritized upgrade plan: which to bump now (safe/security), which to schedule (breaking but worthwhile), and which to leave. Do not modify any files — report only.`,
  },
  {
    id: 'docs-drift-check',
    title: 'Documentation drift check',
    description: 'Discover every doc surface, then compare its claims against the actual code.',
    readOnly: true,
    appetite: 'medium',
    fanOut: false,
    prompt: `Check the project's documentation for drift against the real code. FIRST discover where documentation actually lives for THIS project rather than assuming a fixed layout — map every documentation surface you can reach: the README, a docs/ tree, agent-onboarding files (CLAUDE.md / AGENTS.md), agent skills and command definitions (e.g. .claude/, .cursor/), a wiki, changelogs, inline API docs / docstrings / JSDoc, meaningful code comments, and any external support, marketing, or docs site linked from the README or package metadata (follow those links and read them, but never edit anything outside this repository). Then verify their concrete claims against the codebase: commands that no longer exist or have changed flags, described file/module layout that has moved, configuration keys and defaults that are stale, features documented but removed (or present but undocumented), and setup steps that would no longer work. List every stale or wrong statement with the doc surface + location, the claim, and what the code actually does now. Rank by how badly each would mislead a new contributor or user. Report only — do not edit any docs.`,
  },
  {
    id: 'codebase-explainer',
    title: 'Explain this codebase',
    description: 'Wiki-style architecture deep-dive, one subagent per subsystem.',
    readOnly: true,
    appetite: 'large',
    fanOut: true,
    prompt: `Produce a wiki-style architecture deep-dive of this codebase aimed at a senior engineer joining the project. First map the top-level structure and identify the major subsystems. Then fan out parallel subagents, one per subsystem, each producing a focused section: what the subsystem is responsible for, its key modules/files and their roles, the important data types and flows, how it talks to the other subsystems, and the non-obvious gotchas or invariants someone must know before changing it. Merge the sections into one coherent document with a top-level overview, an architecture summary (how the pieces fit and where the main data flows run), and the per-subsystem sections. Favor accurate, code-grounded explanation over hand-waving; call out anything surprising or fragile.`,
  },
  {
    id: 'prompt-designer',
    title: 'Design spare-token prompts for this repo',
    description: 'Meta: scan the codebase and search the web to propose repo-specific maintenance prompts.',
    readOnly: true,
    appetite: 'medium',
    fanOut: true,
    prompt: `Design a set of repo-specific autonomous maintenance prompts for this repository — tasks worth running unattended on spare capacity. Work from two directions in parallel: (1) fan out subagents to scan the codebase for where spare effort would pay off most — weak spots in test coverage, debt hotspots, drift-prone docs, recurring chores visible in git history, stack-specific risks (framework majors pending, deprecated APIs in use), and anything this project uniquely needs; (2) search the web for maintenance-task ideas, audits, and agent-automation patterns specific to this exact stack and domain (frameworks, languages, and tooling you find in the manifests). Then synthesize 5–10 proposed prompts tailored to this repo. For each: a short title, the full ready-to-run prompt body (self-contained, review-shaped: severity-ranked findings or a small reviewable diff, no questions, nothing pushed outside the repo), whether it is read-only or produces a diff, a rough token appetite, why it fits THIS repository specifically, and how often it is worth re-running. Avoid generic tasks a stock library already covers (refactoring audit, security review, dead-code hunt, coverage gaps, dependency audit, docs drift) unless you can make them meaningfully repo-specific. Rank the proposals by expected value.`,
  },
  {
    id: 'feature-brainstorm',
    title: 'Feature brainstorm',
    description: 'Scan the product and search the web for new feature ideas; writes a doc to docs/.',
    readOnly: true,
    appetite: 'large',
    fanOut: true,
    prompt: `Brainstorm new features for this product. First scan the codebase (README, docs, main UI/entry points) to build an accurate picture of what the product does today, who it serves, and what its existing strengths are. Then fan out parallel subagents: some searching the web for what users in this product's domain ask for and complain about (forums, Reddit, GitHub issues of similar tools, reviews), some exploring adjacent product categories for transplantable ideas, and some mining the codebase itself for underused capabilities that could be extended into features. Synthesize 10-20 feature ideas ranked by expected value: for each give a name, a short pitch, why it fits this product specifically, rough implementation effort given the existing architecture (name the modules it would touch), and any evidence of demand you found. Write the full brainstorm as a new markdown file under docs/ (e.g. docs/feature-brainstorm-<year>-<month>.md — never overwrite an existing file), and end with a short summary of the top 5 ideas in your final message. You may only create new markdown files under docs/; never modify existing files or source code.`,
  },
  {
    id: 'competitive-landscape',
    title: 'Competitive landscape',
    description: 'Research what competing tools are shipping; gap analysis; writes a doc to docs/.',
    readOnly: true,
    appetite: 'large',
    fanOut: true,
    prompt: `Map the competitive landscape for this product. Scan the codebase and docs to pin down exactly what the product is and its distinctive capabilities, then fan out parallel subagents to research the web: identify the closest competing and adjacent tools, and for each dig into what they are shipping right now (changelogs, release notes, launch posts, roadmaps, pricing pages) and what their users praise or complain about. Produce a gap analysis: features competitors have that this product lacks (ranked by how much they matter), features this product has that competitors lack (worth emphasizing or building on), and emerging trends across the space that nobody has fully captured yet. Be concrete and cite sources with URLs. Write the full analysis as a new markdown file under docs/ (e.g. docs/competitive-landscape-<year>-<month>.md — never overwrite an existing file), and end with the top takeaways in your final message. You may only create new markdown files under docs/; never modify existing files or source code.`,
  },
  {
    id: 'stack-radar',
    title: 'Tech-stack radar',
    description: 'Research ecosystem developments relevant to this stack; writes a doc to docs/.',
    readOnly: true,
    appetite: 'medium',
    fanOut: true,
    prompt: `Research what is happening in this project's technology ecosystem and what is worth adopting. Read the manifests and key config to establish the exact stack (languages, frameworks, major libraries and their versions), then fan out parallel subagents to search the web per area: significant releases and upcoming majors for the frameworks in use, notable new libraries or tools the community is converging on for problems this codebase solves by hand, deprecations or ecosystem shifts that will eventually force a move, and relevant performance/security developments. For each finding, assess concrete relevance to THIS codebase (name the modules affected), adoption effort, and urgency (act now / watch / ignore), and skip generic news with no bearing on the code. Write the full radar as a new markdown file under docs/ (e.g. docs/stack-radar-<year>-<month>.md — never overwrite an existing file), and end with the act-now items in your final message. You may only create new markdown files under docs/; never modify existing files or source code.`,
  },
  {
    id: 'tests-for-riskiest-module',
    title: 'Tests for the riskiest untested module',
    description: 'Write behavior-focused tests for the highest-risk gap (no source edits).',
    readOnly: false,
    appetite: 'large',
    fanOut: false,
    prompt: `Find the single highest-risk module in this repository that lacks adequate tests — weight by blast radius (what breaks if it regresses) and by how much untested logic/branching it contains — and write a focused test suite for it. Match the project's existing test framework, style, and conventions exactly. Write behavior-focused tests that assert intended behavior and contracts (inputs → outputs, error cases, edge cases, invariants), NOT the current implementation details — the goal is to catch real regressions, not to freeze today's code. Do NOT modify any source files in this run: if a piece is genuinely untestable without a source change, note it in your summary and skip it rather than editing it. Run the tests and make sure the entire suite passes before finishing. In your final message, summarize which module you chose and why, what behaviors you covered, and any gaps you deliberately left.`,
  },
];
