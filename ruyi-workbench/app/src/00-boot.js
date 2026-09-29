#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 如意工作台 server(第43波 构建期拼接模块化)
//
// 本文件(app/src/00-boot.js)是【源码模块】之一:app/server.js 是由 app/build.js
// 把 app/src/*.js 按 src/manifest.json 顺序拼接出的【产物】。改代码请改 src/ 对应
// 模块,然后 `node app/build.js` 重建产物;不要手改 app/server.js(会被下次构建覆盖)。
// 产物字节级可复现(build --check 校验),运行时零依赖单文件,气隙可审。
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');
const readline = require('readline');
const { StringDecoder } = require('string_decoder');
const zlib = require('zlib'); // v0.8-S4a: checkpoint journal gzips `before` content with the built-in zlib (gzipSync/gunzipSync) — NO npm.
const { URL, pathToFileURL } = require('url');

const APP_NAME = '如意 Ruyi'; // v0.8-S8 品牌落地(原 'Win Claude Workbench';去 Claude 化,开源商标合规)
const VERSION = '3.0.0-preview.2'; // Pretender 3.0 预览版 2（2026-09-25）：128 偿债波起到 137 波（preview.1 只打了标签、没发 Release）；正式 3.0.0 仍按 50 号文三组门（55 号文）
// Unique per running server instance; lets an updater prove the process actually restarted
// after an overlay was applied (a version string alone can't prove a restart happened).
const OVERLAY_ID = crypto.randomBytes(6).toString('hex');
const DEFAULT_PORT = 8765;
const MAX_BODY_BYTES = 128 * 1024 * 1024;
// 127-114b(26 号文 §3/45 号文 §2 ②): ASR 转写入站专用上限 25 MB —— 早于上面的 128 MB 总闸判定
// (同一请求流里先撞哪条闸,决定 26 MB 夹具拿到的是 413 还是放行;反向:把本常量换成 MAX_BODY_BYTES
// 或把判定挪到 readBody 之后,asr-transcribe.e2e.js 的 24.9/26 MB 返回码对照当场红)。
const ASR_MAX_BODY_BYTES = 25 * 1024 * 1024;
// 13(128a,48 号文 §2):配置只落「改过的键」——显式键集合 configExplicitKeysV1 ＋ 稀疏落盘,没碰过的设置跟随
// 产品当前默认;迁移按显式键判。本号本身不挂迁移(推断每次读都跑),只标记「这份文件是稀疏格式写的」。
// 12(v2.8 / 107-T1): 126-111b/111d/111e 三个压缩开关翻成默认开,并对 schema<12 的存量配置做一次性
// 迁移(盘上显式写着的 false → true)。11 = v2.8 selectable Agent CLI driver (Claude Code / Kimi Code)。
const CONFIG_SCHEMA = 13;
// v0.8-S0: session file schema. Bumped independently of CONFIG_SCHEMA; normalizeSession backfills.
const SESSION_SCHEMA = 1;

function isPkg() {
  return typeof process.pkg !== 'undefined';
}

function exePath() {
  return isPkg() ? process.execPath : process.argv[1];
}

function appRoot() {
  return path.resolve(__dirname, '..');
}

// 3.0 收口(原 v1.0-S9「建议 v2.0 收口」):数据目录缺省名改为 .ruyi-workbench。解析顺序:
//   RUYI_HOME → WIN_CLAUDE_WORKBENCH_HOME(旧变量名,只读兼容,不再往子进程里写)→ ~/.ruyi-workbench;
//   新目录还不存在、旧目录 ~/.win-claude-workbench 是真目录(迁移没成或还没轮到)时继续用旧目录 —— 数据不会因为改名「消失」。
// 迁移(把旧目录搬成新名、原处留一个指回来的目录联接)只在直接运行 serve 时做一次,见 migrateLegacyDataRoot。
const RUYI_DATA_DIR_NAME = '.ruyi-workbench';
const LEGACY_DATA_DIR_NAME = '.win-claude-workbench';
function defaultDataRoots() {
  const home = os.homedir();
  return { next: path.join(home, RUYI_DATA_DIR_NAME), legacy: path.join(home, LEGACY_DATA_DIR_NAME) };
}
function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}
// dataRoot() / dataRootAliases() 在文件遍历的热路径上逐项被调(03 isSensitiveDataPath);每次都 lstat 两个目录在大树上是秒级开销。
// 结果按「两个环境变量 + 家目录」记住:进程内能改变答案的只有这三样(迁移发生在启动时,迁移后清一次缓存)。
let _dataRootMemo = null;
function dataRootMemoKey() {
  return [process.env.RUYI_HOME || '', process.env.WIN_CLAUDE_WORKBENCH_HOME || '', os.homedir()].join('\0');
}
function resolveDataRootUncached() {
  if (process.env.RUYI_HOME) return process.env.RUYI_HOME;
  if (process.env.WIN_CLAUDE_WORKBENCH_HOME) return process.env.WIN_CLAUDE_WORKBENCH_HOME;
  const { next, legacy } = defaultDataRoots();
  if (lstatOrNull(next)) return next;
  const old = lstatOrNull(legacy);
  if (old && old.isDirectory() && !old.isSymbolicLink()) return legacy;
  // 旧位置是用户自己建的链接 / 联接(数据挪去了别的盘)、新目录还没有:照旧用它。修前这里会落到一个空的新目录,
  // 配置、会话、密钥看起来全没了。迁移不搬链接(见 migrateLegacyDataRoot)。
  if (old && old.isSymbolicLink()) { try { if (fs.statSync(legacy).isDirectory()) return legacy; } catch { /* 断链:当它不存在 */ } }
  return next;
}
function dataRoot() {
  const key = dataRootMemoKey();
  if (_dataRootMemo && _dataRootMemo.key === key && _dataRootMemo.root) return _dataRootMemo.root;
  const root = resolveDataRootUncached();
  _dataRootMemo = { key, root, aliases: null };
  return root;
}
// 数据根的别名:指向同一个目录的其它写法 —— 迁移后旧位置上留的目录联接,或者新位置是指向旧目录的链接。敏感子树判定
// (03 isSensitiveDataPath 与文件遍历的跳过)是按词法前缀比的,只认数据根本身的话,经别名的写法就能读到 config.json /
// runtime.json(token)/ 会话。**与环境变量无关**:Claude / Kimi 的 MCP 子进程总带 RUYI_HOME,修前在那里一律返回空,
// 旧路径上的联接就成了绕过口。判据是 realpath 相等(Windows 上不分大小写),数据根还不存在时不缓存、下次再算。
function dataRootAliases() {
  const root = dataRoot();
  if (_dataRootMemo && _dataRootMemo.root === root && Array.isArray(_dataRootMemo.aliases)) return _dataRootMemo.aliases;
  const norm = p => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
  let rootReal = '';
  try { rootReal = norm(fs.realpathSync(root)); } catch { return []; }
  const { next, legacy } = defaultDataRoots();
  const out = [];
  for (const candidate of [legacy, next]) {
    if (norm(path.resolve(candidate)) === norm(path.resolve(root))) continue;
    try { if (norm(fs.realpathSync(candidate)) === rootReal) out.push(candidate); } catch { /* 不存在 */ }
  }
  if (_dataRootMemo && _dataRootMemo.root === root) _dataRootMemo.aliases = out;
  return out;
}
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || n === process.pid) return false;
  try { process.kill(n, 0); return true; } catch (e) { return Boolean(e && e.code === 'EPERM'); }
}
// 一次性迁移:~/.win-claude-workbench → ~/.ruyi-workbench,原处留目录联接(Windows 普通用户就能建;其它平台是目录符号链接)
// 指回新目录 —— 用户全局 Claude 配置里登记的 MCP 路径、计划任务、快捷方式里写死的旧路径照样能用。
// 只在:直接运行、缺省命令 serve、没有任何数据根环境变量、新目录不存在、旧目录是真目录、旧目录里没有别的活实例
// (runtime.json 的 pid 还活着就不动)时做。搬不动(被占用、跨卷、权限)就原样继续用旧目录,下次启动再试。
function migrateLegacyDataRoot() {
  if (process.env.RUYI_HOME || process.env.WIN_CLAUDE_WORKBENCH_HOME) return { moved: false, reason: 'env' };
  const { next, legacy } = defaultDataRoots();
  if (lstatOrNull(next)) return { moved: false, reason: 'next-exists' };
  const old = lstatOrNull(legacy);
  if (old && old.isSymbolicLink()) return { moved: false, reason: 'legacy-is-link' }; // 用户自己建的链接:不搬,dataRoot() 照旧用它
  if (!old || !old.isDirectory()) return { moved: false, reason: 'no-legacy' };
  try {
    const rt = JSON.parse(fs.readFileSync(path.join(legacy, 'runtime.json'), 'utf8'));
    if (rt && pidAlive(rt.pid)) return { moved: false, reason: 'legacy-in-use', pid: rt.pid };
  } catch { /* 没有 runtime.json 或读不了:没有活实例的证据,照常迁移 */ }
  try { fs.renameSync(legacy, next); } catch (e) { return { moved: false, reason: 'rename-failed', error: String(e && e.code || e) }; }
  _dataRootMemo = null; // 数据根从旧目录换成了新目录
  let junction = true;
  try { fs.symlinkSync(next, legacy, 'junction'); } catch { junction = false; }
  return { moved: true, from: legacy, to: next, junction };
}
// 缺省命令就是 serve(`Ruyi.exe`、`server.js`、`server.js serve --port N`、`server.js --port N`);mcp / install / doctor /
// mcp-config 这些子命令不迁移(MCP 子进程本来就由父进程经 RUYI_HOME 指到数据根)。
function isDirectServeInvocation() {
  if (require.main !== module) return false;
  return !process.argv.slice(2).some(a => ['mcp', 'install', 'doctor', 'mcp-config'].includes(String(a)));
}
const DATA_ROOT_MIGRATION = isDirectServeInvocation() ? migrateLegacyDataRoot() : null;


function externalRoot() {
  return isPkg() ? path.dirname(process.execPath) : appRoot();
}

// A Full offline release ships one verified CPython beside ACC. ACC already starts that interpreter
// by absolute path, but ordinary task commands (`python ...`) inherit the server PATH. Without this
// bridge a clean intranet machine either reports Python missing or falls through to an unrelated
// system Python that cannot import openpyxl/winsdk. Expose the bundled interpreter process-wide so
// native provider tools, Claude CLI children, PowerShell tasks, and direct Ruyi.exe launches agree.
function exposeBundledPythonRuntime() {
  if (process.platform !== 'win32') return '';
  const pythonDir = path.join(externalRoot(), 'mcp', 'ai-computer-control', 'python_embed');
  const pythonExe = path.join(pythonDir, 'python.exe');
  try { if (!fs.existsSync(pythonExe)) return ''; } catch { return ''; }
  const currentPath = String(process.env.PATH || process.env.Path || '');
  const pathDirs = currentPath.split(path.delimiter).filter(Boolean);
  if (!pathDirs.some(dir => path.resolve(dir).toLowerCase() === path.resolve(pythonDir).toLowerCase())) {
    process.env.PATH = [pythonDir, ...pathDirs].join(path.delimiter);
  }
  process.env.PYTHON = pythonExe;
  process.env.PYTHONUTF8 = '1';
  // Keep the signed release runtime immutable when user scripts import source-only packages.
  process.env.PYTHONDONTWRITEBYTECODE = '1';
  process.env.RUYI_BUNDLED_PYTHON = pythonExe;
  return pythonExe;
}

