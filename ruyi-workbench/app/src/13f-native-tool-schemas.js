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
