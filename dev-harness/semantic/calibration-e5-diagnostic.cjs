'use strict';
// Small synthetic sanity check, separate from threshold selection and holdouts.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{pathToFileURL}=require('node:url');
const root=path.resolve(process.argv[2]||'output/semantic-calibration-model-runtime-v1'),out=path.resolve(process.argv[3]||'output/semantic-calibration-e5-diagnostic-v1.json');
if(fs.existsSync(out))throw Error('Use a new diagnostic output.');
const anchors=[['怎样给盆栽浇水？','How should potted plants be watered?','土壤干燥时给盆栽浇水。','Water potted plants when the soil is dry.'],['如何更换自行车轮胎？','How do I replace a bicycle tire?','取下车轮后更换轮胎。','Remove the wheel and replace the bicycle tire.'],['会议定在星期几？','On which day is the meeting?','会议定在星期五。','The meeting is scheduled for Friday.']];
async function main(){
 const worker=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/semantic-runtime/worker.cjs'),'utf8');
 const feeds=vm.runInNewContext(worker.slice(worker.indexOf('function modelFeeds('),worker.indexOf('async function main('))+'\nmodelFeeds;',{BigInt64Array});
 const {AutoTokenizer}=await import(pathToFileURL(path.join(root,'node_modules/@huggingface/transformers/dist/transformers.node.mjs'))),ort=require(path.join(root,'node_modules/onnxruntime-node'));
 const rows=[];
 for(const id of ['multilingual-e5-small','multilingual-e5-small-official-q8']){
  const dir=path.join(root,'models',id),t=await AutoTokenizer.from_pretrained(dir,{local_files_only:true}),s=await ort.InferenceSession.create(path.join(dir,'onnx/model_quantized.onnx'),{executionProviders:['cpu'],intraOpNumThreads:2,interOpNumThreads:1,logSeverityLevel:4});
  const encode=async text=>{const input=t([text],{padding:true,truncation:true,max_length:512}),output=await s.run(feeds(ort,s,input)),h=output.last_hidden_state,dim=h.dims[2],v=new Array(dim).fill(0);for(let n=0;n<h.dims[1];n++)if(Number(input.attention_mask.data[n]))for(let d=0;d<dim;d++)v[d]+=h.data[n*dim+d];const norm=Math.hypot(...v);return v.map(x=>x/norm);};
  const queryTexts=anchors.flatMap(x=>x.slice(0,2)),docs=anchors.flatMap(x=>x.slice(2)),q=[];for(const x of queryTexts)q.push(await encode('query: '+x));
  const variants={};for(const prefix of ['passage: ','query: ']){const d=[];for(const x of docs)d.push(await encode(prefix+x));variants[prefix]=q.map((v,i)=>({query:queryTexts[i],scores:d.map(w=>v.reduce((n,x,k)=>n+x*w[k],0)),expectedSameTopic:[Math.floor(i/2)*2,Math.floor(i/2)*2+1]}));}
  const examples=['query: 南瓜的家常做法','query: how much protein should a female eat'];
  rows.push({modelId:id,inputNames:s.inputNames,outputNames:s.outputNames,officialExampleTokens:examples.map(text=>{const x=t(text);return{text,ids:Array.from(x.input_ids.data,Number),mask:Array.from(x.attention_mask.data,Number)};}),variants});await s.release();
 }
 const result={schemaVersion:1,generatedAt:new Date().toISOString(),documents:anchors.flatMap(x=>x.slice(2)),models:rows,limits:['Diagnostic anchors do not select thresholds.','No acceptance data is read.','Same source feed adapter and mean+L2, fixed physical batch1.','Official model usage https://huggingface.co/intfloat/multilingual-e5-small']};fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(out);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
