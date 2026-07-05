// E2E for v1.2-B —— checkpoint 全覆盖审计(机制性防漏).
//
// 背景/动机:ACC v1.6 四个 Office 写族工具上线时漏进 BRIDGED_WRITE_PATH_ARGS(server.js 快照表),
//   用户真机撞出「PPT/Excel 不能撤销」。逐个补是被动的。本切片把「逐个补」升级成【离线回归可断言】的机制:
//   任何叫 write_*/save_*/export_*/create_*/delete_*/remove_*/move_*/copy_*/rename_* 的桥接写族工具没进快照
//   表且没显式豁免 → auditBridgedWriteCoverage 返回它 → 此 e2e 直接红。杜绝 v1.6 事故重演。
//
// 五部分:
//  (A) 机制核心 —— 静态固化工具名清单(本切片 B1 盘点自 ACC 93 工具冻结)过 auditBridgedWriteCoverage,
//      断言 uncovered 为空。机器无关,永远运行 —— 这是「离线回归」那一层的防线。
//  (C) 审计函数行为单元 —— 命名模式命中/豁免/已入表 三分支;裸名与带前缀名等价;非写族名不误报;★控制组红线。
//  (D) 多目标提取单元(纯函数)—— collectBridgedWriteTargets:move 两条(src delete + dest write)、copy 一条、
//      缺字段/相对路径跳过、可选截图路径。
//  (D2) move/copy 两条式端到端(spawn 真 workbench + fake-mcp)—— 桥接 move_file → journal 落两条(source
//      op:delete 存 before + destination op:create)→ /api/checkpoints 核对 → rollback 整回合【逆序】恢复
//      (dest create 先撤删新文件、src delete 后撤写回原处 → 净效果=移动前状态)。
//  (B) 真 ACC 全量审计(best-effort)—— 拉起真 ai-computer-control(同 desktop-mcp-smoke 的 McpStdioClient
//      拉法)拿全量 93+ 工具名 → auditBridgedWriteCoverage → 断言 uncovered 为空。ACC 拉不起来 / stdio SDK
//      只回 <80 工具(已知构建坑)/ 无 python 环境 → SKIP(不 fail),回落 (A) 的静态清单兜底。
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const REPO = [path.resolve(__dirname, '..', 'ai-computer-control'), path.resolve(__dirname, '..', 'mcp', 'ai-computer-control')]
  .find(p => fs.existsSync(p)) || path.resolve(__dirname, '..', 'mcp', 'ai-computer-control');