const BUNDLED_PYTHON_RUNTIME = exposeBundledPythonRuntime();

// 随包 ripgrep(app/vendor-bin/rg.exe)对模型开的每一个子进程都可见 —— 与上面随包 Python 同一个模具:
// 进程级 PATH 前置一次,Claude/Kimi CLI、原生 shell_start/powershell_run/script_run、Kimi ACP 终端、
// 子代理与 MCP stdio 子进程全部继承,不必在十几个 spawn 点各拼一遍 env。修前只有 file_search 快路径
// 认得它,模型在终端里敲 rg 是 command not found。
// 更糟的是修前 probeRg 找的是 appRoot()/vendor-bin —— appRoot() 是 server.js 的【上一级】(产品根),
// 而 rg.exe 随仓/随包/随 overlay 都在 app/vendor-bin(与 staticBase() 的 app/public 同一个 app 目录),
// 于是随包那份从来没被认出来过,体检上的「有 ripgrep」全靠用户自己 PATH 上碰巧有的 rg。
// 只认这一个锚定目录 <外部根>/app/vendor-bin(源码运行时外部根就是 appRoot());它必须是真目录、
// 不是符号链接/目录联接(同 05c 对 vendor-bin 的信任锚定口径)—— 工作区可控的路径绝不进 PATH。
// 不碰 USE_BUILTIN_RIPGREP:Claude Code 默认用它自带的 rg,这里只是让 Bash 里的裸 rg 找得到。
// RUYI_PATH_BEFORE_VENDOR 留住前置之前的 PATH,probeRg 靠它区分「系统装的 rg」与「随包的 rg」。
function ruyiVendorBinDir() {
  const dir = path.join(externalRoot(), 'app', 'vendor-bin');
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() ? dir : '';
  } catch { return ''; }
}
function samePathEntry(a, b) {
  const norm = p => { const r = path.resolve(String(p || '').trim().replace(/^"|"$/g, '')); return process.platform === 'win32' ? r.toLowerCase() : r; };
  try { return norm(a) === norm(b); } catch { return false; }
}
const RUYI_PATH_BEFORE_VENDOR = String(process.env.PATH || process.env.Path || '');
function exposeVendorBinOnPath() {
  const dir = ruyiVendorBinDir();
  if (!dir) return '';
  const rest = RUYI_PATH_BEFORE_VENDOR.split(path.delimiter).filter(entry => entry && !samePathEntry(entry, dir));
  process.env.PATH = [dir, ...rest].join(path.delimiter);
  return dir;
}
const RUYI_VENDOR_BIN_ON_PATH = exposeVendorBinOnPath();

const paths = {
  data: dataRoot(),
  config: path.join(dataRoot(), 'config.json'),
  sessions: path.join(dataRoot(), 'sessions'),
  uploads: path.join(dataRoot(), 'uploads'),
  logs: path.join(dataRoot(), 'logs'),
  generated: path.join(dataRoot(), 'generated'),
  checkpoints: path.join(dataRoot(), 'checkpoints'), // v0.8-S4a: file-checkpoint journal (per-session)
  playbooks: path.join(dataRoot(), 'playbooks'), // v0.9-S2: user-authored playbooks (built-ins ship in resources/)
  skills: path.join(dataRoot(), 'skills'), // v1 技能体系: 用户级技能 skills/<id>/SKILL.md(内置技能仍在 resources/,项目技能在 <cwd>/.ruyi/skills)
  webcache: path.join(dataRoot(), 'webcache'), // v0.9-S9: web_fetch main-text cache (<sha256(url)>.json), offline-reusable
  agentRuns: path.join(dataRoot(), 'agent-runs'), // persistent DAG workflow state, grouped by session
  agentWorkflows: path.join(dataRoot(), 'agent-workflows'), // personal reusable DAG templates
  agentWorktrees: path.join(dataRoot(), 'agent-worktrees'), // optional isolated write-agent worktrees (outside the repo)
  usage: path.join(dataRoot(), 'usage'),
  memory: path.join(dataRoot(), 'memory'), // v2 跨会话记忆(团队模式 v2 Phase3): global/ 与 project/<projectKey>/ // v1.4-OSS 用量看板: append-only monthly cost ledgers usage/YYYY-MM.jsonl
};

// v1 技能体系: 技能/目录名的安全字符集(供落盘 skills/<id>/、防路径穿越)。复用同 playbook id 的形状。
const SKILL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const LEGACY_API_ERROR_CODES = new Map([
  ['missing or invalid workbench token', 'auth.token_invalid'],
  ['bad token', 'auth.token_invalid'],
  ['invalid sessionId', 'session.id_invalid'],
  ['sessionId required', 'session.id_required'],
  ['session not found', 'session.not_found'],
  ['method not allowed', 'api.method_not_allowed'],
  ['host not allowed', 'api.host_rejected'],
  ['unknown action', 'request.action_unknown'],
  // 128b:撤回相关的三句裸串给稳定码(否则一律落成 api.request_failed,前端只能把原串 'rewind_superseded' 摆给用户看)。
  ['rewind_superseded', 'session.rewind_superseded'],
  ['session.rewound_during_write', 'session.rewound_during_write'],
  ['session.history_changed_during_compact', 'session.history_changed_during_compact'],
]);

// Keep the legacy message as an optional diagnostic while ensuring every HTTP error has a stable,
// language-neutral machine code. Individual routes can still use apiFailure() for a richer code/params.
function normalizeApiErrorPayload(data) {
  if (!data || data.ok !== false || typeof data.error !== 'string') return data;
  const message = data.error;
  const { error, ...rest } = data;
  return {
    ...rest,
    error: {
      code: LEGACY_API_ERROR_CODES.get(message) || 'api.request_failed',
      params: {},
      message,
    },
  };
}

function json(data, status = 200, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(normalizeApiErrorPayload(data), null, 2),
  };
}

// P2 API error contract. Error codes and params are stable/localization-friendly; message remains a
// diagnostic fallback for older callers while the front end migrates away from sentence matching.
function apiFailure(code, params = {}, message = '', status = 400) {
  return json({
    ok: false,
    error: {
      code: String(code || 'api.unknown'),
      params: params && typeof params === 'object' && !Array.isArray(params) ? params : {},
      ...(message ? { message: String(message) } : {}),
    },
  }, status);
}

// 架构还债批 1 #7:按 sessionId 操作的路由最常见的两句失败。修前 40 余处各自手写裸串
// json({ ok:false, error:'invalid sessionId' }, 400) / 'session not found' 404,靠上面那张遗留映射表
// 兜底翻成稳定码 —— 拼错一个字就悄悄落成 api.request_failed。出参与遗留写法逐字节相同(code/params/message 同序)。
function apiSessionIdInvalid() { return apiFailure('session.id_invalid', {}, 'invalid sessionId', 400); }
function apiSessionNotFound() { return apiFailure('session.not_found', {}, 'session not found', 404); }

function text(data, status = 200, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
    body: data,
  };
}

// 按 key 串行的写链(架构还债批 1 #3):同一个 key 上的 work 一个接一个跑,前一个失败不挡后一个;
// 链尾结算后(成功或失败)若仍是自己就从 map 里摘掉,不留长寿条目。返回的就是这一次 work 的 promise ——
// 调用方要结果就 await 它,要吞错就自己 catch(helper 只保证链本身不产生未处理的拒绝)。
// 修前 02 / 08 里七处各自手写同一段 previous.catch().then(work) → set → 自清;需要额外收尾动作的
// (appendIntervention 的推送与压缩计数、saveSession 的在飞快照)仍然手写,不走这里。
function runKeyedChain(chains, key, work) {
  const previous = chains.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  chains.set(key, current);
  current.then(() => {}, () => {}).then(() => { if (chains.get(key) === current) chains.delete(key); });
  return current;
}

// 分离式外部启动(打开文件/网址/编辑器/资源管理器)的共用入口。病根:cp.spawn 找不到程序、没权限、被策略拦
// (ENOENT / EACCES / EPERM)时【不】同步抛出,而是稍后在 ChildProcess 上发 'error' 事件;裸写
// spawn(...).unref() 没有监听者,这个事件就成了 uncaughtException,startServerInner 的兜底会 process.exit(1)
// —— 一次「打开」失败(注册表里残留的默认浏览器路径、卸掉的编辑器、被 AppLocker 拦的 explorer.exe)带走整个
// 工作台:在飞回合、MCP 子进程、待决权限全丢,而工具先前已经回了「opened」。
// 这里先挂 'error' 监听再 unref,并以 promise 交回启动结果:'spawn' 事件 → { ok:true },'error' → { ok:false, error }。
// 同步抛出(参数非法)照旧同步抛给调用方,与原来 try { spawn().unref() } catch 的语义一致;成功路径的参数、
// detached/stdio/windowsHide 全由调用方原样传入,行为不变。不关心结果的调用方可以不 await(错误已被吸收)。
function spawnDetachedChecked(command, args, options) {
  const child = cp.spawn(command, args || [], options);
  const started = new Promise(resolve => {
    child.on('error', error => resolve({ ok: false, error: (error && error.message) || String(error), code: (error && error.code) || null }));
    child.once('spawn', () => resolve({ ok: true, pid: child.pid }));
  });
  child.unref();
  return started;
}

// 路径段解码:decodeURIComponent 遇到坏的百分号编码(如 `%zz`)会抛 URIError,落到顶层就是 500 + http_unhandled。
// 路由拿到 null 按「这个 id 不存在/不合法」回 4xx(先例:/api/missions/:id/interventions/:iv/decision)。
function safeDecodeURIComponent(segment) {
  try { return decodeURIComponent(String(segment == null ? '' : segment)); } catch { return null; }
}

