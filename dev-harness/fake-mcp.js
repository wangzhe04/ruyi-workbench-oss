// Minimal stdio JSON-RPC MCP server (MCP 2024-11-05) for OFFLINE testing of the workbench's built-in
// MCP stdio client / bridge. Speaks newline-delimited JSON-RPC on stdin/stdout.
//   initialize -> { protocolVersion, capabilities, serverInfo }
//   notifications/initialized -> (no response)
//   tools/list -> four fake tools: echo{message}, add{a,b}, screenshot_full, diagnostics
//   tools/call -> executes and returns { content:[{type:'text',text: JSON.stringify(result)}], isError }
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
];
let OPTIONAL = { ocr: true, uia: true, cv2: false, playwright: false };
try { const v = process.env.FAKE_MCP_OPTIONAL; if (v) { const o = JSON.parse(v); if (o && typeof o === 'object') OPTIONAL = { ocr: !!o.ocr, uia: !!o.uia, cv2: !!o.cv2, playwright: !!o.playwright }; } } catch { /* ignore */ }

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || !msg.method) return;
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
