# Ruyi User Guide

> This guide is for everyday users who do not need to write code. It explains how to delegate work such as
> combining spreadsheets, renaming files, extracting text from scans, and drafting a weekly report while keeping
> every action understandable and reversible. The UI is authoritative if a label differs from this guide.

See also: [Chinese edition](USER-GUIDE_CN.md) · [administrator guide](ADMIN-GUIDE_EN.md).

## 1. Get started in three minutes

### Open the workbench

Double-click Start-Workbench.cmd or the shortcut prepared by your administrator. A browser opens the local Ruyi
page; the window title reads Ruyi Workbench and the top bar carries a **Steward | Workbench** segmented control. If
the page does not open, open the local address supplied by the administrator; the default port is 8765.

### Complete first-run setup

The first-run card asks you to:

1. Choose or drop a folder. This becomes the workspace. Ruyi can read and write inside it, not arbitrary files
   elsewhere on your computer.
2. Check engine readiness. A green status means a configured Claude CLI or OpenAI-compatible provider is ready.
   Use Settings or contact an administrator when no engine is available.
3. Try a task card. Cards turn a common task into a clear prompt with a few fields to fill in.

A new install starts in Smart auto: low-risk work runs without asking, while deleting data, installing software, pushing and
sending outbound stop for you (recognized by rules over the command text — common phrasings are covered, but it is not a
sandbox; see SECURITY.md in the repository). An upgraded install keeps the level it had. Switch to Ask me every step from the shield
button when you want Ruyi to ask before each change.

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

### Thread

A thread is one conversation about one piece of work. The left rail, titled Tasks, groups all your threads by
state (Waiting on you / Running / Queued / Wrapped up today / Earlier); you can search threads, rename, pin and
delete them, and **New thread** starts another (in the steward view the same button reads **Start a task**). Use
separate threads for unrelated work to keep histories clear.

### One workbench, two views

Ruyi has one interface with two **views**, switched with the **Steward | Workbench** segmented control in the
middle of the top bar (shortcut ``Ctrl+` ``):

- The **steward view** is a conversation: tell it what you want, and the steward opens threads to do it, reports
  back, and keeps an eye on everything in flight.
- The **workbench view** is the three-pane layout where every step is visible: threads on the left, the
  conversation in the middle, files and changes on the right.

Both views read the **same** threads, messages, pending decisions and checkpoints. Switching moves and deletes
nothing, and the thread rail on the left is the same list in both. A new install starts in the steward view; to
start in the workbench instead, change **Settings → General → General → Default view on launch**. Section 4 says
what is in each view.

### Permission modes

Pick the default for new threads from the **shield** in the top bar (or Settings → General → Permissions &
safety); set a single thread from the **permission chip** in its header.

| Mode | Meaning | Good for |
|---|---|---|
| Ask me every step | Asks before editing files or running commands (reads never ask). | First use and important files. |
| Edit files without asking | File edits proceed; commands and outbound actions still ask. | Trusted editing tasks. |
| Plan only | Ruyi writes a plan and does not act. | Complex work you want to review first. |
| Smart auto | Stops asking and reports back. Deleting data, installing software, pushing, sending outbound, and spliced or encoded commands whose real intent cannot be read stop (rule-based, not a sandbox); the steward may approve the non-floor ones under its rules (see section 9). | Handing the work to the steward without step-by-step interruptions. |
| Fully automatic | Never asks and nothing is vetted - even floor actions such as payments, shutdown, or sending mail run straight away; only system folders stay write-protected (red warning style). | Only in an isolated environment or when you fully trust the task. Scheduled tasks never use it. |

Switching to Smart auto or Fully automatic asks you to confirm first, each with its own explanation. When unsure, use
Ask me every step. A change applies from the next turn and does not interrupt a turn in progress.

### Questions from the AI

When information is missing, Ruyi opens a question card instead of guessing. A question may accept one choice,
multiple choices, or typed text. Option descriptions explain their effects, and an Other choice can accept a
custom response when available. Submit answer becomes available only after every question is answered; use
Ctrl+Enter (or Command+Enter on macOS) as a shortcut.

Ruyi does not preselect an answer. Closing the card cancels the question. After submission, the card stays open
until delivery is confirmed, so a temporary network failure can be retried without losing the response.

### Checkpoints, audit, and rollback

Before writing, editing, or deleting a file, Ruyi records a checkpoint. The Activity tab in the right pane records
tool and permission events. You can roll back an individual change or a whole turn, returning files to their prior contents. Batch
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

Ruyi is **one workbench with two views**. The screen has a top bar, a left rail, a middle area and a right pane: the
top bar and the left rail are shared by both views, while the middle and the right change with the view.

### Top bar (shared; from the middle to the right)

- **The view control, Steward | Workbench**: click to switch views, shortcut ``Ctrl+` ``. A new install starts in
  the steward view.
- **"N running · M waiting on you"**: a global status pill counting running threads and items waiting for you;
  click it and the rail scrolls to the matching group. It is hidden while there are no threads.
- **The shield**: the default permission level for new threads; open it to pick one of the five levels (section 2).
  A single thread can be tightened from its own permission chip.
- **The power button, "Stop the steward"**: halts the steward's own polling and in-flight turns (threads already
  running carry on); once stopped, the same button reads "Wake the steward".
