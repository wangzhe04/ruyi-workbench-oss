// Transport adapter: registers the sealed-upload hook so 13-http-router keeps no
// static edge to the attachment runtime (SCC ceiling). Loaded after the router.
WorkDataAttachmentUploadHooks.sealUpload = async function sealUpload(body) {
  const rawName = typeof body?.name === 'string' ? body.name : '';
  let safeName = sanitizeFsSegmentName(path.win32.basename(rawName)).replace(/[. ]+$/, '').slice(0, 200);
  if (!safeName || /^[. ]*$/.test(safeName)) safeName = 'upload.bin';
  const encoded = String(body?.data || '').includes(',') ? String(body.data).split(',').pop() : String(body?.data || '');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length) return null;
  const mime = typeof body?.mime === 'string' && /^[-A-Za-z0-9.+]+[/][-A-Za-z0-9.+]+$/.test(body.mime) ? body.mime : 'application/octet-stream';
  const id = 'file_' + require('node:crypto').randomBytes(8).toString('hex');
  const runtime = WorkDataAttachmentRuntime.create({ root: paths.uploads, keys: workDataKeys, enabled: () => true });
  await runtime.seal({ id, kind: 'original', logicalName: safeName, mime, data: bytes });
  const audioLike = /\.(wav|mp3|m4a|webm|ogg|flac)$/i.test(safeName);
  const imageLike = /\.(png|jpe?g|gif|webp|bmp)$/i.test(safeName);
  // Derived work (OCR/transcribe/compress) needs the sealed bytes and is not wired.
  return Object.freeze({ id, name: safeName, size: bytes.length, createdAt: nowIso(), sealed: true,
    ...(audioLike ? { kind: 'audio' } : {}), ...(imageLike ? { kind: 'image' } : {}) });
};
