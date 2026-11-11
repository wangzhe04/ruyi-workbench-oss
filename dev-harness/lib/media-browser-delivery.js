'use strict';
// Positive acceptance uses the supplied Windows Full package and its bundled
// Node. The missing-resource branch exercises the same encrypted browser flow.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRunner } = require('./harness');
const { startBrowserFixture, WB, sleep } = require('./browser-fixture');
const { releaseEnvironment } = require('./release-checks');
const { startMediaBrowserProvider, wireMessages, wireImageUrl } = require('./media-browser-provider');

const width = 320, height = 192;
const sendText = 'Please describe the public sample.';
const holdText = 'Please wait for a second public sample.';
const doneText = 'Synthetic provider received the fixture.';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function bmp(color) {
  const bytes = Buffer.alloc(54 + width * height * 3);
  bytes.write('BM');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  for (let at = 54; at < bytes.length; at += 3) {
    bytes[at] = color[2];
    bytes[at + 1] = color[1];
    bytes[at + 2] = color[0];
  }
  return bytes;
}

function packagePath(value) {
  assert.ok(typeof value === 'string' && path.isAbsolute(value), 'RUYI_MEDIA_BROWSER_PACKAGE must name an absolute extracted Full stage');
  const root = fs.realpathSync(value);
  for (const relative of ['app/server.js', 'runtime/node/node.exe', 'mcp/ai-computer-control/offline-manifest.json']) {
    assert.ok(fs.statSync(path.join(root, relative)).isFile(), 'Full package entry missing: ' + relative);
  }
  const sourceLock = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'media-runtime-sources.json'), 'utf8'));
  assert.equal(sourceLock.schema, 1);
  assert.ok(Array.isArray(sourceLock.artifacts), 'Full package source artifacts');
  const names = sourceLock.artifacts.map(row => row.path).sort();
  const legacy = ['opencv-windows-ffmpeg-source-sidecar.zip'];
  const local = ['opencv-windows-ffmpeg-sources-v2-local.zip', 'opencv_python_headless-5.0.0.93.tar.gz'].sort();
  assert.ok([legacy, local].some(expected => JSON.stringify(names) === JSON.stringify(expected)), 'known Full source profile');
  for (const { path: name, bytes } of sourceLock.artifacts) {
    const file = fs.statSync(path.join(root, 'resources', 'media-runtime-sources', name));
    assert.ok(file.isFile() && file.size === bytes, 'missing or incomplete package source: ' + name);
  }
  return root;
}

async function seedEncrypted(base) {
  assert.equal(process.platform, 'win32', 'CurrentUser DPAPI is required');
  assert.equal(base, fs.realpathSync(base));
  assert.equal(path.basename(base), 'home');
  assert.match(path.basename(path.dirname(base)), /^ruyi-media-browser-[A-Za-z0-9]{6}$/);
  assert.equal(process.env.RUYI_HOME, base);
  assert.deepEqual(fs.readdirSync(base), ['config.json']);
  const { loadServerInternals } = require('./server-internals');
  const { WorkDataManifest, WorkDataKeys, LocalSecretCrypto, ServerOwnership, atomicWriteJson } =
    loadServerInternals(['WorkDataManifest', 'WorkDataKeys', 'LocalSecretCrypto', 'ServerOwnership', 'atomicWriteJson']);
  const config = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8'));
  config.providers[0].vision = true;
  const manifest = WorkDataManifest.create({ base });
  const owner = await ServerOwnership.acquire([base]);
  let keys, staged;
  try {
    const initial = await manifest.readActive();
    const encrypted = await manifest.prepare({ expected: initial, mode: 'encrypted' });
    keys = WorkDataKeys.create({ store: { read: async () => { throw Error('unexpected seed key read'); } },
      enabled: () => false, protector: LocalSecretCrypto });
    staged = await keys.stageNew();
    await atomicWriteJson(path.join(encrypted.root, 'work-data-key-v1.json'), staged.header);
    await atomicWriteJson(path.join(encrypted.root, 'config.json'), config);
    await manifest.commit({ expected: initial, candidate: encrypted });
    return encrypted.root;
  } finally {
    staged?.lease.release();
    keys?.clear();
    await owner.release();
  }
}

