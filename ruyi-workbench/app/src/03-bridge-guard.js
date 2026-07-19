// ===================================================================================================
// v1.2-B (本切片灵魂): 机制性防漏 —— 把「新增桥接写族工具时逐个补 BRIDGED_WRITE_PATH_ARGS」从人肉纪律
// 升级成【离线回归可断言】的机制。前科:ACC v1.6 四个 Office 写族上线时漏进快照表,用户真机撞出「PPT/Excel
// 不能撤销」。此后每补一个是被动的;auditBridgedWriteCoverage 让「漏表」在 e2e 里直接变红。
//
// 判定:一个 bridged 工具的【裸名】命中「写语义命名模式」(见下)却不在 BRIDGED_WRITE_PATH_ARGS 里 → 判为
//   uncovered(疑似漏进快照表)。命名模式覆盖大厂/社区 MCP 的常见写族命名法:
//     ^(write_|save_|export_|create_)  —— 产出/覆盖文件
//     ^(delete_|remove_)               —— 删除文件
//     ^(move_|copy_|rename_)           —— 移动/复制/改名
//   名字命中但【逻辑上不动文件系统】的工具(如 create_session / create_task)由显式豁免表放行 —— 每条都要
//   写清为什么豁免,豁免是「我看过、确认它不写用户文件」的证据,不是「懒得补表」的地毯。
// ⚠️ 局限(诚实):这是【命名启发式】,只能抓「名字看着像写族却漏表」的。像 excel_beautify / chart_image /
//   window_screenshot 这类【真写文件但名字不含写族前缀】的,命名模式抓不到 —— 它们靠 B1 人工盘点入表(已入),
//   审计函数对它们无能为力(不在 uncovered 里也不在豁免表里,因为名字压根不匹配)。所以本函数是「防回潮网」,
//   不是「盘点器」:它保证【叫 write_*/save_*/… 的新工具】不会静默漏表,人工盘点保证【命名不规范的写族】入表。
const BRIDGED_WRITE_NAME_PATTERN = /^(write_|save_|export_|create_|delete_|remove_|move_|copy_|rename_)/;
// 写语义命名模式命中、但【逻辑上不动用户文件系统】故不需要进快照表的桥接工具裸名。每条注释=豁免理由。
// 这张表是审计的「白名单例外」:auditBridgedWriteCoverage 命中命名模式但在此表里的,不算 uncovered。
// 维护纪律:往这里加名字前必须确认该工具【真的不写用户磁盘文件】(读源码,别信名字);写清一句话理由。
const BRIDGED_WRITE_AUDIT_EXEMPT = new Set([
  // —— ACC v1.6(93 工具)现状:命中命名模式但不动用户文件系统的,逐条豁免 ——
  // move_window:命中 ^move_ 但它是【把窗口挪到屏幕新位置】(window.py: move_window(x,y,title,handle)),
  //   零文件 I/O。命名启发式的典型误报 —— 审计报了、人核实了、显式豁免。这正是豁免表存在的意义(不是地毯,
  //   是「我读过源码确认不写文件」的证据)。ACC 里目前唯一的这类误报。
  'move_window',
  // 下面几条是「防未来」的通用逻辑性名字豁免,以及对社区 drop-in MCP 常见命名法的预置豁免,避免把
  // create_session / create_window 之类误判成漏表(它们即便某天出现在某个 MCP 里,也不动用户文件)。
  'create_session',   // 逻辑会话对象(内存/DB),不落用户文件
  'create_task',      // 任务对象,不动文件系统
  'create_context',   // 浏览器/自动化上下文,不落盘
  'create_window',    // 开窗口(UI),不写文件
  'create_directory', // 建目录 —— 目录不是字节级可快照对象(checkpoint 存文件内容),回滚语义=删空目录,
                      //   价值低且易误删用户既有目录;明确不纳入快照(与内建 file_* 不含 mkdir 一致)。
  'save_session',     // 保存会话到 MCP 内部存储(非用户工作区文件),护栏外不快照。
  'export_macro',     // 若某 MCP 提供:宏导出到其内部数据目录(如 ACC record_stop 写 <data>/macros),
                      //   落在工作区护栏外 → journalBridgedWrite 本就跳过;此处豁免让审计不误报。
]);
// 纯函数:给一批桥接工具【裸名】,返回 { uncovered:[...] } —— 名字像写族(命中命名模式)、非豁免、却不在
// 快照表(BRIDGED_WRITE_PATH_ARGS)里的工具名列表(去重、稳定排序)。uncovered 非空 = 有写族工具漏进快照表,
// 用户将撞「该工具产出/删除的文件不能撤销」—— e2e 断言 uncovered 为空即机制性杜绝 v1.6 事故重演。
// 输入既接受裸名(delete_file)也接受带前缀的桥接名(acc__delete_file),内部统一去前缀。无 I/O、可离线直测。
function auditBridgedWriteCoverage(toolNames) {
  const uncovered = new Set();
  for (const name of (Array.isArray(toolNames) ? toolNames : [])) {
    const bare = unprefixedBridgedName(name);
    if (!bare) continue;
    if (!BRIDGED_WRITE_NAME_PATTERN.test(bare)) continue;               // 名字不像写族 → 审计不管
    if (BRIDGED_WRITE_AUDIT_EXEMPT.has(bare)) continue;                 // 显式豁免(逻辑性名字/护栏外)
    if (Object.prototype.hasOwnProperty.call(BRIDGED_WRITE_PATH_ARGS, bare)) continue; // 已在快照表 → 覆盖到了
    uncovered.add(bare);                                                // 像写族、没豁免、没进表 → 疑似漏
  }
  return { uncovered: [...uncovered].sort() };
}
// v1.5-W1.5 (T3): 在 bridged 写族工具「分发执行之前」存一份 before 快照进 journal —— 让「本轮变更」卡里
// 该文件可撤销、journalRollback 能恢复。全部失败静默吞掉(快照失败绝不阻断工具执行,与内建文件工具的
// journalRecord 同一安全网纪律)。走既有 journal 条目格式 → 与内建工具「本轮变更」卡/rollback API 零前端改动。
//   op 判定:目标已存在 → modify(存 before 内容);不存在 → create(回滚=删除)。
//   delete 语义:存 before(op:delete,回滚=写回);目标不存在 → 不快照(没什么可回退)。
//   安全:用与文件工具同一路径护栏(guardWorkspacePath)判定;越界 → 不快照(工具照常执行,ACC 有自己
//   的 protected_path 护栏兜底)。
async function journalBridgedWrite(bridgedName, args, session, config, ctx) {
  try {
    const targets = collectBridgedWriteTargets(bridgedName, args);
    if (!targets.length) return; // 非写族 / 无路径 / 非绝对路径 → 不快照
    const jctx = await journalSessionCtx(ctx);
    if (!jctx.sessionId || !Number.isFinite(jctx.turnSeq)) return; // 无会话上下文 → 无处锚定
    // v1.2-B 多目标:逐个目标独立护栏 + 快照。任一失败(越界/读不到/journalRecord 抛)静默跳过【该目标】,
    //   不阻断工具、不阻断其它目标。move_file 的两条(source delete + destination write)按此表顺序落 journal;
    //   journalRollback 整回合逆序展开(后写的 dest 先撤 → 删掉新文件;再撤 src → 把源写回原处),净效果=移动前状态。
    for (const target of targets) {
      try {
        // 路径护栏:必须落在允许的工作区内;越界不快照(工具照常执行,ACC 有自己的 protected_path 兜底)。
        const guard = await guardWorkspacePath(target.path, session, config);
        if (!guard.ok) continue;
        const p = guard.absPath;
        // 读 before:存在→取字节;不存在→null。读失败(权限/目录)按「无 before」处理,不阻断。
        let before = null, exists = false;
        try { before = await fsp.readFile(p); exists = true; } catch { before = null; exists = false; }
        if (target.mode === 'delete') {
          if (!exists) continue; // 删/移一个不存在(或读不到)的源 → 没什么可回退
          await journalRecord(jctx.sessionId, jctx.turnSeq, bridgedName, p, 'delete', before);
        } else {
          // write:存在→modify(存 before);不存在→create(无 before,回滚=删除)。
          await journalRecord(jctx.sessionId, jctx.turnSeq, bridgedName, p, exists ? 'modify' : 'create', exists ? before : null);
        }
      } catch {
        // 单目标安全网:该目标本回合不可撤销,但工具与其它目标照常。
      }
    }
  } catch {
    // 安全网:快照失败绝不阻断工具执行。吞掉即可(该文件本轮不可撤销,但工具照常运行)。
  }
}

