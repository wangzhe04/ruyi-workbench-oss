# Model Workflow Specification

> Added in Wave 51 (04 Phase D). For users and contributors: how the workbench structures a model turn — plan → execute → check → loop-guard → budget → compact — and what each budget tier means. The spec is also marketing material: an auditable way of working. Bilingual: see `MODEL-WORKFLOW-SPEC_CN.md`.

## 1. Principle

The workbench imposes structural constraints on every model turn so each step is observable, replayable, and reversible. Six stages: **plan → execute → check → loop-guard → budget → compact**. This spec describes the provider engine (OpenAI-compatible path). The Claude CLI engine is a thin wrapper that delegates to the CLI black box; differences are in the engine capability matrix.

## 2. Plan (plan mode)

- **PLAN: prefix**: if the first assistant message of a turn starts with `PLAN:`, the turn pauses for user approval.
- **Approval closure**: the approval flag lives in the turn's closure and is **never** written to `config.permissionMode` — one approval never grants permanent permission; it expires when the turn ends.
- **Re-submit after reject**: the model may re-submit `PLAN:` after rejection (guards the consumed-planPhase regression).
- **steer vs plan**: semantics of steering while a plan is pending (revise the brief vs lift the plan) are in the Steer doc (plan 02).

## 3. Execute

### 3.1 Tool-protocol guard rails
Read before write (read a file before editing it); minimal, precise changes; `found:false` / no-match is normal semantics, not an error; list a plan with `todo_write` before multi-step work; finish with a concise change summary.

### 3.2 On-demand loading
`tool_search` discovers a capability → `tool_load` loads the returned pack or exact tool name → call the concrete tool. Do not reinvent an on-demand-loadable tool via the terminal.

### 3.3 Tool-selection priority
Built-in and desktop/document tools first (protected by permission prompts + one-click undo); terminal scripts as fallback (not auto-undoable, error-prone ad-hoc).

