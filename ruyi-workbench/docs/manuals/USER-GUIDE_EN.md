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
- Files shows the workspace tree and previews text files. Artifacts lists files generated in the current chat.
  Audit shows a filterable timeline of actions and decisions. Changes shows reversible file edits grouped by turn.
  Agent Workflows is the monitoring canvas for multi-agent orchestrations. Usage displays token consumption
  and cost for the current turn.
- The composer supports attachments, task cards, slash commands, and ordinary natural-language requests.
- Simple mode hides developer-oriented panels and uses plain-language labels. Pro mode exposes terminal, desktop,
  MCP, debugging, and storage panels.

## 5. Settings

Configure either a local Claude CLI path or an OpenAI-compatible provider; one configured engine is enough to
start. Provider keys are stored locally and masked in UI responses.

The Web Search page configures SearXNG, Bing, Brave, Tavily, Bocha, or a custom endpoint. It is optional.

On the General page, choose Simple or Pro UI, detailed or concise response style, and language: Follow system,
Simplified Chinese, or English.

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
budget warning.

In a multi-agent workflow, open a running node to send a directed instruction that is delivered before its next
model call. A proposed task card tells you who proposed a new node, what it does, and its estimated budget; you
choose Add task or No thanks.

## 7. FAQ

**No engine is ready.** Configure a Claude CLI path or add a provider in Settings, then select it in the top bar.

**Why am I seeing a permission prompt?** Ruyi is asking before a sensitive action. Review the action, scope, and
reversibility, then approve or reject it. An unattended prompt expires as a rejection.

**How do I undo a change?** Open Audit or Changes, inspect the checkpointed change, and roll back the entry or
whole turn.

**Does Ruyi work offline?** Local files, scripts, desktop control, Office work, PDF export, and OCR are local.
Only online search needs a configured network service.

**The conversation is long.** Open the context meter and use Compact now; Ruyi summarizes earlier context so the
chat can continue.
