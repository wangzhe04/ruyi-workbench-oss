# Ruyi Administrator Guide

This is the English companion to [管理员手册](ADMIN-GUIDE_CN.md). It covers local deployment, engine integration,
security boundaries, verification, and troubleshooting.

## 1. Deployment model

Ruyi is a local Windows application. The workbench server is a single Node.js program with no runtime npm
dependencies. Use Ruyi.exe serve --open for packaged deployment or node app/server.js serve --open from source.

Ruyi.exe also supports doctor, mcp-config, install, and mcp. Overlay packages can update an installation
incrementally; verify the overlay identifier and run doctor after applying one.

The data root defaults to the legacy .win-claude-workbench directory under the user profile. Set RUYI_HOME to move
it. It contains configuration, chats, uploads, checkpoints, audit logs, generated MCP configuration, skills,
memories, workflow state, and usage ledgers. Treat it as private local application data.

The default HTTP port is 8765. Use a loopback address only; Ruyi is not a multi-user or public web service.

## 2. Engine integration

### Claude CLI

Point Settings to an internal Claude CLI executable or configure it during installation. Ruyi generates and can
register its workbench MCP configuration. If PowerShell JSON quoting breaks Claude's add-json command, use the
non-JSON add form or import the file printed by mcp-config.

### OpenAI-compatible providers

Add a provider with an ID, display label, base URL, API key, and model. Ruyi supports presets and compatible
internal gateways. Test the connection in Settings before production use. API keys remain on the local machine and
are masked in ordinary API responses.

Since 2.8.0, **changing a provider's endpoint while leaving the masked key in place fails the save.** The key box
in Settings holds the mask, and the base-URL box sits next to it, so this is a normal operation rather than an
attack; the save is refused as a whole (HTTP 409, code `config.masked_secret_vector_changed`), nothing is written,
your draft survives, and the message names the entry and asks you to type the key again or clear the key box
explicitly. See section 7.

Speech recognition, when configured, reuses the same provider record: `audioBaseUrl` (falling back to `baseUrl`)
plus the same API key. Which dialect Ruyi speaks to it is a per-provider setting, `providers[].asrProtocol`:
`transcriptions` (the OpenAI-shaped multipart `/audio/transcriptions`, the default, and the only shape before
2.8.0) or `chat-audio` (`/chat/completions` with an `input_audio` data URI, which is how MiMo and Bailian
document ASR). A provider that speaks neither cannot do voice at all, and Ruyi says so rather than guessing.
Chat style only accepts the formats the upstream declares — MiMo refuses webm with a plain 400 — so microphone
recordings are converted to 16 kHz mono WAV in the browser before upload, while audio attachments and the
`audio_transcribe` tool send the user's original file untranscoded.

### Desktop MCP and honest metering

ai-computer-control is optional. Install its required Python environment only where desktop/Office control is
needed. Usage accounting groups token and estimated cost by engine, provider, chat, and currency; subscription-plan
traffic is labeled as plan-included instead of fabricated as a monetary charge.

ACC v1.9.1 exposes 108 tools. Browser mode defaults to `system`, which opens a new tab/window in the user's
associated browser without owning or closing it; the active Ruyi Workbench tab is never navigated, reused, or
closed. `managed`, `custom`, `cdp`, and explicitly isolated `bundled` modes are available through
`browserAutomation`. Managed Chromium is launched with renderer accessibility enabled. When an accelerated browser
surface lacks a UIA Document tree, UIA/observe results carry `accessibilityLimited` and callers should switch to
CDP/DOM, OCR, or screenshot coordinates.

Default OCR uses the offline Windows.Media.Ocr API through `winsdk`, not Tesseract. Full packages contain and
verify CPython 3.12 plus the cp312 `winsdk` wheel during both build and installation. For an overlay on an older
installation, run `update.bat --deps` before `update.bat --code` so `uiautomation`, `comtypes`, and `winsdk` are
installed from the local wheel cache.

