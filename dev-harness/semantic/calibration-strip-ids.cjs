'use strict';
// Research representation only. Reuse the exact production ID grammar and map
// normalized matches back to original UTF16 spans; other bytes stay unchanged.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'),'utf8'),api=vm.runInNewContext(source+'\nSemanticRetrieval;',{require,Buffer,Date,setTimeout,clearTimeout});
const parserSource=api.structuredIds.toString()+'\n'+api.structuredIdMatches.toString(),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function stripIds(value){const original=String(value),map=[];let normalized='';for(const {segment,index}of new Intl.Segmenter('und',{granularity:'grapheme'}).segment(original)){const plain=segment.normalize('NFKC').toLowerCase();normalized+=plain;for(let i=0;i<plain.length;i++)map.push({start:index,end:index+segment.length});}if(normalized!==original.normalize('NFKC').toLowerCase())throw Error('Normalization mapping requires review');
 const matches=Array.from(api.structuredIdMatches(original));if(JSON.stringify([...new Set(matches.map(row=>row.value))])!==JSON.stringify(Array.from(api.structuredIds(original))))throw Error('Shared ID parser mismatch');
 const spans=matches.map(match=>({start:map[match.start].start,end:map[match.end-1].end}));let text='',at=0;for(const span of spans){if(span.start<at)continue;text+=original.slice(at,span.start)+' ';at=span.end;}text+=original.slice(at);return{text,changed:text!==original,removedIdentifiers:[...new Set(matches.map(row=>row.value))],removedSpans:spans};}
module.exports={id:'structured-id-span-removal-v3',stripIds,parserSha256:hash(parserSource),sourceSha256:hash(fs.readFileSync(__filename))};
