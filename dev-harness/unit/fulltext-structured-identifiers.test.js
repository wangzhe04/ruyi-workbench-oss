'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {fixture}=require('../lib/fulltext-consumer-fixture');
test('long natural queries require complete structured identifiers in one verified source',async t=>{
 const f=await fixture();t.after(()=>f.close());const primitive=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'),'utf8');f.context.SemanticRetrieval=vm.runInNewContext(primitive+'\nSemanticRetrieval;',{require,Date});
 const row=(id,content)=>({role:'user',id,turnSeq:1,content});
 await f.put('Exact',[row('m','Work package OP-12 records the exact decision.')],{head:{title:'plain'}});
 await f.put('Prefix',[row('m','Work package OP-123 has a different decision.')],{head:{title:'plain'}});
 await f.put('Both',[row('m','OP-12 '+ 'x '.repeat(3000)+' and ZZ-91 in same source')],{head:{title:'plain'}});
 await f.put('Separate',[row('a','OP-12 one document'),row('b','ZZ-91 another document')],{head:{title:'plain'}});
 await f.put('Metadata',[row('m','unrelated body')],{head:{title:'planning ZZ-912 overview'}});
 await f.put('MetadataSplit',[row('m','unrelated body')],{head:{title:'OP-12 project',summary:'ZZ-91 overview'}});
 await f.put('CutPrefix',[row('m','x'.repeat(4090)+' OP-123 remains a different token')],{head:{title:'plain'}});
 await f.put('CutMixed',[row('m','x'.repeat(4090)+' OP-123 other text '+ 'q '.repeat(2500)+' true OP-12')],{head:{title:'plain'}});
 await f.put('SameChunk',[row('m','OP-123 is wrong; the correct entity is OP-12.')],{head:{title:'plain'}});
 const ids=out=>out.results.map(x=>x.id);
 let out=await f.ui('Please explain what was previously decided for ＯＰ－１２ and why was it selected');assert.ok(ids(out).includes('Exact'));assert.ok(ids(out).includes('Both'));assert.ok(!ids(out).includes('Prefix'));assert.ok(!ids(out).includes('CutPrefix'),'truncated prefix of a longer identifier cannot match');assert.ok(ids(out).includes('CutMixed'),'true later identifier is retained');const mixed=out.results.find(x=>x.id==='CutMixed');assert.match(mixed.snippet,/true OP-12/);const same=out.results.find(x=>x.id==='SameChunk');assert.ok(same,'later complete token in same shard is retained');assert.equal(same.reference.matchStart,'OP-123 is wrong; the correct entity is '.length);assert.equal(out.results.find(x=>x.id==='Exact').reference.matchKind,'lexical-entity');
 out=await f.ui('Explain relation between OP-12 and ZZ-91 after all prior discussions');assert.ok(ids(out).includes('Both'));assert.ok(!ids(out).includes('Separate'));assert.ok(!ids(out).includes('Metadata'));assert.ok(!ids(out).includes('MetadataSplit'),'different metadata fields cannot be combined into one entity source');
 out=await f.ui('What about planning ZZ-91 and the related overview');assert.ok(!ids(out).includes('Metadata'),'metadata prefix must not match the shorter identifier');
 out=await f.ui('Please explain OP-9999 and the previous planning overview');assert.equal(out.results.length,0,'unknown identifier cannot fall back to common words');
});
test('bounded entity hit buffers report partial rather than claiming exhaustive matching',async t=>{
 const f=await fixture();t.after(()=>f.close());const primitive=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'),'utf8');f.context.SemanticRetrieval=vm.runInNewContext(primitive+'\nSemanticRetrieval;',{require,Date});await f.put('Many',[{role:'user',id:'m',turnSeq:1,content:('OP-12 '+ 'x '.repeat(2100)).repeat(34)}]);const out=await f.ui('OP-12',null,()=>f.hooks.search('OP-12',1));assert.equal(out.entity.required,1);assert.equal(out.entity.partial,true);assert.ok(out.results.length);
});
test('different multi-segment identifiers never match through a shared suffix',async t=>{
 const f=await fixture();t.after(()=>f.close());const primitive=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'),'utf8');f.context.SemanticRetrieval=vm.runInNewContext(primitive+'\nSemanticRetrieval;',{require,Date});await f.put('Correct',[{role:'user',id:'m',turnSeq:1,content:'AB-ZZ-91 approved decision'}]);await f.put('Wrong',[{role:'user',id:'m',turnSeq:1,content:'XY-ZZ-91 different decision'}]);const out=await f.ui('Explain the earlier AB-ZZ-91 decision');assert.ok(out.results.some(x=>x.id==='Correct'));assert.ok(!out.results.some(x=>x.id==='Wrong'));
});
test('shared identifier parser validates whole tokens without suffix recovery',()=>{
 const primitive=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'),'utf8'),api=vm.runInNewContext(primitive+'\nSemanticRetrieval;',{require,Date}),ids=value=>Array.from(api.structuredIds(value));
 assert.deepEqual(ids('ＡＢ－ＺＺ－９１'),['ab-zz-91']);assert.deepEqual(ids('XY-ZZ-91'),['xy-zz-91']);assert.deepEqual(ids('OP-12'),['op-12']);assert.deepEqual(ids('X'.repeat(20)+'-ZZ-91'),[]);assert.deepEqual(ids('AB-ZZ-91-QW-42'),['ab-zz-91-qw-42']);
});
test('overlong invalid identifier is not substituted with a shared suffix',async t=>{
 const f=await fixture();t.after(()=>f.close());const primitive=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'),'utf8');f.context.SemanticRetrieval=vm.runInNewContext(primitive+'\nSemanticRetrieval;',{require,Date});await f.put('Wrong',[{role:'user',id:'m',turnSeq:1,content:'XY-ZZ-91 different decision'}]);const out=await f.ui('Explain decision for '+ 'X'.repeat(20)+'-ZZ-91');assert.equal(out.results.length,0);
});
test('punctuation following identifier does not admit a longer identifier',async t=>{
 const f=await fixture();t.after(()=>f.close());const primitive=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'),'utf8');f.context.SemanticRetrieval=vm.runInNewContext(primitive+'\nSemanticRetrieval;',{require,Date});await f.put('Wrong',[{role:'user',id:'m',turnSeq:1,content:'OP-123 decision'}]);await f.put('Right',[{role:'user',id:'m',turnSeq:1,content:'OP-12: approved decision'}]);const out=await f.ui('Decision for OP-12:');assert.deepEqual(Array.from(out.results,row=>row.id),['Right']);
});