- **The gear**: Settings, Help (user manual, administrator manual, reopen the setup guide, view logs), keyboard
  shortcuts, dark / light theme, interface (simple / pro), the capability matrix, and, last, the destructive
  "Clean up history".

### Left rail: the thread list (shared)

- The number beside the title "Tasks" is the thread count; "Search threads" searches titles and bodies.
- **New thread** opens a thread (in the steward view the button reads **Start a task** and asks the steward to
  start it).
- Threads are grouped by state: **Waiting on you** (a pending permission, question, plan or proposal),
  **Running**, **Queued**, **New**, **Stopped today**, **Wrapped up today** and **Earlier**. "Max at once" and
  "Pause everything" control concurrency.
- At the foot are four entries: **Scheduled tasks**, **Action log**, **What it remembers**, **Health · usage**.

### The steward view

The middle is the conversation with the steward (the box reads "Say something to Ruyi"): you ask for something, it
opens a thread to do it (or hands it to an existing one) and reports back; ask "how are these going?" and it
answers thread by thread. The right pane shows the thread selected in the rail: what it is waiting for, the Allow /
Deny buttons you can press right there, its permission / model / engine, a box to **talk to that thread directly**
(the message goes straight to it, not through the steward), and "Open in the workbench" and "Stop".

The steward speaks up only when it should: trouble in another thread shows a **quiet card** at the bottom right that
does not steal focus, question pop-ups never interrupt you while you are typing, and every pending decision gathers
in the "Waiting for you" tray at the bottom right.

### The workbench view

| Area | What is there |
|---|---|
| Thread header | The thread name and state, the **workspace folder** button (click it to change folder), the "hand to the steward" toggle and a way back to the steward, this thread's own **permission / model / engine** chips (affecting only this thread), the **context meter** (used / limit; click it to see usage, set the limit, or **Compact now**), and the connection status |
| Middle | **Conversation** and **Crew** (the live multi-agent canvas) tabs; under each answer: the turn record (tool calls), the turn's file changes (undoable) and the turn's usage |
| Composer | See the next paragraph; while a turn runs you can steer it or stop it |
| Right pane, seven tabs | Below |

The seven tabs on the right:

- **Files**: the workspace tree. Click a text file to preview it; ask Ruyi in chat when you need to search content or
  read a specific path.
- **Artifacts**: the files generated in this thread, grouped by turn, which you can preview and open. The easiest
  place to collect the result of a job.
- **Changes**: reversible file edits grouped by turn; undo one at a time or roll back a whole turn.
- **Memory**: workbench memory (section 6).
- **Workflows**: the monitoring canvas for multi-agent orchestrations.
- **Usage**: token consumption and cost for the current turn.
- **Activity**: a filterable timeline of everything the AI did; click a row for the full record.

Simple mode emphasizes files, artifacts, changes, and progress with plain-language labels. Pro mode adds richer
status and configuration, while low-level terminal, desktop, MCP, search, and read operations remain model tools
governed by permissions rather than manual runners. Connector management lives in Settings → Tools &
integrations → Integrations and MCP; diagnostics, storage, metrics, and raw logs live in Settings → System →
Diagnostics.

### Composer

The composer supports attachments, task cards, slash commands, and ordinary natural-language requests, and it
exists in both views (with a microphone beside Send once speech recognition is configured).
Switch between simple and pro mode from the gear menu, under "Interface" (also under Settings → General →
General).

## 5. Settings

Open the **gear** at the top right of the top bar and choose Settings. The left side has five groups: **General**
(General / Permissions & safety / Usage & limits), **Steward**, **Models & Services** (Model assignment / Model
providers / Speech recognition / Agent CLI / Agent roles), **Tools & integrations** (Web search / Integrations and
MCP / Add-on components / Skills & templates / Migration center) and **System** (Diagnostics / Storage & data /
Advanced / Update Center). The "?" on each page opens the matching section of this guide.

