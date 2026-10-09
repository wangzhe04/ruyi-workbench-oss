'use strict';
// 中文检索桥接(MCP)工具(2026-10)。模型服务商会话里桥接工具从不注入,模型只能 tool_search 再走 tool_invoke_* 代理;
// 用中文搜的模型(qwen 等)修前几乎搜不到内置桌面服务器的工具:「截图」只出 set_clipboard_image(它的中文描述里碰巧有
// 「截图了一张图」),「鼠标点击」零命中。夹具是一小份照着 ai_computer_control 抄的工具名/描述,不需要 Python。
//   [Z1] 中文说法排得出对应的桥接工具(截图 / 鼠标 / 键盘 / 窗口 / 剪贴板 / 办公 / 浏览器 / 识别 / 进程),诱饵排在后面。
//   [Z2] 结果形状不变:带汉字的查询走已有的 alias_ranker 形状;纯英文查询仍是修前的子串匹配形状;零命中照旧交回子串结果。
//   [Z3] 别名只按工具名里的词生成、只给桥接工具;与原生 file_* 重复的桥接文件工具不给别名,中文检索原生的排前面。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-bridged-search-zh-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const SID = 'ai_computer_control';
// [名字, 描述] —— 描述取自真实工具的开头(英文为主,少数是中文;中文描述正是修前噪声的来源)。
const ACC = [
  ['screenshot', 'Take a screenshot of the primary screen, a region, a monitor, or a specific window.'],
  ['screenshot_region', 'Take a screenshot of a rectangular region (virtual-screen coordinates, any monitor).'],
  ['window_screenshot', 'Screenshot a specific window by (case-insensitive) title substring. Uses PrintWindow.'],
  ['browser_screenshot', 'Take a screenshot of the current browser page.'],
  ['get_screen_info', 'Get information about screen resolution, DPI, and multi-monitor setup.'],
  ['observe', 'One-shot situational snapshot: screenshot + focused window + UIA elements + OCR words.'],
  ['mouse_click', 'Click the mouse at the specified coordinates. button: "left", "right", or "middle". clicks: 1 single, 2 double.'],
  ['mouse_move', 'Move the mouse cursor to the specified coordinates.'],
  ['mouse_drag', 'Drag the mouse from one position to another.'],
  ['mouse_scroll', 'Scroll the mouse wheel. Positive = up/right, negative = down/left.'],
  ['type_text', 'Type a string of text using the keyboard.'],
  ['press_key', 'Press a single key or key combination.'],
  ['hotkey', 'Press a keyboard shortcut (multiple keys held simultaneously).'],
  ['list_windows', 'List all visible windows with their titles, handles, and positions.'],
  ['focus_window', 'Bring a window to the foreground by title or handle, and confirm it actually took focus.'],
  ['close_window', "Ask a window to close, then confirm whether it actually closed."],
  ['maximize_window', "Maximize a window. Returns 'ok' and the resulting 'maximized' state."],
  ['get_clipboard', '读取系统剪贴板里的【文本】。什么时候用: 用户说「我复制了…你看一下」,或你刚让某个 App 执行了复制后想拿到结果。'],
  ['set_clipboard', '把一段【文本】写入系统剪贴板,供其它程序粘贴 (Ctrl+V)。'],
  ['set_clipboard_image', 'Put an image file onto the clipboard, so it can be pasted into other apps (Ctrl+V). 何时用: 生成/截图了一张图,想直接粘贴到聊天窗口、文档或设计工具里。'],
  ['write_excel', 'Create or overwrite a styled Excel file (.xlsx).'],
  ['excel_chart', 'Insert a native chart (bar | line | pie | scatter) into an existing .xlsx.'],
  ['excel_read', '结构化读取 Excel (.xlsx):二维 data + 表头 + 可选公式/数字格式。'],
  ['write_pptx', 'Create a 16:9 PowerPoint (.pptx) from slide specs.'],
  ['pdf_read_pages', '分页读取 PDF:只读你点名的页,避免「50 页 PDF 整读爆上下文」。'],
  ['write_document', 'Create or overwrite a styled Word document (.docx).'],
  ['browser_open', 'Open a URL in the browser.'],
  ['browser_click', 'Click an element in the browser page.'],
  ['ocr_screen', 'Run OCR on the whole primary screen, or a region "x,y,width,height".'],
  ['ocr_image', 'Run OCR on an image file. Returns recognized text + per-word bounding boxes.'],
  ['ui_find', 'Find controls by name / control type / automation id within a window.'],
  ['launch_application', 'Launch an application and confirm it really started.'],
  ['kill_process', 'Kill a running process by PID or name — with safety guards.'],
  ['list_processes', 'List running processes.'],
  // 与原生 file_* 重复的一族:不该被中文别名顶到原生前面
  ['read_file', 'Read the text content of a file.'],
  ['delete_file', 'Delete a file or directory.'],
  ['edit_file', 'Replace an exact string inside a file, in place (partial edit). 何时用: 改动一个已有文件的一小段。'],
];
const cfg = srv.defaultConfig();
const native = srv.buildOpenAiTools(cfg, null, {});
const bridgedTools = []; const route = {};
for (const [name, description] of ACC) {
  const full = `${SID}__${name}`;
  bridgedTools.push({ type: 'function', function: { name: full, description, parameters: { type: 'object', properties: {} } } });
  route[full] = { serverId: SID, toolName: name };
}
const state = srv.createToolLoadingState(cfg, '你好', null, native.concat(bridgedTools), route, null);
const short = n => n.startsWith(`${SID}__`) ? '@' + n.slice(SID.length + 2) : n;
const top = (query, k = 8) => state.search(query, k).matches.map(m => short(m.name));

