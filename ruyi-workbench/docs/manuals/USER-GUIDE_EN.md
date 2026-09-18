# Ruyi User Guide

> This guide is for everyday users who do not need to write code. It explains how to delegate work such as
> combining spreadsheets, renaming files, extracting text from scans, and drafting a weekly report while keeping
> every action understandable and reversible. The UI is authoritative if a label differs from this guide.

See also: [Chinese edition](USER-GUIDE_CN.md) · [administrator guide](ADMIN-GUIDE_EN.md).

## 1. Get started in three minutes

### Open the workbench

Double-click Start-Workbench.cmd or the shortcut prepared by your administrator. A browser opens the local Ruyi
page. If it does not, open the local address supplied by the administrator; the default port is 8765.

### Complete first-run setup

The first-run card asks you to:

1. Choose or drop a folder. This becomes the workspace. Ruyi can read and write inside it, not arbitrary files
   elsewhere on your computer.
2. Check engine readiness. A green status means a configured Claude CLI or OpenAI-compatible provider is ready.
   Use Settings or contact an administrator when no engine is available.
3. Try a task card. Cards turn a common task into a clear prompt with a few fields to fill in.

The default permission mode is Ask every time. Ruyi asks before each operation, so it is safe to explore.

### Send your first request

Write naturally, as if assigning work to a colleague:

- Combine every Excel workbook in this folder into Summary.xlsx.
- Read this project and explain what it does in a few sentences.
- Extract the text from these scanned documents.

Press Enter to send and Shift+Enter for a newline. The conversation explains progress while the tool panel shows
the local files and actions involved.

## 2. The concepts that matter

### Workspace

The workspace is Ruyi's activity boundary. File reads, writes, and searches are scoped to the selected folder.
Choose it carefully: selecting the correct workspace defines where the AI may operate.

### Chat

A chat is one complete conversation. The sidebar lets you create, search, rename, pin, and delete chats. Use
separate chats for unrelated work to keep histories clear.

### Permission modes

| Mode | Meaning | Good for |
|---|---|---|
| Ask every time | Requests approval before each action. | First use and important files. |
| Auto-apply minor edits | File edits proceed; sensitive operations still ask. | Trusted editing tasks. |
| Plan before acting | Ruyi proposes a plan and waits for approval. | Complex work requiring review. |
| Full automation | No routine approval prompts. | Only deliberate, low-risk tasks. |

When unsure, use Ask every time. Changing mode takes effect immediately.

### Questions from the AI

When information is missing, Ruyi opens a question card instead of guessing. A question may accept one choice,
multiple choices, or typed text. Option descriptions explain their effects, and an Other choice can accept a
custom response when available. Submit answer becomes available only after every question is answered; use
Ctrl+Enter (or Command+Enter on macOS) as a shortcut.

Ruyi does not preselect an answer. Closing the card cancels the question. After submission, the card stays open
until delivery is confirmed, so a temporary network failure can be retried without losing the response.

### Checkpoints, audit, and rollback

Before writing, editing, or deleting a file, Ruyi records a checkpoint. The Audit tab records tool and permission
events. You can roll back an individual change or a whole turn, returning files to their prior contents. Batch
renames are previewed as an old-name to new-name table because they are not automatically reversible.

## 3. Common tasks

### Combine Excel workbooks

Ask Ruyi to align columns, combine files, add a source-file column, and remove exact duplicates. Example:
Combine all Excel files in D:\Reports\October and save the result as Summary.xlsx.

### Rename a group of files

State the folder and naming rule. Ruyi shows a proposed mapping first so you can spot collisions before any file is
renamed.

### Summarize PDFs or run OCR

Ruyi can extract text from PDFs and write a Markdown summary. For scans or image-based PDFs, enable desktop control
through Settings; if it is unavailable, Ruyi reports that fact instead of claiming success.

### Draft a report or export a PDF

