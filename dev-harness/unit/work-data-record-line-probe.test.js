'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(process.env.RUYI_RECORD_PROBE_SOURCE||path.resolve(__dirname,'../../ruyi-workbench/app/src/01q-work-data-records.js'),'utf8');
const records=vm.runInNewContext(source+'\nWorkDataRecords;',{Buffer});
const check=(raw,width=1)=>{const probe=records.lineProbe(),bytes=Buffer.from(raw);for(let start=0;start<bytes.length;start+=width)probe.feed(bytes.subarray(start,start+width));return probe.reserved();};
test('top-level literal or escaped w is observed at every byte split and arbitrary property order',()=>{
 const rows=['{"w":2,"e":{}}','  {"before":{"w":"nested"},"\\u0077":2}','{"giant":"abc","w":3}', '{"\\u0077":0}', '{"w":null}', '{"w":"not a format"}'];
 for(const raw of rows){const bytes=Buffer.from(raw);for(let split=0;split<=bytes.length;split++){const probe=records.lineProbe();probe.feed(bytes.subarray(0,split));probe.feed(bytes.subarray(split));assert.equal(probe.reserved(),true,raw+' split'+split);}}
});
test('nested w, arrays, string contents and different escaped keys never become a top-level reserved key',()=>{
 const rows=['[]','[{"w":2}]','"{\\"w\\":2}"','{"e":{"w":2}}','{"e":[{"w":2}]}','{"ww":1,"W":2}','{"\\u0077x":1}','{"\\\\u0077":1}','{"x":"\\\"w\\\":2,{}[]"}','{"x":"😀汉字\\\\tail","y":9}','{"":"w"}'];
 for(const raw of rows){assert.doesNotThrow(()=>JSON.parse(raw),raw);for(const width of [1,2,5,17])assert.equal(check(raw,width),false,raw);}
});
test('an observed w remains reserved and separate probe instances do not share lexical state',()=>{
 const first=records.lineProbe(),second=records.lineProbe();first.feed(Buffer.from('{"w"'));assert.equal(first.reserved(),true);second.feed(Buffer.from('{"x":"'));first.feed(Buffer.from(':garbage'));second.feed(Buffer.from('w"}'));assert.equal(first.reserved(),true);assert.equal(second.reserved(),false);
});
test('large legacy values and deep containers are skipped with fixed probe state until a late w',()=>{
 const probe=records.lineProbe(),block=Buffer.alloc(64*1024,120);probe.feed(Buffer.from('{"legacy":"'));
 for(let index=0;index<128;index++)probe.feed(block);assert.equal(probe.reserved(),false);probe.feed(Buffer.from('","nested":'));
 const depth=40000;probe.feed(Buffer.from('['.repeat(depth)));probe.feed(Buffer.from('{"w":2}'));probe.feed(Buffer.from(']'.repeat(depth)));assert.equal(probe.reserved(),false);
 probe.feed(Buffer.from(',"\\u0077":3}'));assert.equal(probe.reserved(),true);
});
test('valid JSON oracle agrees across deterministic varied nested rows and arbitrary chunk widths',()=>{
 let seed=24891;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 for(let index=0;index<2000;index++){
  const top=index%11===0?[]:{};
  if(!Array.isArray(top))for(let count=rand()%8;count>=0;count--){const name=['w','ww','W','nested','x','😀','quote"','slash\\'][rand()%8];top[name]=[null,'w','汉字😀','\\u0077',{w:2},[{w:3}],rand()][rand()%7];}
  else top.push({w:2});
  let raw=JSON.stringify(top);if(index%2===0)raw=raw.replace(/"w":/g,'"\\u0077":');
  const parsed=JSON.parse(raw),expected=parsed!==null&&typeof parsed==='object'&&!Array.isArray(parsed)&&Object.hasOwn(parsed,'w');
  assert.equal(check(raw,1+rand()%23),expected,raw);
 }
});
test('Buffer and Uint8Array fragments are accepted; unrelated input types are rejected',()=>{
 const probe=records.lineProbe();probe.feed(new Uint8Array(Buffer.from('{"w":2}')));assert.equal(probe.reserved(),true);
 for(const value of ['{"w":2}',[],new Uint16Array(2),new DataView(new ArrayBuffer(4)),null])assert.throws(()=>records.lineProbe().feed(value),{code:'work_data_record.probe_input'});
});
test('UTF8 BOM and every JS-trim whitespace codepoint are recognized across every byte split',()=>{
 const codepoints=[9,10,11,12,13,32,0xa0,0x1680,...Array.from({length:11},(_,i)=>0x2000+i),0x2028,0x2029,0x202f,0x205f,0x3000,0xfeff];
 for(const codepoint of codepoints){const raw=String.fromCodePoint(codepoint)+'{"e":{"value":"abc"},"\\u0077":2}',bytes=Buffer.from(raw);assert.equal(raw.trim().startsWith('{'),true);
  for(let split=0;split<=bytes.length;split++){const probe=records.lineProbe();probe.feed(bytes.subarray(0,split));probe.feed(bytes.subarray(split));assert.equal(probe.reserved(),true,'U+'+codepoint.toString(16)+' split'+split);}
 }
 for(const prefix of ['\u0085','\u200b','😀'])assert.equal(check(prefix+'{"w":2}'),false);
 for(const bytes of [Buffer.from([0xc0,0xa0,123,34,119,34]),Buffer.from([0xed,0xa0,0x80,123,34,119,34]),Buffer.from([0xf4,0x90,0x80,0x80,123,34,119,34])]){const probe=records.lineProbe();probe.feed(bytes);assert.equal(probe.reserved(),false);}
 const late=records.lineProbe();late.feed(Buffer.from('\ufeff\u3000 {"e":"'));const block=Buffer.alloc(65536,120);for(let i=0;i<32;i++)late.feed(block);late.feed(Buffer.from('","w":2}'));assert.equal(late.reserved(),true);
});
