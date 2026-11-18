'use strict';
// Small graph metadata and upstream source only. External weight data forbidden.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function main(directory){const root=path.resolve(directory),head=JSON.parse(fs.readFileSync(path.join(root,'transformers-js-head.json'))).sha,onnx=JSON.parse(fs.readFileSync(path.join(root,'onnx-api.json'))).sha,receipts=[];
 async function get(url,name,cap=3*1024*1024){const response=await fetch(url);if(!response.ok)throw Error(response.status+' '+url);let total=0;const parts=[];for await(const bytes of response.body){total+=bytes.length;if(total>cap)throw Error('Small metadata cap');parts.push(bytes);}const bytes=Buffer.concat(parts);fs.writeFileSync(path.join(root,name),bytes,{flag:'wx'});receipts.push({url,name,bytes:bytes.length,sha256:hash(bytes)});return bytes;}
 const tree=JSON.parse(await get('https://api.github.com/repos/huggingface/transformers.js/git/trees/'+head+'?recursive=1','transformers-js-tree.json'));
 const sourceFiles=tree.tree.filter(row=>row.type==='blob'&&(/embedding_gemma2|gemma4/.test(row.path)||/packages\/transformers\/(package.json|LICENSE)$/.test(row.path))).map(row=>row.path);for(const file of sourceFiles)await get('https://raw.githubusercontent.com/huggingface/transformers.js/'+head+'/'+file,'js-'+file.replaceAll('/','_'));
 await get('https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/'+onnx+'/onnx/model_q4.onnx','model_q4.metadata.onnx',600000);
 await get('https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/'+onnx+'/onnx/model_quantized.onnx','model_q8.metadata.onnx',600000);
 const python=JSON.parse(await get('https://api.github.com/repos/huggingface/transformers/commits/main','transformers-python-head.json'));for(const file of ['src/transformers/models/embedding_gemma2/modeling_embedding_gemma2.py','src/transformers/models/embedding_gemma2/tokenization_embedding_gemma2.py','LICENSE'])try{await get('https://raw.githubusercontent.com/huggingface/transformers/'+python.sha+'/'+file,'py-'+file.replaceAll('/','_'));}catch(error){receipts.push({file,error:String(error)});}
 await get('https://www.apache.org/licenses/LICENSE-2.0.txt','Apache-2.0.txt');
 fs.writeFileSync(path.join(root,'source-audit-downloads.json'),JSON.stringify({status:'SMALL_GRAPH_AND_SOURCE_ONLY_NO_INFERENCE',head,onnx,receipts},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({head,onnx,sourceFiles,receipts:receipts.length}));
}
if(require.main===module)main(process.argv[2]||'output/embeddinggemma2-metadata-r1').catch(error=>{console.error(error);process.exitCode=1;});module.exports={main};
