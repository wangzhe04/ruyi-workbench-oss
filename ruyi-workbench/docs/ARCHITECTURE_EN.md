# Ruyi Architecture

This is the English companion to [架构说明](ARCHITECTURE_CN.md).

## Components

> Version baseline: `configSchema` **11** · session `schemaVersion` **1** · the tree is the **2.8.0 candidate**
> (the version line in `package.json` is bumped by wave 107's R1 cut, so it still reads 2.7.0 on disk until then;
> `CONFIG_SCHEMA` has not moved since 2.7.0 and 2.8.0 does not bump it) · source modules **53** · native tools
> **97** · ACC **108** (v1.9.1).
>
> **Four structural changes since v2.5.0**: (1) the source went from 17 modules to **53**, with the number-13 HTTP
> router family alone accounting for 20 files; (2) native tools went **52 → 97** on the `TOOL_HANDLERS` axis, whose
> single source of truth is the repository-root `facts.json`; (3) four new route families were added — steward,
> scheduler, an SSE event stream, and speech transcription — bringing route decision points to **137** and
> `ROUTE_AUTH` declarations to **125** (generated into `docs/architecture/route-inventory.{json,md}`); (4) the
> frontend became **one workbench, two lenses** — a Workbench lens and a Steward lens over the same workbench,
> switched by a segmented control in the top bar, sharing one thread rail and reading the same data. The retired
> dispatch desk is gone. The v2.5.0 set (WinForms + WebView2 native shell, the six task-facing toolbox entries,
> long-tool interjection, background sub-agent DAGs) still holds.
>
> **This is a baseline document**: it describes the tree as it is today. Per-release user-visible change belongs in
> the repository `CHANGELOG.md`; wave-level design and evidence live in `docs/optimization-plan/`.

Ruyi has a framework-less browser frontend and a Node.js local server. The browser handles chats, workspace
selection, settings, permission cards, file and audit views, workflow monitoring, and language resources. The
server owns configuration, session persistence, provider and Claude CLI engines, tool execution, checkpoints,
audit records, MCP bridging, workflow scheduling, skills, memories, and usage ledgers.

## Engines

The provider engine communicates with OpenAI-compatible HTTP and streaming endpoints. The optional Claude CLI
engine runs a user-supplied local executable and injects the generated workbench MCP configuration. Both engines
share the same session, local tools, permission policy, checkpoint journal, audit model, skills, and memories.

Both engines also share the Wave 54 ordered-turn protocol. `createTurnSegmentBuilder()` persists text, thinking,
tool, subagent, plan, question, permission, workflow, Mission, and error events as `message.segments`; tool segments
reference the existing `message.toolCalls` payload by id, and calls from one model response share a `batchId`.
Permission, plan, and question decisions close their pending segments in place, so allowed/denied, approved/rejected,
and answered states survive static re-entry. Legacy fields remain populated, and sessions without `segments` keep
the previous content-then-tools fallback without fabricated chronology.

The browser uses the same ordered narrative for streaming and static re-entry. Helpers in
`public/js/turn-narrative.js` provide stable keys, render signatures, and scroll anchors so unchanged message DOM is
reused. The conversation is a `role="log"` that announces additions and status changes without replaying the whole
history; tail-index navigation restores keyboard focus to the corresponding process row. Successful sequential
tools fold after the third item while running and failed items stay visible. A zero-dependency dark/light browser
screenshot grid supplies the Wave 54 visual regression lock.

## Entry points and HTTP API

serve starts the loopback UI and API. mcp starts the stdio MCP endpoint. install and mcp-config generate or register
MCP configuration; doctor reports deployment readiness.

The HTTP API serves static assets, configuration, sessions, tool actions, files, checkpoints, audit events,
providers, workflows, usage, memories, and MCP integration. Sensitive browser routes require the per-process page
token. The browser obtains the token via `POST /api/bootstrap` (open level, host gate blocks DNS rebinding) and
stores it in `sessionStorage`; HTML no longer embeds the token; `index.html` ships a CSP meta (`connect-src 'self'`).
Error responses use stable code/params/message objects so the frontend can localize them without branching
on a human-language error string.