Provide your notes and ask for a report. Ruyi summarizes supplied information rather than inventing outcomes. It can
export a completed report to PDF; Chinese-capable fonts are selected automatically when available.

### Inspect or save project changes

For a Git workspace, ask what changed or ask Ruyi to save the current work with a commit message. You do not need
to remember Git commands, but you should review the proposed change summary before approving it.

### Search the web

Web search is optional and must be configured by an administrator. Without it, Ruyi remains fully usable for local
work and reports that online search is unavailable. Cached material can still be available while offline.

## 4. Tour of the interface

The layout has a chat sidebar, the central conversation, and a right-hand tool panel.

- The top bar selects the workspace, permission mode, engine, theme, UI mode, and language. It also shows context
  usage when relevant.
- Files shows the workspace tree and previews text files. Ask Ruyi in chat when you need to search content or read
  a specific path. Artifacts lists files generated in the current chat.
  Changes shows reversible file edits grouped by turn. Audit shows a filterable timeline of actions and decisions.
  Agent Workflows is the monitoring canvas for multi-agent orchestrations. Usage displays token consumption
  and cost for the current turn.
- The composer supports attachments, task cards, slash commands, and ordinary natural-language requests.
- Simple mode emphasizes files, artifacts, changes, and progress with plain-language labels. Pro mode adds richer
  status and configuration, while low-level terminal, desktop, MCP, search, and read operations remain model tools
  governed by permissions rather than manual runners. Connector management lives in Settings → Integrations / MCP;
  diagnostics, storage, metrics, and raw logs live in Settings → Doctor.

## 5. Settings

Configure either a local Claude CLI path or an OpenAI-compatible provider; one configured engine is enough to
start. Provider keys are stored locally and masked in UI responses.

The Web Search page configures SearXNG, Bing, Brave, Tavily, Bocha, or a custom endpoint. It is optional.

On the General page, choose Simple or Pro UI, detailed or concise response style, and language: Follow system,
Simplified Chinese, or English.

### New task desk preview and classic layout

Open **Settings → General → Task desk layout** to switch between **Classic layout (default)** and the **New task
desk preview**. This changes only the presentation preference on this computer; it is not a data migration. Both
layouts read the same tasks, chats, messages, pending decisions, and checkpoints. Nothing is copied, moved, or
deleted, and you can switch back at any time.

- Use **Dispatch desk** in the classic sidebar to return immediately; use **Classic layout** at the bottom of the
  task dock to go back. They are two interfaces over the same task facts.
- The dispatch desk restates the goal, workspace, and turn-specific permission mode before you start. A Quick Ask
  ending in `?` returns to the classic conversation without creating a task.
- The task dock opens the raw message worksite plus Needs you, Results, and a real change ledger. Archived tasks
  retain the same undo handles. Its top `+` opens a clean task draft and focuses the dispatch box.
- A task opens on the **Worksite log**, which turns starts, turns, failures, usage, decisions, results, and rewinds
  into one continuous duty log. Every sentence expands to its raw type, time, source cursor, and fact detail. Switch
  to **Crew stages** or **Raw record** at any time; these are lenses over the same facts, not separate task state.
  Long logs keep a normal 160-row DOM window and reveal earlier notes in explicit batches.
- Multi-agent tasks show a **crew stage map** in the Crew stages lens. Every member, dependency, status, and latest
  progress line comes from the same task record; the foreman sentence is a deterministic summary and does not call
  a model. A dotted gold member is proposed work awaiting approval and opens its exact Needs you item. Select a
  running member to pass a note; the UI reports immediate delivery, queued delivery, or honest unavailability and
  preserves the draft after failure.
- The **Mission telegraph** below the title separates three scopes. Pause, Continue, and Human takeover affect the
  current turn and driver; Stop and Retry affect the whole Mission; Pause/Continue/Stop inside Crew stages affect
  only the selected Run. Every button shows its scope and disabled controls explain why. Stop, Retry, and Run Stop
  restate their impact in place and require a second confirmation.