const HERE = __dirname;
const srv = require(path.join(WB, 'app', 'server.js'));
const { McpStdioClient, detectDesktopMcp, auditBridgedWriteCoverage,
        collectBridgedWriteTargets, BRIDGED_WRITE_PATH_ARGS } = srv;

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const procs = [];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getJson(port, p, headers) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000, headers: headers || {} }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    r.on('error', () => resolve({ status: 0, json: null, raw: '' })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '' }); });
  });
}
function postJson(port, p, payload, headers) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 6000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    req.on('error', () => resolve({ status: 0, json: null, raw: '' })); req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: '' }); });
    req.write(data); req.end();
  });
}
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); }); req.write(data); req.end();
  });
}
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 固化清单:ACC in-process 全量工具名冻结 (v1.6=93 → v1.8 +excel_read/pdf_read_pages/image_info/image_resize=97)。用途=(A) 的离线兜底 +
// (B) 真 ACC 拉不起来时的回落。**维护纪律**:ACC 新增/改名工具时,此清单要同步(否则 (B) 在有 python 的
// 机器上会红,提示你既补 server.js 快照表、也更新这份冻结清单)。清单顺序无关(auditBridgedWriteCoverage 去重排序)。
const ACC_TOOL_NAMES_FROZEN = [
  'act_and_verify', 'audit_tail', 'batch_actions', 'beep', 'browser_click', 'browser_close',
  'browser_execute_js', 'browser_get_elements', 'browser_get_text', 'browser_navigate', 'browser_open',
  'browser_screenshot', 'browser_type', 'chart_image', 'close_window', 'copy_file', 'delete_file',
  'diagnostics', 'excel_beautify', 'excel_chart', 'excel_read', 'file_info', 'find_all_templates',
  'find_on_screen', 'find_template', 'focus_window', 'get_active_window', 'get_clipboard',
  'get_clipboard_image', 'get_dpi_info', 'get_environment_variable', 'get_mouse_position',
  'get_pixel_color', 'get_screen_info', 'get_system_info', 'hotkey', 'image_info', 'image_resize',
  'key_down', 'key_up', 'kill_process', 'launch_application',
  'list_directory', 'list_monitors', 'list_processes', 'list_windows', 'macro_list', 'macro_run',
  'maximize_window', 'message_box', 'minimize_window', 'mouse_click', 'mouse_drag', 'mouse_move',
  'mouse_scroll', 'move_file', 'move_window', 'notify_attention', 'observe', 'ocr_click', 'ocr_find_text',
  'ocr_image', 'ocr_screen', 'pdf_read_pages', 'play_sound', 'press_key', 'read_document', 'read_file',
  'record_start', 'record_stop', 'resize_window', 'run_command', 'safety_info', 'screenshot',
  'screenshot_region', 'scroll_at', 'set_clipboard', 'set_clipboard_image', 'set_window_topmost',
  'show_notification', 'type_text', 'ui_find', 'ui_inspect', 'ui_invoke', 'version_info', 'vision_click',
  'wait', 'wait_for_image', 'wait_for_pixel', 'wait_for_window', 'wait_for_window_idle',
  'window_screenshot', 'write_document', 'write_excel', 'write_file', 'write_pdf', 'write_pptx',
];

