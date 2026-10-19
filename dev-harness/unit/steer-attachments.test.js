'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { functionBlock } = require('../lib/source-slice');
const { fixture: composerFixture } = require('../lib/composer-race-fixture');
const src = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const read = file => fs.readFileSync(path.join(src, file), 'utf8');
const domain = read('13b-api-domain-routes.js');
const steering = domain.slice(domain.indexOf('const STEER_REFUSAL ='), domain.indexOf('// ── steer 域:'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZzXcAAAAASUVORK5CYII=', 'base64');
function backend(t, kind = 'openai') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steer-images-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const uploads = path.join(home, 'uploads'); fs.mkdirSync(path.join(uploads, 'image1'), { recursive: true });
  fs.writeFileSync(path.join(uploads, 'image1', 'picture.png'), PNG);
  const attachment = { id: 'image1', name: 'picture.png', path: 'untrusted-path.png' };
  const session = { id: 'sess_image', turnSeq: 1, messages: [], providerHistory: [] };
  const reg = { kind, session, state: 'running', interactive: true, vision: true, steerQueue: [] };
  const regs = new Map([[session.id, reg]]), events = [], writes = [];
  const c = vm.createContext({ require, fs, fsp, path, Buffer, Date, paths: { uploads }, activeChildren: regs, STEER_QUEUE_MAX: 3,
    safeSessionId: s => /^sess_\w+$/.test(String(s)) ? s : '', nowIso: () => new Date().toISOString(),
    saveSession: async () => {}, hasPendingQuestionForSession: () => false,
    writeToChild: (sid, envelope) => { writes.push(envelope); return true; }, logEvent() {},
  });
  const bridge = read('03-bridge-guard.js');
  vm.runInContext(read('04-visual-pipeline.js') + '\n' + functionBlock(bridge, 'pathWithinRoot') + '\n' +
    functionBlock(bridge, 'buildAttachmentPrompt') + '\n' + functionBlock(read('04-permission-runtime.js'), 'sanitizeFsSegmentName') + '\n' +
    functionBlock(read('01-config.js'), 'buildUserEnvelope') + '\n' + steering + '\n' +
    'Object.assign(SteerAttachmentHooks, { pathWithinRoot, buildAttachmentPrompt });\n' +
    functionBlock(read('07-autonomy.js'), 'drainSteerQueue') + '\n' + functionBlock(read('02c-turn-segments.js'), 'createTurnSegmentBuilder'), c);
  reg.onEvent = event => events.push(event);
  return { c, reg, session, regs, attachment, events, writes };
}

test('provider 插话将上传图片真正放进模型消息,正文、事件和叙事账本均保留附件', async t => {
  const h = backend(t);
  const queued = await h.c.steerSessionCore({ sessionId: h.session.id, text: '再看看这张图', attachments: [h.attachment] });
  assert.equal(queued.body.ok, true);
  assert.notEqual(h.reg.steerQueue[0].attachments[0].path, h.attachment.path);
  await h.c.drainSteerQueue(h.reg, h.session, h.reg.onEvent);
  const content = h.session.providerHistory[0].content;
  assert.equal(content[1].type, 'image_url'); assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(h.session.messages[0].attachments[0].id, 'image1');
  assert.equal(h.events[0].attachments[0].id, 'image1');
  const builder = h.c.createTurnSegmentBuilder(); builder.consume(h.events[0]);
  assert.equal(builder.snapshot()[0].attachments[0].id, 'image1');
});

test('Claude 即时插话收到原生 image 块;Kimi 同会话后续队列保留图片记录', async t => {
  const h = backend(t, 'claude');
  const sent = await h.c.steerSessionCore({ sessionId: h.session.id, text: '补图', attachments: [h.attachment] });
  assert.equal(sent.body.injected, true);
  const image = h.writes[0].message.content.find(p => p.type === 'image');
  assert.equal(image.source.media_type, 'image/png'); assert.equal(image.source.data, PNG.toString('base64'));
  assert.equal(h.session.messages[0].attachments.length, 1);
  const k = backend(t, 'kimi-acp');
  assert.equal((await k.c.steerSessionCore({ sessionId: k.session.id, attachments: [k.attachment] })).body.ok, true);
  assert.equal(k.reg.steerQueue[0].attachments[0].id, 'image1');
  assert.match(k.reg.steerQueue[0].text, /picture.png/);
});

test('插话附件拒绝路径伪造/缺失记录,失败不排队;文字模型保留附件引用', async t => {
  const h = backend(t);
  for (const a of [{ ...h.attachment, name: '../outside.png' }, { ...h.attachment, id: 'missing' }]) {
    assert.equal((await h.c.steerSessionCore({ sessionId: h.session.id, text: 'x', attachments: [a] })).kind, 'failure');
  }
  assert.equal(h.reg.steerQueue.length, 0);
  h.reg.vision = false;
  await h.c.steerSessionCore({ sessionId: h.session.id, text: '看图', attachments: [h.attachment] });
  await h.c.drainSteerQueue(h.reg, h.session, h.reg.onEvent);
  assert.equal(typeof h.session.providerHistory[0].content, 'string');
  assert.match(h.session.providerHistory[0].content, /picture.png/);
});

test('composer 图片插话发送附件,只清理发出的快照;失败或仍在上传时保留草稿', async () => {
  const f = composerFixture();
  const first = { id: 'image1', name: 'picture.png' }, later = { id: 'image2', name: 'later.png' };
  f.state.attachments = [first];
  const pending = f.send('看图');
  assert.equal(f.calls[0].body.attachments[0].id, 'image1');
  f.state.attachments.push(later); f.response.resolve({ ok: true }); await pending;
  assert.deepEqual(f.state.attachments, [later]); assert.equal(f.rows[0].attachments[0].id, 'image1');
  const failed = composerFixture(); failed.state.attachments = [first];
  const rejected = failed.send('保留'); failed.response.resolve({ ok: false }); await rejected;
  assert.equal(failed.state.attachments.length, 1); assert.equal(failed.nodes.promptInput.value, '保留');
  failed.state.uploading = 1; await failed.runtime.sendPrompt(); assert.equal(failed.calls.length, 1);
  const imageOnly = composerFixture(); imageOnly.state.attachments = [first];
  const justImage = imageOnly.send(''); assert.equal(imageOnly.calls[0].body.attachments.length, 1);
  imageOnly.response.resolve({ ok: true }); await justImage;
  assert.equal(imageOnly.state.attachments.length, 0);
  const ended = composerFixture(); ended.state.attachments = [first];
  ended.send('接着看').catch(() => {});
  ended.state.attachments.push(later);
  ended.response.resolve({ ok: false, error: { code: 'steer.no_live_turn' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended.streams[0].body.attachments.length, 1, '回合已结束时按原附件快照发新消息');
  assert.equal(ended.streams[0].body.attachments[0].id, 'image1');
  assert.deepEqual(ended.state.attachments, [later], '请求在飞时后加的附件留给下一条');
});

test('真实 HTTP 回合的下一次 provider 请求包含插话图片,会话保持同一回合', { timeout: 60000 }, async t => {
  const http = require('node:http'), cp = require('node:child_process');
  const { startFakeProvider, textFrames } = require('../lib/fake-openai-provider');
  const { getFreePort } = require('../free-port');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steer-http-image-'));
  let releaseFirst, sawFirst;
  const hold = new Promise(resolve => { releaseFirst = resolve; });
  const first = new Promise(resolve => { sawFirst = resolve; });
  let firstChat = true;
  const fake = await startFakeProvider({ handler: async () => {
    if (firstChat) { firstChat = false; sawFirst(); await hold; }
    return textFrames('已处理');
  } });
  const port = await getFreePort();
  fs.mkdirSync(path.join(home, 'uploads', 'image1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'uploads', 'image1', 'picture.png'), PNG);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    defaultWorkspace: home, engineMode: 'interactive', activeProvider: 'fake', permissionMode: 'default',
    includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false, externalMcpServers: [],
    stewardEnabledV1: false, stewardThreadBriefV1: false, desktopMcp: { enabled: false },
    providers: [{ id: 'fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'fixture', model: 'fake-model', vision: true }],
  }));
  const child = cp.spawn(process.execPath, [path.join(src, '../server.js'), 'serve', '--port', String(port)], {
    env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') },
    windowsHide: true, stdio: 'ignore',
  });
  t.after(async () => { releaseFirst(); child.kill(); await fake.close(); fs.rmSync(home, { recursive: true, force: true }); });
  let token = '';
  for (let i = 0; i < 200; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { /* boot */ }
    if (token) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(token, 'workbench starts');
  const request = (route, payload) => new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', timeout: 30000,
      headers: { 'x-wcw-token': token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let body = ''; res.on('data', data => { body += data; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('HTTP timeout'))); req.end(raw);
  });
  const created = JSON.parse((await request('/api/sessions', { cwd: home, title: '带图插话' })).body);
  const sid = created.session.id;
  const chat = request('/api/chat/stream', { sessionId: sid, message: '先检查', cwd: home });
  await Promise.race([first, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('provider did not receive first request')), 20000); timer.unref(); })]);
  const receipt = await request('/api/steer', { sessionId: sid, text: '再看这张图', attachments: [{ id: 'image1', name: 'picture.png' }] });
  assert.equal(JSON.parse(receipt.body).ok, true, receipt.body);
  releaseFirst(); const settled = await chat;
  assert.equal(settled.status, 200);
  assert.ok(fake.requests.some(req => req.messages.some(m => m.role === 'user' && Array.isArray(m.content)
    && m.content.some(p => p.type === 'image_url' && p.image_url.url === 'data:image/png;base64,' + PNG.toString('base64')))), 'actual provider request contains pixels');
  const stored = fs.readFileSync(path.join(home, 'sessions', sid + '.messages.ndjson'), 'utf8');
  assert.match(stored, /"steered":true/); assert.match(stored, /picture.png/);
});
