const VisualPipeline = ((fspModule, pathModule) => {
  const fsp = fspModule;
  const path = pathModule;
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
      try {
        const st = await fsp.stat(a.path);
        if (st.size > IMAGE_ATTACH_MAX) { parts[0].text += `\n[图片过大未发送:${a.name || path.basename(a.path)}]`; continue; }
        const buf = await fsp.readFile(a.path);
        const uri = `data:${attachmentMime(a.name || a.path)};base64,${buf.toString('base64')}`;
        parts.push({ type: 'image_url', image_url: { url: uri } });
      } catch { parts[0].text += `\n[图片读取失败:${a.name || path.basename(a.path)}]`; }
    }
    return parts;
  }
  // Does a user turn carry at least one image attachment worth sending as a part? (Gate for parts-vs-string.)
  function hasImageAttachment(attachments) {
    return Array.isArray(attachments) && attachments.some(a => a && a.path && IMAGE_EXT_RE.test(String(a.name || a.path)));
  }
  // Pull screenshot image(s) out of a bridged tool result. Desktop MCP (ACC v1.4) may surface a screenshot as
  // `image` / `image_base64` (base64 or data URI) or nested under `screenshot.image`. Returns an array of data
  // URIs (0..n). The base64 is assumed PNG unless it is already a data: URI. Pure read — does NOT mutate result.
  function extractToolImages(resultObj) {
    if (!resultObj || typeof resultObj !== 'object') return [];
    const out = [];
    const push = v => {
      if (typeof v !== 'string' || !v) return;
      out.push(v.startsWith('data:') ? v : `data:image/png;base64,${v}`);
    };
    push(resultObj.image);
    push(resultObj.image_base64);
    if (resultObj.screenshot && typeof resultObj.screenshot === 'object') push(resultObj.screenshot.image);
    return out;
  }
  // Strip the heavy image field(s) out of a tool result BEFORE it is serialized into a `role:'tool'` message,
  // replacing each with a compact占位 so the tool-result JSON stays精简 (the actual pixels ride in a separate
  // user image message, appended after the batch). Returns a SHALLOW clone with the image fields占位ed; the
  // original object (used for the UI event) is untouched. Only called when we DID extract ≥1 image AND vision是开的.
  function stripToolImageFields(resultObj) {
    if (!resultObj || typeof resultObj !== 'object') return resultObj;
    const clone = { ...resultObj };
    if (typeof clone.image === 'string') clone.image = '[截图见随后的图片消息]';
    if (typeof clone.image_base64 === 'string') clone.image_base64 = '[截图见随后的图片消息]';
    if (clone.screenshot && typeof clone.screenshot === 'object' && typeof clone.screenshot.image === 'string') {
      clone.screenshot = { ...clone.screenshot, image: '[截图见随后的图片消息]' };
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
  return Object.freeze({ buildUserContentParts, hasImageAttachment, extractToolImages, stripToolImageFields, pruneOldImages });
})(fsp, path);
