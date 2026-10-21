'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const LIMIT=256*1024,secret='SYNTHETIC_M1_CONTACT_SECRET';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function createGateway({upstream,deadline=Date.now()+20000,responseChallenge='M1_RESPONSE_'+crypto.randomBytes(16).toString('hex'),protocol='openai'}) {
  if(!['openai','anthropic'].includes(protocol))throw new Error('protocol-denied');
  const root=path.resolve(__dirname,'../../..'),names=['01i-privacy-rules.js','01h-privacy-core.js'];
  const sources=names.map(name=>fs.readFileSync(path.join(root,'ruyi-workbench/app/src',name),'utf8'));
  const core=vm.runInNewContext(sources.join('\n')+'\nPrivacyCore;',{require,Buffer});
  const policy=Object.freeze({rules:[{id:'m1-cli-literal',kind:'literal',value:secret,category:'INTERNAL'}]});
  const scope=core.createScope({scopeId:'m1-cli-protected-scope',detector:core.createDetector(policy)});
  const originalPrompt='Return the synthetic provider reply verbatim. Contact: '+secret,projected=scope.protectRaw(originalPrompt);
  const evidence={protocol,recipient:'m1-synthetic-provider',purpose:'model-inference',policySha256:sha(JSON.stringify(policy)),rulesSha256:sha(sources.join('\n')),originalPromptSha256:sha(originalPrompt),projectedPromptSha256:sha(projected.text),responseChallengeSha256:sha(responseChallenge),projectionMatches:projected.matches.length,requests:[],rejected:0};let inflight=false;
  function protectString(text,budget) {
    scope.validateProtected(text);let out='',from=0,hits=0;
    for(const token of text.matchAll(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g)){const segment=scope.protectRaw(text.slice(from,token.index),{budget});out+=segment.text+token[0];hits+=segment.matches.length;from=token.index+token[0].length;}
    const segment=scope.protectRaw(text.slice(from),{budget});return {text:out+segment.text,hits:hits+segment.matches.length};
  }
  async function handle(request) {
    if(inflight||Date.now()>=deadline){evidence.rejected++;throw new Error('broker-unavailable');}inflight=true;
    try {
      const route=protocol==='anthropic'?request?.method==='POST'&&request?.path==='/v1/messages':(request?.method==='POST'&&request?.path==='/v1/chat/completions')||(request?.method==='GET'&&request?.path==='/v1/models');
      if(!request||Object.keys(request).sort().join(',')!=='bodyBase64,id,method,operation,path,purpose,recipient,version'||request.version!==1||!/^[-a-f0-9]{36}$/.test(request.id)||request.operation!=='model-request'||request.recipient!==evidence.recipient||request.purpose!==evidence.purpose||!route||typeof request.bodyBase64!=='string'||request.bodyBase64.length>Math.ceil(LIMIT/3)*4)throw new Error('request-denied');
      const raw=Buffer.from(request.bodyBase64,'base64');if(raw.length>LIMIT||raw.toString('base64')!==request.bodyBase64)throw new Error('request-denied');
      let body,hits=0;
      if(request.method==='POST') {
        const value=JSON.parse(raw.toString('utf8'));if(value.model!=='synthetic-m1'||!Array.isArray(value.messages))throw new Error('model-denied');const budget=core.createMatchBudget();
        function walk(item,depth=0){if(depth>32)throw new Error('payload-depth');if(typeof item==='string'){const result=protectString(item,budget);hits+=result.hits;return result.text;}if(Array.isArray(item))return item.map(entry=>walk(entry,depth+1));if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).map(([key,entry])=>{if(protectString(key,budget).hits)throw new Error('sensitive-key');return [key,walk(entry,depth+1)];}));return item;}
        body=JSON.stringify(walk(value));if(Buffer.byteLength(body)>LIMIT||body.includes(secret))throw new Error('payload-denied');
      }else if(raw.length)throw new Error('get-body-denied');
      if(Date.now()>=deadline)throw new Error('deadline');
      const record={method:request.method,path:request.path,sourceBodySha256:sha(raw),upstreamBodySha256:body?sha(body):null,upstreamBodyBytes:body?Buffer.byteLength(body):0,matches:hits,containsOriginal:false,delivery:'submitted-result-unknown'};evidence.requests.push(record);
      const headers=body?{'content-type':'application/json'}:{};if(protocol==='anthropic')headers['anthropic-version']='2023-06-01';
      const response=await fetch(upstream+request.path,{method:request.method,body,headers,redirect:'error',signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
      const reader=response.body.getReader(),parts=[];let size=0;
      try {for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>LIMIT)throw new Error('response-limit');parts.push(value);}}finally{await reader.cancel().catch(()=>{});}
      const bytes=Buffer.concat(parts),contentType=response.headers.get('content-type')?.split(';')[0];if(!['application/json','text/event-stream'].includes(contentType))throw new Error('response-type');
      Object.assign(record,{responseSha256:sha(bytes),status:response.status,delivery:'confirmed',responseContainsChallenge:bytes.toString('utf8').includes(responseChallenge)});
      return {id:request.id,status:response.status,contentType,bodyBase64:bytes.toString('base64')};
    }catch(error){evidence.rejected++;throw error;}finally{inflight=false;}
  }
  return {handle,evidence,projectedPrompt:projected.text,expectedResponse:responseChallenge};
}
module.exports={createGateway,LIMIT};
