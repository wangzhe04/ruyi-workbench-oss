// 13f-native-tool-schemas.js - 110-1: 从 13-http-router.js 搬出的原生工具 schema 数组 MCP_TOOLS(纯搬家,零行为变更)。
const MCP_TOOLS = [
  ...adaptiveMetaToolSchemas(true),
  {
    name: 'workbench_memory_list',
    description: 'List/search confirmed Workbench Memory metadata for the current project and global scope. Use when the user asks what is remembered or the injected memory preflight/index is insufficient. This does not read full bodies.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Optional relevance query. Omit to list newest entries.' },
        scope: { type: 'string', enum: ['all', 'project', 'global'], default: 'all' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
    },
  },
  {
    name: 'workbench_memory_read',
    description: 'Read one confirmed Workbench Memory entry by id. Read only entries relevant to the current request and verify stale facts against the workspace before relying on them.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'Optional unless the same id exists in both scopes.' },
      },
    },
  },
  {
    name: 'workbench_memory_propose',
    description: 'Submit one durable memory candidate for user review. It never saves directly: the user must confirm the card shown after the turn. Use when the user explicitly asks to remember something, or for a stable preference, confirmed project convention/decision, or verified recurring lesson that is not already in repository files. Never include secrets, transient status, guesses, or ordinary task output.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['name', 'description', 'type', 'scope', 'body', 'reason'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', minLength: 1, maxLength: 400, description: 'When this memory is useful.' },
        type: { type: 'string', enum: ['preference', 'convention', 'lesson', 'reference'] },
        scope: { type: 'string', enum: ['project', 'global'], description: 'Use global only for an explicitly cross-project personal preference.' },
        body: { type: 'string', minLength: 1, maxLength: 4000, description: 'Concise Markdown with conclusion, applicability and concrete practice.' },
        reason: { type: 'string', minLength: 1, maxLength: 240, description: 'Why this will remain useful across future sessions.' },
      },
    },
  },
  {
    name: 'workbench_memory_relation_propose',
    description: 'Propose a relation edge between two existing confirmed Workbench Memory entries (supports/contradicts/supersedes/derived_from). It never saves directly: the user must confirm the card after the turn. from/to must be memory ids that already exist in the same scope.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['type', 'from', 'to'],
      properties: {
        type: { type: 'string', enum: ['supports', 'contradicts', 'supersedes', 'derived_from'], description: 'How from relates to to.' },
        from: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Source memory id (must exist in the target scope).' },
        to: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Target memory id (must exist in the target scope).' },
        scope: { type: 'string', enum: ['project', 'global'], default: 'project', description: 'Scope of both from/to.' },
        note: { type: 'string', maxLength: 200, description: 'Optional short rationale for the relation.' },
        reason: { type: 'string', maxLength: 240, description: 'Why this relation is worth confirming.' },
      },
    },
  },
  {
    name: 'workbench_memory_revise',
    description: 'Propose a revision to an existing confirmed Workbench Memory entry (name/description/type/body). It never saves directly: the user must confirm the card after the turn. Provide the suggested replacement values; unchanged fields may be omitted.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['id', 'reason'],
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Memory id to revise.' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'Scope of the target memory.' },
        name: { type: 'string', minLength: 1, maxLength: 120, description: 'Suggested replacement name (omit to keep).' },
        description: { type: 'string', minLength: 1, maxLength: 400, description: 'Suggested replacement description (omit to keep).' },
        type: { type: 'string', enum: ['preference', 'convention', 'lesson', 'reference'], description: 'Suggested replacement type (omit to keep).' },
        body: { type: 'string', minLength: 1, maxLength: 4000, description: 'Suggested replacement Markdown body (omit to keep).' },
        reason: { type: 'string', minLength: 1, maxLength: 240, description: 'Why the entry is stale/wrong and should be revised.' },
      },
    },
  },
  {
    name: 'workbench_memory_relation_revoke',
    description: 'Propose revoking (deleting) an existing memory relation edge. It never deletes directly: the user must confirm the card after the turn. Use relationId from listMemoryRelations or a prior confirmed relation.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['relationId'],
      properties: {
        relationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Relation edge id to revoke.' },
        note: { type: 'string', maxLength: 200, description: 'Optional short rationale for revoking.' },
        reason: { type: 'string', maxLength: 240, description: 'Why this edge should be removed.' },
      },
    },
  },
  {
    // 105a: offered only when runtimeObservationRecallV1 AND runtimeObservationReducerV1 are both on
    // (buildOpenAiTools / MCP tools/list / adaptive catalog all gate on the pair; the handler fails closed too).
    name: 'observation_recall',
    description: 'Recall the original content of a tool result reduced during context compaction, using the rawRef embedded in its reduced view (format history:<turn>:<hash>:<index>:<hash>). When a user asks for an exact historical value/detail and a relevant earlier tool result is marked reduced or omitted, call this tool before answering; never conclude the detail is absent from the reduced view alone. Read-only; resolves only snapshots of the CURRENT session. Stable failure envelope {ok:false,error}: invalid_ref | not_found (snapshot GC\'d) | hash_mismatch | quota_exceeded (8 recalls per turn — do not retry the same ref after this) | disabled.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['rawRef'],
      properties: {
        rawRef: { type: 'string', description: 'The rawRef= value embedded in a reduced observation view.' },
        maxChars: { type: 'integer', minimum: 1000, maximum: 60000, default: 8000, description: 'Cap on returned characters; longer originals are head/tail truncated with truncated:true.' },
      },
    },
  },
  {
    name: 'permission_prompt',
    description: 'Internal: handles --permission-prompt-tool requests by asking the workbench UI to allow/deny a tool call.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object' },
      },
    },
  },
  {
    name: 'powershell_run',
    description: 'Run a one-shot PowerShell command on Windows. For a persistent/interactive terminal that keeps state across calls, use shell_start/shell_send instead.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['command'],
    },
  },
  // v0.8-S2 shell session族 — a persistent PowerShell terminal that keeps working directory, variables,
  // and background processes alive across calls. AVAILABLE ONLY on the native provider engine: session
  // state lives in the serve process. Under the Claude CLI engine (tools run in a one-shot MCP subprocess)
  // these return a guiding error — use powershell_run for one-shot commands there.
  {
    name: 'shell_start',
    description: 'Start a persistent PowerShell session (keeps cwd/vars/background processes across calls). Provider engine only. Returns {shellId}. Then drive it with shell_send / shell_poll.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'working directory (defaults to home)' },
        name: { type: 'string', description: 'human-readable label' },
        shellId: { type: 'string', description: 'optional deterministic id ([a-zA-Z0-9_-]{1,32}); auto-generated if omitted' },
      },
    },
  },
  {
    name: 'shell_send',
    description: 'Send a line of input to a shell session and return the output that settles within timeoutMs (best-effort; long tasks: track with shell_poll). output is the increment since the last cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        shellId: { type: 'string' },
        input: { type: 'string' },
        timeoutMs: { type: 'number', description: 'max wait for output to settle (default 10000)' },
      },
      required: ['shellId', 'input'],
    },
  },
  {
    name: 'shell_poll',
    description: 'Read new output from a shell session since an absolute byte cursor. Returns {output, cursor, running, exitCode?, truncated?}. Pass the returned cursor back next time to tail incrementally.',
    inputSchema: {
      type: 'object',
      properties: {
        shellId: { type: 'string' },
        cursor: { type: 'number', description: 'absolute byte offset to read from (default 0)' },
      },
      required: ['shellId'],
    },
  },
  {
    name: 'shell_kill',
    description: 'Terminate a shell session and its process tree. CAUTION: any un-consumed buffered output of that session is lost, and any long-running command inside it is killed.',
    inputSchema: {
      type: 'object',
      properties: { shellId: { type: 'string' } },
      required: ['shellId'],
    },
  },
  {
    name: 'shell_list',
    description: 'List active shell sessions: [{shellId,name,cwd,running,exitCode,startedAt,lastUsedAt,bytes}].',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'script_run',
    description: 'Run a temporary PowerShell, Python, or Node script',
    inputSchema: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['powershell', 'python', 'node', 'javascript'] },
        code: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['code'],
    },
  },
  {
    name: 'file_read',
    description: 'Read a local file. Char slice via offset/limit, or line mode via lineOffset (1-based) / lineLimit (returns cat -n style content with totalLines). Image/binary files are refused (use the vision channel).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number', description: 'char offset (char-slice mode)' },
        limit: { type: 'number', description: 'char count (char-slice mode)' },
        lineOffset: { type: 'number', description: '1-based start line (line mode)' },
        lineLimit: { type: 'number', description: 'number of lines to return (line mode)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description: 'Write a local file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' }, createDirs: { type: 'boolean' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_edit',
    description: 'Replace text in a local file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } },
      required: ['path', 'oldText', 'newText'],
    },
  },
  {
    name: 'file_delete',
    description: 'Delete a local file (checkpointed first, so it can be rolled back). Directories are refused.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'file_move',
    description: '移动或重命名一个文件（from→to）。已先存检查点，可一键撤销。默认不覆盖已存在的目标（overwrite=true 才覆盖）。仅支持单个文件，不支持文件夹；跨磁盘自动退化为复制+删除。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源文件绝对路径' },
        to: { type: 'string', description: '目标绝对路径（含新文件名即为重命名）' },
        overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'file_copy',
    description: '复制一个文件（from→to）。目标已存在时会先存检查点，可一键撤销。默认不覆盖（overwrite=true 才覆盖）。仅支持单个文件，不支持文件夹。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源文件绝对路径' },
        to: { type: 'string', description: '目标绝对路径' },
        overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'archive_zip',
    description: '把工作区内的文件/文件夹打包成一个 .zip（deflate 压缩，中文文件名正确保留）。dest 已存在时先存检查点，可撤销。单文件上限 100MB、总量上限 500MB，超限会人话拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '要打包的文件或文件夹的绝对路径数组' },
        dest: { type: 'string', description: '输出 .zip 的绝对路径' },
      },
      required: ['paths', 'dest'],
    },
  },
  {
    name: 'archive_unzip',
    description: '把一个 .zip 解压到 destDir（支持 stored/deflate 两种压缩方式）。含越界路径（Zip Slip，如 ..\\）的压缩包会被整包拒绝；符号链接条目会被跳过。条目数上限 2000、解压总量上限 500MB。覆盖已存在文件需 overwrite=true，覆盖前会存检查点。',
    inputSchema: {
      type: 'object',
      properties: {
        src: { type: 'string', description: '要解压的 .zip 绝对路径' },
        destDir: { type: 'string', description: '解压目标文件夹的绝对路径' },
        overwrite: { type: 'boolean', description: '覆盖已存在的文件，默认 false' },
      },
      required: ['src', 'destDir'],
    },
  },
  {
    name: 'http_download',
    description: '从一个 http(s) 网址下载文件保存到工作区内的 dest（内网/回环地址会被 SSRF 防护拒绝）。dest 已存在时先存检查点，可撤销。默认单文件上限 100MB（maxBytes 可调），Content-Length 与实际字节都会卡上限，超限拒绝。返回 {path, bytes, contentType}。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要下载的 http(s) 网址' },
        dest: { type: 'string', description: '保存到的绝对路径（须在工作区内）' },
        maxBytes: { type: 'number', description: '最大字节数，默认 100MB' },
        timeoutMs: { type: 'number', description: '单请求超时（毫秒），默认 30s' },
      },
      required: ['url', 'dest'],
    },
  },
  {
    name: 'file_list',
    description: 'List files under a directory',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' }, pattern: { type: 'string' }, recursive: { type: 'boolean' }, maxFiles: { type: 'number' }, maxDepth: { type: 'number' } },
    },
  },
  {
      name: 'file_search',
      description: 'Search text (regex, per line) in files under a directory. Optional context lines, relative-path glob filter, and per-file grouping.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string' }, pattern: { type: 'string' },
          maxResults: { type: 'number' }, maxFiles: { type: 'number' }, maxDepth: { type: 'number' },
          ignoreDirs: { type: 'array', items: { type: 'string' } },
          context: { type: 'number', description: '0-5 lines of context before/after each match' },
          glob: { type: 'string', description: 'relative-path glob filter (** / * / ?) restricting scanned files' },
          group: { type: 'boolean', description: 'group results by file: [{path, matches:[...]}]' },
        },
        required: ['pattern'],
      },
  },
  {
    name: 'glob',
    description: 'Find files by glob pattern (** crosses dirs, * within a segment, ? one char). Returns matches sorted by mtime (newest first).',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, root: { type: 'string' }, maxResults: { type: 'number' }, maxDepth: { type: 'number' } },
      required: ['pattern'],
    },
  },
  {
    name: 'browser_open',
    description: 'Open a URL or local HTML file in a new tab of the default browser. Never navigate or close the current Ruyi Workbench tab.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'mcp_list',
    description: 'List the currently configured built-in and external MCP connectors, their launch command, argument list, working directory, environment key names, and browser target. Secret environment values are never returned. Use this before changing tool/MCP configuration.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mcp_configure',
    description: 'Configure tools/MCP on the user\'s explicit request. Supports upsert/remove/enable of an external stdio MCP connector and changing the ai-computer-control browser target. This is an exec-tier persistent configuration change: inspect with mcp_list first, explain the diff, and rely on the permission prompt before applying. It cannot replace the built-in desktop MCP executable or edit application binaries.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['upsert', 'remove', 'set-enabled', 'set-browser'] },
        id: { type: 'string', description: 'External MCP id for upsert/remove/set-enabled.' },
        enabled: { type: 'boolean', description: 'For set-enabled.' },
        server: { type: 'object', description: 'For upsert: {id,label,command,args[],cwd,env{},enabled}. Keep credentials only in env and never echo them after saving.' },
        browser: { type: 'object', description: 'For set-browser: {mode:system|managed|custom|cdp|bundled, executable?, cdpUrl?}. system is the safe default and uses the user browser plus desktop UIA/OCR.' },
      },
      required: ['operation'],
    },
  },
  {
    name: 'office_open',
    description: 'Open a local Office document with the default application',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'desktop_screenshot',
    description: 'Capture the primary Windows screen to a PNG file',
    inputSchema: {
      type: 'object',
      properties: { outputPath: { type: 'string' }, timeoutMs: { type: 'number' } },
    },
  },
  {
    name: 'keyboard_send_keys',
    description: 'Send keystrokes to the active Windows application. CAUTION: keys go to whatever window currently has focus; SendKeys meta characters + ^ % ~ ( ) { } [ ] are live modifiers (e.g. ^s = Ctrl+S, %{F4} = Alt+F4). Confirm the focus target before sending, and prefer explicit app control over raw keys when possible.',
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'string' }, delayMs: { type: 'number' }, timeoutMs: { type: 'number' } },
      required: ['keys'],
    },
  },
  {
    name: 'project_snapshot',
    description: 'Return a compact project tree snapshot',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' }, maxFiles: { type: 'number' }, maxDepth: { type: 'number' } },
    },
  },
  // v1.0-S4 git 工具族 — 看状态/看差异/看历史/提交。为非程序员管版本(「帮我把这次改动存个版本」)。全部
  // execFile('git',…) 无 shell,模型可控路径一律在 `--` 之后,git 缺失/非仓库/缺身份 → 人话引导错误。
  {
    name: 'git_status',
    description: 'Show the git status of a folder (current branch, ahead/behind, and how many files changed). Read-only. Returns a plain-language summary plus the raw porcelain status.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'the repo folder (defaults to the session/home workspace)' },
      },
    },
  },
  {
    name: 'git_diff',
    description: 'Show what changed in a git repo as a unified diff (the +added / -removed lines). Read-only. Use staged:true to see staged changes, path to limit to one file, contextLines to widen/narrow context.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'the repo folder (defaults to the session/home workspace)' },
        path: { type: 'string', description: 'limit the diff to this file/pathspec' },
        staged: { type: 'boolean', description: 'diff the staged (index) changes instead of the working tree' },
        contextLines: { type: 'number', description: 'lines of context around each change (0..50, default git 3)' },
      },
    },
  },
  {
    name: 'git_log',
    description: 'List recent git commits (hash, date, author, subject) as a table. Read-only. maxCount defaults to 10 (clamped 1..100); path limits history to one file.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'the repo folder (defaults to the session/home workspace)' },
        maxCount: { type: 'number', description: 'how many commits to return (1..100, default 10)' },
        path: { type: 'string', description: 'limit history to this file/pathspec' },
      },
    },
  },
  {
    name: 'git_commit',
    description: 'Save a version: stage changes then create a git commit with the given message. This RUNS git hooks (pre-commit etc.), so it is an exec-tier action. If the repo has no Git identity configured, it returns a guiding error (it never invents a fake name/email).',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'the repo folder (defaults to the session/home workspace)' },
        message: { type: 'string', description: 'the commit message (required) — one line describing the change' },
        addAll: { type: 'boolean', description: 'stage all changes first with `git add -A` (default true when no explicit paths)' },
        paths: { type: 'array', items: { type: 'string' }, description: 'stage only these files (overrides addAll)' },
      },
      required: ['message'],
    },
  },
  {
    name: 'dependency_inventory',
    description: 'Inventory local dependency and runtime configuration files without installing anything',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' } },
    },
  },
  {
    name: 'code_review_scan',
    description: 'Run a lightweight offline code review scan for common security and quality risks',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' }, maxFiles: { type: 'number' }, maxDepth: { type: 'number' }, maxFindings: { type: 'number' }, ignoreDirs: { type: 'array', items: { type: 'string' } } },
    },
  },
  {
    name: 'frontend_audit',
    description: 'Audit frontend files for offline asset and UI polish issues',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' }, maxFiles: { type: 'number' }, maxDepth: { type: 'number' }, ignoreDirs: { type: 'array', items: { type: 'string' } } },
    },
  },
  {
    name: 'claude_md_audit',
    description: 'Find and audit CLAUDE.md project memory files',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' } },
    },
  },
  {
    name: 'docs_search',
    description: 'Search local project documentation as an offline docs lookup',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' }, query: { type: 'string' }, maxResults: { type: 'number' }, maxDepth: { type: 'number' }, ignoreDirs: { type: 'array', items: { type: 'string' } } },
      required: ['query'],
    },
  },
  {
    name: 'codebase_symbol_search',
    description: 'Search a codebase for where a symbol (function/class/method/variable name) is defined and referenced, returning file-level definition/reference evidence grouped by file. Grep-level lexical scan (not AST/type-aware): it matches identifier occurrences by word boundary. Use when auditing or tracing where a symbol is defined and called, so claims are grounded in real file:line evidence instead of name-similarity guesses. Do not use for semantic/type-aware queries, cross-language resolution, or when an exact definition-vs-reference distinction matters (use a language server). The symbol argument is treated as a literal (regex metacharacters are escaped).',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'The symbol name to search (function/class/method/variable).' },
        root: { type: 'string', description: 'Codebase root directory (defaults to workspace).' },
        kind: { type: 'string', enum: ['any', 'definition', 'reference'], description: 'Only return definitions, references, or both (default any).' },
        maxResults: { type: 'number', description: 'Max total matches (default 200).' },
        maxFiles: { type: 'number', description: 'Max files scanned (default 1500).' },
        maxDepth: { type: 'number', description: 'Max directory depth (default 8).' },
        ignoreDirs: { type: 'array', items: { type: 'string' }, description: 'Extra dirs to skip (node_modules/.git/.venv always skipped).' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'debug_hypothesis',
    description: 'Advisory hypothesis/experiment/refutation ledger for structured debugging (bisect/elimination method). Tracks which hypotheses are pending/refuted/supported/confirmed so you can see how many remain unrefuted, catch repeated experiments, and avoid locking a root cause before excluding alternatives. It is a STATELESS helper (the ledger is carried in the conversation, not persisted server-side): pass the ledger returned by the previous call back on every subsequent call. Actions: init(hypotheses[]) to create the ledger, test(hypothesisId,result,evidence) to record a refuting/supporting experiment (refutation is sticky; a refuted hypothesis cannot be revived), conclude(hypothesisId) to lock the root cause (only a supported hypothesis may be concluded; warns if alternatives remain unexcluded), status to see stats + duplicate/contradiction warnings. Do not use when the bug is already obvious or there is nothing to disambiguate.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['init', 'test', 'conclude', 'status'], description: 'State-machine action.' },
        hypotheses: { type: 'array', items: { type: 'object' }, description: 'init: array of {id?, description, mechanism?, expectedEvidence?, verification?}.' },
        ledger: { type: 'object', description: 'Current ledger snapshot (previous call\'s returned ledger); required for test/conclude/status, ignored by init.' },
        hypothesisId: { type: 'string', description: 'test/conclude: target hypothesis id.' },
        result: { type: 'string', enum: ['supports', 'refutes', 'inconclusive'], description: 'test: experiment result.' },
        evidence: { type: 'string', description: 'test: what you did and what you observed.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'data_profile',
    description: 'Profile a data file (CSV/TSV/JSON/JSONL/text log) into a machine-computed summary: row/column counts, per-column type, null/unique counts, numeric min/max/mean/median/std + IQR outlier count, and sample values. Use to replace eyeballing a large file with file_read when you need its structure, scale and data-quality issues (missing/outliers/format) before planning an analysis. Do not use for small files where reading directly is cheaper, or for cleaning/transforming the data (this tool is read-only). Column type and outlier detection are statistical heuristics, not data lineage.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the data file to profile.' },
        maxRows: { type: 'number', description: 'Max rows to sample (default 2000).' },
        delimiter: { type: 'string', description: 'CSV/TSV delimiter; auto-detected when omitted.' },
        maxSampleValues: { type: 'number', description: 'Sample values shown per column (default 5).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'http_request',
    description: 'Make an HTTP request to a local or intranet endpoint for API debugging',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' }, timeoutMs: { type: 'number' }, maxBodyChars: { type: 'number' } },
      required: ['url'],
    },
  },
  // v0.9-S9 (D6): web search + fetch. Only offered when the capability matrix satisfies TOOL_REQUIRES
  // (web_search: network+searchBackend; web_fetch: network). web_fetch's url is SSRF-guarded (rejects
  // loopback/私网/元数据/协议) — an untrusted url can never reach an internal endpoint.
  {
    name: 'web_search',
    description: 'Search the web via the configured search backend (searxng/bing/brave/custom). Returns {results:[{title,url,snippet}]}. Use it for time-sensitive facts, external information, or anything that may have changed after your knowledge cutoff — search first, then answer. Then use web_fetch to read a promising result in full.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'the search query' },
        maxResults: { type: 'number', description: 'max results to return (default 5, clamped 1..20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a public web page over http/https and return its extracted main text + title. Follows redirects (≤3), 10s timeout, ≤2MB. Internal/loopback/metadata addresses are refused for safety. Offline, it serves a cached copy if one exists (fromCache:true). Use it to read a page found via web_search.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'the http(s) URL to fetch' },
        maxChars: { type: 'number', description: 'max characters of extracted text to return (default 20000)' },
      },
      required: ['url'],
    },
  },
  // Shared main-turn question tool. Provider runs it in-process; Claude runs it through the per-session MCP
  // loopback. It is hidden from sub-agents and standalone MCP sessions because neither owns the chat UI.
  {
    name: 'request_user_input',
    description: 'Pause and ask the user one to three concise questions in the workbench UI. Prefer 2-5 concrete, mutually exclusive options whenever the answer can be enumerated; put the recommended option first and label it (Recommended). Choice questions include an Other typed fallback by default. Use text-only mode only when options genuinely cannot represent the answer. The tool returns structured user answers; continue only after it returns.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array', minItems: 1, maxItems: 3,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable identifier within this request; generated when omitted' },
              header: { type: 'string', description: 'Short label for the question' },
              question: { type: 'string', description: 'The question shown to the user' },
              answerMode: { type: 'string', enum: ['single', 'multiple', 'text'], description: 'Single or multiple choice is preferred. Use text only when a useful finite option set cannot be offered. Inferred from options/multiSelect when omitted.' },
              options: {
                type: 'array', description: 'Prefer 2-5 concrete choices. Put the recommended option first and suffix its label with (Recommended). Omit only for genuinely open-ended text answers.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Stable option identifier; generated when omitted' },
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                },
              },
              multiSelect: { type: 'boolean', description: 'Legacy alias for answerMode=multiple' },
              allowOther: { type: 'boolean', default: true, description: 'With single/multiple choices, allow a custom typed fallback. Defaults to true; set false only when custom input would be invalid.' },
              otherLabel: { type: 'string', description: 'Optional label for the custom-answer choice' },
              otherPlaceholder: { type: 'string', description: 'Optional placeholder for the custom-answer input' },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
    },
  },
  // v0.8-S3: task-list (TodoWrite) tool. FULL-REPLACE semantics — each call replaces the whole list.
  // Drives the UI step-bar. State lands on session.todos (provider engine: serve-process closure special-
  // case in runOpenAiTurn; Claude engine: loopback POST /api/todo, since the one-shot MCP child must not
  // write session files — see the todo_write case in toolCall()).
  {
    name: 'todo_write',
    description: 'Record/replace the task list for the current turn (full replace each call). Use it to plan multi-step work and mark progress. items:[{id?,text,status:pending|in_progress|done}]. Drives the workbench step-bar.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
            },
            required: ['text'],
          },
        },
      },
      required: ['items'],
    },
  },
  // 第26波b: 任务账本更新。与 todo_write 同款双引擎持久化路径(provider serve 闭包特例 / Claude 走 loopback
  // POST /api/mission)。仅当会话已有 mission(用户发起长任务)时,模型才被鼓励用它;无 mission 时调用也安全(会创建)。
  {
    name: 'mission_update',
    description: 'Update the long-running task ledger (Mission): mark milestones done/blocked, add milestones, or record evidence. Use it ONLY when a Mission is active for this session (the system prompt shows a <mission-ledger> block). action="update" merges; provide milestones:[{id,desc?,status:pending|done|blocked,evidence?}]. Do NOT invent a Mission for simple one-shot tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        milestones: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              desc: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'done', 'blocked'] },
              evidence: { type: 'string', description: '完成证据摘要(文件/测试/结论)' },
            },
            required: ['id'],
          },
        },
        goal: { type: 'string' },
      },
    },
  },
  // 108c: 只读原生工具 —— 自身运行时详情。数据装配复用 /api/status 的同一组函数(computeHealth/
  // getCapabilities/loadSkillRegistry/getAgentWorkflows 等),不新造事实源;config 段只回显白名单标量字段。
  {
    name: 'workbench_self_status',
    description: '只读查询本工作台自身的运行时状态:版本号、启动模式(exe/源码)、安装位置、数据目录、服务地址与实例标识、健康检查项、原生/ACC 工具数与技能/命令/Playbook/工作流数量,以及当前设置(引擎/端点/模型/权限模式/输出风格/界面语言,已做密钥掩码,绝不含 apiKey/token)。何时用:用户问「你是哪个版本/装在哪/端口是多少/数据目录在哪/当前用哪个模型和权限模式/有多少工具、技能、Playbook」,或你需要核对自身运行环境再回答时,调用本工具而不是凭记忆回答或猜测。何时别用:查询用户项目文件、工作区结构或桌面/浏览器状态时——那应改用 project_snapshot/file_list/ACC diagnostics 等工具;本工具不接受也不触碰任何用户文件路径。section 可选,缩小返回范围以节省上下文,默认 all(全部)。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        section: { type: 'string', enum: ['identity', 'health', 'counts', 'config', 'all'], default: 'all', description: 'identity=版本/位置/端口等恒定量;health=健康检查项;counts=工具/技能/Playbook/工作流计数;config=当前设置(掩码);all=全部(默认)。' },
      },
    },
  },
  // ── 116c(27 号文 §3.5):工作台管家(Steward)工具族 ────────────────────────────────────────────
  // 管家「动如意」,线程「动世界」:本族只操作如意自身(看线程、开线程、递话、答复待决、控制班组、
  // 记管家自己的记忆),【不含】任何作用于外部世界的能力(文件读写/shell/桌面/浏览器/联网/git 写)。
  // 需要动手时管家把任务委派给线程,由线程在其权限模式与授权书约束下执行。
  // 四个 offer 面全部按 isStewardToolName 门控:只有 kind==='steward' 的管家会话拿得到这 17 个工具;
  // handler 内还有 fail-closed 二次校验(非管家会话 -> steward.forbidden;开关关 -> steward.disabled)。
  {
    name: 'steward_self_status',
    description: '只读查询如意工作台自身状态,并附带管家自己的运行段(管家相关设置的掩码回显 + 收件箱状态:是否启用/是否在轮询/当前 inboxSeq/各类事件计数)。何时用:用户问「你是哪个版本/装在哪/端口多少/当前用哪个模型/管家开着吗/收件箱里攒了什么」,或你要核对自身运行环境再作答时。何时别用:查线程进度用 steward_thread_status,查费用用 steward_usage,查健康项细节用 steward_health;本工具不接受也不触碰任何用户文件路径。section 可选,缩小返回范围省上下文。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        section: { type: 'string', enum: ['identity', 'health', 'counts', 'config', 'steward', 'all'], default: 'all', description: "identity=版本/位置/端口等恒定量;health=健康检查项;counts=工具/技能/Playbook/工作流计数;config=当前设置(掩码);steward=管家设置掩码与收件箱状态;all=全部(默认)。" },
      },
    },
  },
  {
    name: 'steward_threads_search',
    description: '按关键词检索线程(会话)——同时匹配标题与正文内容,返回命中线程的 id、所属事项、标题、类型、五态、最后一句助手原话(≤200 字,已中和)、更新时间与相关度分。何时用:用户提到某件事但没说是哪条线程(「上次那个爬虫的事怎么样了」),或你要在递话前先定位目标线程时。何时别用:你已经知道 sessionId 时直接用 steward_thread_status;要看线程里具体说了什么用 steward_thread_read。结果永不包含管家自己的会话。',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['q'],
      properties: {
        q: { type: 'string', description: '检索词(中英皆可)。太短(少于 2 字)会返回空结果并给出 reason。' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: '返回条数上限,夹取到 1..50,默认 10。' },
      },
    },
  },
  {
    name: 'steward_thread_status',
    description: '读一条线程的当前状态:五态(交办中/进行中/需要你/已收工/已停工)、当前动作与最近一步、待决摘要(类型 + 一句话)、权限档、引擎与模型、累计费用与 token、最后一句助手原话(≤200 字)。何时用:用户问「那条线在干嘛/卡在哪/花了多少钱」,或你要判断能不能递话、该不该替他答复待决之前。何时别用:要看具体对话内容用 steward_thread_read;要看班组(Agent 工作流)节点进度用 steward_runs_status。线程不存在返回 {ok:false,error:"not_found"}。',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['sessionId'],
      properties: { sessionId: { type: 'string', description: '线程(会话)id,来自 steward_threads_search / steward_inbox_read / 到访总览。' } },
    },
  },
  {
    name: 'steward_thread_read',
    description: '按需深读一条线程最近若干回合的原话:用户说了什么、助手回了什么、调用了哪些工具(只给一行摘要与结果长度/rawRef,不给工具输出全文)。何时用:总览与 steward_thread_status 不够你判断下一步时,针对性读一条线程。何时别用:例行汇报——总览每回合都在,不必逐条深读;也不要用它来「补全上下文」批量扫线程,读取是记账的。配额:每回合最多 6 次、单次 ≤12000 字符、本次到访累计受 stewardReadBudgetChars 限制;超限返回 {ok:false,error:"quota_exceeded"} 或 {ok:false,error:"budget_exceeded"},此时不要重试,改用已有信息作答或向用户说明。读到的内容不写入任何持久化,也不进管家记忆。',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: '线程(会话)id。' },
        tail: { type: 'integer', minimum: 1, maximum: 20, default: 6, description: '往回读几个回合,夹取到 1..20,默认 6。' },
        maxChars: { type: 'integer', minimum: 1000, maximum: 12000, default: 12000, description: '本次返回的字符上限,夹取到 1000..12000;超出从最早的回合开始丢弃并标 truncated。' },
      },
    },
  },
  {
    name: 'steward_runs_status',
    description: '读 Agent 班组运行(工作流 DAG)的概览:每个 run 的状态、节点完成进度、是否暂停/在等什么、累计费用。何时用:线程状态显示在跑班组,而用户问「跑到第几步了/卡住了吗」,或你要在 steward_run_action 之前确认 runId 与节点 id。何时别用:普通对话线程(没有班组)用 steward_thread_status 就够。省略 sessionId 时返回全部线程的班组概览(有界)。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { sessionId: { type: 'string', description: '可选。只看这条线程的班组;省略则看全部。' } },
    },
  },
  {
    name: 'steward_inbox_read',
    description: '读管家收件箱:五类归一化事件(需要你 needs_you / 失败 failed / 收工 done / 停滞 stalled / 预算 budget)按 inboxSeq 递增排列。何时用:每个回合开头拉取上次游标之后的新事件,决定该提议什么、该做什么。何时别用:它不是对话历史,也不是完整审计流——要看审计用 steward_audit_tail。传 since=上次拿到的最大 inboxSeq 做增量,不要每次从 0 全量拉。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        since: { type: 'integer', minimum: 0, description: '只返回 inboxSeq 大于该值的事件(增量游标);省略等于 0。' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: '返回条数上限,夹取到 1..200,默认 50。' },
      },
    },
  },
  {
    name: 'steward_usage',
    description: '读用量与费用台账:按线程或按日汇总 token 与花费,并把管家自身开销(kind=aux、note=steward)单列。何时用:用户问「今天/这条线花了多少」,或你要在开新线程前核对预算。何时别用:要看单条线程的状态与最近一步用 steward_thread_status。金额按币种分列,不做汇率换算(诚实优先)。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: '可选。只统计这条线程。' },
        day: { type: 'string', description: "可选。只统计某一天,格式 YYYY-MM-DD(本地日历日)。" },
      },
    },
  },
  {
    name: 'steward_health',
    description: '读工作台健康检查项(体检):每项的 id、是否正常与一句话细节。何时用:用户说「怎么不好使了/是不是坏了」,或某条线程反复失败而你怀疑是环境问题时。何时别用:线程自身失败的原因在 steward_thread_status 的待决摘要与 steward_runs_status 里,不在这里。返回原始项,人话解释由你来说。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'steward_audit_tail',
    description: '读审计时间线尾部(最近的工作台事件,已过既有脱敏)。何时用:用户问「刚才发生了什么/是谁改的/我批准过什么」,或你要为一个决定给出可查证的依据时。何时别用:找线程内容用 steward_threads_search;找待办事件用 steward_inbox_read。limit 夹取到 1..100。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: '返回条数上限,夹取到 1..100,默认 20。' } },
    },
  },
  {
    name: 'steward_thread_new',
    description: '按【委托书】新开一条线程并立刻让它跑起来。委托书结构固定:brief.userText 是用户原话(逐字放在首条消息最前,绝不改写),你的补充(目标/验收项/相关文件/偏好/约束)经中和后放在其后的管家围栏里、总长 ≤1200 字。何时用:用户提出的是一件要动手做的新事(要读写文件、跑命令、联网、做东西)。何时别用:关于如意自身、事项、费用、设置的问题你直接回答,不要为此开线程;已有对口线程时改用 steward_thread_continue。本工具是管家唯一的「动世界」出口——你自己没有文件/shell/桌面工具,想动手就必须经由线程。返回 {ok,sessionId,missionId,undoRef};回合是后台异步跑的,返回时通常还没有结果。',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['brief'],
      properties: {
        title: { type: 'string', description: '可选。线程标题;省略则由首条消息自动命名。' },
        missionId: { type: 'string', description: '可选。把新线程归入已有事项;省略则新线程自成事项。' },
        cwd: { type: 'string', description: '可选。线程的工作文件夹;省略则用全局默认工作区。这只是线程的起点目录,不是你自己能读写的路径。' },
        brief: {
          type: 'object', additionalProperties: false, required: ['userText'],
          description: '委托书。userText 必填且逐字保留;其余各段是你的补充,对用户可见、可改、可删,不得改写用户意图。',
          properties: {
            userText: { type: 'string', description: '用户原话,逐字。' },
            goal: { type: 'string', description: '一句话目标。' },
            acceptance: { type: 'array', items: { type: 'string' }, description: '验收项(做到什么算完成)。' },
            context: { type: 'array', items: { type: 'string' }, description: '相关文件、目录或已知事实。' },
            preferences: { type: 'array', items: { type: 'string' }, description: '用户偏好(格式/语言/风格)。' },
            constraints: { type: 'array', items: { type: 'string' }, description: '约束与红线。' },
            playbookId: { type: 'string', description: '可选。建议线程参考的 playbook id。' },
            memoryIds: { type: 'array', items: { type: 'string' }, description: '本次补充引用到的管家记忆条目 id(用于事后解释「因为你上次说…」)。' },
          },
        },
      },
    },
  },
  {
    name: 'steward_thread_continue',
    description: '把一句话递给一条已有线程并让它继续跑。message 是【原话直递】——不改写、不加你的注解;有补充要说,先递原话再另行插话。何时用:用户的话明确属于某条已有线程(接着上次的事继续说)。何时别用:目标线程正忙(在途回合)时会返回 {ok:false,error:"steward.busy"},不要轮询重试,先向用户说明或等它停;新的一件事用 steward_thread_new;管家自己的会话不能作为目标。返回 {ok,sessionId,undoRef},undoRef 锚在递话前的 turnSeq(可用于回退检查点)。',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['sessionId', 'message'],
      properties: {
        sessionId: { type: 'string', description: '目标线程 id(不能是管家自己的会话)。' },
        message: { type: 'string', description: '要递过去的话,原话直递。' },
      },
    },
  },
  {
    name: 'steward_thread_rename',
    description: '给线程改一个更贴切的标题。何时用:自动命名明显词不达意,或用户说「把那条改叫 X」。何时别用:不要为了「整理」批量改名——标题是用户认线程的锚点。返回 {ok,sessionId,title,undoRef},undoRef 带旧标题可一键改回。',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['sessionId', 'title'],
      properties: {
        sessionId: { type: 'string', description: '线程 id。' },
        title: { type: 'string', description: '新标题(≤80 字)。' },
      },
    },
  },
  {
    name: 'steward_decide',
    description: '替用户答复一条线程的待决(权限请求 permission / 提问 question / 计划 plan / 任务池 pool)。放行范围由【目标线程自己的权限档】决定,你没有独立档位:每步都问/只做计划 -> 一律只提议;改文件不问 -> 只可放行 read/edit 级权限请求;全自动 -> 除永久豁免外都可替答。不该由你答的会返回 {ok:false,error:"propose_required",reason},此时【不要重试】,把这件事作为提议交给用户按。永久豁免(对外发送/支付/安装卸载/系统设置/关机格式化等不可撤销且外溢的动作)在任何权限档都返回 propose_required。何时用:收件箱出现 needs_you 且目标线程权限允许你代答。何时别用:你拿不准用户意图时——宁可提议。expectedVersion 省略则用当前版本(并发改动会返回 version_conflict,属正常,重读后再决定)。',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['missionId', 'interventionId', 'action'],
      properties: {
        missionId: { type: 'string', description: '待决所属事项/线程 id(收件箱事件里的 missionId)。' },
        interventionId: { type: 'string', description: '待决 id。' },
        action: { type: 'string', enum: ['allow', 'deny', 'answer', 'approve', 'reject'], description: 'permission 用 allow/deny;question 用 answer;plan/pool 用 approve/reject。' },
        payload: { type: 'object', description: '按类型的附加内容:question 需要 {answer:{answers:[...]}};plan 可带 {feedback};permission 可带 {updatedInput}。' },
        expectedVersion: { type: 'integer', minimum: 0, description: '可选。乐观并发版本;省略则读当前值。' },
      },
    },
  },
  {
    name: 'steward_run_action',
    description: '控制一条线程的 Agent 班组运行:pause(暂停)/stop(停止)/resume(继续)/retry_node(重跑某节点)/steer_node(给某节点插话)。收紧类动作(pause、stop)在任何权限档都可做;推进类动作(resume、retry_node、steer_node)只在目标线程为「全自动」时可做,否则返回 {ok:false,error:"propose_required"} —— 此时把它作为提议交给用户按,不要重试。何时用:收件箱出现 stalled/failed 且你判断重跑或停下是对的。何时别用:不清楚失败原因时先 steward_runs_status 看清楚再动手。',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['sessionId', 'runId', 'action'],
      properties: {
        sessionId: { type: 'string', description: '线程 id。' },
        runId: { type: 'string', description: '班组运行 id(来自 steward_runs_status)。' },
        action: { type: 'string', enum: ['pause', 'resume', 'stop', 'retry_node', 'steer_node'], description: '要执行的动作。' },
        nodeId: { type: 'string', description: 'retry_node / steer_node 必填:目标节点 id。' },
        message: { type: 'string', description: 'steer_node 必填:插话内容(≤2000 字)。' },
      },
    },
  },
  {
    name: 'steward_memory_write',
    description: '把一条关于【用户本人】的事实写进管家记忆(身份 profile / 偏好 preference / 习惯 habit / 当前关注 focus / 决策倾向 policy)。何时用:用户在对话里自己陈述了稳定的事实或偏好(「我用的是 Windows」「报告都给我写成中文」「我一般周一整理上周任务」),写下来以后用于路由、默认选项、语气与主动提醒。何时别用:① 第三方的个人信息一律不记;② 一次性的任务细节属于线程上下文不是记忆;③ 密钥/口令/连接串会被确定性拒绝(sensitive_rejected);④ sourceRef 必须指向【用户自己的那条消息】,指向工具输出或助手消息会被拒(source_not_user)。同义条目自动合并(merged:true),被否决过的同义内容拒绝写回(vetoed_duplicate),总量上限 200 条(capacity_exceeded)。',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['kind', 'text', 'sourceRef'],
      properties: {
        kind: { type: 'string', enum: ['profile', 'preference', 'habit', 'focus', 'policy'], description: '记忆类别。' },
        text: { type: 'string', description: '一句话事实,≤300 字,用第三人称陈述用户(例:「用户偏好中文输出」)。' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: '可选。置信度 0..1,默认 0.6。' },
        sourceRef: {
          type: 'object', additionalProperties: false, required: ['sessionId', 'turnSeq'],
          description: '来源:该事实出自哪条线程的哪个回合的【用户消息】。会被服务端核对角色。',
          properties: {
            sessionId: { type: 'string', description: '来源线程 id。' },
            turnSeq: { type: 'integer', minimum: 0, description: '来源回合号(用户消息所在回合)。' },
          },
        },
      },
    },
  },
  {
    name: 'steward_memory_veto',
    description: '否决一条管家记忆(标为 vetoed,不再注入,且同义内容不再自动写回)。何时用:用户说「别记这个/我不是那样的」,或你发现之前记错了。何时别用:内容需要更新而不是作废时,直接用 steward_memory_write 写新版本(同义会自动合并)。返回 {ok,id,undoRef}。',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: { type: 'string', description: '记忆条目 id。' } },
    },
  },
  {
    name: 'steward_memory_search',
    description: '按关键词/类别检索管家记忆(默认只返回生效条目)。何时用:回答前想确认用户偏好、判断路由权重、或要在委托书里引用记忆条目 id 时。何时别用:这不是工作台记忆(项目知识库),项目知识要让线程去查;也不要每回合无差别全量拉——记忆块本来就已在你的上下文里。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        q: { type: 'string', description: '可选。检索词;省略则按 kind/时间返回。' },
        kind: { type: 'string', enum: ['profile', 'preference', 'habit', 'focus', 'policy'], description: '可选。只看某一类。' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: '返回条数上限,夹取到 1..50,默认 20。' },
        includeVetoed: { type: 'boolean', description: '可选。true 时连被否决的条目一起返回(默认 false)。' },
      },
    },
  },
  // v0.9-S6 (子代理, L): spawn a self-contained SUB-TURN to carry out a delegated task, with its OWN
  // isolated history + tool subset (toolTier) + iteration budget, returning only the final conclusion text.
  // PROVIDER-ENGINE ONLY: it needs the live provider/session/journal/onEvent closure, so it is special-cased
  // in runOpenAiTurn's tool loop (like todo_write/bridge) and NEVER reaches the context-free toolCall(). It
  // is also filtered OUT of the Claude-CLI MCP surface (registered only when subagentMaxPerTurn>0 via
  // buildOpenAiTools). Sub-turns do NOT get spawn_agent themselves (禁嵌套). Registered in MCP_TOOLS so the
  // schema is shared; buildOpenAiTools decides whether to offer it.
  {
    name: 'spawn_agent',
    description: 'Delegate a self-contained subtask to an isolated sub-agent. Every accepted spawn is projected into the persistent Workbench DAG. Set background:true when the parent can continue useful independent work: the call returns a runId/nodeId receipt immediately, and wait_agents collects the result later. Omit background (or set false) only when the result is required before the parent can proceed. Independent calls in the same assistant message run concurrently up to the configured stage limit. For dependent orchestration, assign stable agentKey values and use completed earlier-stage keys in dependsOn; their conclusions are injected automatically. Dependencies in the same batch are refused. toolTier: read (default) | edit | exec. Sub-agents cannot spawn further sub-agents.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'the concrete task to delegate (a self-contained instruction)' },
        role: { type: 'string', description: 'Agent role id from the role library, for example explorer, worker, reviewer, verifier' },
        agentKey: { type: 'string', description: 'optional stable identifier for this sub-agent within the parent turn (for later dependsOn references)' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'agentKey values from completed earlier stages whose conclusions should be injected into this task' },
        toolTier: { type: 'string', enum: ['read', 'edit', 'exec'], description: "tool access level for the sub-agent (default 'read')" },
        maxIters: { type: 'number', description: 'sub-loop iteration budget (default 100, clamped 1..300)' },
        model: { type: 'string', description: 'optional model id for the sub-turn (engine is openai), chosen by task difficulty (fast model for simple/bulk work, strong model for hard reasoning). Pick from the OpenAI models listed in the system prompt; a wrong/unknown id makes the sub-agent fail. Omit to use the default.' },
        resources: { type: 'array', items: { type: 'string' }, description: 'resources held for the whole subtask. Examples: desktop, browser:default, file:C:\\project\\a.js, workspace:C:\\project. Prefix with read: for shared access.' },
        background: { type: 'boolean', description: 'true = launch into the Workbench DAG and return immediately so the parent can continue in parallel; later call wait_agents. false/default = wait for this result synchronously.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'orchestrate_agents',
    description: "Run a persistent sub-agent DAG. The runtime emits workflow heartbeats during quiet windows, asks an overlong model node to wrap up, and stops only that node if it ignores the bounded grace period. Supports structured JSON Schema outputs, automatic Reviewer/Verifier quality gates, explicit vote-contract validation, deterministic voting/deduplication, cross-review, semantic loop progress keys, tool-evidence requirements, and per-node failure/dependency policies. Reliability guidance: give factual probes minSuccessfulToolCalls>=1; make unavailable schema fields nullable; use dependencyPolicy:'all_settled' only on fan-in nodes designed to consume failed inputs; set loop.progressPath to a stable structured field; every dependency of a vote node must explicitly output {verdict,confidence}. vote/dedupe nodes are deterministic aggregators and do NOT execute their task text, so keep synthesis in a preceding node. Two ways to call it: (1) author `nodes` inline for a one-off DAG, or (2) pass `workflowId` to reuse a saved/built-in template by id (available ids + when to reach for each are listed in the system prompt) plus `context` — a short description of THIS run's actual subject/task, since a template's node tasks are often generic placeholders with no subject of their own. Prefer (2) for complex, multi-step tasks that match a listed template; skip it for simple one-shot requests.",
    inputSchema: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array', minItems: 1, maxItems: 64,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'unique stable node id, letters/numbers/_/- only' },
              task: { type: 'string', description: 'self-contained task for this node' },
              role: { type: 'string', description: 'Agent role id; the role supplies model, tools, MCP, permission and iteration defaults' },
              engine: { type: 'string', enum: ['openai', 'claude'], description: "which engine runs this node: 'openai' (HTTP against a configured Provider) or 'claude' (a native Claude CLI spawn). Omit to auto-pick whichever is available." },
              dependsOn: { type: 'array', items: { type: 'string' }, description: 'node ids that must finish before this node starts' },
              toolTier: { type: 'string', enum: ['read', 'edit', 'exec'] },
              maxIters: { type: 'number' },
              model: { type: 'string', description: 'optional explicit model override for THIS node. Omit by default so the runtime can validate and use the configured sub-agent preferred endpoint/model, then fall back to the current conversation endpoint/model. Set only when the user/task requires a different model; it must match the node engine.' },
              resources: { type: 'array', items: { type: 'string' }, description: 'exclusive resources required by this node; use read: prefix for shared access' },
              isolation: { type: 'string', enum: ['none', 'worktree'], description: 'worktree runs this node in a detached Git worktree and keeps its commit for explicit user application; never auto-merges' },
              outputSchema: { type: 'object', description: 'optional JSON Schema for this node final JSON value (objects, arrays, and primitives supported); invalid JSON/schema fails the node. Fields that may be unavailable must explicitly allow null, for example type:["integer","null"].' },
              context: { type: 'string', description: 'optional node-level context injected ONLY into this node (appended after the run-wide context). Use for per-node specifics (structure summary for exploration, concrete fragment for execution, artifact list for verify); omit to inherit only the run-wide context. Capped at 4000 chars.' },
              gate: {
                type: 'object', description: 'quality gate; reviewer/verifier roles get one automatically',
                properties: {
                  mode: { type: 'string', enum: ['review', 'verify', 'vote', 'cross_review', 'dedupe', 'coverage', 'propagate'], description: 'vote/dedupe/coverage/propagate are deterministic aggregator nodes and do not execute task' },
                  threshold: { type: 'number', description: 'vote pass ratio, 0..1' },
                  minApprovals: { type: 'number' },
                  minConfidence: { type: 'number', description: 'minimum aggregate vote confidence, 0..1' },
                  abstainThreshold: { type: 'number', description: 'negative votes below this confidence become abstentions; 0..1, default 0' },
                  inputSet: { type: 'array', items: { type: 'string' }, description: 'coverage items that must appear in upstream handledItems or findings/claims evidenceRefs' },
                  propagateKey: { type: 'string', description: 'item record key used to inherit assignments among equal-key items' },
                  allowPartialCoverage: { type: 'boolean', description: 'allow coverage nodes or model gates with uncovered items to succeed with a warning' },
                  allowPartial: { type: 'boolean', description: 'allow propagate nodes with unpropagated items to succeed' },
                  requireEvidence: { type: 'boolean', description: 'R1 high-stakes gate (audit/research). When true, structuredResult.findings claims whose evidenceRefs are missing/invalid/cross-workspace are marked unverified, and if any unverified claim exists the node is rejected (gate_unverified). Default false: unverified claims are merely marked, not blocking (backwards-compatible).' },
                },
              },
              failurePolicy: { type: 'string', enum: ['block', 'continue', 'retry'], description: 'block downstream (default), continue in degraded mode, or retry automatically' },
              dependencyPolicy: { type: 'string', enum: ['all_success', 'all_settled'], description: 'all_success blocks this node on a failed dependency (default); all_settled runs after every dependency settles and injects failed status/error for tolerant fan-in aggregation' },
              degradedPolicy: { type: 'string', enum: ['accept', 'retry', 'request_review', 'fail'], description: '当节点【降级成功】(产出可用但执行异常)时的处置:accept 照用(默认)/ retry 重跑一次 / request_review 暂停待人工 / fail 判失败(交 failurePolicy 决定下游)' },
              maxRetries: { type: 'number', description: 'additional automatic attempts for retry policy, 0..5' },
              retryFallback: { type: 'string', enum: ['block', 'continue'], description: 'behavior after retries are exhausted' },
              minSuccessfulToolCalls: { type: 'number', description: '0..20; fail the node unless this attempt records at least this many successful tool calls. Use >=1 for independently checkable factual probes.' },
              condition: { type: 'object', description: 'optional branch condition: {node,path,operator,value}; operators include equals/not_equals/truthy/falsy/contains/comparisons/status_is' },
              loop: { type: 'object', description: 'bounded loop: {maxIterations,until,progressPath,noProgressLimit,onNoProgress}. progressPath selects a stable field from structured output (for example status or remainingCount), so prose/verbosity changes do not fake progress.' },
              replan: { type: 'boolean', description: 'R5: when true, a failed/rejected node generates a reviewable replanPatch proposal (status pending, never auto-applied). Default false = zero-migration.' },
            },
            required: ['id', 'task'],
          },
        },
        providerId: { type: 'string', description: 'optional explicit OpenAI-compatible provider override. Omit by default so runtime routing can validate the configured sub-agent preference and safely fall back to the current conversation route.' },
        workflowId: { type: 'string', description: 'saved/built-in workflow id to launch instead of sending nodes' },
        context: { type: 'string', description: "this run's actual subject/task, prepended to every node's task — required in practice when workflowId is used, since template node tasks are generic placeholders" },
      },
    },
  },
];
