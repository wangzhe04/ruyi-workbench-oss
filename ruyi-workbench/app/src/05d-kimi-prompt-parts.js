// Kimi ACP prompt content blocks. This fragment is deliberately filesystem-only: the 05b bridge owns the
// ACP process/RPC lifecycle and calls this helper after initialize.agentCapabilities is known.
const KIMI_ACP_PROMPT_IMAGE_MAX_BYTES = typeof IMAGE_ATTACH_MAX === 'number'
  ? IMAGE_ATTACH_MAX : 5 * 1024 * 1024;
const KIMI_ACP_PROMPT_IMAGE_TOTAL_MAX_BYTES = 15 * 1024 * 1024;
const KIMI_ACP_PROMPT_IMAGE_MAX_COUNT = 4;
const KIMI_ACP_PROMPT_IMAGE_SPECS = Object.freeze({
  png: { mimeType: 'image/png' },
  jpg: { mimeType: 'image/jpeg' },
  jpeg: { mimeType: 'image/jpeg' },
  gif: { mimeType: 'image/gif' },
  webp: { mimeType: 'image/webp' },
  bmp: { mimeType: 'image/bmp' },
});
const KIMI_ACP_PROMPT_IMAGE_LIKE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'avif',
]);

async function kimiAcpPromptRealpath(rawPath) {
  if (typeof realpathForContainment === 'function') return realpathForContainment(rawPath);
  return fsp.realpath(rawPath);
}

function kimiAcpPromptDeclaredMime(attachment) {
  if (!attachment || typeof attachment !== 'object') return '';
  for (const key of ['mimeType', 'mimetype', 'mime', 'type']) {
    const value = String(attachment[key] || '').trim().toLowerCase().split(';', 1)[0];
    // Existing upload records do not carry a MIME field. Ignore generic UI labels such as "file" while
    // treating every actual type/subtype declaration as security-relevant.
    if (value.includes('/')) return value;
  }
  return '';
}

function kimiAcpPromptAttachmentReference(attachment) {
  try {
    const rawPath = String(attachment && attachment.path || '');
    const name = String(attachment && attachment.name || (rawPath ? path.basename(rawPath) : 'attachment'));
    return `${name}: ${rawPath}`;
  } catch { return 'attachment'; }
}

function kimiAcpPromptClassifyAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object' || !String(attachment.path || '')) return { kind: 'none' };
  const rawPath = String(attachment.path);
  const pathExt = path.extname(rawPath).slice(1).toLowerCase();
  const nameExt = path.extname(String(attachment.name || '')).slice(1).toLowerCase();
  const declaredMime = kimiAcpPromptDeclaredMime(attachment);
  const pathSpec = Object.prototype.hasOwnProperty.call(KIMI_ACP_PROMPT_IMAGE_SPECS, pathExt)
    ? KIMI_ACP_PROMPT_IMAGE_SPECS[pathExt] : null;
  const nameSpec = Object.prototype.hasOwnProperty.call(KIMI_ACP_PROMPT_IMAGE_SPECS, nameExt)
    ? KIMI_ACP_PROMPT_IMAGE_SPECS[nameExt] : null;
  const imageHint = Boolean(pathSpec || nameSpec || KIMI_ACP_PROMPT_IMAGE_LIKE_EXTENSIONS.has(pathExt)
    || KIMI_ACP_PROMPT_IMAGE_LIKE_EXTENSIONS.has(nameExt) || declaredMime.startsWith('image/'));
  if (!imageHint) return { kind: 'non-image', rawPath };
  if (!pathSpec) return { kind: 'image', rawPath, reason: '图片扩展名不在 ACP 安全白名单内' };
  if (nameExt && (!nameSpec || nameSpec.mimeType !== pathSpec.mimeType)) {
    return { kind: 'image', rawPath, reason: '附件名称扩展名与实际路径扩展名不一致' };
  }
  if (declaredMime && (declaredMime === 'image/jpg' ? 'image/jpeg' : declaredMime) !== pathSpec.mimeType) {
    return { kind: 'image', rawPath, reason: `声明的 MIME ${declaredMime} 与扩展名不一致` };
  }
  return { kind: 'image', rawPath, ext: pathExt, spec: pathSpec };
}

