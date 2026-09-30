'use strict';
// 工具分发批(审计 N1/N4/N5/N6/N7/A2/A9/A10/A14/F3/NE-12)的纯逻辑与真子进程覆盖。真 server.js、临时 HOME。
//   [N1]  tool_invoke_* 把 ctx 带进原生目标(workingDir 生效);回合摘要 / 不可逆账按真正被调用的工具名记。
//   [N4]  allowCommandTools / allowDesktopTools 在分发点(toolCall,ctx 带 config)也拒绝,与 offer 面同一判据。
//   [N5]  未知工具 did-you-mean;必填缺失 / 类型明显不对 → 点名字段的 invalid-arguments;合法调用不受影响。
//   [N5b] 宽进:枚举大小写不敏感、boolean 认 0/1、字符串数组认逗号串 —— 就地规范成正统值再交给处理器;真不合法仍点名字段。
//   [N6]  MCP 标准 image / 多 text 块不再丢、不再把 base64 劈成文字;多块时首块是 JSON(含 ok:false)照样按结构化结果处理。
//   [N6b] 工具截图附件落盘走 tmp+rename,目录名带会话标签,删会话时一并清。
//   [N7]  非视觉模型历史里图像换一行占位。
//   [F3]  extractToolImages 的 mime 认字节魔数 / format,不再一律 png。
//   [A2]  桌面 audit_tail 的真实形状({ok,count,records:[{ts,tool,ok,args}]})出得了时间线行。
//   [A9]  桌面租约按 ACC 真实工具名分写/读/无。
//   [A10] 纯读 ACC 工具落 read 档;会点/敲/写的仍 exec。
//   [A14] 桥接子进程调用中途退出 → 可行动的错误(退出码、重试口径);启动失败的原因不吞。
//   [NE-12] desktop_screenshot 的 PNG / 缩略副本进 image_base64,路径保留。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-dispatch-hardening-unit-'));
process.env.RUYI_HOME = path.join(root, 'data');
process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
process.env.HOME = root;
process.env.USERPROFILE = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { toolCall, buildTurnSummary, inferToolResources, bridgedToolTier, buildOpenAiTools, McpStdioClient, dispatchTestHooks: H } = srv;
after(() => { try { srv.killAllMcpClients && srv.killAllMcpClients(); } catch { /* ignore */ } try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG_HEAD = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(60, 1)]).toString('base64');

test('[N1] tool_invoke_read 把 ctx 带进原生目标:工作目录生效', async () => {
  const ws = path.join(root, 'ws-n1');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'marker-n1.txt'), 'x');
  const cfg = { toolLoadingMode: 'auto' };
  const r = await toolCall('tool_invoke_read', { name: 'file_list', arguments: {} }, { config: cfg, workingDir: ws, session: { id: 'sess_n1', cwd: ws } });
  assert.equal(path.resolve(r.root), path.resolve(ws), `修前 ctx=null,根目录回落到数据目录默认工作区(got ${JSON.stringify(r).slice(0, 300)})`);
});

test('[N1] 回合摘要与不可逆账按 tool_invoke_* 的真实目标记', () => {
  const s = buildTurnSummary(1, [
    { name: 'tool_invoke_exec', input: { name: 'script_run', arguments: { language: 'node', code: 'console.log(1)' } }, result: { ok: true } },
    { name: 'tool_invoke_edit', input: { name: 'file_write', arguments: { path: path.join(root, 'a.txt'), content: 'x' } }, result: { ok: true, op: 'create' } },
  ], 'openai', []);
  assert.equal(s.commands, 1);
  assert.deepEqual(s.irreversible.map(x => [x.kind, x.name]), [['exec', 'script_run']]);
  assert.equal(s.filesChanged.length, 1);
  assert.equal(path.basename(s.filesChanged[0].path), 'a.txt');
  // 目标读不出来 → 原样(不谎称账全)
  const s2 = buildTurnSummary(1, [{ name: 'tool_invoke_exec', input: {}, result: { ok: true } }], 'openai', []);
  assert.deepEqual(s2.irreversible, []);
});

