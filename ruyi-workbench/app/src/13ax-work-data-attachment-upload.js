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

const attachmentRuntimes = () => ({
  attachment: WorkDataAttachmentRuntime.create({ root: paths.uploads, keys: workDataKeys, enabled: () => true, face: 'attachment' }),
  toolImage: WorkDataAttachmentRuntime.create({ root: paths.uploads, keys: workDataKeys, enabled: () => true, face: 'toolImage' }),
});
WorkDataAttachmentUploadHooks.sealToolImage = async ({ id, name, mime, data }) => {
  const config = await readConfig();
  if (config.workDataEncryptionV1 !== true) return null;
  const runtime = WorkDataAttachmentRuntime.create({ root: paths.uploads, keys: workDataKeys, enabled: () => true, face: 'toolImage' });
  try {
    await runtime.seal({ id, kind: 'tool-image', logicalName: name, mime, data });
    return true;
  } catch (error) {
    // The id is content-derived, so a repeated tool image hits id_exists; that is
    // the sealed equivalent of the raw path's "already present, skip the write".
    if (error && String(error.code || '').endsWith('id_exists') && await runtime.has(id)) return true;
    throw error;
  }
};
WorkDataAttachmentUploadHooks.removeToolImages = async sessionId => {
  const prefix = 'toolimg_' + toolImageSessionTag(sessionId) + '_';
  const runtime = WorkDataAttachmentRuntime.create({ root: paths.uploads, keys: workDataKeys, enabled: () => true, face: 'toolImage', allowSealedRemoval: true });
  const removed = [];
  for (const row of await runtime.list()) {
    if (row.state !== 'sealed' || !row.id.startsWith(prefix)) continue;
    try { await runtime.retireSealed(row.id); removed.push(row.id); }
    catch { /* a single damaged row must not stop the rest of the sweep */ }
  }
  return Object.freeze({ removed: Object.freeze(removed) });
};
WorkDataAttachmentUploadHooks.info = async id => {
  for (const runtime of Object.values(attachmentRuntimes())) {
    if (await runtime.has(id)) {
      const stat = await runtime.stat(id);
      return Object.freeze({ totalBytes: stat.totalBytes, sha256: stat.sha256, mime: stat.metadata?.mime || 'application/octet-stream' });
    }
  }
  return null;
};
WorkDataAttachmentUploadHooks.read = async ({ id, start, end }) => {
  for (const runtime of Object.values(attachmentRuntimes())) {
    if (!(await runtime.has(id))) continue;
    const lease = await runtime.read(id, start, end);
    try { return Object.freeze({ bytes: Buffer.from(lease.bytes), totalBytes: lease.totalBytes, sha256: lease.sha256, mime: lease.metadata?.mime || 'application/octet-stream' }); }
    finally { try { lease.release(); } catch {} }
  }
  throw Object.assign(Error('work_data_attachment_runtime.id_missing'), { code: 'work_data_attachment_runtime.id_missing', statusCode: 404 });
};