test('[Z1] 中文说法排得出对应的桥接工具', () => {
  // 截图:叫「截图」的就是 screenshot 本身;另外几件截图工具紧随其后;描述里碰巧有「截图」的诱饵排在它们后面
  const shot = top('截图');
  assert.equal(shot[0], '@screenshot', shot.join(','));
  for (const n of ['@screenshot_region', '@browser_screenshot', '@window_screenshot']) assert.ok(shot.slice(0, 5).includes(n), `${n} 应在前 5:${shot}`);
  assert.ok(shot.indexOf('@set_clipboard_image') > shot.indexOf('@window_screenshot'), `诱饵排在截图工具后面:${shot}`);
  assert.equal(top('截屏')[0], '@screenshot');
  assert.equal(top('浏览器截图')[0], '@browser_screenshot');
  // 鼠标 / 键盘
  const click = top('鼠标点击');
  assert.equal(click[0], '@mouse_click', click.join(','));
  assert.ok(click.includes('@mouse_move') && click.includes('@browser_click'), click.join(','));
  assert.equal(top('双击')[0], '@mouse_click');
  assert.equal(top('拖拽')[0], '@mouse_drag');
  assert.equal(top('移动鼠标')[0], '@mouse_move');
  assert.ok(top('键盘输入', 3).includes('@type_text'), top('键盘输入').join(','));
  assert.equal(top('输入文字')[0], '@type_text');
  assert.equal(top('快捷键')[0], '@hotkey');
  assert.deepEqual(top('按快捷键', 2), ['keyboard_send_keys', '@hotkey']);   // 原生的也能发快捷键,同类时原生在前
  // 窗口
  assert.equal(top('关闭窗口')[0], '@close_window');
  assert.equal(top('最大化窗口')[0], '@maximize_window');
  assert.equal(top('切换窗口')[0], '@focus_window');
  assert.ok(top('窗口').slice(0, 4).every(n => /window/.test(n)), top('窗口').join(','));
  // 剪贴板
  assert.equal(top('复制到剪贴板')[0], '@set_clipboard');
  assert.equal(top('读取剪贴板')[0], '@get_clipboard');
  // 办公文档(中英混写不留空格也认得出英文词)
  assert.equal(top('excel 图表')[0], '@excel_chart');
  assert.equal(top('生成表格')[0], '@write_excel');
  assert.equal(top('读取pdf')[0], 'file_read'); // Native page renders no longer require a desktop bridge.
  assert.equal(top('读取图片')[0], 'file_read');
  assert.equal(top('幻灯片')[0], '@write_pptx');
  assert.equal(top('生成 word 文档')[0], '@write_document');
  // 识别 / 控件 / 程序与进程
  assert.equal(top('识别屏幕文字')[0], '@ocr_screen');
  assert.equal(top('查找控件')[0], '@ui_find');
  assert.equal(top('屏幕分辨率')[0], '@get_screen_info');
  assert.equal(top('启动程序')[0], '@launch_application');
  assert.equal(top('结束进程')[0], '@kill_process');
  assert.equal(top('进程列表')[0], '@list_processes');
});

