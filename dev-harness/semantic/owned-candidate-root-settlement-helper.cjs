'use strict';
// Derive the settlement helper from the reviewed v3 observed allocator. No
// process starts while building this source.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function makeAllocator(base){
 let s=base;const edits=[];function replace(a,b,n=1){if(s.split(a).length!==n+1)throw Error('settlement.helper.boundary.'+edits.length);s=s.split(a).join(b);edits.push([a,b,n]);}
 replace('const migrationCandidateRetained = new Set();\n','/* settlement shares the v3 retained-owner set */\n');
 replace('async function migrationCreateCandidateBoundary({candidate,root,sourceProof,assertIssued,ownership,assertExclusive,assertIntent,onNativeCause}) {','async function migrationSettleCandidateRoot({candidate,root,sourceProof,assertIssued,ownership,assertExclusive,assertIntent,onNativeCause,expectedBoundary,files,directories}) {');
 replace("  await assertIntent();check();let broker,closed=false,started=false,uncertain=false;", "  if(!expectedBoundary||expectedBoundary.rel!=='.work-data/generations/'+candidate.id||!/^[a-f0-9]{24}$/.test(expectedBoundary.id||'')||!Array.isArray(expectedBoundary.parents)||expectedBoundary.parents.length!==3||JSON.stringify(expectedBoundary.parents)!==JSON.stringify(anchors.slice(-3))||!Array.isArray(files)||!Array.isArray(directories))fail('plan');\n  files=JSON.parse(JSON.stringify(files));directories=JSON.parse(JSON.stringify(directories));\n  await assertIntent();check();let broker,closed=false,started=false,uncertain=false;");
 replace('ruyi-candidate-observer-','ruyi-settlement-observer-');replace('ruyi-candidate-identity-query-v1','ruyi-settlement-identity-query-v1');
 const before=`    const receipt=await broker.command({cmd:'research-candidate-start',base,id:candidate.id,anchorIds:anchors});
    if(!receipt||receipt.kind!=='candidate-directory-created-v1'||receipt.root!==target||receipt.relative!==''||receipt.parentId!==null||receipt.created!==true||!/^[a-f0-9]{24}$/.test(receipt.id||'')||!/^[a-f0-9]{64}$/.test(receipt.token||''))fail('receipt');
    await assertIntent();check();let released;
    try{released=await broker.command({cmd:'research-candidate-close',root:target,token:receipt.token});}
    catch(cause){uncertain=true;throw cause;}
    if(!released||released.closed!==true||Object.keys(released).join(',')!=='closed'){uncertain=true;fail('close');}`;
 const after=`    let receipt;try{receipt=await broker.command({cmd:'candidate-settle-root',base,root:target,id:expectedBoundary.id,parents:expectedBoundary.parents,revision:crypto.randomBytes(32).toString('hex'),files,directories});}catch(cause){if(cause?.code==='work_data_backup.census_first_close_unverified')uncertain=true;throw cause;}
    if(!receipt||Object.keys(receipt).sort().join(',')!=='id,kind,root,rootFlushed,rows'||receipt.kind!=='candidate-root-settlement-v1'||receipt.root!==target||receipt.id!==expectedBoundary.id||receipt.rootFlushed!==true||!Array.isArray(receipt.rows))fail('receipt');
    await assertIntent();check();`;
 replace(before,after);
 replace('    result=Object.freeze({candidate,root:target,id:receipt.id,parents:Object.freeze(anchors.slice(-3)),baselineSha256});',"    result=migrationCandidateSettlementProof.issue({owner:ownership,candidate,rootId:expectedBoundary.id,files,directories,rows:receipt.rows,assertAuthoritySync:(owner,value)=>owner===ownership&&value===candidate&&assertExclusive(owner)===true&&assertIssued(value)===true});");
 replace('candidate-allocator-process-v1','candidate-settlement-process-v1');replace('allocator-receipt.json','settlement-receipt.json');
 return{source:s,edits};
}
function transform(source,allocatorBase){
 const code=fs.readFileSync(path.join(__dirname,'owned-candidate-settlement-proof.cjs'),'utf8').replace('module.exports={issue,consume};','return Object.freeze({issue,consume});'),derived=makeAllocator(allocatorBase);
 const anchor='async function migrationCapsuleCapturePreserved(root, revision, readback) {';
 const proof="const migrationCandidateSettlementProof=(()=>{\n"+code+"\n})();\n"+derived.source+"\n";
 if(source.split(anchor).length!==2)throw Error('settlement.helper.anchor');const out=source.replace(anchor,proof+anchor);return{source:out,edits:[[anchor,proof+anchor]],allocatorEdits:derived.edits,sha256:crypto.createHash('sha256').update(out).digest('hex')};
}
module.exports={transform,makeAllocator};
