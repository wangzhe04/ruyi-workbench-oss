'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFile(path.resolve(__dirname, '../../ruyi-workbench/app/src/11c-file-visual-io.js'), 'utf8');
async function reader(runLocalMediaHelper) {
  return vm.runInNewContext((await source) + '\nFileVisualIo;', { require, Buffer, MediaImageHooks: { runLocalMediaHelper } });
}

const bytes = Buffer.from('%PDF-bounded fixture bytes');
const image = Buffer.alloc(24);
Buffer.from('89504e470d0a1a0a', 'hex').copy(image);
image.writeUInt32BE(13, 8);
image.write('IHDR', 12);
image.writeUInt32BE(160, 16);
image.writeUInt32BE(80, 20);
const png = image.toString('base64');

test('protected text sends only the snapshot and bounded options to the fixed helper', async () => {
  const signal = new AbortController().signal;
  const io = await reader((helper, argv, input, options) => {
    assert.equal(helper, 'native-file-read.py');
    assert.equal(JSON.stringify(argv.slice(0, 2)), '["--protected",".pdf"]');
    assert.deepEqual(JSON.parse(argv[2]), { pageOffset: 1, pageLimit: 2, visual: false, ownerStub: false });
    assert.equal(input, bytes);
    assert.equal(options.signal, signal);
    assert.equal(options.timeoutMs, 30000);
    assert.equal(options.maxBytes, 12 * 1024 * 1024);
    assert.ok(!argv.join(' ').includes('private'));
    return { ok: true, mode: 'document', projection: 'document-text', content: 'Complete supported text', images: [], path: 'private' };
  });
  const result = await io.protectedDocument('C:/private/example.pdf', {}, 'private-script-path.py', signal, bytes);
  assert.equal(result.content, 'Complete supported text');
  assert.equal(result.path, undefined);
  assert.equal(result.images.length, 0);
});

test('protected vision requires an exact bounded PNG page window', async () => {
  const response = { ok: true, mode: 'document', projection: 'pdf-pages', content: 'PDF page render: page 2 of 3.',
    pageOffset: 2, totalPages: 3, nextPageOffset: 3, images: [{ name: 'page-2.png', mimeType: 'image/png', data: png, path: 'private' }] };
  const io = await reader(() => response);
  const args = { as: 'image', pageOffset: 2, pageLimit: 1 };
  const result = await io.protectedDocument('example.pdf', args, null, undefined, bytes);
  assert.equal(result.ok, true);
  assert.equal(result.images[0].data, png);
  assert.equal(result.images[0].path, undefined);
  response.images[0].data = 'not-canonical-base64!';
  assert.equal((await io.protectedDocument('example.pdf', args, null, undefined, bytes)).code, 'document_read_failed');
  response.images[0].data = png;
  response.nextPageOffset = undefined;
  assert.equal((await io.protectedDocument('example.pdf', args, null, undefined, bytes)).code, 'document_read_failed');
});

test('protected reads refuse unrecognized types, unavailable runtime and cancelled input', async () => {
  let launches = 0;
  const io = await reader(() => { launches += 1; });
  assert.equal((await io.protectedDocument('archive.zip', {}, null, undefined, bytes)).code, 'document_unsupported');
  assert.equal((await io.protectedDocument('example.pdf', {}, null, AbortSignal.abort(), bytes)).code, 'aborted');
  assert.equal(launches, 0);
  const noRuntime = await reader(undefined);
  assert.equal((await noRuntime.protectedDocument('example.pdf', {}, null, undefined, bytes)).code, 'reader_unavailable');
  const refusedRuntime = await reader(() => { throw Object.assign(Error('private helper path'), { code: 'privacy.image_runtime_unavailable' }); });
  const refused = await refusedRuntime.protectedDocument('example.pdf', {}, null, undefined, bytes);
  assert.equal(refused.code, 'reader_unavailable');
  assert.match(refused.hint, /Full offline/);
  assert.doesNotMatch(JSON.stringify(refused), /private helper path/);
});

test('protected kind refuses renamed container data before plain text fallback', async () => {
  const io = await reader(undefined);
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'ruyi-protected-document-kind-'));
  try {
    for (const [name, sample, kind] of [
      ['pdf.txt', bytes, 'document'],
      ['prefixed-pdf.txt', Buffer.concat([Buffer.alloc(400, 0x20), bytes]), 'document'],
      ['zip.txt', Buffer.from('504b0304', 'hex'), 'document'],
      ['video.txt', Buffer.from('00000010667479706d703432', 'hex'), 'video'],
      ['avi.txt', Buffer.from('RIFF0000AVI '), 'video'],
      ['ebml.txt', Buffer.from('1a45dfa3', 'hex'), 'video'],
      ['plain.txt', Buffer.from('text with PDF-like words'), null],
    ]) {
      const file = path.join(root, name);
      await fs.writeFile(file, sample);
      assert.equal(await io.kind(file), null, name);
      assert.equal(await io.kind(file, true), kind, name);
    }
  } finally {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), temp);
    assert.ok(path.basename(resolved).startsWith('ruyi-protected-document-kind-'));
    await fs.rm(root, { recursive: true });
  }
});