### 3.4 Sub-agent orchestration
- `orchestrate_agents` is the single entry point: submit the whole dependency graph (`nodes`, dependencies via `dependsOn`), or reuse a template with `workflowId` (built-in templates require a `context` naming this run's subject or they will not start; when `nodes` is also given, `nodes` wins and the template is ignored); a single agent uses the top-level shorthand `{task, role?, toolTier?, background?}`. The runtime parallelizes ready nodes (cap `subagentMaxConcurrent` per stage), awaits dependencies, injects prior conclusions into later nodes, and persists progress. The old `spawn_agent` was folded in; a model that still calls it is translated into a single node.
- **Permissions**: nodes run under the thread's effective permission mode (request > session > global). Both engines apply the same rule: Ask every time allows read-only tools, Auto-apply edits also allows file edits, and commands / bridged MCP are refused; Smart auto, Full auto and Plan behave as usual. A role's own mode (such as Plan) takes precedence.
- **Resource awareness**: nodes touching the same file / browser profile / desktop / Office document must declare `resources` (e.g. `desktop`, `browser:default`, `file:C:\proj\a.js`, `workspace:C:\proj`; read-only sharing takes a `read:` prefix); conflicting nodes queue automatically, and tool args are locked at call time as a backstop.

## 4. Check

### 4.1 Quality gate (DAG-node level)
A node may declare `outputSchema` (structural validation) + `gate` (pass condition); failure policy `failurePolicy` (block/continue/retry); degraded policy `degradedPolicy` (accept/fail/retry/request_review). A reviewer / verifier node without a `gate` gets an automatic review / verify gate (it must output a verdict; anything but pass is rejected); a node that only produces findings and should not pass or reject anything sets `gate: false` (the three audit nodes and the reproduce node in the built-in templates do).

### 4.1a Built-in templates and roles
Eight built-in templates (`BUILTIN_AGENT_WORKFLOWS` in `08-agent-runs.js`): debate-and-judge, implement-review-fix-test, deep-research, design-and-decide, codebase-audit, debug-root-cause, doc-from-scratch, data-insights. Their node tasks are generic and carry no subject; the subject comes from the launch `context`. Ten built-in roles (`BUILTIN_AGENT_ROLES` in `01e-permission-modes.js`): explorer, worker, coder, reviewer, verifier, planner, researcher, critic, synthesizer, analyst; the role prompt goes into the system prompt on both engines (on the Claude engine via `--append-system-prompt`, moved into the first message when the command line is too long). Personal and project templates (`.ruyi/workflows.json`) with the same id override in the order project > personal > built-in; saving rejects dependency cycles and unknown roles.

### 4.2 Turn-level output contract (planned)
Long tasks end with a "completion statement: what was done / what wasn't / how it was verified." Prompt convention first, mechanical checking later (04 Phase D planned item, not yet implemented).

## 5. Loop protection (dual detection)

The workbench defends against loops with two complementary, non-overlapping detectors.

### 5.1 Identical-signature run (signature level)
`sig = tool name + raw args`. Consecutive identical sigs accumulate:
- 3rd hit → `loopWarning` nudge (prompt the model to change tack);
- 5th hit → **refuse to execute + abort the turn** (`errorClass=tool_loop`).

Catches "the exact same call repeated."

### 5.2 Result-fingerprint no-progress (semantic level, 04 Phase D Wave 51)
A fingerprint of the tool result's content summary (**excluding** call args — "different args but same result" is exactly the semantic loop to catch; including args would make a path change auto-reset and collapse into a duplicate of the signature detector). N consecutive identical fingerprints (no new info) → `loopWarning` nudge.
- **Normal tools threshold 4**; **exploratory tools lenient threshold 8** (`file_read`/`read_file`/`list_directory`/`grep`/`glob`/`find_template`/`web_search`/`ocr_screen`/`ocr_find_text`/`ocr_image`/`ui_find`/`ui_inspect`/`screenshot`/`find_on_screen`/`find_all_templates`, etc. — reading different paths with different content is normal exploration; content changes → fingerprint changes → reset; only truly repeated identical results warn).
- **Warn-first, no abort**: a semantic loop is weaker evidence than a signature loop, so it only nudges the model to self-rescue (unlike the signature detector's 5th-hit abort).
- **Errors / empty results count as new info** (the error itself is information) and reset the counter.

Catches "different args but no progress" (e.g. re-reading the same content via different paths, or `grep` with different patterns all returning empty).

### 5.3 How the two relate
The signature detector runs first; if it already warned, the semantic detector skips (`!loopWarning` guard, no double-warn). The semantic detector covers the blind spot: different sig but identical result content. Both counters are turn-local and never leak across turns.

## 6. Budget

### 6.1 Iteration budget tiers (`TOOL_ITERATION_BUDGETS`)
| Tier | Cap | Meaning |
|---|---|---|
| standard | 100 | default, most tasks |
| long | 200 | long task (`isLongToolTask` keyword heuristic: a first turn heavy in exec/read auto-promotes) |
| standardHard | 300 | hard limit (`hardLimit`) for standard turns, cannot be exceeded |
| hard | 1000 | hard limit for long-task or agent-team turns |
| extension | 50 | dynamic extension increment (`shouldExtendToolIterationBudget`: appended on progress, capped at the turn's `hardLimit`) |

### 6.2 Sub-agent budget
`subagentMaxConcurrent` (parallel-within-a-stage cap), `subagentMaxPerTurn` (per-turn total cap, 0=disabled, tool kept out of the schema).

### 6.3 Budget-parity unification (04 Phase D planned item)
Align the user clamp with hardLimit; upgrade `isLongToolTask` to "re-judge from first-turn tool-usage pattern" (reduce opening-turn misdetection). Planned, not yet implemented.

## 7. Compaction

`context-compact-v2`: when over-window, history is compacted with ≥80% fact retention (9/10 tests). Compaction events are visible in the UI (🗜 family). A summary call never fails by over-windowing itself (budgeted + dynamically truncated); an over-window 400 does not end the turn (e2e stage B: turn ok).

## 8. Checkpoints and undo

Write-family tools enter the snapshot table (`BRIDGED_WRITE_PATH_ARGS`): create/modify/delete/move/copy, all operation shapes. A whole-turn rewind zeros the workspace. This is the backstop for the "interrupt + rewind" combo — non-cancellable tools (e.g. an already-completed file write) rely on checkpoints/rewind, and the copy makes the "interrupt + rewind" combination explicit (differentiator: operation-level undo).
