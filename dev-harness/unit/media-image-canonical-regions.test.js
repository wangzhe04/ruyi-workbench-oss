'use strict';
require('../lib/media-artifact-test-guard');
const {test}=require('node:test'),a=require('node:assert/strict');
const {fixture,h,png,pixel,source,functionBlock}=require('../lib/media-image-contract-fixture');
const selection=(f,orientation=1)=>({space:'canonical-pixels-v1',sourceHash:f.sourceHash,sourceRevision:'s1',
  width:orientation>4?16:32,height:orientation>4?32:16,
  transformHash:h(JSON.stringify({width:32,height:16,orientation})),boxes:[[12,12,14,14]]});
for(let orientation=1;orientation<=8;orientation++)test('canonical displayed pixels bind actual EXIF '+orientation+' and mask exactly once',async()=>{
  const f=fixture({changeFrame:frame=>{frame.transform.orientation=orientation;if(orientation>4){frame.width=16;frame.height=32;frame.codes=[];}}});
  const regions=selection(f,orientation),token=await f.pipeline.prepare({regions}),borrow=f.pipeline.borrow(token),image=png(borrow.bytes);
  a.deepEqual(pixel(image,12,12),[0,0,0]);a.deepEqual(pixel(image,15,12),[200,200,200]);
  a.equal(borrow.manifest.transformHash,regions.transformHash);a.equal(borrow.manifest.regionsHash,h(JSON.stringify(regions)));
  a.equal(borrow.manifest.width,regions.width);a.equal(borrow.manifest.height,regions.height);f.pipeline.release(token);
});
for(const [label,mutate] of [
  ['source',r=>r.sourceHash='0'.repeat(64)],['revision',r=>r.sourceRevision='old'],['width',r=>r.width=31],['height',r=>r.height=15],
  ['transform',r=>r.transformHash='0'.repeat(64)],['missing transform',r=>delete r.transformHash],['extra orientation',r=>r.orientation=1],
  ['extra key',r=>r.safe=true],['string dimension',r=>r.width='32'],['negative box',r=>r.boxes=[[-1,0,1,1]]],
  ['off-image box',r=>r.boxes=[[30,0,33,1]]],['empty box',r=>r.boxes=[[1,1,1,2]]],['NaN',r=>r.boxes=[[0,0,NaN,1]]],
  ['Infinity',r=>r.boxes=[[0,0,1,Infinity]]],['too many',r=>r.boxes=Array.from({length:4097},()=>[0,0,1,1])]
])test('canonical selection rejects '+label+' without issuing an artifact',async()=>{
  const f=fixture(),regions=selection(f);mutate(regions);await a.rejects(f.pipeline.prepare({regions}));
});
test('canonical fractional edges round outward and zero regions are an explicit reset',async()=>{
  const f=fixture(),regions=selection(f);regions.boxes=[[12.8,12.8,13.1,13.1]];
  const token=await f.pipeline.prepare({regions}),borrow=f.pipeline.borrow(token),image=png(borrow.bytes);
  a.deepEqual(pixel(image,12,12),[0,0,0]);a.deepEqual(pixel(image,13,13),[0,0,0]);a.deepEqual(pixel(image,14,14),[200,200,200]);f.pipeline.release(token);
  regions.boxes=[];const empty=await f.pipeline.prepare({regions}),view=f.pipeline.borrow(empty);a.deepEqual(pixel(png(view.bytes),12,12),[200,200,200]);f.pipeline.release(empty);
});
test('source-pixel mapper and OCR interval mapper retain reviewed production bytes',()=>{
  a.equal(h(functionBlock(source,'explicitBoxes')),'3081833f96598a16884008d9fdc7e1d666cd9e2d0ce188da4146530bf5da8e2c');
  a.equal(h(functionBlock(source,'mapWords')),'757792e792caf7a7a92e4b8a36826a09eea9ca6b04104b44c2e8959082d05c0c');
});
