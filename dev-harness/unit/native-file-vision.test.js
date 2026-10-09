'use strict';
require('../lib/self-isolate-home.js');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { startFakeProvider, textFrames, toolCallFrames } = require('../lib/fake-openai-provider');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-native-vision-'));
const ws = path.join(root, 'workspace');
const home = path.join(root, 'data');
fs.mkdirSync(ws); fs.mkdirSync(home);
process.env.RUYI_HOME = home;
process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
if (process.env.RUYI_NATIVE_READ_TEST_PYTHON) process.env.RUYI_BUNDLED_PYTHON = process.env.RUYI_NATIVE_READ_TEST_PYTHON;
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const srv = require(path.join(app, 'server.js'));
const V = srv.dispatchTestHooks.VisualPipeline;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join(ws, 'pic.png'), png);
fs.writeFileSync(path.join(ws, 'renamed.dat'), png);
const config = { defaultWorkspace: ws, workspaces: [{ path: ws, read: true, write: true, execute: true }], permissionMode: 'bypass',
  includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [],
  toolLoadingMode: 'full', allowDesktopTools: false, stewardEnabledV1: true, stewardThreadBriefV1: false };
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
const ctx = () => ({ config, workingDir: ws, session: { id: 'visiontest', cwd: ws } });
const read = args => srv.toolCall('file_read', args, ctx());
const py = process.env.RUYI_BUNDLED_PYTHON || 'python';
const available = cp.spawnSync(py, ['-I', '-c', 'import zipfile'], { windowsHide: true }).status === 0;
const pillowAvailable = available && cp.spawnSync(py, ['-I', '-c', 'import PIL'], { windowsHide: true }).status === 0;
const pdfAvailable = available && cp.spawnSync(py, ['-I', '-c', 'import pdfplumber, reportlab, PIL'], { windowsHide: true }).status === 0;
after(() => fs.rmSync(root, { recursive: true, force: true }));

if (available) {
  const fixtures = cp.spawnSync(py, ['-I', '-X', 'utf8', '-c', String.raw`
import sys, os, zipfile, base64
d=sys.argv[1]; pic=base64.b64decode(sys.argv[2])
parts={
 'sample.docx': {'word/document.xml': '<document><p>Hello 文档</p><p>Second paragraph</p></document>', 'word/media/pic1.png':pic,'word/media/pic2.png':pic,'word/media/pic3.png':pic},
 'sample.pptx': {'ppt/presentation.xml':'<presentation/>','ppt/slides/slide1.xml':'<slide><p>Slide 1 chart</p></slide>','ppt/media/pic.png':pic},
 'sample.xlsx': {'xl/workbook.xml':'<workbook/>','xl/sharedStrings.xml':'<sst><si><t>Header</t></si></sst>','xl/worksheets/sheet1.xml':'<worksheet><row><c r="A1" t="s"><v>0</v></c><c r="B1"><f>1+1</f><v>2</v></c></row></worksheet>','xl/media/pic.png':pic},
 'sample.odt': {'content.xml':'<document><p>ODF paragraph</p></document>','Pictures/pic.png':pic},
 'entities.docx': {'word/document.xml':'<!DOCTYPE document [<!ENTITY x "secret">]><document><p>&x;</p></document>'},
 'bomb.docx': {'word/document.xml':'<document><p>'+'x'*(9*1024*1024)+'</p></document>'},
}
for name, entries in parts.items():
 with zipfile.ZipFile(os.path.join(d,name),'w',zipfile.ZIP_DEFLATED) as z:
  for n, data in entries.items(): z.writestr(n,data)
`, ws, png.toString('base64')], { encoding: 'utf8', windowsHide: true });
  assert.equal(fixtures.status, 0, fixtures.stderr);
}

test('native image bytes, renamed image, bounds, errors and read-only proxy', async () => {
  const offered = srv.buildOpenAiTools(config, null, {});
  assert.ok(srv.createToolLoadingState({ ...config, toolLoadingMode: srv.defaultConfig().toolLoadingMode }, '这张照片里有什么', null, offered, null, null).current().some(t => t.function.name === 'file_read'));
  for (const name of ['pic.png', 'renamed.dat']) {
    const r = await read({ path: name });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.mode, 'image');
    assert.deepEqual(V.extractToolImages(r), ['data:image/png;base64,' + png.toString('base64')]);
    assert.ok(!JSON.stringify(V.stripToolImageFields(r)).includes(png.toString('base64')));
    assert.match(JSON.stringify(V.stripToolImageFields(r, 'no-vision')), /model has no vision/);
  }
  const quiet = await read({ path: 'pic.png', includeImages: false });
  assert.equal(V.extractToolImages(quiet).length, 0);
  assert.equal((await read({ path: 'missing.png' })).code, 'not_found');
  fs.writeFileSync(path.join(ws, 'huge.png'), Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.equal((await read({ path: 'huge.png' })).code, 'file_too_large');
  const proxy = await srv.toolCall('tool_invoke_read', { name: 'file_read', arguments: { path: 'pic.png' } }, ctx());
  assert.equal(V.extractToolImages(proxy).length, 1);
});

