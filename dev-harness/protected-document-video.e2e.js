'use strict';
// Normal native tool and model-turn entry. The opt-in mode uses the frozen
// Windows Full runtime. All files and the model endpoint are synthetic.
require('./lib/self-isolate-home');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { inflateSync } = require('node:zlib');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, toolCallFrames, textFrames } = require('./lib/fake-openai-provider');
const { startFakeAnthropic, messageEvents } = require('./lib/fake-anthropic-provider');
const { releaseEnvironment } = require('./lib/release-checks');
const { makeVideoFixture, audioCanary, metadataCanary } = require('./lib/media-video-fixture');
const { protectedPdf, protectedDocx, protectedPptx, protectedXlsx, protectedOdf } = require('./lib/protected-document-fixtures');

const runner = createRunner('PROTECTED DOCUMENT VIDEO');

function images(body) {
  return body.messages.filter(message => message.role === 'user' && Array.isArray(message.content))
    .flatMap(message => message.content.filter(item => item.type === 'image_url').map(item => item.image_url.url));
}

function hasOpaqueMask(url, region, office = false) {
  // The production derivative uses RGB PNG, filter zero, and no source chunks.
  // The fixture draws one ordinary word. Eight successive horizontal runs of
  // 64 black pixels establish a filled redaction rectangle, beyond any glyph.
  const png = Buffer.from(url.split(',')[1], 'base64');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), stride = 1 + width * 3;
  const chunks = [];
  for (let at = 8; at + 12 <= png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: stride * height });
  const pixel = (x, y) => y * stride + 1 + x * 3;
  const isRgb = (offset, value) => raw[offset] === value && raw[offset + 1] === value && raw[offset + 2] === value;
  if (office) {
    if (width !== 960 || height !== 1200 || !isRgb(pixel(900, 1100), 255)) return false;
    // The public prefix starts at x=36, y=64; the email appears later on this
    // line. Require actual public glyph ink and gaps to survive independently
    // of the filled mask rectangle detected below.
    let publicInk = 0, publicWhite = 0;
    for (let y = 64; y < 96; y++) for (let x = 36; x < 130; x++) {
      if (isRgb(pixel(x, y), 0)) publicInk++;
      if (isRgb(pixel(x, y), 255)) publicWhite++;
    }
    if (publicInk < 5 || publicWhite < 20) return false;
  }
  if (region) {
    // The 2× PDF fixture must retain its white background and cover the entire
    // independently observed word rectangle, including its rightmost letters.
    if (width !== 640 || height !== 440 || !isRgb(pixel(600, 400), 255) || !isRgb(pixel(400, 200), 255)) return false;
    for (let y = region.top; y < region.bottom; y++) {
      for (let x = region.left; x < region.right; x++) {
        if (!isRgb(pixel(x, y), 0)) return false;
      }
    }
    return true;
  }
  let rows = 0;
  for (let y = 0; y < height; y++) {
    let run = 0, longest = 0;
    for (let x = 0; x < width; x++) {
      run = isRgb(pixel(x, y), 0) ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    rows = longest >= 64 ? rows + 1 : 0;
    if (rows >= 8) return true;
  }
  return false;
}

function anthropicImageBlocks(value) {
  if (Array.isArray(value)) return value.flatMap(anthropicImageBlocks);
  if (value === null || typeof value !== 'object') return [];
  if (value.type === 'image') return [value];
  return Object.values(value).flatMap(anthropicImageBlocks);
}