The read-tier `mcp_list` tool returns connector metadata and environment-variable names, never secret values. The
exec-tier `mcp_configure` tool can persist external connector or browser-target changes only after an explicit user
request and the normal permission confirmation; it cannot replace the built-in ACC executable or lower tool tiers.

### Voice transcription

`POST /api/audio/transcribe` is the only new outbound surface in 2.8.0: a 25 MB gate (declared Content-Length plus
a streaming tally), a 120 s timeout, a request to the provider in whichever dialect `providers[].asrProtocol`
selects (OpenAI-shaped multipart to `/audio/transcriptions` by default, or `/chat/completions` with an
`input_audio` data URI), and a usage ledger line of kind `aux` marked `estimated` when the upstream reports no
usage (the chat dialect's `prompt_tokens` / `completion_tokens` are mapped, so it normally reports real numbers).
The native tool `audio_transcribe` is exec tier because it sends a user file off the machine, and its result is
flagged untrusted.
Transcription is off until `asrProviderId` and `asrModel` are both set; unset means the composer builds no
microphone node at all.

## 3. Security boundaries

- Ruyi binds loopback only and protects browser-originated sensitive routes with a page token obtained via
  `POST /api/bootstrap` (token stored in `sessionStorage`, never in plain HTML; a CSP `<meta>` tag in
  `index.html` restricts script sources). A deny-by-default host gate rejects cross-origin and same-machine
  non-browser requests.
- `GET /api/status` is **host-gated only and takes no UI token**, so everything it returns must be masked at the
  field level. Section 7 states what is masked and what is not.
- Permission modes gate read, edit, and exec operations. File changes are checkpointed before mutation.
- **What the gate judged is what runs.** Before 2.8.0, `powershell_run` / `script_run` / `shell_start` ran in the
  home directory when given no working directory while the permission gate judged the thread's working folder, so
  a relative path landed at home. The working directory is now resolved once by the exec gate (explicit `cwd`,
  then the request's working folder, then the thread `cwd`, then `defaultWorkspace`, then home) and handed back to
  dispatch; all three tools use only that. Side effect, stated plainly: when the thread `cwd` points at a deleted
  directory the three tools now fail closed on it, and the error is the raw spawn message. `git_*` tools do not go
  through the exec gate and still default to the home directory.
- Web tools reject private, loopback, and link-local destinations to reduce SSRF exposure.
- Workspace guards constrain file access; sensitive application data is denied even when reached through links.
- Audit records are appended locally and secrets are redacted before UI delivery. One redaction table governs
  audit responses, the command excerpts the steward is shown, and session-search excerpts. 2.8.0 completed it for
  quoted label-and-value shapes (`"apiKey": "…"`, YAML/TOML/`.env`/PowerShell `$env:`, and the once- and
  thrice-escaped JSON found in session files) and for segmented keys, which used to be cut at the first hyphen and
  slip through whole. Known edges remain: a PEM private key is only redacted through its first segment, a single
  value longer than 4096 characters is not redacted past that point, and a value containing a single quote closes
  at that quote.
- Ruyi is offline-first, has no product telemetry, and follows clean-room provenance rules.
- Skills, memories, workflows, MCP manifests, and model output are untrusted input. Review permissions, workspace
  scope, imported manifests, and generated commands before approving them.

See the repository [Security Policy](../../../SECURITY.md) for reporting and threat-model details.

## 4. Pro mode and diagnostics

The right-hand workspace keeps six task-facing entries in both simple and pro mode: Files, Artifacts, Changes,
Agent workflows, Usage, and Activity. Terminal, desktop, MCP, search, and file-read capabilities remain available
to the model through the normal read/edit/exec permission, checkpoint, and audit paths; they are no longer exposed
as context-free manual runners.

Connector operations remain under **Settings → Integrations / MCP**. Deployment checks, storage management,
performance metrics, and raw event logs are grouped into collapsible sections under **Settings → Doctor**.

## 5. Acceptance and regression

Run tests serially because fixtures use fixed local ports:

    npm.cmd test

The fast static route is:

    npm.cmd test -- --fast

Live provider and desktop tests require a real key or Python environment and are skipped by default. For a new
provider, test model listing, streaming text, tool calls, an error response, usage reporting, and a restart.

## 6. Troubleshooting

Use Ruyi.exe doctor first. Verify the selected engine, provider base URL and model, CLI path, MCP registration,
loopback port availability, data-root permissions, and desktop Python environment. Keep server logs and the audit
timeline when escalating an issue; do not paste unmasked keys or chat content into public reports.

## 7. Secret masking and the launch-target gate (2.8.0)

**The mask shape** is `••••<last four>`. **Responses never carry plaintext.** On save, a value that still begins
with the mask prefix is **restored from the copy on disk** — echoing the mask back never overwrites the real
secret; only real new plaintext updates disk, and an empty string clears the field.

**Masked before 2.8.0**: `providers[].apiKey` and `searchBackend.apiKey`.

**Added in 2.8.0** — every one of these was a real local disclosure surface, because `GET /api/status` is
host-gated only and takes no UI token, so any process on the machine could read the whole set with one request:

- `modelsApiKey`, the Agent CLI model-endpoint key (a top-level config key). It uses the same mould as
  `providers[].apiKey`: seed the mask, echo it back, restore on save.
- `externalMcpServers[].env` and the `headers` of remote entries — **every value**, not a name-based selection.
  The reason is recorded as measured: MCP environment-variable names are chosen by each vendor
  (`GITHUB_PERSONAL_ACCESS_TOKEN`, `X_KEY`, `DB_URL`, and so on) while the normal case here is that the value *is*
  the credential, so picking by name is guaranteed to miss some. The cost is recorded too: non-secret values are
  hidden as well (`PYTHONUTF8=1` shows as `••••1`), and a `${VAR}` reference in a remote header is masked the same
  way (it round-trips correctly). **Key names stay visible**, so operators and the steward can still see which
  variables are configured; to change a value, type the new one.
- `externalMcpServers[].args` gain display redaction, so `--token <value>` or `postgres://user:pw@host` is shown
  as redacted.
- **Credentials inside URLs.** `user:pass@` is stripped and credential-shaped query parameters (`api_key`, `key`,
  `access_token`, `token`, `secret`, `password`, `auth`, `authorization`, `credential`, `sig`, `signature`,
  `session`, including `x-` prefixed forms) have their values masked, while scheme, host, port and path stay
  visible so the endpoint is still identifiable. This covers `providers[].baseUrl` / `audioBaseUrl` /
  `extraBaseUrls`, `searchBackend.baseUrl`, `modelsApiBase`, and the `url` of remote MCP entries. **Outbound calls
  still use the real URL**; a URL with no credential parameter is passed through byte for byte.

**The restore gate for MCP**: after matching the entry by id, the secrets are restored only when the **launch
target is unchanged** — for stdio that is `command`, `cwd` and the whole `args` list; for a remote entry, the
`url`. This closes "I cannot see the key, but I can point it at another program or endpoint". The cost: if the
same save also changed the command, its arguments or the address, those values must be typed again.

**The restore gate for providers, `searchBackend` and `modelsApiKey`: the save is refused, not silently
cleared.** The set of addresses this key actually reaches is `baseUrl` plus `audioBaseUrl` (falling back to
`baseUrl`) plus `extraBaseUrls` — the failover path sends the same `Authorization` to each of them. A save that
**widens** that set while echoing back a masked key returns **409 `config.masked_secret_vector_changed`**, writes
zero bytes, keeps your draft, and names the entry and the fields at issue — never the values. **Narrowing is
unaffected** (removing an `extraBaseUrls` entry, or clearing `audioBaseUrl` so transcription falls back to
`baseUrl`, are both subsets). `searchBackend` (vector: `type` + `baseUrl`) and `modelsApiKey` (vector:
`modelsApiBase`) are compared for equality instead, because an empty `baseUrl` there means "switch to the vendor's
official host", which is a new address. The same check runs on `POST /api/provider/test`, which refuses **without
sending a request**, and on the steward's `steward_config_set`, where the only thing that can trigger it is a
remote MCP `url`.

**The last gate**: sanitization clears any value still carrying the mask before it can reach `config.json`,
`generated/*.mcp.json`, the Claude/Kimi sync artifacts, or a child process environment. The one exception is a
remote MCP `url`, where clearing would make the connector vanish silently, so such an entry is dropped whole
instead — and the refusal above means a normal write never reaches that line.

**Still unmasked, registered so operators know**: `POST /api/mcp/import-config/scan` (token tier) echoes the `env`
and `headers` of `~/.claude.json` and `~/.codex/config.toml` verbatim. The scan-then-apply contract requires the
client to hand back exactly what scan returned, so masking it means changing that contract. No frontend calls it
today; only the test harness does.

**Operational line**: put remote MCP credentials in `headers`, not in the URL.

### Known gaps in 2.8.0 (registered, not fixed)

- **Speech transcription has no outbound URL admission check.** `audioBaseUrl` is treated exactly like `baseUrl`:
  trimmed and length-capped, with no private or loopback rejection. An administrator can point it anywhere on the
  intranet and it will be called. This is a different thing from `web_fetch`'s `ssrfCheck`, which constrains an
  untrusted URL supplied by the model; here the endpoint is one the administrator configured. Tightening it means
  tightening both, or intranet use of the main endpoint breaks too.
- **Speech transcription has no concurrency cap.** There is a 25 MB gate and a 120 s timeout per request, but a
  page holding a UI token can issue them back to back. Single-user on loopback behind the token gate, this is
  assessed as low risk; assess it yourself if a machine is shared.
- **`needs_you` has no event wake-up.** The steward path is poll, debounce, queue, model — there is no "a decision
  is pending, wake the steward now" edge. Measured end-to-end delegation latency: at a 5 s poll, mean 17.7 s and
  max 30.6 s; at the 15 s factory poll, mean 31.5 s and max 42.7 s. Both are well inside `permissionTimeoutMs`
  (120 s), by 2.8x to 11.8x. **But those readings were taken with the steward unthrottled**: when
  `stewardMaxTurnsPerHour` is reached, or the steward is queued behind another turn, a non-scheduled thread can
  wait out the full 120 s and then auto-reject. **Operational line**: lower `stewardPollMs` (factory **15000**,
  clampable down to 5000 — the 5 s readings are clearly better) and leave headroom in `stewardMaxTurnsPerHour`
  (factory **30**), because at the cap the steward cannot run a turn either.
- **`git_*` tools still default to the home directory.** They do not go through the exec gate, so they are not
  part of the "judged here, ran there" class fixed in section 3.
- **The steward decision log is not scrubbed retroactively.** If the steward used `steward_config_set` on
  `externalMcpServers` before 2.8.0, `steward/decisions-v1.ndjson` already holds plaintext and
  `GET /api/steward/decisions` serves `undoRef` as-is. Clean that file by hand if needed.
- **There is no UI editor for MCP `env` / `headers` today.** The Settings panel shows only `commandOrUrl`. "See
  the key names, replace the value" currently has to go through `POST /api/config`, the steward's
  `steward_config_set`, or the model's `mcp_configure`.
- **Obfuscated commands are blocked from delegation, not from running.** Indirect construction (string
  concatenation, `-enc`, `FromBase64String`, `iex`) stops the steward from approving on your behalf, but it does
  not change what counts as a permanently exempt action, so a purely obfuscated command under smart auto still
  does not stop to ask at all.
- **The confirmation on steward setting-change buttons is front-end only.** The server still treats the `act`
  route as the single criterion for "the user pressed it", so a local process that does not go through the browser
  can still POST such an act directly. That route is covered by the route auth table and the UI token, but a
  server-side second credential for the confirm tier is not part of this release.

## 8. Defaults, upgrade, and rollback (2.8.0)

> **Classification**: measured readings plus factory-on means **shipped**; factory-off means **experimental**.
> "Off by default" means an explicit `false`, or an absence that is byte-for-byte equivalent to the previous
> release. All of these are **top-level keys in the data root's `config.json`**; write `false` to turn one off and
> restart the service (a few take effect on the next turn).

### 8.1 Shipped, factory on

| Key | What it is | Reading | Turn it off |
|---|---|---|---|
| `stewardEnabledV1` | Steward master switch (on by default since wave 121; a new install lands in the Steward lens) | e2e plus a manual walkthrough | `false` (falls back to the classic layout, with no background activity) |
| `schedulerEnabledV1` | Scheduled tasks | fake-clock e2e only | `false` (with no tasks it already polls nothing) |
| `newThreadEngine: 'last'` | A new thread follows the engine you last used | API-level e2e only; **changes existing users' default behaviour** | set it to `'global'` |
| `stewardExemptDelegationV1` | The steward may approve permanently exempt, non-floor actions (ten gates; see user guide section 9) | fake-endpoint e2e plus real-model latency, quoted in section 7 | `false` (the same key as the Settings checkbox; **the steward cannot change it itself**) |
| `asrProviderId` / `asrModel` (both empty from the factory) | Voice input | **Unconfigured means zero behaviour**, verified: the microphone node is never built. The default protocol (OpenAI-shaped `/audio/transcriptions`) returned **404 on all four candidate endpoints**, so set "Speech-to-text protocol" to Chat style per provider (`providers[].asrProtocol='chat-audio'`) — MiMo and Bailian verified working, Hunyuan never verified | choose Off for speech recognition, or clear both keys |
| Steward memory `expiresAt` / `scope` | Expiry and scope on remembered lines | e2e; purely additive fields | no switch (absent means permanent and everywhere, as in 2.7.0) |

The engine and context switches carried by 2.7.0 — observation reduction and re-read, session notes, summary
entity checking, single-shot summaries, estimate buckets, the summary fact table, append-only tool schemas,
tool-result caching, and vector memory recall — **were already on by default in 2.7.0** and were simply missing
from that entry; the 2.8.0 changelog records them with their readings. All remain switchable off.

### 8.2 Wave 126's compaction switches: three now on, two still experimental

Each of wave 126's five compaction switches was measured against a real model in paired A/B runs on 2026-09-18.
On those readings **2.8.0 turns three of them on by default** — `runtimeSummaryPromptI18nV1` (English summaries
for an `en-US` UI), `runtimeHistoryReadDedupV1` (repeated full reads in the protected tail become pointers) and
`runtimeReseedTailUnitsV1` (L2 keeps whole units in the tail). The other two,
`runtimeEvaporateBudgetBoundaryV1` and `runtimeReseedReattachFilesV1`, stay off and are not touched by the
upgrade. The full readings are in the Chinese guide's section 7.3 and in the 2.8.0 changelog entry.

**The upgrade rewrites your config for those three.** Flipping a factory default alone reaches nobody: in
`normalizeConfig` the value in `config.json` always wins over the default, and the first config read writes the
whole merged config back — so every machine that ever ran 2.7.0 has `false` on disk. `CONFIG_SCHEMA` therefore
goes to **12** with a one-shot migration: in a config at `configSchema < 12` those three keys are turned on
**even if you had explicitly switched them off**. Anything you switch off *after* 2.8.0 is never touched again
(the migration only fires below 12). To opt out, write the key back to `false` after upgrading. For every other
switch, off by default still means byte for byte identical to the previous release.

### 8.3 Upgrading from 2.7.0

- **`CONFIG_SCHEMA` goes 11 → 12** (wave 107's T1 cut). Apart from the one migration named below there is no
  migration script: other new keys still take their default on the first config read and are written back.
- Upgraders therefore **gain four things without being asked**: steward delegation on
  (`stewardExemptDelegationV1`), so threads on smart auto may now be approved for by the steward; scheduled tasks
  on (`schedulerEnabledV1`), which polls and writes nothing while there are no tasks; new threads following
  the engine last used (`newThreadEngine: 'last'`); and **three compaction switches turned on once**
  (`runtimeSummaryPromptI18nV1`, `runtimeHistoryReadDedupV1`, `runtimeReseedTailUnitsV1`) — **including ones you
  had explicitly switched off**, done by the `configSchema < 12` migration described in section 8.2. An `en-US`
  UI gets English summaries from now on, and summary cost rises about **60%**. Anything you switch off after
  2.8.0 is never reopened. Sections 8.1 and 8.2 say how to turn each one off.
- Voice input is **never** enabled automatically: `asrProviderId` and `asrModel` are both empty from the factory.
- The scheduler's data files are new (`<dataRoot>/scheduler/tasks-v1.json` and `fires-v1.ndjson`) and touch
  nothing that 2.7.0 wrote.

### 8.4 Rolling back to 2.7.0: back up first, or fields are lost silently

**Why a backup is mandatory** — both confirmed by reading 2.7.0's own code:

1. 2.7.0's `sanitizeProvider` **rebuilds** `providers[].models[]` into `{id, label}` and **writes `config.json`
   back on the first config read**, so `models[].caps` (the speech and vector capability tags),
   `providers[].audioBaseUrl`, `providers[].asrProtocol` and `hiddenModels` are gone after one start.
2. 2.7.0's steward-memory normalization **does not know** `expiresAt` or `scope`, so the next memory write
   rewrites the store and drops both fields. The entries themselves survive.

`config.json.prev` keeps only the most recent generation and will not cover this.

**Minimum steps:**

1. **Stop the service**: close the desktop shell, `Ctrl+C`, or end the `Ruyi.exe serve` process, and confirm no
   turn or scheduled task is running.
2. **Back up two things, outside the data root**: `<dataRoot>\config.json` (together with `config.json.prev`) and
   the **whole** `<dataRoot>\steward\` directory (`memory-v1.json`, `decisions-v1.ndjson`, and the rest). Copying
   the entire `<dataRoot>` is safer still.
3. Install 2.7.0, or reapply the older overlay package.
4. **Coming back to 2.8.0, the order matters**: install 2.8.0 first, **then** restore the backed-up `config.json`
   and `steward\` over it, **then** start. Starting first and restoring after lets the startup normalization pass
   run over them once.
5. **If you already downgraded without a backup**: re-tag `models[].caps` for each speech or vector model in
   Settings, re-pick the speech recognition pair, `audioBaseUrl` and the speech-to-text protocol, expect models hidden through `hiddenModels`
   to reappear in the model list, and expect steward memory expiry and scope to be back at permanent and
   everywhere.

**Two more things that happen on a downgrade:**

- **Scheduled tasks do not exist at all in 2.7.0** — the scheduler arrived after it. The `scheduler\` directory is
  left untouched on disk; tasks are still there when you upgrade again, they simply never fired in between.
- **New top-level keys are not deleted.** 2.7.0's `normalizeConfig` lays defaults down and overlays what is on
  disk, keeping unrecognized top-level keys as-is, so `asrProviderId`, `asrModel`, `stewardExemptDelegationV1`,
  `schedulerEnabledV1` and `newThreadEngine` merely go unread and work again after an upgrade. **The only things
  erased are the two classes above**: the **nested** fields inside `providers[]` (`models[].caps`,
  `audioBaseUrl`, `asrProtocol`, `hiddenModels`, rebuilt by `sanitizeProvider`) and steward memory's `expiresAt` / `scope`.

## Brand and compatibility

Ruyi was formerly Win Claude Workbench. The runtime still recognizes old data-root and environment-variable names,
and retains the MCP server identifier win-claude-workbench to avoid breaking existing user configuration. New
documentation and UI use the Ruyi brand.
