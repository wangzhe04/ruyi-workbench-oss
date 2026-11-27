'use strict';
// Count only readable published shards and headers. Sealed or absent data is reported separately.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { constBlock, functionBlock } = require('../lib/source-slice');
const src = name => fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const memory = src('06d-memory-domain.js'), parser = src('12-tool-dispatch.js'), index = src('13ap-session-fulltext-index.js');
const generator = functionBlock(index,'semanticWindows');
if (!generator) throw Error('window generator changed');
const api = vm.runInNewContext([generator, ...['stripLeadingBom','foldFrontmatterBlock','parseFrontmatter'].map(fn=>functionBlock(parser,fn)),
  constBlock(memory,'CORE_MEMORY_SUMMARY_CAP'),constBlock(memory,'MEMORY_TYPES'),functionBlock(memory,'memorySemanticHeaderText'),
  '({count:s=>Array.from(semanticWindows(s)).length, header:(id,raw)=>{const fm=parseFrontmatter(raw);return memorySemanticHeaderText(id,fm,MEMORY_TYPES.has(fm.type)?fm.type:"reference");}})'].join('\n'));
function entries(dir) {
  try { return fs.lstatSync(dir).isDirectory()?fs.readdirSync(dir,{withFileTypes:true}):[]; }
  catch(e){ if(e.code==='ENOENT')return [];throw e; }
}
function read(file) {
  const stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.size>20*1024*1024) throw Error('unsupported file');
  return fs.readFileSync(file,'utf8');
}
function distribution(values) {
  const sorted=[...values].sort((a,b)=>a-b), at=q=>sorted[Math.ceil(q*sorted.length)-1]??null;
  return {count:values.length,total:values.reduce((a,b)=>a+b,0),p50:at(.5),p95:at(.95),max:at(1)};
}
function inventory(root) {
  const sessions=path.join(root,'sessions'), indexDir=path.join(sessions,'_fulltext-index-v1');
  const ids=new Set(entries(sessions).filter(e=>e.isFile()&&/^[\w-]{1,64}\.json$/.test(e.name)).map(e=>e.name.slice(0,-5)));
  const counts=[], headers=[], projectTotals=[]; let shardRows=0, unavailableIndexes=0, unreadableHeaders=0;
  for(const dir of entries(indexDir).filter(e=>e.isDirectory()&&ids.has(e.name))){
    try{
      const folder=path.join(indexDir,dir.name), manifest=JSON.parse(read(path.join(folder,'manifest.json')));
      if(manifest.sessionId!==dir.name||!Array.isArray(manifest.shards)||!/^[a-f0-9]{32}$/.test(manifest.generation))throw Error();
      let windows=0,rows=0;
      for(const ref of manifest.shards){
        if(!Number.isSafeInteger(ref.ordinal)||ref.ordinal<0)throw Error();
        const raw=read(path.join(folder,manifest.generation+'.'+ref.ordinal+'.json')),shard=JSON.parse(raw);
        if(require('node:crypto').createHash('sha256').update(JSON.stringify(shard)).digest('hex')!==ref.sha256)throw Error();
        for(const row of shard.rows){if(typeof row.text!=='string')throw Error();windows+=api.count(row.text);rows++;}
      }
      counts.push(windows);shardRows+=rows;
    } catch {unavailableIndexes++;}
  }
  function countHeaders(dir){
    let total=0;
    for(const e of entries(dir).filter(e=>e.isFile()&&/^[\w-]+\.md$/i.test(e.name))){
      try {const raw=read(path.join(dir,e.name));if(!/^\uFEFF?---\s*\r?\n/.test(raw))throw Error();
        const n=api.count(api.header(e.name.slice(0,-3),raw));headers.push(n);total+=n;
      } catch {unreadableHeaders++;}
    }
    return total;
  }
  const global=countHeaders(path.join(root,'memory','global')),projects=path.join(root,'memory','project');
  for(const dir of entries(projects).filter(e=>e.isDirectory()))projectTotals.push(global+countHeaders(path.join(projects,dir.name)));
  return {sessions:ids.size,indexedSessions:counts.length,unavailableIndexes,shardRows,sessionWindows:distribution(counts),sessionsOver1938:counts.filter(n=>n>1938).length,
    headerWindows:distribution(headers),unreadableHeaders,globalAndProjectWindows:distribution(projectTotals),projectsOver512:projectTotals.filter(n=>n>512).length};
}
if(process.argv[2]==='--header-fixture'){
  const lengths=Array.from({length:20},(_,n)=>150+Math.round(n*250/19));
  const count=(size,n)=>{
    const id='memory-'+n, name='部署'.repeat(10), desc='发布检查'.repeat(100).slice(0,size);
    const raw=['---','name: '+name,'description: '+desc,'type: reference','---'].join('\n');
    return {before:api.count([id,name,desc,desc,'reference'].join(' ')),after:api.count(api.header(id,raw))};
  };
  const rows=lengths.map(count);
  console.log(JSON.stringify({descriptionChars:lengths,before:rows.map(r=>r.before),after:rows.map(r=>r.after),beforeTotal:rows.reduce((a,b)=>a+b.before,0),afterTotal:rows.reduce((a,b)=>a+b.after,0)},null,2));
} else {
if(!process.argv[2])throw Error('data root argument required');
console.log(JSON.stringify(inventory(fs.realpathSync(process.argv[2])),null,2));
}
