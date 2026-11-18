'use strict';
// Owned research overlay only. The original errors and control flow survive.
const base=require('./owned-prepare-cause-diagnostic.cjs');
function transform(ad,ak,file){
 const stages=['publish-enter','publish-source-check','publish-target-verify','publish-commit','publish-committed','publish-special-forward','publish-recover','publish-activate','publish-special-verify','publish-special-capture','publish-return','verify-enter','verify-selected','verify-target','verify-logical','verify-special','verify-return','cold-publish','cold-update-published','cold-verify','cold-update-complete','cold-result','cold-finish','cold-retire','cold-return'];
 let probe=base.probe(file).replace(/const accepted=new Set\(\[[^\]]*\]\);/,`const accepted=new Set(${JSON.stringify(stages)});`);
 const ae=[['const WorkDataMigrationHost = ((io,p,c) => {',probe+'const WorkDataMigrationHost = ((io,p,c) => {'],
 ["async function publish(prepared){return run(async()=>{", "async function publish(prepared){ResearchPrepareDiagnostic.mark('publish-enter');return run(async()=>{"],
 ['try{await checkSource(plan);const target=await (preservedRead!==undefined?sourceTree:tree).verify(plan.target);',"try{ResearchPrepareDiagnostic.mark('publish-source-check');await checkSource(plan);ResearchPrepareDiagnostic.mark('publish-target-verify');const target=await (preservedRead!==undefined?sourceTree:tree).verify(plan.target);"],
 ['const result=await manifest.commit({expected:plan.expected,candidate:plan.candidate});',"ResearchPrepareDiagnostic.mark('publish-commit');const result=await manifest.commit({expected:plan.expected,candidate:plan.candidate});ResearchPrepareDiagnostic.mark('publish-committed');"],
 ["specialProof=await finishSpecialTransition(plan,'forward');","ResearchPrepareDiagnostic.mark('publish-special-forward');specialProof=await finishSpecialTransition(plan,'forward');"],
 ['await plan.special.recover();await plan.special.activate();',"ResearchPrepareDiagnostic.mark('publish-recover');await plan.special.recover();ResearchPrepareDiagnostic.mark('publish-activate');await plan.special.activate();"],
 ['specialProof=await plan.special.verifyPublished({expected:result});',"ResearchPrepareDiagnostic.mark('publish-special-verify');specialProof=await plan.special.verifyPublished({expected:result});"],
 ['const specialSha=await usingSource(await reader.capture(',"ResearchPrepareDiagnostic.mark('publish-special-capture');const specialSha=await usingSource(await reader.capture("],
 ['issued.delete(prepared);return Object.freeze({active:result,processExitRequired:true});',"ResearchPrepareDiagnostic.mark('publish-return');issued.delete(prepared);return Object.freeze({active:result,processExitRequired:true});"],
 ['async function verifyPublished(prepared, { recheck = false } = {}) { return run(async()=>{',"async function verifyPublished(prepared, { recheck = false } = {}) { ResearchPrepareDiagnostic.mark('verify-enter');return run(async()=>{"],
 ['const selected=await current(proof.expected);',"ResearchPrepareDiagnostic.mark('verify-selected');const selected=await current(proof.expected);"],
 ["const specialRoot=p.join(base,'.work-data','skill-backups');","ResearchPrepareDiagnostic.mark('verify-target');const specialRoot=p.join(base,'.work-data','skill-backups');"],
 ['for(const row of proof.transformed){',"ResearchPrepareDiagnostic.mark('verify-logical');for(const row of proof.transformed){"],
 ['const actualSpecial=await owner.verifyPublished({expected:selected});',"ResearchPrepareDiagnostic.mark('verify-special');const actualSpecial=await owner.verifyPublished({expected:selected});"]];
 const ke=[['const published = await migration.publish(prepared);',"ResearchPrepareDiagnostic.mark('cold-publish');const published = await migration.publish(prepared);"],
 ["await update('published', prepared.candidate);","ResearchPrepareDiagnostic.mark('cold-update-published');await update('published', prepared.candidate);"],
 ['await verifyPublished();',"ResearchPrepareDiagnostic.mark('cold-verify');await verifyPublished();"],
 ["await update('complete', prepared.candidate);","ResearchPrepareDiagnostic.mark('cold-update-complete');await update('complete', prepared.candidate);"],
 ['const resultReceipt = await persistResult(result);',"ResearchPrepareDiagnostic.mark('cold-result');const resultReceipt = await persistResult(result);"],
 ['await control.finish(intent, async()=>',"ResearchPrepareDiagnostic.mark('cold-finish');await control.finish(intent, async()=>"],
 ['await clearClaim();\n        return Object.freeze(result);',"ResearchPrepareDiagnostic.mark('cold-retire');await clearClaim();\n        ResearchPrepareDiagnostic.mark('cold-return');return Object.freeze(result);"],
 ['      } catch (cause) {\n        retainHelper(cause);','      } catch (cause) {\n        ResearchPrepareDiagnostic.record(cause);retainHelper(cause);']];
 const apply=(s,edits)=>{for(const [a,b] of edits){if(s.split(a).length!==2)throw Error('boundary '+a.slice(0,80));s=s.replace(a,b);}return s;};return{ad:apply(ad,ae),ak:apply(ak,ke),editsAd:ae,editsAk:ke};
}
module.exports={transform};