async function checkAnthropicPage(app, workspace, pdf, keyword) {
  const callId = 'toolu_local_media';
  const followUpId = 'toolu_after_media';
  const model = 'claude-fixture';
  let iteration = 0;
  const fake = await startFakeAnthropic({ handler(request) {
    if (!request.stream || ++iteration > 2) return messageEvents({ model, text: 'Synthetic answer.' });
    const toolUse = iteration === 1
      ? { id: callId, name: 'file_read', input: { path: 'sample.pdf', as: 'image', pageLimit: 1 } }
      : { id: followUpId, name: 'file_read', input: { path: 'follow-up.txt' } };
    return messageEvents({ model, toolUses: [toolUse] });
  } });
  try {
    const provider = { id: 'messages-fixture', label: 'Messages fixture', type: 'openai-compat',
      apiStyle: 'anthropic', baseUrl: fake.url, apiKey: 'synthetic-messages-key', model, vision: true };
    await app.mutateConfig(config => { config.providers.push(provider); });
    const session = await app.createSession({ title: 'Protected PDF Messages fixture', cwd: workspace,
      engineRoute: { engine: 'openai', providerId: provider.id, model } });
    const events = [];
    const { result } = await app.runSessionTurn({ sessionId: session.id, cwd: workspace, source: 'http',
      message: 'Inspect the requested local visual material.', onEvent: event => events.push(event) });
    assert.equal(result.ok, true);
    assert.deepEqual(fake.errors, []);
    const captured = fake.requests.filter(request => request.stream);
    assert.equal(captured.length, 3);
    assert.ok(captured.every(request => request.url === '/v1/messages'));
    const pageResult = captured[1].messages.at(-1);
    assert.equal(pageResult.role, 'user');
    const [receipt] = pageResult.content;
    assert.equal(receipt.type, 'tool_result');
    assert.equal(receipt.tool_use_id, callId);
    const page = JSON.parse(receipt.content);
    assert.equal(page.ok, true, 'Anthropic PDF tool result: ' + JSON.stringify(page));
    assert.equal(page.projection, 'pdf-pages');
    const sent = anthropicImageBlocks(captured[1].body);
    assert.equal(sent.length, 1);
    assert.ok(pageResult.content.includes(sent[0]), 'the PDF page follows its tool result in the same user message');
    const source = sent[0].source;
    assert.equal(source.type, 'base64');
    assert.equal(source.media_type, 'image/png');
    assert.match(source.data, /^iVBORw0KGgo/);
    assert.ok(hasOpaqueMask('data:image/png;base64,' + source.data, { left: 65, top: 56, right: 298, bottom: 81 }),
      'wire PNG masks the synthetic text region while preserving white background');
    const followUpReceipt = captured[2].messages.at(-1).content[0];
    assert.equal(followUpReceipt.type, 'tool_result');
    assert.equal(followUpReceipt.tool_use_id, followUpId);
    assert.equal(JSON.parse(followUpReceipt.content).ok, true);
    const absent = [keyword, pdf.toString('base64'), 'UNEXPOSED', 'https://ruyi.invalid/protected-image/'];
    for (const request of fake.requests) {
      assert.ok(absent.every(marker => !request.raw.includes(marker)));
      if (request !== captured[1]) {
        assert.deepEqual(anthropicImageBlocks(request.body), []);
        assert.ok(!request.raw.includes(source.data));
      }
    }
    for (const value of [JSON.stringify(await app.loadSession(session.id)), JSON.stringify(events)]) {
      assert.ok(absent.every(marker => !value.includes(marker)) && !value.includes(source.data));
    }
    runner.ok(true, 'Anthropic Messages receives the masked PDF page only on the matching tool-result request');
  } finally {
    await fake.close();
  }
}