test('structured ID coverage counts only eligible sources while preserving real truncation',async t=>{
 const {fixture:owned}=require('../lib/fulltext-owned-producer-fixture');const f=await owned();t.after(()=>f.close());
 const primitive=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'),'utf8');f.hookContext.SemanticRetrieval=vm.runInNewContext(primitive+'\nSemanticRetrieval;',{require,Date});
 await f.put('Right',[{role:'user',id:'m',content:'OP-12 confirmed'}]);await f.put('Wrong',[{role:'user',id:'m',content:'OP-123 different'}]);
 const semantic={score:async(_q,docs)=>({status:'ready',scores:docs.map(()=>.9),minScore:.34,coverage:{cached:docs.length,total:docs.length,complete:true},admission:{policyId:'test',status:'evaluated',purpose:'search-relevance',accepted:docs.map(()=>true)}})};
 const index=vm.runInNewContext('SessionFullTextIndex',f.hookContext).create({...f.host,resultUnit:'sessions',semantic});await index.step(16);
 const out=await index.search('OP-12',null,20);assert.equal(out.semantic.coverage,'complete');assert.equal(out.semantic.truncated,false);assert.deepEqual(Array.from(out.results,x=>x.reference.sessionId),['Right']);
});

test('structured ID coverage marks real eligible candidate truncation partial',async t=>{
 const {fixture:owned}=require('../lib/fulltext-owned-producer-fixture');const f=await owned();t.after(()=>f.close());
 const primitive=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'),'utf8');f.hookContext.SemanticRetrieval=vm.runInNewContext(primitive+'\nSemanticRetrieval;',{require,Date});
 await f.put('Many',[{role:'user',id:'m',content:('OP-12 '+ 'x '.repeat(2100)).repeat(34)}]);
 const semantic={score:async(_q,docs)=>({status:'ready',scores:docs.map(()=>.9),minScore:.34,coverage:{cached:docs.length,total:docs.length,complete:true},admission:{policyId:'test',status:'evaluated',purpose:'search-relevance',accepted:docs.map(()=>true)}})};
 const index=vm.runInNewContext('SessionFullTextIndex',f.hookContext).create({...f.host,resultUnit:'sessions',semantic});await index.step(16);
 const out=await index.search('OP-12',null,1);assert.equal(out.entity.partial,true);assert.equal(out.semantic.truncated,true);assert.equal(out.semantic.coverage,'partial');
});

test('structured ID coverage retains the 4096-fragment bound in an eligible source',async t=>{
 const {fixture:owned}=require('../lib/fulltext-owned-producer-fixture');const f=await owned();t.after(()=>f.close());
 const primitive=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'),'utf8');f.hookContext.SemanticRetrieval=vm.runInNewContext(primitive+'\nSemanticRetrieval;',{require,Date});
 await f.put('Long',[{role:'user',id:'m',content:'OP-12 '+ 'ordinary words '.repeat(26000)}]);
 const semantic={score:async(_q,docs)=>({status:'ready',scores:docs.map(()=>.9),minScore:.34,coverage:{cached:docs.length,total:docs.length,complete:true},admission:{policyId:'test',status:'evaluated',purpose:'search-relevance',accepted:docs.map(()=>true)}})};
 const index=vm.runInNewContext('SessionFullTextIndex',f.hookContext).create({...f.host,resultUnit:'sessions',semantic});await index.step(16);
 const out=await index.search('OP-12',null,1);assert.equal(out.semantic.truncated,true);assert.equal(out.semantic.coverage,'partial');assert.ok(out.results.some(x=>x.reference.sessionId==='Long'));
});
