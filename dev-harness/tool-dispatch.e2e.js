(async () => {
// E2E (第41波 41b): 表驱动工具注册表的「guard 声明化」行为锁 + 分发行为直测。
// 不靠 grep 源码形状 —— 直接 require server.js 内省 TOOL_HANDLERS 注册表(模块拆分/重排后依然有效,
// 这正是 V2.0「静态锁行为化」的样板):
//   L1 每个条目:handler 是函数、paths 已声明(可为 null)、paths 取值合法。
//   L2 paths === null → 必须有非空 guardNote(「忘了声明」与「录在案的豁免」从结构上分开)。
//   L3 paths 非 null → handler 源必须含 guardFileToolPath(/guardDownloadDest( 调用 —— 触路径工具没护栏 = 锁红
//      (archive_zip 漏 guard[第27波]、desktop_screenshot 越界写[第36波] 这类漏审整类收口)。
//   L4 注册表键集 === NATIVE_TOOL_PACKS 键集(分发与目录漂移 = 锁红);每个键都有 tier 声明。
//   L5 edit/exec 级工具必须在注册表(tier 表覆盖不到的 exec/edit 工具 = nativeToolGate 盲区)。
//   B1 toolCall 未知工具 → throw「Unknown tool」(与旧 switch default 同形同文)。
//   B2 真实分发:glob 走表内 handler 成功返回;out-of-bounds file_read(远端 provider)被 guard 拒 —
//      证明 handler 里的 guard 不是摆设而是接在同一 ctx 上。
//   B3 第41波首擒:project_snapshot 补读闸后,远端 provider 越界列目录被拒(与 file_list 同闸)。
const path = require('path'), fs = require('fs'), os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const UNIT_DATA = path.join(os.tmpdir(), 'wcw-tool-dispatch-units');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

fs.rmSync(UNIT_DATA, { recursive: true, force: true }); fs.mkdirSync(UNIT_DATA, { recursive: true });
process.env.WIN_CLAUDE_WORKBENCH_HOME = UNIT_DATA;
const S = require(SERVER);

const REG = S.TOOL_HANDLERS, TIER = S.NATIVE_TOOL_TIER, PACKS = S.NATIVE_TOOL_PACKS;
const names = Object.keys(REG);

// ── L1/L2/L3: 逐条目声明纪律 ──
const PATHS_VALUES = new Set(['read', 'write', 'both', 'conditional']);
let l1Bad = [], l2Bad = [], l3Bad = [];
for (const n of names) {
  const e = REG[n];
  if (!e || typeof e.handler !== 'function' || !Object.prototype.hasOwnProperty.call(e, 'paths')
    || !(e.paths === null || PATHS_VALUES.has(e.paths))) l1Bad.push(n);
  if (e && e.paths === null && !(typeof e.guardNote === 'string' && e.guardNote.trim())) l2Bad.push(n);
  if (e && e.paths !== null) {
    const src = e.handler.toString();
    if (!/guardFileToolPath\(|guardDownloadDest\(/.test(src)) l3Bad.push(n);
  }
}
ok(names.length === 50, `L1 注册表 50 个工具(got ${names.length})`);
ok(l1Bad.length === 0, 'L1 每条目 handler/paths 声明齐整' + (l1Bad.length ? ' → ' + l1Bad.join(',') : ''));
ok(l2Bad.length === 0, 'L2 paths:null 条目全部带 guardNote(录在案豁免)' + (l2Bad.length ? ' → ' + l2Bad.join(',') : ''));
ok(l3Bad.length === 0, 'L3 paths 非 null 条目 handler 内全部含 guard 调用' + (l3Bad.length ? ' → ' + l3Bad.join(',') : ''));

// ── L4/L5: 表间一致性 ──
const packNames = Object.keys(PACKS);
const onlyReg = names.filter(n => !packNames.includes(n));
const onlyPack = packNames.filter(n => !names.includes(n));
ok(onlyReg.length === 0 && onlyPack.length === 0, 'L4 注册表键集 === NATIVE_TOOL_PACKS 键集' + ((onlyReg.length || onlyPack.length) ? ` → reg-only:${onlyReg} pack-only:${onlyPack}` : ''));
const noTier = names.filter(n => !Object.prototype.hasOwnProperty.call(TIER, n));
ok(noTier.length === 0, 'L4 每个注册工具都有 NATIVE_TOOL_TIER 声明' + (noTier.length ? ' → ' + noTier.join(',') : ''));
const tierOrphan = Object.keys(TIER).filter(n => !names.includes(n) && !['propose_task', 'send_to_agent'].includes(n));
ok(tierOrphan.length === 0, 'L5 tier 表无注册表外孤儿(propose_task/send_to_agent 走闭包特例,有意豁免)' + (tierOrphan.length ? ' → ' + tierOrphan.join(',') : ''));
const dangerous = names.filter(n => TIER[n] === 'edit' || TIER[n] === 'exec');
ok(dangerous.length > 0 && dangerous.every(n => REG[n]), 'L5 edit/exec 级工具全部在注册表(' + dangerous.length + ' 个)');

// ── B1: 未知工具 —— 与旧 switch default 同形同文 ──
let threw = '';
try { await S.toolCall('__no_such_tool__', {}); } catch (e) { threw = String((e && e.message) || e); }
ok(threw === 'Unknown tool: __no_such_tool__', 'B1 未知工具 throw「Unknown tool: __no_such_tool__」');

// ── B2/B3: 真实分发 + guard 接线 ──
const P = (base) => ({ providers: [{ id: 'p', type: 'openai-compat', baseUrl: base, apiKey: 'k', model: 'm' }], activeProvider: 'p' });
const WS = path.join(UNIT_DATA, 'ws'); fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(WS, 'a.js'), '// x');
const ctxRemote = { config: { ...P('https://api.deepseek.com'), defaultWorkspace: WS }, session: { cwd: WS } };
const OUTSIDE = path.join(os.tmpdir(), 'wcw-tool-dispatch-OUTSIDE');
fs.rmSync(OUTSIDE, { recursive: true, force: true }); fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'secret');

const g1 = await S.toolCall('glob', { root: WS, pattern: '*.js' }, ctxRemote);
ok(g1 && g1.ok === true && Array.isArray(g1.files) && g1.files.length === 1, 'B2 glob 经表驱动分发正常工作区内列举');
const g2 = await S.toolCall('file_read', { path: path.join(OUTSIDE, 'secret.txt') }, ctxRemote);
ok(g2 && g2.ok === false && g2.code === 'not-allowed', 'B2 远端 provider 越界 file_read 被 guard 拒(guard 接在同一 ctx)');
const g3 = await S.toolCall('project_snapshot', { root: OUTSIDE }, ctxRemote);
ok(g3 && g3.ok === false && g3.code === 'not-allowed', 'B3 第41波首擒:project_snapshot 越界列目录(远端)与 file_list 同闸拒');
const g4 = await S.toolCall('project_snapshot', { root: WS }, ctxRemote);
ok(g4 && g4.ok === true && Array.isArray(g4.files), 'B3 project_snapshot 工作区内照常可用');

console.log(fail ? `\nTOOL-DISPATCH E2E: ${fail} FAIL` : '\nTOOL-DISPATCH E2E: ALL PASS');
process.exit(fail ? 1 : 0);
})();