async function checkResponsesPage(app, workspace, pdf, keyword) {
  const captured = [], errors = [];
  const callId = 'call_responses_media', followUpId = 'call_responses_after_media';
  const model = 'responses-fixture';
  let iteration = 0;
  // Reuse the common provider's socket ownership and close path. Its fallback
  // receives Responses requests before the Chat Completions decoder runs.
  const fake = await startFakeProvider({ fallback: async (req, res) => {
    try {
      // The production capability probe checks the configured base before the
      // native turn; models GETs are handled by the shared provider itself.
      if (req.method === 'HEAD' && req.url === '/v1') { res.writeHead(200); res.end(); return; }
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/responses');
      let raw = '';
      req.setEncoding('utf8');
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      captured.push({ raw, body, stream: body.stream === true });
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'Synthetic answer.' }] }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let sequence = 0;
      const emit = value => res.write('data: ' + JSON.stringify({ ...value, sequence_number: sequence++ }) + '\n\n');
      const id = 'response_media_' + (++iteration);
      emit({ type: 'response.created', response: { id, status: 'in_progress', output: [] } });
      if (iteration <= 2) {
        const args = iteration === 1 ? { path: 'sample.pdf', as: 'image', pageLimit: 1 } : { path: 'follow-up.txt' };
        const item = { type: 'function_call', id: 'fc_media_' + iteration,
          call_id: iteration === 1 ? callId : followUpId, name: 'file_read', arguments: '' };
        emit({ type: 'response.output_item.added', output_index: 0, item });
        emit({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: JSON.stringify(args) });
        emit({ type: 'response.output_item.done', output_index: 0, item: { ...item, arguments: JSON.stringify(args) } });
      } else emit({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_media', delta: 'Synthetic answer.' });
      emit({ type: 'response.completed', response: { id, status: 'completed', output: [],
        usage: { input_tokens: 12, output_tokens: 5 } } });
      res.end();
    } catch (error) {
      errors.push(error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Synthetic Responses fixture failed.' } }));
    }
  } });
  try {
    const provider = { id: 'responses-fixture', label: 'Responses fixture', type: 'openai-compat', apiStyle: 'responses',
      baseUrl: fake.url + '/v1', apiKey: 'synthetic-responses-key', model, vision: true, serverWebSearch: false };
    await app.mutateConfig(config => { config.providers.push(provider); });
    const session = await app.createSession({ title: 'Protected PDF Responses fixture', cwd: workspace,
      engineRoute: { engine: 'openai', providerId: provider.id, model } });
    const events = [];
    const { result } = await app.runSessionTurn({ sessionId: session.id, cwd: workspace, source: 'http',
      message: 'Inspect the requested local visual material.', onEvent: event => events.push(event) });
    assert.equal(result.ok, true);
    assert.deepEqual(errors, []);
    assert.deepEqual(fake.errors, []);
    assert.deepEqual(fake.requests, [], 'Responses must never fall back to Chat Completions');
    const streamed = captured.filter(request => request.stream);
    assert.equal(streamed.length, 3);
    const items = streamed[1].body.input;
    const receiptIndex = items.findIndex(item => item.type === 'function_call_output' && item.call_id === callId);
    assert.ok(receiptIndex >= 0, 'matching PDF tool result exists');
    const page = JSON.parse(items[receiptIndex].output);
    assert.equal(page.ok, true, 'Responses PDF tool result: ' + JSON.stringify(page));
    assert.equal(page.projection, 'pdf-pages');
    const visual = items[receiptIndex + 1];
    assert.equal(visual.type, 'message');
    assert.equal(visual.role, 'user');
    const imagesIn = body => body.input.flatMap(item => Array.isArray(item.content)
      ? item.content.filter(part => part.type === 'input_image') : []);
    const sent = imagesIn(streamed[1].body);
    assert.equal(sent.length, 1);
    assert.ok(visual.content.includes(sent[0]), 'PDF image immediately follows its matching tool-result item');
    const url = sent[0].image_url;
    assert.match(url, /^data:image\/png;base64,iVBORw0KGgo/);
    assert.ok(hasOpaqueMask(url, { left: 65, top: 56, right: 298, bottom: 81 }),
      'Responses wire PNG masks the synthetic text region while preserving white background');
    const followUp = streamed[2].body.input.find(item => item.type === 'function_call_output' && item.call_id === followUpId);
    assert.equal(JSON.parse(followUp.output).ok, true);
    const absent = [keyword, pdf.toString('base64'), 'UNEXPOSED', 'https://ruyi.invalid/protected-image/'];
    for (const request of captured) {
      assert.ok(absent.every(marker => !request.raw.includes(marker)));
      if (request !== streamed[1]) {
        assert.deepEqual(imagesIn(request.body), []);
        assert.ok(!request.raw.includes(url.split(',')[1]));
      }
    }
    for (const value of [JSON.stringify(await app.loadSession(session.id)), JSON.stringify(events)]) {
      assert.ok(absent.every(marker => !value.includes(marker)) && !value.includes(url.split(',')[1]));
    }
    runner.ok(true, 'Responses receives the masked PDF page only on the matching tool-result request');
  } finally {
    await fake.close();
  }
}