- **Change ledger & undo handles** groups real checkpoint rows by turn with file, operation, tool, and time. A
  Reversible row can be undone alone; Rollback Mission reverses recoverable files since Mission start and resets
  that conversation tail and its milestones. Large files without a before-snapshot, commands, and other
  irreversible actions are listed separately and are never reported as undone. Entry and whole-Mission rollback
  require confirmation and are disabled while a turn or team Run is still writing.
- Needs you in the desk bar or task intake opens the same cross-task drawer. Permissions, questions, plans, and
  helper proposals are decided there; Allow and Approve require a second confirmation. A question first shows the
  background the model gave immediately before asking, then presents full-row choices with no default selection;
  Other is only the fallback when no option fits. An offline worksite offers only an honest classic-layout handoff.
- The desk-bar **Workspace / Safety / Engine** facts open the workspace picker, permission-mode panel, and model
  menu respectively. Only **Settings** in the task dock opens the full Settings page.
- A stopped task lists unfinished work and offers Try again, Change approach, or Leave it for now. Try again opens
  the inline whole-Mission Retry confirmation, then clears the stopped stamp and starts a new turn. Change approach
  prepares an unsent classic-composer draft; Leave it for now only archives local UI state.
- While you were away is generated only from persisted change records, and advances its local read position only
  after the task view has rendered successfully.
- Archive search, filters, pinning, and archiving are local UI preferences. They never rewrite task facts.
- A completed task gains a **Closeout dossier** with Acceptance, Artifacts, Unfinished, Changes, Usage, and Audit
  facts from the sealed result. It can be saved as familiar work, remembered as a habit, or archived in place.

To be alerted while away, explicitly enable **Settings → General → Notify me when I am needed**. The browser asks
for system-notification permission on that click. Quiet hours default to 22:00–08:00 and can be changed locally.
Each pending decision is notified at most once and its notification is withdrawn when the decision becomes
terminal. Items seen during quiet hours or denied permission are not replayed later, and restarting the workbench
does not emit a backlog. The feature is off by default and stores only a local preference.

If the task projection cannot load, the failure view offers both **Retry** and **Return to classic layout**. Classic
mode remains fully usable, and the failure does not rewrite task or chat data. A damaged local preview-preference
record may reset read, pin, and archive positions, but the task remains authoritative and intact.

## 6. Skills, memories, usage, and workflows

Skills are reusable expert workflows. Use **Enable for chat** for temporary needs or **Keep resident** to make a
skill available across chats. Resident skills still use progressive loading: only a compact index is always present,
and the full guide is opened when relevant. Each skill card can show its complete workflow and quality checks.

Commands work in both engines: Claude CLI keeps the native `/name` form, while Provider mode inserts the same
command as an editable full task template. Playbook forms can also reveal their complete execution guide before run.

### Browser and tool settings through conversation

Opening a URL now defaults to a new tab/window in your system browser and existing signed-in session. The current
Ruyi Workbench tab is protected: browser tools do not navigate, reuse, or close it. Chrome for Testing is used only
when you explicitly select the isolated bundled mode under **Settings → Integrations and MCP → Browser target**.
Use CDP mode to reuse an already attached browser when element-level DOM automation is required.

If a hardware-accelerated page exposes only browser chrome through UI Automation, the AI switches to CDP/DOM,
OCR, or screenshot coordinates. A purely Direct3D-drawn application has no semantic buttons unless the app itself
implements an accessibility provider, so pixel capture and recognition are the available fallback there.

You can also ask the AI to retarget the browser or add, disable, or remove an MCP connector. It first shows the
sanitized current state and proposed difference, then waits for an execution-level permission confirmation before
saving. Secret environment values are never returned in the inventory.