test('local Markdown/HTML links opt in, paginate and retain per-target permission checks', async () => {
  fs.writeFileSync(path.join(root, 'outside.png'), png);
  fs.writeFileSync(path.join(ws, 'links.md'), '![local](pic.png)\n![outside](../outside.png)\n![remote](https://example.invalid/pic.png)');
  assert.equal(V.extractToolImages(await read({ path: 'links.md' })).length, 0);
  const remoteConfig = { ...config, providers: [{ id: 'p', baseUrl: 'https://example.invalid/v1', model: 'v' }], activeProvider: 'p' };
  const r = await srv.toolCall('file_read', { path: 'links.md', includeImages: true }, { ...ctx(), config: remoteConfig });
  assert.equal(r.ok, true);
  assert.equal(r.images.length, 1);
  assert.equal(r.nextImageOffset, 2);
  assert.equal(r.imageWarnings.length, 1, 'outside-workspace link denied');
  const last = await read({ path: 'links.md', includeImages: true, imageOffset: r.nextImageOffset });
  assert.equal(last.imageWarnings[0].code, 'non_local_image');
  fs.writeFileSync(path.join(ws, 'page.html'), '<img src="pic.png">');
  assert.equal((await read({ path: 'page.html', includeImages: true })).images.length, 1);
});

test('OOXML/ODF text and embedded media; continuation; malicious/corrupt archives', { skip: !available }, async () => {
  for (const [name, text] of [['sample.docx', 'Hello 文档'], ['sample.pptx', 'Slide 1 chart'], ['sample.xlsx', 'A1: Header'], ['sample.odt', 'ODF paragraph']]) {
    const r = await read({ path: name });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.content.includes(text), r.content);
    assert.ok(r.images.length > 0);
  }
  const r = await read({ path: 'sample.docx', limit: 12 });
  assert.equal(r.truncated, true);
  assert.equal(r.nextImageOffset, 2);
  const next = await read({ path: 'sample.docx', offset: r.nextOffset, imageOffset: r.nextImageOffset });
  assert.equal(next.images[0].name, 'word/media/pic3.png');
  assert.equal(next.nextImageOffset, undefined);
  assert.equal((await read({ path: 'sample.docx', includeImages: false })).images.length, 0);
  for (const name of ['entities.docx', 'bomb.docx']) assert.equal((await read({ path: name })).code, 'document_invalid');
  fs.writeFileSync(path.join(ws, 'invalid.docx'), 'PK\x03\x04broken');
  assert.equal((await read({ path: 'invalid.docx' })).code, 'document_invalid');
});

