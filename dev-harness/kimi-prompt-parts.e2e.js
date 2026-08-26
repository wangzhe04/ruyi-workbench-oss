// Credential-free Kimi ACP prompt-parts contract test. Loads the new source fragment in a VM with a
// controlled guard and temporary files; it never starts Kimi, a server, a network request, or a build.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'ruyi-workbench', 'app', 'src', '05-claude-engine.js');
const PARTS = path.join(ROOT, 'ruyi-workbench', 'app', 'src', '05d-kimi-prompt-parts.js');
let failures = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { failures++; console.log('FAIL ' + label); }
};

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kimi-prompt-parts-'));
const workspace = path.join(tempRoot, 'workspace');
const uploads = path.join(tempRoot, 'uploads');
const outside = path.join(tempRoot, 'outside');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(uploads, { recursive: true });
fs.mkdirSync(outside, { recursive: true });

const realFsp = fs.promises;
let statCalls = 0;
let readCalls = 0;
let openCalls = 0;
let guardCalls = 0;
let guardMode = 'workspace';
const events = [];
const fsp = {
  realpath: (...args) => realFsp.realpath(...args),
  stat: (...args) => { statCalls++; return realFsp.stat(...args); },
  readFile: (...args) => { readCalls++; return realFsp.readFile(...args); },
  open: async (...args) => {
    openCalls++;
    const handle = await realFsp.open(...args);
    const stat = handle.stat.bind(handle);
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    return {
      stat: (...statArgs) => { statCalls++; return stat(...statArgs); },
      read: async (...readArgs) => {
        const result = await read(...readArgs);
        if (result && result.bytesRead > 0) readCalls++;
        return result;
      },
      close: (...closeArgs) => close(...closeArgs),
    };
  },
};
const within = (target, root) => {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};
const sandbox = {
  Buffer,
  Object,
  Set,
  String,
  path,
  fsp,
  IMAGE_ATTACH_MAX: 5 * 1024 * 1024,
  paths: { uploads },
  realpathForContainment: rawPath => realFsp.realpath(rawPath),
  guardFileToolPath: async rawPath => {
    guardCalls++;
    if (guardMode === 'deny-all') return { ok: false, error: 'controlled guard denied' };
    const realPath = await realFsp.realpath(rawPath).catch(() => path.resolve(rawPath));
    const allowed = guardMode === 'workspace' && (within(realPath, workspace) || within(realPath, uploads));
    return allowed ? { ok: true, absPath: rawPath } : { ok: false, error: 'controlled guard denied' };
  },
  console,
};
vm.createContext(sandbox);
vm.runInContext(`${fs.readFileSync(PARTS, 'utf8')}\nthis.buildKimiAcpPromptParts = buildKimiAcpPromptParts;`, sandbox, { filename: PARTS });
const buildParts = sandbox.buildKimiAcpPromptParts;

const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const caps = { promptCapabilities: { image: true } };
const context = { session: { id: 'prompt-parts-e2e', cwd: workspace }, config: { defaultWorkspace: workspace }, onEvent: event => events.push(event) };
const attachment = (filePath, name, extra = {}) => ({ path: filePath, name: name || path.basename(filePath), ...extra });
const write = (filePath, bytes) => { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, bytes); return filePath; };
const imageParts = parts => parts.filter(part => part && part.type === 'image');
const textParts = parts => parts.filter(part => part && part.type === 'text');
const resetCounters = () => { statCalls = 0; readCalls = 0; openCalls = 0; guardCalls = 0; events.length = 0; };