function kimiAcpPromptMagicMatches(ext, buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (ext === 'png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === 'jpg' || ext === 'jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (ext === 'gif') return buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a');
  if (ext === 'webp') return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (ext === 'bmp') return buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d;
  return false;
}

async function kimiAcpPromptGuardAttachmentPath(rawPath, context) {
  if (!path.isAbsolute(rawPath)) return { ok: false, reason: '附件路径必须是绝对路径' };
  let guarded = null;
  try {
    if (typeof guardFileToolPath === 'function') {
      guarded = await guardFileToolPath(rawPath, {
        session: context && context.session,
        config: context && context.config,
      }, { write: false, tool: 'kimi_acp_prompt_image' });
    }
  } catch (error) {
    guarded = { ok: false, error: String(error && error.message || error) };
  }
  if (guarded && guarded.ok) {
    try {
      const canonical = await kimiAcpPromptRealpath(String(guarded.absPath || rawPath));
      return { ok: true, path: canonical };
    } catch (error) {
      return { ok: false, reason: `realpath 失败：${String(error && error.message || error)}` };
    }
  }
  // Do not override an explicit file guard denial with a lexical uploads/file_<id>/basename heuristic. The
  // normal guard already owns canonical workspace and dataRoot/uploads containment, including junctions.
  return { ok: false, reason: (guarded && guarded.error) || '路径未通过文件读取边界校验' };
}

function kimiAcpPromptWarn(context, attachment, reason) {
  const detail = `[Kimi ACP 图片降级] ${kimiAcpPromptAttachmentReference(attachment)}；${reason}`;
  try {
    if (context && typeof context.onEvent === 'function') context.onEvent({ type: 'stderr', text: detail });
  } catch { /* notification failure must not abort the turn */ }
  return detail;
}

function kimiAcpPromptFallbackBlock(attachment, reason) {
  return {
    type: 'text',
    text: `[附件图片未转为 ACP 图片块]\n- ${kimiAcpPromptAttachmentReference(attachment)}\n- 降级原因：${reason}`,
  };
}

function kimiAcpPromptReferenceBlock(attachment) {
  return { type: 'text', text: `[附件引用]\n- ${kimiAcpPromptAttachmentReference(attachment)}` };
}

// Build ACP ContentBlocks for only this turn's explicitly-path-backed image attachments. The first block is
// always the caller's prompt verbatim; all degradation is represented by later text blocks and stderr events.
// This helper never spawns, performs network I/O, mutates config, or throws an attachment failure into the
// enclosing turn.
async function buildKimiAcpPromptParts(prompt, attachments, capabilities, context) {
  const promptText = String(prompt == null ? '' : prompt);
  const parts = [{ type: 'text', text: promptText }];
  const references = [];
  const images = [];
  const list = Array.isArray(attachments) ? attachments : [];
  const canSendImages = Boolean(capabilities && capabilities.promptCapabilities && capabilities.promptCapabilities.image === true);
  let imageCount = 0;
  let imageBytes = 0;
  for (const attachment of list) {
    let classification;
    try { classification = kimiAcpPromptClassifyAttachment(attachment); } catch { classification = { kind: 'none' }; }
    if (classification.kind === 'none') continue;
    if (classification.kind === 'non-image') {
      if (classification.rawPath && !promptText.includes(classification.rawPath)) references.push(kimiAcpPromptReferenceBlock(attachment));
      continue;
    }
    if (!canSendImages) {
      const reason = 'ACP agentCapabilities.promptCapabilities.image 未明确声明为 true';
      kimiAcpPromptWarn(context, attachment, reason);
      references.push(kimiAcpPromptFallbackBlock(attachment, reason));
      continue;
    }
    if (classification.reason) {
      kimiAcpPromptWarn(context, attachment, classification.reason);
      references.push(kimiAcpPromptFallbackBlock(attachment, classification.reason));
      continue;
    }
    if (imageCount >= KIMI_ACP_PROMPT_IMAGE_MAX_COUNT) {
      const reason = `本回合最多发送 ${KIMI_ACP_PROMPT_IMAGE_MAX_COUNT} 张图片`;
      kimiAcpPromptWarn(context, attachment, reason);
      references.push(kimiAcpPromptFallbackBlock(attachment, reason));
      continue;
    }
    const guarded = await kimiAcpPromptGuardAttachmentPath(classification.rawPath, context).catch(error => ({
      ok: false, reason: String(error && error.message || error),
    }));
    if (!guarded.ok) {
      const reason = guarded.reason || '附件路径未通过安全校验';
      kimiAcpPromptWarn(context, attachment, reason);
      references.push(kimiAcpPromptFallbackBlock(attachment, reason));
      continue;
    }
    let handle = null;
    try {
      // Bound allocation before reading. A whole-file path read could observe a file that grew after the first
      // stat and allocate an unbounded buffer; the handle reads at most the per-image limit plus one byte,
      // then handle.stat() proves that the bytes and file size still agree.
      handle = await fsp.open(guarded.path, 'r');
      const before = await handle.stat();
      if (!before.isFile()) throw new Error('附件不是普通文件');
      if (before.size > KIMI_ACP_PROMPT_IMAGE_MAX_BYTES) throw new Error(`单图超过 ${KIMI_ACP_PROMPT_IMAGE_MAX_BYTES} 字节上限`);
      if (imageBytes + before.size > KIMI_ACP_PROMPT_IMAGE_TOTAL_MAX_BYTES) throw new Error('本回合图片总大小超过 15 MiB 上限');
      const buffer = Buffer.alloc(Math.min(KIMI_ACP_PROMPT_IMAGE_MAX_BYTES + 1, Math.max(1, before.size + 1)));
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        const count = Number(result && result.bytesRead) || 0;
        if (!count) break;
        bytesRead += count;
      }
      const after = await handle.stat();
      if (!after.isFile() || after.size !== bytesRead) throw new Error('图片在读取期间发生变化');
      if (bytesRead > KIMI_ACP_PROMPT_IMAGE_MAX_BYTES) throw new Error(`实际读取字节数超过 ${KIMI_ACP_PROMPT_IMAGE_MAX_BYTES} 上限`);
      if (imageBytes + bytesRead > KIMI_ACP_PROMPT_IMAGE_TOTAL_MAX_BYTES) throw new Error('实际读取后图片总大小超过 15 MiB 上限');
      const actual = buffer.subarray(0, bytesRead);
      if (!kimiAcpPromptMagicMatches(classification.ext, actual)) throw new Error('图片字节头与扩展名/MIME 不匹配');
      images.push({ type: 'image', data: actual.toString('base64'), mimeType: classification.spec.mimeType });
      imageCount += 1;
      imageBytes += bytesRead;
    } catch (error) {
      const reason = `图片读取或验证失败：${String(error && error.message || error)}`;
      kimiAcpPromptWarn(context, attachment, reason);
      references.push(kimiAcpPromptFallbackBlock(attachment, reason));
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }
  return parts.concat(references, images);
}