function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// 117q-B1(30 号文 §4.1):子进程 stdout 的 NDJSON 逐行喂入器。为什么必须走 StringDecoder ——
// chunk 边界不保证落在字符边界上,而 CJK 是 3 字节:对每个 chunk 单独 toString('utf8') 会把
// 被切开的汉字静默变成 U+FFFD,后续续接字节也解码成垃圾。这是一个以中文为主的产品的主干道。
// flush() 负责子进程关闭后把 decoder 里的残字与最后那半行交出去(三者协议都是「一行一个 JSON」)。
// ── 控制台输出解码(PowerShell / cmd / 原生命令)────────────────────────────────────────────────────────
// 中文 Windows 上,无控制台(windowsHide)起的 powershell.exe 往重定向的 stdout 写的是系统代码页(GBK/cp936),
// 原生命令也多半如此;而 git、node、python(UTF-8 模式)写的是 UTF-8 —— 同一份输出里两种编码混着来很常见。
// [Console]::OutputEncoding 那类 PS 侧方案在无控制台 spawn 下无效(04-desktop-shell 头注里实测过),所以在 Node 侧解:
// 【按行】判定 —— 合法 UTF-8 就按 UTF-8,否则按 GB18030(GBK 的超集)。按行而不是整段:修前整段只要有一处不是
// 合法 UTF-8 就整段按 GBK 解,混排输出里的 UTF-8 部分反被解坏。换行符 0x0A 在两种编码里都不会出现在多字节字符中间,
// 所以按它切是安全的。纯 ASCII 行两种解法结果一样。
let _consoleGbDecoder = null;
const _consoleUtf8Strict = new TextDecoder('utf-8', { fatal: true });
function decodeConsoleSegment(buf) {
  if (!buf || !buf.length) return '';
  try { return _consoleUtf8Strict.decode(buf); } catch { /* 不是合法 UTF-8 */ }
  try {
    if (!_consoleGbDecoder) { try { _consoleGbDecoder = new TextDecoder('gb18030'); } catch { _consoleGbDecoder = new TextDecoder('gbk'); } }
    return _consoleGbDecoder.decode(buf);
  } catch { return Buffer.from(buf).toString('utf8'); } // 这个 node 没带 GBK 的 ICU:退回 UTF-8(至少不崩)
}
function decodeConsoleText(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  let out = '', start = 0;
  for (let i = data.indexOf(0x0a); i >= 0; i = data.indexOf(0x0a, start)) {
    out += decodeConsoleSegment(data.subarray(start, i + 1));
    start = i + 1;
  }
  return out + decodeConsoleSegment(data.subarray(start));
}
// 流式版本:整行才解码;没有换行的尾巴先攒着(多字节字符可能被 chunk 切开),由调用方在空闲时 flush()
// (交互式 shell 的提示符、「是否继续? [Y/N]」这类不带换行的输出)或在进程结束时 end()。
// 尾巴上一个没写完的多字节字符有多少字节(0 = 尾巴完整):UTF-8 看最后一个起始字节还差几个续字节;
// 否则按 GBK 看结尾连续高位字节的个数是否为奇数(双字节字符只到了前一半)。空闲 flush 时把它留到下一次。
function consoleIncompleteTail(buf) {
  const n = buf.length;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const b = buf[n - back];
    if (b >= 0x80 && b < 0xc0) continue;            // UTF-8 续字节,继续往前找起始字节
    if (b >= 0xc0) {
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      if (back < need) { try { _consoleUtf8Strict.decode(buf.subarray(0, n - back)); return back; } catch { /* 前面也不是 UTF-8:按 GBK 看 */ } }
    }
    break;
  }
  let high = 0;
  while (high < n && buf[n - 1 - high] >= 0x80) high += 1;
  return high % 2 === 1 ? 1 : 0;
}
function createConsoleLineDecoder() {
  let pending = Buffer.alloc(0);
  const take = () => { const rest = pending; pending = Buffer.alloc(0); return decodeConsoleText(rest); };
  return {
    write(chunk) {
      const data = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      const cut = data.lastIndexOf(0x0a);
      if (cut < 0) { pending = data; return pending.length > 256 * 1024 ? take() : ''; }
      pending = data.subarray(cut + 1);
      return decodeConsoleText(data.subarray(0, cut + 1));
    },
    // 空闲时吐出不带换行的尾巴(提示符之类),但没写完的那个字符留着 —— 写方可能正停在两个字节之间。
    flush() {
      const keep = consoleIncompleteTail(pending);
      if (!keep) return take();
      const head = pending.subarray(0, pending.length - keep);
      pending = pending.subarray(pending.length - keep);
      return decodeConsoleText(head);
    },
    end: take,
    get pendingBytes() { return pending.length; },
  };
}

function createNdjsonLineFeeder(onLine) {
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  return {
    push(chunk) {
      // hunt2-engines#4:只在【新到的这段】里找换行。修前每块都把整段残行拼上再 split 一遍 —— 一条 20MB 的单行
      // (大 tool_result / base64 图片)按 64KB 分块喂进来是 O(n²),实测 8 秒、50MB 近一分钟阻塞事件循环。
      // 新段里没有换行就只追加(V8 字符串拼接是摊还 O(1)),有换行时整段 split 一次,残行随即清空 —— 整体线性。
      const text = decoder.write(chunk);
      if (!text) return;
      if (text.indexOf('\n') < 0) { remainder += text; return; }
      const lines = (remainder + text).split(/\r?\n/);
      remainder = lines.pop() || '';
      for (const line of lines) onLine(line);
    },
    flush() {
      remainder += decoder.end();
      if (remainder.trim()) onLine(remainder);
      remainder = '';
    },
  };
}