test('[Z2] 结果形状不变', () => {
  // 带汉字:已有的 alias_ranker 形状(修前零命中时就是这个形状),字段一个不多
  const zh = state.search('截图', 5);
  assert.equal(zh.ok, true);
  assert.equal(zh.fallback, 'alias_ranker');
  assert.equal(zh.retrievalVersion, 'deterministic-v1');
  assert.deepEqual(Object.keys(zh).sort(), ['elapsedMs', 'fallback', 'matches', 'ok', 'packs', 'query', 'queryHash', 'retrievalVersion']);
  // args = 检索结果统一出口给未装载命中带的参数骨架(压不成骨架的不带),与本条无关,这里只容许它出现
  const keysOf = m => Object.keys(m).filter(k => k !== 'args').sort();
  for (const m of zh.matches) assert.deepEqual(keysOf(m), ['blockedReason', 'description', 'loaded', 'matchedOn', 'name', 'pack', 'score', 'tier']);
  assert.deepEqual(Object.keys(zh.packs).sort(), [...new Set(zh.matches.map(m => m.pack))].sort());
  // 纯英文:仍是修前的子串匹配,形状与排序口径都不动(名字含查询词的加权在前)
  const en = state.search('screenshot', 8);
  assert.equal(en.retrievalVersion, undefined);
  assert.equal(en.fallback, undefined);
  for (const m of en.matches) assert.deepEqual(keysOf(m), ['description', 'name', 'pack', 'tier']);
  assert.ok(en.matches.slice(0, 4).every(m => /screenshot/.test(m.name)), en.matches.map(m => m.name).join(','));
  // 带汉字但分词排序一个也没命中:照旧交回子串匹配的结果(空表),不抛
  const none = state.search('龘龘龘', 5);
  assert.equal(none.ok, true);
  assert.equal(none.retrievalVersion, undefined);
  assert.deepEqual(none.matches, []);
  // 单个汉字切不出词:只交真得分的,不拿整张目录按 0 分垫满
  const one = state.search('删', 8);
  assert.ok(one.matches.length > 0 && one.matches.every(m => m.score > 0), JSON.stringify(one.matches.map(m => [m.name, m.score])));
  assert.equal(one.matches[0].name, 'file_delete');
  assert.deepEqual(Object.keys(one.packs).sort(), [...new Set(one.matches.map(m => m.pack))].sort());
  assert.ok(state.search('截', 8).matches.every(m => m.score > 0));
  // 打开 runtimeToolRetrievalV1 时直接是 v1 排序(不带 fallback 标记),中文召回同样成立
  const v1 = srv.searchToolCatalog(state.catalog, { query: '鼠标点击', limit: 3 }, { ...cfg, runtimeToolRetrievalV1: true }, { legacyNameBoost: 3 });
  assert.equal(v1.fallback, undefined);
  assert.equal(v1.matches[0].name, `${SID}__mouse_click`);
});

test('[Z3] 别名只给桥接工具、按名字里的词生成;原生的同类工具排在桥接复本前面', () => {
  const item = n => state.catalog.find(x => x.name === n);
  assert.ok(item(`${SID}__mouse_click`).aliases.includes('鼠标点击'));
  assert.ok(item(`${SID}__screenshot`).aliases.includes('截图'));
  // 同一个名字不走桥接(没有路由)就不补:词表只服务桥接工具,原生工具的中文叫法仍只住 TOOL_RETRIEVAL_HINTS
  const plain = srv.buildToolCatalog([{ type: 'function', function: { name: 'mouse_click', description: 'x', parameters: {} } }], {}, cfg);
  assert.deepEqual(plain[0].aliases, []);
  // 与原生 file_* 重复的桥接文件工具不给别名;别的服务器里只是名字带 capture 的工具也不叫「截图」
  for (const n of ['read_file', 'delete_file', 'edit_file']) assert.deepEqual(item(`${SID}__${n}`).aliases, [], n);
  const other = name => srv.buildToolCatalog([{ type: 'function', function: { name: `net__${name}`, description: 'x', parameters: {} } }], { [`net__${name}`]: { serverId: 'net', toolName: name } }, cfg)[0].aliases;
  assert.deepEqual(other('packet_capture'), []);
  assert.ok(other('capture_screen').includes('截取屏幕'), JSON.stringify(other('capture_screen')));
  // 中文搜文件操作 / 网页 / 键盘:原生的排在前面
  const ahead = (q, a, b) => { const r = top(q, 20); const ia = r.indexOf(a); const ib = r.indexOf(b); return ia >= 0 && (ib < 0 || ia < ib); };
  assert.equal(top('删除文件')[0], 'file_delete');
  // 「移动 / 复制」也是桥接工具别名里的词(移动鼠标、复制到剪贴板),原生文件工具要排在它们前面
  assert.equal(top('移动文件')[0], 'file_move');
  assert.equal(top('复制文件')[0], 'file_copy');
  assert.equal(top('读文件')[0], 'file_read');
  assert.ok(ahead('读取文件', 'file_read', '@read_file'), top('读取文件').join(','));
  assert.ok(ahead('修改文件', 'file_edit', '@edit_file'), top('修改文件').join(','));
  assert.deepEqual(top('打开网页', 2), ['browser_open', '@browser_open']);
  assert.equal(top('键盘输入')[0], 'keyboard_send_keys');
});