Workbench memory stores personal practices or project conventions after a draft-and-confirm step. Project memories
apply to their matching workspace; global memories are enabled deliberately. Keep repository-wide shared rules in
CLAUDE.md and personal habits in workbench memory.

The Usage page groups tokens and cost by engine, provider, chat, and day. It labels subscription-plan traffic
honestly rather than inventing a monetary cost, and includes sub-agent and compaction usage. You can set a monthly
budget warning. Provider settings support default input, cache-hit, and output rates plus exact per-model overrides
within the same provider. Blank model fields inherit provider defaults, and a blank cache-hit rate conservatively
uses the normal input rate. The Usage page also reports cache-hit tokens.

In a multi-agent workflow, open a running node to send a directed instruction that is delivered before its next
model call. A proposed task card tells you who proposed a new node, what it does, and its estimated budget; you
choose Add task or No thanks.

## 7. FAQ

**No engine is ready.** Configure a Claude CLI path or add a provider in Settings, then select it in the top bar.

**Why am I seeing a permission prompt?** Ruyi is asking before a sensitive action. Review the action, scope, and
reversibility, then approve or reject it. An unattended prompt expires as a rejection.

**How do I undo a change?** Open Audit or Changes, or use Change ledger & undo handles at the bottom of a task
sheet. You can undo one checkpoint row or roll the whole Mission back to its start. Operations without a usable
before-snapshot remain explicitly listed as irreversible.

**Does Ruyi work offline?** Local files, scripts, desktop control, Office work, PDF export, and OCR are local.
Only online search needs a configured network service.

**The conversation is long.** Open the context meter and use Compact now; Ruyi summarizes earlier context so the
chat can continue.

## 8. Local models (Ollama / LM Studio)

Ruyi can talk to a model running on your own computer. This route needs **no API key and no internet access**.

### Three steps

1. Install Ollama or LM Studio on this computer and leave its local server running.
2. In Ruyi, open step 3 of the welcome wizard (Help in the sidebar reopens it any time) and pick the
   **Ollama (local model, no key)** or **LM Studio (local model, no key)** preset card.
3. Leave the API key blank and press Test connection. Ruyi asks the local server which models it has and fills
   the model list under Advanced; choose one, press Save and continue, and the top bar switches to it.

Settings, Providers behaves the same way: neither preset requires a key, and the key field says so.

### Test connection says it cannot connect

Almost always the local server is not running right now. Start Ollama or LM Studio (LM Studio also needs its
built-in local server enabled), then press Test connection again.

The default addresses are `http://127.0.0.1:11434/v1` (Ollama) and `http://127.0.0.1:1234/v1` (LM Studio). If you
changed the port, edit the address under Advanced.

### Is it worth it

Local models cost nothing, never leave the machine, and work offline, which suits tidying files, rewriting text,
and translation. They are usually weaker than hosted models on long multi-step work, coding, and long-document
analysis. Configuring both and switching in the top bar is the least painful setup.

---

## 9. Voice input, scheduled tasks, service entry, and steward delegation

All four arrived in 2.8.0. Each part is written the same way: **how to do it, what you will see, and what to do
when it does not work.**

### Voice input: speak instead of typing

**Configure it once.** Open **Settings → Models & Services → Model providers → Speech recognition (voice
input)** and pick a **provider** and a **model**. Only models tagged as speech-capable in that provider's model
list are offered; when
there is no candidate at all the block renders no controls — **that is not the feature hiding, it means this
machine has no speech model to choose**. Once saved, the page confirms that speech recognition is on; choosing
**Off** turns it back off.

> **The prerequisite, stated plainly.** Ruyi speaks only the OpenAI-shaped `/audio/transcriptions` endpoint, so
> **voice works only with a provider that offers that endpoint**, whatever that provider's own documentation
> says. Of the four ASR models tested on the developer's own machine — MiMo, two on Bailian, and Hunyuan —
> **not one offers it; all four returned 404**. So record one short take right after you configure it. If it
> fails, you did not configure it wrong: move to a provider that offers that endpoint. Ask your administrator
> if you are not sure which one does.

