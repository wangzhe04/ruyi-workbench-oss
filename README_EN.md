# Ruyi (如意) · A Local AI Workbench

<img src="docs/branding/ruyi-mark.svg" alt="Ruyi" width="72" align="right" />

[简体中文](README.md) · **English**

> **Turn "chatting with a model" into "having the model get the job done" — on your own Windows PC, offline if you like, with every step visible and every step reversible.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Windows e2e](https://github.com/wangzhe04/ruyi-workbench-oss/actions/workflows/e2e.yml/badge.svg?branch=master)](https://github.com/wangzhe04/ruyi-workbench-oss/actions/workflows/e2e.yml)
[![Offline e2e](https://img.shields.io/badge/offline%20e2e-444-success.svg)](./dev-harness)
[![Zero npm deps](https://img.shields.io/badge/npm%20runtime%20deps-0-orange.svg)](./ruyi-workbench/app/server.js)
[![Third-Party Notices](https://img.shields.io/badge/third--party-notices-informational.svg)](./THIRD-PARTY-NOTICES.md)

**Ruyi** is a clean-room, local AI workbench for Windows. Give it a model it can reach — any OpenAI-compatible endpoint (a cloud API, an on-prem vLLM, a local Ollama or LM Studio) or a locally installed Claude Code / Kimi Code CLI — and it **actually does the work on your machine**: reads and writes files, runs scripts, drives Office and the desktop, and dispatches teams of sub-agents. A **steward** keeps watch over everything in flight.

> **Current release: 3.0 Preview `v3.0.0-preview.2`** (2026-09-25, GitHub pre-release). Features are frozen and the full automated regression plus offline-package smoke tests pass. The human sign-offs — an independent security red-team review, real screen-reader and human-factors walkthroughs — remain before 3.0 final (see [doc 55](docs/optimization-plan/55-release-3.0-preview.md)). The last full Release is `v2.6.2`; the 2.7.0 and 2.8.0 changes ship as part of this preview. Everything is in the [CHANGELOG](CHANGELOG.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero-dark.png" />
  <img src="docs/screenshots/hero-light.png" alt="Ruyi's workbench view: one sentence has the AI read a CSV and write a report; the answer has a findings table and the side pane lists the file change, which can be undone" />
</picture>

<sub>▲ The workbench view: one sentence asks the AI to read `sales.csv` in the workspace folder and write the report to `report.md`. The answer carries a findings table, the write only happened after you allowed it, and the "Changes" tab on the right undoes it one change or one turn at a time. (The screenshots show the Chinese interface; the whole UI is also available in English.)</sub>

## Contents

- [Get started in three steps](#get-started-in-three-steps) · [What to say first](#what-to-say-first)
- [What Ruyi is](#what-ruyi-is) · [Who it is for](#who-it-is-for) · [Design principles](#design-principles)
- [Two views: steward and workbench](#two-views-steward-and-workbench)
- [Let the AI act — and still take it back](#let-the-ai-act--and-still-take-it-back)
- [Capabilities (current master)](#capabilities-current-master)
- Features in depth: [Engines and models](#1-engines-and-models) · [Native tools](#2-native-tools) · [Multi-agent orchestration](#3-multi-agent-orchestration) · [The steward](#4-the-steward) · [Scheduled tasks](#5-scheduled-tasks) · [Desktop and Office](#6-desktop-and-office-acc-optional) · [Voice input](#7-voice-input) · [Skills, memory and Playbooks](#8-skills-memory-and-playbooks) · [Migration center](#9-migration-center) · [Web search](#10-web-search) · [Usage and cost](#11-usage-and-cost) · [Long sessions](#12-long-sessions-and-context) · [Interface](#13-interface-language-and-keyboard) · [Extensions](#14-extensions-mcp-connectors-and-ruyi-toolbox)
- [How Ruyi compares](#how-ruyi-compares)
- [Deployment: offline packages, intranets and running from source](#deployment-offline-packages-intranets-and-running-from-source) · [Upgrading](#upgrading) · [Data and configuration](#data-directory-and-configuration)
- [FAQ](#faq)
- [Repository layout](#repository-layout) · [Development and testing](#development-and-testing) · [Documentation](#documentation)
- [Security, privacy and clean-room](#security-privacy-and-clean-room) · [Contributing](#contributing) · [License](#license)

---

## Get started in three steps

**No coding and no command line required.** Once you have a release package (the Full or Slim `Ruyi-<version>-*.zip`):

1. **Extract the whole ZIP first** — do not run anything from the ZIP preview. A short path such as `C:\Ruyi` is recommended; if the extractor complains about long paths, do not choose "Skip".
2. **Double-click `Start-Workbench.cmd`.** The package ships its own Node runtime, so there is nothing to install. With the desktop shell `RuyiDesktop.exe` present it opens in its own window; otherwise it opens in your browser.
3. **Follow the welcome wizard**: language → connect a model → pick a workspace folder → pick a safety level (→ pick the steward's model). About five minutes, with plain-language guidance and on-the-spot checks at every step.
   - **Local models**: install Ollama or LM Studio, pull a model, and choose it in the wizard — no key needed.
   - **Cloud or on-prem endpoints**: enter the Base URL and API key your provider gave you and press "Test connection".
   - **CLI engines**: if Claude Code or Kimi Code is installed, the wizard detects it.

You can skip the wizard and reopen it any time from **Help** in the lower-left corner, which also holds the manual, the health check and the logs — no digging through folders.

### What to say first

Talk to it the way you would brief a colleague: what you want, where it is, and what the result should look like.

- "Analyse `sales.csv` in the workspace folder, give me three findings, and write the full report as Markdown."
- "Sort the installers, invoices and contracts in my Downloads folder into three folders; leave everything else alone."
- "Every Monday at 9 am, turn last week's new files into a list of material for my weekly report." (Hand this to the steward; it creates a scheduled task.)
- "Do a deep-dive on vector databases for our use case, with sources." (This triggers multi-agent orchestration on its own.)

When information is missing, the AI shows you a question card instead of guessing.

---

## What Ruyi is

Most AI tools fall into one of three camps: cloud chat apps (they can only talk), coding CLI agents (made for programmers), and cloud automation agents (they live on someone else's server). Ruyi takes the spot none of them hold: **on your machine, actually doing things, reversible, and safe for people who do not write code**.

| | |
|---|---|
| **One file, zero dependencies** | The backend runtime is a single `app/server.js` (about 63k lines, concatenated from 66 ordered modules in `app/src/`, byte-reproducible) with **zero npm runtime dependencies** — Node built-ins only. The frontend is 61 framework-free ES modules with no build step. The audit surface for an intranet security review is as small as it gets. |
| **107 native tools · 108 ACC tools** | 65 tools available to threads (files, terminal, search, Git, web, Office hand-off, sub-agent orchestration) plus 42 steward-only tools; the optional ACC desktop-control component adds 108 more (screenshot, OCR, UIA, keyboard and mouse, windows, browser, Office, PDF). |
| **8 templates · 10 roles · tested** | 8 built-in multi-agent workflows and 10 node roles. The repository contains **453 e2e cases** (446 in the default regression; 7 live probes that need a real API or desktop are opt-in), plus 173 unit suites and 23 ACC smoke groups, run on Windows CI for every change. |

> Formerly **Win Claude Workbench**, renamed **Ruyi** at v0.8 — partly for trademark caution, partly because an old system prompt made provider models introduce themselves as "Claude". *Ruyi* (如意) means "as you wish"; the mark is a blue-and-white *ruyi* cloud motif.

### Who it is for

- **Knowledge workers who do not code**: tidy folders, merge Excel workbooks, OCR scans, summarise PDFs, draft weekly reports, outline presentations, get reminded on time. Simple mode replaces jargon with plain language, and common jobs are one-click task cards.
- **Power users doing engineering work**: run scripts, review code, hunt bugs, run multi-agent research and technology selection, design workflows visually, bring your own MCP servers and CLI engines.
- **Teams with intranet and compliance requirements**: works fully offline, model endpoints can point only at internal services, a single dependency-free backend and a build-free frontend keep the audit surface small, and there is zero telemetry.

### Design principles

- **Offline first**: it runs with or without internet; online abilities (search, fetching) degrade visibly when offline instead of pretending.
- **Reversible**: every write has a checkpoint, and conversation and files roll back together; anything that cannot be undone says so when it asks for approval.
- **Honest**: "done" is claimed only on a receipt, cost is estimated only from prices you entered and labelled as not an invoice, and failure reasons come from the workbench's own table rather than the model's imagination.
- **You decide**: high-risk actions always ask first; once the steward has read external content it can only propose, not act.
- **Bilingual**: the interface, prompt packs, built-in skills and quick tasks all exist in Chinese and English and load with the interface language.

---

## Two views: steward and workbench

One workbench, two views, switched with a segmented button in the top bar; the thread list on the left is shared. New installs start in the steward view.

![The steward view: threads grouped by "Waiting on you" and "Wrapped up today" on the left, the conversation with the steward in the middle, and the selected thread's pending decision on the right](docs/screenshots/steward-home.png)

<sub>▲ The steward view: threads are grouped by "waiting on you" and "wrapped up today"; ask the steward "how are these going?" and it answers thread by thread; the right pane shows the thread waiting for your go-ahead, with Allow / Deny right there.</sub>

**The steward view** is a conversation: tell it what you want, and it opens a thread to do it (or hands it to an existing thread) and reports back when it is done.

- The left pane groups threads by state (waiting on you / running / wrapped up today …) and the top bar counts how many are running and how many are waiting on you. The right pane shows the selected thread: what it is waiting for, Allow / Deny buttons, its permission / model / engine, and a box to talk to that thread directly without going through the steward.
- The steward speaks up only when it should: trouble in another thread shows a "quiet card" that does not steal focus, question pop-ups never interrupt you while you are typing, and every pending decision gathers in the "Waiting for you" tray.
- "Up next" at the bottom of the right pane lists the scheduled tasks about to fire.

**The workbench view** is the classic three-pane layout:

| Area | What is there |
|---|---|
| Left pane | Thread list (search, pin, rename, grouping), "Start a task", and entries for scheduled tasks, action log, what it remembers about you, and health · usage |
| Thread header | Thread name, workspace folder, state, "hand to the steward", and this thread's own **permission / model / engine** (affecting only this thread), plus the context meter |
| Middle | Conversation and Crew (the live multi-agent canvas); under each answer: the turn record (tool calls), the turn's file changes (undoable) and the turn's usage |
| Composer | Agent-team toggle, skills, attachments, voice; while a turn runs you can steer it or stop it |
| Right pane, seven tabs | Files (workspace tree, safe preview on click) · Artifacts · Changes (reversible file changes) · Memory · Agent workflows · Usage · Records (the audit timeline) |

---

## Let the AI act — and still take it back

Letting the AI act only works if you can undo what it did:

![A permission request: the model wants to move an installer into a new folder; the dialog says the action can be undone in one click and offers Deny, Allow or Later](docs/screenshots/permission-approval.png)

**Five safety levels** (switch any time from the shield button in the top bar; switching does not interrupt a running turn):

| Level | Behaviour | When to use it |
|---|---|---|
| **Ask me every step** (default) | Asks before editing files or running commands; reads are not asked | When you are getting started or handling important files |
| **Auto-apply small edits** | File edits run automatically; commands and other sensitive actions still ask | You trust its file edits but not free-running commands |
| **Plan first** | Shows a complete plan and only acts after you approve it | Complex jobs where you want to see the approach first |
| **Smart auto** | The AI judges risk: low-risk actions run, high-risk ones still ask | Everyday work the steward looks after (switching asks for confirmation) |
| **Full auto** | Never asks (shown with a warning style) | Only when you fully understand the task and it is safe (switching asks for confirmation) |

- **Three tool tiers**: read / edit / exec. Exec-tier actions can **never be allowed persistently**; read and edit tiers can be set to "allow for this thread".
- **Threads can only tighten**: threads the steward opens get their own default level; a single thread can be tighter than the global level, never looser.
- **File checkpoints**: before any write, edit, delete, move, copy, unzip or download, the "before" state goes into a checkpoint journal. Undo one change or roll back a whole turn; code tasks also take a workspace baseline at the start of a turn, so changes that bypass the file tools (a script writing files, say) are caught too. Anything that cannot be undone automatically (commands, very large files) says so on the approval dialog.
- **Conversation rewind**: rewind a thread to any earlier turn and optionally roll back the file changes made after it — conversation and files go back together, not just the chat history.
- **Audit timeline**: every turn, tool call and permission decision goes into an NDJSON audit log, filterable by source and type in the "Records" tab; secrets are redacted before anything reaches the UI.
- **Receipts only**: completion claims such as "scheduled / sent / created" are driven solely by handler receipts; without a receipt it says plainly "I started it but got no receipt".
- **Autonomy grants**: when you want a stretch of uninterrupted work, issue a temporary grant from the local UI that is narrower than the current permission — file paths, command prefixes, network access, count and expiry can all be limited — and revoke it any time. There is no "all tools, whole workspace, unlimited" preset.
- **Steward approvals have hard limits**: the steward approves on your behalf only in Smart auto, only for threads it looks after or that a scheduled task opened, and only when all ten gates pass. **Sending anything outside, paying, uninstalling, changing system settings or formatting a disk always needs your own click.**
- **Local hardening**: the server listens on `127.0.0.1` only; the page credential is handed over by a handshake rather than embedded in HTML; a Host allowlist blocks DNS rebinding; network tools refuse private and loopback addresses (SSRF); keys, sessions and audit files in the data directory are denied to the file tools in both directions (including junction and short-name tricks); secrets in API responses are masked. See [SECURITY.md](./SECURITY.md) for the threat model.

---

## Capabilities (current master)

| Capability | Summary | More |
|---|---|---|
| **Engines: any model endpoint** | OpenAI-compatible endpoints (Chat Completions or Responses API) and Anthropic Messages endpoints (Anthropic itself or a compatible gateway), with no bundled vendor presets; local Ollama / LM Studio need no key; Claude Code or Kimi Code as Agent CLIs; switch engines mid-thread and keep the context | [§1](#1-engines-and-models) |
| **Native tool loop** | **107 native built-in tools** with read / edit / exec approval tiers, on-demand tool loading, batching of independent calls and staging of dependent ones | [§2](#2-native-tools) |
| **Structured questions** | Single choice, multiple choice, free text, "choices + other"; the card closes only once the answer reached the model | [§1](#1-engines-and-models) |
| **Multi-agent orchestration** | 8 templates, 10 roles, 5 quality gates, conditions and loops, resource leases, worktree isolation, a graphical editor and live canvas; team mode; background sub-agents | [§3](#3-multi-agent-orchestration) |
| **The steward** | Five thread states, a "waiting for you" queue, quiet cards, persona and voice, memory with expiry and scope, 124 changeable settings, propose-only after reading external content | [§4](#4-the-steward) |
| **Scheduled tasks** | Once / daily / weekly / monthly / cron; remind only or run a turn; honest handling of missed runs | [§5](#5-scheduled-tasks) |
| **Desktop and Office** | Optional ACC v1.9.1: 108 tools, OCR + UIA text grounding so text-only models can drive the desktop; Word / Excel / PowerPoint / PDF | [§6](#6-desktop-and-office-acc-optional) |
| **Voice input** | Text appears as you speak and each sentence is corrected when you pause; local components or cloud models | [§7](#7-voice-input) |
| **Skills / memory / Playbooks** | 20 built-in skills in a four-source library; draft-then-confirm workbench memory; 16 built-in Playbooks | [§8](#8-skills-memory-and-playbooks) |
| **Migration center** | Imports global instructions, MCP servers and plugin skills from Claude Code, Codex and Kimi; migrates older Ruyi installs | [§9](#9-migration-center) |
| **Web search** | Zero-config built-in search plus six optional backends; fetching with SSRF defenses and an offline cache | [§10](#10-web-search) |
| **Usage and cost** | Per-currency, per-call accounting, honest estimates, every path metered, monthly budget alerts | [§11](#11-usage-and-cost) |
| **Long sessions** | Tiered compaction, observation shrinking with on-demand recall, session notes, a context meter | [§12](#12-long-sessions-and-context) |
| **Interface and language** | Chinese / English / follow system, dark / light / follow system, expert and simple modes, Mermaid diagrams, command palette | [§13](#13-interface-language-and-keyboard) |
| **Extensions** | Drop-in MCP connectors; ruyi-toolbox components discovered automatically | [§14](#14-extensions-mcp-connectors-and-ruyi-toolbox) |

---

## Features in depth

### 1. Engines and models

- **OpenAI-compatible endpoints (the native engine)**: direct HTTP + SSE streaming with a full native tool loop. Choose Chat Completions, the Responses API (server-side tool loop) or Anthropic Messages (Anthropic itself and Anthropic-compatible gateways; signed thinking blocks are passed back unchanged within a tool loop); main turns, sub-agents, summaries and Playbook drafting all follow the chosen protocol. **No vendor presets are bundled**: enter the Base URL and key your provider gives you (a cloud API, a one-api gateway, an on-prem vLLM); local Ollama / LM Studio need no key. Configure as many providers as you like, each with its own model list, prices, cache-hit prices and request headers.
- **Agent CLIs**: choose **Claude Code** or **Kimi Code**. Claude Code supports live streaming, interactive steering, permission bridging, native agents and per-turn MCP configuration, and can target third-party Anthropic-compatible endpoints (Coding Plans); Kimi Code is driven through its official ACP protocol (see the compatibility limits below). Both receive a "Ruyi environment briefing" describing which Ruyi tools exist, how the UI renders things and how permissions work.
- **Model assignment**: one settings page decides which model does what — the main conversation model, the default engine for new threads (last used / follow global), the steward, the strong and fast tiers, sub-agents, context compaction and voice correction. Changes save immediately; "follow" means the row is not set separately.
- **Cross-engine continuation**: switch a thread from an endpoint to Claude Code or back and the history is grafted over; the context carries on. Switching on the thread header affects only that thread.
- **Structured questions**: both engines share one `request_user_input` channel with single choice, multiple choice, free text and "choices + other", stable option IDs and descriptions; the card closes only once the answer is confirmed delivered, and questions from background threads surface right away.
- **Plan mode**: a plan first, action only after you approve (a real flow in the provider engine, not prompt decoration).
- **Capability matrix**: vision, reasoning traces and tool calling are probed and labelled per endpoint, so the UI tells you what is missing.

<details>
<summary><b>Kimi Code compatibility limits</b></summary>

Kimi Code is driven through its official ACP (JSON-RPC / NDJSON). Native tool events, Ruyi's permission approvals, native plan snapshots (read-only, updated in place by `planId`) and structured questions are bridged into Ruyi's UI, and context usage and native compaction read Kimi's own authoritative state. Capabilities follow the ACP shapes: `request_permission` is single-select and `elicitation/form` supports multiple choice; not every native question shape is claimed to support multi-select. The ACP child process currently closes when a prompt ends, so cross-turn Goal / Cron / background-task continuity is **not claimed as complete**. A compatibility patch for npm-installed Kimi Code 0.37.2 is enabled only on an exact match and never rewrites your installation; unknown layouts and non-npm installs degrade explicitly. `dev-harness/kimi-acp-live-probe.js` exercises a real Kimi CLI against a local simulated model, with no credentials.
</details>

### 2. Native tools

All tools are implemented with Node built-ins (zero dependencies). 65 are available to threads and 42 are steward-only. Tool descriptions load on demand by task; when the model lacks a capability it searches the tool catalog and loads more, so simple questions no longer carry the whole tool set (an "all resident" mode remains in Settings). Independent calls with fixed arguments are batched into one model response; calls that depend on earlier results wait for the next stage.

| Category | Tools |
|---|---|
| Reading files | `file_read` · `file_list` · `file_search` · `glob` · `project_snapshot` · `audio_transcribe` |
| Writing files (checkpointed) | `file_write` · `file_edit` · `file_delete` · `file_move` · `file_copy` |
| Archives | `archive_zip` · `archive_unzip` (Zip-Slip safe) |
| Terminal and scripts | `powershell_run` · `script_run` (temporary PowerShell / Python / Node scripts) · persistent terminals `shell_start` / `shell_send` / `shell_poll` / `shell_kill` / `shell_list` |
| Desktop and Office hand-off | `desktop_screenshot` · `keyboard_send_keys` · `office_open` |
| Web | `web_search` · `web_fetch` · `http_request` · `http_download` · `browser_open` |
| Code and projects | `git_status` / `git_diff` / `git_log` / `git_commit` · `dependency_inventory` · `code_review_scan` · `frontend_audit` · `claude_md_audit` · `docs_search` · `codebase_symbol_search` · `debug_hypothesis` · `data_profile` |
| Sub-agents | `orchestrate_agents` (a single agent goes through it too) · `wait_agents` · `agent_result` (fetch a sub-agent's full output on demand) · `spawn_agent` (kept for older sessions) |
| Planning and interaction | `request_user_input` · `todo_write` (drives the UI step list) · `mission_update` (the task ledger) · `permission_prompt` · `workbench_self_status` |
| Memory | `workbench_memory_list` / `_read` / `_propose` / `_revise` plus relation proposals and revocation · `observation_recall` (recall the original of a shrunk tool result) |
| Tool catalog | `list_tools` · `tool_search` · `tool_load` · `tool_invoke_read` / `_edit` / `_exec` (tiered proxy calls to hidden tools) |
| Skills and integrations | `skill_read` · `mcp_list` · `mcp_configure` (changes MCP configuration behind an exec-tier confirmation) |

External MCP tools (desktop control, drop-in connectors) are **bridged** into the same loop and go through the same tiered approvals.

### 3. Multi-agent orchestration

Say "do a deep-dive on …" and Ruyi dispatches a team of specialised sub-agents and draws the collaboration live on the Crew canvas: who is running, how far they got, where they are stuck. When a conversation shows research / audit / debugging / selection / documentation intent, both engines receive the template list and the capability tiers of the available models, start the orchestration themselves and **assign models by node difficulty** — fast models for retrieval and bulk nodes, strong models for verification, synthesis and quality gates — with a guard against templating trivial tasks. The composer's "Agent team" toggle forces multi-agent for one turn (matching a template first, or designing a minimal DAG).

**8 built-in templates** (node counts can be changed in the editor):

| Template | Shape | Good for |
|---|---|---|
| Deep research → verify → synthesis | Decompose → facts / context lenses in parallel → adversarial verification → cited synthesis | Research whose conclusions must be reliable and traceable |
| Code audit | Map the codebase → correctness / security / quality in parallel → verify → fix plan | Taking over an unfamiliar codebase, pre-release check-ups |
| Implement → independent review → targeted fix → acceptance | Fix only if review fails, then independent acceptance | Development tasks with clear acceptance criteria |
| Bug hunt | Reproduce → two hypotheses in parallel → verify → root-cause fix | Stubborn bugs |
| Requirements → options → selection → plan | Three approaches in parallel → weighted comparison → actionable checklist | Technology selection, architecture decisions |
| Document from scratch | Outline → sections in parallel → fact check → final edit | Long documents |
| Data insights | Explore → plan → multi-angle analysis → verify → insights | Data analysis and reports |
| Debate → judgement | For and against in parallel → cross-examined verdict | Contentious decisions |

**10 node roles** (each with its own prompt, tool tier, budget and colour):

| Role | Does | Tool tier |
|---|---|---|
| Explorer | Quickly explores code, docs and the current state without changing files | read |
| Planner | Breaks complex tasks into a plan or design; does not implement | read |
| Researcher | Searches the web and reads sources; produces sourced findings | read |
| Analyst | Analyses data, logs and metrics, running scripts where needed | exec |
| Worker | Implements a clearly specified change and does basic verification | exec |
| Coder | Closes the loop on implementation, debugging and tests | exec |
| Reviewer | Independently reviews correctness, security and regression risk | read |
| Verifier | Runs tests and verifies results without changing product code | exec |
| Critic | Adversarial review: hunts for holes, counterexamples and unsupported claims | read |
| Synthesizer | Combines several upstream results into one structured write-up | read |

**Orchestration primitives**: per-node engine / model assignment · dependency edges · conditional execution (fix only if review fails) · loops (until a condition holds, with anti-spin) · failure policies (block / continue / retry) · dependency policies (all succeed / all settle) · resource leases (no deadlocks) · Git worktree isolation (parallel file edits without collisions) · structured-output schemas · **5 quality gates**: review / verify / vote (quorum) / cross_review / dedupe — vote and dedupe are deterministic and cost no tokens.

**Sub-agents, new mode**: a sub-agent's tool calls and compaction stay on its own card; the main conversation receives a compact delivery envelope (conclusion, output files, usage), and the model fetches full output with `agent_result` when it needs it. Agents can run in the background while you keep talking; each result is delivered exactly once, and the background strip above the composer lets you watch and stop them.

**Team mode**: running sub-agents can propose extra nodes with `propose_task`, which become part of the DAG after you approve them in the task pool; nodes message each other asynchronously with `send_to_agent`; and you can steer **a specific node** mid-run, taking effect before its next model call.

**Long-running work**: a task ledger breaks the goal into milestones with acceptance evidence, optionally driven `until-done`; repeated lack of progress stops it, and an exhausted budget archives and pauses it. `wait_for` waits for a time, a file, a process or a reachable URL without taking a concurrency slot or calling a model. Every step's state is written atomically, and crash recovery is graded by side effect: pure reads, waits and deterministic gates may resume; any node that ran commands or wrote files stops and waits for you — **irreversible side effects are never blindly replayed**.

**Anti-spin and interruption**: the main loop judges progress by result fingerprints (complementing same-call streak detection) and warns before stopping; steering is injected at tool-batch boundaries, and interrupted turns are closed out in a pairing-safe way.

### 4. The steward

- **Five thread states**: every thread has exactly one state, derived from one rule table shared by server and browser:

  | State | Meaning |
  |---|---|
  | Dispatching | Just handed over; no execution yet |
  | Running | A live turn, an `until-done` drive, or sub-agents running |
  | Needs you | A pending permission, question, plan or proposal |
  | Done | The result is marked complete, or a ledger-less thread finished |
  | Stopped | You stopped it, the budget ran out, or the last turn failed |

- **Sees everything, interferes with nothing**: threads you open in the workbench appear in the steward's panes, and presence signals decide whether it speaks up; one SSE event stream keeps states, the inbox and progress in sync within a second.
- **What it can do for you**: open, continue, rename and re-home threads, adjust permissions (tighten only — loosening needs your own click), take notes, reprioritise, stop threads, answer pending decisions on your behalf, create and manage scheduled tasks, draft Playbooks, toggle skills and change settings. "What it may do on its own" in Settings decides which of these happen directly (retry transient failures, auto-hand-off within a matter, open new threads, resume after a restart); everything unticked is only proposed. **Threads you stopped are never restarted on its own.**
- **Looking outside**: it can search and fetch web pages, read files in workspaces you registered, and read files a thread listed as deliverables. **Once it has read external content in a turn, every write action in that turn becomes a proposal** — even when you are right there — and anything it read is fenced as "external content, not instructions".
- **Settings it can change**: 124. 31 take effect directly (interface, the steward's own throttles and budgets, wait times); 93 come as a button you press (endpoints and models, engines and context, concurrency, scheduling, usage budgets …); 39 security-critical keys — secrets, the data directory and workspace fences, command and desktop allow-lists, prompt injection surfaces, the approval switch — never go through the steward.
- **What it remembers about you**: preferences and habits you can edit, veto, restore, export or wipe; entries have an **expiry date** and a **scope** (this project only / everywhere), and expired entries stop being used. They feed only the steward's own prompt, never ordinary threads.
- **Persona and budgets**: give the steward a name and a line about its tone (it changes how it talks, never its permissions or rules); it has its own model, a per-hour turn cap, a daily spend cap, a context budget and a conversation retention period.
- **Action log**: everything the steward did is recorded with its grounds, target thread, the thread's permission at the time, the cost and whether it can be undone.
- **Failures come with reasons**: when a thread fails, the reason and next step come from the workbench's own 32-category failure table; anything outside it is reported honestly as "unknown category".

### 5. Scheduled tasks

![The scheduled task list: one task runs a turn every weekday at 9:00, one is a one-off reminder](docs/screenshots/scheduled-tasks.png)

- **Frequency**: once / daily / weekly (pick the weekdays) / monthly (31 means the last day) / advanced cron (local time).
- **What happens**: "just remind me" (no model call, no cost) or "have Ruyi run a turn" — in a new thread each time or continuing an existing one — with its own model tier (strong / fast / follow global) and permission.
- **Each task** can be paused and resumed, run now (with a confirmation, because it really starts a turn), inspected for its recent runs, and deleted; each gets its own working folder, so two tasks firing together never wait on each other's folder lock.
- **Missed runs are handled honestly**: missed during sleep or shutdown, it catches up once within the catch-up window and is marked "catch-up"; past the window it is marked "skipped" and you are told; a run that crashed mid-turn is recorded as "outcome unknown — check first", neither counted as a success nor blindly resent.
- "Later" on a quiet card really schedules a one-off reminder N minutes out. With no tasks there is zero polling and zero overhead.

### 6. Desktop and Office (ACC, optional)

`mcp/ai-computer-control/` is the desktop-control MCP bundled with the Full package (**ACC v1.9.1**, 108 tools; source installs need Python ≥ 3.12). Once installed, the workbench detects it and offers it to both engines.

- **See**: full-screen / region / window screenshots, OCR with text location, the UIA control tree, template matching.
- **Act**: mouse, keyboard, window management, launching and closing apps, the clipboard, dialog handling, macro record and replay.
- **Office**: read and write Word / Excel / PowerPoint / PDF; Excel styling and charts and PowerPoint generation use three built-in design systems, with CJK font discipline built in.
- **Key design**: **text grounding first** — OCR + UIA let text-only models click the right control, with vision as an enhancement; `observe` / `act_and_verify` turn "did that click work?" into something checkable; optional dependencies degrade gracefully; file changes are checkpointed; changing actions are audited automatically.
- **Browser**: URLs open in your own default browser with your logins by default — no hidden test browser — and the workbench's own tab is protected; Settings can switch to a specific browser, CDP attach, or an isolated test browser. Hardware-accelerated pages that expose only the frame to UIA are flagged, steering the AI to DOM, OCR or screenshot coordinates.
- **Conversational configuration**: when you explicitly ask to add, remove or toggle an MCP server or change the browser target, the AI reads a redacted inventory, explains the difference and writes configuration only after an exec-tier confirmation.

The Full offline package includes a verified CPython 3.12 runtime, wheel-only dependencies and a matching Chromium, so the target machine needs neither Python nor network access.

### 7. Voice input

- **Text as you speak**: every time you pause, the sentence you just said is transcribed into the composer while the microphone keeps recording; each sentence is finalised when you finish it. **Nothing is sent automatically.**
- **Sentence-end correction**: each finalised sentence is checked once more with a more accurate pass, and if the result differs it quietly replaces the sentence — only sentences you have not touched. Modes: auto (re-listen if possible, then let an LLM merge the two), re-listen only, LLM text fix only, or off. The LLM only sees that sentence's text and treats it as data ("translate this into English" gets corrected, never executed).
- **Where recognition comes from**: install `asr-stream` (sherpa-onnx streaming on CPU, with SenseVoice sentence recognition) and `asr-shim` (local Qwen3-ASR that picks the 1.7B or 0.6B model by free GPU memory) from [ruyi-toolbox](https://github.com/wangzhe04/ruyi-toolbox), and Ruyi discovers and wires them up at start-up; or mark a cloud model as speech-capable on its provider card and choose its interface type. Failures say what went wrong and where to fix it.

### 8. Skills, memory and Playbooks

- **Skill library**: four sources — 20 built-in skills (code review, document processing, spreadsheet analysis, structured writing, research and synthesis, Office automation, Windows desktop control, API debugging, security hardening, offline packaging, local CI checks, project-memory management and more), a user library (`skills/` in the data directory), a project library (`.ruyi/skills/`), and skills read from Claude Code / Codex / Kimi plugins. Enable a skill for the current thread or keep it resident globally (up to 8 each); the system prompt carries only a compact index and full text loads on demand — **both engines share the same skills**. Built-in commands keep their `/name` meaning under Claude Code and insert the same task template under a provider. The library's search box also takes a plain sentence ("anything that tidies meeting notes?").
- **Workbench memory**: personal experience, project conventions and lessons across threads, stored only after **the AI drafts and you confirm** — it never writes behind your back. Memory is grouped by project, fenced when injected and limited to the current project by default; vector recall is on by default. It complements the `CLAUDE.md` that travels with a code repository.
- **Playbooks (one-click tasks)**: save a task that went well as a Playbook — the AI drafts the steps and parameters, you confirm, and it becomes one click next time. 16 built in: archive files by content, batch rename, clean a CSV, clean up Downloads, compare two documents, open an app and operate it, build a folder inventory, tidy meeting minutes, merge Excel workbooks, OCR a scan, summarise PDFs, outline a presentation, summarise a folder on a schedule, translate a document, fill in a web form, draft a weekly report. Built-in templates are labelled by service type (research and comparison / material gathering / writing / code tasks / scheduled digests / change watching).

### 9. Migration center

- **Global instructions**: at start-up `~/.claude/CLAUDE.md` and the `AGENTS.md` files of Codex and Kimi are imported as Ruyi core memory and kept in sync with their sources; entries you edited are not overwritten, and the file that Claude Code / Kimi read natively is not injected twice.
- **MCP and skills**: MCP servers from Claude Code, Codex and Kimi are imported automatically, and skills are read from their plugins. Imported entries carry their origin, so something you deleted in the original tool is never written back.
- **Older Ruyi installs**: detected from paths in your configurations wherever they live, repointed to the new version with a backup and undo; deleting an old package only moves it to the Recycle Bin. The entry point is "Integrations & MCP" in Settings, and the first launch mentions it once.

### 10. Web search

- `web_search`: zero-config built-in search, or SearXNG / Bing / Brave / Tavily / Bocha / a custom backend, or off. DeepSeek's Responses protocol can run searches server-side, saving a local round-trip.
- `web_fetch`: extracts the main text (with redirect, timeout and size limits) and refuses private and loopback addresses; when offline or refused it falls back to the local cache, and the tool card shows "cached · fetched N days ago".
- Sub-agents and workflow nodes can use the web too (Researcher does by default); on restricted intranets they fall back to local material.

### 11. Usage and cost

- **Per-currency, per-call accounting** with no forced exchange rates; cost is estimated only when you entered prices for the provider, otherwise only tokens are shown, always labelled "equivalent estimate, not an actual charge"; plan-included usage is not counted as spend.
- **Every token-spending path is metered**: sub-agent turns, automatic and manual compaction, Playbook drafting, the steward, thread naming.
- Split by engine, provider and thread, for today / this week / this month / all time, with an optional monthly soft budget that warns without blocking.

### 12. Long sessions and context

- **Context meter**: the thread header shows used / maximum tokens live; the window is probed automatically and can be pinned by hand.
- **Tiered compaction**: past a threshold, old tool results are evaporated first, then summarised; summaries carry entity checks and a fact table, and recently read files are re-attached after a reseed. You can name a dedicated compaction model or compact manually.
- **Observation shrinking with on-demand recall**: large tool outputs shrink to summaries in context, and the model recalls the byte-identical original with `observation_recall` when needed; repeated reads within the history are de-duplicated.
- **Session notes**: the key points of long jobs are kept as external notes and re-injected after compaction, so the latest stretch is never lost.

### 13. Interface, language and keyboard

- **Language**: Simplified Chinese / English / follow system. The interface, prompt packs, built-in skills and quick tasks load in the interface language; content written by users and projects stays as written.
- **Theme**: dark / light / follow system. **Mode**: expert (full three panes) / simple (advanced items hidden, plain-language terms).
- **Rendering**: Markdown and code highlighting; ` ```mermaid ` blocks render as diagrams (full-screen zoom, SVG / PNG export).
- **Keyboard**: `Enter` sends · `Shift+Enter` new line · `Ctrl+K` command palette · `Ctrl+N` new thread · `Esc` stops the current turn or closes pop-ups one layer at a time · `?` shortcut help.
- **Desktop shell**: `RuyiDesktop.exe` (WinForms + WebView2) with rounded corners, taskbar semantics, edge resizing and smooth scrolling; without it Ruyi runs in the browser.
- **Notifications**: optional native system notifications for pending decisions while you are away (off by default, with quiet hours).

### 14. Extensions: MCP connectors and ruyi-toolbox

- **Drop-in connectors**: put any stdio MCP server in a folder under the package's `mcp/` or the data directory's `mcp/`, add a `ruyi-mcp.json` (`{id, command, args…}`), and restart — it registers itself; delete the folder to uninstall. Its tools are bridged to both engines through the same tiered approvals (`bridgedToolTiers` sets tiers for bridged tools). See [mcp/README_EN.md](mcp/README_EN.md).
- **ruyi-toolbox**: the [optional component repository](https://github.com/wangzhe04/ruyi-toolbox) for things that need heavy installs and that not everyone needs (such as local speech recognition). Installed components register in `~/.ruyi-toolbox/components/`; at start-up Ruyi scans it, starts services and wires them in as endpoints, and adds MCP servers to the connector list. The first hook-up is announced, and "Integrations & MCP" in Settings shows what is connected and lets you disable each one or turn discovery off. Commands come only from the registration files on disk, never through a shell; every launch is audited, and Ruyi reaps the processes it started when it exits.

---

## Screenshots

<table>
<tr>
<td width="50%"><img src="docs/screenshots/workflow-editor.png" alt="The graphical workflow editor: the deep-research template's node graph, with the inspector editing the verify node" /></td>
<td width="50%"><img src="docs/screenshots/settings-models.png" alt="Model assignment in Settings: which model handles the main conversation, the steward, the strong and fast tiers, sub-agents and compaction" /></td>
</tr>
<tr>
<td><b>Graphical workflow editor</b>: load the "deep research → verify → synthesis" template, drag nodes and draw arrows; the inspector sets each node's task, role, engine, model and quality gate.</td>
<td><b>Model assignment</b>: one table decides which model does what; changes save immediately.</td>
</tr>
</table>

<sub>The screenshots come from a local demo instance with a scripted model endpoint (canned answers); the interface, tool cards, permissions, checkpoints, scheduled tasks and usage accounting are the real features.</sub>

---

## How Ruyi compares

| | Cloud chat apps | Coding CLI agents | Cloud automation agents | **Ruyi** |
|---|---|---|---|---|
| Where it runs | Vendor servers | Local terminal | Vendor sandbox | **Your machine; data stays home** |
| Offline / intranet deployment | ✗ | Partly (model still online) | ✗ | **✓ endpoints can point at internal models** |
| Drives the local desktop and Office | Hardly | Weak | In a cloud VM | **✓ even with text-only models (OCR + UIA text grounding)** |
| Can you undo its mistakes? | No such concept | Via git | Hard | **✓ file checkpoints + conversation rewind, stated on the approval dialog** |
| Multi-agent collaboration | Black box | Mostly CLI output | Black box | **✓ graphical editor + live monitor** |
| Someone keeping watch | ✗ | ✗ | Partly | **✓ the steward: states, pending decisions and schedules in one place** |
| Cost transparency | Subscription | Partly | Subscription | **✓ per-currency, per-call accounting; never inflated** |
| Usable by non-programmers | ✓ (but only chats) | ✗ | ✓ (but not controllable) | **✓ simple mode, one-click tasks, plain language** |
| Deployment and audit cost | — | Needs the Node / Python ecosystem | — | **One dependency-free file; unzip and run offline** |

<details>
<summary><b>Harness-Bench-360 snapshot (2026-08-09, Escapade 2.5 era)</b></summary>

We extended the open-source [HarnessBench](https://github.com/Qihoo360/harness-bench) method (filesystem tasks, programmatic oracles, process traces and security evaluation) into HB360 and compared four harnesses on 106 real tasks with the same `deepseek-v4-flash` model:

| Harness | Outcome | Process | Security | Efficiency | O×P×S | O×P×S×E | Est. cost | Avg. time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Ruyi** | 77.2 | 98.1 | 100.0 | **65.1** | 75.7 | **49.6** | **$0.60** | 97s |
| Hermes Agent | **80.6** | **98.8** | 100.0 | 51.3 | **79.6** | 41.9 | $0.92 | 159s |
| Codex (WSL2) | 76.9 | 78.2 | 100.0 | 63.6 | 60.1 | 36.6 | $1.58 | **90s** |
| OpenClaw | 63.2 | 74.4 | 100.0 | 50.1 | 47.0 | 23.0 | $1.18 | 156s |

On the upstream O×P×S score Hermes leads with 79.6 and Ruyi follows with 75.7; with engineering efficiency included, Ruyi's Efficiency of 65.1 — the highest of the four — puts it first on O×P×S×E at 49.6, with the lowest estimated cost. The two combined scores answer different questions and are not directly comparable. This is a single-machine, single-model, single-run snapshot, not an official leaderboard; costs are normalised estimates, not invoices. The per-task raw results live in a separate benchmark project and are not published in this repository.
</details>

---

## Deployment: offline packages, intranets and running from source

**Offline packages (recommended)**: build on a connected Windows machine, copy into the intranet, extract and run.

| Command (inside `ruyi-workbench/`) | Result |
|---|---|
| `npm run package:offline` | **Full**: desktop control (ACC), CPython 3.12 and OCR, built from a verified cache (default) |
| `npm run package:offline:full:fresh` | Full, rebuilding the ACC runtime online |
| `npm run package:offline:slim` | **Slim**: without desktop control |
| `npm run build:desktop` | Build the `RuyiDesktop.exe` desktop shell |

The output lands in `dist\` and contains a Node runner, `Start-Workbench.cmd` and `README-START-HERE.txt` to read before extracting. A Full package verifies and registers ACC on first launch and uses a fast check afterwards; the bundled Python is preferred, with no dependence on the target's Python or earlier installs. A package named Full must pass every gate — CPython 3.12, importable OCR projections, all files in the SHA-256 manifest — or the packager refuses to build it. A single-file `Ruyi.exe` is also possible. See [Offline Deployment](ruyi-workbench/docs/OFFLINE_DEPLOYMENT_EN.md) and the [Administrator Guide](ruyi-workbench/docs/manuals/ADMIN-GUIDE_EN.md).

> The Full package contains deep Chromium and WinSDK folders: **extract the whole package to a short path** such as `C:\Ruyi`. If the extractor reports paths that are too long, do not choose "Skip" — ACC's integrity check would then reject the desktop-control component (the base workbench still starts and shows recovery steps).

**Intranets**: point the model endpoint at an internal vLLM / Ollama / one-api gateway, and switch search off or at an internal SearXNG. The workbench itself needs no outside access.

**From source** (developers): Windows 10/11 + Node.js ≥ 20; no `npm install` needed.

```powershell
git clone https://github.com/wangzhe04/ruyi-workbench-oss.git
cd ruyi-workbench-oss\ruyi-workbench
node .\app\server.js serve --open        # binds 127.0.0.1, default port 8765, moves on if taken
```

| Command | Purpose |
|---|---|
| `node .\app\server.js doctor` | Health check: engines, dependencies, ports, data directory (the same report as Settings · System · Health) |
| `node .\app\server.js mcp-config` | Print a workbench MCP configuration ready for `.mcp.json` |
| `node .\app\server.js install` | Register the workbench MCP with the local Claude Code |
| `node .\app\server.js mcp` | Run as a stdio MCP server |

### Upgrading

- **Major versions**: download the new full package, **extract it to a new folder**, close the old version and start from the new folder. The data directory lives outside the install folder and migrates automatically on first launch; keep the old folder as your way back. The migration center can also detect the old install and repoint your configurations to the new one.
- **Incremental overlay packages**: patch the same version only; the pre-check refuses packages for a different version. See [`ruyi-workbench/tools/APPLY-OVERLAY.md`](ruyi-workbench/tools/APPLY-OVERLAY.md).

### Data directory and configuration

| Item | Meaning |
|---|---|
| Data directory | Defaults to `~/.ruyi-workbench`: configuration, threads, checkpoints, audit, memory, skills and usage all live here (called `~/.win-claude-workbench` before 3.0 and migrated automatically on first start; see below) |
| `RUYI_HOME` | Sets the data directory (the legacy `WIN_CLAUDE_WORKBENCH_HOME` is still read; `RUYI_HOME` wins) |
| `RUYI_RG_PATH` | Path to ripgrep; otherwise the package's `vendor-bin/rg.exe`, then `rg` on `PATH`, then a built-in scanner (slower on large repositories) |
| `RUYI_TOOLBOX_HOME` | Where ruyi-toolbox components register (default `~/.ruyi-toolbox`) |
| `CLAUDE_CLI_PATH` / `KIMI_CLI_PATH` | Paths to the Agent CLIs (also settable in Settings) |
| `KIMI_CODE_HOME` | Kimi Code's configuration folder (Ruyi merges its MCP list into Kimi's `mcp.json`) |

---

## FAQ

<details><summary><b>Does it work without internet?</b></summary>

Yes. The workbench itself is fully offline; as long as a model endpoint is reachable (local Ollama / LM Studio or an internal service) it can work. Web search degrades visibly when offline and uses local material only.
</details>

<details><summary><b>Do I need to install Python or Node?</b></summary>

Not with a release package: it ships its own Node runtime, and the Full package also ships CPython 3.12 for desktop control. Only running from source needs Node.js ≥ 20, and only a source install of ACC needs Python ≥ 3.12.
</details>

<details><summary><b>"Test connection" cannot reach my local model?</b></summary>

Make sure Ollama / LM Studio is running and has a model pulled. The address is usually `http://127.0.0.1:11434/v1` (Ollama) or `http://127.0.0.1:1234/v1` (LM Studio). The wizard and the settings page say which step failed and link to the matching manual section.
</details>

<details><summary><b>The AI changed a file wrongly — now what?</b></summary>

Use the turn's "changes" card under the answer or the "Changes" tab on the right to undo one change or the whole turn; or rewind the thread to an earlier turn and roll the files back with it.
</details>

<details><summary><b>Why does the steward only give me buttons after reading a web page?</b></summary>

By design: web content can smuggle in instructions. Once it has read external content in a turn, that turn's write actions become proposals you confirm with a click.
</details>

<details><summary><b>Where is my data, and how do I uninstall?</b></summary>

In the data directory (default `~/.ruyi-workbench`, changeable with `RUYI_HOME`). To uninstall, delete the extracted install folder; delete the data directory too if you want the data gone. There is zero telemetry and nothing is ever reported.
</details>

<details><summary><b>The extractor says paths are too long?</b></summary>

Extract to a short path such as `C:\Ruyi` and try again — do not choose "Skip". If you already skipped, the base workbench still starts; desktop control is rejected by the integrity check with recovery steps.
</details>

<details><summary><b>Does it run on Linux or macOS?</b></summary>

Windows 10/11 is the first-class target; release packages and desktop control are Windows-only. The source starts on Linux for development and testing (CI's static checks run there), but PowerShell, Explorer and `C:\`-path features do not apply.
</details>

---

## Repository layout

```
.
├── ruyi-workbench/
│   ├── app/src/            Backend source: 64 ordered modules (edit here, then run build.js)
│   ├── app/server.js       Backend runtime artifact (concatenated by app/build.js; zero npm runtime deps)
│   ├── app/public/         Frontend: index.html + 61 native ES modules + layered CSS + zh/en locales
│   ├── desktop/            WinForms + WebView2 desktop shell
│   ├── resources/          Built-in Playbooks, the offline plugin marketplace, scripts
│   ├── config/             Configuration examples and factory defaults
│   ├── docs/               User and administrator guides, architecture, offline deployment, source review
│   └── tools/              Offline packaging, overlay upgrades
├── mcp/
│   ├── ai-computer-control/  Desktop-control MCP (ACC, Python, 108 tools)
│   └── README_EN.md        Drop-in connector guide
├── dev-harness/            Offline e2e, unit tests, static locks and fakes (plain Node)
├── docs/                   Engineering spec, generated architecture artifacts, i18n contract, roadmap and archive
├── facts.json              Single source of truth for headline numbers (generated)
├── CLAUDE.md               Project notes for AI coding assistants
├── CONTRIBUTING.md         Contributor guide and the five hard constraints
├── SECURITY.md             Security policy and threat model
└── CHANGELOG.md            Bilingual release notes
```

---

## Development and testing

Before changing anything, read the five hard constraints in [CONTRIBUTING.md](./CONTRIBUTING.md): **fully offline, zero npm runtime dependencies in `server.js`, clean-room, Windows 10/11 first-class, and every behaviour change carries e2e coverage**. If an AI coding assistant is doing the work, have it read [CLAUDE.md](./CLAUDE.md) first: it lists the shared building blocks (keyed write chains, small JSON stores, API failure envelopes, the Agent CLI registries, the thread-state rule table and more) and how to regenerate the generated artifacts.

**Shape of the code**: the backend is edited only in `app/src/`, then `node ruyi-workbench/app/build.js` rebuilds `server.js` (CI rejects stale artifacts with `--check`); the module graph, route inventory and headline numbers are generated artifacts with their own regeneration scripts (see the table in CLAUDE.md). The frontend has no build step: edit `app/public/` directly.

**Fast checks before a commit** (same order as CI):

```bash
node dev-harness/syntax-gate.js
node ruyi-workbench/app/build.js --check      # the artifact must match app/src
node --test "dev-harness/unit/*.test.js"
node dev-harness/run-all.js --fast            # static locks only, seconds
node dev-harness/<relevant>.e2e.js            # one file: last line ... E2E: ALL PASS
```

**Full regression**: `node dev-harness/run-all.js --parallel 4`. There are three kinds of tests: `*.e2e.js` (end-to-end with a real server and a fake provider), `*.browser.e2e.js` (a real browser driven over CDP) and `*.static.e2e.js` (static locks that prefer asserting runtime values). Windows CI (`.github/workflows/e2e.yml`) is authoritative; a full run in a Linux container fails a known set of Windows-only files (PowerShell, `C:\` paths, pixel baselines), so judge regressions against a baseline from the same environment. Live probes that need real API keys or a desktop are skipped by default.

Architecture and engineering: [Architecture](ruyi-workbench/docs/ARCHITECTURE_EN.md) · [Engineering spec](docs/ENGINEERING-SPEC.md) · [Module dependency graph](docs/architecture/module-dependency-graph.md) · [Route inventory](docs/architecture/route-inventory.md) · [Static-lock inventory](docs/architecture/source-text-locks.md)

---

## Documentation

| Topic | English | 中文 |
|---|---|---|
| Everyday use | [User Guide](ruyi-workbench/docs/manuals/USER-GUIDE_EN.md) | [用户手册](ruyi-workbench/docs/manuals/USER-GUIDE_CN.md) |
| Deployment, engines, security and regression | [Administrator Guide](ruyi-workbench/docs/manuals/ADMIN-GUIDE_EN.md) | [管理员手册](ruyi-workbench/docs/manuals/ADMIN-GUIDE_CN.md) |
| Offline package | [Offline Deployment](ruyi-workbench/docs/OFFLINE_DEPLOYMENT_EN.md) | [离线部署说明](ruyi-workbench/docs/OFFLINE_DEPLOYMENT_CN.md) |
| Runtime architecture | [Architecture](ruyi-workbench/docs/ARCHITECTURE_EN.md) | [架构说明](ruyi-workbench/docs/ARCHITECTURE_CN.md) |
| Tool loading design | — | [按需装载与 A/B](ruyi-workbench/docs/TOOL-LOADING_CN.md) |
| Built-in skills and quick tasks | — | [技能与一键任务目录](ruyi-workbench/docs/SKILLS-CATALOG_CN.md) |
| MCP connectors | [MCP Connectors](mcp/README_EN.md) | [MCP 连接器](mcp/README.md) |
| Clean-room rationale | [Source Review](ruyi-workbench/docs/SOURCE_REVIEW_EN.md) | [源码审阅结论](ruyi-workbench/docs/SOURCE_REVIEW_CN.md) |
| UI localization contract | [Localization Guide](docs/i18n/README_EN.md) | [多语言兼容方案](docs/i18n/README.md) |
| Release lines and roadmap | [Optimization roadmap](docs/OPTIMIZATION-ROADMAP.md) | [优化路线图](docs/OPTIMIZATION-ROADMAP.md) |

The complete bilingual documentation index is [docs/README.md](docs/README.md).

---

## Security, privacy and clean-room

- The server listens on `127.0.0.1` only; the page credential is handed over by a handshake, never embedded in HTML; a Host allowlist blocks DNS rebinding.
- Every write goes through a checkpoint and can be rolled back; exec-tier actions can never be allowed persistently.
- Network tools refuse private and loopback addresses; sensitive data-directory files are denied to the file tools in both directions; secrets are masked in API responses, the status endpoint and the workbench MCP's resources.
- **Zero telemetry**: the only outbound traffic goes to the model endpoints and search backends you configure and the URLs you ask it to visit.
- Ruyi is a **clean-room implementation**: no leaked Anthropic source, no redistribution of the official Claude Code (bring your own), no copied third-party plugin source. License obligations for the bundled frontend libraries (marked, highlight.js, mermaid and others) are listed in [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

**3.0 naming cleanup**: the data directory `~/.win-claude-workbench` becomes `~/.ruyi-workbench` (moved automatically on first start, with a directory junction left at the old path so scripts and shortcuts that hard-code it keep working; if another running instance is using the old directory, it is kept for now and migrated on a later start); the MCP server id `win-claude-workbench` becomes `ruyi` (tools show up as `mcp__ruyi__*` in Claude Code / Kimi Code; `install` and the installer remove the old registration, stale Kimi entries are cleaned up, and agent roles that still name the old id keep working); the offline plugin marketplace `win-workbench-offline` becomes `ruyi-offline`; child processes only get `RUYI_HOME`, while the old `WIN_CLAUDE_WORKBENCH_HOME` is still read.

## Contributing

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before sending a fix, feature or documentation change.
- Use the repository's issue forms for bugs and ideas; see [SUPPORT.md](./SUPPORT.md) for usage questions.
- Participate under the [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
- **Do not disclose unfixed vulnerabilities publicly**; report them privately as described in [SECURITY.md](./SECURITY.md).

## License

[Apache-2.0](./LICENSE) (including `ai-computer-control`) · third-party components in [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) · Copyright 2026 Ruyi Workbench contributors.
