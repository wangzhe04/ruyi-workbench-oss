'use strict';

// 输入框上方的附件托盘:渲染、上传(含「上传中…」占位与在飞计数)、缩略图 blob URL 的释放。
// 从 app.js 抽出 —— 组合根有行数护栏(frontend-domains D45 等,≤1280 且「不增行」),这一块带着 F13 的新增已放不下。
//
// 上传期间(F13,前端走查 W1-chat):修前 uploadFiles 全程没有任何进行中状态,发送过快时这一条消息漏掉附件、
// 附件反而挂到下一条消息上。现在:一进来就给每个文件放一个「上传中…」占位(只画在托盘里,不进 state.attachments
// —— 发送的永远是 state.attachments,占位不会被发出去),并把在飞数记到 state.uploading,sendPrompt 据此拦住发送。
// 缩略图预览用 URL.createObjectURL(file):修前从不释放。移除 / 发送出去 / 清场时经 revokeAttachmentPreview 释放。
import { state } from './state.js';
import { $, el, fmtBytes, toast } from './util.js';
import { api } from './net.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

const IMAGE_NAME_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
const UPLOAD_MAX_BYTES = 90 * 1048576;

export function createAttachmentTray({ apiErrText = error => String((error && error.message) || error || '') } = {}) {
  const pendingUploads = [];   // 「上传中…」占位 { name, size, controller, cancelled },与 state.uploading 同步
  // W2-F10：现场代数。清场（新线程／resetUploads）把它 +1；在飞的上传回来时发现代数变了，就丢掉自己的结果、不往新现场里塞附件
  // （修前 clearThreadStage 不碰 pendingUploads，上一条线程里还在飞的上传会落进新线程的托盘）。
  let stageGeneration = 0;

  function revokeAttachmentPreview(record) {
    if (!record || !record.previewUrl) return;
    try { URL.revokeObjectURL(record.previewUrl); } catch { /* ignore */ }
    delete record.previewUrl;
  }

  function renderAttachments() {
    const tray = $('attachmentTray');
    tray.innerHTML = '';
    state.attachments.forEach((f, i) => {
      const pill = el('span', 'attachment-pill');
      if (f.previewUrl) {
        const thumb = document.createElement('img');
        thumb.className = 'attach-pill-thumb';
        thumb.src = f.previewUrl;
        thumb.alt = f.name || '';
        pill.appendChild(thumb);
      }
      pill.append(el('span', '', `${f.name} · ${fmtBytes(f.size)}`));
      const x = el('button', 'attach-x'); x.appendChild(icon('close', 12)); x.setAttribute('aria-label', t('chat.attachRemoveAria')); x.title = t('common.remove');
      x.onclick = () => { const [removed] = state.attachments.splice(i, 1); revokeAttachmentPreview(removed); renderAttachments(); };
      pill.appendChild(x);
      tray.appendChild(pill);
    });
    for (const slot of pendingUploads) {
      const pill = el('span', 'attachment-pill uploading');
      pill.setAttribute('aria-busy', 'true');
      pill.append(el('span', '', `${slot.name} · ${t('chat.attachmentUploading')}`));
      // W2-F10：占位也有 ×（与已传好的附件同一枚按钮、同一个样式）。上传卡住时发送一直被「附件还在上传」拦着，
      // 修前只能刷新页面；现在点 × 就中止这一发（AbortController）并撤掉占位。
      const x = el('button', 'attach-x'); x.type = 'button'; x.appendChild(icon('close', 12));
      x.setAttribute('aria-label', t('chat.attachCancelAria', { name: slot.name })); x.title = t('common.cancel');
      x.onclick = () => cancelSlot(slot);
      pill.appendChild(x);
      tray.appendChild(pill);
    }
  }

  // 放行一个占位(成功 / 失败 / 过大 / 取消)就撤一个;幂等。
  function settleSlot(slot) {
    const at = pendingUploads.indexOf(slot);
    if (at >= 0) pendingUploads.splice(at, 1);
    state.uploading = pendingUploads.length;
    renderAttachments();
  }
  function cancelSlot(slot) {
    slot.cancelled = true;
    try { slot.controller.abort(); } catch { /* 没有 AbortController 的宿主：靠 cancelled 标记丢结果 */ }
    settleSlot(slot);
  }
  // 清场（新线程）：中止全部在飞的上传、撤掉占位、让回来的结果作废。
  function resetUploads() {
    stageGeneration += 1;
    for (const slot of [...pendingUploads]) {
      slot.cancelled = true;
      try { slot.controller.abort(); } catch { /* 同上 */ }
    }
    pendingUploads.length = 0;
    state.uploading = 0;
    renderAttachments();
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
  }

  async function uploadFiles(files) {
    const list = [...files].filter(Boolean);
    const generation = stageGeneration;
    const slots = list.map(file => ({ name: file.name, size: file.size, cancelled: false, controller: typeof AbortController === 'function' ? new AbortController() : { abort() {} } }));
    pendingUploads.push(...slots);
    state.uploading = pendingUploads.length;
    renderAttachments();
    for (let i = 0; i < list.length; i++) {
      const file = list[i], slot = slots[i];
      try {
        if (slot.cancelled) continue;
        if (file.size > UPLOAD_MAX_BYTES) { toast(t('toast.fileTooLarge', { p1: file.name }), 'err'); continue; }
        const data = await fileToBase64(file);
        if (slot.cancelled) continue;
        const res = await api('/api/upload', { method: 'POST', body: JSON.stringify({ name: file.name, data }), signal: slot.controller.signal });
        // 取消／清场之后才回来的结果不进托盘（服务端已落盘的那份文件不会被引用，无害）。
        if (slot.cancelled || generation !== stageGeneration) continue;
        const record = res.file;
        if (record && IMAGE_NAME_RE.test(String(record.name || ''))) record.previewUrl = URL.createObjectURL(file);
        if (record) state.attachments.push(record);
      } catch (e) {
        if (slot.cancelled || (e && e.name === 'AbortError')) continue;   // 用户点了 ×：不是失败，不弹错
        toast(t('toast.uploadFail', { p1: apiErrText(e) }), 'err');
      } finally { settleSlot(slot); }
    }
  }

  return Object.freeze({ renderAttachments, revokeAttachmentPreview, uploadFiles, resetUploads });
}