// v1.2 提示词三层防御·工具层缝隙收口:script_run 已有 Office 软闸,但模型仍可绕道 ACC 的
// run_command/execute_command 用 `python -c "...openpyxl...xxx.xlsx..."` 内联手写 Office(实测续聊惯性
// 场景确实这么干过)。同一启发式在 bridged 分发点(callTool 之前)再设一道同款软闸;force:true 泄压。
// 纯函数,导出供 e2e 单测;返回拒绝对象或 null(放行)。
const BRIDGED_SCRIPT_TOOLS = new Set(['run_command', 'execute_command', 'shell', 'powershell']);
// v1.4.1 (audit #6/#7):Office 手写检测的库/写法特征。旧版只认 pip 库 import,漏了【离线运行时里也捆绑的】
// win32com/comtypes COM 自动化(Dispatch/CreateObject Excel|Word|PowerPoint + .SaveAs)、importlib 动态导入
// 绕过、matplotlib savefig —— 模型可借此绕过软闸手写不可撤销 Office。此处集中强化,两道软闸共用。
const OFFICE_WRITER_LIB_RE = /(openpyxl|xlsxwriter|python-docx|from\s+docx|import\s+docx|python-pptx|from\s+pptx|import\s+pptx|reportlab|win32com|comtypes|Dispatch\s*\(\s*['"](?:Excel|Word|PowerPoint)|CreateObject\s*\(\s*['"](?:Excel|Word|PowerPoint)|GetActiveObject\s*\(\s*['"](?:Excel|Word|PowerPoint)|\.SaveAs\b|importlib\.import_module\s*\(\s*['"](?:openpyxl|docx|pptx|xlsxwriter|reportlab)|\.savefig\s*\(|matplotlib)/i;
function bridgedOfficeScriptGate(bridgedName, args) {
  const bare = unprefixedBridgedName(bridgedName);
  if (!BRIDGED_SCRIPT_TOOLS.has(bare)) return null;
  if (args && args.force === true) return null;
  const cmd = String((args && (args.command || args.cmd || args.code)) || '');
  const officeLib = OFFICE_WRITER_LIB_RE.test(cmd);
  const officeFile = /\.(xlsx|xlsm|docx|pptx|pdf)\b/i.test(cmd);
  if (officeLib && officeFile) {
    return {
      ok: false,
      error: '检测到终端命令在手写 Office 文件。请改用现成工具:Excel = write_excel → excel_beautify →(需图表)excel_chart;PPT = write_pptx;Word = write_document;PDF = write_pdf——统一模板、可一键撤销。若现成工具确实覆盖不了(特殊格式需求),重新调用并加参数 force:true,同时向用户说明该产出不可自动撤销。',
      hint: 'Office 产出规程(工具层强制,v1.2)',
    };
  }
  return null;
}

function normalizeCwd(cwd, fallback) {
  const base = cwd || fallback || os.homedir();
  return path.resolve(base);
}

// v0.8-S0 cwd guardrail: a resolved working dir sitting AT the user's home or its Desktop/Documents/
// Downloads root is the highest-risk "tidy this folder" target (it acts on everything the user owns).
// Returns { path, reason } to attach to the turn's meta event, or null when the dir is task-specific.
function cwdWarning(resolvedDir) {
  if (!resolvedDir) return null;
  const norm = p => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const home = os.homedir();
  const roots = new Set([home, path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads')].map(norm));
  if (roots.has(norm(resolvedDir))) {
    return { path: resolvedDir, reason: 'working-dir-is-user-root' };
  }
  return null;
}

// ===================================================================================================
// v0.9-S3 (C3) — folder-drag → workspace by FINGERPRINT.
// The browser sandbox never exposes a dropped folder's absolute path (webkitGetAsEntry gives name +
// first-level child names only). So we locate the real directory by fingerprint: given {name, children}
// (children = the folder's first-level entry names, ≤50), search a bounded set of CANDIDATE roots for a
// directory whose basename matches `name` (case-insensitive) AND whose own first-level entry names overlap
// the supplied children by ≥ MATCH_THRESHOLD (Jaccard: |intersect| / |union|). Returns matches sorted by
// score DESC, ≤5. Purely READ-ONLY (readdir); never mutates anything.
//
// Candidate roots (one directory level scanned under each):
//   • each existing drive root (A:\ .. Z:\)     — one level of dirs only
//   • home dir and its first level              — home itself + one level
//   • the current defaultWorkspace's parent      — one level (sibling projects)
//   • config.recentWorkspaces                    — the exact dirs (their basenames can match directly)
//
// PERFORMANCE GUARDRAILS: every readdir is try/catch (a permission-denied root is skipped, never fatal);
// candidate directory total is capped at CANDIDATE_CAP (truncated:true when exceeded); a wall-clock budget
// (RESOLVE_BUDGET_MS) stops the scan early (truncated:true). A huge child list is clamped to CHILDREN_CAP.
// ===================================================================================================
const WORKSPACE_MATCH_THRESHOLD = 0.8;   // Jaccard overlap of child-name sets required to count as a hit
const WORKSPACE_CANDIDATE_CAP = 2000;    // hard cap on candidate directories scanned
const WORKSPACE_RESOLVE_BUDGET_MS = 3000; // overall wall-clock budget for the scan (now covers candidate BUILD too)
const WORKSPACE_CHILDREN_CAP = 50;       // clamp on the incoming child-name list
// PF3: a single dead/offline mapped network drive used to block the WHOLE process, because the resolver
// enumerated drives with fs.readdirSync/existsSync. Every directory listing now goes through fsp.readdir
// (async, yields the event loop) wrapped in a HARD per-directory timeout so one slow root can never stall
// the scan (or the chat stream sharing the loop). On timeout/error the root is simply skipped.
// PF3 fix: 600ms was too tight — a slow-but-ALIVE network drive (700-900ms to list) was routinely misjudged as
// dead and its real workspaces dropped. Widened to 1000ms; the overall RESOLVE_BUDGET_MS still bounds the worst
// case so a genuinely dead drive can never block indefinitely.
const WORKSPACE_DIR_TIMEOUT_MS = 1000;   // hard per-directory readdir/stat timeout (dead network drive can't block)
// PF3 fix: distinguish a TIMEOUT from a real empty/absent/denied directory. The old readdirTimed collapsed both
// to null, so a slow-but-alive dir looked identical to a non-existent one — a real workspace on a laggy drive
// scored 0 (empty child set) and was silently dropped, with no way to flag the result as incomplete. These
// sentinels let callers tell "slow, unknown" (mark truncated / fall back to a bounded stat) apart from "known
// empty/absent" (skip). A readdir that resolves AFTER we've timed out is simply discarded. Never throws.
const READDIR_TIMEOUT = Symbol('readdir-timeout');
const STAT_TIMEOUT = Symbol('stat-timeout');
function readdirTimed(dir, opts, timeoutMs) {
  return Promise.race([
    fsp.readdir(dir, opts).catch(() => null),                                      // null = error (ENOENT / denied / not a dir)
    new Promise(resolve => setTimeout(() => resolve(READDIR_TIMEOUT), timeoutMs)), // sentinel = timed out (alive but slow)
  ]);
}
// PF3 fix: bounded existence probe for an EXPLICITLY-KNOWN candidate path (a recentWorkspace). Confirms the dir
// is still there WITHOUT listing it, so a known workspace on a slow drive isn't dropped just because its own
// readdir timed out. Resolves to a Stats, null (error/absent), or STAT_TIMEOUT. Never throws.
function statTimed(p, timeoutMs) {
  return Promise.race([
    fsp.stat(p).catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(STAT_TIMEOUT), timeoutMs)),
  ]);
}
// Jaccard similarity of two name Sets: |A ∩ B| / |A ∪ B|. Empty-vs-empty → 1 (both truly empty folders
// fingerprint-match); one-empty → 0.
function nameSetJaccard(a, b) {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
// List first-level SUBDIRECTORIES of `root` (absolute paths). Bounded; never throws. Returns { dirs, timedOut }:
// timedOut:true means the listing was ABANDONED at the per-dir timeout (alive but slow) so the caller can mark
// the overall result truncated (a partial candidate set must not be mistaken for the authoritative one). An
// error/absent root yields { dirs:[], timedOut:false } — nothing to discover, and it's not "slow".
async function listChildDirs(root) {
  // PF3: async + hard timeout. A non-existent drive letter rejects fast (ENOENT → null → []); a live-but-slow
  // network root times out instead of blocking the event loop. Replaces the old existsSync gate: attempting the
  // timed readdir directly both tests existence AND lists in one non-blocking call.
  const ents = await readdirTimed(root, { withFileTypes: true }, WORKSPACE_DIR_TIMEOUT_MS);
  if (ents === READDIR_TIMEOUT) return { dirs: [], timedOut: true };
  if (!ents) return { dirs: [], timedOut: false };
  const out = [];
  for (const e of ents) {
    // isDirectory() can throw on a broken symlink entry on some FS — guard it.
    let isDir = false;
    try { isDir = e.isDirectory(); } catch { isDir = false; }
    if (isDir) out.push(path.join(root, e.name));
    if (out.length >= 4096) break; // sanity guard for a pathological root
  }
  return { dirs: out, timedOut: false };
}

// Core resolver (pure-ish: reads the FS, takes config for candidate roots). Exposed for e2e unit testing.
// Returns { ok:true, matches:[{path, score}], truncated }.
async function resolveWorkspace({ name, children }, config) {
  const wantName = String(name || '').trim().toLowerCase();
  if (!wantName) return { ok: false, error: 'name is required', matches: [] };
  const wantChildren = new Set(
    (Array.isArray(children) ? children : [])
      .slice(0, WORKSPACE_CHILDREN_CAP)
      .filter(c => typeof c === 'string' && c)
      .map(c => c.toLowerCase())
  );

  const started = Date.now();
  let truncated = false;

  // ── build the candidate-directory list ──────────────────────────────────────────────────────────
  const candidates = [];        // absolute dir paths to test
  const candSeen = new Set();    // de-dupe by lowercased path
  const pushCand = p => {
    if (candidates.length >= WORKSPACE_CANDIDATE_CAP) { truncated = true; return; }
    const key = String(p).toLowerCase();
    if (candSeen.has(key)) return;
    candSeen.add(key);
    candidates.push(p);
  };

  // PF3: the wall-clock budget now guards candidate BUILD (drive/home/parent enumeration), not just scoring,
  // so a slow root can't blow past it. Every listChildDirs() is async + per-directory timed (see WORKSPACE_DIR_TIMEOUT_MS).
  const overBudget = () => Date.now() - started > WORKSPACE_RESOLVE_BUDGET_MS;
  // (a) each existing drive root, one directory level. Enumerate A:..Z: that exist.
  // PF3 fix: a timed-out root enumeration marks the result truncated (its children weren't discovered — the
  // candidate set is incomplete, not authoritative).
  const addChildren = r => { if (r.timedOut) truncated = true; for (const d of r.dirs) pushCand(d); };
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      if (overBudget()) { truncated = true; break; }
      const root = String.fromCharCode(c) + ':\\';
      // No existsSync pre-check: the timed readdir returns [] for a non-existent OR unreachable drive without blocking.
      addChildren(await listChildDirs(root));
      if (candidates.length >= WORKSPACE_CANDIDATE_CAP) { truncated = true; break; }
    }
  } else {
    // non-Windows: use filesystem root's one level as the drive-equivalent (keeps the code path exercisable).
    addChildren(await listChildDirs('/'));
  }
  // (b) home dir and its first level.
  const home = os.homedir();
  pushCand(home);
  if (!overBudget()) addChildren(await listChildDirs(home));
  // (c) the current defaultWorkspace's parent, one level (sibling projects).
  const dw = (config && typeof config.defaultWorkspace === 'string' && config.defaultWorkspace) ? config.defaultWorkspace : home;
  const dwParent = path.dirname(path.resolve(dw));
  if (!overBudget()) addChildren(await listChildDirs(dwParent));
  // (d) recentWorkspaces — the exact dirs (their basenames can match directly). PF3 fix: track these as KNOWN
  // paths so a timeout on their own listing falls back to a bounded stat instead of dropping a real workspace.
  const knownPaths = new Set(); // lowercased resolved paths the user has explicitly used
  for (const w of (config && Array.isArray(config.recentWorkspaces) ? config.recentWorkspaces : [])) {
    if (typeof w === 'string' && w) { const rp = path.resolve(w); pushCand(rp); knownPaths.add(rp.toLowerCase()); }
  }

  // ── score candidates whose basename matches the wanted name ─────────────────────────────────────
  const matches = [];
  for (const dir of candidates) {
    if (Date.now() - started > WORKSPACE_RESOLVE_BUDGET_MS) { truncated = true; break; }
    if (path.basename(dir).toLowerCase() !== wantName) continue;
    const names = await readdirTimed(dir, undefined, WORKSPACE_DIR_TIMEOUT_MS);
    if (names === READDIR_TIMEOUT) {
      // PF3 fix: this candidate's fingerprint is unknowable (slow drive) → the result is INCOMPLETE, flag it.
      truncated = true;
      // Preserve the old "unreadable dir → empty fingerprint" scoring so an empty dropped folder still name-matches.
      const emptyScore = nameSetJaccard(wantChildren, new Set()); // 1 iff wantChildren is also empty, else 0
      if (emptyScore >= WORKSPACE_MATCH_THRESHOLD) {
        matches.push({ path: path.resolve(dir), score: Math.round(emptyScore * 1000) / 1000 });
      } else if (knownPaths.has(String(dir).toLowerCase())) {
        // A KNOWN path (recentWorkspaces) with a non-empty fingerprint we couldn't read must NOT be dropped just
        // because its listing timed out. Confirm it still exists via a bounded stat and select it on the name
        // match alone (a workspace the user has actually used, basename == wanted name, is a real hit). Score at
        // the threshold so it surfaces yet never outranks a genuine fingerprint match (which scores on real overlap).
        const st = await statTimed(dir, WORKSPACE_DIR_TIMEOUT_MS);
        let isDir = false; try { isDir = !!(st && st !== STAT_TIMEOUT && st.isDirectory && st.isDirectory()); } catch { isDir = false; }
        if (isDir) matches.push({ path: path.resolve(dir), score: WORKSPACE_MATCH_THRESHOLD });
      }
      continue;
    }
    const have = names ? new Set(names.slice(0, 500).map(n => String(n).toLowerCase())) : new Set(); // null (error) → empty, as before
    const score = nameSetJaccard(wantChildren, have);
    if (score >= WORKSPACE_MATCH_THRESHOLD) matches.push({ path: path.resolve(dir), score: Math.round(score * 1000) / 1000 });
  }
  // De-dupe by resolved path (a dir can appear via two roots), keep the higher score; sort DESC; ≤5.
  const bestByPath = new Map();
  for (const m of matches) {
    const k = m.path.toLowerCase();
    if (!bestByPath.has(k) || bestByPath.get(k).score < m.score) bestByPath.set(k, m);
  }
  const sorted = [...bestByPath.values()].sort((a, b) => b.score - a.score).slice(0, 5);
  return { ok: true, matches: sorted, truncated };
}

// ===================================================================================================
// v0.9-S4 (C4) — local file PREVIEW: path safety + content read.
// The /api/file/preview endpoint returns file CONTENT (text / image dataURI / html source) to the UI's
// 「产物」gallery + file tree. That is dangerous by nature (a mis-scoped read is an arbitrary-file-read
// primitive), so it sits behind TWO gates: (1) the UI-token gate (needsToken whitelist), and (2) this
// allowed-root containment check — the second, defence-in-depth闸. The requested `path` must be absolute
// and, once resolved (symlink-agnostic lexical resolve is fine here — we compare canonicalized prefixes),
// must sit UNDER one of the roots the workbench legitimately touches for this session:
//   • the session's cwd (its working folder);
//   • config.defaultWorkspace;
//   • each of config.recentWorkspaces;
//   • dataRoot (where the app writes generated artifacts / checkpoints / uploads).
// Anything outside every root → 403. This is what stops a token-holding page (or a mistaken client) from
// reading C:\Windows\win.ini or a user file outside any workspace.
// ===================================================================================================
function fileAllowedRoots(session, config) {
  const roots = [];
  const push = p => {
    if (typeof p !== 'string' || !p.trim()) return;
    try { roots.push(path.resolve(p.trim())); } catch { /* skip unresolvable */ }
  };
  if (session && typeof session.cwd === 'string') push(session.cwd);
  if (config && typeof config.defaultWorkspace === 'string') push(config.defaultWorkspace);
  for (const w of (config && Array.isArray(config.recentWorkspaces) ? config.recentWorkspaces : [])) push(w);
  push(dataRoot()); // generated artifacts, uploads, checkpoints all live here
  // De-dupe (case-insensitive on Windows).
  const seen = new Set();
  return roots.filter(r => { const k = r.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
// True iff `target` (already path.resolve'd) is inside `root` (or IS `root`). Compares path segments to
// avoid the classic prefix-substring bug (C:\ws-evil starting with C:\ws). Case-insensitive on win32.
function pathWithinRoot(target, root) {
  const rel = path.relative(root, target);
  // relative('' when equal); starts with '..' or is absolute → escapes the root.
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return false;
  return true;
}
function pathWithinAnyRoot(target, roots) {
  return roots.some(r => pathWithinRoot(target, r));
}
// 审计 P1: dataRoot 是文件工具的允许根之一(fileAllowedRoots),本意只为读写【应用产物】(uploads/checkpoints
// 内容/generated 产物)。但它同时罩住了应用自身的【控制面文件】:config.json(明文 provider 密钥)、sessions/
// (完整对话记录,含 file_read 读回的文件内容与讨论到的密钥)、memory/(跨会话记忆)、usage/(计费台账)、logs/
// (审计,含路径/命令)、agent-runs/(工作流状态)、generated/(内含带 WCW_TOKEN 的会话 MCP 配置)。提示注入的
// 模型只需 file_read 这些文件再经 web_fetch 外传,即绕过 HTTP 层的 maskProviders 脱敏(GET /api/status 从不回明文
// 密钥,文件工具层却能读原始字节)。这里对【解析后的真实路径】做二次拒绝:命中这些敏感子树的文件工具访问一律
// 拒绝(读写都拒),不影响读 uploads/ 产物或 checkpoints/ 内容。用 realpath 比对,故工作区内指向敏感文件的符号链接也拒。
// 对抗轮扩展(3 处补漏): ①加入 runtime.json —— 它在 dataRoot 顶层明文存 WCW_TOKEN(RUNTIME.token),原表漏掉 →
// file_read 拿 token → 打 /api/file/preview 读 config.json 的链成立;②遍历类工具(file_list/file_search/glob)会
// 【递归进】dataRoot 子树返回文件内容,原来只校验 root 参数不校验被遍历文件 → 敏感文件内容仍外泄(见 walkFiles 内跳过);
// ③realpath 对称性: dataRoot 祖先若为 junction/符号链接/8.3 短名,realpath(target) 与【未解析】的 paths.* 永不相等,
// 门被绕过 → 同时对【词法 dataRoot】与【realpath 后 dataRoot】两种根前缀比对,调用方传词法或 realpath 路径都能命中。
// _dataRootReal 由 ensureDataRootReal 缓存(dataRoot 必存在,ensureDirs);同步 isSensitiveDataPath 供遍历热路径逐项调用。
let _dataRootReal = null;
async function ensureDataRootReal() {
  if (!_dataRootReal) { const r = dataRoot(); _dataRootReal = await fsp.realpath(r).catch(() => r); }
  return _dataRootReal;
}
function isSensitiveDataPath(p) {
  if (!p) return false;
  const root = dataRoot();
  // 敏感子路径(相对 dataRoot):明文密钥 config.json、token runtime.json、会话/记忆/计费/审计/工作流状态/带 token 的
  // 生成配置。不含 uploads/checkpoints/webcache/skills/playbooks/agent-worktrees —— 那些是用户产物/内容,合法可读。
  const names = ['config.json', 'runtime.json', 'sessions', 'memory', 'usage', 'logs', 'generated', 'agent-runs'];
  const bases = (_dataRootReal && _dataRootReal !== root) ? [root, _dataRootReal] : [root];
  for (const b of bases) for (const n of names) if (pathWithinRoot(p, path.join(b, n))) return true;
  return false;
}
// v1.0.2-S3: shared allowed-root guard for the file endpoints (/api/file/preview borrows the inline version;
// /api/file/reveal uses this). Resolves BOTH the target and every root via fs.realpath (symlink-agnostic) —
// a symlink inside an allowed root but pointing outside must NOT pass. Returns {ok, code?, error?, absPath?}:
//   code 'bad-path'    → not absolute (400-class);
//   code 'not-allowed' → resolves outside every allowed root (403-class);
//   ok:true            → absPath is the realpath'd, in-workspace target (存在性由调用方另判)。
// Mirrors the containment logic already proven in the /api/file/preview handler; centralized so reveal can't
// drift from preview's护栏。Never throws.
async function guardWorkspacePath(rawPath, session, config) {
  if (!rawPath || !path.isAbsolute(rawPath)) return { ok: false, code: 'bad-path', error: '路径必须是绝对路径' };
  const target = path.resolve(rawPath);
  const roots = fileAllowedRoots(session, config);
  const real = await fsp.realpath(target).catch(() => target);
  // 审计 P1(对抗轮补漏): reveal(在资源管理器打开/定位)与 http_download 落盘目标都经此护栏 —— 敏感控制面文件既
  // 不许暴露也不许被下载覆写(否则可覆写 config.json/runtime.json 致配置损毁/token 替换)。与文件工具同源拒绝。
  await ensureDataRootReal();
  if (isSensitiveDataPath(target) || isSensitiveDataPath(real)) return { ok: false, code: 'not-allowed', error: '该路径属于应用内部数据,已禁止访问' };
  const realRoots = await Promise.all(roots.map(r => fsp.realpath(r).catch(() => r)));
  if (!pathWithinAnyRoot(real, realRoots)) return { ok: false, code: 'not-allowed', error: '路径不在允许的工作区内' };
  return { ok: true, absPath: real };
}
// v1.4.6-S3: is the active OpenAI-compatible provider pointed at a LOCAL endpoint (loopback / private LAN)?
// Used to relax the out-of-workspace READ guard: a local model (Ollama / LM Studio on 127.0.0.1) cannot
// exfiltrate file contents to a third party, so reading outside the workspace is comparatively low-risk. A
// remote/cloud provider (or the Claude cloud engine, or no configured provider) → treated as NON-local, so
// out-of-workspace reads are denied. Pure lexical host check on the configured baseUrl (no DNS lookup).
function providerIsLocal(config) {
  try {
    const p = activeOpenAiProvider(config);
    if (!p || !p.baseUrl) return false;
    const host = new URL(p.baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.endsWith('.localhost')) return true;
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    return false;
  } catch { return false; }
}
// v1.4.6-S3: workspace boundary for the NATIVE file tools (file_read/write/edit/delete/move/copy/list/
// search/glob). Data-exfil defense: without this a REMOTE provider's model can drive file_read on ANY local
// path (C:\Users\...\.ssh, etc.) and stream the bytes out. Policy (config.allowOutsideWorkspace, default
// false, is the single explicit escape hatch for legitimate cross-workspace work):
//   • within an allowed root (session.cwd ∪ defaultWorkspace ∪ recentWorkspaces ∪ dataRoot) → allow.
//   • out of bounds + WRITE  → DENY always (destructive / exfil-staging), audit-logged.
//   • out of bounds + READ   → allow only for a LOCAL provider (providerIsLocal); a remote/cloud model → DENY.
//   • allowOutsideWorkspace === true → bypass (still audit-logged so an operator can see the crossings).
// 第31波B(autonomy-shell-sandbox L1): 工具层 autoexec 路径黑名单 —— 从授权书层(consumeGrant)下沉到
// guardFileToolPath,让 bypass/plan/default 全模式都受 autoexec 保护,不再依赖"是否有授权书"。
// 与 GRANT_EDIT_AUTOEXEC_DENY(:6139) 同源但独立维护:授权书层保留引用(纵深,向后兼容),此处为工具层统一 sink。
// 精确匹配 .git/hooks/ 等自动执行入口(不误伤 .gitignore/.gitattributes 等工作区根级文件)。
const AUTOEXEC_DENYLIST = [
  // git hooks（.git/hooks/ 内的任何文件，.githooks/，.husky/）；.git/config 可通过 core.hooksPath 把 hook 重定向到任意目录。
  /(^|[\\/])\.git[\\/]hooks[\\/]/i, /(^|[\\/])\.git[\\/]config(?:\.worktree)?$/i, /(^|[\\/])\.githooks[\\/]/i, /(^|[\\/])\.husky[\\/]/i,
  // IDE 任务
  /(^|[\\/])\.vscode[\\/]tasks\.json$/i, /(^|[\\/])\.vscode[\\/]launch\.json$/i,
  // CI/CD 配置（非高频开发编辑）
  /(^|[\\/])\.github[\\/]workflows[\\/]/i, /(^|[\\/])\.gitlab-ci\.yml$/i, /(^|[\\/])Jenkinsfile$/i,
];
// 对路径做 Windows 语义归一:组件去尾点/尾空格 + 小写(Windows 不区分大小写,junction/短名由 realpath 化解)。
function normalizeAutoexecPath(absPath) {
  return absPath.split(/[\\/]/).map(s => s.replace(/[. ]+$/, '')).join('/').toLowerCase();
}
// ctx may be null (the one-shot MCP child passes none): then config is read from disk and session is absent,
// so dataRoot still bounds it. Returns { ok:true, absPath } or { ok:false, code:'not-allowed', error }.
async function guardFileToolPath(rawPath, ctx, opts) {
  const write = !!(opts && opts.write);
  const tool = (opts && opts.tool) || 'file';
  const abs = path.resolve(String(rawPath || ''));
  let config = ctx && ctx.config ? ctx.config : null;
  if (!config) { try { config = await readConfig(); } catch { config = {}; } }
  const session = ctx && ctx.session ? ctx.session : null;
  const real = await fsp.realpath(abs).catch(() => abs);
  // 审计 P1: 敏感控制面文件二次拒绝(见 isSensitiveDataPath)。放在 allowOutsideWorkspace 逃生舱【之前】——即便用户
  // 开了越界豁免,应用自身的 config/runtime/sessions/memory 等也绝不可经文件工具读写(密钥/会话/token 外传面)。
  // 词法 abs 与 realpath 后 real 都查,双保险(junction/短名部署下两者不同)。
  await ensureDataRootReal();
  if (isSensitiveDataPath(abs) || isSensitiveDataPath(real)) {
    logEvent({ kind: 'workspace_boundary', tool, op: write ? 'write' : 'read', decision: 'deny-sensitive', pathLen: abs.length });
    return { ok: false, code: 'not-allowed', error: '该路径属于应用内部数据(配置/会话/记忆/日志等),已禁止文件工具访问' };
  }
  // 第31波B(L1): autoexec 检查下沉到 guardFileToolPath —— 全模式覆盖(含 bypass/plan/default),不再依赖授权书层。
  // 仅 write 时检查(读 .git/hooks 不会触发自动执行);对 abs 与 real 双路径归一后匹配 denylist,命中即拒。
  if (write) {
    const normAbs = normalizeAutoexecPath(abs);
    const normReal = normalizeAutoexecPath(real);
    if (AUTOEXEC_DENYLIST.some(re => re.test(normAbs) || re.test(normReal))) {
      logEvent({ kind: 'workspace_boundary', tool, op: 'write', decision: 'deny-autoexec', pathLen: abs.length });
      return { ok: false, code: 'autoexec-denied', error: '该路径属于自动执行文件(如 git hooks/CI 配置),已禁止通过文件工具写入;如确需编辑,请直接在终端操作' };
    }
  }
  if (config && config.allowOutsideWorkspace === true) {
    const roots0 = fileAllowedRoots(session, config);
    const realRoots0 = await Promise.all(roots0.map(r => fsp.realpath(r).catch(() => r)));
    if (!pathWithinAnyRoot(real, realRoots0)) logEvent({ kind: 'workspace_boundary', tool, op: write ? 'write' : 'read', decision: 'allow-config', pathLen: abs.length });
    return { ok: true, absPath: real };
  }
  const roots = fileAllowedRoots(session, config);
  const realRoots = await Promise.all(roots.map(r => fsp.realpath(r).catch(() => r)));
  if (pathWithinAnyRoot(real, realRoots)) return { ok: true, absPath: real };
  if (write) {
    logEvent({ kind: 'workspace_boundary', tool, op: 'write', decision: 'deny', pathLen: abs.length });
    return { ok: false, code: 'not-allowed', error: '路径不在允许的工作区内(越界写已拒绝);如确需跨工作区,请在设置中开启 allowOutsideWorkspace' };
  }
  if (providerIsLocal(config)) {
    logEvent({ kind: 'workspace_boundary', tool, op: 'read', decision: 'allow-local', pathLen: abs.length });
    return { ok: true, absPath: real };
  }
  logEvent({ kind: 'workspace_boundary', tool, op: 'read', decision: 'deny-remote', pathLen: abs.length });
  return { ok: false, code: 'not-allowed', error: '路径不在允许的工作区内(越界读在非本地模型下已拒绝);如确需跨工作区,请在设置中开启 allowOutsideWorkspace' };
}
// v1.0.2-S3: build the explorer.exe argv for /api/file/reveal WITHOUT touching a shell (路径含用户可控字符,
// shell 拼接 = 命令注入)。绝不走 cmd.exe:调用方用 cp.spawn('explorer.exe', args, {detached,stdio:'ignore'}).unref()。
//   mode='select' → ['/select,' + absPath]  (注意 /select, 与路径是同一个参数, 逗号后直接拼路径, 资源管理器定位)
//   mode='open'   → [absPath]               (explorer 按默认关联程序打开该文件)
// 把关加固(收官复核):mode='open' 对可执行/脚本类扩展名自动降级为 'select'——否则被提示注入的模型可在
// 工作区造 .bat/.exe/.js(Windows 上 .js 默认关联是脚本宿主, 会直接执行!), 再诱导用户点「打开」= 一键执行
// 任意程序。降级后仅在资源管理器中定位, 是否运行由用户在资源管理器里自己决定。返回 {command,args,mode,degraded}。
// Pure (no I/O, no spawn) — exposed for e2e 单测护栏逻辑。默认 mode='open'。
// v1.4.1 (audit #3):由「黑名单可执行扩展名」改为【白名单默认拒绝】—— 旧黑名单漏了 .settingcontent-ms /
// .msc / .chm / .hta / .wsc / .sct / .appref-ms / .library-ms / .diagcab 等一大票 LOLBin「一键代码执行」文件类型,
// 被提示注入的模型在工作区造这类文件再诱导用户点「打开」= 任意执行。反转:只有【已知安全的查看类】扩展名才允许
// 'open'(文档/Office/图片/媒体/纯文本/网页),其余一律降级为资源管理器「定位」,由用户自行决定是否运行。
const REVEAL_OPEN_SAFE_EXTS = new Set([
  // 纯文本 / 数据(默认由文本编辑器打开)
  'txt', 'md', 'markdown', 'rtf', 'csv', 'tsv', 'log', 'json', 'xml', 'yaml', 'yml', 'ini', 'toml', 'conf',
  // 文档 / Office(查看器打开;Office 默认受保护视图 + 宏禁用)
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff', 'heic',
  // 音视频
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv',
  // 网页(浏览器沙箱打开)
  'html', 'htm',
]);
function buildRevealSpawn(mode, absPath) {
  const p = String(absPath || '');
  const ext = path.extname(p).slice(1).toLowerCase();
  const wantOpen = mode !== 'select';
  // 白名单默认拒绝:仅安全查看类扩展名可 'open',其余(可执行/脚本/LOLBin/未知/无扩展名)→ 降级 'select'。
  const effMode = (wantOpen && REVEAL_OPEN_SAFE_EXTS.has(ext)) ? 'open' : 'select';
  const args = (effMode === 'select') ? ['/select,' + p] : [p];
  return { command: 'explorer.exe', args, mode: effMode, degraded: wantOpen && effMode === 'select' };
}
// v1.4.6-S2: build the argv to open a URL / file with the OS default handler WITHOUT a shell. browser_open /
// office_open used to do `cp.spawn('cmd.exe', ['/c','start','', target])` — cmd.exe splits a model-controlled
// target on & | && metacharacters, so `http://x&calc` ran calc.exe (command injection,实测复现). Spawning
// explorer.exe directly (Node CreateProcess passes argv verbatim — no shell) hands the URL/path to the
// default browser/handler and never interprets shell metacharacters. Pure (no spawn); exposed for e2e argv
// assertions. NB: the caller must still spawn with {detached, windowsHide, stdio:'ignore'}.unref().
function buildOpenSpawn(target) {
  return { command: 'explorer.exe', args: [String(target || '')] };
}

// Browser navigation has an extra invariant beyond shell-safety: never reuse the current Workbench tab.
// For web pages, resolve the user's default HTTP handler and pass its documented new-tab switch. Local folders
// intentionally retain the Explorer behavior used by the "open data directory" UI action.
let _defaultBrowserExecutable;
function windowsRegistryString(key, valueName) {
  if (process.platform !== 'win32') return '';
  try {
    const args = ['query', key, valueName == null ? '/ve' : '/v', ...(valueName == null ? [] : [valueName])];
    const result = cp.spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 1500 });
    if (result.status !== 0) return '';
    const line = String(result.stdout || '').split(/\r?\n/).find(s => /\sREG_SZ\s/.test(s));
    return line ? String(line).replace(/^.*?\sREG_SZ\s+/, '').trim() : '';
  } catch { return ''; }
}
function defaultBrowserExecutable() {
  if (_defaultBrowserExecutable !== undefined) return _defaultBrowserExecutable;
  _defaultBrowserExecutable = '';
  if (process.platform !== 'win32') return _defaultBrowserExecutable;
  const progId = windowsRegistryString('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice', 'ProgId');
  if (!progId) return _defaultBrowserExecutable;
  const command = windowsRegistryString(`HKCR\\${progId}\\shell\\open\\command`, null);
  const match = command.match(/^\s*"([^"]+\.exe)"|^\s*([^\s]+\.exe)/i);
  const executable = match && (match[1] || match[2]);
  if (executable && fs.existsSync(executable)) _defaultBrowserExecutable = executable;
  return _defaultBrowserExecutable;
}
function isBrowserDocumentTarget(target) {
  const value = String(target || '').trim();
  return /^(https?:|file:)/i.test(value) || /\.html?$/i.test(value);
}
function buildBrowserOpenSpawn(target, browserExecutable = defaultBrowserExecutable()) {
  const value = String(target || '');
  if (!isBrowserDocumentTarget(value) || !browserExecutable) {
    return { ...buildOpenSpawn(value), mode: 'shell-association', preservesWorkbench: true };
  }
  const tabFlag = /firefox/i.test(path.basename(browserExecutable)) ? '-new-tab' : '--new-tab';
  return { command: browserExecutable, args: [tabFlag, value], mode: 'new-tab', preservesWorkbench: true };
}
const PREVIEW_TEXT_EXTS = new Set(['md', 'markdown', 'csv', 'txt', 'html', 'htm', 'json', 'js', 'ts', 'jsx', 'tsx', 'py', 'css', 'xml', 'yaml', 'yml', 'ini', 'log', 'sh', 'ps1', 'bat', 'cmd', 'toml', 'c', 'h', 'cpp', 'java', 'go', 'rs', 'rb', 'php', 'sql', 'tex']);
const PREVIEW_TEXT_MAX = 1 * 1024 * 1024;   // 1MB text cap (spec)
const PREVIEW_IMAGE_MAX = 5 * 1024 * 1024;  // 5MB image cap (spec)
const PREVIEW_IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };
// Read a preview payload for an already-validated absolute path. Returns a plain object matching the
// endpoint contract: {ok, kind:'text'|'image'|'image-toobig'|'html'|'binary', ...}. Never throws for a
// well-formed missing file — returns {ok:false,error}. Kind selection is suffix-driven (kindForPath +
// PREVIEW_TEXT_EXTS): html gets its own kind (front-end sandboxes it); img → dataURI (≤5MB, else too-big);
// text-family → utf8 content (≤1MB, truncated flag); everything else → binary (front-end offers「打开」).
async function readFilePreview(absPath) {
  let st;
  try { st = await fsp.stat(absPath); } catch { return { ok: false, error: 'file not found' }; }
  if (st.isDirectory()) return { ok: false, error: 'is a directory', hint: '只支持预览文件' };
  const ext = String(path.extname(absPath).replace(/^\./, '')).toLowerCase();
  const kind = kindForPath(absPath);
  // Image family → base64 data URI (bounded).
  if (kind === 'img') {
    if (st.size > PREVIEW_IMAGE_MAX) return { ok: true, kind: 'image-toobig', size: st.size, canOpen: true };
    const buf = await fsp.readFile(absPath);
    const mime = PREVIEW_IMG_MIME[ext] || 'application/octet-stream';
    return { ok: true, kind: 'image', dataUri: `data:${mime};base64,${buf.toString('base64')}`, size: st.size };
  }
  // HTML → return raw source; the front-end renders it inside a fully-locked sandbox iframe (never here).
  if (ext === 'html' || ext === 'htm') {
    if (st.size > PREVIEW_TEXT_MAX) {
      const fd = await fsp.open(absPath, 'r');
      try { const b = Buffer.alloc(PREVIEW_TEXT_MAX); const { bytesRead } = await fd.read(b, 0, PREVIEW_TEXT_MAX, 0); return { ok: true, kind: 'html', content: b.slice(0, bytesRead).toString('utf8'), truncated: true, size: st.size }; }
      finally { await fd.close(); }
    }
    return { ok: true, kind: 'html', content: await fsp.readFile(absPath, 'utf8'), truncated: false, size: st.size };
  }
  // Text family (md/csv/txt/json/js/py/…) → utf8 content, ≤1MB (truncated flag when larger).
  if (PREVIEW_TEXT_EXTS.has(ext)) {
    if (st.size > PREVIEW_TEXT_MAX) {
      const fd = await fsp.open(absPath, 'r');
      try { const b = Buffer.alloc(PREVIEW_TEXT_MAX); const { bytesRead } = await fd.read(b, 0, PREVIEW_TEXT_MAX, 0); return { ok: true, kind: 'text', content: b.slice(0, bytesRead).toString('utf8'), truncated: true, size: st.size }; }
      finally { await fd.close(); }
    }
    return { ok: true, kind: 'text', content: await fsp.readFile(absPath, 'utf8'), truncated: false, size: st.size };
  }
  // xlsx/docx/pdf/other → binary; the front-end offers「用系统程序打开」(office_open). Station-side
  // preview of office formats is DEFERRED to v1.0 (zero-npm constraint: no xlsx/docx/pdf parsing lib).
  return { ok: true, kind: 'binary', canOpen: true, size: st.size, ext };
}

function existsExecutable(command) {
  if (!command) return false;
  const s = batchSafeSpawn(command, ['--version']);
  const result = cp.spawnSync(s.command, s.args, { stdio: 'ignore', windowsHide: true, timeout: 6000, ...s.opts });
  return !result.error;
}

// v1.0-S4: `gitCli` capability — is `git` installed & runnable? Probes `git --version` (execFile, 3s), result
// cached ~60s (its own cache, so getCapabilities' 60s matrix cache and this stay in step without coupling).
// Feeds the capability matrix's `gitCli` boolean → TOOL_REQUIRES filters the four git tools when git is absent.
let _gitCliProbe = null; // { at, value }
const GITCLI_CACHE_MS = 60000;
function probeGitCli() {
  const now = Date.now();
  if (_gitCliProbe && (now - _gitCliProbe.at) < GITCLI_CACHE_MS) return _gitCliProbe.value;
  let value = false;
  try {
    const result = cp.spawnSync('git', ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 3000 });
    value = !result.error && result.status === 0;
  } catch { value = false; }
  _gitCliProbe = { at: now, value };
  return value;
}

function buildAttachmentPrompt(attachments) {
  if (!attachments || attachments.length === 0) return '';
  const lines = [
    '',
    '<attached_files>',
  ];
  for (const file of attachments) {
    lines.push(`- ${file.name || path.basename(file.path)}: ${file.path}`);
    if (file.textPreview) {
      lines.push('  <preview>');
      lines.push(file.textPreview);
      lines.push('  </preview>');
    }
  }
  lines.push('</attached_files>');
  return lines.join('\n');
}
