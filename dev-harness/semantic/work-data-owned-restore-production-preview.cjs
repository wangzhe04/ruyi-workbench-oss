'use strict';
const base=require('./work-data-owned-restore-integration-research.cjs');
function replaceOne(text,from,to){if(text.split(from).length!==2)throw Error('boundary drift: '+from.slice(0,70));return text.replace(from,to);}
function transform(source){
 let out=base.transform(source).source;
 let helper=require('node:fs').readFileSync('dev-harness/semantic/work-data-owned-restore-unknown.cjs','utf8');
 helper=replaceOne(helper,'module.exports={isUnknown,flags};','return Object.freeze({isUnknown,flags});');
 out=replaceOne(out,'const WorkDataFullSnapshot = ((io, p, cryptoApi, zlibApi) => {','const WorkDataFullSnapshot = ((io, p, cryptoApi, zlibApi) => {\nconst WorkDataOwnedRestoreUnknown=(()=>{\n'+helper+'\n})();');
 out=replaceOne(out,'await targetAdmission();await absent();let created=false;','await targetAdmission();await absent();let created=false,restoreBarrierUncertain=false;');
 out=replaceOne(out,'await ownedRestoreFlush({target,source:base,ownership:targetOwnership,records:createdDirectories});','try{await ownedRestoreFlush({target,source:base,ownership:targetOwnership,records:createdDirectories});}catch(cause){restoreBarrierUncertain=WorkDataOwnedRestoreUnknown.isUnknown(cause);throw cause;}');
 out=replaceOne(out,'...ResearchRestoreUnknown.flags(cause)','...(restoreBarrierUncertain?WorkDataOwnedRestoreUnknown.flags(cause):{})');
 return out;
}
module.exports={transform};

