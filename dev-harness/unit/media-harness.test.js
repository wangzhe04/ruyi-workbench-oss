'use strict';
require('../lib/self-isolate-home.js');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-media-harness-'));
const ws = path.join(root, 'workspace'), home = path.join(root, 'data');
fs.mkdirSync(ws); fs.mkdirSync(home);
process.env.RUYI_HOME = home; process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
if (process.env.RUYI_NATIVE_READ_TEST_PYTHON) process.env.RUYI_BUNDLED_PYTHON = process.env.RUYI_NATIVE_READ_TEST_PYTHON;
const srv = require('../../ruyi-workbench/app/server.js');
const media = srv.dispatchTestHooks.MediaInspection;
const config = { defaultWorkspace: ws, workspaces: [{ path: ws, read: true, write: true, execute: true }], permissionMode: 'bypass',
  includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [], toolLoadingMode: 'full' };
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
const ctx = { config, workingDir: ws, session: { id: 'mediatest', cwd: ws }, sessionId: 'mediatest', turnSeq: 1 };
const call = (name, args) => srv.toolCall(name, args, ctx);
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('syntax gate rejects invalid edits/writes before changing bytes and never executes valid source', async () => {
  fs.writeFileSync(path.join(ws, 'test.json'), '{"ok":true}');
  for (const [tool, args] of [['file_write', { content: '{bad' }], ['file_edit', { oldText: 'true', newText: 'broken' }]]) {
    const result = await call(tool, { path: 'test.json', validateSyntax: true, ...args });
    assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.written, false);
    assert.equal(fs.readFileSync(path.join(ws, 'test.json'), 'utf8'), '{"ok":true}');
  }
  const marker = path.join(ws, 'executed.txt');
  const candidate = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`;
  assert.equal((await call('code_check', { path: 'candidate.cjs', content: candidate })).ok, true);
  assert.equal(fs.existsSync(marker), false);
  assert.equal((await call('code_check', { path: 'candidate.js', content: 'const = ;' })).code, 'syntax_error');
  assert.equal((await call('file_write', { path: 'test.json', content: '{"ok":false}', validateSyntax: true })).ok, true);
  assert.equal((await call('code_check', { path: 'test.json' })).ok, true);
  assert.equal((await call('code_check', { path: 'x.ts', content: 'let x: number;' })).code, 'unsupported_syntax');
  assert.equal((await media.checkSyntax('a.json', ' '.repeat(1024 * 1024 + 1))).code, 'source_too_large');
  const python = await media.locate('python');
  if (python.available) {
    assert.equal((await call('code_check', { path: 'test.py', content: 'def f(:\n pass' })).ok, false);
    assert.equal((await call('code_check', { path: 'test.py', content: 'raise Exception("must not run")' })).ok, true);
  }
});

test('recursive copy/move/delete and batches use checkpoints; preflight failures leave all sources intact', async () => {
  fs.mkdirSync(path.join(ws, 'out/sub'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'out/sub/a.txt'), 'A'); fs.writeFileSync(path.join(ws, 'out/b.txt'), 'B');
  assert.equal((await call('file_copy', { from: 'out', to: 'copy', recursive: true })).ok, true);
  assert.equal(fs.readFileSync(path.join(ws, 'copy/sub/a.txt'), 'utf8'), 'A');
  const bad = await call('file_delete', { paths: ['copy/b.txt', 'missing.txt'] });
  assert.equal(bad.ok, false); assert.equal(bad.partial, false); assert.equal(fs.existsSync(path.join(ws, 'copy/b.txt')), true);
  assert.equal((await call('file_move', { from: 'copy', to: 'moved', recursive: true })).ok, true);
  assert.equal(fs.existsSync(path.join(ws, 'copy')), false);
  assert.equal((await call('file_copy', { from: 'out', to: 'out/nested', recursive: true })).code, 'overlapping_paths');
  assert.equal((await call('file_delete', { path: '.', recursive: true })).code, 'protected_root');
  const deleted = await call('file_delete', { path: 'moved', recursive: true });
  assert.equal(deleted.ok, true, JSON.stringify(deleted)); assert.equal(deleted.files, 2); assert.equal(fs.existsSync(path.join(ws, 'moved')), false);
  assert.equal((await call('file_copy', { items: [{ from: 'out/b.txt', to: 'batch/b.txt' }, { from: 'out/sub/a.txt', to: 'batch/a.txt' }] })).ok, true);
  assert.equal((await call('checkpoint_list', {})).ok, true);
  const checkpoints = JSON.parse(fs.readFileSync(path.join(home, 'checkpoints/mediatest/index.json'), 'utf8'));
  assert.ok(checkpoints.some(e => e.tool === 'file_delete' && e.op === 'delete'), 'recursive deletes retain per-file undo entries');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
  const strict = { ...ctx, config: { ...config, providers: [{ id: 'p', baseUrl: 'https://example.invalid/v1', model: 'v' }], activeProvider: 'p' } };
  const denied = await srv.toolCall('file_copy', { items: [{ from: 'out/b.txt', to: 'denied/b.txt' }, { from: '../outside.txt', to: 'denied/leak.txt' }] }, strict);
  assert.equal(denied.ok, false); assert.equal(fs.existsSync(path.join(ws, 'denied')), false);
});

test('directory operations reject symbolic links rather than traversing external contents', async t => {
  fs.mkdirSync(path.join(ws, 'links'), { recursive: true });
  try { fs.symlinkSync(path.join(ws, 'out'), path.join(ws, 'links/junction'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('symlink permission unavailable'); throw error; }
  const result = await call('file_delete', { path: 'links', recursive: true });
  assert.equal(result.code, 'symlink_refused'); assert.equal(result.partial, false);
  assert.equal(fs.readFileSync(path.join(ws, 'out/b.txt'), 'utf8'), 'B');
  const overlap = await call('file_copy', { from: 'out', to: 'links/junction/nested', recursive: true });
  assert.equal(overlap.code, 'overlapping_paths'); assert.equal(fs.existsSync(path.join(ws, 'out/nested')), false);
});

test('acceptance receipt binds multiple gate states to existing evidence without claiming independent verification', async () => {
  const checks = ['pass', 'pass', 'fail', 'blocked', 'not_run'].map((status, i) => ({ label: `Gate ${i}`, status, evidence: ['out/b.txt'], conclusion: i === 4 ? 'Not listened' : 'Caller judgment' }));
  const r = await call('acceptance_report', { path: 'receipt.json', title: 'Movie delivery', checks });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.report.overall, 'fail');
  assert.deepEqual(r.report.counts, { pass: 2, fail: 1, blocked: 1, not_run: 1 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, 'receipt.json'))).checks.length, 5);
  assert.match(r.report.provenance, /not independently verified/);
  assert.equal((await call('acceptance_report', { path: 'invalid.json', title: 'Invalid', checks: [{ label: 'Missing', status: 'pass', evidence: ['missing.txt'] }] })).code, 'evidence_missing');
  assert.equal(fs.existsSync(path.join(ws, 'invalid.json')), false);
});

test('image declaration and capability search surface native vision and provider-only background jobs', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(ws, 'image.png'), png);
  assert.equal((await call('file_read', { path: 'image.png', as: 'image' })).mode, 'image');
  assert.equal((await call('file_read', { path: 'image.png', as: 'text' })).code, 'not_text');
  const tools = srv.buildOpenAiTools(config, null, {});
  const catalog = srv.buildToolCatalog(tools);
  for (const query of ['view image', 'vision', '看图']) {
    const result = srv.searchToolCatalog(catalog, { query, view: 'matrix' }, config);
    assert.equal(result.matches[0].name, 'file_read', JSON.stringify(result));
    assert.equal(result.capabilityMatrix[0].modality, 'text/image/document');
  }
  const jobs = srv.searchToolCatalog(catalog, { query: 'background shell' }, config);
  assert.ok(jobs.matches.some(m => m.name === 'shell_start' && /provider/.test(m.availability)));
  const status = await srv.toolCall('workbench_self_status', { section: 'capabilities' }, { ...ctx, provider: { id: 'p', vision: true, apiStyle: 'responses' } });
  assert.equal(status.capabilities.modalities.vision, true, JSON.stringify(status));
  assert.equal(status.capabilities.modalities.audio, false);
  assert.match(status.capabilities.checkpointScope, /not checkpointed/);
  const disabled = await srv.toolCall('workbench_self_status', { section: 'config' }, { ...ctx, provider: { id: 'p', vision: false, apiStyle: 'anthropic' } });
  assert.equal(disabled.config.modalities.vision, false);
  assert.equal(disabled.config.providerCapabilities.protocol, 'anthropic');
  assert.equal(disabled.config.providerCapabilities.modelSupportProbed, false);
});

test('streamed audio metadata retains bounded curves, channel peaks and clipping risk', () => {
  const c = media.audioCollector(10, 1, 3);
  const fixture = 'frame:0 pts:0 pts_time:0\nlavfi.r128.I=-12.4\nlavfi.r128.S=-13\nlavfi.astats.1.Peak_level=0\nlavfi.astats.1.RMS_level=-6\nlavfi.astats.Overall.Peak_level=0\nframe:1 pts:4800 pts_time:0.1\nlavfi.r128.I=-12\nlavfi.astats.2.Peak_level=-3\nlavfi.astats.Overall.RMS_level=-8\n';
  for (let i = 0; i < fixture.length; i += 17) c.feed(fixture.slice(i, i + 17));
  const r = c.finish();
  assert.equal(r.integratedLufs, -12); assert.equal(r.channels.length, 2); assert.equal(r.curve.length, 1);
  assert.equal(r.nearClipWindows[0].startSeconds, 10); assert.equal(r.curve[0].peakDbfs, 0);
});

test('real FFmpeg WAV inspection measures tone/silence locally; never claims listening', async t => {
  const dependency = await media.locate('ffmpeg');
  if (!dependency.available) { assert.match(dependency.hint, /Install FFmpeg/); return t.skip('FFmpeg unavailable; parser covered separately'); }
  const samples = 48000 * 4, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(16384 * Math.sin(i * 2 * Math.PI * 1000 / 48000)), 44 + i * 2);
  fs.writeFileSync(path.join(ws, 'tone.wav'), wav);
  const r = await call('audio_inspect', { path: 'tone.wav', durationSeconds: 4 });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.listeningPerformed, false);
  assert.ok(r.integratedLufs < -5 && r.integratedLufs > -15, JSON.stringify(r));
  assert.ok(Math.abs(r.channels[0].peakDbfs + 6.02) < 0.1); assert.equal(r.nearClipWindows.length, 0);
  assert.equal((await call('audio_inspect', { path: 'tone.wav', stream: 1 })).code, 'audio_decode_failed');
  wav.fill(0, 44); fs.writeFileSync(path.join(ws, 'silence.wav'), wav);
  const silence = await call('audio_inspect', { path: 'silence.wav', durationSeconds: 4 });
  assert.equal(silence.ok, true); assert.equal(silence.channels[0].peakDbfs, null); assert.equal(silence.nearClipWindows.length, 0);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(i % 48 < 24 ? 32767 : -32768, 44 + i * 2);
  fs.writeFileSync(path.join(ws, 'clipped.wav'), wav);
  const clipped = await call('audio_inspect', { path: 'clipped.wav', startSeconds: 1, durationSeconds: 2 });
  assert.equal(clipped.ok, true, JSON.stringify(clipped)); assert.ok(clipped.nearClipWindows.length > 0);
  assert.equal(clipped.curve[0].startSeconds, 1); assert.equal(clipped.nextStartSeconds, 3);
});

test('dependency diagnostics give executable evidence and actionable missing-tool hints', async () => {
  const r = await call('media_probe', {});
  assert.equal(r.ok, true); assert.equal(r.installsPerformed, false);
  assert.equal(r.dependencies.node.available, true);
  assert.match(r.dependencies.node.version, /^v\d+/);
  for (const [kind, value] of Object.entries(r.dependencies)) {
    if (value.available) assert.ok(fs.statSync(value.path).isFile(), kind);
    else assert.match(value.hint, /Install/, kind);
  }
});