test('[N4] 命令 / 桌面工具开关在分发点也生效(且与 offer 面同一判据)', async () => {
  const proof = path.join(root, 'n4-proof.txt');
  const code = `require('fs').writeFileSync(${JSON.stringify(proof)},'ran')`;
  const off = { allowCommandTools: false, allowDesktopTools: false };
  for (const [name, args] of [['script_run', { language: 'node', code }], ['powershell_run', { command: 'echo 1' }], ['shell_start', { command: 'x' }], ['desktop_screenshot', {}], ['keyboard_send_keys', { keys: 'a' }]]) {
    const r = await toolCall(name, args, { config: off });
    assert.equal(r.ok, false, name);
    assert.equal(r.code, 'tool-disabled', name);
  }
  const viaProxy = await toolCall('tool_invoke_exec', { name: 'script_run', arguments: { language: 'node', code } }, { config: off });
  assert.equal(viaProxy.code, 'tool-disabled');
  assert.equal(fs.existsSync(proof), false);
  // 会话级桌面覆盖 true 放行(全局关也一样);覆盖 false 拒
  assert.equal(H.nativeToolDisabledByPolicy('desktop_screenshot', off, true), '');
  assert.notEqual(H.nativeToolDisabledByPolicy('desktop_screenshot', { allowDesktopTools: true }, false), '');
  // offer 面:被拒的工具不在 schema 里
  const names = buildOpenAiTools({ ...off, toolLoadingMode: 'auto' }, null, {}).map(t => t.function.name);
  for (const n of ['script_run', 'powershell_run', 'shell_start', 'desktop_screenshot', 'keyboard_send_keys']) assert.ok(!names.includes(n), n);
});

test('[N5] 未知工具:toolCall 仍抛 Unknown tool(消息逐字),建议走 toolFailureResult', async () => {
  await assert.rejects(() => toolCall('list_directory', {}), e => {
    assert.equal(e.message, 'Unknown tool: list_directory');
    const r = H.toolFailureResult(e);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unknown-tool');
    assert.ok(r.didYouMean.includes('file_list'), JSON.stringify(r.didYouMean));
    assert.equal(r.didYouMean.length, 3);
    assert.match(r.hint, /tool_search/);
    return true;
  });
  // 拼写近似:edit distance
  assert.equal(H.suggestToolNames('file_raed', ['file_read', 'file_write', 'glob', 'git_log'])[0], 'file_read');
  // 普通 Error 不带任何多余字段
  assert.deepEqual(H.toolFailureResult(new Error('boom')), { ok: false, error: 'boom' });
  // 代理路径
  const r = await toolCall('tool_invoke_read', { name: 'file_raed', arguments: {} }, { config: { toolLoadingMode: 'auto' } });
  assert.equal(r.code, 'unknown-tool');
  assert.ok(r.didYouMean.includes('file_read'), JSON.stringify(r));
});

test('[N5] 入参按工具自己的 schema 校验:必填 / 类型 / enum / items', async () => {
  let r = await toolCall('file_read', {});
  assert.equal(r.code, 'invalid-arguments');
  assert.match(r.error, /missing required 'path' \(string\)/);
  assert.deepEqual(r.expected, { path: 'string' });
  r = await toolCall('file_search', {});
  assert.equal(r.code, 'invalid-arguments');
  assert.match(r.error, /pattern/);
  r = await toolCall('file_search', { pattern: '' });
  assert.equal(r.code, 'invalid-arguments', '空 pattern 会匹配每一行 —— 拒');
  r = await toolCall('file_read', { path: 'x.txt', limit: 'ten' });
  assert.equal(r.code, 'invalid-arguments');
  assert.match(r.error, /'limit' must be a number/);
  r = await toolCall('file_read', null);
  assert.equal(r.code, 'invalid-arguments');
  // 宽松标量强转不受影响(handler 自己 Number()/String())
  assert.equal(H.validateNativeToolArgs('file_read', { path: 'x.txt', limit: '10' }), null);
  assert.equal(H.validateNativeToolArgs('file_read', { path: 123 }), null);
  assert.equal(H.validateNativeToolArgs('file_search', { pattern: 'a', ignoreDirs: ['x'], group: 'true' }), null);
  // 数组 items / 类型
  r = H.validateNativeToolArgs('file_search', { pattern: 'a', ignoreDirs: { x: 1 } });
  assert.match(r.error, /'ignoreDirs' must be an array/);
  r = H.validateNativeToolArgs('file_search', { pattern: 'a', ignoreDirs: [{}] });
  assert.match(r.error, /ignoreDirs\[0\]/);
  // 无 schema 的工具(provider 侧元工具)不校验
  assert.equal(H.validateNativeToolArgs('skill_read', {}), null);
  // 管家工具自带校验与专属错误码,公共闸不碰
  assert.equal(H.validateNativeToolArgs('steward_run_action', {}), null);
  // 未知键不拒(HTTP /api/tools 路由把整个 body 当 args)
  assert.equal(H.validateNativeToolArgs('file_read', { path: 'a', sessionId: 's1', turnSeq: 2 }), null);
});

