// Original constrained transport adapter. The OS token and host broker are the boundary.
import crypto from 'node:crypto';
export const LIMIT=256*1024,ORIGIN='https://privacy-gateway.invalid';
export function writePipeFrame(socket,request,signal){signal.throwIfAborted();socket.write(JSON.stringify(request)+'\n');}
async function boundedBody(request) {
  if(!request.body)return Buffer.alloc(0);const reader=request.body.getReader(),parts=[];let size=0;
  try {for(;;){request.signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>LIMIT)throw new Error('request-limit');parts.push(value);}return Buffer.concat(parts);}
  finally {await reader.cancel().catch(()=>{});}
}
export function createFetchAdapter(exchange) {
  return async function protectedFetch(input,init) {
    const request=new Request(input,init),url=new URL(request.url);request.signal.throwIfAborted();
    if(url.origin!==ORIGIN||url.username||url.password||url.search||url.hash||!((request.method==='POST'&&url.pathname==='/v1/chat/completions')||(request.method==='GET'&&url.pathname==='/v1/models')))throw new Error('recipient-denied');
    const body=await boundedBody(request),id=crypto.randomUUID();request.signal.throwIfAborted();
    const reply=await exchange({version:1,id,operation:'model-request',recipient:'m1-synthetic-provider',purpose:'model-inference',method:request.method,path:url.pathname,bodyBase64:body.toString('base64')},request.signal);
    request.signal.throwIfAborted();
    if(!reply||reply.id!==id||!Number.isInteger(reply.status)||reply.status<200||reply.status>599||typeof reply.bodyBase64!=='string'||reply.bodyBase64.length>Math.ceil(LIMIT/3)*4)throw new Error('reply-invalid');
    const bytes=Buffer.from(reply.bodyBase64,'base64');if(bytes.length>LIMIT||bytes.toString('base64')!==reply.bodyBase64)throw new Error('reply-invalid');
    if(!['application/json','text/event-stream'].includes(reply.contentType))throw new Error('reply-type-denied');
    return new Response(bytes,{status:reply.status,headers:{'content-type':reply.contentType}});
  };
}
