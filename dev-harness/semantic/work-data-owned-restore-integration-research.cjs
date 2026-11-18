'use strict';
// Exact research transform of actual 01ab source; no production modification.
const crypto=require('node:crypto'),H=x=>crypto.createHash('sha256').update(x).digest('hex');
function transform(source){
 const edits=[
 ['restoredTreeFor, readCapturedAuthority, preservedRead, limits = {}','restoredTreeFor, readCapturedAuthority, preservedRead, ownedRestoreFlush, limits = {}'],
 ['    base = p.resolve(base);','    if(ownedRestoreFlush!==undefined&&typeof ownedRestoreFlush!==\'function\')fail(\'host_invalid\');\n    base = p.resolve(base);'],
 ['await io.mkdir(target,{mode:0o700});created=true;await realDirectory(target);','await io.mkdir(target,{mode:0o700});created=true;await realDirectory(target);const needsRestoreFlush=nativeStage===null&&ownedRestoreFlush!==undefined,createdDirectories=[];const recordDirectory=async relative=>{const file=relative?p.join(target,...relative.split(\'/\')):target,stat=await io.lstat(file,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink())fail(\'target_alias\');createdDirectories.push(Object.freeze({relative,identity:String(stat.dev)+\':\'+String(stat.ino)}));};if(needsRestoreFlush)await recordDirectory(\'\');'],
 ['if(skipDirectory(relative))continue;await io.mkdir(p.join(target,...relative.split(\'/\')),{mode:0o700});','if(skipDirectory(relative))continue;await io.mkdir(p.join(target,...relative.split(\'/\')),{mode:0o700});if(needsRestoreFlush)await recordDirectory(relative);'],
 ['const verified=await readTree(targetOwnership).capture(target);','if(needsRestoreFlush){await targetAdmission();await ownedRestoreFlush({target,source:base,ownership:targetOwnership,records:createdDirectories});await targetAdmission();}\n          const verified=await readTree(targetOwnership).capture(target);'],
 ["}catch(cause){fail('restore_failed',{cause,targetRetained:created});}","}catch(cause){fail('restore_failed',{cause,targetRetained:created,...ResearchRestoreUnknown.flags(cause)});}"]
 ];let result=source;for(const [a,b] of edits){if(result.split(a).length!==2)throw Error('integration.boundary '+a.slice(0,50));result=result.replace(a,b);}return{source:result,originalSha256:H(source),derivedSha256:H(result),edits};
}
module.exports={transform};
