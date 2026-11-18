'use strict';
// Explicit modeled settlement seam for the real migration host test tree.
function transform(source){
 const edits=[
 [" const context={...fx,require,Buffer,process,crypto,fs,fsp,path,AbortSignal,paths:{data:base},LocalSecretCrypto:protector,PrivacyCore:fx.privacy,atomicWriteJson:fx.atomicWriteJson,nowIso:()=>new Date().toISOString(),tryStat:file=>{try{return fs.statSync(file);}catch{return null;}}};vm.createContext(context);",
  " const context={...fx,require,Buffer,process,crypto,fs,fsp,path,AbortSignal,paths:{data:base},LocalSecretCrypto:protector,PrivacyCore:fx.privacy,atomicWriteJson:fx.atomicWriteJson,nowIso:()=>new Date().toISOString(),tryStat:file=>{try{return fs.statSync(file);}catch{return null;}}};vm.createContext(context);const proofSource=fs.readFileSync(path.join(repo,'dev-harness/semantic/owned-candidate-settlement-proof.cjs'),'utf8').replace('module.exports={issue,consume};','return Object.freeze({issue,consume});');context.migrationCandidateSettlementProof=vm.runInContext('(()=>{'+proofSource+'})()',context);"],
 ["   ...(preserved?{assertExclusiveSync:()=>state.exclusive,preservedRead:{profile:'bounded-native-v1',capturePreserved}}:{}),",
  `   ...(preserved?{assertExclusiveSync:()=>state.exclusive,preservedRead:{profile:'bounded-native-v1',capturePreserved},candidateSettlement:async options=>{
     if(options.assertIssued(options.candidate)!==true||options.assertExclusive(options.ownership)!==true)throw Error('settlement authority');await options.assertIntent();
     if(state.beforeSettlement)await state.beforeSettlement(options);
     const snapshot=await rawCapture(options.candidate.root,'e'.repeat(64));context.__settlementRows=JSON.stringify(snapshot.entries.map(row=>({rel:row.rel,id:row.id,dir:row.dir,attrs:row.attrs,shortName:row.shortName,streams:row.streams.map(({name,size,hash})=>({name,size,hash}))})));const rows=vm.runInContext('JSON.parse(__settlementRows)',context);delete context.__settlementRows;
     const proof=context.migrationCandidateSettlementProof.issue({owner:options.ownership,candidate:options.candidate,rootId:options.expectedBoundary.id,files:options.files,directories:options.directories,rows,assertAuthoritySync:(owner,candidate)=>owner===options.ownership&&candidate===options.candidate&&state.exclusive===true});
     state.settlementRootCalls=(state.settlementRootCalls||0)+1;
     if(state.afterSettlement)await state.afterSettlement(options);return proof;
   }}:{}),`]
 ];let out=source;for(const [i,[a,b]] of edits.entries()){if(out.split(a).length!==2)throw Error('settlement.fixture.boundary.'+i);out=out.replace(a,b);}return{source:out,edits};
}
module.exports={transform};
