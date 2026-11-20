'use strict';
// Synthetic native transport for actual Tree/Store capability tests only.
// Fixed Basic times intentionally do not assert NTFS preservation behavior.
const io=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
// timesFor (optional) lets a test model metadata-only drift (for example a later
// LastAccess) on chosen entries; it never changes names, identities or bytes.
function createPreservedReaderModel(onCapture=()=>{},{timesFor}={}){
  return async(root,revision)=>{
    await onCapture(root);const entries=[];
    async function visit(rel){
      const file=path.join(root,...rel.split('/').filter(Boolean)),stat=await io.lstat(file,{bigint:true}),dir=stat.isDirectory(),data=dir?null:await io.readFile(file);
      const times=typeof timesFor==='function'&&timesFor(root,rel)||['1','2','3','4'];
      entries.push({rel,dir,id:stat.dev.toString(16).padStart(8,'0')+stat.ino.toString(16).padStart(16,'0'),opaque:'a'.repeat(64),attrs:dir?16:32,times,shortName:'',streams:dir?[]:[{name:'',size:data.length,hash:crypto.createHash('sha256').update(data).digest('hex'),data:data.toString('base64')}]});
      if(dir)for(const name of(await io.readdir(file)).sort())await visit(rel?rel+'/'+name:name);
    }
    await visit('');return{schema:1,platform:'ntfs-objects-v1',revision,entries};
  };
}
module.exports={createPreservedReaderModel};
