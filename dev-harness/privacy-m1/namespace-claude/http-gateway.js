'use strict';
const http=require('node:http'),crypto=require('node:crypto');
const {createGateway,LIMIT}=require('../cli/gateway-broker');
async function startGateway(options){
  const broker=createGateway({...options,protocol:'anthropic'}),observed=[];
  const server=http.createServer(async(req,res)=>{
    if(observed.length<64)observed.push({method:['POST','HEAD','GET'].includes(req.method)?req.method:'other',route:req.url==='/v1/messages'?'messages':req.url==='/v1/messages?beta=true'?'messages-beta':req.url==='/'?'root':'denied',pathSha256:crypto.createHash('sha256').update(req.url||'').digest('hex'),pathBytes:Buffer.byteLength(req.url||'')});
    if(req.method!=='POST'||!['/v1/messages','/v1/messages?beta=true'].includes(req.url)){res.writeHead(403);res.end();return;}
    const parts=[];let size=0;
    try{
      for await(const part of req){size+=part.length;if(size>LIMIT)throw new Error('limit');parts.push(part);}
      const response=await broker.handle({version:1,id:crypto.randomUUID(),operation:'model-request',recipient:broker.evidence.recipient,purpose:broker.evidence.purpose,method:'POST',path:'/v1/messages',bodyBase64:Buffer.concat(parts).toString('base64')});
      res.writeHead(response.status,{'content-type':response.contentType});res.end(Buffer.from(response.bodyBase64,'base64'));
    }catch{if(!res.headersSent)res.writeHead(403);res.end();}
  });
  server.requestTimeout=15000;server.headersTimeout=5000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {...broker,observed,url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
module.exports={startGateway};
