const VisualPipeline = (() => {
  const nodeFsp = require('fs/promises');
  const nodePath = require('path');
  // ── v0.9-S7 视觉回路 (§0.9-S7 / 总纲 §7.5) ────────────────────────────────────────────────────────────
  // Image-part plumbing for the provider (OpenAI-compat) engine. Two entry points feed the model images:
  //   (1) image ATTACHMENTS on a user turn (buildUserContentParts, runOpenAiTurn) — vision=true only;
  //   (2) tool SCREENSHOTS surfaced by a bridged desktop tool (extractToolImages + the tool-loop tail).
  // Both obey the pairing/continuity铁律: an image is ONLY ever added inside a `role:'user'` message, and a
  // tool screenshot's user message is appended AFTER the whole tool batch closes (never wedged in a block).
  // HISTORY保图≤2 (pruneOldImages) bounds visual-history膨胀 by demoting the OLDEST image parts to text.
  const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;   // attachment extensions we send as image parts
  const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  const IMAGE_ATTACH_MAX = 5 * 1024 * 1024;   // ≤5MB/张; larger → text占位 (avoid history膨胀 / request bloat)
  const HISTORY_IMAGE_KEEP = 2;               // 保图≤2: at most this many image_url parts survive in history

  function attachmentMime(name) {
    const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return (m && IMAGE_MIME[m[1]]) || 'image/png';
  }
  // Build the OpenAI `content` PARTS array for a user turn that carries image attachments (vision path).
  // Text part first (the same string buildAttachmentPrompt produced), then one image_url part per image
  // attachment whose file reads back ≤5MB. An oversize/unreadable image degrades to an inline text占位 (so
  // the model still knows an image was attached but nothing bloats the request). Non-image attachments are
  // already described in the text part; they are NOT re-read here. Returns a parts array. Never throws.
  async function buildUserContentParts(textContent, attachments) {
    const parts = [{ type: 'text', text: String(textContent || '') }];
    for (const a of (attachments || [])) {
      if (!a || !a.path || !IMAGE_EXT_RE.test(String(a.name || a.path))) continue;
      // v1.9:优先发 sendPath —— 上传时为超限大图压缩出的派生件(13b maybeCompressImageAttachment,≤5MB
      // 目标),大图不再直接降级占位;派生件缺失/不可读回退原图,仍超限才降级占位文本。mime 跟实际发送文件走。
      let target = String(a.sendPath || '') || a.path;
      try {
        let st = await nodeFsp.stat(target).catch(() => null);
        if (!st && target !== a.path) { target = a.path; st = await nodeFsp.stat(target); }
        if (!st) throw new Error('missing');
        if (st.size > IMAGE_ATTACH_MAX) { parts[0].text += `\n[图片过大未发送:${a.name || nodePath.basename(a.path)}]`; continue; }
        const buf = await nodeFsp.readFile(target);
        // 字节魔数优先,扩展名兜底:文件名说 .png 字节却是 JPEG(截图工具/改名)时,Anthropic Messages 协议会因
        // media_type 与字节不符直接 400(04i 的编码照单全收这里给的 mime)。与下方工具截图的 toImageDataUri 同一口径。
        const b64 = buf.toString('base64');
        const uri = `data:${sniffImageMime(b64) || attachmentMime(target)};base64,${b64}`;
        parts.push({ type: 'image_url', image_url: { url: uri } });
      } catch { parts[0].text += `\n[图片读取失败:${a.name || nodePath.basename(a.path)}]`; }
    }
    return parts;
  }
  // Does a user turn carry at least one image attachment worth sending as a part? (Gate for parts-vs-string.)
  function hasImageAttachment(attachments) {
    return Array.isArray(attachments) && attachments.some(a => a && a.path && IMAGE_EXT_RE.test(String(a.name || a.path)));
  }
  // ── 工具结果里的图像字段(ACC 方言 + MCP 标准 ImageContent 映射后的形状)────────────────────────────────────────
  // 三处顶层/嵌套位置:`image` / `image_base64`(ACC screenshot、window_screenshot、get_clipboard_image)、
  // `screenshot.image`(ACC observe),外加 normalizeMcpToolResult 把第三方 MCP 的 `type:'image'` 块映射成的
  // `image_base64`(第一张)+`images:[{mimeType,data}]`(多张)。每个字段旁的 format/mimeType/image_mime 给出真实类型。
  // 审计 F3/A11:修前一律贴 `data:image/png`,ACC 的 format:"jpeg" 会被当 PNG 发出去,Anthropic Messages 校验 media_type
  // 与字节不符直接 400。现在:字节魔数优先(服务端校验的是字节),其次兄弟键声明的类型,最后才回落 png。
  const FORMAT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  function mimeFromHint(v) {
    const h = String(v == null ? '' : v).trim().toLowerCase();
    if (!h) return '';
    if (/^image\/[a-z0-9.+-]+$/.test(h)) return h === 'image/jpg' ? 'image/jpeg' : h;
    return FORMAT_MIME[h.replace(/^\./, '')] || '';
  }
  // 只解码前 24 个 base64 字符(18 字节)够认 PNG/JPEG/GIF/WEBP/BMP 的头。
  function sniffImageMime(b64) {
    let head;
    try { head = Buffer.from(String(b64 || '').slice(0, 24), 'base64'); } catch { return ''; }
    if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
    if (head.length >= 6 && head.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
    if (head.length >= 12 && head.slice(0, 4).toString('latin1') === 'RIFF' && head.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) return 'image/bmp';
    return '';
  }
  // 从图像字节读宽高(PNG IHDR / JPEG SOFn);认不出返回 null。只为占位文案与结果元数据,不做校验。
  function imageSizeFromBuffer(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
    return null;
  }
  function toImageDataUri(v, ...hints) {
    if (typeof v !== 'string' || !v) return '';
    if (v.startsWith('data:')) return v;
    let mime = sniffImageMime(v);
    for (let k = 0; !mime && k < hints.length; k += 1) mime = mimeFromHint(hints[k]);
    return `data:${mime || 'image/png'};base64,${v}`;
  }
  // 像图像载荷吗:data URI,或一长串 base64/base64url 字符(排除 `nginx:latest`、`C:\\x.png` 这类恰好叫 image 的普通字符串 ——
  // 非视觉路径会把命中的字段换成占位,误伤普通字段比漏掉一张图更糟)。
  // 非 data: 分支光靠「≥12 字符且全是 base64 字符集」不够:`{image:'bitnami/postgresql'}` 这样的普通镜像名/标识符也满足,
  // 被当成截图后会生成非法图片块(provider 400,还写进 providerHistory 反复 400)并抹掉原字段。现在两层:
  //   ① 魔数确认(最强证据):解出的头字节是 PNG/JPEG/GIF/WEBP/BMP(sniffImageMime,与随后 toImageDataUri 认的是同一张表)→ 是图;
  //   ② 魔数认不出时,排除「全小写标识符」形状(IDENT_SLUG_RE:容器镜像名 bitnami/postgresql、nginx-ingress-controller、my_module_v2
  //      这一整类 —— 镜像名按规范必须全小写,恰是 `image` 字段最常见的非图撞名)。真 base64 载荷在 ≥12 个字符里一个大写字母都没有的
  //      概率可忽略不计,所以不会误杀真图。
  // 不把「②」收成「必须魔数」:既有断言(unit/tool-dispatch-hardening F3、vision-loop 的 fake-mcp 夹具)锁着「字节认不出时回落兄弟键声明的
  // 类型 / png」—— 未知格式或占位串形态的载荷照旧当图(混合大小写的标识符仍有撞名可能,但那比误杀未知格式的真图更可接受)。
  const IDENT_SLUG_RE = /^[a-z0-9]+(?:[/_-][a-z0-9]+)*$/;
  function looksLikeImagePayload(v) {
    if (typeof v !== 'string') return false;
    if (v.startsWith('data:')) return /^data:image\//i.test(v);
    const head = v.length > 512 ? v.slice(0, 512) : v;
    if (v.length < 12 || !/^[A-Za-z0-9+/=_-]+$/.test(head)) return false;
    return sniffImageMime(v) !== '' || !IDENT_SLUG_RE.test(head);
  }
  // 结果里所有图像字段的引用:{ value, mime(推断出的 data URI 之前的类型), width, height, replace(text) → 就地改克隆 }。
  function imageFieldRefs(resultObj) {
    const refs = [];
    if (!resultObj || typeof resultObj !== 'object') return refs;
    const top = { w: resultObj.width, h: resultObj.height };
    const topHints = [resultObj.image_mime, resultObj.mimeType, resultObj.mime_type, resultObj.media_type, resultObj.format];
    if (looksLikeImagePayload(resultObj.image)) refs.push({ value: resultObj.image, hints: topHints, ...top, set: (c, t) => { c.image = t; } });
    if (looksLikeImagePayload(resultObj.image_base64)) refs.push({ value: resultObj.image_base64, hints: topHints, ...top, set: (c, t) => { c.image_base64 = t; } });
    const shot = resultObj.screenshot;
    if (shot && typeof shot === 'object' && looksLikeImagePayload(shot.image)) {
      refs.push({ value: shot.image, hints: [shot.image_mime, shot.mimeType, shot.mime_type, shot.media_type, shot.format], w: shot.width, h: shot.height,
        set: (c, t) => { c.screenshot = { ...c.screenshot, image: t }; } });
    }
    if (Array.isArray(resultObj.images)) {
      resultObj.images.forEach((it, idx) => {
        if (it && typeof it === 'object' && looksLikeImagePayload(it.data)) {
          refs.push({ value: it.data, hints: [it.mimeType, it.mime_type, it.mime, it.media_type, it.format], w: it.width, h: it.height,
            set: (c, t) => { c.images = (c.images || resultObj.images).slice(); c.images[idx] = { ...c.images[idx], data: t }; } });
        }
      });
    }
    return refs;
  }
  // Pull screenshot image(s) out of a bridged tool result → array of data URIs (0..n). Pure read — does NOT mutate result.
  function extractToolImages(resultObj) {
    return imageFieldRefs(resultObj).map(r => toImageDataUri(r.value, ...r.hints)).filter(Boolean);
  }
  // Strip the heavy image field(s) out of a tool result BEFORE it is serialized into a `role:'tool'` message,
  // replacing each with a compact占位 so the tool-result JSON stays精简 (the actual pixels ride in a separate
  // user image message, appended after the batch). Returns a SHALLOW clone with the image fields占位ed; the
  // original object (used for the UI event) is untouched.
  // 第二参 placeholder:省略 = 视觉开时的「截图见随后的图片消息」;传 'no-vision' = 审计 N7,非视觉模型历史里用
  // 「[image omitted: WxH png, model has no vision]」(不再把 40 KB base64 当文字塞进历史)。也可传函数 (ref, mime) → 文本。
  function stripToolImageFields(resultObj, placeholder) {
    if (!resultObj || typeof resultObj !== 'object') return resultObj;
    const refs = imageFieldRefs(resultObj);
    if (!refs.length) return { ...resultObj };
    const clone = { ...resultObj };
    for (const r of refs) {
      let replacement = typeof placeholder === 'string' && placeholder !== 'no-vision' ? placeholder : '[截图见随后的图片消息]';
      if (placeholder === 'no-vision' || typeof placeholder === 'function') {
        const mime = (toImageDataUri(r.value, ...r.hints).match(/^data:([^;]+);/) || [])[1] || 'image/png';
        replacement = typeof placeholder === 'function' ? placeholder(r, mime)
          : `[image omitted: ${Number(r.w) > 0 && Number(r.h) > 0 ? `${Number(r.w)}x${Number(r.h)} ` : ''}${mime.replace('image/', '')}, model has no vision]`;
      }
      r.set(clone, replacement);
    }
    return clone;
  }
  // 保图≤2 (§0.9-S7): after injecting a new image message, walk providerHistory and demote the OLDEST
  // image_url parts down to a text占位 so at most HISTORY_IMAGE_KEEP(2) survive. We ONLY rewrite parts INSIDE a
  // user message's content array — we NEVER delete a message, so the pairing铁律 (every tool_call_id answered)
  // is untouched. Idempotent: an already-demoted slot is a plain text part and no longer counts as an image.
  // Returns the number of images demoted this pass (0 = under the cap). Mirrors evaporateHistory's cache-safety
  // note: this rewrites old content, so it runs ONLY right after a new image lands (never speculatively).
  function pruneOldImages(history) {
    if (!Array.isArray(history)) return 0;
    // Collect every (messageIndex, partIndex) that is currently an image_url part, oldest-first.
    const slots = [];
    for (let mi = 0; mi < history.length; mi++) {
      const c = history[mi] && history[mi].content;
      if (!Array.isArray(c)) continue;
      for (let pi = 0; pi < c.length; pi++) {
        const p = c[pi];
        if (p && (p.type === 'image_url' || p.image_url || p.type === 'image')) slots.push([mi, pi]);
      }
    }
    if (slots.length <= HISTORY_IMAGE_KEEP) return 0;
    const demoteCount = slots.length - HISTORY_IMAGE_KEEP;
    let demoted = 0;
    for (let k = 0; k < demoteCount; k++) {
      const [mi, pi] = slots[k];
      history[mi].content[pi] = { type: 'text', text: `[截图已淘汰:${k + 1}]` };
      demoted++;
    }
    return demoted;
  }
  return Object.freeze({ buildUserContentParts, hasImageAttachment, extractToolImages, stripToolImageFields, pruneOldImages, sniffImageMime, imageSizeFromBuffer });
})();