function observe(fx) {
  const responses = [], writes = [], completed = new Set();
  const origin = 'http://127.0.0.1:' + fx.appPort;
  fx.cdp.on('Network.requestWillBeSent', ({ request }) => {
    const url = new URL(request.url);
    if (url.origin === origin && request.method === 'POST') writes.push(url.pathname);
  });
  fx.cdp.on('Network.responseReceived', ({ requestId, response }) => {
    const url = new URL(response.url);
    if (url.origin === origin) responses.push({ requestId, path: url.pathname, query: url.searchParams, status: response.status,
      headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value])) });
  });
  fx.cdp.on('Network.loadingFinished', ({ requestId }) => completed.add(requestId));
  return { responses, writes, completed };
}
async function capturePreviewBytes(fx) {
  // CDP can decode a Fetch resource as text even for an image/png response.
  // Take a clone of that exact response; forward the original promise unchanged.
  await fx.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const native = window.fetch;
    const bodies = new Map();
    window.__ruyiMediaPreviewBodies = bodies;
    window.fetch = function(...args) {
      const result = Reflect.apply(native,this,args);
      result.then(response => {
        const url = new URL(response.url);
        if (url.origin===location.origin && response.ok && /^\\/api\\/media\\/images\\/[0-9a-f]{32}\\/preview$/.test(url.pathname)) {
          const bytes = response.clone().arrayBuffer();
          bytes.catch(()=>{});
          bodies.set(url.pathname+url.search,bytes);
        }
      }).catch(()=>{});
      return result;
    };
  })()` });
}

async function until(test, label, milliseconds = 70000) {
  const deadline = Date.now() + milliseconds;
  do {
    const result = await test();
    if (result) return result;
    await sleep(60);
  } while (Date.now() < deadline);
  throw Error('Browser delivery deadline: ' + label);
}

async function click(fx, selector) {
  const x = JSON.stringify(selector);
  const box = await until(() => fx.evaluate(`(() => {
    const node = document.querySelector(${x});
    if (!node || node.disabled) return null;
    node.scrollIntoView({block:'nearest',inline:'nearest'});
    const rect = node.getBoundingClientRect(), x = rect.x+rect.width/2, y = rect.y+rect.height/2;
    return rect.width && rect.height && node.contains(document.elementFromPoint(x,y)) ? {x,y} : null;
  })()`), selector);
  await fx.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box });
  await fx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box });
}

async function selectSession(fx, id) {
  await fx.evaluate(`localStorage.setItem('wcw.lastSession',${JSON.stringify(id)}),true`);
  const time = await fx.evaluate('performance.timeOrigin');
  await fx.cdp.send('Page.reload');
  assert.ok(await fx.waitForEval(`performance.timeOrigin!==${time} && window.state?.currentSession?.id===${JSON.stringify(id)} &&
    state.currentSession.engineRoute?.providerId==='fake' && state.config?.workDataEncryptionV1===true`), 'encrypted native session selected');
  assert.ok(await fx.setLens('classic'), 'classic composer entered');
}

async function upload(fx, name, bytes) {
  const inputs = path.join(fx.root, 'browser-inputs');
  fs.mkdirSync(inputs, { recursive: true });
  const file = path.join(inputs, name);
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  const { root } = await fx.cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await fx.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  assert.ok(nodeId, 'actual file input exists');
  await fx.cdp.send('DOM.setFileInputFiles', { nodeId, files: [file] });
}

async function send(fx, text) {
  await fx.evaluate(`(() => {
    const input = document.getElementById('promptInput');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await click(fx, '#sendBtn');
}

async function preview(fx, observed, id, name) {
  const shown = await until(() => fx.evaluate(`(() => {
    const item = state.attachments.find(item=>item.name===${JSON.stringify(name)});
    const image = document.querySelector('#attachmentTray .attach-pill-thumb');
    if (state.uploading || !item?.protectedImage || item.imageEditing || item.imageReviewRequired ||
      !image?.complete || !image.naturalWidth || image.src!==item.previewUrl) return null;
    const canvas = document.createElement('canvas');
    canvas.width=image.naturalWidth; canvas.height=image.naturalHeight;
    const ctx=canvas.getContext('2d'); ctx.drawImage(image,0,0);
    const pixel=(x,y)=>[...ctx.getImageData(x,y,1,1).data];
    return {id:item.id, sealed:item.sealed, originalPath:item.path || null, issued:item.protectedImage,
      imageWidth:canvas.width, imageHeight:canvas.height, masked:pixel(15,15), publicPixel:pixel(300,180)};
  })()`), 'actual protected attachment preview', 115000);
  const receipt = await until(() => observed.responses.find(row => row.path === '/api/media/images/' + shown.issued.id + '/preview' &&
    row.query.get('sessionId') === id && row.status === 200 && observed.completed.has(row.requestId)), 'authenticated preview response finished');
  const responsePath = receipt.path + '?' + receipt.query.toString();
  const base64 = await until(() => fx.evaluate(`(async () => {
    const response = window.__ruyiMediaPreviewBodies.get(${JSON.stringify(responsePath)});
    if (!response) return null;
    const bytes = new Uint8Array(await response);
    return btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join(''));
  })()`), 'actual browser response bytes');
  const bytes = Buffer.from(base64, 'base64');
  assert.equal(shown.sealed, true);
  assert.equal(shown.originalPath, null);
  assert.equal(shown.imageWidth, width);
  assert.equal(shown.imageHeight, height);
  assert.equal(shown.issued.sessionId, id);
  assert.equal(receipt.headers['content-type'], 'image/png');
  assert.equal(receipt.headers['x-ruyi-payload-sha256'], sha(bytes));
  assert.equal(shown.issued.payloadHash, sha(bytes));
  assert.equal(bytes.subarray(0,8).toString('hex'), '89504e470d0a1a0a');
  return { ...shown, base64: bytes.toString('base64') };
}

async function maskRegion(fx, oldId) {
  await click(fx, '#attachmentTray .attach-protected-preview');
  await until(() => fx.evaluate("Boolean(document.querySelector('.image-region-editor[open]'))"), 'real image editor open');
  await fx.evaluate(`[...document.querySelectorAll('.image-region-coordinates input')].forEach((field,index)=>{
    field.value=[10,10,25,20][index];
  })`);
  await click(fx, '.image-region-coordinates button');
  await click(fx, '.image-region-actions > button:nth-child(4)');
  await until(() => fx.evaluate(`(() => {
    const editor=document.querySelector('.image-region-editor[open]'), item=state.attachments[0];
    return editor?.getAttribute('aria-busy')==='false' && item?.protectedImage?.id &&
      item.protectedImage.id!==${JSON.stringify(oldId)} && JSON.stringify(item.chosenImageRegions?.boxes)==='[[10,10,35,30]]';
  })()`), 'applied region produced a new protected PNG');
  await click(fx, '.image-region-actions > button:last-child');
}

function assertWire(wire, shown, original, name, expectedText) {
  const user = wireMessages(wire).findLast(row => row.role === 'user');
  assert.ok(Array.isArray(user?.content), 'wire user turn has protected image parts');
  const parts = user.content.filter(row => wireImageUrl(row) !== null);
  assert.equal(parts.length, 1);
  const allImages = wireMessages(wire).flatMap(row => Array.isArray(row.content) ? row.content.filter(part => wireImageUrl(part) !== null) : []);
  assert.equal(allImages.length, 1, 'the complete wire contains only the current reviewed image');
  assert.equal(wireImageUrl(parts[0]), 'data:image/png;base64,' + shown.base64);
  const raw = JSON.stringify(wire);
  assert.ok(!raw.includes(original.toString('base64')) && !raw.includes(name) &&
    !raw.includes(shown.issued.reference), 'wire contains only the protected representation');
  assert.ok(user.content.some(row => ['text', 'input_text'].includes(row.type) && row.text.includes(expectedText)));
}

async function run({ full, apiStyle = 'chat' }) {
  const t = createRunner(full ? 'MEDIA BROWSER FULL SEND STEER ' + apiStyle.toUpperCase() : 'MEDIA BROWSER MISSING');
  let fx, releaseHold, observed, receiver;
  try {
    assert.equal(process.platform, 'win32', 'browser media fixture requires Windows DPAPI');
    assert.ok(['chat', 'responses', 'anthropic'].includes(apiStyle));
    const sourceRoot = full && process.env.RUYI_MEDIA_BROWSER_SOURCE_ROOT;
    if (sourceRoot) {
      assert.ok(path.isAbsolute(sourceRoot));
      assert.equal(sha(fs.readFileSync(path.join(sourceRoot, 'app', 'server.js'))), sha(fs.readFileSync(path.join(WB, 'app', 'server.js'))),
        'qualification source must match the current generated server');
      for (const key of ['RUYI_MEDIA_RUNTIME_ROOT', 'RUYI_MEDIA_SOURCES_ROOT']) assert.ok(path.isAbsolute(process.env[key] || ''), key);
    }
    const workbenchRoot = full ? sourceRoot ? fs.realpathSync(sourceRoot) : packagePath(process.env.RUYI_MEDIA_BROWSER_PACKAGE) : undefined;
    const workbench = workbenchRoot || WB;
    const serverEnv = {};
    const held = new Promise(resolve => { releaseHold = resolve; });
    const wires = [];
    let holdSeen = false, encryptedRoot, sendSession, steerSession;
    const receive = async body => {
      wires.push(structuredClone(body));
      if (!holdSeen && JSON.stringify(wireMessages(body)).includes(holdText)) { holdSeen = true; await held; }
    };
    if (apiStyle !== 'chat') receiver = await startMediaBrowserProvider(apiStyle, doneText, receive);
    await startBrowserFixture({
      prefix: 'ruyi-media-browser-', workbenchRoot, serverEnv, ok: t.ok,
      config: { locale: 'en-US', privacyModeV1: 'enhanced', privacyRulesV1: [], privacyTechnicalV1: false,
        credentialEncryptionV1: true, workDataEncryptionV1: false, stewardEnabledV1: false, stewardThreadBriefV1: false,
        schedulerEnabledV1: false, enableMcpDropIn: false, importAgentInstructions: false,
        contextAutoCompactEnabled: false, allowDesktopTools: false, desktopMcp: { enabled: false, autodetect: false } },
      evidenceObserver: { beforeStart(value) { fx = value; }, provider() {}, child() {}, cleanup() {} },
      async beforeServe(fixture) {
        if (receiver) {
          const file = path.join(fixture.home, 'config.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
          Object.assign(config.providers[0], { apiStyle, baseUrl: receiver.baseUrl });
          fs.writeFileSync(file, JSON.stringify(config));
        }
        const isolation = releaseEnvironment(path.join(fixture.root, 'server-profile'), fixture.home);
        for (const key of Object.keys(process.env)) if (!Object.hasOwn(isolation, key)) isolation[key] = undefined;
        Object.assign(serverEnv, isolation, { RUYI_MEDIA_RESOURCE_PROFILE: 'legacy-full-4987-v1', RUYI_MEDIA_OCR_LANGUAGE: 'en-US',
          RUYI_MEDIA_RUNTIME_ROOT: full ? sourceRoot ? process.env.RUYI_MEDIA_RUNTIME_ROOT : undefined : path.join(fixture.root, 'missing-runtime'),
          RUYI_MEDIA_SOURCES_ROOT: full ? sourceRoot ? process.env.RUYI_MEDIA_SOURCES_ROOT : undefined : path.join(fixture.root, 'missing-source') });
        const seedEnv = releaseEnvironment(path.join(fixture.root, 'seed-profile'), fixture.home);
        seedEnv.RUYI_TEST_SERVER_JS = path.join(workbench, 'app', 'server.js');
        encryptedRoot = execFileSync(process.execPath, [__filename, '--seed-encrypted', fixture.home],
          { env: seedEnv, encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
      },
      async provider(ctx) {
        assert.equal(apiStyle, 'chat', 'browser must use the selected protocol receiver');
        await receive(ctx.body);
        ctx.text(doneText);
        ctx.stop();
      },
      async prepare(fixture) {
        const create = async title => {
          const response = await fixture.request('POST', '/api/sessions', { title, cwd: fixture.work,
            engineRoute: { engine: 'openai', providerId: 'fake', model: 'fake-model' } });
          assert.equal(response?.status, 200);
          const id = response.json?.session?.id;
          assert.ok(id, 'test session created');
          return id;
        };
        const status = await fixture.request('GET', '/api/status');
        assert.equal(status.json?.config?.workDataEncryptionV1, true);
        assert.equal(fs.realpathSync(status.json?.dataRoot).toLowerCase(), fs.realpathSync(encryptedRoot).toLowerCase());
        sendSession = await create('Public Send fixture');
        steerSession = await create('Public Steer fixture');
      },
    });
    observed = observe(fx);
    await fx.cdp.send('Network.enable');
    if (full) await capturePreviewBytes(fx);
    await selectSession(fx, sendSession);
    const sendName = 'SyntheticSensitiveSendName.bmp', sendColor = [112,160,208], sendBytes = bmp(sendColor);
    await upload(fx, sendName, sendBytes);
    if (!full) {
      const refusal = await until(() => observed.responses.find(row => row.path === '/api/media/images/prepare' && row.status === 409 &&
        observed.completed.has(row.requestId)),
        'typed prepare refusal');
      const body = await fx.cdp.send('Network.getResponseBody', { requestId: refusal.requestId });
      const raw = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      assert.equal(JSON.parse(raw).error?.code, 'privacy.image_processor_dependency_failed');
      const retained = `!state.uploading && state.attachments[0]?.sealed===true && state.attachments[0]?.imageReviewRequired===true &&
        !state.attachments[0]?.protectedImage && !document.querySelector('#attachmentTray .attach-pill-thumb')`;
      await until(() => fx.evaluate(retained), 'sealed draft retained without raw preview');
      t.ok(true, 'real encrypted browser upload reaches typed component refusal and retains a reviewable draft');
      await send(fx, sendText);
      const strings = JSON.parse(fs.readFileSync(path.join(workbench, 'app', 'public', 'locales', 'en-US.json'), 'utf8'));
      await until(() => fx.evaluate(`(${retained}) && document.getElementById('promptInput').value===${JSON.stringify(sendText)} &&
        document.getElementById('toastTray').textContent.includes(${JSON.stringify(strings['mediaImage.reviewRequired'])})`),
        'failed Send preserves composer with review guidance');
      assert.equal(observed.writes.filter(route => route === '/api/chat/stream' || route === '/api/steer').length, 0);
      assert.equal(wires.length, 0);
      t.ok(true, 'browser Send refuses missing Full components without dispatch or raw-image fallback');
      return;
    }
    const base = await preview(fx, observed, sendSession, sendName);
    assert.deepEqual(base.masked, [...sendColor,255]);
    await maskRegion(fx, base.issued.id);
    const exact = await preview(fx, observed, sendSession, sendName);
    assert.equal(fs.existsSync(path.join(encryptedRoot, 'uploads', exact.id, sendName)), false);
    assert.deepEqual(exact.masked, [0,0,0,255]);
    assert.deepEqual(exact.publicPixel, [...sendColor,255]);
    const forbidden = await fx.request('GET', '/api/media/images/' + exact.issued.id + '/preview?sessionId=' + steerSession);
    assert.equal(forbidden.status, 409);
    assert.equal(forbidden.json?.error?.code, 'privacy.image_scope_changed');
    t.ok(true, 'real encrypted tray and editor apply a mask, preserve public pixels and reject preview in another session');
    await send(fx, sendText);
    const sendWire = await until(() => wires.find(body => JSON.stringify(wireMessages(body)).includes(sendText)), 'Send wire receipt');
    assertWire(sendWire, exact, sendBytes, sendName, sendText);
    await until(() => fx.evaluate(`!state.streaming && document.getElementById('messages').textContent.includes(${JSON.stringify(doneText)})`),
      'Send rendered provider result');
    assert.equal(observed.writes.filter(route => route === '/api/chat/stream').length, 1);
    t.ok(true, 'actual Browser Send delivers the exact reviewed PNG with no original bytes, filename or private reference');
    await selectSession(fx, steerSession);
    await send(fx, holdText);
    await until(() => holdSeen, 'live native turn held at the local provider');
    assert.ok(await fx.evaluate('state.streaming'), 'native turn is still active');
    const steerName = 'SyntheticSensitiveSteerName.bmp', steerColor = [112,208,144], steerBytes = bmp(steerColor);
    await upload(fx, steerName, steerBytes);
    const steer = await preview(fx, observed, steerSession, steerName);
    assert.equal(fs.existsSync(path.join(encryptedRoot, 'uploads', steer.id, steerName)), false);
    assert.deepEqual(steer.publicPixel, [...steerColor,255]);
    assert.notEqual(steer.base64, exact.base64);
    await send(fx, '');
    await until(() => fx.evaluate('state.streaming && !state.attachments.length'), 'browser Steer acknowledged and clears only the sent draft');
    assert.equal(observed.writes.filter(route => route === '/api/steer').length, 1);
    assert.equal(observed.writes.filter(route => route === '/api/chat/stream').length, 2);
    releaseHold();
    const steerWire = await until(() => wires.find(body => JSON.stringify(wireMessages(body)).includes(steer.base64)), 'Steer wire receipt');
    assertWire(steerWire, steer, steerBytes, steerName, 'protected.png');
    await until(() => fx.evaluate('!state.streaming'), 'native turn finishes after Steer');
    assert.equal(wires.filter(body => JSON.stringify(wireMessages(body)).includes(exact.base64)).length, 1);
    assert.equal(wires.filter(body => JSON.stringify(wireMessages(body)).includes(steer.base64)).length, 1);
    assert.equal(wires.length, 3);
    receiver?.assert();
    const seen = JSON.stringify(wires);
    for (const raw of [sendName, steerName, sendBytes.toString('base64'), steerBytes.toString('base64'), exact.issued.reference, steer.issued.reference]) {
      assert.ok(!seen.includes(raw), 'all captured provider requests preserve the original-image exclusion');
    }
    t.ok(true, 'attachment-only Browser Steer stays on the live native turn and delivers its exact PNG without the original name or bytes');
    console.log('MEDIA-BROWSER-PROOF ' + JSON.stringify({ packagedServerSha256: sha(fs.readFileSync(path.join(workbench, 'app', 'server.js'))),
      bundledNode: Boolean(workbenchRoot), sourceQualification: Boolean(sourceRoot), apiStyle, workDataEncryption: true, sendPngSha256: exact.issued.payloadHash,
      steerPngSha256: steer.issued.payloadHash, providerRequests: wires.length }));
  } catch (error) {
    t.fail(error.stack || String(error));
    try {
      const state = await fx?.evaluate(`(() => ({ uploading: window.state?.uploading,
        attachments: (window.state?.attachments || []).map(item => ({ sealed: item.sealed,
          protected: Boolean(item.protectedImage), editing: item.imageEditing, reviewRequired: item.imageReviewRequired,
          preview: Boolean(item.previewUrl), error: item.imageError || null })),
        thumbnails: [...document.querySelectorAll('#attachmentTray .attach-pill-thumb')].map(image =>
          ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight })) }))()`);
      console.log('MEDIA-BROWSER-DIAG ' + JSON.stringify({ state, mediaResponses: observed?.responses
        .filter(row => row.path.startsWith('/api/media/images/') || row.path === '/api/upload')
        .map(row => ({ route: row.path.replace(/[a-f0-9]{32}/g, '<ticket>'), status: row.status,
          completed: observed.completed.has(row.requestId) })), exceptions: fx?.exceptions.length,
        consoleErrors: fx?.consoleErrors.length }));
    } catch { /* diagnostics must not replace the original failure */ }
    const refused = observed?.responses.filter(row => row.path === '/api/media/images/prepare' &&
      row.status >= 400 && observed.completed.has(row.requestId)).at(-1);
    if (refused) {
      try {
        const reply = await fx.cdp.send('Network.getResponseBody', { requestId: refused.requestId });
        const raw = reply.base64Encoded ? Buffer.from(reply.body, 'base64').toString('utf8') : reply.body;
        const code = JSON.parse(raw)?.error?.code;
        if (typeof code === 'string' && /^[a-z._]+$/.test(code)) console.log('MEDIA-BROWSER-DIAG prepare ' + refused.status + ' ' + code);
      } catch { /* keep the original failure */ }
    }
  } finally {
    releaseHold?.();
    try { await receiver?.close(); } catch (error) { t.fail(error.stack || String(error)); }
    if (fx) {
      if (t.failures) console.log('Media browser fixture retained at ' + fx.root);
      try { await fx.close({ keepRoot: t.failures !== 0 }); } catch (error) { t.fail(error.stack || String(error)); }
    }
    t.done();
  }
}

if (require.main === module) {
  assert.equal(process.argv[2], '--seed-encrypted');
  seedEncrypted(process.argv[3]).then(root => console.log(root)).catch(error => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}
module.exports = { run };