Configure either a local Agent CLI path (Claude Code or Kimi Code, under Models & Services → Agent CLI) or an
OpenAI-compatible provider (Models & Services → Model providers: press "+ Add Provider" and pick a starting point from the
drop-down beside it: local Ollama, local LM Studio, or the one "custom" entry (OpenAI-compatible / self-hosted). A cloud
API and an Anthropic-compatible gateway both use "custom": enter the base URL and key the service gave you. The
protocol drop-down sits right under the Base URL and **follows the address automatically**: `api.anthropic.com`, an
address whose path ends in `/anthropic` (or `/anthropic/vN`) or in `/messages` means Anthropic Messages; one ending in
`/chat/completions` means Chat Completions; one ending in `/responses` means the Responses API. Once you pick a protocol
by hand the address stops changing it, and when the address box loses focus a pasted `/v1/messages`,
`/chat/completions` or `/responses` suffix is stripped. For an Anthropic-compatible gateway, for example, add a
"custom" card and paste `https://api.example.com/anthropic`; the protocol switches by itself. "Test connection" reads the
endpoint's model list; when the endpoint has none (404 / 405 / 501, or an empty list) it falls back to one minimal
completion with the configured model, and asks you to fill in a model if none is set. Finally press "Save providers"); one configured
engine is enough to start. Ruyi ships **no vendor presets**. Once configured, choose it from the engine chip in a
thread's header, or decide who uses which model under Models & Services → Model assignment. Provider keys are
stored locally and masked in UI responses.

The Web Search page (Settings → Tools & integrations) configures SearXNG, Bing, Brave, Tavily, Bocha, or a custom
endpoint. It is optional.

On the General page (Settings → General → General), choose Simple or Pro UI, detailed or concise response style,
language (Follow system, Simplified Chinese, or English), and the **Default view on launch**: whether the next start
lands in the **Steward (default)** or the **Workbench**. That is only a local interface preference: it migrates and
rewrites no thread data, you can switch back at any time, and the top-bar control always works too. While the
steward master switch is off, only the workbench view is available.

### Notify me when I am needed

To be alerted while away, explicitly enable **Settings → General → General → Notify me when I am needed**. It is off
by default and stores only a local preference. The browser asks for system-notification permission on that click.
Quiet hours default to 22:00–08:00 and can be changed.

A notification is sent in two situations only:

- In the **workbench view**, when you are sitting on a different thread and a quiet card appears at the bottom
  right, a system notification goes out with it.
- In the **steward view**, when the steward leaves a permission request for you or has something to call you about,
  and only while the window is not in the foreground (minimised or unfocused).

Each event notifies once and a notification is not withdrawn afterwards. Items that arrive during quiet hours, or
while permission is denied, are not replayed later, and restarting the workbench does not emit a backlog. The desktop
shell uses a tray balloon.

### The Steward tab

**Settings → Steward.** The steward is a conversational view (section 4): you say one sentence and it dispatches the
work to threads and reports back. **It is on from the factory** (a new install lands in the steward view). The page
has eight groups from top to bottom:

- **Steward switch**: "Turn the steward on", "Switch to the steward view" and "Stop the steward". Turning the switch
  off stops the steward at once and leaves no background activity; if you are in the steward view at that moment you
  are returned to the workbench view straight away. "Stop the steward" only halts its own polling and in-flight
  turns; threads already running carry on under their own permission.
- **Steward persona**: a name and a tone preference. It changes only how the steward speaks, never permissions or
  discipline.
- **What the steward may do on its own**: retry once after a failure, resume after a restart, hand off within a
  task, open a new thread when needed, keep an unfinished thread going on its own, answer a thread's question for you
  while you are away (only with a source), and approve a permanently exempt action under its rules (section 9).
  This list only applies to threads at "Edit files without asking" or above; threads that ask every step only ever
  get a suggestion, and anything left unticked is only ever suggested.
- **Pace & context**: how often to check the inbox, the idle time that starts a new visit, how long to keep the
  steward conversation, the steward's context budget and the compaction trigger. **"Name each thread
  automatically" is in this group too**: for each new thread it spends one small call to produce a short name and a
  one-line gist instead of using your whole message as the title; your own words are never rewritten (hover to see
  them in full).
- **Task index**: how many recent threads the rail keeps (10 to 200); threads outside that window can still be
  found by search.
- **Scheduled tasks**: see section 9.
- **What the steward remembers about you**: the preferences and habits it noted. Every entry can be edited, vetoed or
  restored, and the whole set can be exported or cleared. They enter only the steward's own prompt, never ordinary
  threads.