(async () => {
  try {
    const pngPath = write(path.join(workspace, 'one.png'), pngBytes);
    const jpegPath = write(path.join(workspace, 'two.jpeg'), jpegBytes);
    resetCounters();
    let parts = await buildParts('look at these', [attachment(pngPath), attachment(jpegPath)], caps, context);
    const images = imageParts(parts);
    ok(parts[0]?.type === 'text' && parts[0].text === 'look at these', 'ACP prompt keeps the original first text block');
    ok(images.length === 2 && images[0].mimeType === 'image/png' && images[1].mimeType === 'image/jpeg', 'valid PNG/JPEG attachments become ACP image blocks');
    ok(Buffer.from(images[0].data, 'base64').equals(pngBytes) && Buffer.from(images[1].data, 'base64').equals(jpegBytes), 'ACP image data is the verified file bytes');
    ok(guardCalls === 2 && openCalls === 2 && readCalls === 2 && statCalls === 4, 'accepted images use guard, stat-before/read, and stat-after');

    resetCounters();
    parts = await buildParts('/compact now', [], caps, context);
    ok(parts.length === 1 && parts[0].text === '/compact now', 'no attachments keeps a raw slash prompt');
    ok(readCalls === 0 && guardCalls === 0, 'no-image prompt performs no filesystem work');

    const notePath = write(path.join(workspace, 'note.txt'), Buffer.from('not an image'));
    resetCounters();
    parts = await buildParts('read the note', [attachment(notePath)], caps, context);
    ok(imageParts(parts).length === 0 && readCalls === 0 && guardCalls === 0, 'non-image attachment is not re-read or sent remotely');

    resetCounters();
    parts = await buildParts('image without capability', [attachment(pngPath)], { promptCapabilities: {} }, context);
    ok(imageParts(parts).length === 0 && readCalls === 0 && guardCalls === 0, 'missing image capability degrades without reading the image');
    ok(textParts(parts).some(part => /one\.png/.test(part.text)) && events.some(event => event.type === 'stderr'), 'capability degradation preserves the file reference and emits stderr');

    const fakeMimePath = write(path.join(workspace, 'fake-mime.png'), pngBytes);
    resetCounters();
    parts = await buildParts('fake mime', [attachment(fakeMimePath, 'fake-mime.png', { mimeType: 'text/plain' })], caps, context);
    ok(imageParts(parts).length === 0 && readCalls === 0 && events.length > 0, 'contradictory MIME is rejected before reading');

    const htmlPath = write(path.join(workspace, 'html-disguised.png'), Buffer.from('<script>alert(1)</script>', 'utf8'));
    resetCounters();
    parts = await buildParts('do not upload html', [attachment(htmlPath)], caps, context);
    ok(imageParts(parts).length === 0 && readCalls === 1 && textParts(parts).some(part => /字节头/.test(part.text)), 'text disguised as PNG is rejected by the byte header');

    const tooLargePath = path.join(workspace, 'too-large.png');
    const tooLargeBytes = Buffer.alloc(5 * 1024 * 1024 + 1);
    pngBytes.copy(tooLargeBytes);
    write(tooLargePath, tooLargeBytes);
    resetCounters();
    parts = await buildParts('large image', [attachment(tooLargePath)], caps, context);
    ok(imageParts(parts).length === 0 && readCalls === 0 && /5 MiB|5242880/.test(textParts(parts).map(part => part.text).join('\n')), 'single-image limit rejects >5 MiB before read');

    const totalPaths = [];
    const fourMiB = Buffer.alloc(4 * 1024 * 1024);
    pngBytes.copy(fourMiB);
    for (let i = 0; i < 4; i++) totalPaths.push(write(path.join(workspace, `total-${i}.png`), fourMiB));
    resetCounters();
    parts = await buildParts('total limit', totalPaths.map(filePath => attachment(filePath)), caps, context);
    ok(imageParts(parts).length === 3 && textParts(parts).some(part => /总大小/.test(part.text)), '15 MiB total limit keeps only images within the cap');

    const countPaths = [];
    for (let i = 0; i < 5; i++) countPaths.push(write(path.join(workspace, `count-${i}.png`), pngBytes));
    resetCounters();
    parts = await buildParts('count limit', countPaths.map(filePath => attachment(filePath)), caps, context);
    ok(imageParts(parts).length === 4 && textParts(parts).some(part => /最多发送 4/.test(part.text)), 'four-image count limit preserves the fifth reference as a fallback');

    const outsidePath = write(path.join(outside, 'outside.png'), pngBytes);
    resetCounters();
    parts = await buildParts('outside', [attachment(outsidePath)], caps, context);
    ok(imageParts(parts).length === 0 && readCalls === 0 && guardCalls === 1, 'out-of-workspace image is rejected by the normal guard');

    resetCounters();
    parts = await buildParts('traversal', [attachment(path.join(workspace, '..', 'outside', 'outside.png'))], caps, context);
    ok(imageParts(parts).length === 0 && readCalls === 0, 'traversal-resolved outside path is not read');

    resetCounters();
    parts = await buildParts('relative', [attachment('relative.png')], caps, context);
    ok(imageParts(parts).length === 0 && readCalls === 0 && guardCalls === 0 && /绝对路径/.test(textParts(parts).map(part => part.text).join('\n')), 'relative image attachment is rejected without invoking the guard');

    resetCounters();
    const missingPath = path.join(workspace, 'missing.png');
    parts = await buildParts('missing', [attachment(missingPath)], caps, context);
    ok(imageParts(parts).length === 0 && readCalls === 0 && events.length > 0, 'read failure degrades without aborting the turn');

    const uploadPath = write(path.join(uploads, 'file_owned123', 'owned.png'), pngBytes);
    guardMode = 'workspace';
    resetCounters();
    parts = await buildParts('owned upload', [attachment(uploadPath)], caps, context);
    ok(imageParts(parts).length === 1 && readCalls === 1 && guardCalls === 1, 'normal guard permits a canonical owned upload');

    guardMode = 'deny-all';
    resetCounters();
    parts = await buildParts('explicitly denied upload', [attachment(uploadPath)], caps, context);
    ok(imageParts(parts).length === 0 && openCalls === 0 && readCalls === 0, 'explicit normal-guard denial cannot be overridden by upload path shape');

    const makeJunction = (link, target) => {
      try {
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
        return true;
      } catch (error) {
        console.log(`SKIP junction fixture ${link}: ${error && error.message || error}`);
        return false;
      }
    };
    const externalUploadRoot = path.join(outside, 'external-upload-root');
    const externalUploadId = path.join(externalUploadRoot, 'file_external123');
    const externalUploadFile = write(path.join(externalUploadId, 'root-junction.png'), pngBytes);
    const uploadRootJunction = path.join(uploads, 'junction-root');
    const uploadRootJunctionFile = path.join(uploadRootJunction, 'file_external123', 'root-junction.png');
    const rootJunctionMade = makeJunction(uploadRootJunction, externalUploadRoot);
    if (rootJunctionMade) {
      resetCounters();
      guardMode = 'workspace';
      parts = await buildParts('upload root junction', [attachment(uploadRootJunctionFile)], caps, context);
      ok(imageParts(parts).length === 0 && openCalls === 0 && readCalls === 0, 'upload-root junction escaping its canonical root is not read');
    }

    const externalUploadIdTarget = path.join(outside, 'external-upload-id');
    const externalUploadIdFile = write(path.join(externalUploadIdTarget, 'id-junction.png'), pngBytes);
    const fileIdJunction = path.join(uploads, 'file_junction');
    const fileIdJunctionFile = path.join(fileIdJunction, 'id-junction.png');
    const idJunctionMade = makeJunction(fileIdJunction, externalUploadIdTarget);
    if (idJunctionMade) {
      resetCounters();
      guardMode = 'workspace';
      parts = await buildParts('file id junction', [attachment(fileIdJunctionFile)], caps, context);
      ok(imageParts(parts).length === 0 && openCalls === 0 && readCalls === 0, 'file_<id> junction escaping uploads is not read');
    }
    // Keep fixture variables live in the test output so a failed junction setup is diagnosable.
    ok(Boolean(externalUploadFile && externalUploadIdFile), 'junction fixtures have external targets');
    guardMode = 'workspace';
    const configBefore = JSON.stringify(context.config);
    ok(JSON.stringify(context.config) === configBefore, 'prompt-part processing does not mutate config');

    const engine = fs.readFileSync(ENGINE, 'utf8');
    const snippetStart = engine.indexOf('  const recoveryHistory =');
    const recoveryEndMarker = '  const historyRecoveryInjected = Boolean(recoveryHistory);\n';
    const recoveryEnd = engine.indexOf(recoveryEndMarker, snippetStart) + recoveryEndMarker.length;
    const promptStart = engine.indexOf('  const currentUserEnvelope =', recoveryEnd);
    const snippetEndMarker = "  const fullPrompt = kimiNativeSlashCommand ? String(message == null ? '' : message) : assembledPrompt;\n";
    const promptEnd = engine.indexOf(snippetEndMarker, promptStart) + snippetEndMarker.length;
    const snippetEnd = promptEnd;
    ok(engine.indexOf("  const slashCommand = String(message || '').trim().startsWith('/');") >= 0
      && snippetStart >= 0 && recoveryEnd > snippetStart && promptStart >= 0 && snippetEnd > promptStart,
    '05 entry contains the slash/recovery/prompt policy block');
    const policySnippet = engine.slice(snippetStart, recoveryEnd) + engine.slice(promptStart, promptEnd);
    const policy = vm.runInNewContext(`(function(input) {
      const agentCliType = input.agentCliType;
      const message = input.message;
      const slashCommand = String(message || '').trim().startsWith('/');
      const kimiNativeSlashCommand = agentCliType === 'kimi' && slashCommand;
      const _recoveryHistoryOverride = input.override;
      const agentRecoverySummary = input.summary;
      const recoverySource = input.recoverySource;
      const basePrompt = input.basePrompt;
      const indexInjection = input.indexInjection;
      const memoryTurnCheck = input.memoryTurnCheck;
      ${policySnippet}
      return { slashCommand, kimiNativeSlashCommand, recoveryHistory, historyRecoveryInjected, fullPrompt };
    })`, { buildClaudeRecoveryHistory: () => 'claude-history' });
    const runPolicy = policy;
    const slashInput = { agentCliType: 'kimi', message: '  /compact now', summary: 'summary', override: 'override', recoverySource: [], basePrompt: '  /compact now\n<attached_files>', indexInjection: '', memoryTurnCheck: 'memory' };
    const kimiPolicy = runPolicy(slashInput);
    ok(kimiPolicy.kimiNativeSlashCommand === true && kimiPolicy.recoveryHistory === '' && kimiPolicy.historyRecoveryInjected === false, 'Kimi slash with summary keeps recovery un-injected metadata accurate');
    ok(kimiPolicy.fullPrompt === slashInput.message, 'Kimi slash prompt remains the original message text');
    const claudePolicy = runPolicy({ ...slashInput, agentCliType: 'claude', override: null });
    ok(claudePolicy.kimiNativeSlashCommand === false && claudePolicy.recoveryHistory.includes('summary') && claudePolicy.historyRecoveryInjected === true, 'Claude slash recovery behavior remains on its original path');
    const regularClaudePolicy = runPolicy({ ...slashInput, agentCliType: 'claude', message: 'continue normally', summary: '', override: null });
    ok(regularClaudePolicy.recoveryHistory === 'claude-history', 'Claude non-slash recovery history remains available');
    const kimiBranch = engine.slice(engine.indexOf("  if (agentCliType === 'kimi' && !fakeClaude)"), engine.indexOf('\n  // cmd8191', engine.indexOf("  if (agentCliType === 'kimi' && !fakeClaude)")));
    ok(/session, message, attachments,/.test(kimiBranch) && /kimiNativeSlashCommand/.test(kimiBranch), '05 passes attachments and kimiNativeSlashCommand to the ACP bridge');
  } catch (error) {
    failures++;
    console.error('FAIL unexpected harness error:', error && error.stack || error);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  process.exitCode = failures ? 1 : 0;
})().catch(error => {
  failures++;
  console.error('FAIL unhandled harness error:', error && error.stack || error);
  process.exitCode = 1;
});