test('[N5b] 宽进:枚举大小写 / 布尔 0-1 / 逗号串数组被规范成正统值,处理器看到的是规范值', () => {
  const V = H.validateNativeToolArgs;
  let a = { language: 'PowerShell', code: 'Write-Output 1' };
  assert.equal(V('script_run', a), null, 'script_run language:PowerShell 修前被拒');
  assert.equal(a.language, 'powershell', '就地规范成 schema 里的正统值');
  for (const [given, canon] of [['Node', 'node'], ['NODE', 'node'], [' Python ', 'python']]) {
    a = { language: given, code: 'x' };
    assert.equal(V('script_run', a), null, given);
    assert.equal(a.language, canon);
  }
  a = { language: '', code: 'x' };
  assert.equal(V('script_run', a), null, "可选枚举传 '' 视为没传(处理器自带缺省)");
  assert.ok(!('language' in a));
  a = { section: 'Health' };
  assert.equal(V('workbench_self_status', a), null, 'workbench_self_status section 大小写');
  assert.equal(a.section, 'health');
  a = { recursive: 1 };
  assert.equal(V('file_list', a), null, 'file_list recursive:1 修前被拒');
  assert.strictEqual(a.recursive, true);
  a = { recursive: '0' };
  assert.equal(V('file_list', a), null);
  assert.strictEqual(a.recursive, false);
  a = { recursive: 'False' };
  assert.equal(V('file_list', a), null);
  assert.strictEqual(a.recursive, false);
  a = { ignoreDirs: 'a, b ,,c' };
  assert.equal(V('file_list', a), null, 'file_list ignoreDirs 逗号串修前被拒');
  assert.deepEqual(a.ignoreDirs, ['a', 'b', 'c']);
  a = { pattern: 'x', ignoreDirs: 'node_modules' };
  assert.equal(V('file_search', a), null);
  assert.deepEqual(a.ignoreDirs, ['node_modules']);
  // 真不合法的输入仍被拒,且点名字段
  let r = V('script_run', { language: 'cobol', code: 'x' });
  assert.equal(r.code, 'invalid-arguments');
  assert.match(r.error, /'language' must be one of/);
  r = V('file_list', { recursive: 'maybe' });
  assert.match(r.error, /'recursive' must be a boolean/);
  r = V('file_list', { recursive: 2 });
  assert.match(r.error, /'recursive' must be a boolean/);
  r = V('workbench_self_status', { section: 'status' });
  assert.match(r.error, /'section' must be one of/);
});