// hunt2-engines#17:CLI 子进程的诊断文本(stderr、stdout 里的非 JSON 行)原来无上限累积,回合结束整段落进会话文件 ——
// 一个刷屏的 CLI 能把一条会话撑到上百 MB,之后每次读写会话都要搬它。这里只留头尾各一半(默认共 64K 字符):
// 启动错误多在头部、致命错误多在尾部,中间用一行说明省略了多少。累加是摊还 O(1)(尾巴超过两倍半额才裁一次)。
const CLI_DIAGNOSTIC_TEXT_CAP = 64 * 1024;
function createCappedDiagnosticText(cap = CLI_DIAGNOSTIC_TEXT_CAP) {
  const half = Math.max(1, Math.floor(cap / 2));
  let head = '';
  let tail = '';
  let dropped = 0;
  return {
    append(text) {
      let rest = String(text || '');
      if (!rest) return;
      if (head.length < half) {
        const take = rest.slice(0, half - head.length);
        head += take;
        rest = rest.slice(take.length);
        if (!rest) return;
      }
      tail += rest;
      if (tail.length > half * 2) { dropped += tail.length - half; tail = tail.slice(-half); }
    },
    toString() {
      const omitted = dropped + Math.max(0, tail.length - half);
      return omitted ? `${head}\n…[已省略 ${omitted} 字符]…\n${tail.slice(-half)}` : head + tail;
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// P2-8(30号文§3 总表 + §4「中和伪造围栏标签」判据): 防提示词注入的判据 —— 曾在 06d/06e/06/09 手写 6 遍
// (workbench-memory / workbench-memory-core / mission-ledger / project-memory / skill-index /
// workbench-plan-approved),六处形状完全一致(gi 标志 + 可选斜杠捕获组),判据一致全靠人工复制维持。把不可信
// 文本里可能出现的 `<TAG`/`</TAG` 前括号换成方括号,让模型吐出来的文本不能提前闭合/伪造调用方外层拼接的固定
// 字面围栏(如 <workbench-memory>…</workbench-memory>)。方括号与尖括号同为 1 字符/1 字节,替换不改变长度,
// 不影响调用方紧随其后的字符/字节预算截断算术。只做这一步替换 —— 调用方各自原有的空白折叠(`\s+`→' ')/
// trim/null 兜底/截断等链式处理保持原样,不并入本函数(各处链式处理的必要差异见各调用点)。
function neutralizeFenceTag(text, tagName) {
  return String(text).replace(new RegExp('<(/?)' + tagName, 'gi'), '[$1' + tagName);
}

// P2-9(30号文§3 总表 + §8.9②): 工具分级排序表 —— 现有 07-autonomy.js/08-agent-runs.js(×3)/
// 09b-replan-ledger.js(×2)六处独立声明字面量 `{read:0,edit:1,exec:2}`,判据一致(数值越大权限越宽)全靠
// 人工复制维持。这是【权限升级判据】—— 08/09b 拿它判"子代理这次调用的工具是否超出授权层级"、"replan
// 补丁是否试图把节点 tier 抬高",分叉的后果是越权。117q-B5 曾把它落在 07-autonomy.js,但 09b 此前从未
// 消费 07 的任何符号,那次收编因此新增了一条循环边 09b-replan-ledger.js->07-autonomy.js,被迫登记进
// module-dependency-policy.json 的白名单(117q-B7 已撤回该条目 —— 移完后 09b 不再引用 07 的任何符号,
// 那条边真的不存在了)。落回本文件(00-boot.js)则 07/08/09b 三个消费者全部已经依赖 00-boot,新增边数
// 为零——它本就只是一张纯查表常量,没有任何 autonomy 语义。冻结防意外改写。
const TOOL_TIER_RANK = Object.freeze({ read: 0, edit: 1, exec: 2 });

// P2-16(30号文§3 总表): argsHash 指纹算法两份字面相同 —— 06f-autonomy-grants.js::consumeGrant(用量事件,
// 收对象 args)与 09b-replan-ledger.js::recordNodeContinuation(节点续点 pending 步骤,收预先算好的
// argsStr 字符串)各自手写一遍 sha1+hex 截 12 位。收拢两处 best-effort 语义:入参已经是字符串就直接用,
// 否则 JSON.stringify(args || {});任何异常兜底返回空串(与两处原有 try/catch 兜底行为一致,不让指纹计算
// 炸调用方主流程)。纯函数,只吃入参、无 IO。
function hashArgs(args) {
  try {
    const str = typeof args === 'string' ? args : JSON.stringify(args || {});
    return crypto.createHash('sha1').update(str).digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

async function ensureDirs() {
  await Promise.all([
    fsp.mkdir(paths.data, { recursive: true }),
    fsp.mkdir(paths.sessions, { recursive: true }),
    fsp.mkdir(paths.uploads, { recursive: true }),
    fsp.mkdir(paths.logs, { recursive: true }),
    fsp.mkdir(paths.generated, { recursive: true }),
    fsp.mkdir(paths.checkpoints, { recursive: true }),
    fsp.mkdir(paths.playbooks, { recursive: true }), // v0.9-S2
    fsp.mkdir(paths.skills, { recursive: true }), // v1 技能体系: 用户级技能目录
    fsp.mkdir(paths.webcache, { recursive: true }), // v0.9-S9
    fsp.mkdir(paths.agentRuns, { recursive: true }),
    fsp.mkdir(paths.agentWorkflows, { recursive: true }),
    fsp.mkdir(paths.agentWorktrees, { recursive: true }),
    fsp.mkdir(paths.usage, { recursive: true }), // v1.4-OSS 用量看板: append-only monthly ledgers
    fsp.mkdir(paths.memory, { recursive: true }), // v2 跨会话记忆: 记忆库根(global/ 与 project/<projectKey>/ 按需建)
  ]);
}

// ===== v1.4-OSS 用量/成本账本 (append-only monthly ledger) ================================================
// Each finished turn (both engines) appends ONE JSON line to usage/YYYY-MM.jsonl (month = the row's UTC ts).
// Design: APPEND-ONLY, never read-modify-write, so concurrent 多会话 turns cannot corrupt a shared index the
// way a read-modify-write index could. Empty / zero-token turns are skipped. A ledger write failure is
// fire-and-forget (a non-critical persistence, like the rest) and must NEVER break the turn. Corrupt lines are
// skipped at read time (safeJsonParse per line). COST SEMANTICS: every recorded `cost` is a NOTIONAL/estimate
// figure, never an assertion of real billing (a Claude subscription or a third-party Coding Plan may not bill
// per token at all). `costTrusted:false` marks rows whose currency amount is plan-based / not a meaningful
// spend (see the Claude third-party endpoint path); aggregation keeps those OUT of the real costsByCurrency.
let usageLedgerChain = Promise.resolve();
// 128f-⑥:还没轮到的那几行(见 appendUsageLedger)。退出路径上的同步补写只动 state==='queued' 的。
const usageLedgerPending = [];
// 退出监听器里只能同步 I/O(async 版永远跑不完 —— 与 02 的 flushSessionIndexSync 同一个理由)。返回补写了几行。
function flushUsageLedgerSync() {
  let written = 0;
  for (const item of usageLedgerPending) {
    if (!item || item.state !== 'queued') continue;
    try { fs.mkdirSync(path.dirname(item.file), { recursive: true }); fs.appendFileSync(item.file, item.line, 'utf8'); item.state = 'done'; written += 1; }
    catch { /* best effort:退出路径上不许抛 */ }
  }
  return written;
}

// Resolve the ledger source + cost-trust for a Claude CLI turn. modelsApiBase EMPTY = Anthropic direct ->
// source 'claude-cli', CLI total_cost_usd usable as a NOTIONAL USD estimate. NON-EMPTY = a third-party
// Anthropic-compatible endpoint (e.g. a vendor Coding Plan) whose CLI-reported cost is computed with
// ANTHROPIC pricing and is therefore WRONG for that vendor (and often a flat monthly plan) -> record tokens
// only, cost null, costTrusted false, and tag the source by its known preset id (else host) so grouping stays
// honest (Claude 官方 vs 第三方端点). Runs at turn time, so CLAUDE_ENDPOINT_PRESETS (declared later) is available.
function claudeLedgerSource(config) {
  let base = (config && typeof config.modelsApiBase === 'string') ? config.modelsApiBase.trim() : '';
  // v1.4-OSS 用量看板(补): 当 config.modelsApiBase 为空时,CLI 子进程仍会继承 OS 环境里的 ANTHROPIC_BASE_URL /
  // ANTHROPIC_BASE(effectiveAnthropicEnv 只在 modelsApiBase 非空时覆盖它们,否则原样穿透)。纯用环境变量把
  // Claude CLI 路由到第三方端点时,CLI 报的 total_cost_usd 仍按 Anthropic 计价、对该厂商不可信 —— 据此把
  // costTrusted 判为 false,与显式 modelsApiBase 的第三方路径一致。
  if (!base) base = String(process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE || '').trim();
  if (!base) return { provider: 'claude-cli', costTrusted: true };
  let tag = '';
  try {
    for (const p of CLAUDE_ENDPOINT_PRESETS) { if (p && p.baseUrl && base.startsWith(p.baseUrl)) { tag = p.id; break; } }
    if (!tag) tag = 'claude-endpoint:' + new URL(base).host;
  } catch { tag = 'claude-endpoint:unknown'; }
  return { provider: tag, costTrusted: false };
}

// v1.4-OSS 用量看板(补): shared Claude-turn billing-field resolver. Extracted from the main-turn ledger append
// so BOTH the main chat turn AND a Claude sub-agent node bill identically. Cost precedence (诚实计费):
//  (1) config.claudePricing set -> tokens×price, a meaningful estimate for direct + third-party endpoints,
//      costTrusted:true; (2) else, Anthropic-direct only (claudeLedgerSource costTrusted), the CLI's reported
//      total_cost_usd as a NOTIONAL USD figure; (3) else (third-party, unpriced) cost null + costTrusted false
//      (its CLI cost is Anthropic-priced and wrong for that vendor, often a flat monthly plan not billed per token).
// computeCostFromPricing is a hoisted function declaration, so the forward reference here is safe at call time.
function claudeCostFields(config, inTok, outTok, costUsd) {
  const { provider, costTrusted: directTrust } = claudeLedgerSource(config);
  let cost = null, currency = null, costTrusted = directTrust;
  const priced = computeCostFromPricing(config && config.claudePricing, inTok, outTok);
  if (priced.currency) { cost = priced.cost; currency = priced.currency; costTrusted = true; }
  else if (directTrust) { const c = Number(costUsd); if (Number.isFinite(c)) { cost = c; currency = 'USD'; } }
  return { provider, cost, currency, costTrusted };
}

// Validate optional per-million-token pricing. Provider pricing may add cachedInputPerM and exact model
// overrides; legacy {inputPerM,outputPerM,currency} remains byte-stable after normalization.
function normalizePricing(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const parseRate = value => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const inP = parseRate(raw.inputPerM), outP = parseRate(raw.outputPerM), cachedP = parseRate(raw.cachedInputPerM);
  const cur = (typeof raw.currency === 'string') ? raw.currency.trim().slice(0, 8) : '';
  const modelRows = [];
  const seen = new Set();
  for (const row of (Array.isArray(raw.models) ? raw.models : []).slice(0, 100)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const model = typeof row.model === 'string' ? row.model.trim().slice(0, 240) : '';
    if (!model || seen.has(model)) continue;
    const modelIn = parseRate(row.inputPerM), modelOut = parseRate(row.outputPerM), modelCached = parseRate(row.cachedInputPerM);
    if (modelIn == null && modelOut == null && modelCached == null) continue;
    seen.add(model);
    modelRows.push({
      model,
      ...(modelIn == null ? {} : { inputPerM: modelIn }),
      ...(modelOut == null ? {} : { outputPerM: modelOut }),
      ...(modelCached == null ? {} : { cachedInputPerM: modelCached }),
    });
  }
  if (!cur || (inP == null && outP == null && cachedP == null && !modelRows.length)) return null;
  return {
    inputPerM: inP == null ? 0 : inP,
    outputPerM: outP == null ? 0 : outP,
    currency: cur,
    ...(cachedP == null ? {} : { cachedInputPerM: cachedP }),
    ...(modelRows.length ? { models: modelRows } : {}),
  };
}
function cachedInputTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const raw = details.cached_tokens != null ? details.cached_tokens
    : details.cache_read_input_tokens != null ? details.cache_read_input_tokens
      : usage.cache_read_input_tokens != null ? usage.cache_read_input_tokens : usage.cached_tokens;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
// Cached input is part of input tokens for OpenAI-compatible usage frames. Charge the non-cached remainder at
// inputPerM and cached tokens at cachedInputPerM; when the cache price is unset, conservatively use inputPerM.
function computeCostFromPricing(pricing, inTok, outTok, cachedInTok = 0) {
  const p = normalizePricing(pricing);
  if (!p) return { cost: null, currency: null };
  const input = Math.max(0, Number(inTok) || 0);
  const cached = Math.min(input, Math.max(0, Number(cachedInTok) || 0));
  const cachedRate = Number.isFinite(Number(p.cachedInputPerM)) ? Number(p.cachedInputPerM) : p.inputPerM;
  const cost = (input - cached) / 1e6 * p.inputPerM + cached / 1e6 * cachedRate + (Number(outTok) || 0) / 1e6 * p.outputPerM;
  return { cost: Number.isFinite(cost) ? cost : null, currency: p.currency };
}
// Exact model override wins within one provider; missing cached price continues to fall back to that row's input rate.
function computeProviderCost(provider, inTok, outTok, cachedInTok = 0, model = '') {
  const pricing = normalizePricing(provider && provider.pricing);
  if (!pricing) return { cost: null, currency: null };
  const modelId = String(model || provider && provider.model || '').trim();
  const override = Array.isArray(pricing.models) ? pricing.models.find(row => row.model === modelId) : null;
  const resolved = override ? {
    inputPerM: override.inputPerM == null ? pricing.inputPerM : override.inputPerM,
    outputPerM: override.outputPerM == null ? pricing.outputPerM : override.outputPerM,
    cachedInputPerM: override.cachedInputPerM == null ? (pricing.cachedInputPerM == null ? pricing.inputPerM : pricing.cachedInputPerM) : override.cachedInputPerM,
    currency: pricing.currency,
  } : pricing;
  return computeCostFromPricing(resolved, inTok, outTok, cachedInTok);
}

function appendUsageLedger(entry) {
  try {
    const inTok = Math.max(0, Math.round(Number(entry.inTok) || 0));
    const outTok = Math.max(0, Math.round(Number(entry.outTok) || 0));
    const cachedInTok = Math.min(inTok, Math.max(0, Math.round(Number(entry.cachedInTok) || 0)));
    // NB: Number(null) === 0, so guard null/undefined explicitly — a tokens-only turn must stay cost:null.
    const costNum = (entry.cost == null) ? NaN : Number(entry.cost);
    // v1.4-OSS 用量看板(补): skip a truly empty row — zero tokens AND no trusted positive cost. A row that reports
    // a real cost but no per-token usage (e.g. a Claude-plan aux call billed a flat amount) is KEPT so its spend
    // is not silently lost. costNum is computed above so this guard can see it.
    if (inTok <= 0 && outTok <= 0 && !(Number.isFinite(costNum) && costNum > 0)) return;
    const ts = (typeof entry.ts === 'string' && entry.ts) ? entry.ts : nowIso();
    const rec = {
      ts,
      sessionId: String(entry.sessionId || ''),
      engine: entry.engine === 'claude' ? 'claude' : 'openai',
      provider: String(entry.provider || ''),
      model: String(entry.model || ''),
      inTok, outTok, cachedInTok,
      cost: Number.isFinite(costNum) ? costNum : null,
      currency: (typeof entry.currency === 'string' && entry.currency) ? entry.currency : null,
      costTrusted: entry.costTrusted !== false, // false = plan-based / notional (kept out of real cost totals)
      estimated: entry.estimated === true,
      turnSeq: Number(entry.turnSeq) || 0,
      // v1.4-OSS 用量看板(补): kind is three-valued — 'turn' (top-level chat turn), 'subagent' (an Agent 工作流 /
      // orchestrate_agents DAG node), or 'aux' (a non-turn helper call: 压缩摘要 / playbook 起草 等). Old rows without a
      // kind read as 'turn' (向后兼容). agentKey/subagentId are stamped only for sub-agent rows so the dashboard
      // can attribute a DAG node's spend; both truncated to a sane length.
      kind: entry.kind === 'subagent' ? 'subagent' : (entry.kind === 'aux' ? 'aux' : 'turn'),
    };
    if (entry.agentKey != null && String(entry.agentKey)) rec.agentKey = String(entry.agentKey).slice(0, 120);
    if (entry.subagentId != null && String(entry.subagentId)) rec.subagentId = String(entry.subagentId).slice(0, 120);
    if (entry.runId != null && String(entry.runId)) rec.runId = String(entry.runId).slice(0, 120); // 代理模式 v2:代理 run 归属(subagent/aux 行)
    // v1.4-OSS 用量看板(补): optional note tags an aux row's sub-kind (e.g. 'compact' / 'playbook-draft'), ≤40 chars.
    if (entry.note != null && String(entry.note)) rec.note = String(entry.note).slice(0, 40);
    const line = JSON.stringify(rec) + '\n';
    const file = path.join(paths.usage, ts.slice(0, 7) + '.jsonl');
    // 128f-⑥:排队的这一行先登记进 usageLedgerPending(状态 queued)—— 退出路径(SIGINT／SIGTERM／未捕获异常都走
    // process.exit)上链还没轮到它,flushUsageLedgerSync 用同步 I/O 把 queued 的补写掉;正在写的那一行(writing)
    // 不补:它落没落盘不知道,补了可能记两遍(费用翻倍比少一行更糟)。
    const pending = { file, line, state: 'queued' };
    usageLedgerPending.push(pending);
    // One global append chain so multi-session concurrent writes never interleave a half-line.
    usageLedgerChain = usageLedgerChain.then(async () => {
      try {
        if (pending.state === 'queued') {
          pending.state = 'writing';
          await fsp.mkdir(paths.usage, { recursive: true });
          await fsp.appendFile(file, line, 'utf8');
          pending.state = 'done';
        }
      } finally {
        const at = usageLedgerPending.indexOf(pending);
        if (at >= 0) usageLedgerPending.splice(at, 1);
      }
      markPretenderIndexDirty(rec.sessionId, 'usage'); // 75c: lazily refresh only this Mission's usage aggregate
      if (rec.kind === 'turn') bumpMissionChangeSeq(rec.sessionId, {
        type: 'budget',
        cursor: { turnSeq: rec.turnSeq, engine: rec.engine },
        detail: { inTok: rec.inTok, outTok: rec.outTok, cachedInTok: rec.cachedInTok, cost: rec.cost, currency: rec.currency || '', estimated: rec.estimated },
      });
    }).catch(() => {}); // fire-and-forget: a ledger failure must never wedge the chain or the turn
  } catch { /* never let accounting break a turn */ }
}

// Local-calendar day key (YYYY-MM-DD) for byDay bucketing (matches the today/month local range boundaries).
function usageDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// 性能批 P1:账大体按时间追加,相邻行多半同一天。记住上一次算出的那一天的 [本地 0 点, 次日 0 点),落在里面就复用日键 ——
// 日键只由 ms 决定,区间内处处相同,所以结果与逐行 usageDayKey 相同(NaN 永远不落在区间里,照旧逐次现算)。
// 边界按日历字段现造(new Date(年, 月, 日) / 日 + 1):午夜跳 DST 的时区(开罗、哈瓦那、贝鲁特、圣地亚哥……)那一天
// 的 0 点不存在,setHours(0) 会落到 01:00,若再从它 setDate(+1) 推次日边界就错成次日 01:00,次日 0–1 点的行被记到前一天。
function usageDayKeyMemo() {
  let lo = NaN, hi = NaN, key = '';
  return ms => {
    if (ms >= lo && ms < hi) return key;
    key = usageDayKey(ms);
    const d = new Date(ms);
    lo = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    hi = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    return key;
  };
}
// Lower-bound instant (ms) for a range. today/month use the LOCAL calendar; week = last 7x24h; all = 0.
function usageRangeLowerMs(range, now) {
  const d = new Date(now);
  if (range === 'today') { d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (range === 'week') return now - 7 * 24 * 60 * 60 * 1000;
  if (range === 'all') return 0;
  d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); // 'month' (default)
}
// Read every ledger row with ts >= lowerMs. Reads only month files that can contain such rows (file month key
// >= the lower bound's UTC month; monotonic, so no qualifying row is missed). Corrupt lines are skipped, and a
// missing usage dir (old install) yields [] rather than throwing.
async function readUsageRows(lowerMs) {
  const rows = [];
  let files = [];
  try { files = (await fsp.readdir(paths.usage)).sort(); } catch { return rows; }   // 性能批 P1:按月份名排序 —— 修前是 readdir 次序(Linux 上是散列序),浮点累加次序随平台漂
  const lowerKey = lowerMs > 0 ? new Date(lowerMs).toISOString().slice(0, 7) : '';
  for (const f of files) {
    if (!/^\d{4}-\d{2}\.jsonl$/.test(f)) continue;
    if (lowerKey && f.slice(0, 7) < lowerKey) continue; // whole month precedes the lower bound
    let raw = '';
    try { raw = await fsp.readFile(path.join(paths.usage, f), 'utf8'); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const rec = safeJsonParse(line, null);
      if (!rec || typeof rec !== 'object') continue; // corrupt line skipped
      const t = Date.parse(rec.ts);
      if (!Number.isFinite(t) || (lowerMs > 0 && t < lowerMs)) continue;
      rows.push(rec);
    }
  }
  return rows;
}

// ── 性能批 P1:用量账缓存 ────────────────────────────────────────────────────────────────────────
// 修前每个读者(看板、预算、任务卡用量、管家熔断/仲裁/用量工具)每次都 readUsageRows:把所有月份整份读出、逐行
// JSON.parse。每跑一轮对话 13e 就打一次 usage 脏页,下一次看板读因此整读一遍账 —— 2000 会话 / 30 万行(70 MB)时
// 单这一步 1.5 s,而且大半是同步解析,SSE 流跟着顿。
// 这里把解析结果按月份文件常驻成列(定长数组 + 值字典),文件只长不改时只解析新增的尾巴:
//   · 判据:stat 的 size/mtime 没变 → 原样复用;同一个文件(ino 没变)、【变长了】、且上次已解析部分末尾那 ≤256 字节
//     (约一整行,含毫秒级 ts)原样还在 → 只读新增部分;其余一切(截短、同尺寸改写、换文件、核对不上)这一个月整份重读。
//     只提交到最后一个换行,没写完的那半行每次按原逻辑现解析、不入列。程序自己对账只追加(appendUsageLedger /
//     flushUsageLedgerSync);外部编辑里只有「在中间改、同时又变长、末尾 256 字节恰好没动」这一种查不出,要等进程重启
//     (缓存只在内存里)。
//   · 对外只有 forEachUsageRow(lowerMs, fn):次序(readdir 次序的月份文件 → 文件内行序)、过滤(月份键 + ts 下界 +
//     坏行/坏 ts 跳过)与 readUsageRows 逐条相同,调用方原来的累加代码一字不改,浮点累加次序因此也不变。
//   · fn 拿到的是【复用的】视图对象:只许在回调里读,不许留引用。数值列存的是 Number(原值)(六个消费方本来就先
//     Number() 再用),字符串类字段原值入字典(连类型一起保真:typeof 判断照旧),costTrusted 只在原值 === false
//     时为 false,estimated 只在原值 === true 时为 true —— 与消费方的判据一一对应。多出一个 tsMs(= Date.parse(ts))。
//   · RUYI_USAGE_CACHE=0 退回修前的整读路径(逃生口,也是 unit/usage-ledger-cache 差分测试的对照组)。
const USAGE_CACHE_CHECK_BYTES = 256;
const USAGE_CACHE_YIELD_LINES = 4000;   // 整月首次解析时每这么多行让一次事件循环(70 MB 的账不再一口气占住主线程)
const USAGE_CACHE_ROW_BYTES = 8 * 5 + 1 + 4 * 7;   // 五个 Float64 列 + 标志位 + 七个字典号
const usageLedgerCache = {
  months: new Map(),            // 月份文件名 -> { size, mtimeMs, committed, check, cols, tail }
  dict: [], dictIndex: new Map(), dictObjectIndex: new Map(),
  chain: Promise.resolve(),
  stats: { refreshes: 0, fullParses: 0, incrementalParses: 0, bytesParsed: 0 },
};
function usageLedgerCacheDisabled() { return process.env.RUYI_USAGE_CACHE === '0'; }
// 对象 / 数组值(只可能来自外部写坏的行)按内容去重:原样交给消费方的是同内容的第一份实例 —— typeof、String()
// 的结果都不变,而按引用去重会让每一行都在字典里新占一格、永不回收。
function usageDictId(value) {
  if (value !== null && typeof value === 'object') {
    let key = '';
    try { key = JSON.stringify(value); } catch { key = '?'; }
    let id = usageLedgerCache.dictObjectIndex.get(key);
    if (id === undefined) { id = usageLedgerCache.dict.length; usageLedgerCache.dict.push(value); usageLedgerCache.dictObjectIndex.set(key, id); }
    return id;
  }
  let id = usageLedgerCache.dictIndex.get(value);
  if (id === undefined) { id = usageLedgerCache.dict.length; usageLedgerCache.dict.push(value); usageLedgerCache.dictIndex.set(value, id); }
  return id;
}
const USAGE_DICT_COLUMNS = ['sessionId', 'engine', 'provider', 'model', 'currency', 'kind', 'note'];
function usageColumns(capacity) {
  const cap = Math.max(4, capacity | 0);
  const cols = { n: 0, cap, tsMs: new Float64Array(cap), inTok: new Float64Array(cap), outTok: new Float64Array(cap), cachedInTok: new Float64Array(cap), cost: new Float64Array(cap), flags: new Uint8Array(cap), tsRaw: new Map() };
  for (const key of USAGE_DICT_COLUMNS) cols[key] = new Uint32Array(cap);
  return cols;
}
function usageColumnsGrow(cols) {
  // 小列倍增;大列(整月解析完收紧过的)每次只多留 1/8 —— 一个月几万行,追加一行就翻倍太浪费
  const cap = cols.cap < 4096 ? cols.cap * 2 : cols.cap + (cols.cap >> 3);
  for (const key of ['tsMs', 'inTok', 'outTok', 'cachedInTok', 'cost', 'flags', ...USAGE_DICT_COLUMNS]) {
    const next = new cols[key].constructor(cap); next.set(cols[key]); cols[key] = next;
  }
  cols.cap = cap;
}
// ts 原串是不是 toISOString 的规范写法(是的话不必另存,用 tsMs 就能原样还原)。逐行 new Date().toISOString() 太贵,
// 按形状判:24 位、各分隔符在位、全是数字、小时不是 24(V8 把 24 点进位到次日);日期部分合不合法(2 月 30 日之类
// V8 也会进位)按「上一行的那一天」缓存,同一天只真算一次。判不准的情形一律当非规范、另存原串 —— 只多占点内存,不会错。
const usageTsDateMemo = { date: '', ok: false };
function usageTsIsCanonical(ts) {
  if (typeof ts !== 'string' || ts.length !== 24) return false;
  if (ts.charCodeAt(4) !== 45 || ts.charCodeAt(7) !== 45 || ts.charCodeAt(10) !== 84 || ts.charCodeAt(13) !== 58
    || ts.charCodeAt(16) !== 58 || ts.charCodeAt(19) !== 46 || ts.charCodeAt(23) !== 90) return false;
  for (const k of [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22]) { const c = ts.charCodeAt(k); if (c < 48 || c > 57) return false; }
  if (ts.charCodeAt(11) === 50 && ts.charCodeAt(12) === 52) return false;   // 24 点
  if (!ts.startsWith(usageTsDateMemo.date) || usageTsDateMemo.date === '') {
    const date = ts.slice(0, 10);
    const probe = date + 'T00:00:00.000Z';
    const t = Date.parse(probe);
    usageTsDateMemo.date = date;
    usageTsDateMemo.ok = Number.isFinite(t) && new Date(t).toISOString() === probe;
  }
  return usageTsDateMemo.ok;
}
// 字典号:相邻行的会话/引擎/模型多半相同,每列记住上一个值,命中就不查 Map。
function usageColumnsDictMemo() {
  return { sessionId: [NaN, 0], engine: [NaN, 0], provider: [NaN, 0], model: [NaN, 0], currency: [NaN, 0], kind: [NaN, 0], note: [NaN, 0] };
}
function usageDictIdMemo(memo, value) {
  if (memo[0] === value) return memo[1];   // NaN 初值永不相等;JSON 里也出不来 NaN
  const id = usageDictId(value);
  memo[0] = value; memo[1] = id;
  return id;
}
// 一行 → 列。与 readUsageRows 的逐行判据相同:空白行、解析不出对象、ts 解析不出有限数的行都跳过。
function usageColumnsPushLine(cols, line) {
  if (!line.trim()) return false;
  const rec = safeJsonParse(line, null);
  if (!rec || typeof rec !== 'object') return false;
  const t = Date.parse(rec.ts);
  if (!Number.isFinite(t)) return false;
  if (cols.n === cols.cap) usageColumnsGrow(cols);
  const i = cols.n++;
  cols.tsMs[i] = t;
  // ts 原串只在它不是 toISOString 的规范写法时才另存(byModel.lastAt 要原样回显那一行的 ts)
  if (!usageTsIsCanonical(rec.ts)) cols.tsRaw.set(i, rec.ts);
  cols.inTok[i] = Number(rec.inTok); cols.outTok[i] = Number(rec.outTok); cols.cachedInTok[i] = Number(rec.cachedInTok); cols.cost[i] = Number(rec.cost);
  cols.flags[i] = (rec.costTrusted === false ? 1 : 0) | (rec.estimated === true ? 2 : 0);
  const memo = cols.dictMemo || (cols.dictMemo = usageColumnsDictMemo());
  cols.sessionId[i] = usageDictIdMemo(memo.sessionId, rec.sessionId);
  cols.engine[i] = usageDictIdMemo(memo.engine, rec.engine);
  cols.provider[i] = usageDictIdMemo(memo.provider, rec.provider);
  cols.model[i] = usageDictIdMemo(memo.model, rec.model);
  cols.currency[i] = usageDictIdMemo(memo.currency, rec.currency);
  cols.kind[i] = usageDictIdMemo(memo.kind, rec.kind);
  cols.note[i] = usageDictIdMemo(memo.note, rec.note);
  return true;
}
// 解析一段文本进 cols。yieldBetween 时每 USAGE_CACHE_YIELD_LINES 行让一次事件循环(只用于还没发布出去的新列)。
async function usageColumnsParseText(cols, text, yieldBetween) {
  const lines = text.split('\n');
  for (let k = 0; k < lines.length; k++) {
    let line = lines[k];
    if (line.endsWith('\r')) line = line.slice(0, -1);
    usageColumnsPushLine(cols, line);
    if (yieldBetween && k % USAGE_CACHE_YIELD_LINES === USAGE_CACHE_YIELD_LINES - 1) await new Promise(resolve => setImmediate(resolve));
  }
}
// 整月解析完把列收紧到实际行数(首次解析按字节估的容量会多出两成)。之后追加仍按倍增长。
function usageColumnsShrink(cols) {
  const cap = Math.max(4, cols.n);
  if (cap >= cols.cap) return cols;
  for (const key of ['tsMs', 'inTok', 'outTok', 'cachedInTok', 'cost', 'flags', ...USAGE_DICT_COLUMNS]) cols[key] = cols[key].slice(0, cap);
  cols.cap = cap;
  return cols;
}
function usageColumnsAppend(dst, src) {
  for (let j = 0; j < src.n; j++) {
    if (dst.n === dst.cap) usageColumnsGrow(dst);
    const i = dst.n++;
    for (const key of ['tsMs', 'inTok', 'outTok', 'cachedInTok', 'cost', 'flags', ...USAGE_DICT_COLUMNS]) dst[key][i] = src[key][j];
    if (src.tsRaw.has(j)) dst.tsRaw.set(i, src.tsRaw.get(j));
  }
}
// buf 的 [0, lastNL] 是完整行、之后是没写完的尾巴(不入列,每次随条目现解析一份)。
// 0x0A 不会出现在 UTF-8 多字节序列内部,在它上面切不会劈开字符,逐段解码与整份解码结果相同。
function usageSplitComplete(buf) {
  const lastNl = buf.lastIndexOf(0x0a);
  const complete = lastNl >= 0 ? buf.subarray(0, lastNl + 1) : buf.subarray(0, 0);
  return { complete, rest: buf.subarray(complete.length) };
}
function usageNextCheck(previous, complete) {
  const take = complete.subarray(Math.max(0, complete.length - USAGE_CACHE_CHECK_BYTES));   // 只拷末尾,不把整块拼一遍
  const source = take.length >= USAGE_CACHE_CHECK_BYTES ? take : Buffer.concat([previous, take]);
  return Buffer.from(source.subarray(Math.max(0, source.length - USAGE_CACHE_CHECK_BYTES)));
}
async function usageParseTail(rest) {
  if (!rest.length) return null;
  const tail = usageColumns(4);
  await usageColumnsParseText(tail, rest.toString('utf8'), false);
  return tail;
}
async function usageMonthFullParse(file, st) {
  const buf = await fsp.readFile(file);
  const { complete, rest } = usageSplitComplete(buf);
  const cols = usageColumns(Math.ceil(complete.length / 200) + 16);
  // 新列还没发布(不在 months 里),分片让出期间别的读者看到的仍是旧条目。
  if (complete.length) await usageColumnsParseText(cols, complete.toString('utf8'), true);
  usageColumnsShrink(cols);
  usageLedgerCache.stats.fullParses += 1;
  usageLedgerCache.stats.bytesParsed += buf.length;
  return { size: buf.length, mtimeMs: st.mtimeMs, ino: st.ino, committed: complete.length, check: usageNextCheck(Buffer.alloc(0), complete), cols, tail: await usageParseTail(rest) };
}
// 读 [committed - check.length, size):先核对旧末尾那几个字节还在原位,再吞新增部分。核不上就返回 null(调用方整月重读)。
// 新增行先解析进临时列;并进共享列与换上新条目由调用方在同一个同步段里做 —— 别的读者看不到「行已入列、旧尾巴
// 还挂着」那种半截状态(那会把同一行数两遍)。
async function usageMonthIncremental(file, entry, st) {
  const start = entry.committed - entry.check.length;
  const length = st.size - start;
  const fh = await fsp.open(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    if (bytesRead !== length) return null;
  } finally { await fh.close(); }
  if (!buf.subarray(0, entry.check.length).equals(entry.check)) return null;
  const { complete, rest } = usageSplitComplete(buf.subarray(entry.check.length));
  const fresh = usageColumns(16);
  if (complete.length) await usageColumnsParseText(fresh, complete.toString('utf8'), false);
  const tail = await usageParseTail(rest);
  const parsedBytes = buf.length - entry.check.length;
  // 返回提交函数:由调用方在【同一个同步段】里并列 + 换条目。
  return () => {
    usageColumnsAppend(entry.cols, fresh);
    usageLedgerCache.stats.incrementalParses += 1;
    usageLedgerCache.stats.bytesParsed += parsedBytes;
    return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, committed: entry.committed + complete.length, check: usageNextCheck(entry.check, complete), cols: entry.cols, tail };
  };
}
async function refreshUsageLedgerCacheNow() {
  usageLedgerCache.stats.refreshes += 1;
  let files = [];
  try { files = await fsp.readdir(paths.usage); } catch { usageLedgerCache.months.clear(); return []; }
  const order = files.filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();   // 与 readUsageRows 同一次序
  const present = new Set(order);
  for (const name of [...usageLedgerCache.months.keys()]) if (!present.has(name)) usageLedgerCache.months.delete(name);
  for (const name of order) {
    const file = path.join(paths.usage, name);
    try {
      const st = await fsp.stat(file);
      const entry = usageLedgerCache.months.get(name);
      if (entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs) continue;
      // 同尺寸只换了 mtime = 原地改写(追加一定变长)→ 整月重读
      const commit = entry && st.ino === entry.ino && st.size > entry.size && st.size >= entry.committed ? await usageMonthIncremental(file, entry, st).catch(() => null) : null;
      if (commit) usageLedgerCache.months.set(name, commit());
      else usageLedgerCache.months.set(name, await usageMonthFullParse(file, st));
    } catch { usageLedgerCache.months.delete(name); }   // 读不了的月份与修前一样当它不存在
  }
  return order;
}
// 刷新串行:每个调用拿到的都是【它发起之后】才开始的那一次刷新 —— 刚写进账的行对下一个读者一定可见。
function refreshUsageLedgerCache() {
  const run = usageLedgerCache.chain.then(refreshUsageLedgerCacheNow, refreshUsageLedgerCacheNow);
  usageLedgerCache.chain = run.catch(() => []);
  return run;
}
// opts.sessionIds(可选,Set<string>):只遍历这些会话的行 —— 次序与全量遍历里筛出来的一样,聚合结果逐位相同;
// 列里先比字典号,不命中的行连视图都不填(每轮对话后只刷那几条会话的用量时,30 万行的账只花几毫秒)。
async function forEachUsageRow(lowerMs, fn, opts = {}) {
  const onlySessions = opts && opts.sessionIds instanceof Set ? opts.sessionIds : null;
  if (usageLedgerCacheDisabled()) {
    for (const rec of await readUsageRows(lowerMs)) {
      if (onlySessions && !onlySessions.has(rec.sessionId)) continue;
      rec.tsMs = Date.parse(rec.ts); rec.tsRaw = rec.ts; fn(rec);
    }
    return;
  }
  // 读账失败与修前 readUsageRows 同口径:当空账(不抛)。回调里抛的错照旧往外冒。
  let order = [];
  try { order = await refreshUsageLedgerCache(); } catch { return; }
  const lowerKey = lowerMs > 0 ? new Date(lowerMs).toISOString().slice(0, 7) : '';
  const dict = usageLedgerCache.dict;
  let wantIds = null;
  if (onlySessions) {
    wantIds = new Set();
    for (const sid of onlySessions) { const id = usageLedgerCache.dictIndex.get(sid); if (id !== undefined) wantIds.add(id); }
    if (!wantIds.size) return;
  }
  const view = new UsageRowView();
  const visit = c => {
    const rawTs = c.tsRaw.size ? c.tsRaw : null;
    for (let i = 0; i < c.n; i++) {
      if (wantIds && !wantIds.has(c.sessionId[i])) continue;
      const t = c.tsMs[i];
      if (lowerMs > 0 && t < lowerMs) continue;
      const flags = c.flags[i];
      view.tsMs = t; view.tsRaw = rawTs ? rawTs.get(i) : undefined;
      view.inTok = c.inTok[i]; view.outTok = c.outTok[i]; view.cachedInTok = c.cachedInTok[i]; view.cost = c.cost[i];
      view.costTrusted = (flags & 1) === 0; view.estimated = (flags & 2) !== 0;
      view.sessionId = dict[c.sessionId[i]]; view.engine = dict[c.engine[i]]; view.provider = dict[c.provider[i]]; view.model = dict[c.model[i]];
      view.currency = dict[c.currency[i]]; view.kind = dict[c.kind[i]]; view.note = dict[c.note[i]];
      fn(view);
    }
  };
  for (const name of order) {
    if (lowerKey && name.slice(0, 7) < lowerKey) continue;
    const entry = usageLedgerCache.months.get(name);
    if (!entry) continue;
    visit(entry.cols);
    if (entry.tail) visit(entry.tail);
  }
}
// 视图:字段在构造时一次定形(defineProperty 之后再挂字段会让 V8 把对象降成字典模式,每行十几次读写全变慢);
// ts 走原型上的 getter,按需拼规范串。tsRaw:只有原值不是 toISOString 规范写法时才有值(回退路径下恒为原值)——
// 需要原样回显 ts 的地方(看板 byModel.lastAt)用 tsRaw ?? 规范串,免得每行都拼一次串。
class UsageRowView {
  constructor() {
    this.tsMs = 0; this.tsRaw = undefined;
    this.inTok = 0; this.outTok = 0; this.cachedInTok = 0; this.cost = 0;
    this.costTrusted = true; this.estimated = false;
    this.sessionId = undefined; this.engine = undefined; this.provider = undefined; this.model = undefined;
    this.currency = undefined; this.kind = undefined; this.note = undefined;
  }
  get ts() { return this.tsRaw !== undefined ? this.tsRaw : new Date(this.tsMs).toISOString(); }
}
function usageLedgerCacheStats() {
  let rows = 0, residentBytes = 0;
  for (const entry of usageLedgerCache.months.values()) { rows += entry.cols.n; residentBytes += entry.cols.cap * USAGE_CACHE_ROW_BYTES; }
  return { ...usageLedgerCache.stats, months: usageLedgerCache.months.size, rows, residentBytes, dictSize: usageLedgerCache.dict.length };
}
// Aggregate the ledger for a range into the /api/usage/summary shape. costsByCurrency holds ONLY trusted,
// non-plan-based costs; planBasedTurns counts turns whose cost is plan-based/notional (surfaced separately).
// Dimensions: engine / provider / session / day / model (117x-M1 added byModel; see its comment in the loop).
async function buildUsageSummary(range) {
  const config = await readConfig().catch(() => ({}));
  const now = Date.now();
  // provider/source id -> display label (native providers + Claude direct + known Claude endpoints).
  const labels = new Map([['claude-cli', 'Claude CLI (Anthropic)']]);
  for (const p of (Array.isArray(config.providers) ? config.providers : [])) if (p && p.id) labels.set(String(p.id), String(p.label || p.id));
  for (const p of CLAUDE_ENDPOINT_PRESETS) if (p && p.id) labels.set(String(p.id), String(p.label || p.id));
  // session id -> title from the lightweight metadata index (no full-session scan).
  const titles = new Map();
  // 128f-⑧(Brief §4.2 第 22 条后半):修前直读盘上索引 —— 索引写是去抖 ~200 ms 的,刚改名的会话在这一窗里还是旧标题。
  // 与 listSessions 同一个叠法:盘上 → 在飞 → 排队(新的在后,墓碑删掉)。
  try {
    const idx = await readSessionIndex();
    const merged = overlayUnflushedSessionIndex(new Map((Array.isArray(idx) ? idx : []).filter(e => e && e.id).map(e => [String(e.id), e])));
    for (const [id, e] of merged) titles.set(String(id), (e && e.title) || '');
  } catch { /* index optional */ }

  const addCost = (bucket, cur, cost) => { bucket[cur] = (bucket[cur] || 0) + cost; };
  const totals = { inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, subagentTurns: 0, auxCalls: 0, estimatedTurns: 0, planBasedTurns: 0, costsByCurrency: {} };
  const byEngine = new Map(), byProvider = new Map(), bySession = new Map(), byDay = new Map(), byModel = new Map();
  const dayKeyOf = usageDayKeyMemo();
  const modelKeys = new Map();   // eng -> pid -> mid -> JSON 键(每个三元组只 stringify 一次)
  const modelKeyOf = (eng, pid, mid) => {
    let byPid = modelKeys.get(eng); if (!byPid) modelKeys.set(eng, byPid = new Map());
    let byMid = byPid.get(pid); if (!byMid) byPid.set(pid, byMid = new Map());
    let key = byMid.get(mid); if (key === undefined) byMid.set(mid, key = JSON.stringify([eng, pid, mid]));
    return key;
  };

  await forEachUsageRow(usageRangeLowerMs(range, now), r => {
    const inTok = Number(r.inTok) || 0, outTok = Number(r.outTok) || 0, cachedInTok = Math.min(inTok, Number(r.cachedInTok) || 0);
    const cost = Number(r.cost), cur = (typeof r.currency === 'string' && r.currency) ? r.currency : null;
    const trusted = r.costTrusted !== false;
    const hasCost = trusted && cur && Number.isFinite(cost);
    totals.inTok += inTok; totals.outTok += outTok; totals.cachedInTok += cachedInTok; totals.turns += 1;
    if (r.kind === 'subagent') totals.subagentTurns += 1; // v1.4-OSS 用量看板(补): DAG/子代理回合独立计数
    if (r.kind === 'aux') totals.auxCalls += 1; // v1.4-OSS 用量看板(补): 辅助调用(压缩/起草等)独立计数
    if (r.estimated === true) totals.estimatedTurns += 1;
    if (!trusted) totals.planBasedTurns += 1;
    if (hasCost) addCost(totals.costsByCurrency, cur, cost);
    const eng = r.engine === 'claude' ? 'claude' : 'openai';
    let em = byEngine.get(eng); if (!em) byEngine.set(eng, em = { engine: eng, inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, planBasedTurns: 0, costsByCurrency: {} });
    em.inTok += inTok; em.outTok += outTok; em.cachedInTok += cachedInTok; em.turns += 1; if (!trusted) em.planBasedTurns += 1; if (hasCost) addCost(em.costsByCurrency, cur, cost);
    const pid = String(r.provider || '');
    let pm = byProvider.get(pid); if (!pm) byProvider.set(pid, pm = { provider: pid, label: labels.get(pid) || pid, inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, planBasedTurns: 0, costsByCurrency: {} });
    pm.inTok += inTok; pm.outTok += outTok; pm.cachedInTok += cachedInTok; pm.turns += 1; if (!trusted) pm.planBasedTurns += 1; if (hasCost) addCost(pm.costsByCurrency, cur, cost);
    const sid = String(r.sessionId || '');
    let sm = bySession.get(sid); if (!sm) bySession.set(sid, sm = { sessionId: sid, title: titles.get(sid) || '', inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, planBasedTurns: 0, costsByCurrency: {} });
    sm.inTok += inTok; sm.outTok += outTok; sm.cachedInTok += cachedInTok; sm.turns += 1; if (!trusted) sm.planBasedTurns += 1; if (hasCost) addCost(sm.costsByCurrency, cur, cost);
    const tsMs = r.tsMs;
    const dk = dayKeyOf(tsMs);
    let dm = byDay.get(dk); if (!dm) byDay.set(dk, dm = { date: dk, inTok: 0, outTok: 0, cachedInTok: 0, costsByCurrency: {} });
    dm.inTok += inTok; dm.outTok += outTok; dm.cachedInTok += cachedInTok; if (hasCost) addCost(dm.costsByCurrency, cur, cost);
    // 117x-M1: byModel. Keyed by the (engine, provider, model) TRIPLE, not by model id alone: the same id can be
    // served by two providers, and collapsing them would force us to invent one provider/engine for the entry.
    // Rows whose `model` is empty are SKIPPED entirely (NOT bucketed into a "未记录模型" group): byModel exists to
    // drive the model selector's 常用置顶/副行, and an entry with no id can neither be selected nor pinned — 设计页
    // §11.17.7 ④ spells it out: 「把 model 字段删掉 -> 该条不进 byModel 而不是记成空串」. Consequence (and the
    // invariant its lock pins): sum(byModel.turns) === sum(byEngine.turns) - (rows carrying an empty model).
    // Everything else reuses the exact same 口径 as the four dimensions above (addCost/roundB/finishGroup), so a
    // model entry's planBased flag and costsByCurrency mean precisely what a provider entry's do.
    const mid = String(r.model || '');
    if (mid) {
      const mk = modelKeyOf(eng, pid, mid); // JSON-array key: unambiguous whatever characters an id carries
      let mm = byModel.get(mk);
      if (!mm) byModel.set(mk, mm = { model: mid, provider: pid, label: labels.get(pid) || pid, engine: eng, inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, planBasedTurns: 0, costsByCurrency: {}, lastAt: '', lastMs: 0, lastTsRaw: undefined });
      mm.inTok += inTok; mm.outTok += outTok; mm.cachedInTok += cachedInTok; mm.turns += 1; if (!trusted) mm.planBasedTurns += 1; if (hasCost) addCost(mm.costsByCurrency, cur, cost);
      // lastAt = the ts of this group's MOST RECENT ledger row, kept as that row's own ISO string so it reads
      // exactly like the `ts` on the line it came from (设计页 §11.17.2「常用」按最近一次使用时间排序). A row whose
      // ts does not parse is ignored FOR lastAt ONLY — it still counts in this entry's tokens/turns — so lastAt can
      // never become 'Invalid Date'/NaN; a group with no parseable ts at all keeps the empty string. (readUsageRows
      // already drops unparseable-ts rows before we get here, so this is defence in depth, not a live path.)
      // 性能批 P1:只记最大时刻与那一行的原串(没有原串 = 规范写法),收尾再成串 —— 与逐行 String(r.ts) 结果相同。
      if (Number.isFinite(tsMs) && tsMs > mm.lastMs) { mm.lastMs = tsMs; mm.lastTsRaw = r.tsRaw; }
    }
  });
  // Round every currency bucket to 6 dp to shed binary-float noise (0.30000000000000004 -> 0.3), and derive a
  // per-entry planBased flag: true ONLY when the entry has plan-based turns AND no trusted cost to show (so a
  // mixed entry that still has a real cost keeps showing it, and the front-end can honestly badge 计划内计费).
  const round6 = n => Math.round((Number(n) || 0) * 1e6) / 1e6;
  const roundB = b => { for (const k of Object.keys(b)) b[k] = round6(b[k]); return b; };
  const finishGroup = m => { roundB(m.costsByCurrency); m.planBased = m.planBasedTurns > 0 && Object.keys(m.costsByCurrency).length === 0; };
  roundB(totals.costsByCurrency);
  for (const m of byEngine.values()) finishGroup(m);
  for (const m of byProvider.values()) finishGroup(m);
  for (const m of bySession.values()) finishGroup(m);
  for (const m of byModel.values()) finishGroup(m); // same 口径 as the three groups above, deliberately not a second one
  for (const m of byDay.values()) roundB(m.costsByCurrency);

  // Budget: CURRENT local month's TRUSTED spend in the budget currency (independent of `range`).
  let budget = null;
  const ub = config.usageBudget;
  if (ub && typeof ub === 'object' && Number(ub.monthly) > 0 && typeof ub.currency === 'string' && ub.currency) {
    let spent = 0;
    await forEachUsageRow(usageRangeLowerMs('month', now), r => { const c = Number(r.cost); if (r.costTrusted !== false && r.currency === ub.currency && Number.isFinite(c)) spent += c; });
    budget = { monthly: Number(ub.monthly), currency: ub.currency, spentThisMonth: round6(spent) };
  }
  return {
    ok: true, range, totals,
    byEngine: [...byEngine.values()],
    byProvider: [...byProvider.values()],
    // 117x-M1: most-recently-used first (lastAt desc), then busier first, then model id — a total order, so the
    // payload never silently depends on Map insertion order. NOT sliced, unlike bySession: the selector shows a
    // 「上次用 · 共 M 回合」副行 for EVERY model it lists, and a slice would both starve that副行 and break the
    // sum(byModel.turns) === sum(byEngine.turns) - empty-model-rows invariant. lastMs is scratch, stripped here.
    byModel: [...byModel.values()]
      .sort((a, b) => (b.lastMs - a.lastMs) || (b.turns - a.turns) || (a.model < b.model ? -1 : (a.model > b.model ? 1 : 0)))
      .map(({ lastMs, lastTsRaw, ...rest }) => ({ ...rest, lastAt: lastMs > 0 ? String(lastTsRaw !== undefined ? lastTsRaw : new Date(lastMs).toISOString()) : rest.lastAt })),
    bySession: [...bySession.values()].sort((a, b) => (b.inTok + b.outTok) - (a.inTok + a.outTok)).slice(0, 20),
    byDay: [...byDay.values()].sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)),
    budget,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 第 121 波 K2a(34 号文 §6.1;27 号文 `:20` 预告的那一步):进程内事件总线。
//
// 为什么住在 00-boot:它的订阅者(13r-event-stream.js)排在最后,而生产者散落在 02/04/05/09/13i/13q
// —— 总线必须比【所有】生产者都早,生产者才只需要一条后向引用。00-boot 是全仓第一个模块,且每一个
// 生产者所在模块对它的依赖边【本来就存在】(见 docs/architecture/module-dependency-graph.json),
// 所以这一步一条新边都不加,forwardEdges 不动。
//
// 三条纪律:
//   ① 零订阅者时 emit 是 no-op,且【永不抛】—— 观察面绝不反噬写路径(同 logEvent 的口径);
//   ② 订阅者自己抛的异常就地吞掉并继续派给下一个,一个坏订阅者不许拖垮生产者;
//   ③ 总线【不落盘、不持久化、不跨进程】。它只是「谁写了什么」到「谁想知道」之间的一条线,
//      重启即空;任何需要重启后还在的事实都必须另有落盘的权威源(会话头/NDJSON)。
const RUYI_EVENT_SUBSCRIBERS = new Set();
const RUYI_EVENTS = {
  // 返回退订函数(约定同 DOM/Node 的 off 语义:重复退订无副作用)。
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    RUYI_EVENT_SUBSCRIBERS.add(fn);
    return () => { RUYI_EVENT_SUBSCRIBERS.delete(fn); };
  },
  emit(name, payload) {
    if (!RUYI_EVENT_SUBSCRIBERS.size) return;           // 纪律①:零订阅者 = 零开销
    for (const fn of RUYI_EVENT_SUBSCRIBERS) {
      try { fn(String(name || ''), payload); } catch { /* 纪律②:订阅者的错不许回流到写路径 */ }
    }
  },
  subscriberCount() { return RUYI_EVENT_SUBSCRIBERS.size; },
};
// 事件流模块(13r-event-stream.js)的延迟绑定命名空间 —— 先例是 06i 的 StewardHooks 与 06c 的
// AgentLoopHooks。13-http-router.js 排在 13r 【之前】,直接写 handleEventStreamRoutes 会是一条
// 新前向边;它只写 `EventStreamHooks.handleApiRoutes`(13 → 00-boot 是既有后向边),13r 加载时
// Object.assign 填充实现。未填充(理论上不可能)时那一行是无操作。
const EventStreamHooks = {};

// ── 迁移中心(56 号文 §3,W2):其它 Agent CLI 的家目录 + 如意包根判定 + 安装登记表 ─────────────────
// 迁移中心的实现住在 13u-migration-center.js(零入边);13b 的路由经这张表迟绑定调进去(13b → 00-boot 是
// 既有后向边),与 EventStreamHooks 同款。未填充时路由回 503,不会误走别的分支。
const MigrationHooks = {};

// 其它 Agent CLI 的用户级目录。一律在【调用时】按 os.homedir() 与各家的覆盖变量解析(不缓存):测试把
// USERPROFILE/HOME 指到临时家,这里立刻跟着走 —— 这就是「测试绝不碰真机家目录」的那一道闸。
//   Claude Code:~/.claude 与 ~/.claude.json;Codex:$CODEX_HOME,缺省 ~/.codex;
//   Kimi Code:$KIMI_CODE_HOME,缺省 ~/.kimi-code(与 syncMcpServersToKimi 同一口径);Gemini CLI:~/.gemini。
function agentCliHomes() {
  const home = os.homedir();
  return {
    home,
    claude: path.join(home, '.claude'),
    claudeJson: path.join(home, '.claude.json'),
    codex: String(process.env.CODEX_HOME || '').trim() || path.join(home, '.codex'),
    kimi: String(process.env.KIMI_CODE_HOME || '').trim() || path.join(home, '.kimi-code'),
    gemini: path.join(home, '.gemini'),
  };
}

// 给人看的路径:家目录前缀写成 ~(只影响显示,不参与任何判定)。
function tildePath(p) {
  const s = String(p || '');
  const home = os.homedir();
  if (!home || !s) return s;
  const a = process.platform === 'win32' ? s.toLowerCase() : s;
  const h = process.platform === 'win32' ? home.toLowerCase() : home;
  if (a === h) return '~';
  if (a.startsWith(h) && (s[home.length] === '\\' || s[home.length] === '/')) return '~' + s.slice(home.length).replace(/\\/g, '/');
  return s;
}

// 路径比较键:resolve + 去尾分隔符;Windows 下大小写不敏感。
function samePathKey(p) {
  let s = path.resolve(String(p || ''));
  if (process.platform === 'win32') s = s.toLowerCase();
  return s.length > 3 ? s.replace(/[\\/]+$/, '') : s;
}

// 如意包根标记:<root>/app/server.js 是文件,且 <root>/package.json 的 name 是 ruyi-workbench 或
// <root>/Start-Workbench.cmd 在。两条都要:只有 app/server.js 的目录可能是别的 Node 项目。
// 返回 { root, version } 或 null。只读、从不抛。
function ruyiPackageInfo(dir) {
  try {
    const root = path.resolve(String(dir || ''));
    if (!fs.statSync(path.join(root, 'app', 'server.js')).isFile()) return null;
    let named = false; let version = '';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      named = Boolean(pkg && pkg.name === 'ruyi-workbench');
      if (pkg && typeof pkg.version === 'string') version = pkg.version.slice(0, 40);
    } catch { /* 没有或坏的 package.json:只能靠启动脚本认 */ }
    if (!named && !fs.existsSync(path.join(root, 'Start-Workbench.cmd'))) return null;
    return { root, version };
  } catch { return null; }
}

// 从一个绝对路径沿祖先链往上找【最近】的如意包根(最多 12 层)。不全盘扫描、不列举任何目录。
// 最近优先:源码树 ruyi-workbench/ 下的 dist/Ruyi-vX 是另一个包,应认成 dist/Ruyi-vX 而不是外层。
// cache(可选 Map)按目录键记忆结果,一次扫描里同一棵树只 stat 一遍。
function findRuyiPackageRootFor(p, cache) {
  const raw = String(p || '').trim();
  if (!raw || !path.isAbsolute(raw)) return null;
  let dir = path.resolve(raw);
  const seen = [];
  for (let i = 0; i < 12; i++) {
    const key = samePathKey(dir);
    if (cache && cache.has(key)) { const hit = cache.get(key); for (const k of seen) cache.set(k, hit); return hit; }
    seen.push(key);
    const info = ruyiPackageInfo(dir);
    if (info) { if (cache) for (const k of seen) cache.set(k, info); return info; }
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  if (cache) for (const k of seen) cache.set(k, null);
  return null;
}

// 安装登记表 <data>/install-registry.json:每个启动过的包一行
//   { packageRoot, version, launchMode, firstSeenAt, lastLaunchedAt, pid }
// 所有包共用同一个数据根(dataRoot()),所以「本机都有哪些包启动过」只能记在这里。只记账、不做决定。
const INSTALL_REGISTRY_SCHEMA = 1;
const INSTALL_REGISTRY_MAX = 64;
function installRegistryPath() { return path.join(paths.data, 'install-registry.json'); }
function readInstallRegistry() {
  try {
    const raw = safeJsonParse(fs.readFileSync(installRegistryPath(), 'utf8'), null);
    const rows = raw && Array.isArray(raw.packages) ? raw.packages : [];
    const packages = [];
    const seen = new Set();
    for (const r of rows) {
      if (!r || typeof r.packageRoot !== 'string' || !path.isAbsolute(r.packageRoot)) continue;
      const key = samePathKey(r.packageRoot);
      if (seen.has(key)) continue;
      seen.add(key);
      packages.push({
        packageRoot: path.resolve(r.packageRoot),
        version: typeof r.version === 'string' ? r.version.slice(0, 40) : '',
        launchMode: typeof r.launchMode === 'string' ? r.launchMode.slice(0, 16) : '',
        firstSeenAt: typeof r.firstSeenAt === 'string' ? r.firstSeenAt.slice(0, 40) : '',
        lastLaunchedAt: typeof r.lastLaunchedAt === 'string' ? r.lastLaunchedAt.slice(0, 40) : '',
        pid: Number.isInteger(r.pid) && r.pid > 0 ? r.pid : 0,
      });
    }
    return { schema: INSTALL_REGISTRY_SCHEMA, packages };
  } catch { return { schema: INSTALL_REGISTRY_SCHEMA, packages: [] }; }
}
// 本包这次启动:登记(或刷新)一行。失败只吞掉 —— 登记表是旁路账,绝不挡启动。
async function recordInstallLaunch(launchMode) {
  try {
    const reg = readInstallRegistry();
    const root = path.resolve(externalRoot());
    const key = samePathKey(root);
    const now = nowIso();
    let row = reg.packages.find(r => samePathKey(r.packageRoot) === key);
    if (!row) { row = { packageRoot: root, firstSeenAt: now }; reg.packages.push(row); }
    row.version = VERSION;
    row.launchMode = String(launchMode || '').slice(0, 16);
    row.lastLaunchedAt = now;
    row.pid = process.pid;
    // 目录已不在的行顺手剔掉(老包被用户手动删了);按最近启动倒序,封顶。
    const packages = reg.packages
      .filter(r => samePathKey(r.packageRoot) === key || fs.existsSync(r.packageRoot))
      .sort((a, b) => String(b.lastLaunchedAt || '').localeCompare(String(a.lastLaunchedAt || '')))
      .slice(0, INSTALL_REGISTRY_MAX);
    await fsp.mkdir(paths.data, { recursive: true });
    await atomicWriteJson(installRegistryPath(), { schema: INSTALL_REGISTRY_SCHEMA, updatedAt: now, packages });
    return { ok: true, packageRoot: root };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}
