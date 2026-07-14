# Ruyi Architecture

This is the English companion to [架构说明](ARCHITECTURE_CN.md).

## Components

Ruyi has a framework-less browser frontend and a Node.js local server. The browser handles chats, workspace
selection, settings, permission cards, file and audit views, workflow monitoring, and language resources. The
server owns configuration, session persistence, provider and Claude CLI engines, tool execution, checkpoints,
audit records, MCP bridging, workflow scheduling, skills, memories, and usage ledgers.

## Engines

The provider engine communicates with OpenAI-compatible HTTP and streaming endpoints. The optional Claude CLI
engine runs a user-supplied local executable and injects the generated workbench MCP configuration. Both engines
share the same session, local tools, permission policy, checkpoint journal, audit model, skills, and memories.

## Entry points and HTTP API

serve starts the loopback UI and API. mcp starts the stdio MCP endpoint. install and mcp-config generate or register
MCP configuration; doctor reports deployment readiness.

The HTTP API serves static assets, configuration, sessions, tool actions, files, checkpoints, audit events,
providers, workflows, usage, memories, and MCP integration. Sensitive browser routes require the per-process page
token. Error responses use stable code/params/message objects so the frontend can localize them without branching
on a human-language error string.

## Workbench MCP and external MCP

The workbench's stdio MCP server exposes local Windows capabilities to Claude CLI. External stdio MCP servers can be
added through a drop-in manifest and bridged into the provider tool loop. Permission tiers, path guards, checkpoint
coverage, and audit logging continue to apply at the workbench boundary.

## Workflows, skills, memories, and usage

Agent workflows persist DAG state, dependency edges, budgets, retries, resource leases, quality gates, optional Git
worktree isolation, task-pool proposals, mailbox messages, and directed steering queues. The browser monitors runs
incrementally and can pause, resume, stop, retry, or approve proposed work.

Skills come from built-in, user, project, and playbook sources and are progressively injected. Workbench memory is
stored globally or per project and enters prompts only through bounded, fenced indexes. Usage ledgers append local
records and summarize tokens, currency-specific estimates, plan-included traffic, and budgets.

## Data root

The data root contains config.json, runtime metadata, sessions, uploads, logs, generated files, checkpoints,
playbooks, skills, web cache, agent runs, workflows, worktrees, usage ledgers, and memory. Sensitive paths are not
exposed through ordinary file tools. Configure RUYI_HOME when an installation requires a different location.