async function packagedEntry(root) {
  assert.ok(path.isAbsolute(root), 'package root must be absolute');
  const packageRoot = await fs.realpath(root);
  const node = await fs.realpath(path.join(packageRoot, 'runtime', 'node', 'node.exe'));
  assert.equal(await fs.realpath(process.execPath), node, 'run this fixture with the packaged Node runtime');
  for (const key of ['RUYI_MEDIA_RUNTIME_ROOT', 'RUYI_MEDIA_SOURCES_ROOT', 'RUYI_MEDIA_RESOURCE_PROFILE']) {
    assert.equal(process.env[key], undefined, key + ' would override the packaged defaults');
  }
  for (const relative of [
    'app/server.js', 'mcp/ai-computer-control/python_embed/python.exe', 'resources/native-file-read.py',
    'resources/media-runtime-dependencies.json', 'resources/media-runtime-sources.json', 'tools/verify-media-artifacts.cjs',
  ]) {
    assert.ok((await fs.lstat(path.join(packageRoot, relative))).isFile(), 'missing packaged file ' + relative);
  }
  console.log('Testing packaged Full at ' + packageRoot);
  return path.join(packageRoot, 'app', 'server.js');
}

async function main() {
  const { values } = parseArgs({ options: {
    'full-components': { type: 'boolean' }, 'package-root': { type: 'string' }, 'anthropic-only': { type: 'boolean' },
    'responses-only': { type: 'boolean' },
  } });
  const full = values['full-components'], anthropicOnly = values['anthropic-only'], responsesOnly = values['responses-only'];
  const packageRoot = values['package-root'];
  assert.ok(!(anthropicOnly && responsesOnly), 'choose only one provider-only mode');
  assert.ok(full || (!anthropicOnly && !responsesOnly && packageRoot === undefined), 'package and provider-only modes require --full-components');
  const packageServer = packageRoot === undefined ? null : await packagedEntry(packageRoot);
  if (full) {
    assert.equal(process.platform, 'win32');
    if (!packageServer) {
      for (const key of ['RUYI_MEDIA_RUNTIME_ROOT', 'RUYI_MEDIA_SOURCES_ROOT']) assert.ok(path.isAbsolute(process.env[key] || ''), key);
    }
  }
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'ruyi-protected-doc-video-'));
  let fake, app, failure;
  try {
    const data = path.join(root, 'data'), workspace = path.join(root, 'workspace');
    await Promise.all([fs.mkdir(data), fs.mkdir(workspace)]);
    Object.assign(process.env, releaseEnvironment(path.join(root, 'home'), data));
    if (!packageServer) process.env.RUYI_MEDIA_RESOURCE_PROFILE = 'legacy-full-4987-v1';
    if (!full) {
      process.env.RUYI_MEDIA_RUNTIME_ROOT = path.join(root, 'missing-runtime');
      process.env.RUYI_MEDIA_SOURCES_ROOT = path.join(root, 'missing-sources');
    }
    const email = 'synthetic-customer@example.com';
    const keyword = 'CONFIDENTIAL';
    const video = makeVideoFixture(), pdf = protectedPdf({ text: keyword }), docx = protectedDocx({ text: 'Quarterly contact ' + email });
    const hidden = protectedDocx({ hidden: true });
    const concealed = full ? [
      { path: 'shaded.docx', bytes: protectedDocx({ shaded: true, text: 'UNEXPOSED SHADED RUN' }), layer: 'unhandled-text-display' },
      { path: 'shadowed.docx', bytes: protectedDocx({ shadowedColor: true, text: 'UNEXPOSED WHITE RUN' }), layer: 'ambiguous-attributes' },
      { path: 'off-slide.pptx', bytes: protectedPptx({ outOfSlide: true }), layer: 'unhandled-slide-geometry' },
      { path: 'clipped-slide.pptx', bytes: protectedPptx({ clipped: true }), layer: 'unhandled-slide-geometry' },
    ] : [];
    const slide = full ? protectedPptx() : null;
    const officeCases = full ? [
      { path: 'sample.xlsx', bytes: protectedXlsx({ text: 'Sheet contact ' + email }), text: 'A1: Sheet contact ',
        requiredText: ['B1: 321', 'C1: TRUE'] },
      { path: 'formula.xlsx', bytes: protectedXlsx({ formula: true }), refusal: 'document_hidden_content', layer: 'spreadsheet-formulas' },
      { path: 'hidden-sheet.xlsx', bytes: protectedXlsx({ hiddenSheet: true }), refusal: 'document_hidden_content', layer: 'hidden-content' },
      { path: 'hidden-format.xlsx', bytes: protectedXlsx({ hiddenFormat: true }), refusal: 'document_hidden_content', layer: 'unhandled-cell-display' },
      ...['odt', 'ods'].map(extension => ({ path: 'sample.' + extension,
        bytes: protectedOdf({ extension, text: 'ODF contact ' + email }), text: 'ODF contact ' })),
      { path: 'sample.odp', bytes: protectedOdf({ extension: 'odp' }), refusal: 'document_hidden_content', layer: 'unhandled-visual-content' },
      { path: 'conditional.odt', bytes: protectedOdf({ conditional: true }), refusal: 'document_hidden_content', layer: 'conditional-content' },
      { path: 'external.ods', bytes: protectedOdf({ extension: 'ods', external: true }), refusal: 'document_hidden_content', layer: 'external-or-embedded-relationships' },
      { path: 'non-ascii.odt', bytes: protectedOdf({ text: 'Public 演示文本' }), text: 'Public ', requiredText: ['演示文本'] },
    ] : [];
    await Promise.all([
      fs.writeFile(path.join(workspace, 'sample.avi'), video), fs.writeFile(path.join(workspace, 'sample.pdf'), pdf),
      fs.writeFile(path.join(workspace, 'sample.docx'), docx), fs.writeFile(path.join(workspace, 'hidden.docx'), hidden),
      fs.writeFile(path.join(workspace, 'follow-up.txt'), 'Synthetic follow-up after the visual request.'),
      ...concealed.map(item => fs.writeFile(path.join(workspace, item.path), item.bytes)),
      ...(slide ? [fs.writeFile(path.join(workspace, 'sample.pptx'), slide)] : []),
      ...officeCases.map(item => fs.writeFile(path.join(workspace, item.path), item.bytes)),
    ]);
    let plan, iteration = 0;
    fake = await startFakeProvider({ handler(request) {
      if (!request.stream) return textFrames('Synthetic answer.');
      if (++iteration === 1) return toolCallFrames('file_read', plan.args, 'local_media');
      if (iteration === 2 && plan.visual && full) return toolCallFrames('file_read', { path: 'follow-up.txt' }, 'after_media');
      return textFrames('Synthetic answer.');
    } });
    const provider = { id: 'fixture', label: 'Fixture', type: 'openai-compat', baseUrl: fake.url, model: 'fake-model', vision: true };
    const config = { configSchema: 14, privacyModeV1: 'enhanced', credentialEncryptionV1: true,
      workDataEncryptionV1: false, defaultWorkspace: workspace, workspaces: [{ path: workspace, read: true, write: true, execute: false }],
      permissionMode: 'bypass', activeProvider: provider.id, providers: [provider], toolLoadingMode: 'full', stewardEnabledV1: false,
      privacyRulesV1: [{ id: 'fixture-mask', kind: 'literal', value: keyword, category: 'INTERNAL' }],
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, desktopMcp: { enabled: false, autodetect: false } };
    await fs.writeFile(path.join(data, 'config.json'), JSON.stringify(config));
    app = packageServer ? require(packageServer)
      : require('./lib/server-internals').loadServerInternals(['createSession', 'runSessionTurn', 'runSubAgentCore', 'readConfig', 'mutateConfig', 'loadSession', 'MediaImageHooks']);
    if (anthropicOnly) {
      await checkAnthropicPage(app, workspace, pdf, keyword);
      return;
    }
    if (responsesOnly) {
      await checkResponsesPage(app, workspace, pdf, keyword);
      return;
    }
    const activeConfig = await app.readConfig();
    const activeProvider = activeConfig.providers.find(item => item.id === provider.id);

    const cases = [
      { args: { path: 'sample.pdf', as: 'image', pageLimit: 1 }, bytes: pdf, label: 'PDF page', visual: true, mask: true },
      { args: { path: 'sample.avi', as: 'image', startSeconds: 0.25, frameCount: 2, intervalSeconds: 0.5 }, bytes: video, label: 'video samples', visual: true },
      ...(full ? [
        { args: { path: 'sample.docx' }, bytes: docx, label: 'DOCX text', text: 'Quarterly contact ' },
        { args: { path: 'sample.docx', as: 'image' }, bytes: docx, label: 'DOCX reflow preview / subagent', visual: true, subagent: true, projection: 'office-content-preview' },
        { args: { path: 'hidden.docx', as: 'image' }, bytes: hidden, label: 'hidden DOCX', refusal: 'document_hidden_content' },
        ...concealed.map(item => ({ args: { path: item.path }, bytes: item.bytes, label: item.path,
          refusal: 'document_hidden_content', layer: item.layer })),
        { args: { path: 'sample.pptx' }, bytes: slide, label: 'in-bounds PPTX text box', text: 'Synthetic slide text' },
        ...officeCases.map(item => ({ ...item, args: { path: item.path }, label: item.path + ' protected text' })),
        ...officeCases.map(item => ({ ...item, text: undefined, args: { path: item.path, as: 'image' },
          label: item.path + ' protected preview', ...(item.refusal ? {} : item.path === 'non-ascii.odt'
            ? { refusal: 'document_render_unavailable' } : { visual: true, projection: 'office-content-preview', officeMask: true }) })),
      ] : []),
    ];
    for (plan of cases) {
      iteration = 0;
      const first = fake.requests.length;
      const session = await app.createSession({ title: 'Protected local media fixture', cwd: workspace });
      const events = [];
      const message = 'Inspect the requested local visual material.';
      const onEvent = event => events.push(event);
      const result = plan.subagent ? await app.runSubAgentCore({ parentSession: session, provider: activeProvider, config: activeConfig,
        task: message, toolTier: 'read', maxIters: 4, onEvent, subagentId: 'protected-media-fixture', depth: 1 })
        : (await app.runSessionTurn({ sessionId: session.id, message, cwd: workspace, source: 'http', onEvent })).result;
      assert.equal(result.ok, true, plan.label + ': native turn completes');
      const captured = fake.requests.slice(first).filter(request => request.stream).map(request => JSON.parse(request.raw));
      assert.equal(captured.length, full && plan.visual ? 3 : 2, plan.label + ': model call count');
      const receipt = JSON.parse(captured[1].messages.find(message => message.role === 'tool' && message.tool_call_id === 'local_media').content);
      const sent = images(captured[1]);
      if (!full) {
        assert.equal(receipt.ok, false);
        assert.equal(receipt.code, plan.args.frameCount ? 'privacy.image_runtime_unavailable' : 'reader_unavailable');
        assert.deepEqual(sent, []);
        runner.ok(true, plan.label + ': missing verified components fail closed without visual egress');
        continue;
      }
      if (plan.refusal) {
        assert.equal(receipt.ok, false);
        assert.equal(receipt.code, plan.refusal);
        if (plan.layer) assert.ok(receipt.found?.includes(plan.layer));
      } else assert.equal(receipt.ok, true, plan.label + ': ' + JSON.stringify(receipt));
      assert.equal(sent.length, plan.visual ? plan.args.frameCount || 1 : 0);
      if (plan.visual) {
        assert.equal(new Set(sent).size, sent.length, 'sampled pixels distinguish the requested frames');
        for (const url of sent) assert.match(url, /^data:image\/png;base64,iVBORw0KGgo/);
        assert.deepEqual(images(captured[2]), [], 'prepared pixels are sent only to the immediate model request');
      }
      if (plan.projection) assert.equal(receipt.projection, plan.projection);
      if (plan.mask) assert.ok(hasOpaqueMask(sent[0]), 'wire PNG covers the synthetic literal with an opaque pixel rectangle');
      if (plan.officeMask) assert.ok(hasOpaqueMask(sent[0], undefined, true), 'Office preview masks the email while retaining public prefix pixels and white background');
      if (plan.text) assert.ok(receipt.content.startsWith(plan.text) && !receipt.content.includes(email));
      if (!plan.refusal && !plan.visual) for (const expected of plan.requiredText || []) assert.ok(receipt.content.includes(expected), expected);
      if (plan.args.frameCount) {
        assert.deepEqual(receipt.coverage.sampledSeconds, [0.25, 0.75]);
        assert.equal(receipt.coverage.fullVideo, false);
      }
      const wire = JSON.stringify(captured), saved = JSON.stringify(await app.loadSession(session.id)), projected = JSON.stringify(events);
      for (const value of [wire, saved, projected]) {
        assert.ok(!value.includes('https://ruyi.invalid/protected-image/'));
        assert.ok(!value.includes(plan.bytes.toString('base64')));
        assert.ok(!value.includes(audioCanary) && !value.includes(metadataCanary) && !value.includes('UNEXPOSED'));
      }
      assert.ok(!wire.includes(email));
      assert.ok(!saved.includes('data:image/png;base64,') && !projected.includes('data:image/png;base64,'));
      runner.ok(true, plan.label + ': real file_read supplies the authorized projection without original media');
    }
    if (full) {
      await checkAnthropicPage(app, workspace, pdf, keyword);
      await checkResponsesPage(app, workspace, pdf, keyword);
      await app.mutateConfig(config => { config.privacyModeV1 = 'off'; });
      plan = { args: { path: 'sample.avi', as: 'image', frameCount: 1 }, visual: false };
      iteration = 0;
      const first = fake.requests.length;
      const session = await app.createSession({ title: 'Ordinary video fixture', cwd: workspace,
        engineRoute: { engine: 'openai', providerId: provider.id, model: provider.model } });
      const { result } = await app.runSessionTurn({ sessionId: session.id, message: 'Read a local video still.', cwd: workspace, source: 'http', onEvent() {} });
      assert.equal(result.ok, true);
      const captured = fake.requests.slice(first).filter(request => request.stream).map(request => JSON.parse(request.raw));
      assert.equal(captured.length, 2);
      const sent = images(captured[1]);
      assert.equal(sent.length, 1);
      assert.match(sent[0], /^data:image\/png;base64,iVBORw0KGgo/);
      assert.ok(!JSON.stringify(captured).includes(video.toString('base64')));
      runner.ok(true, 'video sampling also sends only a decoded still with privacy disabled');
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await fake?.close(); }
    finally {
      // Keep packaged evidence without extending the product's public API to
      // expose its process-private cleanup witness.
      if (packageServer || failure || app?.MediaImageHooks.helperMayStillRun()) console.log('Retained synthetic fixture at ' + root);
      else {
        assert.equal(path.dirname(await fs.realpath(root)), temp);
        assert.ok(path.basename(root).startsWith('ruyi-protected-doc-video-'));
        await fs.rm(root, { recursive: true });
      }
    }
  }
}

main().catch(error => runner.fail(error.stack || String(error))).finally(() => runner.done());