test('[N5b] 端到端:toolCall 收到的 script_run / file_list 入参已是规范值', async () => {
  const ws = path.join(root, 'ws-n5b');
  fs.mkdirSync(path.join(ws, 'skipme'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'skipme', 'hidden.txt'), 'x');
  fs.writeFileSync(path.join(ws, 'keep.txt'), 'x');
  const ctx = { config: { permissionMode: 'bypass' }, workingDir: ws, session: { id: 'sess_n5b', cwd: ws } };
  const r = await toolCall('file_list', { root: ws, recursive: 1, ignoreDirs: 'skipme' }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  const names = (r.files || []).map(f => f.relativePath);
  assert.ok(names.includes('keep.txt'));
  assert.ok(!names.some(n => n.includes('hidden.txt')), 'ignoreDirs 逗号串真的生效了:' + JSON.stringify(names));
  const s = await toolCall('script_run', { language: 'Node', code: 'console.log("n5b-ok")', cwd: ws }, ctx);
  assert.equal(s.ok, true, JSON.stringify(s).slice(0, 300));
  assert.match(s.stdout, /n5b-ok/);
});

test('[N6] MCP 标准 content:全部 text 块、image 块映射、不劈 base64', () => {
  const n = H.normalizeMcpToolResult;
  assert.deepEqual(n({ content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] }), { ok: true, text: 'part one\npart two' });
  const ti = n({ content: [{ type: 'text', text: 'Screenshot captured 1024x768' }, { type: 'image', data: PNG_1X1, mimeType: 'image/png' }] });
  assert.equal(ti.ok, true);
  assert.equal(ti.text, 'Screenshot captured 1024x768');
  assert.equal(ti.image_base64, PNG_1X1);
  assert.equal(ti.image_mime, 'image/png');
  const only = n({ content: [{ type: 'image', data: PNG_1X1, mimeType: 'image/jpeg' }] });
  assert.equal(only.ok, true);
  assert.equal(only.image_base64, PNG_1X1);
  assert.equal(only.content, undefined, '不再把整个 content 数组(含 base64)回给模型');
  const two = n({ content: [{ type: 'image', data: PNG_1X1 }, { type: 'image', data: JPEG_HEAD, mimeType: 'image/jpeg' }] });
  assert.equal(two.images.length, 1);
  assert.equal(two.images[0].data, JPEG_HEAD);
  // 单个 JSON text 块(ACC 形状)逐字不变;isError 仍压过工具自己的 ok:true
  assert.deepEqual(n({ content: [{ type: 'text', text: '{"ok":true,"a":1}' }] }), { ok: true, a: 1 });
  assert.equal(n({ isError: true, content: [{ type: 'text', text: '{"ok":true}' }] }).ok, false);
  // 未知块只留指针
  const o = n({ content: [{ type: 'resource_link', uri: 'file:///x', name: 'x' }] });
  assert.deepEqual(o.omittedBlocks, [{ type: 'resource_link', note: 'omitted', uri: 'file:///x', name: 'x' }]);
  assert.deepEqual(n({ content: [] }), { ok: true, content: [] });
  // 映射后的形状就是工具图像通道认识的形状
  assert.equal(H.VisualPipeline.extractToolImages(only).length, 1);
});

test('[N6] 多 text 块:首块是 JSON 就按结构化结果(保住 ok:false),其余块放 extraText;首块不是 JSON 才拼接', () => {
  const n = H.normalizeMcpToolResult;
  const fail = n({ content: [{ type: 'text', text: '{"ok":false,"error":"boom","code":"E1"}' }, { type: 'text', text: 'Warning: something' }] });
  assert.equal(fail.ok, false, '修前拼接后再解析 → 整体变成 ok:true 的文本');
  assert.equal(fail.error, 'boom');
  assert.equal(fail.code, 'E1');
  assert.equal(fail.extraText, 'Warning: something');
  const good = n({ content: [{ type: 'text', text: '{"ok":true,"a":1}' }, { type: 'text', text: 'note A' }, { type: 'text', text: 'note B' }] });
  assert.deepEqual(good, { ok: true, a: 1, extraText: 'note A\nnote B' });
  const arr = n({ content: [{ type: 'text', text: '[1,2]' }, { type: 'text', text: 'tail' }] });
  assert.deepEqual(arr, { ok: true, items: [1, 2], extraText: 'tail' });
  // 首块不是 JSON:仍整体拼接(与修前一致),后面块是 JSON 也不抢
  assert.deepEqual(n({ content: [{ type: 'text', text: 'Result:' }, { type: 'text', text: '{"ok":false}' }] }), { ok: true, text: 'Result:\n{"ok":false}' });
  // 图像仍映射
  const withImg = n({ content: [{ type: 'text', text: '{"ok":false,"error":"x"}' }, { type: 'text', text: 'w' }, { type: 'image', data: PNG_1X1, mimeType: 'image/png' }] });
  assert.equal(withImg.ok, false);
  assert.equal(withImg.image_base64, PNG_1X1);
});