**Using it.** Once configured, a microphone appears next to the send button in the composer of **both the
Workbench lens and the Steward lens**.

- Click once to start; the button counts up (`0:01`). Click again to finish; the take goes off to be
  transcribed and the button shows a busy state.
- The transcript is **inserted at the caret** (replacing a selection, if you had one). Focus returns to the
  composer with the caret after the inserted text. It is **never sent automatically** — read it, edit it, then
  press send yourself.
- Press **Esc** while recording to cancel: that take is dropped, nothing is transcribed, and the composer is
  left untouched.
- **Three minutes per take.** Recording ends itself at the limit and transcribes what it has.
- Keyboard-only use works the same: Tab to the microphone, Space or Enter to start, press again to finish. Each
  step is announced for screen readers (recording, turning speech into text, added to the input box, cancelled,
  failed).

**What failure looks like.** Every one of these is only a message; **the composer is never changed**.

| Message | What it means and what to do |
|---|---|
| Microphone permission was not granted | The browser or the operating system blocked the microphone. Allow this page in the browser's site permissions. |
| No microphone was found | This machine has no recording device, or another program holds it exclusively. |
| Speech recognition is not set up yet | No provider and model pair is selected, or that provider was deleted. Choose them again in Settings. |
| This recording is too long to transcribe | Over the 25 MB transcription limit; you will not normally reach it inside three minutes. |
| The transcription service did not succeed this time | The provider's end errored or is unreachable — most often the missing `/audio/transcriptions` endpoint described above. |
| No words were recognized | The transcript came back empty. Try a quieter room, closer to the microphone, and say it again. |

**Two known limits.** First, microphone permission inside the desktop shell (the WebView2 host) **has not been
verified**: the button is still drawn, and if pressing it lands on "Microphone permission was not granted", open
Ruyi in a browser instead. Second, the only recording format is webm/opus, and a browser that does not support it
shows no microphone at all — there is no fallback path.

**Also**: you can **attach a recording as a file**. Ruyi transcribes it best-effort and hands the text to the
model with the file. A failed transcription never blocks the upload, and the original file stays downloadable.

### Scheduled tasks: handing a job to the clock

**Where.** Settings → **Steward** tab → **Scheduled tasks** → **New**.

**What to fill in:**

- **What is this called** — a one-line title, for example "draft the weekly report".
- **How often** — just once / every day / every week / every month / advanced (cron). Under "every month", 31
  means "the last day of every month" and February lands on the 28th or 29th automatically. Under "advanced",
  cron is five fields (minute hour day month weekday) in this machine's local time.
- **What happens then** — **Just remind me** (**no model call, no cost**: a reminder appears in the inbox at the
  appointed time) or **Let Ruyi run one turn** (real work).
- **Where it runs** — a fresh thread each time, or pinned to one existing thread.
- **How far it may go on its own** — this task's own permission profile, capped by your global profile and never
  including full automation. **Ask-every-step approves nothing while you are away**: an unanswered prompt waits
  for `schedulerAskWaitMinutes` (30 minutes by default) and is then rejected, the run is recorded as **Waiting
  for you**, and you press **Run now** when you are back. The whole run has its own cap (`timeoutMinutes`, also
  30 minutes by default) and is recorded as Failed if it runs over — two different clocks with the same default.
- **Which model tier** (new in 2.8.0) — complex tasks · strong model / simple tasks · fast model / follow the
  main endpoint. Which endpoint each tier uses is set higher up the same page under "Model for new threads"; a
  tier left empty follows the main endpoint. **With this, you no longer change the global engine for one
  scheduled task.**

**What you will see.** Tasks are listed in that block, each row showing the next firing time, **Pause/Resume**,
**Run now**, **Delete**, and an expandable **Recent runs**.

