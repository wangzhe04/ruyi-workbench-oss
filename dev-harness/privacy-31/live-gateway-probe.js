'use strict';
// Manual, explicitly authorized probe: synthetic files only, real configured credentials used solely for authentication.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), crypto = require('node:crypto');
const { createRunner } = require('../lib/harness');
const t = createRunner('PRIVACY GATEWAY LIVE PROBE');
async function main() {
  if (!process.argv.includes('--live')) throw Error('explicit_live_flag_required');
  const configArg = process.argv.find(value => value.startsWith('--config='));
  const file = configArg ? path.resolve(configArg.slice(9)) : [process.env.RUYI_HOME && path.join(process.env.RUYI_HOME, 'config.json'), path.join(os.homedir(), '.ruyi-workbench/config.json'), path.join(os.homedir(), '.win-claude-workbench/config.json')].filter(Boolean).find(value => fs.existsSync(value));
  if (!file) throw Error('configuration_not_found');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')), selected = (saved.providers || []).find(value => value.id === saved.activeProvider);
  if (!selected?.apiKey || !selected?.model || !selected?.baseUrl) throw Error('configured_plaintext_endpoint_unavailable');
  const provider = { id: 'fixture-live', type: 'openai-compat', model: selected.model, apiStyle: selected.apiStyle, apiKey: selected.apiKey, extraHeaders: selected.extraHeaders, baseUrl: selected.baseUrl,
    serverWebSearch: false, anthropicThinking: 'off', reasoning: false };
  require('../lib/self-isolate-home');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-live-gateway-')), data = path.join(root, 'data'), work = path.join(root, 'work');
  fs.mkdirSync(data); fs.mkdirSync(work); process.env.RUYI_HOME = data; process.env.WIN_CLAUDE_WORKBENCH_HOME = data;
  const app = require('../lib/server-internals').loadServerInternals(['runSessionTurn', 'createSession', 'mutateConfig', 'providerWireProtocol']);
  const wire = app.providerWireProtocol(provider), target = new URL(wire.completionUrl(provider.baseUrl));
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))) throw Error('endpoint_transport_refused');
  const marker = crypto.randomBytes(6).toString('hex'), email = 'fixture-' + marker + '@example.test', key = 'sk-fixture-' + crypto.randomBytes(20).toString('hex'), employee = 'STAFF-' + marker;
  fs.writeFileSync(path.join(work, 'contact.json'), JSON.stringify({ email, apiKey: key, employee }));
  let count = 0, leak = false, inputTokens = 0, outputTokens = 0; const started = Date.now();
  const proxy = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || count >= 6 || Date.now() - started > 180000) { res.writeHead(429); res.end('{}'); return; }
      let raw = ''; for await (const part of req) raw += part;
      if ([email, key, employee, provider.apiKey].some(value => raw.includes(value))) { leak = true; throw Error('private_request_refused'); }
      count++;
      const upstream = await fetch(target, { method: 'POST', redirect: 'error', headers: wire.requestHeaders(provider, { model: provider.model }), body: raw, signal: AbortSignal.timeout(45000) });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      for await (const part of upstream.body) res.write(part); res.end();
    } catch { if (!res.headersSent) res.writeHead(502); res.end('{}'); }
  });
  try {
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const local = { ...provider, baseUrl: 'http://127.0.0.1:' + proxy.address().port };
    await app.mutateConfig(current => { Object.assign(current, { credentialEncryptionV1: true, providers: [local], activeProvider: local.id, privacyModeV1: 'enhanced', privacyRulesV1: [{ id: 'staff', kind: 'regex', value: 'STAFF-[a-f0-9]{12}', category: 'INTERNAL' }], defaultWorkspace: work,
      permissionMode: 'acceptEdits', toolLoadingMode: 'auto', bridgeExternalToolsToProvider: false, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, importAgentInstructions: false, stewardEnabledV1: false, schedulerEnabledV1: false, allowCommandTools: false, allowDesktopTools: false, openaiMaxToolIterations: 4 }); return {}; });
    const session = await app.createSession({ cwd: work, title: 'synthetic privacy test' });
    await app.runSessionTurn({ sessionId: session.id, message: '这是合成数据兼容测试。先用 file_read 读取当前目录 contact.json，然后只取 email 和 employee 两个字段，用 file_write 将这两个字段的值各占一行写入 restored.txt（第一行 email，第二行 employee，不加标签）。遇到本地隐私代号时原样复制，不解码、不猜测。不使用 apiKey，不调用其他工具。完成后只回答完成。', onEvent: event => { if (event.type === 'usage') { inputTokens += Number(event.usage?.input_tokens || 0); outputTokens += Number(event.usage?.output_tokens || 0); } } });
    const output = path.join(work, 'restored.txt');
    t.ok(count >= 2 && !leak, 'real production HTTP requests carry references without synthetic private originals');
    t.ok(fs.existsSync(output) && fs.readFileSync(output, 'utf8').trim() === email + '\n' + employee, 'real model reuses builtin and worker-regex references and the production file tool restores both originals');
    const disk = fs.readdirSync(path.join(data, 'privacy-scopes')).map(name => fs.readFileSync(path.join(data, 'privacy-scopes', name), 'utf8')).join('');
    t.ok(!disk.includes(email) && !disk.includes(key) && !disk.includes(employee), 'production reference maps persist as authenticated ciphertext');
    console.log(JSON.stringify({ model: provider.model, requests: count, inputTokens: inputTokens || null, outputTokens: outputTokens || null, elapsedMs: Date.now() - started }));
  } finally { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('ruyi-live-gateway-')) throw Error('cleanup_scope'); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => t.fail('probe failed: ' + (/^[a-z_]+$/.test(error.message || '') ? error.message : 'sanitized_failure'))).finally(() => t.done({ exit: true }));