(async () => {
  // ── (A) 静态固化清单审计(机器无关,always-on 防回潮) ──────────────────────────────────────────
  ok(ACC_TOOL_NAMES_FROZEN.length >= 93, '(A) 固化清单 >= 93 工具(got ' + ACC_TOOL_NAMES_FROZEN.length + ')');
  const auditFrozen = auditBridgedWriteCoverage(ACC_TOOL_NAMES_FROZEN);
  ok(auditFrozen.uncovered.length === 0,
     '(A) 固化 ACC 清单:auditBridgedWriteCoverage uncovered 为空' +
     (auditFrozen.uncovered.length ? ' —— 漏表: ' + auditFrozen.uncovered.join(', ') : ''));
  // 正证:清单里命名像写族的都进表了。
  for (const t of ['write_document', 'write_file', 'write_excel', 'write_pdf', 'write_pptx',
                   'delete_file', 'move_file', 'copy_file']) {
    ok(Object.prototype.hasOwnProperty.call(BRIDGED_WRITE_PATH_ARGS, t), '(A) ' + t + ' 在快照表');
  }

  // ── (C) auditBridgedWriteCoverage 行为单元(纯函数无依赖) ──────────────────────────────────────
  {
    const u1 = auditBridgedWriteCoverage(['save_report', 'export_pdf', 'rename_thing', 'remove_widget']);
    ok(JSON.stringify(u1.uncovered) === JSON.stringify(['export_pdf', 'remove_widget', 'rename_thing', 'save_report']),
       '(C) 像写族但没进表 → 全进 uncovered(去重排序)');
    ok(auditBridgedWriteCoverage(['write_document', 'delete_file', 'move_file', 'copy_file']).uncovered.length === 0,
       '(C) 已入表写族 → uncovered 为空');
    ok(auditBridgedWriteCoverage(['create_session', 'create_task', 'create_context', 'create_directory',
                                  'save_session', 'export_macro']).uncovered.length === 0,
       '(C) 豁免表里的逻辑性名字 → 不误报');
    ok(auditBridgedWriteCoverage(['read_document', 'screenshot', 'excel_beautify', 'chart_image',
                                  'window_screenshot', 'run_command']).uncovered.length === 0,
       '(C) 名字不含写族前缀 → 命名审计不误报(靠人工盘点)');
    ok(JSON.stringify(auditBridgedWriteCoverage(['acc__save_report']).uncovered) === JSON.stringify(['save_report']),
       '(C) 带前缀桥接名去前缀后同样判定');
    ok(auditBridgedWriteCoverage(['acc__write_document']).uncovered.length === 0,
       '(C) 带前缀的已入表工具 → 不误报');
    ok(auditBridgedWriteCoverage([]).uncovered.length === 0, '(C) 空数组 → 空 uncovered');
    ok(auditBridgedWriteCoverage(null).uncovered.length === 0, '(C) null 输入 → 空 uncovered(不炸)');
    ok(auditBridgedWriteCoverage(['', null, undefined, 42]).uncovered.length === 0, '(C) 垃圾元素 → 忽略不炸');
    // ★ 反向红线(证明审计【真的会红】,不是永远绿的花瓶)——虚构一个「像写族但不在表也不豁免」的名字:
    ok(auditBridgedWriteCoverage(['write_newformat']).uncovered.includes('write_newformat'),
       '(C ★控制组) 虚构 write_newformat 漏表 → 审计确实报红(证明机制有效)');
  }

  // ── (D) 多目标提取单元(纯函数) ─────────────────────────────────────────────────────────────
  {
    const abs = p => path.resolve(p);
    const A = abs('C:\\ws\\src.txt'), B = abs('C:\\ws\\dst.txt');
    const mv = collectBridgedWriteTargets('acc__move_file', { source: A, destination: B });
    ok(mv.length === 2, '(D) move_file → 2 条目标(got ' + mv.length + ')');
    ok(mv[0].mode === 'delete' && mv[0].path === A, '(D) move 第 1 条 = source delete');
    ok(mv[1].mode === 'write' && mv[1].path === B, '(D) move 第 2 条 = destination write');
    const cpTargets = collectBridgedWriteTargets('acc__copy_file', { source: A, destination: B });
    ok(cpTargets.length === 1 && cpTargets[0].mode === 'write' && cpTargets[0].path === B, '(D) copy_file → 1 条 destination write');
    ok(collectBridgedWriteTargets('acc__move_file', { source: A }).length === 1, '(D) move 缺 destination → 只剩 source 一条');
    ok(collectBridgedWriteTargets('acc__move_file', { source: 'rel\\a.txt', destination: B }).length === 1, '(D) move 源为相对路径 → 跳过源、只剩 dest 一条');
    ok(collectBridgedWriteTargets('acc__window_screenshot', { title_substring: 'x' }).length === 0, '(D) window_screenshot 无 output_path → 不快照');
    ok(collectBridgedWriteTargets('acc__window_screenshot', { title_substring: 'x', output_path: abs('C:\\ws\\s.png') }).length === 1, '(D) window_screenshot 有 output_path → 1 条');
    ok(collectBridgedWriteTargets('acc__get_clipboard_image', { save_path: abs('C:\\ws\\c.png') }).length === 1, '(D) get_clipboard_image save_path → 1 条');
  }

  // ── (D2) move/copy 两条式端到端(spawn 真 workbench + fake-mcp) ─────────────────────────────
  {
    const D_HOME = path.join(os.tmpdir(), 'wcw-ckcov-e2e');
    const D_WS = path.join(D_HOME, 'ws');
    fs.rmSync(D_HOME, { recursive: true, force: true });
    fs.mkdirSync(D_WS, { recursive: true });
    const FAKE_MCP = path.join(HERE, 'fake-mcp.js');
    const D_FAKE_PORT = 9061, D_WB_PORT = 9062;
    const src = path.join(D_WS, 'orig.txt');
    const dst = path.join(D_WS, 'moved.txt');
    fs.writeFileSync(src, 'ORIGINAL BODY');

    fs.writeFileSync(path.join(D_HOME, 'config.json'), JSON.stringify({
      configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
      defaultWorkspace: D_WS, recentWorkspaces: [],
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + D_FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
      activeProvider: 'fake',
      externalMcpServers: [{ id: 'fake', label: 'Fake MCP', command: process.execPath, args: [FAKE_MCP], enabled: true }],
      bridgeExternalToolsToProvider: true,
      desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    }, null, 2));

    // provider 调 fake__move_file(source=orig.txt → destination=moved.txt)。
    const dseq = JSON.stringify([{ name: 'fake__move_file', args: { source: src, destination: dst } }]);
    const dfake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(D_FAKE_PORT), FAKE_TOOL_SEQUENCE: dseq }, windowsHide: true });
    const dwb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(D_WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: D_HOME }, windowsHide: true });
    dwb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[dwb!] ' + l.trim())));
    procs.push(dfake, dwb);
    try {
      let dh = null; for (let i = 0; i < 40 && !dh; i++) { await sleep(150); dh = await health(D_WB_PORT); }
      ok(!!dh, '(D2) workbench up on :' + D_WB_PORT);
      const dtok = await getToken(D_WB_PORT);
      const dhdr = { 'x-wcw-token': dtok };
      const dCreated = await postJson(D_WB_PORT, '/api/sessions', { title: 'move', cwd: D_WS }, dhdr);
      const dsid = dCreated.json && dCreated.json.session && dCreated.json.session.id;
      ok(!!dsid, '(D2) session created');

      const dev = await postStream(D_WB_PORT, { sessionId: dsid, message: '移动文件', cwd: D_WS });
      const dTu = dev.filter(e => e.type === 'tool_use' && e.name === 'fake__move_file');
      ok(dTu.length === 1, '(D2) provider 调用 fake__move_file(got ' + dTu.length + ')');
      // move 真的执行了:orig 消失、moved 出现。
      ok(!fs.existsSync(src) && fs.existsSync(dst), '(D2) move 执行后 orig 消失、moved 出现');
      ok(fs.readFileSync(dst, 'utf8') === 'ORIGINAL BODY', '(D2) moved.txt 内容 = 原内容');

      // GET /api/checkpoints:同回合两条 —— source(op:delete 存了 before)+ destination(op:create 无 before)。
      const dcp = await getJson(D_WB_PORT, '/api/checkpoints?sessionId=' + dsid, dhdr);
      const entries = (dcp.json && Array.isArray(dcp.json.entries) ? dcp.json.entries : []);
      const srcEntry = entries.find(e => e.path === path.resolve(src));
      const dstEntry = entries.find(e => e.path === path.resolve(dst));
      ok(!!srcEntry && srcEntry.op === 'delete' && !srcEntry.skipped && Number(srcEntry.bytes) > 0,
         '(D2) 源条目 op:delete 且存了 before 字节(回滚=写回)');
      ok(!!dstEntry && dstEntry.op === 'create',
         '(D2) 目的条目 op:create(此前不存在,回滚=删除)');
      ok(srcEntry && dstEntry && srcEntry.turnSeq === dstEntry.turnSeq, '(D2) 两条同 turnSeq(同一回合)');
      // 声明顺序:source(entrySeq 小)在前、destination 在后 —— 保证 rollback 逆序时 dest 先撤、src 后撤。
      ok(srcEntry && dstEntry && Number(srcEntry.entrySeq) < Number(dstEntry.entrySeq),
         '(D2) source 条目 entrySeq < destination(rollback 逆序:先撤 dest、后撤 src)');

      // rollback 整回合(不传 entrySeq)→ 逆序展开:先撤 dest(create→删 moved.txt),再撤 src(delete→写回 orig.txt)。
      const drb = await postJson(D_WB_PORT, '/api/checkpoints/rollback', { sessionId: dsid, turnSeq: srcEntry.turnSeq }, dhdr);
      ok(drb.json && drb.json.ok === true, '(D2) rollback 整回合 ok');
      ok(fs.existsSync(src) && fs.readFileSync(src, 'utf8') === 'ORIGINAL BODY',
         '(D2) rollback 后 orig.txt 写回原处且内容恢复(source delete 条逆向)');
      ok(!fs.existsSync(dst), '(D2) rollback 后 moved.txt 被删除(destination create 条逆向)—— 净效果=移动前状态');
    } catch (e) {
      console.log('ERROR (D2) ' + (e && e.stack || e.message || e)); fail++;
    } finally {
      killp(dfake); killp(dwb);
      await sleep(300);
      fs.rmSync(D_HOME, { recursive: true, force: true });
    }
  }

  // ── (B) 真 ACC 全量审计(best-effort;拉不起来/工具 <80 → SKIP 回落静态清单) ────────────────────
  let needsTargetVerify = false;
  const det = detectDesktopMcp();
  const launch = (det && det.command)
    ? { id: 'ai-computer-control', command: det.command, args: det.args, cwd: det.cwd, env: det.env }
    : { id: 'ai-computer-control', command: process.platform === 'win32' ? 'python' : 'python3',
        args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: REPO,
        env: { PYTHONPATH: path.join(REPO, 'src'), PYTHONUTF8: '1' } };
  let client = null, liveNames = null;
  try {
    client = new McpStdioClient(launch);
    await client.start();
    liveNames = client.listTools().map(t => t && t.name).filter(Boolean);
  } catch (e) {
    console.log('SKIP (B) real ACC audit — could not start (needs python/deps): ' + (e && e.message || e));
    needsTargetVerify = true;
  }
  if (liveNames) {
    if (liveNames.length >= 80) {
      const auditLive = auditBridgedWriteCoverage(liveNames);
      ok(auditLive.uncovered.length === 0,
         '(B) 真 ACC ' + liveNames.length + ' 工具:auditBridgedWriteCoverage uncovered 为空' +
         (auditLive.uncovered.length ? ' —— 漏表: ' + auditLive.uncovered.join(', ') : ''));
      // 核对真 ACC 工具集 vs 固化清单是否漂移(漂移只 WARN 不 fail —— ACC 可能领先于清单更新)。
      const liveSet = new Set(liveNames), frozenSet = new Set(ACC_TOOL_NAMES_FROZEN);
      const added = liveNames.filter(n => !frozenSet.has(n));
      const removed = ACC_TOOL_NAMES_FROZEN.filter(n => !liveSet.has(n));
      if (added.length || removed.length) {
        console.log('  WARN: 真 ACC 工具集与固化清单漂移 —— 新增:[' + added.join(',') +
                    '] 移除:[' + removed.join(',') + ']。请同步 ACC_TOOL_NAMES_FROZEN' +
                    (added.some(n => /^(write_|save_|export_|create_|delete_|remove_|move_|copy_|rename_)/.test(n))
                      ? ' ⚠️ 新增里有像写族的名字,务必确认 BRIDGED_WRITE_PATH_ARGS 已覆盖!' : '') + '.');
      } else {
        ok(true, '(B) 真 ACC 工具集与固化清单一致(无漂移)');
      }
    } else {
      needsTargetVerify = true;
      console.log('  NOTE: 真 ACC 经 stdio 只回 ' + liveNames.length +
                  ' 工具(in-process 有 97)—— mcp SDK stdio 构建坑,NEEDS TARGET-MACHINE VERIFICATION;已回落静态清单 (A)。');
    }
    try { client.kill(); } catch {}
  }

  for (const c of procs) killp(c);
  console.log('\nCHECKPOINT-COVERAGE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS') +
              (needsTargetVerify ? '  [(B) real-ACC-audit SKIPPED → 回落静态清单 (A)]' : ''));
  setTimeout(() => process.exit(fail ? 1 : 0), 400);
})();