- **Action log**: the record of everything the steward did for you: what, on which thread, when, and whether it can be
  undone.

The model the steward uses (blank follows the main endpoint, but the steward cannot run when the main endpoint is a
command-line engine, and the page says which setting to change) is chosen under Settings → Models & Services →
Model assignment; its hourly turn cap, daily spending cap and how many threads may run at once are under Settings →
General → Usage & limits; and the default permission level for new threads is under Settings → General →
Permissions & safety (the top-bar shield is the same setting). **Switching to Smart auto or Fully automatic always
asks you to confirm again** (each with its own explanation); Settings, the top-bar shield and a thread header's
permission chip go through the same gate. A single thread can be tightened from its own chip, but only tightened,
never loosened.

Keyboard: in the steward view **Esc closes one layer at a time**: the topmost layer first (menu, candidate list,
evidence pop-over), and the thread drawer on the right only once they are all closed.

## 6. Skills, memories, usage, and workflows

Skills are reusable expert workflows. Use **Enable for chat** for temporary needs or **Keep resident** to make a
skill available across chats. Resident skills still use progressive loading: only a compact index is always present,
and the full guide is opened when relevant. Each skill card can show its complete workflow and quality checks.

Built-in commands insert the same editable full task template in both engines (in Claude Code they exist only as
`/offline-toolkit:name`, once the installer has added the plugin); your own commands in `~/.claude/commands` insert
`/name` under the Claude Code engine and the CLI expands them. Playbook forms can also reveal their complete execution
guide before run.

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

The Usage tab in the right pane groups tokens and cost by engine, provider, thread, and day. It labels subscription-plan traffic
honestly rather than inventing a monetary cost, and includes sub-agent and compaction usage. You can set a monthly
budget warning. Provider settings support default input, cache-hit, and output rates plus exact per-model overrides
within the same provider. Blank model fields inherit provider defaults, and a blank cache-hit rate conservatively
uses the normal input rate. The Usage page also reports cache-hit tokens.

In a multi-agent workflow, open a running node to send a directed instruction that is delivered before its next
model call. A proposed task card tells you who proposed a new node, what it does, and its estimated budget; you
choose Add task or No thanks.

## 7. FAQ

**No engine is ready.** Configure an Agent CLI path or add a model provider in Settings (section 5); the connection status in the thread header turns green once one works.

**Why am I seeing a permission prompt?** Ruyi is asking before a sensitive action. Review the action, scope, and
reversibility, then approve or reject it. If you ignore it, it **waits without a time limit by default** (the prompt folds
into the small tray at the bottom right); if you or an administrator set a limit under Settings → General →
Permissions & safety, a permission request is rejected at the deadline (Ruyi never approves for you), and an
unattended scheduled-task prompt is rejected after 30 minutes (configurable).

**How do I undo a change?** Open the Changes tab in the right pane to undo one edit or a whole turn, and the
Activity tab to see what Ruyi did; each answer also carries a turn-changes card. Operations without a usable
before-snapshot are explicitly marked as not automatically reversible and are never counted as undone.

**Does Ruyi work offline?** Local files, scripts, desktop control, Office work, PDF export, and OCR are local.
Only online search needs a configured network service.

**The conversation is long.** Open the context meter in the thread header and use Compact now. Manual compaction runs in
the same order as automatic compaction: it saves a snapshot, then folds old tool results (free, and the originals stay
recoverable); if that is enough it stops there, and only if it is not does it summarise earlier context. A summary is
followed by an index of the tool calls already made, and the AI can fetch the originals by that index with
`observation_recall`, so the chat carries on.

**The AI handed work to background agents and then went quiet.** By default, when background agents finish the
workbench starts a turn by itself and hands the results to the AI, so you do not have to say anything (each delivered result wakes
the conversation once; at most 6 wake-ups happen in a row and your next message resets the count; stopped, cancelled or
restart-interrupted agents and the steward conversation never wake it; neither do runs you started yourself from the Agent workflows panel, nor anything after you pressed Stop or rewound the conversation - those results wait for your next message). If you turned off "Wake the conversation when background agents finish" under Settings →
General → Usage & limits → Concurrency, the results arrive with your next message instead.

## 8. Local models (Ollama / LM Studio)

Ruyi can talk to a model running on your own computer. This route needs **no API key and no internet access**.

### Three steps

1. Install Ollama or LM Studio on this computer and leave its local server running.
2. In Ruyi, open step 3 of the welcome wizard (gear menu → Help → Reopen the setup guide brings it back any time) and pick the
   **Ollama (local model, no key)** or **LM Studio (local model, no key)** preset card.