test('PDF text + rendered scan/chart pages and page continuation', { skip: !pdfAvailable }, async () => {
  const made = cp.spawnSync(py, ['-I', '-c', String.raw`
import sys
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.utils import ImageReader
import io,base64
c=Canvas(sys.argv[1],pagesize=(300,400))
for i in range(3):
 if i != 1: c.drawString(20,350,'Page '+str(i+1))
 c.drawImage(ImageReader(io.BytesIO(base64.b64decode(sys.argv[2]))),20,20,200,200)
 c.showPage()
c.save()
`, path.join(ws, 'pages.pdf'), png.toString('base64')], { windowsHide: true, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const r = await read({ path: 'pages.pdf' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.totalPages, 3);
  assert.equal(r.nextPageOffset, 3);
  assert.equal(r.images.length, 2, 'includes scan-only second page');
  assert.equal(r.imageWarnings.length, 0);
  assert.match(r.content, /Page 1/);
  const last = await read({ path: 'pages.pdf', pageOffset: r.nextPageOffset, includeImages: false });
  assert.match(last.content, /Page 3/);
  assert.equal(last.nextPageOffset, undefined);
  assert.equal(last.images.length, 0);
});

test('BMP/TIFF/ICO convert to provider-compatible PNG without desktop tools', { skip: !pillowAvailable }, async () => {
  const made = cp.spawnSync(py, ['-I', '-c', String.raw`
import sys,os
from PIL import Image
im=Image.new('RGB',(32,32),'red')
for ext in ['bmp','tiff','ico']: im.save(os.path.join(sys.argv[1],'convert.'+ext))
`, ws], { windowsHide: true, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  for (const ext of ['bmp', 'tiff', 'ico']) {
    const r = await read({ path: 'convert.' + ext });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.images[0].mimeType, 'image/png');
    assert.match(V.extractToolImages(r)[0], /^data:image\/png;base64,/);
  }
});

test('actual native image result encodes as Responses input_image and Anthropic base64 image', async () => {
  const r = await read({ path: 'pic.png' });
  const messages = [{ role: 'assistant', content: '', tool_calls: [{ id: 'read1', type: 'function', function: { name: 'file_read', arguments: '{"path":"pic.png"}' } }] },
    { role: 'tool', tool_call_id: 'read1', content: JSON.stringify(V.stripToolImageFields(r)) },
    { role: 'user', content: V.extractToolImages(r).map(url => ({ type: 'image_url', image_url: { url } })) }];
  const response = srv.providerWireProtocol('responses').encodeMessages({ model: 'vision', messages, stream: true });
  assert.ok(response.input.some(m => (m.content || []).some(p => p.type === 'input_image' && p.image_url.endsWith(png.toString('base64')))));
  const anthropic = srv.providerWireProtocol('anthropic').encodeMessages({ model: 'vision', messages, stream: true, hasTools: true });
  const parts = anthropic.messages.flatMap(m => m.content);
  assert.ok(parts.some(p => p.type === 'image' && p.source.media_type === 'image/png' && p.source.data === png.toString('base64')));
  assert.ok(parts.some(p => p.type === 'tool_result'));
});

test('native MCP returns real image content blocks, with base64 stripped from JSON text', async () => {
  const client = new srv.McpStdioClient({ id: 'native', command: process.execPath, args: [path.join(app, 'server.js'), 'mcp'],
    env: { RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home }, cwd: ws });
  try {
    await client.start();
    const r = await client._rpc('tools/call', { name: 'file_read', arguments: { path: path.join(ws, 'pic.png') } }, 10000);
    assert.equal(r.isError, false);
    assert.equal(r.content[1].type, 'image');
    assert.equal(r.content[1].data, png.toString('base64'));
    assert.ok(!r.content[0].text.includes(png.toString('base64')));
    assert.match(r.content[0].text, /image attached in MCP content/);
  } finally { client.kill(); }
});

test('main and subagent tool loops send pixels after tool replies; non-vision never sends base64 text', async () => {
  const fake = await startFakeProvider({ handler(req) {
    if (!req.stream || req.messages.some(m => m.role === 'tool')) return textFrames('done');
    return toolCallFrames('file_read', { path: path.join(ws, 'pic.png') }, 'read_pixels');
  } });
  try {
    for (const vision of [true, false]) {
      const provider = { id: 'fake', baseUrl: fake.url, model: 'fake-model', vision };
      const cfg = { ...config, providers: [provider], activeProvider: 'fake' };
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
      const session = await srv.createSession({ title: 'pixels', cwd: ws });
      const before = fake.requests.length;
      const main = await srv.runSessionTurn({ sessionId: session.id, message: 'Read pic.png', cwd: ws, source: 'http', onEvent() {} });
      assert.equal(main.result.ok, true, JSON.stringify(main.result));
      const mainReq = fake.requests.slice(before).find(q => q.messages.some(m => m.role === 'tool'));
      assert.ok(mainReq);
      const subBefore = fake.requests.length;
      const sub = await srv.runSubAgentCore({ parentSession: { id: session.id, cwd: ws }, provider, config: cfg, task: 'Read pic.png',
        toolTier: 'read', maxIters: 3, onEvent() {}, subagentId: 'test-vision-sub', depth: 1 });
      assert.equal(sub.ok, true, JSON.stringify(sub));
      const subReq = fake.requests.slice(subBefore).find(q => q.messages.some(m => m.role === 'tool'));
      assert.ok(subReq);
      for (const req of [mainReq, subReq]) {
        const toolIndex = req.messages.findIndex(m => m.role === 'tool');
        assert.ok(!req.messages[toolIndex].content.includes(png.toString('base64')));
        const imageParts = req.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url') : []);
        assert.equal(imageParts.length, vision ? 1 : 0);
        if (vision) assert.equal(req.messages[toolIndex + 1].role, 'user');
        else assert.match(req.messages[toolIndex].content, /model has no vision/);
      }
    }
  } finally { await fake.close(); }
});