test('[N7] 非视觉:图像字段换成一行占位', () => {
  const V = H.VisualPipeline;
  const big = 'A'.repeat(40000);
  const res = { ok: true, width: 1280, height: 720, format: 'png', image_base64: big };
  const s = V.stripToolImageFields(res, 'no-vision');
  assert.equal(s.image_base64, '[image omitted: 1280x720 png, model has no vision]');
  assert.equal(res.image_base64, big, '原对象不动(UI 事件还要用)');
  const nested = V.stripToolImageFields({ ok: true, screenshot: { image: big, width: 10, height: 20, format: 'jpeg' } }, 'no-vision');
  assert.equal(nested.screenshot.image, '[image omitted: 10x20 jpeg, model has no vision]');
  // 视觉开时的默认占位不变
  assert.equal(V.stripToolImageFields(res).image_base64, '[截图见随后的图片消息]');
  // 不是图的 image 字段(镜像名 / 路径)不被当成图
  assert.equal(V.extractToolImages({ image: 'nginx:latest' }).length, 0);
  assert.equal(V.extractToolImages({ image: 'C:\\pics\\a.png' }).length, 0);
});

test('[F3] extractToolImages 的 mime:魔数 > format > png', () => {
  const V = H.VisualPipeline;
  assert.match(V.extractToolImages({ ok: true, image: JPEG_HEAD, format: 'jpeg' })[0], /^data:image\/jpeg;base64,/);
  assert.match(V.extractToolImages({ ok: true, image: JPEG_HEAD })[0], /^data:image\/jpeg;base64,/, '没有 format 也认字节');
  assert.match(V.extractToolImages({ ok: true, image_base64: PNG_1X1, format: 'jpeg' })[0], /^data:image\/png;base64,/, '字节说了算(服务端校验的是字节)');
  assert.match(V.extractToolImages({ ok: true, screenshot: { image: 'FAKE_IMAGE_B64', format: 'jpeg' } })[0], /^data:image\/jpeg;base64,/, '字节认不出时用 format');
  assert.match(V.extractToolImages({ ok: true, image: 'FAKE_IMAGE_B64' })[0], /^data:image\/png;base64,/);
  assert.equal(V.extractToolImages({ image: 'data:image/webp;base64,AAAA' })[0], 'data:image/webp;base64,AAAA');
  assert.equal(V.sniffImageMime(Buffer.from('GIF89a......').toString('base64')), 'image/gif');
  assert.equal(V.sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]).toString('base64')), 'image/webp');
});

test('[A2] 桌面 audit_tail 的真实形状(records)出得了时间线行', () => {
  const res = srv.dispatchTestHooks.normalizeMcpToolResult({ content: [{ type: 'text', text: JSON.stringify({
    ok: true, count: 3, log_dir: 'C:\\x',
    records: [
      { ts: '2026-09-30T10:00:00', tool: 'write_file', ok: true, args: '{"path":"C:\\\\a.txt","content":"hi"}' },
      { ts: '2026-09-30T10:00:05', tool: 'run_command', ok: false, args: '{"command":"dir"}' },
      { raw: 'not json' },
    ] }) }] });
  const rows = H.desktopAuditEntriesFromResult(res);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].source, 'desktop');
  assert.equal(rows[0].type, 'write_file');
  assert.equal(rows[0].ts, '2026-09-30T10:00:00');
  assert.equal(typeof rows[0].detail.args, 'object', 'args 字符串被摊成对象,不再双重编码');
  assert.match(rows[1].summary, /失败/);
  assert.equal(rows[2].type, 'raw');
  // 旧形状仍认
  assert.equal(H.desktopAuditEntriesFromResult({ entries: [{ ts: 't', type: 'x' }] }).length, 1);
  assert.equal(H.desktopAuditEntriesFromResult([{ ts: 't', action: 'y' }])[0].type, 'y');
  assert.deepEqual(H.desktopAuditEntriesFromResult({ ok: true }), []);
});