3. Leave the API key blank and press Test connection. Ruyi asks the local server which models it has and fills
   the model list under Advanced; choose one, press Save and continue, and the top bar switches to it.

Settings → Models & Services → Model providers behaves the same way: neither preset requires a key, and the key field says so.

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

> **The prerequisite, stated plainly.** Transcription endpoints come in two dialects. Ruyi speaks both, but
> **you have to tell it which one this provider speaks**. The default is the OpenAI-shaped
> `/audio/transcriptions`; of the four ASR models tested on the developer's own machine — MiMo, two on Bailian,
> and Hunyuan — **not one offers it; all four returned 404**, because they expose ASR through the chat endpoint
> instead. So **record one short take right after you configure it**. If it fails, you did not configure it
> wrong — the protocol is most likely set wrong. Ask your administrator to go to Settings → "Models and
> services" → expand that provider's "Protocol & capabilities" → set "Speech-to-text protocol" to **Chat
> style**, then try again. MiMo and Bailian work over the chat style on the developer's machine; the Hunyuan
> one was never verified on either.

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
| The transcription service did not succeed this time | The provider's end errored or is unreachable — most often **the wrong protocol** as described above (the default `/audio/transcriptions` is missing there and returns 404). |
| No words were recognized | The transcript came back empty. Try a quieter room, closer to the microphone, and say it again. |

**Two known limits.** First, microphone permission inside the desktop shell (the WebView2 host) **has not been
verified**: the button is still drawn, and if pressing it lands on "Microphone permission was not granted", open
Ruyi in a browser instead. Second, the only recording format is webm/opus, and a browser that does not support it
shows no microphone at all — there is no fallback path.

**Also**: you can **attach a recording as a file**. Ruyi transcribes it best-effort and hands the text to the
model with the file. A failed transcription never blocks the upload, and the original file stays downloadable.

**Names and jargon keep coming out wrong? Use the voice vocabulary.** Settings → Voice recognition, the last card: one term per line for words you say often that keep getting misrecognized (names, projects, jargon), optionally followed by how they tend to be misheard, e.g. `Kubernetes = 酷伯奈提斯`; then click "Save vocabulary". These are **hints, never blind replacements**: live recognition uses them as hotwords, and the end-of-sentence re-listening (local Qwen3-ASR or a Whisper-style cloud endpoint) and LLM correction switch to a term only when both the sound and the context fit. A built-in list of 472 common Chinese/English terms (tech, office, AI, game engines) is on by default and is only hinted when a sentence looks like a mishearing of one; you can turn it off. Conversational cloud recognizers (e.g. MiMo) don't get the list yet.

**It remembers what you fix.** After dictating, the words you correct by hand before sending (say, `张伟` → `张玮`, or `刀客` → `Docker`) are checked when you send: if the change sounds alike and looks like a name or a term that was misheard, it goes into this vocabulary so recognition leans that way next time. A term is learned after you make the same fix twice (once is enough for terms on the built-in list or words you have typed yourself); if LLM correction is configured, that model is also asked to double-check, and when it agrees the term is learned at once, with names learned in full. A short notice ("Learned: 刀客 → Docker") tells you when a new word is learned. English proper nouns you type yourself without dictating (such as `useState` or `GitHub Actions`) are collected too once they show up in three messages. Learned words appear in the vocabulary text box; delete one and it will never be learned again, and one you keep changing back is retired on its own after two reversals. To stop learning, untick "Learn from my edits" on the card. It all stays on this machine: the edited text never goes into the logs, and only when LLM double-checking is configured are the edited sentences sent to that model.

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
3. You have not told the steward to leave this thread alone (from 2026-10, a thread you opened yourself is in
   scope as long as it runs in smart auto; one you marked "stop watching" still asks you). And **while you are
   sitting in that thread, or its permission dialog, the pending-items panel, or its focus pane is in front of
   you, the steward stays out of it** — that one waits for your own hand until you minimize it or have been away
   for more than a minute.
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

**Will the steward just say "left for you"?** A permission request from a smart-auto thread is the steward's to
handle: it approves, denies, or hands it to you saying what is blocking. If it takes no position in a turn, the
workbench asks it once more by name; only if it still takes none do you get the "left for you" notice.

**Nothing was delegated and the job is stuck?** Open that thread and press the button yourself — **the path you
press by hand was never restricted**. Permission requests on ordinary threads **wait without a time limit by
default** until you answer (you can set one in Settings); an unattended scheduled-task thread waits 30 minutes
(configurable) and then rejects automatically — it never approves on your behalf by timing out — so go back and
press **Run now** to run it again.
