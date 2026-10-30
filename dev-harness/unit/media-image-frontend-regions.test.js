'use strict';
require('../lib/media-artifact-test-guard');
const {test}=require('node:test'),a=require('node:assert/strict');
const {fixture,plain,deferred}=require('../lib/media-image-frontend-fixture');
const prepare=f=>f.prepareProtectedImages([f.record],f.state.currentSession.id);
test('geometry uses actual rendered bounds, supports reverse drag, outward rounding and edge clamping',async()=>{
  const f=await fixture(),rect={left:20,top:30,width:160,height:80};
  a.deepEqual(plain(f.regionPoint(100,70,rect,32,16)),[16,8]);a.deepEqual(plain(f.regionPoint(-1,200,rect,32,16)),[0,16]);
  a.deepEqual(plain(f.dragRegion([14.1,8.1],[2.8,1.8])),[2,1,15,9]);a.equal(f.dragRegion([2,2],[2,2]),null);
  a.equal(f.regionPoint(0,0,{...rect,width:0},32,16),null);
  a.throws(()=>f.regionSelection(f.base,Array.from({length:129},()=>[0,0,1,1])));a.throws(()=>f.regionSelection(f.base,[[0,0,Infinity,1]]));
});
test('verified preview retains exact PNG and bound metadata; unexpired reuse does not POST',async()=>{
  const f=await fixture();await prepare(f);a.equal(f.record.protectedImage.payloadHash,f.base.payloadHash);a.equal(f.urls.length,1);
  a.equal(f.record.imageBasePreview.url,f.record.previewUrl);a.equal(f.record.imageBasePreview.manifest.transformHash,f.base.transformHash);
  const count=f.calls.length;await prepare(f);a.equal(f.calls.length,count);f.releaseImagePreviews(f.record);a.deepEqual(f.revoked,['blob:synthetic-0']);
});
for(const [name,options]of[
  ['metadata header',{headers:h=>h['x-ruyi-manifest-sha256']='0'.repeat(64)}],
  ['payload header',{headers:h=>h['x-ruyi-payload-sha256']='0'.repeat(64)}],
  ['payload bytes',{bytes:b=>b[30]^=1}],['PNG dimensions',{manifest:m=>m.width=31}],
  ['requested regions hash',{manifest:m=>m.regionsHash='0'.repeat(64)}]
])test('preview rejects mismatched '+name+' without retaining URL or authority',async()=>{
  const f=await fixture(options);await a.rejects(prepare(f));a.equal(f.record.protectedImage,undefined);a.equal(f.urls.length,0);
  a.equal(f.record.imageReviewRequired,true);a.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
});
test('Apply deletes old authority synchronously before failing cleanup and keeps draft and selected regions',async()=>{
  let rejectRemoval=false;
  const f=await fixture({remove:async()=>{if(rejectRemoval)throw Error('synthetic cleanup refusal');}});await prepare(f);
  const old=f.record.protectedImage,selection=f.regionSelection(f.base,[[12,12,14,14]]);f.record.chosenImageRegions=selection;rejectRemoval=true;
  const work=f.prepareProtectedImages([f.record],f.state.currentSession.id,{force:true,regions:selection,editor:true});
  a.equal(f.record.protectedImage,undefined);await a.rejects(work);a.equal(f.record.protectedImage,undefined);a.equal(f.record.imageReviewRequired,true);
  a.equal(f.record.chosenImageRegions,selection);a.equal(f.state.attachments[0],f.record);a.equal(f.calls.filter(c=>c.method==='POST').length,1);a.ok(old.reference);
});
test('ordinary TTL reprepare preserves matching explicit regions and independent unmasked protected base',async()=>{
  const f=await fixture();await prepare(f);const baseUrl=f.record.imageBasePreview.url;
  const selection=f.regionSelection(f.base,[[12,12,14,14]]);
  await f.prepareProtectedImages([f.record],f.state.currentSession.id,{force:true,regions:selection,editor:true});
  a.equal(f.record.imageBasePreview.url,baseUrl);a.notEqual(f.record.previewUrl,baseUrl);a.deepEqual(plain(f.record.chosenImageRegions),plain(selection));
  f.setTime(70000);await prepare(f);const posts=f.calls.filter(c=>c.method==='POST');a.deepEqual(JSON.parse(posts.at(-1).body).regions,plain(selection));
  a.equal(f.record.imageBasePreview.url,baseUrl);a.ok(f.revoked.includes('blob:synthetic-1'));
  f.releaseImagePreviews(f.record);a.equal(new Set(f.revoked).size,3);a.equal(f.revoked.length,3);
});
test('source changed at TTL refuses rather than stretching or discarding chosen boxes; explicit review resets',async()=>{
  let changed=false;const f=await fixture({manifest:m=>{if(changed)m.sourceRevision='s2';}});await prepare(f);
  const selection=f.regionSelection(f.base,[[12,12,14,14]]);f.record.chosenImageRegions=selection;changed=true;f.setTime(70000);
  await a.rejects(prepare(f));a.equal(f.record.protectedImage,undefined);a.equal(f.record.chosenImageRegions,selection);
  const count=f.calls.length;await a.rejects(prepare(f));a.equal(f.calls.length,count);
  await f.prepareProtectedImages([f.record],f.state.currentSession.id,{force:true,review:true,regions:null});
  a.equal(f.record.chosenImageRegions,undefined);a.equal(f.record.imageBasePreview.manifest.sourceRevision,'s2');a.equal(f.record.imageReviewRequired,undefined);
});
for(const [name,invalidate]of[
  ['remove/reset',f=>f.releaseImagePreviews(f.record)],['session operation',f=>f.invalidateImageOperations()],
  ['session replacement',f=>f.state.currentSession={id:'another'}],['policy replacement',f=>f.state.config.privacyModeV1='strict']
])test('late prepare after '+name+' cannot publish a preview and deletes its issued record',async()=>{
  const waiting=deferred(),f=await fixture({prepare:async result=>{await waiting.promise;return result;}});
  const work=prepare(f);await Promise.resolve();await Promise.resolve();invalidate(f);waiting.resolve();await a.rejects(work);
  a.equal(f.record.protectedImage,undefined);a.equal(f.record.previewUrl,undefined);a.equal(f.urls.length,0);a.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
});
test('late preview after abort is drained without publication, and concurrent prepare is refused',async()=>{
  const waiting=deferred(),entered=deferred(),f=await fixture({blob:async()=>{entered.resolve();await waiting.promise;}}),controller=new AbortController();
  const work=f.prepareProtectedImages([f.record],f.state.currentSession.id,{signal:controller.signal});await entered.promise;
  await a.rejects(prepare(f),/editingBlocked/);controller.abort();waiting.resolve();await a.rejects(work);
  a.equal(f.urls.length,0);a.equal(f.record.protectedImage,undefined);a.equal(f.record.imagePreparationController,undefined);
});
test('editing blocks send even with protection off; ordinary auto-prepared attachments retain the OFF path',async()=>{
  const f=await fixture();f.record.imageEditing=true;f.state.config.privacyModeV1='off';await a.rejects(prepare(f),/editingBlocked/);a.equal(f.calls.length,0);
  delete f.record.imageEditing;f.state.config.privacyModeV1='enhanced';await prepare(f);f.state.config.privacyModeV1='off';await prepare(f);
  a.equal(f.record.protectedImage,undefined);a.equal(f.record.previewUrl,undefined);a.equal(f.record.imageBasePreview,undefined);
  a.equal(f.calls.filter(c=>c.method==='POST').length,1);a.equal(f.revoked.length,1);a.equal(f.state.attachments[0],f.record);
});
test('pre-aborted Apply revokes the accepted reference before cancellation can fail',async()=>{
  const f=await fixture();await prepare(f);const controller=new AbortController();controller.abort();
  const work=f.prepareProtectedImages([f.record],f.state.currentSession.id,{signal:controller.signal,force:true,editor:true,regions:f.regionSelection(f.base,[[12,12,14,14]])});
  a.equal(f.record.protectedImage,undefined);await a.rejects(work);a.equal(f.record.imageReviewRequired,true);a.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('a changed source without manual boxes still requires explicit review on renewal',async()=>{
  let changed=false;const f=await fixture({manifest:m=>{if(changed)m.transformHash='a'.repeat(64);}});await prepare(f);changed=true;f.setTime(70000);
  await a.rejects(prepare(f));a.equal(f.record.protectedImage,undefined);a.equal(f.record.imageReviewRequired,true);
});
test('changed idle privacy configuration refuses automatic prepare and requires explicit review',async()=>{
  const f=await fixture();await prepare(f);f.state.config.privacyRulesV1=[{id:'new'}];await a.rejects(prepare(f));
  a.equal(f.record.protectedImage,undefined);a.equal(f.record.imageReviewRequired,true);a.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('accepted or failed nonempty manual Apply blocks OFF until an explicit successful review or clear',async()=>{
  for(const refusal of [false,true]){
    let fail=false;const f=await fixture({prepare:result=>{if(fail)throw Error('synthetic refusal');return result;}});await prepare(f);
    fail=refusal;const applying=f.prepareProtectedImages([f.record],f.state.currentSession.id,{force:true,editor:true,regions:f.regionSelection(f.base,[[12,12,14,14]])});
    if(refusal)await a.rejects(applying);else await applying;
    a.equal(f.record.imageManualMaskRequired,true);f.state.config.privacyModeV1='off';const count=f.calls.length;await a.rejects(prepare(f),/reviewRequired/);a.equal(f.calls.length,count);
    fail=false;f.state.config.privacyModeV1='enhanced';await f.prepareProtectedImages([f.record],f.state.currentSession.id,{force:true,editor:true,review:true,regions:null});
    a.equal(f.record.imageManualMaskRequired,undefined);f.state.config.privacyModeV1='off';await prepare(f);
  }
});
test('advisory stamp ignores UI and model-list changes while retaining actual policy, credential and recipient inputs',async()=>{
  const f=await fixture();f.state.config.providers=[{id:'p',baseUrl:'https://model.invalid',apiKey:'masked',model:'m',vision:true,extraHeaders:{'X-Tenant':'a'}}];f.state.config.activeProvider='p';
  await prepare(f);const stamp=f.imagePolicyStamp(),count=f.calls.length;
  Object.assign(f.state.config,{theme:'light',locale:'en-US',uiMode:'simple',colorScheme:'jade'});
  Object.assign(f.state.config.providers[0],{label:'New label',models:[{id:'another-model'}]});
  a.equal(f.imagePolicyStamp(),stamp);await prepare(f);a.equal(f.calls.length,count);
  for(const change of [c=>c.privacyTechnicalV1=true,c=>c.privacyRulesV1=[{id:'new'}],c=>c.privacyPolicyRecoveryRequiredV1=true,
    c=>c.activeProvider='other',c=>c.providers[0].baseUrl='https://other.invalid',c=>c.providers[0].apiKey='new-masked',
    c=>c.providers[0].extraHeaders['X-Tenant']='b',c=>c.providers[0].model='different',c=>c.providers[0].anthropicAuth='bearer',
    c=>c.providers[0].anthropicFallbacks='off',c=>c.providers[0].type='different',c=>c.searchBackend={apiKey:'known-secret'},
    c=>c.externalMcpServers=[{headers:{Authorization:'synthetic-secret'}}]]){
    const before=plain(f.state.config);change(f.state.config);a.notEqual(f.imagePolicyStamp(),stamp);f.state.config=before;
  }
});
test('fresh ordinary OFF upload keeps its original raw thumbnail with zero API, revoke or generation mutation',async()=>{
  const f=await fixture();f.state.config.privacyModeV1='off';f.record.previewUrl='blob:original-off-upload';const before=plain(f.record);
  await prepare(f);a.deepEqual(plain(f.record),before);a.equal(f.calls.length,0);a.equal(f.revoked.length,0);a.equal(f.record.imagePreparationGeneration,undefined);
});
