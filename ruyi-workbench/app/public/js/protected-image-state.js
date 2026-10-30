'use strict';
import { state } from './state.js';
import { api, apiRaw } from './net.js';
import { t } from './i18n.js';

export const REGION_LIMIT = 128;
const images = new Set();
let scopeGeneration = 0;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const failure = key => new Error(t('mediaImage.' + key));
export function imagePolicyStamp() {
  const config=state.config||{},pick=(value,keys)=>Object.fromEntries(keys.map(key=>[key,value?.[key]]));
  // Advisory invalidation only. Match PrivacyGateway.options/secrets inputs and
  // the host's provider recipient inputs; server policy epochs and final wire
  // recipient checks remain authoritative (including masked credentials).
  return JSON.stringify({
    ...pick(config,['privacyModeV1','privacyTechnicalV1','privacyRulesV1','privacyPolicyRecoveryRequiredV1',
      'credentialEncryptionV1','workDataEncryptionV1','modelsApiKey','modelsApiBase','activeProvider']),
    searchBackend:pick(config.searchBackend,['apiKey','baseUrl']),
    providers:(config.providers||[]).map(provider=>pick(provider,
      ['id','type','enabled','baseUrl','audioBaseUrl','extraBaseUrls','apiKey','extraHeaders','apiStyle','model','vision','anthropicAuth','anthropicFallbacks'])),
    externalMcpServers:(config.externalMcpServers||[]).map(server=>pick(server,['url','env','headers','args']))
  });
}
export const isProtectedImage = record => record?.kind === 'image' || /\.(png|jpe?g|gif|webp|bmp)$/i.test(record?.name || '');
export const sameRegionBinding = (a, b) => !!a && !!b && ['sourceHash','sourceRevision','width','height','transformHash'].every(key => a[key] === b[key]);
export function regionSelection(manifest, boxes) {
  if (!manifest || !hex(manifest.sourceHash) || !hex(manifest.transformHash)
    || typeof manifest.sourceRevision !== 'string' || !manifest.sourceRevision || manifest.sourceRevision.length > 256
    || !Number.isSafeInteger(manifest.width) || !Number.isSafeInteger(manifest.height)
    || manifest.width < 1 || manifest.height < 1 || manifest.width * manifest.height > 8000000
    || !Array.isArray(boxes) || boxes.length > REGION_LIMIT) throw failure('reviewRequired');
  const normalized = boxes.map(box => {
    if (!Array.isArray(box) || box.length !== 4 || box.some(n => !Number.isFinite(n))
      || box[0] < 0 || box[1] < 0 || box[2] > manifest.width || box[3] > manifest.height
      || box[0] >= box[2] || box[1] >= box[3]) throw failure('regionInvalid');
    return [Math.floor(box[0]), Math.floor(box[1]), Math.ceil(box[2]), Math.ceil(box[3])];
  });
  return { space:'canonical-pixels-v1', sourceHash:manifest.sourceHash, sourceRevision:manifest.sourceRevision,
    width:manifest.width, height:manifest.height, transformHash:manifest.transformHash, boxes:normalized };
}
// Use the rendered image rectangle (not its scroll container or natural source
// dimensions). No object-fit letterboxing or original EXIF guess participates.
export function regionPoint(clientX, clientY, rect, width, height) {
  if (![clientX,clientY,rect?.left,rect?.top,rect?.width,rect?.height,width,height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0) return null;
  return [Math.min(width,Math.max(0,(clientX-rect.left)*width/rect.width)),
    Math.min(height,Math.max(0,(clientY-rect.top)*height/rect.height))];
}
export function dragRegion(start, end) {
  if (!start || !end) return null;
  const box = [Math.floor(Math.min(start[0],end[0])),Math.floor(Math.min(start[1],end[1])),
    Math.ceil(Math.max(start[0],end[0])),Math.ceil(Math.max(start[1],end[1]))];
  return box[0] < box[2] && box[1] < box[3] ? box : null;
}
function cancelOperation(record) {
  record.imagePreparationGeneration = (record.imagePreparationGeneration || 0) + 1;
  record.imagePreparationController?.abort();
}
export function invalidateImageOperations() {
  scopeGeneration += 1;
  for (const record of [...images]) { cancelOperation(record); record.imageEditorClose?.(); }
}
export function releaseImagePreviews(record) {
  if (!record) return;
  cancelOperation(record); record.imageEditorClose?.();
  for (const url of new Set([record.previewUrl,record.imageBasePreview?.url].filter(Boolean))) URL.revokeObjectURL(url);
  delete record.previewUrl; delete record.imageBasePreview; images.delete(record);
}
export async function discardProtectedImage(record) {
  const old = record.protectedImage;
  // Synchronous revocation: even a failing DELETE/prepare must not restore send
  // authority for a preview that does not contain the newly requested regions.
  delete record.protectedImage;
  if (old?.id) await api('/api/media/images/' + encodeURIComponent(old.id), { method:'DELETE' });
}
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
export async function prepareProtectedImages(attachments, sessionId, { signal, force = false, regions, editor = false, review = false } = {}) {
  for (const record of attachments || []) {
    if (!isProtectedImage(record)) continue;
    if (record.imageEditing && !editor) throw failure('editingBlocked');
    const mode = state.config?.privacyModeV1 || 'off';
    if (mode === 'off') {
      if (record.chosenImageRegions?.boxes?.length || record.imageManualMaskRequired) throw failure('reviewRequired');
      // Ordinary auto-prepared attachments retain the existing OFF path. An
      // explicit nonempty manual-mask commitment must first be reviewed/cleared.
      if (record.protectedImage || record.imageBasePreview) {
        const removal=discardProtectedImage(record); removal.catch(()=>{});
        releaseImagePreviews(record);
      } else if (record.imagePreparationController) cancelOperation(record);
      delete record.imageReviewRequired;
      continue;
    }
    if (!['basic','enhanced','strict'].includes(mode)) throw failure('policyUnavailable');
    if (record.imageReviewRequired && !review && !editor) throw failure('reviewRequired');
    const stamp = imagePolicyStamp();
    if (!force && record.protectedImage?.sessionId === sessionId && record.protectedImage.policyStamp === stamp
      && record.protectedImage.expiresAt > Date.now()+5000) continue;
    if (record.imagePreparationController) throw failure('editingBlocked');
    const selection = regions === undefined ? record.chosenImageRegions || null : regions;
    const bound = selection === null ? null : regionSelection(selection,selection.boxes);
    if (bound?.boxes.length) record.imageManualMaskRequired=true;
    const accepted = record.protectedImage;
    const controller = new AbortController(), generation = (record.imagePreparationGeneration || 0)+1, scope = scopeGeneration;
    record.imagePreparationGeneration = generation; record.imagePreparationController = controller; images.add(record);
    const abort = () => controller.abort();
    signal?.addEventListener('abort',abort,{once:true}); if (signal?.aborted) abort();
    const current = () => {
      if (controller.signal.aborted || generation !== record.imagePreparationGeneration || scope !== scopeGeneration
        || state.currentSession?.id !== sessionId || stamp !== imagePolicyStamp()) throw failure('reviewRequired');
    };
    let issued, preview;
    try {
      await discardProtectedImage(record); current();
      if (!editor && !review && accepted && accepted.policyStamp !== stamp) throw failure('reviewRequired');
      issued = await api('/api/media/images/prepare', { method:'POST',signal:controller.signal,
        body:JSON.stringify({sessionId,id:record.id,name:record.name,...(bound ? {regions:bound} : {})}) });
      current();
      const manifest = issued?.manifest;
      regionSelection(manifest,[]);
      if (!/^[a-f0-9]{32}$/.test(issued?.id || '') || issued.reference !== 'https://ruyi.invalid/protected-image/'+issued.id
        || !hex(manifest.payloadHash) || manifest.mime !== 'image/png' || manifest.name !== 'protected.png'
        || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > 5*1024*1024
        || !Number.isFinite(manifest.expiresAt) || manifest.expiresAt <= Date.now()+1000) throw failure('prepareFailed');
      if (bound && !sameRegionBinding(bound,manifest)) throw failure('reviewRequired');
      const response = await apiRaw('/api/media/images/'+encodeURIComponent(issued.id)+'/preview?sessionId='+encodeURIComponent(sessionId), {signal:controller.signal}); current();
      const manifestHash = await digest(new TextEncoder().encode(JSON.stringify(manifest))); current();
      const regionsHash = await digest(new TextEncoder().encode(JSON.stringify(bound))); current();
      if (!response.ok || response.headers.get('content-type') !== 'image/png'
        || response.headers.get('x-ruyi-payload-sha256') !== manifest.payloadHash
        || response.headers.get('x-ruyi-manifest-sha256') !== manifestHash || manifest.regionsHash !== regionsHash) throw failure('prepareFailed');
      const blob = await response.blob(), bytes = await blob.arrayBuffer(); current();
      const actual = await digest(bytes); current();
      const header = new DataView(bytes);
      if (bytes.byteLength !== manifest.bytes || bytes.byteLength < 33 || actual !== manifest.payloadHash
        || header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a
        || header.getUint32(12) !== 0x49484452 || header.getUint32(16) !== manifest.width || header.getUint32(20) !== manifest.height) throw failure('prepareFailed');
      // TTL renewal may preserve a reviewed PNG only when the displayed source,
      // transform AND resulting bytes are still identical. Changed policy or
      // processor output requires the user's fresh preview in the editor.
      if (!editor && !review && accepted && (!sameRegionBinding(accepted.manifest,manifest) || accepted.payloadHash !== actual)) throw failure('reviewRequired');
      preview = URL.createObjectURL(blob); current();
      const oldUrl = record.previewUrl, oldBase = record.imageBasePreview;
      if (!bound || !bound.boxes.length) record.imageBasePreview = {url:preview,manifest,policyStamp:stamp};
      else if (oldBase && !sameRegionBinding(oldBase.manifest,manifest)) throw failure('reviewRequired');
      record.previewUrl = preview;
      record.protectedImage = {id:issued.id,reference:issued.reference,expiresAt:manifest.expiresAt,sessionId,payloadHash:actual,policyStamp:stamp,manifest};
      if (review) delete record.chosenImageRegions;
      else if (bound) record.chosenImageRegions = bound;
      if (review || bound?.boxes.length===0) delete record.imageManualMaskRequired;
      delete record.imageReviewRequired;
      for (const url of new Set([oldUrl,oldBase?.url].filter(Boolean))) if (url !== preview && url !== record.imageBasePreview?.url) URL.revokeObjectURL(url);
      preview = null; issued = null;
    } catch (error) {
      // A failed reprepare, Apply or changed binding requires an explicit review.
      if (generation === record.imagePreparationGeneration) record.imageReviewRequired = true;
      throw error;
    } finally {
      if (preview) URL.revokeObjectURL(preview);
      if (/^[a-f0-9]{32}$/.test(issued?.id || '')) void api('/api/media/images/'+encodeURIComponent(issued.id),{method:'DELETE'}).catch(()=>{});
      signal?.removeEventListener('abort',abort);
      if (record.imagePreparationController === controller) delete record.imagePreparationController;
      if (!record.previewUrl && !record.imageEditing) images.delete(record);
    }
  }
}
