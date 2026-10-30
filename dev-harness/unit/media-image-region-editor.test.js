'use strict';
require('../lib/media-artifact-test-guard');
const {test}=require('node:test'),a=require('node:assert/strict');
const {fixture}=require('../lib/media-image-editor-dom-fixture');
test('opening, pointer drawing, reverse coordinates, keyboard add/remove and cancel never POST or change accepted regions',async()=>{
  const f=await fixture(),accepted=f.record.protectedImage,count=f.calls.length;f.open();
  a.equal(f.record.imageEditing,true);a.equal(f.dialog().attributes['aria-labelledby'],'image-region-editor-title');
  const surface=f.dialog().children.find(n=>n.className==='image-region-surface');
  surface.emit('pointerdown',{button:0,pointerId:1,clientX:160,clientY:110});
  surface.emit('pointermove',{pointerId:1,clientX:40,clientY:50});surface.emit('pointerup',{pointerId:1,clientX:40,clientY:50});
  a.equal(f.dialog().querySelector('ol').children.length,1);f.fill([16,12,4,3]);f.button('mediaImage.addRegion').onclick();
  a.equal(f.dialog().querySelector('ol').children.length,2);f.dialog().querySelector('ol').querySelector('button').onclick();
  a.equal(f.dialog().querySelector('ol').children.length,1);a.equal(f.calls.length,count);a.equal(f.record.protectedImage,accepted);a.equal(f.record.chosenImageRegions,undefined);
  f.button('common.cancel').onclick();a.equal(f.dialog(),undefined);a.equal(f.record.imageEditing,undefined);a.equal(f.timers.size,0);a.equal(f.document.activeElement,f.trigger);
});
test('Apply issues one fresh prepare, displays the new exact URL and blocks send until close',async()=>{
  const f=await fixture(),old=f.record.protectedImage;f.open();f.fill([16,12,4,3]);f.button('mediaImage.addRegion').onclick();
  f.button('mediaImage.applyRegions').onclick();await f.settle();
  const request=JSON.parse(f.calls.filter(row=>row.method==='POST').at(-1).body);
  a.deepEqual(request.regions.boxes,[[16,12,20,15]]);a.notEqual(f.record.protectedImage.reference,old.reference);
  a.equal(f.dialog().querySelector('img').src,f.record.previewUrl);a.equal(f.dialog().attributes['aria-busy'],'false');
  await a.rejects(f.prepareProtectedImages([f.record],f.state.currentSession.id),/editingBlocked/);
  a.equal(f.document.activeElement,f.button('common.close'));f.button('common.close').onclick();
  const count=f.calls.length;await f.prepareProtectedImages([f.record],f.state.currentSession.id);a.equal(f.calls.length,count);
});
test('delete and clear previous masks operate over the retained unmasked protected base before new Apply',async()=>{
  const f=await fixture();const base=f.record.imageBasePreview.url;f.open();f.fill([16,12,4,3]);f.button('mediaImage.addRegion').onclick();
  f.button('mediaImage.applyRegions').onclick();await f.settle();f.button('common.close').onclick();f.open();
  a.equal(f.dialog().querySelector('img').src,base);a.equal(f.dialog().querySelector('ol').children.length,1);
  f.button('mediaImage.clearRegions').onclick();a.equal(f.dialog().querySelector('ol').children.length,0);
  f.button('mediaImage.applyRegions').onclick();await f.settle();a.deepEqual(JSON.parse(f.calls.filter(row=>row.method==='POST').at(-1).body).regions.boxes,[]);
  a.equal(f.record.chosenImageRegions.boxes.length,0);a.equal(f.record.imageManualMaskRequired,undefined);f.button('common.close').onclick();f.releaseImagePreviews(f.record);
  a.equal(f.revoked.length,new Set(f.revoked).size);
});
test('failed Apply leaves no old send reference and offers explicit current-source review',async()=>{
  let fail=false;const f=await fixture({prepare:result=>{if(fail)throw Error('synthetic source changed');return result;}});fail=true;
  f.open();f.fill([16,12,4,3]);f.button('mediaImage.addRegion').onclick();f.button('mediaImage.applyRegions').onclick();await f.settle();
  a.equal(f.record.protectedImage,undefined);a.equal(f.record.imageReviewRequired,true);a.equal(f.button('mediaImage.reviewCurrent').hidden,false);
  a.equal(f.button('mediaImage.applyRegions').disabled,true);fail=false;f.button('mediaImage.reviewCurrent').onclick();await f.settle();
  a.equal(f.record.imageReviewRequired,undefined);a.equal(f.record.chosenImageRegions,undefined);f.button('common.close').onclick();
});
test('policy change, session invalidation and Escape close the editor, restore focus and release active watch',async()=>{
  for(const action of ['policy','session','escape']){
    const f=await fixture();f.open();
    if(action==='policy'){f.state.config.privacyModeV1='strict';f.tick();}
    else if(action==='session')f.invalidateImageOperations();
    else{f.dialog().emit('cancel');f.dialog().close();}
    a.equal(f.record.imageEditing,undefined);a.equal(f.dialog(),undefined);a.equal(f.timers.size,0);a.equal(f.document.activeElement,f.trigger);
  }
});
test('editing after a successful Apply remains a cancellable draft over the accepted PNG',async()=>{
  const f=await fixture();f.open();f.fill([16,12,4,3]);f.button('mediaImage.addRegion').onclick();
  f.button('mediaImage.applyRegions').onclick();await f.settle();const accepted=f.record.protectedImage;
  f.button('mediaImage.editRegions').onclick();f.fill([20,12,2,2]);f.button('mediaImage.addRegion').onclick();
  a.ok(f.button('common.cancel'));a.equal(f.record.chosenImageRegions.boxes.length,1);f.button('common.cancel').onclick();
  a.equal(f.record.protectedImage,accepted);a.equal(f.record.chosenImageRegions.boxes.length,1);
});
test('theme and locale changes keep the editor and reviewed artifact usable',async()=>{
  const f=await fixture(),accepted=f.record.protectedImage;f.open();Object.assign(f.state.config,{theme:'light',locale:'en-US'});f.tick();
  a.ok(f.dialog()?.open);a.equal(f.record.protectedImage,accepted);a.equal(f.record.imageReviewRequired,undefined);f.button('common.cancel').onclick();
});
test('stale-policy exact toggle stays disabled until successful fresh review restores valid preview switching',async()=>{
  const f=await fixture();f.state.config.privacyRulesV1=[{id:'changed-policy'}];f.open();
  a.equal(f.button('mediaImage.preview').disabled,true);
  a.equal(f.dialog().children.find(n=>n.className==='image-region-status').textContent,'mediaImage.reviewRequired');
  f.button('mediaImage.reviewCurrent').onclick();await f.settle();
  a.equal(f.record.imageReviewRequired,undefined);a.equal(f.button('mediaImage.editRegions').disabled,false);
  f.button('mediaImage.editRegions').onclick();a.equal(f.button('mediaImage.preview').disabled,false);
  f.button('mediaImage.preview').onclick();
  a.equal(f.dialog().children.find(n=>n.className==='image-region-status').textContent,'mediaImage.exactPreview');
  f.button('common.close').onclick();
});
test('P2: an idle stale-policy artifact must retain fresh-review warning while toggling its old exact preview',async()=>{
 const f=await fixture();f.state.config.privacyRulesV1=[{id:'changed-policy'}];f.open();
 a.equal(f.record.imageReviewRequired,true);a.equal(f.button('mediaImage.reviewCurrent').hidden,false);
 f.button('mediaImage.preview').onclick();
 const status=f.dialog().children.find(n=>n.className==='image-region-status').textContent;
 const expected=!status.startsWith('mediaImage.exactPreview');
 f.button('common.cancel').onclick();
 a.equal(expected,true,'Old stale-policy PNG is described as the currently accepted PNG for sending, hiding the fresh-review status');
});
