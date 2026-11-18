'use strict';
// Only the explicitly authorized public2022 license documents and REDIST pages.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve('output/semantic-rank-redist-licenses-v1');
if(fs.existsSync(root))throw Error('Use a fresh owner directory; no overwrite.');
fs.mkdirSync(root);fs.writeFileSync(path.join(root,'OWNER.json'),JSON.stringify({owner:'/root/sol_release_materials',purpose:'Official2022 BuildTools/VC runtime license documents only',createdAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const sources=[
 ['buildtools-2022-landing.html','https://visualstudio.microsoft.com/license-terms/vs2022-ga-diagnosticbuildtools/'],
 ['vcruntime-2022-landing.html','https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/'],
 ['buildtools-2022-updated-202403.docx','https://visualstudio.microsoft.com/wp-content/uploads/2024/03/Visual-Studio-2022-Diagnostic-Build-Tools-Agent-License_Update-March-2024_EN.docx'],
 ['vcruntime-2015-2022.docx','https://visualstudio.microsoft.com/wp-content/uploads/2021/09/Visual-C-Runtime-2015-2022-License-1.docx'],
 ['vs2022-redistribution.html','https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution'],
 ['installed-buildtools-license-url.response','https://go.microsoft.com/fwlink/?LinkId=2179911']
];
const allowed=new Set(['visualstudio.microsoft.com','learn.microsoft.com','go.microsoft.com','download.microsoft.com']);
async function get(url){const redirects=[];for(let i=0;i<8;i++){
 const u=new URL(url);if(u.protocol!=='https:'||!allowed.has(u.hostname)||u.username||u.password)throw Error('Unapproved redirect '+url);
 const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(30000),headers:{'user-agent':'ruyi-public-license-material-audit/1.0','accept':'*/*'}});
 const headers=Object.fromEntries(['content-type','content-length','last-modified','etag','location'].map(k=>[k,response.headers.get(k)]));
 redirects.push({url,status:response.status,headers});
 if(response.status>=300&&response.status<400&&headers.location){await response.body?.cancel();url=new URL(headers.location,url).href;continue;}
 if(response.status!==200){await response.body?.cancel();throw Object.assign(Error('HTTP '+response.status),{redirects});}
 if(headers['content-length']&&Number(headers['content-length'])>1024*1024){await response.body?.cancel();throw Error('Document over1MiB');}
 let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>1024*1024)throw Error('Document over1MiB');chunks.push(Buffer.from(chunk));}
 return {bytes:Buffer.concat(chunks),redirects,finalURL:url};
 }throw Error('Redirect limit');}
(async()=>{const report={schemaVersion:1,status:'RUNNING',startedAt:new Date().toISOString(),scope:'Only public2022 license/source-list documents; no installer/weights/system changes',previousSourceNotes:{file:'output/semantic-rank-redist-audit-r2/official-sources-r1.json',sha256:hash(fs.readFileSync('output/semantic-rank-redist-audit-r2/official-sources-r1.json'))},records:[]};try{
 for(const [name,url]of sources){const item=await get(url);if(name.endsWith('.docx')&&!item.bytes.subarray(0,4).equals(Buffer.from([0x50,0x4b,3,4])))throw Error('Expected DOCX ZIP');const file=path.join(root,name);fs.writeFileSync(file,item.bytes,{flag:'wx'});report.records.push({requestedURL:url,finalURL:item.finalURL,redirects:item.redirects,file,bytes:item.bytes.length,sha256:hash(item.bytes)});}
 report.status='PASS_PUBLIC_2022_LICENSE_DOCUMENT_DOWNLOAD';
 }catch(error){report.status='FAIL';report.error=String(error.stack||error);report.failedRedirects=error.redirects;process.exitCode=1;}
 report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(root,'downloads.lock.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,records:report.records.map(x=>({file:path.basename(x.file),bytes:x.bytes,sha256:x.sha256,finalURL:x.finalURL})),error:report.error}));})();
