'use strict';
import { state } from './state.js';
import { el, toast } from './util.js';
import { t } from './i18n.js';
import { REGION_LIMIT, regionSelection, sameRegionBinding, regionPoint, dragRegion,
  imagePolicyStamp, prepareProtectedImages } from './protected-image-state.js';

export function openImageRegionEditor(record, { onChange = () => {} } = {}) {
  if (record.imageEditing || record.imagePreparationController) return;
  const sessionId = state.currentSession?.id;
  let manifest = record.imageBasePreview?.manifest;
  if (!sessionId || !manifest || !record.imageBasePreview?.url) { toast(t('mediaImage.reviewRequired'),'err'); return; }
  const stamp = imagePolicyStamp(), trigger = document.activeElement, controller = new AbortController();
  if (record.imageBasePreview.policyStamp !== stamp) record.imageReviewRequired = true;
  const dialog = document.createElement('dialog'); dialog.className = 'image-region-editor';
  const title = el('h2','',t('mediaImage.editRegions'));
  title.id = 'image-region-editor-title'; dialog.setAttribute('aria-labelledby',title.id);
  const hint = el('p','image-region-hint',t('mediaImage.editorHint'));
  const status = el('p','image-region-status'); status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
  const surface = el('div','image-region-surface'), image = document.createElement('img'), masks = el('div','image-region-masks');
  image.alt = t('mediaImage.editCanvas'); image.draggable = false;
  surface.append(image,masks);
  const form = el('form','image-region-coordinates'), fields = [];
  for (const key of ['x','y','width','height']) {
    const label = el('label','',t('mediaImage.coordinate.'+key)), input = document.createElement('input');
    input.type = 'number'; input.step = '1'; input.min = key==='width'||key==='height' ? '1' : '0';
    input.required = true; input.value = key==='width'||key==='height' ? '1' : '0';
    label.append(input); form.append(label); fields.push(input);
  }
  const button = (key,handler) => { const node=el('button','',t(key)); node.type='button'; node.onclick=handler; return node; };
  const add = button('mediaImage.addRegion',()=>form.requestSubmit()); form.append(add);
  const list = el('ol','image-region-list'); list.setAttribute('aria-label',t('mediaImage.selectedRegions'));
  const clear = button('mediaImage.clearRegions',()=>{ boxes=[]; applied=false; paint(); add.focus(); });
  const exact = button('mediaImage.preview',()=>{ showingExact=!showingExact; paint(); });
  const review = button('mediaImage.reviewCurrent',()=>void prepare(true));
  const apply = button('mediaImage.applyRegions',()=>void prepare(false));
  const close = button('common.cancel',()=>dialog.close());
  const actions = el('div','image-region-actions'); actions.append(clear,exact,review,apply,close);
  dialog.append(title,hint,surface,form,list,status,actions);
  let boxes = sameRegionBinding(record.chosenImageRegions,manifest) ? record.chosenImageRegions.boxes.map(box=>box.slice()) : [];
  let live=true,busy=false,showingExact=false,applied=false,drag=null,error='';
  record.imageEditing = true;
  const clean = () => {
    if (!live) return; live=false; controller.abort(); clearInterval(watch);
    delete record.imageEditing; delete record.imageEditorClose;
    dialog.remove(); onChange();
    if (trigger?.isConnected) trigger.focus();
    else [...document.querySelectorAll('#attachmentTray .attach-protected-preview')].find(node=>node.dataset.imageAttachmentId===String(record.id))?.focus();
  };
  record.imageEditorClose = () => { if (dialog.open) dialog.close(); clean(); };
  const scopeValid = () => state.currentSession?.id === sessionId && stamp === imagePolicyStamp();
  const watch = setInterval(()=>{ if (!scopeValid()) { record.imageReviewRequired=true; record.imageEditorClose?.(); } },250);
  dialog.addEventListener('close',clean,{once:true});
  // Native modal focus containment and Escape are retained; abort merely
  // revokes this UI operation. It is never interpreted as helper closure.
  dialog.addEventListener('cancel',()=>{ controller.abort(); });
  function paint() {
    const url = showingExact && record.protectedImage ? record.previewUrl : record.imageBasePreview.url;
    if (image.src !== url) image.src = url;
    surface.style.width = manifest.width+'px';
    masks.replaceChildren();
    if (!showingExact) for (const box of [...boxes,...(drag?.box ? [drag.box] : [])]) {
      const mask=el('div','image-region-mask');
      mask.style.left=100*box[0]/manifest.width+'%'; mask.style.top=100*box[1]/manifest.height+'%';
      mask.style.width=100*(box[2]-box[0])/manifest.width+'%'; mask.style.height=100*(box[3]-box[1])/manifest.height+'%'; masks.append(mask);
    }
    list.replaceChildren();
    boxes.forEach((box,index)=>{
      const item=el('li','',t('mediaImage.regionDescription',{index:index+1,x:box[0],y:box[1],width:box[2]-box[0],height:box[3]-box[1]}));
      const remove=button('common.remove',()=>{ boxes.splice(index,1); applied=false; paint(); (list.querySelector('button')||add).focus(); });
      remove.setAttribute('aria-label',t('mediaImage.removeRegion',{index:index+1})); remove.disabled=busy||showingExact;
      item.append(remove); list.append(item);
    });
    const disabled=busy||showingExact||record.imageReviewRequired===true;
    for (let i=0;i<fields.length;i++) { fields[i].disabled=disabled; fields[i].max=String(i%2===0?manifest.width:manifest.height); }
    add.disabled=disabled||boxes.length>=REGION_LIMIT; clear.disabled=disabled||!boxes.length;
    apply.disabled=disabled; exact.disabled=busy||!record.protectedImage||record.imageReviewRequired===true;
    exact.textContent=t(showingExact?'mediaImage.editRegions':'mediaImage.preview');
    review.hidden=!record.imageReviewRequired; review.disabled=busy;
    close.textContent=t(applied?'common.close':'common.cancel');
    dialog.setAttribute('aria-busy',String(busy));
    status.textContent=error||(busy?t('mediaImage.applying'):record.imageReviewRequired?t('mediaImage.reviewRequired'):showingExact?t('mediaImage.exactPreview'):t('mediaImage.regionCount',{count:boxes.length,max:REGION_LIMIT}));
  }
  function addBox(box) {
    if (!box || busy || showingExact || record.imageReviewRequired) return;
    try { boxes=regionSelection(manifest,[...boxes,box]).boxes; error=''; applied=false; }
    catch { error=t('mediaImage.regionInvalid'); }
    paint();
  }
  form.onsubmit = event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    const [x,y,width,height]=fields.map(input=>Number(input.value)); addBox([x,y,x+width,y+height]);
  };
  const point = event => regionPoint(event.clientX,event.clientY,image.getBoundingClientRect(),manifest.width,manifest.height);
  surface.addEventListener('pointerdown',event=>{
    if (busy||showingExact||record.imageReviewRequired||event.button!==0||boxes.length>=REGION_LIMIT||!image.complete||!image.naturalWidth) return;
    const start=point(event); if (!start) return;
    event.preventDefault(); surface.setPointerCapture(event.pointerId); drag={id:event.pointerId,start,box:null};
  });
  surface.addEventListener('pointermove',event=>{ if (drag?.id!==event.pointerId) return; drag.box=dragRegion(drag.start,point(event)); paint(); });
  surface.addEventListener('pointerup',event=>{
    if (drag?.id!==event.pointerId) return;
    const box=dragRegion(drag.start,point(event)); drag=null; surface.releasePointerCapture(event.pointerId); addBox(box); paint();
  });
  const cancelDrag = () => { if (drag) { drag=null; paint(); } };
  surface.addEventListener('pointercancel',cancelDrag); surface.addEventListener('lostpointercapture',cancelDrag);
  async function prepare(reset) {
    if (busy || !scopeValid()) return;
    const selection = reset ? null : regionSelection(manifest,boxes);
    busy=true; error=''; drag=null; paint();
    try {
      await prepareProtectedImages([record],sessionId,{force:true,regions:selection,editor:true,review:reset,signal:controller.signal});
      if (!live) return;
      manifest=record.imageBasePreview.manifest;
      if (reset) boxes=[];
      showingExact=true; applied=true;
    } catch (failure) { if (live) error=t('mediaImage.reviewRequired'); }
    finally { if (live) { busy=false; paint(); onChange(); if (showingExact) close.focus(); else review.focus(); } }
  }
  document.body.append(dialog); paint(); dialog.showModal(); (record.imageReviewRequired?review:fields[0]).focus(); onChange();
}