test('[A9] 桌面租约按 ACC 真实工具名分类', () => {
  const lease = (bare, args) => inferToolResources(`acc__${bare}`, args || {}, { toolName: bare }, root, 'exec').filter(r => r.type === 'desktop').map(r => r.mode).join('');
  for (const w of ['macro_run', 'batch_actions', 'key_down', 'key_up', 'act_and_verify', 'ui_invoke', 'launch_application', 'set_clipboard', 'set_clipboard_image', 'message_box', 'show_notification', 'hotkey', 'mouse_click', 'type_text', 'focus_window', 'close_window', 'vision_click', 'ocr_click']) {
    assert.equal(lease(w), 'write', `${w} 应占桌面独占写锁`);
  }
  for (const r of ['screenshot', 'observe', 'list_windows', 'get_screen_info', 'get_active_window', 'ocr_screen', 'ui_find', 'find_on_screen', 'get_clipboard', 'window_screenshot']) {
    assert.equal(lease(r), 'read', `${r} 只读,应是共享读锁`);
  }
  assert.equal(lease('ocr_find_text', { text: 'x' }), 'read');
  assert.equal(lease('ocr_find_text', { text: 'x', click: true }), 'write');
  for (const n of ['read_document', 'excel_read', 'write_excel', 'memory_save', 'fetch', 'run_command', 'ocr_image']) assert.equal(lease(n, {}), '', `${n} 不占桌面`);
  // 原生桌面工具:键盘注入修前没有锁
  assert.deepEqual(inferToolResources('keyboard_send_keys', { keys: 'a' }, null, root, 'exec').map(r => `${r.type}:${r.mode}`), ['desktop:write']);
  assert.deepEqual(inferToolResources('desktop_screenshot', {}, null, root, 'exec').map(r => `${r.type}:${r.mode}`), ['desktop:read']);
  // 表外(第三方 MCP)走旧正则兜底
  assert.equal(lease('click_element'), 'write');
});

test('[A10] 纯读 ACC 工具落 read 档,会动的仍 exec', () => {
  for (const n of ['observe', 'excel_read', 'read_document', 'pdf_read_pages', 'image_info', 'browser_get_text', 'browser_list_tabs', 'browser_backend_status', 'macro_list', 'memory_read', 'memory_list', 'ocr_available_languages', 'sequential_thinking', 'wait', 'list_windows', 'get_screen_info']) {
    assert.equal(bridgedToolTier(n, null), 'read', n);
  }
  for (const n of ['act_and_verify', 'ocr_find_text', 'ocr_click', 'mouse_click', 'type_text', 'browser_click', 'browser_execute_js', 'browser_open', 'fetch', 'get_environment_variable', 'memory_save', 'memory_delete', 'write_file', 'write_document', 'run_command', 'macro_run', 'beep']) {
    assert.equal(bridgedToolTier(n, null), 'exec', n);
  }
});

test('[NE-12] desktop_screenshot 的图进 image_base64,路径保留;过大不内嵌', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'shot-'));
  const png = path.join(dir, 's.png');
  fs.writeFileSync(png, Buffer.from(PNG_1X1, 'base64'));
  let r = await H.attachScreenshotImage({ ok: true, code: 0, path: png }, png);
  assert.equal(r.image_base64, PNG_1X1);
  assert.equal(r.path, png);
  assert.deepEqual([r.width, r.height, r.format, r.image_mime], [1, 1, 'png', 'image/png']);
  assert.equal(H.VisualPipeline.extractToolImages(r).length, 1);
  // 缩略副本优先,并被清掉
  const side = png + '.vision.jpg';
  fs.writeFileSync(side, Buffer.from(JPEG_HEAD, 'base64'));
  r = await H.attachScreenshotImage({ ok: true, path: png }, png);
  assert.equal(r.image_mime, 'image/jpeg');
  assert.equal(fs.existsSync(side), false);
  // 失败结果不动;巨大的 PNG 只回说明
  assert.deepEqual(await H.attachScreenshotImage({ ok: false, error: 'x', path: png }, png), { ok: false, error: 'x', path: png });
  const bigPng = path.join(dir, 'big.png');
  fs.writeFileSync(bigPng, Buffer.concat([Buffer.from(PNG_1X1, 'base64'), Buffer.alloc(2600000)]));
  r = await H.attachScreenshotImage({ ok: true, path: bigPng }, bigPng);
  assert.equal(r.image_base64, undefined);
  assert.match(r.imageOmitted, /not embedded/);
  // 桌面截图缺失文件:原样返回
  const none = await H.attachScreenshotImage({ ok: true, path: path.join(dir, 'nope.png') }, path.join(dir, 'nope.png'));
  assert.equal(none.image_base64, undefined);
});

