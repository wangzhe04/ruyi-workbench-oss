'use strict';
// Build an owned copy only. Inputs are exact reviewed research modules and app source.
const fs=require('node:fs'),path=require('node:path');
function one(s,a,b){if(s.split(a).length!==2)throw Error('boundary drift '+a.slice(0,80));return s.replace(a,b);}
function helpers(){
 let unknown=fs.readFileSync('dev-harness/semantic/work-data-owned-restore-unknown.cjs','utf8');
 unknown=one(unknown,'module.exports={isUnknown,flags};','return Object.freeze({isUnknown,flags});');
 let barrier=fs.readFileSync('dev-harness/semantic/work-data-owned-restore-flush-candidate.cjs','utf8');
 barrier=one(barrier,'module.exports={prepare,run};','return Object.freeze({prepare,run});');
 let broker=fs.readFileSync('dev-harness/semantic/work-data-owned-restore-broker-candidate.cjs','utf8');
 broker=one(broker,"const {isUnknown}=require('./work-data-owned-restore-unknown.cjs');",'const {isUnknown}=WorkDataOwnedRestoreUnknown;');
 broker=one(broker,'module.exports={create};','return Object.freeze({create});');
 return `const WorkDataOwnedRestoreUnknown = (()=>{\n${unknown}\n})();\nconst WorkDataOwnedRestoreBarrier = (()=>{\n${barrier}\n})();\nconst WorkDataOwnedRestoreBroker = (()=>{\n${broker}\n})();\nconst WorkDataOwnedRestoreRetainedOwners = new Set();\n`;
}
const callback=String.raw`
      const ownedRestoreFlush = async input => {
        const targetOwner=input.ownership;
        const admit=async (candidate,target)=>candidate===targetOwner && target===input.target && exclusiveSync(ownership)===true && exclusiveSync(targetOwner)===true;
        const file=(root,relative)=>relative?p.join(root,...relative.split('/')):root;
        const inspectDirectory=async(root,relative)=>{const name=file(root,relative),stat=await io.lstat(name,{bigint:true});return {identity:String(stat.dev)+':'+String(stat.ino),alias:!stat.isDirectory()||stat.isSymbolicLink()||fold(await io.realpath(name))!==fold(name)};};
        const listDirectories=async root=>{const found=[''];async function walk(relative){for(const entry of await io.readdir(file(root,relative),{withFileTypes:true})){if(entry.isSymbolicLink())throw fail('restore_flush_alias');if(entry.isDirectory()){const next=relative?relative+'/'+entry.name:entry.name;found.push(next);await walk(next);}}}await walk('');return found;};
        try { return await ownedRestoreBroker.run(broker=>WorkDataOwnedRestoreBarrier.run(input,{admit,listDirectories,inspectDirectory,flushAnchored:async({target,relative,chain})=>{
          const ids=chain.map(({identity})=>{const parts=identity.split(':'),dev=BigInt(parts[0]).toString(16),ino=BigInt(parts[1]).toString(16);if(dev.length>8||ino.length>16)throw fail('restore_flush_identity');return dev.padStart(8,'0')+ino.padStart(16,'0');});
          const value=await broker.command({cmd:'owned-restore-flush',root:target,relative,ids});
          if(!value||Object.keys(value).sort().join(',')!=='ids,ok,relative,root'||value.ok!==true||value.root!==target||value.relative!==relative||!Array.isArray(value.ids)||JSON.stringify(value.ids)!==JSON.stringify(ids))throw fail('restore_flush_receipt');
          return {ok:true,target,relative,identities:chain.map(x=>x.identity)};
        }})); } finally { if(ownedRestoreBroker.stats().uncertain) WorkDataOwnedRestoreRetainedOwners.add(ownedRestoreBroker); }
      };
`;
function transform(source){
 source=one(source,'const WorkDataNativeAdapters = ((io, p, c) => {','const WorkDataNativeAdapters = ((io, p, c) => {\n'+helpers());
 source=one(source,'capturePreserved:migrationCapsuleCapturePreserved, protector:LocalSecretCrypto,','capturePreserved:migrationCapsuleCapturePreserved, openOwnedRestoreBroker:migrationCapsuleBroker, protector:LocalSecretCrypto,');
 source=one(source,'    let unknown = false, verifying = false, heldTimer = null;','    let unknown = false, verifying = false, heldTimer = null;\n    const ownedRestoreBroker=WorkDataOwnedRestoreBroker.create({start:()=>{if(typeof bindings.openOwnedRestoreBroker!==\'function\')throw fail(\'restore_flush_unavailable\');return bindings.openOwnedRestoreBroker();},helperUncertain:()=>bindings.helperMayStillRun()});');
 source=one(source,'      const owner = bindings.fullSnapshot.create({base,ownership,assertExclusive:exclusiveSync,assertExclusiveSync:exclusiveSync,preservedRead,protector:snapshotProtector,',callback+'\n      const owner = bindings.fullSnapshot.create({base,ownership,assertExclusive:exclusiveSync,assertExclusiveSync:exclusiveSync,preservedRead,ownedRestoreFlush,protector:snapshotProtector,');
 return source;
}
module.exports={transform};

