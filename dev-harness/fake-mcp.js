// Minimal stdio JSON-RPC MCP server (MCP 2024-11-05) for OFFLINE testing of the workbench's built-in
// MCP stdio client / bridge. Speaks newline-delimited JSON-RPC on stdin/stdout.
//   initialize -> { protocolVersion, capabilities, serverInfo }
//   notifications/initialized -> (no response)
//   tools/list -> 20 fake tools(第46波46d 由 7 扩到 20,镜像 ACC 关键契约)
//   tools/call -> executes and returns { content:[{type:'text',text: JSON.stringify(result)}], isError }
//
// 46d 扩容原则:BRIDGED_WRITE_PATH_ARGS(02-session-store.js)15 个条目全部有 fake 对应物
// (写族真写文件,快照/回撤语义才能被离线回归);结果形状镜像 ACC 真身(write_* → {success,path,
// output_path},image_resize/window_screenshot → {ok,...}),仅 write_docx 保留旧版形状
// (无 output_path,供兼容层测试)。fake-mcp-contract.e2e.js 把「fake 写族 == 快照表键集」钉成静态锁。
'use strict';
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const TOOLS = [
  { name: 'echo', description: 'Echo a message back', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  // v0.8-S0: a read-only-named tool. Its name matches BRIDGED_TOOL_TIERS' read rule (screenshot_full),
  // so the bridged-read-noprompt e2e can assert it auto-allows in 'default' permission mode.
  { name: 'screenshot_full', description: 'Capture a full-screen screenshot (fake)', inputSchema: { type: 'object', properties: {} } },
  // v0.8-S6: a diagnostics tool so the capability matrix's desktop optional-dep probe (getCapabilities →
  // probeDesktopMcp) has something to call when this fake-mcp is wired as the ai-computer-control bridge.
  // Returns an optional-module map; FAKE_MCP_OPTIONAL (JSON) overrides which appear available.
  { name: 'diagnostics', description: 'Report optional module availability (fake)', inputSchema: { type: 'object', properties: {} } },
  // v1.5-W1.5 (T3/T4): a WRITE-family bridged tool mirroring ACC's write_docx契约 —— 真写一个文件,
  // 返回 {success:true, path:...}(旧版 ACC 形状, 不含 output_path)。用于验证:①产物收割按工具名限定
  // 收 path;②workbench 在 callTool 之前存 before 快照进 journal;③rollback 能恢复/删除。arg 名 `path`
  // 与 ACC write_document/write_excel/write_pdf 一致。
  { name: 'write_docx', description: 'Write a fake .docx file (mirrors ACC write_document契约)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'] } },
  // v1.2-B: move/copy 桥接工具, 参数名与 ACC filesystem.py 一致(source/destination)。真动文件, 返回
  // {success:true, source, destination}(ACC move_file/copy_file 契约)。用于验证 workbench 的两条式/单条式
  // before 快照(journalBridgedWrite 多目标)+ rollback 逆序恢复。
  { name: 'move_file', description: 'Move/rename a file (mirrors ACC move_file契约: source→destination)', inputSchema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' } }, required: ['source', 'destination'] } },
  { name: 'copy_file', description: 'Copy a file (mirrors ACC copy_file契约: source→destination)', inputSchema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' } }, required: ['source', 'destination'] } },
  // ── 第46波46d: +13 件,凑齐 20 件并覆盖 BRIDGED_WRITE_PATH_ARGS 全表 ──────────────────────────
  // read 族代表(ACC read_file 契约:{content,size};max_bytes 是【字节】预算)。
  { name: 'read_file', description: 'Read text file (mirrors ACC read_file契约)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, max_bytes: { type: 'number' } }, required: ['path'] } },
  // write_file(ACC filesystem.write_file 契约:{success, bytes_written};支持 append)。
  { name: 'write_file', description: 'Write/append text file (mirrors ACC write_file契约)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, required: ['path', 'content'] } },
  // Office 四件套(ACC v1.7 形状:{success, path, output_path, ...} —— 含 output_path 的新形状)。
  { name: 'write_document', description: 'Write fake .docx (mirrors ACC write_document新形状:含 output_path)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, title: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'write_excel', description: 'Write fake .xlsx (mirrors ACC write_excel契约)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, data: { type: 'array' }, headers: { type: 'array' } }, required: ['path', 'data'] } },
  { name: 'write_pdf', description: 'Write fake .pdf (mirrors ACC write_pdf契约:非 .pdf 路径报错)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'write_pptx', description: 'Write fake .pptx (mirrors ACC write_pptx契约:slides 规格)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, slides: { type: 'array' } }, required: ['path', 'slides'] } },
  // 同路径再造型类(beautify/chart 改写既有文件;46d 契约镜像,文件必须已存在否则报错)。
  { name: 'excel_beautify', description: 'Beautify existing .xlsx (mirrors ACC excel_beautify契约)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, style: { type: 'string' } }, required: ['path'] } },
  { name: 'excel_chart', description: 'Insert chart into existing .xlsx (mirrors ACC excel_chart契约)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, sheet: { type: 'string' }, chart_type: { type: 'string' }, data_range: { type: 'string' }, title: { type: 'string' } }, required: ['path', 'sheet', 'chart_type', 'data_range', 'title'] } },
  { name: 'chart_image', description: 'Render chart .png (mirrors ACC chart_image契约)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, chart_type: { type: 'string' }, data: { type: 'object' }, title: { type: 'string' } }, required: ['path', 'chart_type', 'data', 'title'] } },
  // 图像缩放(ACC v1.8 image_resize 契约:ok 包络 + original_size/new_size;output_path 必填)。
  { name: 'image_resize', description: 'Resize image (mirrors ACC image_resize契约:ok包络)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, output_path: { type: 'string' }, width: { type: 'number' }, scale: { type: 'number' } }, required: ['path', 'output_path'] } },
  // 抓图类:仅当给了落盘路径参数才产出文件(否则回 base64 —— collectBridgedWriteTargets 缺参跳过的语义)。
  { name: 'window_screenshot', description: 'Screenshot a window (mirrors ACC window_screenshot契约:output_path 可选)', inputSchema: { type: 'object', properties: { title_substring: { type: 'string' }, output_path: { type: 'string' } }, required: ['title_substring'] } },
  { name: 'get_clipboard_image', description: 'Read clipboard image (mirrors ACC get_clipboard_image契约:save_path 可选)', inputSchema: { type: 'object', properties: { save_path: { type: 'string' } } } },
  // 删除(ACC delete_file 契约:{success:true};快照表 op:delete → 回滚=写回)。
  { name: 'delete_file', description: 'Delete a file (mirrors ACC delete_file契约)', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  // 47b 桥 cancel/超时契约测试件:慢工具 —— sleep args.ms(默认 30000)后才返回,期间不响应任何
  // notifications(模拟不协作取消的 ACC 僵尸执行)。配合 FAKE_MCP_NOTIFY_CAPTURE 断言桥发了 cancelled。
  { name: 'slow_task', description: 'Sleep ms then return (47b 桥超时契约测试件)', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  // ── 第49波49b: ACC v1.9 生态工具首批镜像(契约对齐真身) ──
  { name: 'edit_file', description: 'Partial edit via exact-string replacement (mirrors ACC edit_file契约:唯一性闸)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'fetch', description: 'Fetch a URL with SSRF guard (mirrors ACC fetch契约, fake 不联网)', inputSchema: { type: 'object', properties: { url: { type: 'string' }, max_bytes: { type: 'number' }, timeout: { type: 'number' } }, required: ['url'] } },
  { name: 'memory_save', description: 'Save a memory entry (mirrors ACC memory_save契约)', inputSchema: { type: 'object', properties: { key: { type: 'string' }, content: { type: 'string' }, tags: { type: 'string' } }, required: ['key', 'content'] } },
  { name: 'memory_read', description: 'Read a memory entry (mirrors ACC memory_read契约)', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'memory_list', description: 'List memory entries (mirrors ACC memory_list契约)', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'memory_delete', description: 'Delete a memory entry (mirrors ACC memory_delete契约)', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'sequential_thinking', description: 'Record a thinking step (mirrors ACC sequential_thinking契约)', inputSchema: { type: 'object', properties: { thought: { type: 'string' }, thought_number: { type: 'number' }, total_thoughts: { type: 'number' }, next_thought_needed: { type: 'boolean' } }, required: ['thought', 'thought_number', 'total_thoughts', 'next_thought_needed'] } },
];
let OPTIONAL = { ocr: true, uia: true, cv2: false, playwright: false };
try { const v = process.env.FAKE_MCP_OPTIONAL; if (v) { const o = JSON.parse(v); if (o && typeof o === 'object') OPTIONAL = { ocr: !!o.ocr, uia: !!o.uia, cv2: !!o.cv2, playwright: !!o.playwright }; } } catch { /* ignore */ }
// 47b:pid 捕获(追加,一行一个)—— 让 e2e 能断言"第一个 fake-mcp 超时后确实被杀、重连的新 pid 活着"。
if (process.env.FAKE_MCP_PID_CAPTURE) { try { fs.appendFileSync(process.env.FAKE_MCP_PID_CAPTURE, String(process.pid) + '\n', 'utf8'); } catch { /* ignore */ } }

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || !msg.method) return;
  // 47b:通知捕获 —— FAKE_MCP_NOTIFY_CAPTURE 落盘全部 notification(无 id 的帧,如 notifications/cancelled)。
  if (msg.id === undefined && process.env.FAKE_MCP_NOTIFY_CAPTURE) {
    try { fs.appendFileSync(process.env.FAKE_MCP_NOTIFY_CAPTURE, JSON.stringify(msg) + '\n', 'utf8'); } catch { /* ignore */ }
  }
  try {
    if (msg.method === 'initialize') {
      return send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      } });
    }
    if (msg.method === 'notifications/initialized') return; // notification: no reply
    if (msg.method === 'tools/list') {
      return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    }
    if (msg.method === 'tools/call') {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      let result, isError = false;
      if (name === 'echo') {
        result = { ok: true, echoed: String(args.message == null ? '' : args.message) };
      } else if (name === 'add') {
        const a = Number(args.a), b = Number(args.b);
        if (!Number.isFinite(a) || !Number.isFinite(b)) { result = { ok: false, error: 'a and b must be numbers' }; isError = true; }
        else result = { ok: true, sum: a + b };
      } else if (name === 'screenshot_full') {
        result = { ok: true, image: 'FAKE_IMAGE_B64', width: 100, height: 100 };
      } else if (name === 'diagnostics') {
        result = { ok: true, optional: { ...OPTIONAL } };
      } else if (name === 'write_docx') {
        // 真写文件(内容默认可控),返回 ACC 旧版 write_document 形状 {success:true, path:abs}(无 output_path)。
        // 这样 T4 能证明「工具名限定的 path 收割」在 output_path 缺席时仍生效(对已装旧版 ACC 的兼容层)。
        try {
          const p = String(args.path || '');
          if (!p) { result = { error: 'path is required' }; isError = true; }
          else {
            fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
            fs.writeFileSync(p, String(args.content == null ? 'FAKE_DOCX_BODY' : args.content), 'utf8');
            result = { success: true, path: path.resolve(p) };
          }
        } catch (e) { result = { error: (e && e.message) || String(e) }; isError = true; }
      } else if (name === 'move_file') {
        // 真 move:source → destination(ACC move_file 契约,参数名 source/destination)。
        try {
          const s = String(args.source || ''), d = String(args.destination || '');
          if (!s || !d) { result = { error: 'source and destination are required' }; isError = true; }
          else {
            fs.mkdirSync(path.dirname(path.resolve(d)), { recursive: true });
            fs.renameSync(s, d);
            result = { success: true, source: path.resolve(s), destination: path.resolve(d) };
          }
        } catch (e) { result = { error: (e && e.message) || String(e) }; isError = true; }
      } else if (name === 'copy_file') {
        // 真 copy:source → destination(source 不变;ACC copy_file 契约)。
        try {
          const s = String(args.source || ''), d = String(args.destination || '');
          if (!s || !d) { result = { error: 'source and destination are required' }; isError = true; }
          else {
            fs.mkdirSync(path.dirname(path.resolve(d)), { recursive: true });
            fs.copyFileSync(s, d);
            result = { success: true, source: path.resolve(s), destination: path.resolve(d) };
          }
        } catch (e) { result = { error: (e && e.message) || String(e) }; isError = true; }
      // ── 第46波46d: 13 件新契约的 handler ─────────────────────────────────────────────
      } else if (name === 'read_file') {
        // ACC read_file 契约:{content, size};max_bytes 字节预算截断(返回截断后的内容)。
        try {
          const p = String(args.path || '');
          const maxB = Number.isFinite(args.max_bytes) ? args.max_bytes : 1000000;
          const buf = fs.readFileSync(p);
          const sliced = buf.subarray(0, Math.max(0, maxB));
          result = { ok: true, content: sliced.toString('utf8'), size: buf.length };
        } catch (e) { result = { ok: false, error: (e && e.code === 'ENOENT' ? '文件不存在: ' + args.path : (e && e.message) || String(e)) }; isError = true; }
      } else if (name === 'write_file') {
        // ACC write_file 契约:{success, bytes_written};append 可选;自动建父目录。
        try {
          const p = String(args.path || '');
          if (!p) { result = { error: 'path is required' }; isError = true; }
          else {
            fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
            const content = String(args.content == null ? '' : args.content);
            if (args.append) fs.appendFileSync(p, content, 'utf8'); else fs.writeFileSync(p, content, 'utf8');
            result = { success: true, bytes_written: Buffer.byteLength(content, 'utf8') };
          }
        } catch (e) { result = { error: (e && e.message) || String(e) }; isError = true; }
      } else if (name === 'write_document' || name === 'write_excel' || name === 'write_pdf' || name === 'write_pptx') {
        // Office 四件套,ACC v1.7 新形状:{success, path, output_path, ...}。write_pdf 镜像「非 .pdf 报错」契约。
        try {
          const p = String(args.path || '');
          if (!p) { result = { error: 'path is required' }; isError = true; }
          else if (name === 'write_pdf' && !p.toLowerCase().endsWith('.pdf')) { result = { ok: false, error: 'path must end with .pdf' }; isError = true; }
          else {
            fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
            const body = 'FAKE_' + name.toUpperCase() + '\n' + JSON.stringify(args).slice(0, 400);
            fs.writeFileSync(p, body, 'utf8');
            const abs = path.resolve(p);
            if (name === 'write_document') result = { success: true, path: abs, output_path: abs, style: String(args.style || 'business') };
            else if (name === 'write_excel') result = { success: true, path: abs, output_path: abs, rows: Array.isArray(args.data) ? args.data.length : 0, style: 'business' };
            else if (name === 'write_pdf') result = { success: true, path: abs, output_path: abs, pages: 1, font: 'FakeCJK' };
            else result = { success: true, path: abs, output_path: abs, slides: Array.isArray(args.slides) ? args.slides.length : 0, style: 'business' };
          }
        } catch (e) { result = { error: (e && e.message) || String(e) }; isError = true; }
      } else if (name === 'excel_beautify' || name === 'excel_chart') {
        // 改写既有文件:文件必须已存在(镜像 ACC 对不存在路径报错的契约);存在则追加标记字节。
        try {
          const p = String(args.path || '');
          if (!p || !fs.existsSync(p)) { result = { error: '文件不存在: ' + (p || '(空)') }; isError = true; }
          else {
            fs.appendFileSync(p, '\n[FAKE_' + name.toUpperCase() + ']', 'utf8');
            const abs = path.resolve(p);
            result = name === 'excel_beautify'
              ? { success: true, path: abs, output_path: abs, sheet: 'Sheet1', style: String(args.style || 'business'), rows: 1, cols: 1 }
              : { success: true, path: abs, output_path: abs, sheet: String(args.sheet || 'Sheet1'), chart_type: String(args.chart_type || 'bar'), anchor: String(args.target_cell || 'H2'), x_title: '', y_title: '' };
          }
        } catch (e) { result = { error: (e && e.message) || String(e) }; isError = true; }
      } else if (name === 'chart_image') {
        // ACC chart_image 契约:{success, path, output_path, chart_type, style, font, bytes}。
        try {
          const p = String(args.path || '');
          if (!p) { result = { error: 'path is required' }; isError = true; }
          else {
            fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
            const body = 'FAKE_PNG_BYTES';
            fs.writeFileSync(p, body, 'utf8');
            const abs = path.resolve(p);
            result = { success: true, path: abs, output_path: abs, chart_type: String(args.chart_type || 'bar'), style: 'business', font: 'FakeCJK', bytes: body.length };
          }
        } catch (e) { result = { error: (e && e.message) || String(e) }; isError = true; }
      } else if (name === 'image_resize') {
        // ACC image_resize 契约(ok 包络):{ok, path, output_path, original_size, new_size, format}。
        try {
          const p = String(args.path || ''), o = String(args.output_path || '');
          if (!p || !o) { result = { ok: false, error: 'path and output_path are required' }; isError = true; }
          else if (!fs.existsSync(p)) { result = { ok: false, error: '文件不存在: ' + p }; isError = true; }
          else {
            fs.mkdirSync(path.dirname(path.resolve(o)), { recursive: true });
            fs.copyFileSync(p, o); // fake:不真缩放,复制即可(契约关心的是落盘与形状)
            const scale = Number.isFinite(args.scale) ? args.scale : (Number.isFinite(args.width) ? 0.5 : 1);
            result = { ok: true, path: path.resolve(p), output_path: path.resolve(o), original_size: [100, 80], new_size: [Math.round(100 * scale), Math.round(80 * scale)], format: 'PNG' };
          }
        } catch (e) { result = { ok: false, error: (e && e.message) || String(e) }; isError = true; }
      } else if (name === 'window_screenshot') {
        // ACC window_screenshot 契约:给 output_path → {ok, path, ...};不给 → {ok, image_base64, ...}。
        const o = String(args.output_path || '');
        if (o) {
          try {
            fs.mkdirSync(path.dirname(path.resolve(o)), { recursive: true });
            fs.writeFileSync(o, 'FAKE_WINDOW_PNG', 'utf8');
            result = { ok: true, matched_title: String(args.title_substring || ''), width: 100, height: 80, scale: 1.0, path: path.resolve(o) };
          } catch (e) { result = { ok: false, error: (e && e.message) || String(e) }; isError = true; }
        } else {
          result = { ok: true, matched_title: String(args.title_substring || ''), width: 100, height: 80, scale: 1.0, image_base64: 'RkFLRV9XSU5ET1dfUE5H' };
        }
      } else if (name === 'get_clipboard_image') {
        // ACC get_clipboard_image 契约:给 save_path → {has_image, path, size};不给 → {has_image, image_base64}。
        const s = String(args.save_path || '');
        if (s) {
          try {
            fs.mkdirSync(path.dirname(path.resolve(s)), { recursive: true });
            fs.writeFileSync(s, 'FAKE_CLIP_PNG', 'utf8');
            result = { has_image: true, path: path.resolve(s), size: 13 };
          } catch (e) { result = { has_image: false, error: (e && e.message) || String(e) }; isError = true; }
        } else {
          result = { has_image: true, image_base64: 'RkFLRV9DTElQX1BORw==' };
        }
      } else if (name === 'delete_file') {
        // ACC delete_file 契约:{success:true};不存在则报错(与真身一致)。
        try {
          const p = String(args.path || '');
          if (!p) { result = { error: 'path is required' }; isError = true; }
          else { fs.rmSync(p, { force: false }); result = { success: true }; }
        } catch (e) { result = { error: (e && e.message) || String(e) }; isError = true; }
      } else if (name === 'slow_task') {
        // 47b 测试件:sleep ms(默认 30000)才返回 —— 桥超时远小于此时,用于验证 cancelled + 杀进程树。
        const ms = Math.max(0, Number(args.ms) || 30000);
        setTimeout(() => {
          send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, slept: ms }) }], isError: false } });
        }, ms);
        return; // 异步应答:本帧不立即 send
      // ── 第49波49b: ACC v1.9 生态工具首批 handler ────────────────────────────────────
      } else if (name === 'edit_file') {
        // 镜像 ACC edit_file 契约:唯一性闸(0 次/多次均报错,replace_all 除外)+ {success, replacements, output_path}。
        try {
          const p = String(args.path || '');
          if (!p || !fs.existsSync(p)) { result = { error: 'file not found: ' + (p || '(空)') }; isError = true; }
          else {
            const text = fs.readFileSync(p, 'utf8');
            const oldS = String(args.old_string == null ? '' : args.old_string);
            const newS = String(args.new_string == null ? '' : args.new_string);
            const count = oldS ? text.split(oldS).length - 1 : 0;
            if (!oldS) { result = { error: 'old_string 为空' }; isError = true; }
            else if (count === 0) { result = { error: 'old_string 在文件中未出现(0 次)' }; isError = true; }
            else if (count > 1 && !args.replace_all) { result = { error: 'old_string 出现 ' + count + ' 次,不唯一' }; isError = true; }
            else {
              const replaced = args.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, newS);
              fs.writeFileSync(p, replaced, 'utf8');
              result = { success: true, replacements: args.replace_all ? count : 1, output_path: path.resolve(p) };
            }
          }
        } catch (e) { result = { error: (e && e.message) || String(e) }; isError = true; }
      } else if (name === 'fetch') {
        // fake 不联网:镜像 ok 包络 + 内网拒绝契约(127.0.0.1/localhost 直接拒,验证 SSRF 形状)。
        const u = String(args.url || '');
        if (!u) { result = { ok: false, error: 'url is required' }; isError = true; }
        else if (/^(https?:\/\/)?(127\.|localhost|192\.168\.|10\.|169\.254\.|\[::1\])/.test(u)) {
          result = { ok: false, error: 'refused: 目标主机指向本机/内网(SSRF 防护)。' }; isError = true;
        } else {
          result = { ok: true, url: u, status: 200, content_type: 'text/plain; charset=utf-8', content: 'FAKE_FETCH_BODY for ' + u, bytes: 21 + u.length, truncated: false, redirects: 0 };
        }
      } else if (name === 'memory_save' || name === 'memory_read' || name === 'memory_list' || name === 'memory_delete') {
        // 进程内记忆(契约形状镜像;不落盘 —— 真身落盘行为由 ACC smoke_v19 覆盖)。
        global.__fakeMemory = global.__fakeMemory || {};
        const store = global.__fakeMemory;
        if (name === 'memory_save') {
          const k = String(args.key || '');
          if (!k) { result = { error: 'key 为空' }; isError = true; }
          else {
            const overwritten = k in store;
            store[k] = { content: String(args.content == null ? '' : args.content), tags: String(args.tags || '').split(',').map(s => s.trim()).filter(Boolean), updated: '2026-01-01T00:00:00' };
            result = { success: true, key: k, updated: store[k].updated, overwritten };
          }
        } else if (name === 'memory_read') {
          const e = store[String(args.key || '')];
          result = e ? { found: true, key: String(args.key), content: e.content, tags: e.tags, updated: e.updated } : { ok: true, found: false, key: String(args.key || '') };
        } else if (name === 'memory_list') {
          const q = String(args.query || '').toLowerCase();
          const entries = Object.keys(store).filter(k => !q || k.toLowerCase().includes(q) || store[k].content.toLowerCase().includes(q))
            .map(k => ({ key: k, preview: store[k].content.slice(0, 120), tags: store[k].tags, updated: store[k].updated }));
          result = { ok: true, entries, total: entries.length, capped: false };
        } else {
          const k = String(args.key || '');
          const deleted = k in store; delete store[k];
          result = { success: true, deleted, key: k };
        }
      } else if (name === 'sequential_thinking') {
        // 镜像 ACC sequential_thinking 契约形状(不维护真链,回显+最小校验)。
        if (!String(args.thought || '').trim()) { result = { ok: false, error: 'thought 为空' }; isError = true; }
        else result = { ok: true, thought_number: Number(args.thought_number) || 1, total_thoughts: Number(args.total_thoughts) || 1, next_thought_needed: !!args.next_thought_needed, thought_history_length: Number(args.thought_number) || 1, branches: [] };
      } else {
        result = { ok: false, error: 'unknown tool: ' + name }; isError = true;
      }
      return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError } });
    }
    // Unknown method with an id: reply with an empty result so a client won't hang.
    if (msg.id !== undefined) return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } catch (e) {
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: (e && e.message) || String(e) } });
  }
});
