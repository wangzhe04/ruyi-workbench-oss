'use strict';
// Offline native media regression: package-aware parse gates and first delivery of complete image batches.
// In-process workbench + shared fake provider; no CLI, desktop, Python or real model dependencies.
require('./lib/self-isolate-home.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const t = createRunner('NATIVE MEDIA BOUNDARIES');
const { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-media-boundaries-'));
const home = path.join(root, 'data'), ws = path.join(root, 'workspace');
fs.mkdirSync(home); fs.mkdirSync(ws);
process.env.RUYI_HOME = home;
process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
const srv = require('../ruyi-workbench/app/server.js');
const configBase = { defaultWorkspace: ws, workspaces: [{ path: ws, read: true, write: true, execute: true }], permissionMode: 'bypass',
  includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [],
  toolLoadingMode: 'full', allowDesktopTools: false, stewardThreadBriefV1: false };
const ctx = { config: configBase, workingDir: ws, session: { id: 'media-boundaries', cwd: ws } };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const imageNames = ['one.png', 'two.png', 'three.png'];
const pixels = imageNames.map((name, i) => {
  const bytes = Buffer.concat([png, Buffer.from(String(i))]); // valid PNG with distinct trailing metadata
  fs.writeFileSync(path.join(ws, name), bytes);
  return bytes.toString('base64');
});
fs.writeFileSync(path.join(ws, 'followup.txt'), 'Keep reviewing the images.');
const imageParts = messages => messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url') : []);

async function syntaxGates() {
  for (const [type, original, invalid] of [['commonjs', 'module.exports = 1;', 'export const answer = 42;'], ['module', 'export const answer = 1;', 'return;']]) {
    const directory = path.join(ws, type);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type }));
    const source = path.join(directory, 'test.js');
    fs.writeFileSync(source, original);
    const candidate = await srv.toolCall('code_check', { path: source, content: invalid }, ctx);
    ok(candidate.ok === false && candidate.code === 'syntax_error', `${type}: invalid module syntax is rejected`);
    const write = await srv.toolCall('file_write', { path: source, content: invalid, validateSyntax: true }, ctx);
    ok(write.ok === false && write.written === false && fs.readFileSync(source, 'utf8') === original, `${type}: failed write preserves original bytes`);
    const edit = await srv.toolCall('file_edit', { path: source, oldText: original, newText: invalid, validateSyntax: true }, ctx);
    ok(edit.ok === false && edit.written === false && fs.readFileSync(source, 'utf8') === original, `${type}: failed edit preserves original bytes`);
    ok((await srv.toolCall('code_check', { path: source }, ctx)).ok === true, `${type}: valid source still passes`);
  }
  const dependency = path.join(ws, 'module', 'node_modules', 'dependency');
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(path.join(dependency, 'package.json'), '{}');
  const source = path.join(dependency, 'test.js');
  ok((await srv.toolCall('code_check', { path: source, content: 'export const value = 1;' }, ctx)).ok === false, 'dependency package without type defaults to CommonJS');
  fs.writeFileSync(path.join(dependency, 'package.json'), '{"type":"module"}');
  ok((await srv.toolCall('code_check', { path: source, content: 'export const value = 1;' }, ctx)).ok === true, 'dependency package can explicitly select ESM');
}

async function imageLoop(engine, vision, attachments = false) {
  let streamCall = 0;
  const fake = await startFakeProvider({ handler(req) {
    if (!req.stream) return textFrames('done');
    streamCall++;
    if (streamCall === 1 && !attachments) return toolCallFrames(imageNames.map((name, i) => ({ name: 'file_read', args: { path: path.join(ws, name) }, id: `image_${i}` })));
    if (streamCall === (attachments ? 1 : 2)) return toolCallFrames('file_read', { path: path.join(ws, 'followup.txt') }, 'followup');
    return textFrames('done');
  } });
  try {
    const provider = { id: 'fake', baseUrl: fake.url, model: 'fake-model', vision };
    const config = { ...configBase, providers: [provider], activeProvider: 'fake' };
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
    const before = fake.requests.length;
    const session = await srv.createSession({ title: 'Image boundaries', cwd: ws });
    let succeeded;
    if (engine === 'main') {
      const turn = await srv.runSessionTurn({ sessionId: session.id, message: 'Compare all three image files.', cwd: ws, source: 'http', onEvent() {},
        ...(attachments ? { attachments: imageNames.map(name => ({ name, path: path.join(ws, name), kind: 'image' })) } : {}) });
      succeeded = turn.result.ok;
    } else {
      const turn = await srv.runSubAgentCore({ parentSession: { id: session.id, cwd: ws }, provider, config, task: 'Compare all three image files.',
        toolTier: 'read', maxIters: 4, onEvent() {}, subagentId: 'image-boundaries-' + vision, depth: 1 });
      succeeded = turn.ok;
    }
    const requests = fake.requests.slice(before).filter(q => q.stream);
    const first = requests[attachments ? 0 : 1], later = requests[attachments ? 1 : 2];
    const label = `${engine}/${vision ? 'vision' : 'text'}${attachments ? '/attachments' : ''}`;
    ok(succeeded && first && later, `${label}: tool loop reaches a subsequent request`);
    if (!first || !later) return;
    const sent = imageParts(first.messages), retained = imageParts(later.messages);
    ok(sent.length === (vision ? 3 : 0) && (!vision || pixels.every(b => sent.some(p => p.image_url.url.endsWith(b)))), `${label}: every fresh image reaches the first request`);
    ok(retained.length === (vision ? 2 : 0) && (!vision || !retained.some(p => p.image_url.url.endsWith(pixels[0]))), `${label}: subsequent text-only tool iteration retains at most two old images`);
    const toolMessages = first.messages.filter(m => m.role === 'tool');
    ok(toolMessages.every(m => pixels.every(b => !m.content.includes(b))), `${label}: tool JSON contains no base64 pixels`);
    if (!vision) ok(toolMessages.length === 3 && toolMessages.every(m => /model has no vision/.test(m.content)), `${label}: non-vision placeholders remain explicit`);
    if (engine === 'main') {
      const saved = await srv.loadSession(session.id);
      ok(imageParts(saved.providerHistory).length <= 2, `${label}: saved history obeys the image budget`);
    }
  } finally { await fake.close(); }
}

(async () => {
  try {
    await syntaxGates();
    for (const engine of ['main', 'subagent']) for (const vision of [true, false]) await imageLoop(engine, vision);
    await imageLoop('main', true, true);
  } catch (error) { t.fail('fatal: ' + (error.stack || error)); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
  t.done({ exit: true });
})();
