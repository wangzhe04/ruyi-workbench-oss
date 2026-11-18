'use strict';
const native=require('./work-data-owned-restore-flush-native-research.cjs');
const child=require('./work-data-issued-child-retention-preview.cjs');
function transform(source){
 let result=native.transform(source).source;
 result=result.replaceAll('ResearchFlushOwnedRestore','FlushOwnedRestoreDirectories').replaceAll('research-flush-owned-restore','owned-restore-flush').replaceAll('research_root','owned_restore_root').replaceAll('research_chain','owned_restore_chain').replaceAll('research_identity','owned_restore_identity');
 return child.transform(result);
}
module.exports={transform};