The route families added since v2.6 are not re-listed route by route here; the authoritative statement is the
`ROUTE_AUTH` table in `01b-route-auth.js` and the generated `docs/architecture/route-inventory.md`.

| Family | Auth level | What it does |
|---|---|---|
| `/api/steward/*` (about 20 routes) | **token** | Steward: start/stop, status, inbox, visit digest, relaying messages, the `act` buttons, the arbiter and queue jumping, the memory panel, the decision log |
| `/api/scheduler/tasks*` | **token** | Scheduled-task CRUD, `/:id/runs`, `/:id/run-now` |
| `GET /api/events/stream` | **token-browser** | One SSE stream replacing the former 5 s / 15 s polls |
| `POST /api/audio/transcribe` | **token** | Speech transcription; the only new outbound surface in this release (25 MB gate, 120 s timeout, OpenAI-shaped multipart to `audioBaseUrl \|\| baseUrl`) |
| `/api/missions`, `/api/missions/:id` | read **token-browser**, write **token** | Read-only projection of mission containers and acceptance items; the four provenance states are computed, not persisted |
| `POST /api/playbooks/service-match` | **token-browser** | Natural language to one of six services, returning `{service, playbooks, state, guidance, guidanceDropped}` with at most one guidance line |
| `GET /api/help/doc` | **token** | In-app manual reader (whitelisted doc id and language; the request string never reaches `path.join`) |

**`GET /api/status` is at the `open` level** — host gate only, no UI token — so the config it serves must be
masked field by field: `providers[].apiKey`, `searchBackend.apiKey`, `modelsApiKey`, every value of
`externalMcpServers[].env` and of a remote entry's `headers`, display redaction on `args`, and credentials inside
any URL it carries. On save, secrets are restored only for the same launch target, and for providers a save that
widens the set of addresses the key reaches while echoing back a mask is refused outright rather than cleared.
`sanitizeExternalMcpServer` is the last gate that keeps a mask out of disk and out of child-process environments.
Details and the remaining unmasked surface are in `docs/manuals/ADMIN-GUIDE_EN.md` section 7.

## Workbench MCP and external MCP

The workbench's stdio MCP server exposes local Windows capabilities to Claude CLI. External stdio MCP servers can be
added through a drop-in manifest and bridged into the provider tool loop. Permission tiers, path guards, checkpoint
coverage, and audit logging continue to apply at the workbench boundary.

The current native tool count is **97** on the `TOOL_HANDLERS` axis, and the single source of truth for that number
is `nativeTools` in the repository-root `facts.json` (generated by `dev-harness/facts-generate.js` and recomputed
by `facts.static.e2e.js`); any other number in the documentation is drift. The 97 break down as **63** general
native tools, **33** `steward_*` tools visible only inside a steward conversation (a normal thread and a sub-agent
never see them), and **1** speech transcription tool, `audio_transcribe`. That last one is exec tier because it
sends a user file off the machine: it shares `file_read`'s path gate, then an extension allowlist, then the 25 MB
gate, and its result is flagged `untrusted: true`. Every failure mode — unconfigured, out of bounds, over the
limit, upstream error — is normalized into `ok: false` rather than thrown.

## Modular build

The product is a single-file `app/server.js`; source lives in `app/src/` (**53 modules**; the authoritative list is
`app/src/manifest.json`) joined in dependency order by `app/build.js`. Edit modules under `src/` and rebuild the
product with `node app/build.js` (`node app/build.js --check` reports staleness).

**The module number prefix is the dependency layer.** `module-dependency-policy.json` declares the permitted edges
and `dev-harness/module-dependency-graph.js --check` pins them: currently **53 modules / 420 edges / 1 SCC**,
generated into `docs/architecture/module-dependency-graph.{json,md}`.

- **00–02** boot and persistence: `00-boot` (constants, `CONFIG_SCHEMA`, `SESSION_SCHEMA`, port budget),
  `01-config` (defaults and `normalizeConfig`), `01b-route-auth` (the deny-by-default `ROUTE_AUTH` table),
  `01c-runtime-flags`, `02-session-store`, `02c-turn-segments` (the ordered-turn protocol).