- **Run now** and **Delete** both **ask first**: Run now is not a dry run — it starts a real turn, may cost
  money, and may act on the outside world; Delete takes that task's run history with it.
- Each row under **Recent runs** is labelled with its **firing mode** and its **outcome**: On time / Caught up /
  Manual, and Succeeded / Failed / Waiting for you / Skipped / **Result unknown — please check**.
- Pressing **Refresh** refreshes the data and **no longer collapses** the row you had expanded (a defect fixed in
  2.8.0).

**New in 2.8.0: each task gets its own working folder.** Previously every scheduled task landed in the default
working folder, so two tasks firing at the same time queued on one folder lock and the waiting one looked as if
it had never fired. Ruyi now opens a folder per task, named from its title, and adds it to the workspace
candidates, so simultaneous tasks run side by side. **A task cannot be given a hand-typed working directory** —
that is a safety line kept on purpose.

**Missed firings and crashes are by design, not accidents:**

- **Missed the time** (the machine slept or was off): the task is re-run **once** inside the grace window (12
  hours out of the box, changeable when you create the task) and that row is labelled **Caught up**. Past the
  window it is labelled **Skipped** and you are told. **Once only — it never chases several missed runs.**
- **The process died mid-turn**: at the next start the run has no terminal state, so it is recorded as **Result
  unknown — please check**. It is **neither counted as success nor blindly resent** — whether to re-run it is
  yours to decide.
- **The time passed and nothing happened**: expand **Recent runs** first and read what that row says (usually
  "Waiting for you" or "Skipped"). Only if there is genuinely no record at all should you check whether the
  steward master switch or scheduled tasks have been turned off.

