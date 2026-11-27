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
const config = src('01-config.js');
const memoryId = vm.runInNewContext(constBlock(src('00-boot.js'), 'SKILL_ID_RE') + '\nSKILL_ID_RE');
const headReadCap = vm.runInNewContext(constBlock(memory, 'MEMORY_METADATA_READ_CAP') + '\nMEMORY_METADATA_READ_CAP');
const safeSessionId = vm.runInNewContext([
  constBlock(config, 'RESERVED_SESSION_FILE_IDS'), functionBlock(config, 'safeSessionId'), 'safeSessionId'
].join('\n'));
function sessionHeads(dir) {
  return entries(dir).filter(entry => entry.isFile() && /\.json$/i.test(entry.name) && safeSessionId(entry.name.slice(0, -5)));
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
  const ids=new Set(sessionHeads(sessions).map(e=>e.name.slice(0,-5)));
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
    for (const entry of entries(dir)) {
      const id = entry.name.slice(0, -3);
      if (!entry.isFile() || !/\.md$/i.test(entry.name) || !memoryId.test(id)) continue;
      try {
        const file = path.join(dir, entry.name);
        if (fs.lstatSync(file).size > 260 * 1024) throw Error('unsupported header');
        const raw = fs.readFileSync(file).subarray(0, headReadCap).toString('utf8');
        // Ambiguous JSON or sealed bytes need the authorized reader. Leave them uncounted.
        if (/^[\s\ufeff]*[{"\[]/.test(raw)) throw Error('header reader required');
        const n = api.count(api.header(id, raw));
        headers.push(n);
        total += n;
      } catch { unreadableHeaders++; }
    }
    return total;
  }
  const global=countHeaders(path.join(root,'memory','global')),projects=path.join(root,'memory','project');
  for(const dir of entries(projects).filter(e=>e.isDirectory()))projectTotals.push(global+countHeaders(path.join(projects,dir.name)));
  return {sessions:ids.size,indexedSessions:counts.length,unavailableIndexes,shardRows,sessionWindows:distribution(counts),sessionsOver1938:counts.filter(n=>n>1938).length,
    headerWindows:distribution(headers),unreadableHeaders,globalAndProjectWindows:distribution(projectTotals),projectsOver512:projectTotals.filter(n=>n>512).length};
}
// Retain the head's committed LF-delimited prefix. Bound memory for unsupported inputs.
async function* committedLines(stream) {
  const limit = 20 * 1024 * 1024;
  let parts = [], bytes = 0;
  for await (const block of stream) {
    let from = 0;
    while (from < block.length) {
      const lf = block.indexOf(10, from);
      const part = block.subarray(from, lf < 0 ? block.length : lf);
      bytes += part.length;
      if (bytes > limit) throw Error('unsupported message size');
      parts.push(part);
      if (lf < 0) break;
      const raw = Buffer.concat(parts, bytes);
      const text = raw.toString('utf8');
      if (!Buffer.from(text).equals(raw)) throw Error('unsupported encoding');
      parts = [];
      bytes = 0;
      yield text;
      from = lf + 1;
    }
  }
}
// Estimate only committed, readable message text. Do not load a user's service, keys or attachments.
async function estimateCommitted(root) {
  const dir=path.join(root,'sessions');
  const factory=index.slice(0,index.indexOf('// Committed upload references'))
    .replace('SCHEMA,CHARS,OVERLAP,SHARD_BYTES,sources,create,canonicalCacheSize:', 'SCHEMA,CHARS,OVERLAP,SHARD_BYTES,sources,slices,semanticWindows,create,canonicalCacheSize:');
  const indexApi=vm.runInNewContext(factory+'\nSessionFullTextIndex;', {require,Buffer,Intl,process});
  const noise=vm.runInNewContext(functionBlock(src('13d-core-domain-routes.js'),'sessionSearchRowIsNoise')+';sessionSearchRowIsNoise');
  const windows=[],rows=[],out={stewardSessions:0,missingTranscript:0,unreadableOrChanged:0};
  for (const entry of sessionHeads(dir)) {
    const id = entry.name.slice(0, -5);
    const headFile = path.join(dir, entry.name);
    const bodyFile = path.join(dir, id + '.messages.ndjson');
    let stream;
    try {
      const headText = read(headFile);
      const head = JSON.parse(headText);
      if (head.id !== id) throw Error('owner changed');
      if (head.kind === 'steward' || head.rawKind === 'steward') {
        out.stewardSessions++;
        continue;
      }
      let count = 0, chunks = 0, seen = 0;
      function countMessage(message) {
        seen++;
        if (!message || typeof message.role !== 'string') throw Error('unsupported message');
        if (noise(message)) return;
        for (const field of indexApi.sources(message)) {
          for (const chunk of indexApi.slices(field.text)) {
            chunks++;
            for (const window of indexApi.semanticWindows(chunk.text)) count++;
          }
        }
      }
      if (head.storageVersion === 2) {
        if (!Number.isSafeInteger(head.messageCount) || head.messageCount < 0) throw Error('unsupported head');
        if (head.messageCount) {
          const before = fs.lstatSync(bodyFile);
          if (!before.isFile()) throw Error('unsupported body');
          stream = fs.createReadStream(bodyFile);
          for await (const line of committedLines(stream)) {
            countMessage(JSON.parse(line));
            if (seen === head.messageCount) break;
          }
          const after = fs.lstatSync(bodyFile);
          if (seen !== head.messageCount || before.ino !== after.ino || before.size !== after.size || before.ctimeMs !== after.ctimeMs) throw Error('incomplete body');
        }
      } else {
        if (!Array.isArray(head.messages)) throw Error('unsupported head');
        head.messages.forEach(countMessage);
      }
      if (read(headFile) !== headText) throw Error('head changed');
      windows.push(count);
      rows.push(chunks);
    } catch (error) {
      if (error.code === 'ENOENT') out.missingTranscript++;
      else out.unreadableOrChanged++;
    } finally {
      stream?.destroy();
    }
  }
  return {...out,shardRows:distribution(rows),sessionWindows:distribution(windows),sessionsOver4096:windows.filter(n=>n>4096).length,sessionsOver1938:windows.filter(n=>n>1938).length};
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
  async function runInventory() {
    if (!process.argv[2]) throw Error('data root argument required');
    const root = fs.realpathSync(process.argv[2]);
    const result = inventory(root);
    if (process.argv[3] === '--estimate-committed') result.committedTextEstimate = await estimateCommitted(root);
    console.log(JSON.stringify(result, null, 2));
  }
  runInventory().catch(() => {console.error('Library inventory failed'); process.exitCode = 1;});
}