- **03–04** gates and peripherals: `03-bridge-guard` (attachment prompts, the exec gate and effective working
  directory), `04-permission-runtime` (permissions, the `REDACT_PATTERNS` table, the MCP connector write path),
  `04-desktop-shell`, `04-visual-pipeline`.
- **05** engine A and the CLI bridge: `05-claude-engine` (Claude CLI turns, `maskSecrets` / `unmaskSecrets`, the
  transcription outbound body), `05b-kimi-bridge` with `05c` / `05d`.
- **06** engine B and per-domain pure functions: `06-provider-engine` (native tool loop, capability matrix,
  `ERROR_CLASSES`, playbooks and service classification), `06b-prompt-registry`, `06c`–`06h` (agent hooks, memory,
  missions, commissions, resource leases, retrieval indexes), `06i-steward-core` (steward pure functions: tiers,
  permanent-exemption criteria, the delegation gates), `06j-scheduler-core` (plan parsing, catch-up and crash
  recovery).
- **07–12** turns and tools: `07-autonomy` (tool tiers and permission gates), `08-agent-runs`, `09-workflow` with
  `09b` / `09d`, `10-context-governance` (two-level automatic compaction and the wave-111 switch decision points),
  `11-native-tools`, `12-tool-dispatch` (the `TOOL_HANDLERS` registry).
- **the 13 family (20 files)** HTTP and the steward runner: `13-http-router` is the single request entry point and
  dispatcher, delegating by domain to `13b` (API domain routes, including `POST /api/audio/transcribe`), `13c`
  (overlay), `13d` (core domain), `13e`, `13f` (native tool schemas); the steward side runs from `13g` to `13t`,
  and `13r-event-stream` is the SSE stream. **This family is where "the same rule judged in two places" is most
  likely to grow**; the counting locks in `dev-harness/steward-tools.static.e2e.js` and `tool-dispatch.e2e.js`
  list every place a new steward action must be registered.
- **14-main** only exports and dispatches the entry point.

## Workflows, skills, memories, and usage

Agent workflows persist DAG state, dependency edges, budgets, retries, resource leases, quality gates, optional Git
worktree isolation, task-pool proposals, mailbox messages, and directed steering queues. Steering works on both
engines: the Claude engine injects user interjections via stdin immediately in interactive mode (print mode refuses; refused while a question is pending); the provider engine queues (cap 3) and drains at iteration boundaries;
the provider engine queues and drains at iteration boundaries; workflow Claude nodes use deferred interjection; the
composer send button is three-state (send/interject/stop). The browser monitors runs
incrementally and can pause, resume, stop, retry, or approve proposed work.

Skills come from built-in, user, project, and playbook sources and are progressively injected. Workbench memory is
stored globally or per project and enters prompts only through bounded, fenced indexes. Usage ledgers append local
records and summarize tokens, currency-specific estimates, plan-included traffic, and budgets.

Subagent dispatch is governed by `config.subagentPreferredProvider` / `config.subagentPreferredModel` (cross-provider;
52x) and the `PROMPT_EN` constant (52a).

## Data root

The data root contains config.json, runtime metadata, sessions, uploads, logs, generated files, checkpoints,
playbooks, skills, web cache, agent runs, workflows, worktrees, usage ledgers, and memory. Sensitive paths are not
exposed through ordinary file tools. Configure RUYI_HOME when an installation requires a different location.

Two directories are new in this release:

- `steward/` — the steward's own persistence. `memory-v1.json` is what the steward remembers about the user, with
  `expiresAt` and `scope` per entry; `decisions-v1.ndjson` is the action log, each line carrying what it went on
  and an undo pointer (`undoRef`). **Downgrading to 2.7.0 loses `expiresAt` and `scope`**; the backup procedure is
  in `docs/manuals/ADMIN-GUIDE_EN.md` section 8.4.
- `scheduler/` — `tasks-v1.json` is the promise itself, carrying a `revision`; `fires-v1.ndjson` is the receipt for
  each execution, carrying `occurrenceKey`, `executionGeneration`, `phase` and `outcome`. Deleting a task does not
  delete its receipts, and an `inFlightRunId` found with no terminal state after a crash is recorded as
  `outcome: 'unknown'` — never assumed successful, never blindly resent.