**"Later" on a quiet card is a real scheduled task.** It does not merely dismiss the card: it schedules a one-off
reminder N minutes out (N is set under Settings → Steward → Scheduled tasks, "Snooze a quiet card for how long
(minutes)", between 1 and 1440) and puts the card away. The neighbouring "put this card away" is the one that
simply dismisses it.

### Service entry in the skill library: type a sentence, see what already exists

**How.** Press `/` in the composer (or, in pro mode, open the skill library) and **type a plain sentence into the
search box**: "tidy up downloads", "compare these PDFs", "summarize this every day". When it matches one of six
services, a **service row** appears at the **top** of the list. Unrelated words produce nothing, and clearing the
search box removes the row — it does not sit there taking up space.

The six services are **Research & Compare, Organize, Writing, Coding Tasks, Scheduled Digest, and Watch**.

**Which sentence you will see** — four states, each of which tells its own truth:

| The service row says | What it means | What to do |
|---|---|---|
| Service "Organize": 7 templates ready to run | This service has templates **and the capabilities they need are confirmed available** | Open a template card below, fill in the fields, and run it |
| Service "Coding Tasks": check the network connection first | There are templates, but **one thing is missing**. You get **at most one configuration prompt** here; anything else collapses into "N more", so you are not handed a list of chores at once | Do that one thing, then search again |
| Service "Watch": no templates yet | This service **genuinely has none** | Do not wait for one — describe the job in the conversation and let Ruyi run it as an ordinary thread |
| Service "…": status unknown; the capabilities its N templates need have not been checked | **The one that matters most**: the capabilities this service needs **have not been probed**, so Ruyi **does not know** whether it will work | Open the capability badge in the top bar (that can trigger a check) and do not read "unknown" as "available" |

> **Why "unknown" is called out separately.** "Not probed yet" used to be folded into *both* "available" and
> "unavailable" — two opposite directions. An unknown network state counted as available, so a card that could
> not actually run said it was ready to run; a desktop-control probe that errored counted as unavailable, so an
> installed capability was reported missing. From 2.8.0 **unknown says unknown**, the service row counts only
> genuinely available templates, and when the set is mixed it adds "N more with unknown status".

**Template cards carry the same four states.** An available card says little; one that needs setup says "Needs
setup"; one missing the network says "Needs the network and you are offline: work from local files for now, or
reopen this once the connection is back"; one that could not be probed says "Status unknown: the capabilities
this card needs have not been checked".

**Also**: a template may belong to no service at all (a purely action-shaped one, such as opening an
application). **Unclassified does not mean unavailable** — it runs perfectly well, it simply never appears in a
service row.

### The steward can approve some of it for you, and what it will never approve

**What this is for.** Some actions stop and ask you no matter what profile the thread is on — deleting data,
installing or uninstalling software, `git push`, sending something outbound. From 2.8.0 the steward **may press
that button for you within the rules**, so a scheduled task does not sit blocked while you are away.

**The conditions for it to approve on your behalf — all ten must hold; one missing and it still waits for you:**

1. The switch is on (it ships on).
2. The **effective** permission profile of this turn is **smart auto** ("ask every step" and "plan only" do not
   count; full automation never stops to ask in the first place).
3. The thread is one the **steward is watching**, or one a **scheduled task opened** — a thread you opened and
   are watching yourself still asks you.
4. **Not one** of the matched rules is a floor item (floor items are listed below).
5. The command text was **scanned in full** and is no longer than **the 300 characters the steward can actually
   see** — what it receives is a 300-character excerpt of the command, so a command that is too long, a scan that
   was truncated, or an excerpt that was itself cut off all block delegation: **it may not approve what it
   cannot see**.
6. The command contains no **concatenation, encoding, or evaluation** — indirect constructions such as
   `& ('shut' + 'down')`, which spell a keyword out at run time. The rules cannot tell what such a command really
   runs, so it always waits for you.
7. For a **delete-data** match, the deletion target must be a **relative path**. A drive letter (`C:\`), a
   leading `/`, `~`, `$env:`, or `%VARIABLE%` all send it to you.
8. The steward **wrote down a reason** (no reason, no approval).
9. When the thread **read a web page** this turn (or last turn, with no message from you since), anything
   **outbound** or **push-to-remote** is never delegated — deleting files or installing software still can be,
   under the same conditions.
10. **At most 6 times per hour** (the count resets on restart).

**What it will never approve for you** (floor items; any profile, any condition): payments, purchases, and
transfers; formatting and partitioning; shutdown, restart, and boot-entry changes; registry and firewall changes;
registering an MCP server; tools whose very name means sending a message, plus `sendmail`; and any command that
takes `/`, `C:\`, or your home directory as its deletion target.

**What you will see:**

- After the steward approves something for you, that turn carries a **receipt** naming what it approved and why.
- Settings → **Steward** → **Action log** lists every one: which category of action, the reason, and a redacted
  excerpt of the command. **The record says it was the steward who approved it, not you.**
- When the ten conditions are not met you see **the same button as before** — except that the steward can now
  name which category of rule caught it (deleting data / changing the system / installing or uninstalling /
  sending outbound / pushing to a remote).

**Where the switch is.** Settings → **Steward** → **What the steward may do on its own** → the entry reading
"when a thread stops to ask about a permanently exempt action, the steward may approve it for me under its
rules". **Untick it to go back to "everything waits for your own hand".** **The steward cannot change this
setting itself** — only you can.

**When something the steward proposes changes a setting, you confirm it.** Buttons the steward offers that would
change a setting, turn a skill on or off, or grant a thread desktop control now open a confirmation panel first:
the panel is titled "Apply this change?" and lists each change as `key = value`, and **nothing is sent until you
press confirm**. Cancelling sends nothing at all. The wording on those buttons and in the panel is derived by the
workbench from the arguments — the model does not get to name them — and any secret in a value is masked before
it is shown.

**Nothing was delegated and the job is stuck?** Open that thread and press the button yourself — **the path you
press by hand was never restricted**. If it waited too long (120 seconds with no answer rejects automatically; it
never approves on your behalf by timing out), go back and press **Run now** to run it again.
