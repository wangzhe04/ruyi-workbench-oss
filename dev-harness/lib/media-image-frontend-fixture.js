'use strict';
const fs=require('node:fs'),p=require('node:path'),vm=require('node:vm'),c=require('node:crypto');
const {fixture:contractFixture,h}=require('./media-image-contract-fixture');
const frontendRoot=p.resolve(__dirname,'../../ruyi-workbench/app/public/js');
const moduleBody=name=>fs.readFileSync(p.join(frontendRoot,name),'utf8').replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gm,'').replace(/^export /gm,'');
const plain=value=>JSON.parse(JSON.stringify(value));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function fixture(options={}) {
  const f=contractFixture(),token=await f.pipeline.prepare(),borrow=f.pipeline.borrow(token);
  const bytes=Buffer.from(borrow.bytes),base=plain(borrow.manifest);borrow.release();f.pipeline.release(token);
  const state={config:{privacyModeV1:'enhanced'},currentSession:{id:'thread-synthetic'},attachments:[]};
  const calls=[],urls=[],revoked=[];let counter=0,time=1000;
  const record={id:'synthetic-upload',name:'fixture.png',kind:'image'};state.attachments.push(record);
  let latest;
  const api=async(url,request={})=>{
    calls.push({url,...request});
    if(request.method==='DELETE'){if(options.remove)await options.remove(url,record);return{ok:true};}
    const body=JSON.parse(request.body),manifest={...base,regionsHash:h(JSON.stringify(body.regions||null)),expiresAt:time+60000};
    options.manifest?.(manifest,body);
    latest={id:(++counter).toString(16).padStart(32,'0'),manifest};latest.reference='https://ruyi.invalid/protected-image/'+latest.id;
    return options.prepare ? options.prepare(latest,body,record) : latest;
  };
  const apiRaw=async(url,request)=>{
    calls.push({url,...request});
    if(options.beforePreview)await options.beforePreview(latest,record);
    const headers={'content-type':'image/png','x-ruyi-payload-sha256':latest.manifest.payloadHash,'x-ruyi-manifest-sha256':h(JSON.stringify(latest.manifest))};
    options.headers?.(headers,latest);
    return{ok:true,headers:{get:name=>headers[name]||null},blob:async()=>{
      if(options.blob)await options.blob(latest,record);
      const value=Buffer.from(bytes);options.bytes?.(value);
      return{arrayBuffer:async()=>value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength)};
    }};
  };
  const sandbox={state,api,apiRaw,t:key=>key,AbortController,crypto:c.webcrypto,TextEncoder,DataView,
    Date:{now:()=>time},URL:{createObjectURL:blob=>{const url='blob:synthetic-'+urls.length;urls.push({url,blob});return url;},revokeObjectURL:url=>revoked.push(url)}};
  const names=['REGION_LIMIT','imagePolicyStamp','isProtectedImage','sameRegionBinding','regionSelection','regionPoint','dragRegion','invalidateImageOperations','releaseImagePreviews','discardProtectedImage','prepareProtectedImages'];
  const apiModule=vm.runInNewContext(moduleBody('protected-image-state.js')+';({'+names.join(',')+'});',sandbox,{filename:'protected-image-state.js'});
  return{...apiModule,state,record,calls,urls,revoked,base,bytes,setTime:value=>time=value};
}
module.exports={fixture,moduleBody,plain,deferred};