test('[A14] 桥接子进程调用中途退出:错误可行动;启动失败原因不吞', async () => {
  const fake = path.join(root, 'crash-mcp.js');
  fs.writeFileSync(fake, `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) handle(JSON.parse(l)); } });
const send = o => process.stdout.write(JSON.stringify(o) + '\\n');
function handle(m) {
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'fake' }, capabilities: {} } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'boom' }] } });
  if (m.method === 'tools/call') { process.stderr.write('segfault-ish'); setTimeout(() => process.exit(3), 30); }
}
`);
  const client = new McpStdioClient({ id: 'crashy', command: process.execPath, args: [fake] });
  await client.start();
  const r = await client.callTool('boom', {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'mcp-child-exited');
  assert.equal(r.retryable, true);
  assert.match(r.error, /tool 'boom'/);
  assert.match(r.error, /code 3/);
  assert.match(r.error, /retry the call once/);
  assert.match(r.error, /segfault-ish/);
  client.kill();
  // 桌面组件用人话点名
  const d = H.mcpChildExitResult({ id: 'ai-computer-control' }, 'screenshot', { code: 1, signal: null, stderrTail: '' });
  assert.match(d.error, /desktop control component/);
  // 没有失败记录 / 有失败记录
  assert.match(H.bridgedServerUnavailableMessage('never-failed'), /^bridged MCP server 'never-failed' is not available/);
});

// ── [N6b] 工具截图附件:tmp+rename、按会话标签命名、删会话时清 ───────────────────────────────────────────────
test('[N6b] 删会话时清掉该会话的 toolimg_* 附件目录(别的会话的不动)', async () => {
  const { functionBlock } = require('../lib/source-slice');
  const src = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/02-session-store.js'), 'utf8');
  const tagOf = new Function('crypto', `${functionBlock(src, 'toolImageSessionTag')}\nreturn toolImageSessionTag;`)(require('crypto'));
  const a = await srv.createSession({ title: 'a', cwd: root });
  const b = await srv.createSession({ title: 'b', cwd: root });
  const uploads = path.join(process.env.RUYI_HOME, 'uploads');
  const mk = (sid, hash) => { const d = path.join(uploads, `toolimg_${tagOf(sid)}_${hash}`); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'screenshot.png'), 'x'); return d; };
  const a1 = mk(a.id, 'aaaaaaaaaaaaaaaaaaaaaaaa'), a2 = mk(a.id, 'bbbbbbbbbbbbbbbbbbbbbbbb'), b1 = mk(b.id, 'cccccccccccccccccccccccc');
  const legacy = path.join(uploads, 'toolimg_dddddddddddddddddddddddd'); fs.mkdirSync(legacy, { recursive: true });
  assert.notEqual(tagOf(a.id), tagOf(b.id));
  await srv.deleteSession(a.id);
  assert.ok(!fs.existsSync(a1) && !fs.existsSync(a2), '被删会话的截图附件没了');
  assert.ok(fs.existsSync(b1), '别的会话的不动');
  assert.ok(fs.existsSync(legacy), '无会话标签的旧附件不在本次清理范围');
  await srv.deleteSession(b.id);
  assert.ok(!fs.existsSync(b1));
});
