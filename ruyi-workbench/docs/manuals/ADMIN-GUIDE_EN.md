# Ruyi Administrator Guide

This is the English companion to [管理员手册](ADMIN-GUIDE_CN.md). It covers local deployment, engine integration,
security boundaries, verification, and troubleshooting. Audience: deployers, IT and intranet operators; the
user-facing instructions are in [USER-GUIDE_EN.md](USER-GUIDE_EN.md).

Hard constraints: Ruyi is a **clean-room implementation**, **`server.js` has zero npm runtime dependencies**, it is
**fully offline with zero telemetry by default**, it is updated **incrementally through overlays** within a version,
and it targets **Windows 10/11**. The product name is "Ruyi". Since 3.0 the MCP server id is `ruyi`, the default data
root is `~/.ruyi-workbench` and the environment variable is `RUYI_HOME` (the old `win-claude-workbench` /
`~/.win-claude-workbench` / `WIN_CLAUDE_WORKBENCH_HOME` are migrated automatically or still read; see "Brand and
compatibility" at the end).

## 1. Deployment model

### Single-file service

Ruyi is a local Windows application. The workbench server is a single Node.js program with no runtime npm
dependencies (Node built-ins only), requiring Node ≥ 20.

```powershell
node app\server.js serve --open        # from source (recommended; edits take effect without a rebuild of the exe)
.\Ruyi.exe serve --open                # packaged exe
Start-Workbench.cmd                    # convenience launcher (runs one of the above)
```

`serve` starts the HTTP server and Web UI; `--open` also opens the browser.

### CLI subcommands

`main()` dispatches on the first argument (default `serve`):

| Subcommand | What it does |
|---|---|
| `serve` | Starts the front end and HTTP API (the main entry). |
| `mcp` | Starts the MCP stdio server for the Claude CLI (a one-shot child process). |
| `mcp-config` | Prints MCP JSON importable by the Claude CLI (including desktop and external MCP). |
| `install` | Tries to register the MCP with the Claude CLI automatically (`claude mcp add-json`). |
| `doctor` | Prints local diagnostics (CLI / git / python / port / overlay integrity and more). |

### Overlay packages

Overlay packages can update an installation incrementally **within the same version**; verify the overlay identifier
and run doctor after applying one. An overlay's `minHostVersion` is the version it was built at
(`tools/build-overlay.js`), and precheck accepts only a host at exactly that version: older, newer, or unknown hosts
are refused (as of 2026-09-19; before that only older hosts were refused, so a newer host could take an older
overlay, a partial downgrade). A cross-version upgrade such as 2.7.0 → 2.8.0 uses the new full package instead
(section 8.3). The launcher (`Start-Workbench.cmd`, `Ruyi.exe`) and the ACC components are not in overlays; they
change only with a full package. Rolling an overlay back also deletes the files that apply added (recorded as
`.overlay-added.json` in the backup). Wave 107's P1 drill confirmed this on real packages: the 2.8.0 overlay reports
`version incompatible` against a 2.7.0 install and writes nothing.

The package layout is `Manage-Overlay.cmd` (thin wrapper) → `Manage-Overlay.ps1` → `payload\` (the files to land
plus `update-manifest.json`, which carries a sha256 per file and `minHostVersion`). Six actions; `precheck` and
`audit` are safety primitives:

```cmd
Manage-Overlay.cmd apply    "C:\...\Ruyi-offline"
Manage-Overlay.cmd rollback "C:\...\Ruyi-offline"
Manage-Overlay.cmd list     "C:\...\Ruyi-offline"
Manage-Overlay.cmd verify   "C:\...\Ruyi-offline"
Manage-Overlay.ps1 -Action precheck -OverlayRoot <extracted package> -Target "C:\...\Ruyi-offline" [-Json] [-Force]
Manage-Overlay.ps1 -Action audit    -Target "C:\...\Ruyi-offline" [-Json]
```

`apply` runs an inline precheck first (a failure refuses and writes nothing, not even the backup folder), then backs
up every file about to be overwritten to `<target>\.overlay-backups\<version>-<timestamp>\`, copies the payload,
writes the `.overlay-applied.json` marker and appends a `.overlay-audit.jsonl` entry, then **verifies every file by
sha256** (the verify result decides the top-level `ok` and the audit `result`, `ok` or `verify_failed`), and keeps
only the five most recent backups. `rollback` restores the latest backup (it **refuses** while the service is
running unless you stop it first; `-Force` skips the port refusal, and the API path passes it automatically because
the API runs inside the service, so the restored files are loaded on restart). Before applying, the script warns if
it finds a workbench on port 8765 / 8799, because the new `server.js` does not take effect while the old one runs.

**Precheck refuses in four cases**: ① path escape (a manifest entry containing `..`, a drive letter or an absolute
path, which would be a zip-slip write); ② integrity (every payload file's sha256 must equal the manifest, which
catches tampered or incomplete packages); ③ version compatibility (see above); ④ idempotence (the same version
already applied and no `-Force`: precheck warns and apply is escalated to a refusal). `-Json` prints one JSON object
for API consumers.

**Applying while the desktop shell is running.** `RuyiDesktop.exe` and `WebView2Loader.dll` are in use and cannot be
overwritten, so for these two the old image is renamed out of the way first (`<name>.old-<timestamp>`; NTFS allows
renaming a running image) and the new file is put in its place; **the new version loads only after the desktop shell is
restarted**. The receipt's `replacedInUse` lists the files handled this way, and leftover `.old-*` files are removed at
the next apply. On `rollback` the `.overlay-applied.json` marker goes back to what it was before the apply (the previous
one is put back from the backup, or the marker is cleared if there was none), so a rolled-back version can be applied
again without the idempotence precheck calling it "already applied". Build an overlay with
`node tools/build-overlay.js <version>`; `<version>` is required, and every package needs a different one.

**In-app update.** **Settings → System → Update Center** (visible in pro mode) drives four token-level routes
(`POST /api/overlay/precheck|apply|rollback` and `GET /api/overlay/status`) and does not carry a second PowerShell
implementation: pick a zip (native file picker) → preview (added / overwritten / unchanged / removed, host and
minimum-version compatibility) → confirm apply → a "restart needed" prompt → on failure a recovery card (one-click
rollback) with the audit tail. The command line remains the rescue path.

After applying, open `http://127.0.0.1:<port>/health`: it should return `{"ok":true,...}`, and the
`overlay-integrity` item in Diagnostics should read `verified`.

### Data root

The data root defaults to .ruyi-workbench under the user profile (called .win-claude-workbench before 3.0; the
first 3.0 start moves it and leaves a directory junction at the old path). Resolution order in `dataRoot()`:

The default HTTP port is 8765 (`--port <n>` → `PORT` → 8765). Ruyi binds `127.0.0.1` only; `--host` with any non-loopback address is refused at startup unless you also pass `--allow-remote` explicitly (and even then non-local peers never receive the page token — see `SECURITY.md`). Ruyi is not a multi-user or public web service.

When the port is taken, Ruyi only takes over **its own data directory's stale instance**: the process holding the port must be the pid recorded in *this data directory's* `runtime.json` (cross-checked against overlayId / image name). A Ruyi instance from another install or another data directory — which may be running a turn — and any other program are never touched. In every other case Ruyi moves on to the first free port in original+1 … original+9; the actual port is written to `runtime.json` and the console URL, and the top bar in the UI says which port is in use. Only when all nine are unavailable does startup fail (leaving `last-start-error.json` for the next start to surface). `killPortOnStart=false` / `WCW_KILL_PORT=0` disables takeover entirely, even of its own stale instance.

## 2. Engine integration

The workbench drives the front end with one engine-agnostic event protocol; two engine paths exist side by side,
chosen by `config.activeProvider`.

### Claude CLI

`activeProvider` empty or `'claude-cli'` (the default). Ruyi spawns the internal `claude` CLI over `stream-json`.
Point Settings to an internal Claude CLI executable or configure it during installation. Ruyi generates and can
register its workbench MCP configuration. If PowerShell JSON quoting breaks Claude's add-json command, use the
non-JSON add form or import the file printed by mcp-config.

- **`claudePath`**: the CLI executable (blank means auto-detect common locations).
- **Third-party endpoint and key (`modelsApiBase` / `modelsApiKey` / `claudeAuthMode`)**: since v1.4.4 these three
  decide two things at once: model-list discovery (`GET /v1/models`) and the environment variables of the actual
  `claude` child process (`buildClaudeCliEnv`). The base URL resolves as `config.modelsApiBase` → the inherited
  `ANTHROPIC_BASE_URL` → `ANTHROPIC_BASE`; the key is written, exactly one of, to `ANTHROPIC_AUTH_TOKEN` (`bearer`,
  most third-party Coding Plans) or `ANTHROPIC_API_KEY` (`x-api-key`, Anthropic's official protocol), and `auto`
  sends both. Changing them under **Settings → Models & Services → Agent CLI** takes effect on the next turn with
  no `setx` and no terminal restart. If discovery fails Ruyi falls back to the built-in model list.
- **`engineMode`**: `legacy` (stdin closed, one-way, stable) or `interactive` (stdin kept open; supports question
  pop-ups and the permission bridge).
- MCP tools are discovered and called natively by the CLI (Ruyi writes its own MCP into the CLI configuration
  through `mcp-config` / `install`).

#### Connecting a third-party Anthropic-compatible endpoint

Claude Code can switch API endpoints through environment variables, so any **Anthropic-compatible** endpoint can be
used — typically a vendor's monthly Coding Plan. Ruyi ships **no vendor presets**: endpoint address, auth style and
model names come from the vendor's own documentation; the placeholder below is `https://api.example.com/anthropic`.

Prerequisites: Node.js ≥ 18 (Ruyi itself needs ≥ 20), Git for Windows (a Claude Code dependency on Windows), and an
API key from the endpoint vendor.

1. **Install the Claude Code CLI.** `npm install -g @anthropic-ai/claude-code`, then `claude.cmd --version`. If the
   system forbids `.ps1` scripts, `claude` resolves to `claude.ps1` and fails with a security error; use
   `claude.cmd` (in `%APPDATA%\npm\claude.cmd`). Ruyi's `detectClaudePath()` finds it automatically, in the order
   `CLAUDE_CLI_PATH` → `claude.cmd` / `claude.exe` on PATH → common install folders.
2. **Point it at the endpoint** with three variables: `ANTHROPIC_BASE_URL` (the endpoint root),
   `ANTHROPIC_AUTH_TOKEN` (a Bearer token — most third-party plans) or `ANTHROPIC_API_KEY` (the `x-api-key`
   header, Anthropic's official protocol; choosing the wrong one usually shows as a 401) and `ANTHROPIC_MODEL`
   (optional). Persist with `setx`, or test in the current session with `$env:`. Many vendors have two different
   base URLs for pay-as-you-go and for the Coding Plan; a wrong one does not error but bills per token instead of
   consuming the plan. **Alternative since v1.4.4 (recommended):** under Settings → Models & Services → Agent CLI →
   "Third-party Anthropic-compatible endpoint (Coding Plan)", choose the "custom" preset, fill in the base URL, the
   authentication method (usually Bearer Token), an optional model list and the key, and save. These fields
   override what the `claude` child receives on the next turn, with no restart and no dependence on inherited OS
   variables; unattended deployments without a UI can keep using `setx`. The workbench setting wins over inherited
   variables.
3. **Check the user-level `~/.claude/settings.json`.** Its `env.ANTHROPIC_BASE_URL` outranks environment variables.
   If it exists and points at `https://api.anthropic.com`, change it to your endpoint; if it does not exist,
   do not create it.
4. **Verify the CLI.** `claude.cmd -p "Reply with exactly: ENDPOINT_OK"` should print `ENDPOINT_OK`.
5. **Bind it to the workbench.** `claudePath` in `~/.ruyi-workbench/config.json` should point at the CLI (for
   example `"claude.cmd"`). Register the MCP server with `node app\server.js install`, or by hand with
   `claude mcp add ruyi --scope user -e "RUYI_HOME=..." -- "<node.exe>" "<workbench>\ruyi-workbench\app\server.js" mcp`.
   `claude mcp add-json` typed by hand in PowerShell loses its JSON double quotes inside `cmd.exe` argument parsing
   (`Invalid configuration: : Invalid input`); the non-JSON `claude mcp add` avoids that. The workbench's own
   `install` goes through Node and passes an argument array, and the bundled `install-workbench.ps1` builds its own
   command line, so neither is affected.
6. **Verify.** `claude mcp list` should show `ruyi - ✔ Connected` (remove a pre-3.0 `win-claude-workbench`
   registration first; `install` does it for you), and `node app\server.js doctor` should show `claudeWorks: true`.
   Then pick the Claude CLI engine in the top bar. The model can be switched in the top-bar model drop-down or under
   Settings → Agent CLI; both take effect on the next turn. With no specific model, the vendor console decides.

| Symptom | What to do |
|---|---|
| `claude` fails with a PowerShell execution-policy error | Use `claude.cmd`, or enter the full `claude.cmd` path in Settings. |
| 401 | Under Settings → Agent CLI set the authentication method to Bearer Token (`ANTHROPIC_AUTH_TOKEN`) or x-api-key (`ANTHROPIC_API_KEY`) explicitly rather than `auto`; check the key is current and belongs to that endpoint. |
| `mcp add-json` says Invalid input | Use `claude mcp add` (step 5). |
| Changed model/endpoint but chats still use the old one | A pre-v1.4.4 defect: the three fields fed only model discovery, not the child's environment. After upgrading they (plus `model`) override inherited values on every turn; if it still does not take, look at the `settings.json` row below. |
| `settings.json` overrides the environment | Check `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json`; it is the CLI's own user-level file and outranks anything the workbench injects. |
| The CLI goes to Bedrock / Vertex, not your endpoint | Once `modelsApiBase` is configured (by `setx` or the UI) the workbench clears `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX`; if that does not help, check whether `settings.json` sets them. |
| `claudePath` detected the wrong CLI | Check for a `CLAUDE_CLI_PATH` variable (highest priority) and remove or correct it. |

**Environment-variable interference and precedence (required reading for maintainers).** The chain is user-level
variables (`setx`) → launching terminal → workbench process → `{ ...process.env }` → workbench overrides → the
Claude CLI child (`buildClaudeCliEnv(config)` / `effectiveAnthropicEnv(config)`). Every user-level variable is still
inherited unchanged; the last layer overrides only when the matching field is filled in under Settings → Agent CLI:
`modelsApiBase` → `ANTHROPIC_BASE_URL` (and `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` are forced empty,
since they make the CLI ignore `ANTHROPIC_BASE_URL` entirely); `modelsApiKey` is written to exactly one of
`ANTHROPIC_AUTH_TOKEN` (`bearer`) or `ANTHROPIC_API_KEY` (`x-api-key`) according to `claudeAuthMode`, and the other
is **forced empty** so the CLI cannot pick the wrong scheme (`auto` keeps the old send-both fallback); `model` →
`ANTHROPIC_MODEL`. A blank field leaves the inherited variable in force. The workbench also injects `RUYI_HOME` and,
when configured, `MAX_THINKING_TOKENS` / `WCW_PERMISSION_TIMEOUT_MS`.

If you use the pure `setx` path, check these when something looks wrong:

| Variable | Risk | Effect |
|---|---|---|
| `CLAUDE_CODE_USE_BEDROCK` | high | `1` makes the CLI use AWS Bedrock and **ignore** `ANTHROPIC_BASE_URL` (cleared automatically once `modelsApiBase` is set) |
| `CLAUDE_CODE_USE_VERTEX` | high | `1` switches to Google Vertex AI, same as above (also cleared) |
| `ANTHROPIC_API_KEY` | high | With `ANTHROPIC_AUTH_TOKEN` also present the CLI may use the wrong scheme (a Bearer endpoint ignores `x-api-key`); the conflicting side is cleared when `modelsApiKey` + `claudeAuthMode` are set |
| `~/.claude/settings.json` → `env.ANTHROPIC_BASE_URL` | high | Outranks environment variables, including the workbench's override; if it points at `https://api.anthropic.com` it overrides your endpoint |
| `CLAUDE_CLI_PATH` | medium | `detectClaudePath()` checks it **first**; a wrong path overrides auto-detection |
| `ANTHROPIC_BASE` | medium | Old base-URL variable that model discovery falls back to (below `ANTHROPIC_BASE_URL`) |
| `RUYI_HOME` / `WIN_CLAUDE_WORKBENCH_HOME` | medium | Moves the data root, so the existing `config.json` and MCP configuration are not found |
| `WCW_KILL_PORT=0` | low | Disables port takeover: a taken 8765 is not freed, Ruyi moves to the next port |
| `WCW_FAKE_CLAUDE` | low | Test only, points at a fake CLI script (**never set in production**) |
| `MAX_THINKING_TOKENS` | low | Caps thinking tokens (the workbench overrides it with `config.thinkingBudget`) |

> **Maintenance rule**: when the CLI misbehaves after you change the third-party endpoint, check the variables above
> and `~/.claude/settings.json` first. Most "configured correctly but the CLI does not use my endpoint" cases are a
> user-level variable or `settings.json` silently overriding.

### OpenAI-compatible providers

`activeProvider` is some `providers[].id`. The engine speaks HTTP + SSE directly and has its own **native tool loop**
(local MCP tools are translated to function calling; the iteration limit `openaiMaxToolIterations` defaults to 100:
a base budget of 1..200, with long turns starting at 200 and allowed to extend to a hard cap of 300 while they make
progress). Add a provider with an ID, display label, base URL, API key, and model. Ruyi ships **no vendor presets**:
the starting templates under Settings → Models & Services → Model providers are local Ollama
(`http://127.0.0.1:11434/v1`), local LM Studio (`http://127.0.0.1:1234/v1`; neither needs a key) and one "custom (OpenAI-compatible / self-hosted)"
entry (a standing rule since 2026-09-27, locked by `start-experience.static`; there is no second one); anything else (a
cloud API, an Anthropic-compatible gateway, a one-api gateway, an on-prem vLLM or Xinference) goes through "custom" as a
hand-entered base URL and key. The protocol drop-down (`apiStyle`) sits right under the Base URL and is **inferred from
the address**: `api.anthropic.com`, a path ending in `/anthropic` (or `/anthropic/vN`), or one ending in `/messages` means
Anthropic Messages; `/chat/completions` means Chat; `/responses` means Responses. Once the user picks a protocol by hand
the address stops changing it, and when the address box loses focus a pasted `/v1/messages`, `/chat/completions` or
`/responses` suffix is stripped. "Test connection" reads the endpoint's model list; when the endpoint has none (404 /
405 / 501, or an empty list) it falls back to one minimal completion with the configured model, and asks for a model if
none is set.
Test the connection in Settings before production use. API keys remain on the local machine and are masked in
ordinary API responses.

Provider fields (normalized by `sanitizeProvider`):

| Field | Meaning |
|---|---|
| `id` / `label` | Identifier / display name |
| `baseUrl` | Endpoint root |
| `apiStyle` | Wire protocol: `chat` (Chat Completions, the default), `responses` (Responses API) or `anthropic` (Anthropic Messages: Anthropic itself and Anthropic-compatible gateways); the main turn, sub-agents, summaries and Playbook drafting all follow it |
| `extraBaseUrls` | Backup endpoints (≤ 3, for failover, below) |
| `apiKey` | Key (masked in responses, section 7) |
| `model` / `models` | Current model / model list |
| `vision` / `reasoning` | Vision loop / reasoning-chain switches |
| `contextWindow` | Context window size (used by automatic compaction) |
| `systemPrompt` | Provider-layer addition to the system prompt |
| `subagentModel` | Model for sub-agents (empty means the main model) |
| `temperature` / `extraHeaders` | Sampling temperature / extra request headers |

**`extraBaseUrls` failover semantics (v1.0-S6)** — the one rule to understand when you wire up several endpoints:

- The candidate sequence is `[baseUrl, ...extraBaseUrls]` (de-duplicated), and Ruyi moves to the next **only on a
  pre-first-byte failure**: a connection-class error (ECONNREFUSED / ETIMEDOUT / ENOTFOUND / EHOSTUNREACH /
  ECONNRESET / TLS handshake failure) or an HTTP **502 / 503 / 504** at the header stage (an unavailable upstream
  gateway).
- It does **not** switch (the attribution is kept, because another endpoint would not help or would hide a real
  problem) for **4xx (including 401 / 403 / 404 / 422), 429 rate limiting, or any error after the SSE body has
  started streaming** (replay protection).
- A switch emits a `failover` event `{type:'failover', providerId, from, to, reason}` and an audit record.
- **Sticky within a session**: the endpoint that last succeeded is tried first on the next turn; stickiness lives
  only in process memory and is cleared on exit.

Since 2.8.0, **changing a provider's endpoint while leaving the masked key in place fails the save.** The key box in
Settings holds the mask, and the base-URL box sits next to it, so this is a normal operation rather than an attack;
the save is refused as a whole (HTTP 409, code `config.masked_secret_vector_changed`), nothing is written, your
draft survives, and the message names the entry and asks you to type the key again or clear the key box explicitly.
See section 7.

### Desktop MCP and honest metering

ai-computer-control (ACC) is optional. Install its required Python environment only where desktop/Office control is
needed. ACC v1.9.1 exposes 108 tools (the exact count is `accTools` in the repository's `facts.json`): screenshots,
window control, OCR, UIA, keyboard and mouse, browser, Word / Excel / PowerPoint / PDF reading and writing
(including `write_pdf` with a Chinese-capable font chain) and more. It reaches the workbench two ways:

- **Supplying the Claude CLI**: when `.mcp.json` is generated, `ai-computer-control` and the enabled
  `externalMcpServers` are written in together, and the CLI calls them natively.
- **Supplying the provider engine**: with `bridgeExternalToolsToProvider` on, the same tools are bridged through an
  in-process MCP stdio client into the native tool loop; off, the provider engine sees only the workbench's own
  tools. Bridged tools are tiered by `BRIDGED_TOOL_TIERS` (the ACC read-only family → read, everything else
  defaults to exec; `config.bridgedToolTiers` can override).

`detectDesktopMcp()` recognises an `ai-computer-control` checkout (it contains `src/ai_computer_control/server.py`),
preferring `AI_COMPUTER_CONTROL_HOME`, and launches it with `python -X utf8 -m ai_computer_control.server`. The
config is `desktopMcp { enabled, command, args, cwd, autodetect }`.

Browser mode defaults to `system`, which opens a new tab/window in the user's associated browser without owning or
closing it; the active Ruyi Workbench tab is never navigated, reused, or closed. `managed` (Playwright with the
default Chromium browser and renderer accessibility, which may open a separate automation window), `custom` (a
browser executable you name), `cdp` (an existing browser with a debugging port) and the explicitly isolated
`bundled` (Chrome for Testing) are available through `browserAutomation { mode, executable, cdpUrl }`, under
**Settings → Tools & integrations → Integrations and MCP**. When an accelerated browser surface lacks a UIA
Document tree, UIA/observe results carry `accessibilityLimited` and callers should stop retrying UIA and switch, in
order, to CDP/DOM, OCR coordinates, then screenshot coordinates. Direct3D pixels have no control semantics; for a
self-drawn application only an AutomationPeer/UIA provider in that application can restore a real element tree.

**Transports and tool surface.** The ACC server has exactly one transport, `stdio` (`mcp.run(transport="stdio")` in
`server.py`), and the workbench launches it as a local child process. The workbench acts as an MCP client for
**external** connectors, where `stdio`, `sse` and `http` forms are recognised (see the importer below). To trim
ACC's tool surface per deployment, set the environment variable `ACC_TOOLSETS` on the ACC process: comma-separated
capability names (`desktop`, `office`, `browser`, `filesystem`, `shell`, `uia`, `ocr`, `vision`, `macro`, `memory`,
`web`, `thinking`, `observe`, `audio`, `sync`), for example `filesystem,shell,office`. Unset means everything;
`audit` and `diagnostics` are always registered; an unknown name is ignored with one line on stderr. There is **no**
`toolset` field in the workbench's MCP configuration; on the workbench side, desktop tools are tightened through
permission tiers (`BRIDGED_TOOL_TIERS` / `config.bridgedToolTiers`) and a role's tool allowlist.

**MCP configuration importer (48c).** The Integrations and MCP page accepts a pasted or imported external `mcp.json`
fragment, validates its schema, merges it into the current configuration and applies it at once (no hand-editing of
`~/.ruyi-workbench/generated/.mcp.json`). Duplicates are handled as "keep the local one, report the conflict" by
server id.

**Offline wheels.** ACC supports offline deployment: `python installer/build_offline_package.py` (needs internet
once) builds a zip with CPython 3.12, every wheel and Playwright Chromium; on the target, unzip and run `install.bat`.
Default OCR uses the offline Windows.Media.Ocr API through `winsdk`, not Tesseract. Full packages contain and verify
CPython 3.12 plus the cp312 `winsdk` wheel during both build and installation (CPython 3.12 because that is the
version providing a cp312 wheel). For an overlay on an older installation, run `update.bat --deps` before
`update.bat --code` so `uiautomation`, `comtypes`, and `winsdk` are installed from the local wheel cache. A missing
optional dependency degrades only its own tools. `write_pdf` registers Chinese fonts in the order Microsoft YaHei →
SimSun → built-in STSong-Light CID → Helvetica.

The read-tier `mcp_list` tool returns connector metadata and environment-variable names, never secret values. The
exec-tier `mcp_configure` tool can persist external connector or browser-target changes only after an explicit user
request and the normal permission confirmation; it cannot replace the built-in ACC executable or lower tool tiers.

### Usage accounting

Usage accounting appends to `dataRoot/usage/YYYY-MM.jsonl`, one record per turn, sub-agent run or auxiliary call
(`{engine, provider, model, inTok, outTok, cost, currency, costTrusted, estimated, kind}`), and groups token and
estimated cost by engine, provider, chat, and currency without ever converting between currencies.
`GET /api/usage/summary?range=today|week|month|all` (token required) aggregates it. Cost trust is graded honestly:

- **Anthropic direct** (`config.modelsApiBase` empty and no third-party override): the CLI's own `total_cost_usd` is
  booked as a notional USD cost, `costTrusted: true`.
- **Third-party Coding Plan** (`modelsApiBase` or the OS `ANTHROPIC_BASE_URL` points at a third-party endpoint): the
  CLI cost is priced as Anthropic and means nothing for that vendor, so it is `costTrusted: false`, labelled
  plan-included, **excluded from the real-spend total**, and only tokens are recorded.
- **OpenAI-compatible providers**: a cost is computed only when `provider.pricing {inputPerM, outputPerM, currency}`
  is set; otherwise only tokens.
- `config.claudePricing {inputPerM, outputPerM, currency}`: with a price set for the Claude engine, any endpoint
  yields a trusted token × price cost.

Every path is metered: main turns, workflow sub-agents (`kind: 'subagent'`), automatic and manual compaction
summaries and Playbook drafting (`kind: 'aux'`). With `config.usageBudget {monthly, currency}` set, the dashboard
shows this month's trusted spend and a budget warning.

### Voice transcription

Speech recognition, when configured, reuses the same provider record: `audioBaseUrl` (falling back to `baseUrl`)
plus the same API key. Which dialect Ruyi speaks to it is a per-provider setting, `providers[].asrProtocol`:
`transcriptions` (the OpenAI-shaped multipart `/audio/transcriptions`, the default, and the only shape before
2.8.0) or `chat-audio` (`/chat/completions` with an `input_audio` data URI, which is how MiMo and Bailian
document ASR). Bailian's Fun-ASR models (`fun-asr-*`) are not served on the OpenAI-compatible path
(it answers 400 with an empty `{}`), so on a chat-style provider Ruyi sends those models to DashScope's native
`/api/v1/services/aigc/multimodal-generation/generation` instead; Qwen3-ASR on the same provider stays on
`/chat/completions`. A provider that speaks neither cannot do voice at all, and Ruyi says so rather than guessing.
Chat style only accepts the formats the upstream declares — MiMo refuses webm with a plain 400 — so microphone
recordings are converted to 16 kHz mono WAV in the browser before upload, while audio attachments and the
`audio_transcribe` tool send the user's original file untranscoded.

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

The security model is written as the code behaves; each item below is a live mechanism.

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

### Permission levels and tool tiers

The permission levels are `PERMISSION_MODES = ['default','acceptEdits','plan','auto','bypass']` (five levels,
`01e-permission-modes.js`; the UI names are in parentheses). Every tool has a tier, **read / edit / exec**
(`NATIVE_TOOL_TIER`: the read family such as `file_read`, `file_list`, `glob`, `git_status`, `git_diff`, `git_log`,
`web_search`, `web_fetch`, `todo_write` is read; `file_write`, `file_edit`, `file_delete` are edit;
`powershell_run`, `script_run`, `http_request`, `git_commit`, `spawn_agent`, `shell_start` and similar are exec).
The gate `nativeToolGate(mode, tier)` is:

| Level | read | edit | exec |
|---|---|---|---|
| `bypass` (Fully automatic) | allow | allow | allow |
| `auto` (Smart auto, the default for new installs) | allow | allow | allow, except permanently exempt actions (deleting data, installing or uninstalling software, pushing, sending outbound; see user guide section 9) and commands built by concatenation, encoding or evaluation, which still ask |
| `default` (Ask me every step) | allow | ask | ask |
| `acceptEdits` (Edit files without asking) | allow | allow | ask |
| `plan` (Plan only) | allow | block | block |

The UI names are the ones on the top-bar shield and the thread header's permission chip: Ask me every step / Edit
files without asking / Plan only / Smart auto / Fully automatic. The scheduled-task form's "How far it may go on its
own" drop-down uses the same names.

`git_commit` is deliberately **exec** (it triggers arbitrary code in `.git/hooks` and is never downgraded). Plan-mode
approval is a **per-turn closure flag** and never changes the global `config.permissionMode` (so one approval cannot
grant permanent permission). Sub-agent tiers also have a second gate at execution time: even under bypass, a
read-tier sub-turn cannot write a file. Read- and edit-level sub-agents on both engines may search the web: the
provider engine has `web_search` / `web_fetch` (read tier, SSRF guards unchanged) and the Claude engine's read/edit
allowlist includes `WebSearch` / `WebFetch`. Bridged MCP tools (including ACC) take part on the provider engine by
`BRIDGED_TOOL_TIERS`: a read sub-agent may use the bridged read family, edit adds edit-tier tools, exec gets all.
Asymmetric by design: the Claude engine's `--mcp-config` stays mounted at exec level only, because the CLI's
`--allowed-tools` is not a hard limit under bypass, so mounting the bridge earlier would leak full desktop control.

### UI token gate

Since v2.0 the token is no longer embedded in HTML: after the page loads, the browser asks the server for a session
token over `POST /api/bootstrap`, keeps it in `sessionStorage` rather than the DOM, and attaches it as the
`x-wcw-token` header to every later sensitive request. The deny-by-default host gate (wave 33) lets only configured
hosts through token validation and rejects other processes on the machine and cross-origin requests. The
`needsToken` allowlist includes `/api/tools/*`, `/api/checkpoints/*` (rollback), `/api/session/rewind`, `/api/steer`,
`/api/config`, `/api/provider/test`, `/api/playbooks*`, `/api/workspace/resolve`, `/api/pick-folder`,
`/api/file/preview`, `/api/plan/decision` and `/api/audit`. Exceptions: `/api/permission/request` and `/api/todo` are
called from a child process over loopback and use a **body token** instead. A new token-gated endpoint must extend the
allowlist explicitly; the expression does not cover new paths automatically.

### SSRF scope

The `url` of `web_fetch` is **untrusted input from the model or a page**, and `ssrfCheck` hard-defends it: by literal
host it refuses loopback (`localhost` / `::1` / `0.0.0.0`), private ranges (`10.`, `172.16-31.`, `192.168.`),
link-local and cloud metadata (`169.254.169.254`), IPv6 ULA and link-local, NAT64 `64:ff9b::/96`, IPv4-mapped IPv6
that embeds a private address, and the `.local` / `.internal` suffixes; only http/https; redirects are re-checked per
hop (≤ 3), and each hop's `dns.lookup` that lands on a private address is refused (closing DNS rebinding).

**The key distinction**: the **search backend's `baseUrl` is a trusted endpoint configured by the administrator, and
its outbound traffic does not go through SSRF checks** (an administrator may legitimately point `web_search` at an
intranet SearXNG or an enterprise search proxy). The code comments distinguish the two explicitly: only
`web_fetch`'s untrusted URL is restricted.

### Audit log, checkpoints, telemetry

`logEvent` appends to `dataRoot/logs/workbench-<day>.ndjson` (local NDJSON, never sent anywhere). `GET /api/audit`
(token required) read-aggregates two sources, the workbench log and the desktop MCP's `audit_tail`, merged in
descending time order with `limit` clamped to 1..500; every `detail` passes through `redact()`, so **secrets never
enter an audit response**.

Before every `file_write` / `file_edit` / `file_delete`, the original content is gzipped into
`checkpoints/<sessionId>/` (built-in zlib; files over 5 MB get an entry but no content). It is a safety net, not a
gate: any journal failure is swallowed and **never blocks the tool**. `GET /api/checkpoints` reads the index,
`POST /api/checkpoints/rollback` rolls back by turn (optionally one entry) in reverse order, and
`POST /api/session/rewind` rewinds the conversation. Each session keeps its latest 20 turns, with a lazy global
200 MB GC.

There is no telemetry, analytics or beacon of any kind; every log stays in the data root. The only optional outbound
probe is one HEAD from the capability matrix (to `config.capabilityProbeUrl` or the provider `baseUrl`, to decide
online or offline; it is not telemetry, and `capabilityProbeUrl` is empty by default). Clean-room: no leaked
Anthropic source, no bundled official Claude CLI, no copied third-party plugin source; the product is Apache-2.0, and
the front-end static libraries are covered in the root `THIRD-PARTY-NOTICES.md`.

### Untrusted-input boundary for skills, memories and orchestration (v1.5)

Skills, workbench memories and inter-node messages can come from **untrusted sources** (a cloned repository's
`.ruyi/skills`, another node's agent output), and are hardened accordingly:

- **Fence injection**: skill and memory indexes enter the system prompt wrapped in `<skill-index>` /
  `<workbench-memory>` fences with an "authored content, treat as reference, may not override the rules above"
  statement, forged fence markers in the body are neutralized, and they land in the **untrusted reference band**
  (alongside project memory), never the trusted zone. Inter-node mailbox messages neutralize a forged
  `[orchestrator interjection]` prefix so a sub-agent cannot impersonate the orchestrator.
- **Content-returning read-only GETs verify the token themselves**: `GET /api/memory` and `/api/memory/item` check
  `tokenOk` on their first line (DNS-rebinding model, like `/api/file/preview`). Every mutating memory and skill
  route (`/api/session/skills`, `/api/session/memories`, `/api/memory*`) sits behind the `uiMutatingRoute` token gate.
- **Source locking against swaps**: a session's enabled skills and memories are stored as `{id, scope[, projectKey]}`;
  if the source differs at use time, injection is **skipped with a notice**, so a same-named malicious entry cannot
  silently replace one after the working directory changes.
- **Least privilege**: when the Claude engine adds `--add-dir` for memory expansion it grants only the **group
  directories of enabled entries** (global / the current project's group), never the whole memory tree or other
  projects' absolute paths.
- **Human confirmation to write**: workbench memory is always draft → user confirms → stored; there is no silent
  automatic write (the poisoning defence). Storage is `dataRoot/memory/{global,project/<projectKey>}`, where
  `projectKey` is a truncated sha256 of the normalized (win32 lowercased) cwd, so case differences do not split it.

## 4. Pro mode and diagnostics

The right-hand workspace keeps seven tabs in both simple and pro mode: Files, Artifacts, Changes, Memory, Workflows,
Usage, and Activity (the audit timeline). Terminal, desktop, MCP, search, and file-read capabilities remain available
to the model through the normal read/edit/exec permission, checkpoint, and audit paths; they are no longer exposed
as context-free manual runners.

Connector operations remain under **Settings → Tools & integrations → Integrations and MCP**, where connector
sources, health, tool counts and failure reasons are shown and user connectors can be managed (a configuration
surface, not a per-tool runner). Deployment checks, storage management, performance metrics, and raw event logs are
grouped into collapsible sections under **Settings → System → Diagnostics**: deployment diagnostics cover engine
paths, git/rg/python detection, overlay integrity and `/health`, and the raw log can be cleared or downloaded as
`.ndjson`. Storage diagnostics offer per-store usage analysis, retention policy and manual cleanup, and
`GET /api/metrics` (token required) returns process memory, request-time percentiles (P50/P95/P99) and storage
trends for operations monitoring.

## 5. Acceptance and regression

The harness lives in `dev-harness/` (plain Node, no npm, offline). Each end-to-end test is self-contained: it spawns
a fake provider and the workbench, asserts, cleans up, and its last line is a verdict such as `<NAME> E2E: ALL PASS`
(exit code 0 means green). Run tests serially because fixtures use fixed local ports:

    npm.cmd test

The fast static route is:

    npm.cmd test -- --fast

`npm test` is `node ../dev-harness/run-all.js`; `--parallel 4` runs four lanes and `--fast` runs only the `.static`
pure static locks. The default regression skips seven live probes (`deepseek-live`, `deepseek-tools`,
`desktop-bridge-live`, `claude-binary-live`, `claude-compact-probe-live`, `compact-quality-live`,
`prompt-cache-discipline-live`) that need a real key, a real CLI or a real desktop; the totals are `e2eCount` and
`e2eLiveSkipped` in the repository's `facts.json`.

Live provider and desktop tests require a real key or Python environment and are skipped by default. For a new
provider, test model listing, streaming text, tool calls, an error response, usage reporting, and a restart.
`desktop-bridge-live` needs the real Python desktop MCP (`pip install -e` of ACC); `desktop-mcp-smoke` needs
`AI_COMPUTER_CONTROL_HOME` pointing at an ACC checkout (it skips gracefully without the `mcp` library);
`model-tier-probe.js` is a live evaluation, not part of the offline regression: `node dev-harness\model-tier-probe.js
<KEY> <MODEL>` runs the same agentic scenarios against different model tiers (tool-call discipline, multi-step
chaining, resistance to hallucination, parallel format), which is the basis for deciding whether a small model needs
targeted prompt relief, format self-repair, tighter concurrency or loop-guard thresholds before production.

ACC smoke tests (from `mcp/ai-computer-control`, after `pip install -e .` or an offline install from
`requirements_offline.txt`): `python -X utf8 tests\smoke_registry.py` (tool registry, 108 tools),
`tests\smoke_stdio.py` (both stdio launch forms in full, the key regression) and `tests\smoke_v13.py`
(semantics, audit, degradation).

## 6. Troubleshooting

Use Ruyi.exe doctor first. Verify the selected engine, provider base URL and model, CLI path, MCP registration,
loopback port availability, data-root permissions, and desktop Python environment. Keep server logs and the audit
timeline when escalating an issue; do not paste unmasked keys or chat content into public reports.

| Symptom | What to do |
|---|---|
| **Port taken** | On the default 8765, only a stale instance registered by **this data directory** (the pid in its `runtime.json`) is ended and retried on the same port, and only while `killPortOnStart` is not disabled; other Ruyi instances (another install or data directory) and other programs are left alone, and Ruyi moves on to the next free port (port+1 … port+9; the top banner names the actual port, `runtime.json` records it). Only when every candidate is taken does the start fail; to pin a port use `--port <n>` and end the holder by hand first. |
| **Engine 401** | Claude CLI: check `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` (or the model-endpoint base and key in Settings). Provider: check the apiKey. A **401 does not trigger endpoint failover** (the attribution is kept), so a backup endpoint will not help; fix the key first. |
| **Stream drops / failover notice** | A `failover` event means the primary endpoint was unavailable before the first byte and a backup was used (connection failure or 502/503/504). If the backup is down too the turn finally errors. A break after the SSE body has started never switches endpoints (replay protection); resend the turn. |
| **Search backend unreachable** | Check `searchBackend.type` and its baseUrl (required for searxng/custom) and apiKey (required for bing/brave and tavily, optional for bocha). The search backend is a **trusted endpoint, outside SSRF checks**, but must still be reachable. Offline, `web_fetch` falls back to the local webcache (`fromCache: true`). |
| **PDF fonts / CID fallback** | On a machine without Microsoft YaHei or SimSun, `write_pdf` (an ACC tool) falls back to the built-in `STSong-Light` (CID, no external file, Chinese rendered by the reader); this is **expected**, and the returned `font` field names the font actually used. Without reportlab the whole of `write_pdf` degrades gracefully without affecting other tools. |
| **Performance / large sessions** | Long conversations are virtualized and paged in the UI; near the window limit, automatic or manual compaction runs (`autoCompactThreshold` defaults to 0.8 × `contextWindow`), and the providerHistory snapshot is stored first at `checkpoints/<sid>/history-*.json.gz`. |
| **Permission prompt timeout** | Permission and question prompts **default to no time limit**: `permissionTimeoutMs` and `questionTimeoutMs` ship as 0, so a prompt waits for you and folds into the small tray at the bottom right. If you set a limit (Settings → Permissions & safety → "How long to wait for you"; permission 5–600 s, question 1–60 min), a permission request is **rejected** at the deadline and a question is cancelled (Ruyi never grants permission for you). An unattended scheduled task rejects after `schedulerAskWaitMinutes` (30 minutes by default). |

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

Masking takes effect in many places through one code path: `GET /api/status`, the reply of `POST /api/config`,
`steward_config_get`, the replies of `mcp_list` / `mcp_configure`, the folder-import reply, and the `before` /
`applied` fields of the steward decision log. The Claude Code auto-import (`autoImportClaudeCodeMcp`, on by default)
copies token-bearing `env` blocks from `~/.claude.json` into the workbench verbatim, so before 2.8.0 this was a real
exposure on real machines.

**The restore gate for MCP**: after matching the entry by id, the secrets are restored only when the **launch
target is unchanged** — for stdio that is `command`, `cwd` and the whole `args` list; for a remote entry, the
`url`. This closes "I cannot see the key, but I can point it at another program or endpoint" (otherwise an echoed
mask becomes a handle: the steward proposes a patch that swaps `command` while `env` stays masked, the user presses
the button, and the keys go along to the new program). The cost: if the same save also changed the command, its
arguments or the address, those values must be typed again.

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

**The last gate**: `sanitizeExternalMcpServer` clears any value still carrying the mask (and any arg still carrying
a redaction marker) before it can reach `config.json`, `generated/*.mcp.json`, the Claude/Kimi sync artifacts, or a
child process environment; it runs on every config read and write, folder import, `import-config/apply`,
`mcp_configure upsert`, the Claude Code auto-import and the drop-in runtime merge. The one exception is a
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
- **`needs_you` event wake-up (added 2026-10; this entry is withdrawn).** Before, the steward path was poll,
  debounce, queue, model, with a measured mean delegation latency of 31.5 s at the 15 s factory poll. Now a new
  pending decision immediately triggers an extra inbox tick (the `thread.needs_you` event, ticks at 0.4 s and
  2.5 s), and the steward's turn debounce drops from 5 s to 1 s whenever a thread is blocked on a permission or
  question: pending-to-inbox measured about 0.45 s against a fake endpoint, leaving one round trip of the steward
  model. **A second correction**: `permissionTimeoutMs` has shipped as **0 (no limit)** since 2026-09-24, so an
  ordinary thread's permission request is never auto-rejected because the steward was slow; only when you set a
  limit in Settings does a steward-mediated thread wait at least 600 s; unattended scheduled tasks reject after
  `schedulerAskWaitMinutes` (factory 30 minutes). Keep headroom in `stewardMaxTurnsPerHour` (factory **30**):
  at the cap the steward cannot run a turn either.
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

## 8. Defaults, upgrade, and rollback (2.8.0 baseline; the 3.0 preview supplement is section 8.5)

> **Classification**: measured readings plus factory-on means **shipped**; factory-off means **experimental**.
> "Off by default" means an explicit `false`, or an absence that is byte-for-byte equivalent to the previous
> release; **for the three switches that were flipped on, only an explicit `false` is the previous behaviour, an
> absence no longer is**. Evidence that comes only from a fake endpoint (fake provider or fake clock) is marked ⚠.
> All of these are **top-level keys in the data root's `config.json`**; write `false` to turn one off and
> restart the service (a few take effect on the next turn). This section lists the ones 2.8.0 calls out, not the
> whole defaults block of `01-config.js`.

### 8.1 Shipped, factory on

Engine and context switches. The first eight of these **were already on by default in 2.7.0** and were simply
missing from that release's notes; the 2.8.0 changelog records them with their readings. All remain switchable off.

| Key | What it is | Reading | Turn it off |
|---|---|---|---|
| `runtimeObservationReducerV1` + `runtimeObservationRecallV1` | Observation reduction; the model can re-read the original through the embedded `rawRef` | Real history context use **−81.0%**, re-read byte-identical, recall adopted 5/5 | write `false` to both |
| `runtimeSessionNotesV1` / `runtimeSessionNotesInjectV1` / `runtimeSessionNotesMergeV1` | Session notes kept in a sidecar file and re-injected | ⚠ qualitative plus fake-endpoint end to end | `false` each |
| `runtimeSummaryEntityCheckV1` | After an L2 summary, a deterministic spot check of paths / versions / numbers / dates / code names, with **exactly one** targeted repair when something is missing | Missing entities after repair: 0 | `false` |
| `runtimeSummarySingleShotV1` (+ `summarySingleShotMaxTokensV1`, factory 32768) | Single-shot summary first; falls back to map-reduce only when the upstream really reports an overflow | Total gate **88.9% / ¥0.1352** against map-reduce 77.8% / ¥0.1945 | `false` |
| `runtimeEstimateBucketsV1` | Token estimation bucketed by JSON / code / prose | Deterministic readings only (no real-model A/B) | `false` |
| `runtimeSummaryFactTableV1` (+ `summaryFactTableMaxSamplesV1`, factory 64) | Injects a global fact table during map-reduce, no extra model calls | Single-item entity retention **+56.2pp**; **the same run's total gate is mixed: 66.7% against 77.8%** — recorded as is | `false` |
| `runtimeAppendOnlyToolSchemasV1` | The tools schema is frozen in order within a session and only appended to | Real A/B cached-input **+23.9pp**, quality 4/4 | `false` |
| `runtimeExecResultCacheV1` (+ `execResultCacheMaxEntriesV1`, factory 200) | `file_read` read-only results cached per session, re-authorized and re-stat'ed before a hit | Hit **+17–24pp**; tool-phase time about 311 ms → 112 ms (**about −64%**), 12/12 correct | `false`, or set the limit to 0 |
| `runtimeMemoryVectorRecallV1` | Offline vector layer for memory recall, fused with the lexical layer by RRF | Synthetic gate Recall@3 90% → 95% (**+5pp, short of the originally preset +10pp auto-flip line; the user decided on 2026-09-04 to turn it on anyway**) | `false` (back to purely lexical ranking) |
| `sessionSearchIndexV1` | The sidebar search can search chat bodies | Functional; the old substring filter remains as the fallback | `false` |

A reading update for `runtimeMemoryVectorRecallV1` (3.0 preview walkthrough): the "Recall@3 90% → 95%" in the table is the
reading from when it was introduced. Since the walkthrough the vector layer is only a **re-ranker** — admission of
candidates belongs to the lexical layer (which now includes spelling tolerance up to one edit), and a candidate only the
vector layer found needs cosine ≥ 0.25 and ≥ 0.6 × the top vector score to get in. The one case in the old +5pp (spelling
drift) is now won by the lexical layer, and in `memory-recall-quality` the fused ranking and the purely lexical one both
score 19/20. Turning it off just returns to purely lexical ranking and loses no recall; whether it stays on by default
is for you to decide.

Product features:

| Key | What it is | Reading | Turn it off |
|---|---|---|---|
| `stewardEnabledV1` | Steward master switch (on by default since wave 121; a new install lands in the Steward lens) | e2e plus a manual walkthrough | `false` (back to the Workbench lens, with no background activity) |
| `schedulerEnabledV1` | Scheduled tasks | ⚠ fake-clock e2e only | `false` (with no tasks it already polls nothing) |
| `newThreadEngine: 'last'` | A new thread follows the engine you last used | ⚠ API-level e2e only; **changes existing users' default behaviour** | set it to `'global'` |
| `stewardExemptDelegationV1` | The steward may approve permanently exempt, non-floor actions (ten gates; see user guide section 9) | ⚠ 46 fake-endpoint cases; **measured real steward-model latency**: mean 17.7 s / max 30.6 s at the 5 s poll, mean 31.5 s / max 42.7 s at the 15 s poll (the factory value), all five delegations succeeded and every audit line matched; since 2026-10 there is event wake-up, see the correction in section 7 | `false` (the same key as the Settings checkbox; **the steward cannot change it itself**) |
| `asrProviderId` / `asrModel` (both empty from the factory) | Voice input | **Unconfigured means zero behaviour**, verified: the microphone node is never built. The default protocol (OpenAI-shaped `/audio/transcriptions`) returned **404 on all four candidate endpoints**, so set "Speech-to-text protocol" to Chat style per provider (`providers[].asrProtocol='chat-audio'`) — MiMo and Bailian verified working, Hunyuan never verified | choose Off for speech recognition, or clear both keys |
| Steward memory `expiresAt` / `scope` | Expiry and scope on remembered lines | e2e; purely additive fields | no switch (absent means permanent and everywhere, as in 2.7.0) |

### 8.2 Wave 126's compaction switches: three now on, two still experimental

Each of wave 126's five compaction switches was measured against a real model in paired A/B runs on 2026-09-18
(`deepseek-v4-flash` at `api.deepseek.com`, **6 pairs** per switch and 18 pairs for 111c, with the window scaled down
to 30000 to control cost, calling the product's own compaction primitives in process, with each switch gated in the
product's own decision function). On those readings **2.8.0 turns three of them on by default** —
`runtimeSummaryPromptI18nV1` (English summaries for an `en-US` UI), `runtimeHistoryReadDedupV1` (repeated full reads
in the protected tail become pointers) and `runtimeReseedTailUnitsV1` (L2 keeps whole units in the tail). The other
two, `runtimeEvaporateBudgetBoundaryV1` and `runtimeReseedReattachFilesV1`, stay off and are not touched by the
upgrade.

**The upgrade rewrites your config for those three.** Flipping a factory default alone reaches nobody: in
`normalizeConfig` the value in `config.json` always wins over the default, and the first config read writes the
whole merged config back — so every machine that ever ran 2.7.0 has `false` on disk. `CONFIG_SCHEMA` therefore
goes to **12** with a one-shot migration: in a config at `configSchema < 12` those three keys are turned on
**even if you had explicitly switched them off**. Anything you switch off *after* 2.8.0 is never touched again
(the migration only fires below 12). To opt out, write the key back to `false` after upgrading. For every other
switch, off by default still means byte for byte identical to the previous release.

| Key | What it is | Gate and reading | Verdict |
|---|---|---|---|
| `runtimeSummaryPromptI18nV1` | Bilingual summary prompt (the English one when `locale` is en-US) | The gate "EN validation pass rate ≥ ZH" is met but **does not discriminate** (all three arms 1.000). The real difference is the **summary language**: the off arm gave an English-UI user a Chinese summary **6/6**, the on arm was English 6/6; fact retention **10/10** against 9.33, wall clock 10.6 s against 19.6 s, cost ¥0.132 against ¥0.167 | **On by default (from 2.8.0)**: it fixes a real defect and no non-inferiority signal is worse. The one cost: a `locale=en-US` user now gets English summaries (`auto` and `zh-CN` are byte-identical). To turn off, write `runtimeSummaryPromptI18nV1: false` explicitly |
| `runtimeHistoryReadDedupV1` | Several full copies of one file in the protected tail become pointers | The gate "release tokens +10%" is **met and far exceeded**: old-boundary sub-case **+70.0%** (7076 → 12030), the sub-case with 111a on **+40.8%** (8090 → 11393); class B non-inferiority 12/12 answered the two facts that were pointed away | **On by default (from 2.8.0)**. To turn off, write `runtimeHistoryReadDedupV1: false` explicitly |
| `runtimeReseedTailUnitsV1` | L2 keeps the tail as whole units (an assistant message plus all its tool replies) | The gate "empty-tail share −80%" measured **−100%**: the off arm had **11 of 11** reseeds with an empty tail, the on arm **0 of 21**; paired orphans 0 in both arms | **On by default (from 2.8.0)**, with the **cost stated**: L2 count 1.83 → 3.50, summary cost **+60%** (¥1.681 → ¥2.687 over 6 pairs). To turn off, write `runtimeReseedTailUnitsV1: false` explicitly |
| `runtimeEvaporateBudgetBoundaryV1` | The L1 evaporation boundary moves from "second-to-last assistant" to a token budget | The gate "L2 count −20%" is **not met, and in the wrong direction: +32.0%** (4.17 → 5.50, the on arm ≥ the off arm in 5 of 6 pairs); cost **+36%**; total L1 release equal in both arms (32150 against 31818, within noise); quality non-inferior | **Look again.** The mechanism is self-consistent (protect the tail → L1 evaporates less → falls back to L2 more often); **the metric chosen for it points opposite to its mechanism**. Before flipping the default, pick a metric that can state the benefit of protecting tail observations |
| `runtimeReseedReattachFilesV1` | After a reseed, re-attach recently read files in a bounded way | Structural side **12/12 green** (on arm injected 11/11, first 40 lines carried the fact, off arm never injected); behavioural gate "share of first post-compaction actions that re-read a known file −50%" measured **0%** (83.3% / 83.3%). **The reading is knowingly contaminated**: a real model's summary copies the constants it read into the key-files section, so the off arm also had the answer | **Look again.** The conclusion is "could not be measured", not "measured and useless" — a clean reading needs a fact that is task-essential and cannot be copied into a summary |

The last two rows are **factory off** and the upgrade does not touch them.

**Other switches that stay off** (all left in the experimental band as "did not pass the gate" or "only synthetic
readings"; this release does not touch them): `runtimeToolRetrievalV1`, `runtimeVolatileTailLayoutV1` (#1 G1, the
prefix-cache probe did not pass the gate), `runtimeSummaryRefineV1` (sequential refine of at most 4 chunks, no net
gain on the 105 total gate), `runtimeBudgetGuardV1` + `budgetGuardTurnTokensV1`,
`runtimeToolTimeBudgetShadowV1` / `runtimeToolTimeBudgetV1` + two millisecond thresholds (synthetic readings only),
`runtimeFailureTelemetryV1`, `boundedReadSchedulerV1`, `metaToolHintsV1` and `actionArgumentModelViewV1`.

### 8.3 Upgrading from 2.7.0

- **How to upgrade**: download the 2.8.0 Slim or Full **full package**, **extract it into a new folder**, close
  2.7.0 and start from the new folder. The data root (`.ruyi-workbench` under the user profile by default, formerly `.win-claude-workbench`,
  or wherever `RUYI_HOME` points) is not inside the install folder, and the new version migrates it on first
  start. **The 2.8.0 overlay cannot be applied to 2.7.0** (precheck refuses it by version). Keep the old folder
  until the new version is working: it is your ready-made way back (take the backups in section 8.4 first).
  Wave 107's P1 drill ran exactly this: data created by 2.7.0, then 2.8.0 started on it, gives `configSchema` 12
  with the three compaction switches below turned on and every other key unchanged.
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

**Why a backup is mandatory** — both confirmed by reading 2.7.0's own code, and the first one measured against
v2.7.0 in wave 107's P1 drill (a provider carrying all four fields, one downgraded start, all four gone):

1. 2.7.0's `sanitizeProvider` **rebuilds** `providers[].models[]` into `{id, label}` and **writes `config.json`
   back on the first config read**, so `models[].caps` (the speech and vector capability tags),
   `providers[].audioBaseUrl`, `providers[].asrProtocol` and `hiddenModels` are gone after one start, and
   upgrading back to 2.8.0 does not bring them back. The API key survives.
2. 2.7.0's steward-memory normalization **does not know** `expiresAt` or `scope`, so the next memory write
   rewrites the store and drops both fields. The entries themselves survive.

`config.json.prev` keeps only the most recent generation and will not cover this.

**Minimum steps:**

1. **Stop the service**: close the desktop shell, `Ctrl+C`, or end the `Ruyi.exe serve` process, and confirm no
   turn or scheduled task is running.
2. **Back up two things, outside the data root**: `<dataRoot>\config.json` (together with `config.json.prev`) and
   the **whole** `<dataRoot>\steward\` directory (`memory-v1.json`, `decisions-v1.ndjson`, and the rest). Copying
   the entire `<dataRoot>` is safer still.
3. Go back to the 2.7.0 install folder (the old one you kept when upgrading), or extract the 2.7.0 full package
   again.
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
  The three compaction switch keys belong to the "left on disk, unread" group too: 2.7.0 does not have them.
- **Downgrading and then upgrading again reopens any compaction switch you turned off in 2.8.0, once**: 2.7.0
  writes `configSchema` back as 11, so the one-time `< 12` migration runs again when you return to 2.8.0 (measured
  in wave 107's P1 drill). To keep one off, write `false` again after upgrading back.

### 8.5 3.0 preview supplement: `CONFIG_SCHEMA` 12 → 14

Sections 8.1–8.4 were written at 2.8.0 and remain accurate for 2.7.0 ↔ 2.8.0. The current tree is
**3.0.0-preview.3** and `CONFIG_SCHEMA` is **14** (`app/src/00-boot.js`; the migration table is
`CONFIG_MIGRATIONS` in `app/src/01-config.js`). Upgrading from 2.8.0 works as in section 8.3: download the full
package, extract it into a new folder, keep the old one as the way back; the data-root and MCP-server-id renames are
described under "Data root" and "Brand and compatibility". Two more one-shot migrations arrive:

- **13 (sparse persistence)**: the config now writes only the keys you changed, the explicit-key set is kept in
  `configExplicitKeysV1`, and settings you never touched follow the product's current defaults. At the same time
  `killOnDisconnect` now defaults to `false` (a refresh or closing the window no longer ends a turn); a `true` found
  in an old file that is not in the explicit keys is treated as "the default of the day".
- **14 (factory permission level)**: the factory level flips from Ask me every step to **Smart auto**, **for fresh
  installs only**. A config already on disk that never stored `permissionMode` is pinned back to `default` by the
  migration, so nobody is quietly loosened; a level already written on disk is kept as is. Switching to Smart auto
  or Fully automatic still asks for a second confirmation.

Other 3.0 preview default changes (for example `agentAutoWake`, which wakes the main conversation when background
agents finish, on from the factory) are in the root `CHANGELOG.md`. The rollback drill in this section covers only
2.8.0 ↔ 2.7.0; rolling a 3.0 preview back to 2.8.0 has not been measured the same way, so back up the whole data
root first as in section 8.4.

## Brand and compatibility

Ruyi was formerly Win Claude Workbench. Since 3.0 the remaining legacy identifiers use Ruyi names as well: the
data root .win-claude-workbench becomes .ruyi-workbench (migrated on first start, junction left behind), the MCP
server id win-claude-workbench becomes ruyi (tools are mcp__ruyi__*; install removes the old registration), and the
offline plugin marketplace win-workbench-offline becomes ruyi-offline. The legacy WIN_CLAUDE_WORKBENCH_HOME
variable is still read; child processes receive RUYI_HOME.
