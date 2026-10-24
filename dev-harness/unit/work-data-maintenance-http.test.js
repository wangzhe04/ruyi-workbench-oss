'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),crypto=require('node:crypto');
const source=fs.readFileSync(process.env.HTTP_CANDIDATE||path.join(__dirname,'../../ruyi-workbench/app/src/13al-work-data-maintenance-http.js'),'utf8');
const api=vm.runInNewContext(source+'\nWorkDataMaintenanceHttp;', {http,crypto,Buffer,URL,Set,Promise});
const id='a'.repeat(48), other='b'.repeat(48), secret='PRIVATE_PASSWORD_DO_NOT_ECHO';
const ordinary=()=>({authority:{generation:0,id:null,mode:'plain',sha256:null},job:{id,operation:'enable',state:'handoff',createdAt:123,
  phase:'snapshot',password:secret,backupPath:'C:\\backup\\actual.ruyi'},password:secret,lastResult:{id,state:'complete',password:secret}});
const bind=(server,port,hostname='127.0.0.1')=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,hostname,()=>resolve(server.address().port));});
async function freePort(hostname='127.0.0.1'){const server=http.createServer();const port=await bind(server,0,hostname);await new Promise(resolve=>server.close(resolve));return port;}
function request(port,url='/api/work-data/status',{method='GET',headers={},body,hostname='127.0.0.1'}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname,port,path:url,method,headers,agent:false},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');resolve({status:res.statusCode,headers:res.headers,text,value:JSON.parse(text)});
      });
    });req.on('error',reject);req.setTimeout(2000,()=>req.destroy(Error('unit request timeout')));req.end(body);
  });
}
async function fixture(t,{readStatus=ordinary,assertColdOwner=()=>true}={}){
  const port=await freePort();const host=api.create({id,port,readStatus,assertColdOwner});t.after(()=>host.close());await host.listen();
  const bootstrap=await request(port,'/api/bootstrap',{method:'POST'});assert.equal(bootstrap.status,200);
  const headers={'x-wcw-token':bootstrap.value.token};return {port,host,headers,token:bootstrap.value.token};
}

test('cold-owner proof is required before binding any listener',async t=>{
  const port=await freePort();let reads=0,binds=0;
  const observedHttp={createServer:(...args)=>{const server=http.createServer(...args),listen=server.listen;server.listen=function(...args){binds++;return listen.apply(server,args);};return server;}};
  const observedApi=vm.runInNewContext(source+'\nWorkDataMaintenanceHttp;', {http:observedHttp,crypto,Buffer,URL,Set,Promise});
  const host=observedApi.create({id,port,assertColdOwner:()=>false,readStatus:()=>{reads++;return ordinary();}});t.after(()=>host.close());
  await assert.rejects(host.listen(),{code:'work_data_setup.ownership_required'});
  const competing=http.createServer();await bind(competing,port);await new Promise(resolve=>competing.close(resolve));assert.equal(reads,0);assert.equal(binds,0);
});
test('actual loopback progress projects current authority and finite job fields without completion or secrets',async t=>{
  const value=ordinary(),f=await fixture(t,{readStatus:()=>value});
  let result=await request(f.port,undefined,{headers:f.headers});assert.equal(result.status,200);assert.equal(result.value.job.phase,'snapshot');
  assert.equal(result.value.authority.mode,'plain');assert.equal(result.value.job.cancellable,false);assert.equal(result.value.job.takeover,true);
  assert.equal(result.value.job.operationMayHaveExecuted,true);assert.equal(result.value.lastResult,null);assert.equal(result.value.capabilities.worker,false);
  assert.equal(result.value.job.backupPath,'C:\\backup\\actual.ruyi');assert.ok(!result.text.includes(secret));assert.equal(result.headers['cache-control'],'no-store');
  value.job.phase='publish-generation';value.job.state='uncertain';value.job.error='work_data_setup.publish_failed';
  result=await request(f.port,'/api/work-data/jobs/'+id,{headers:f.headers});assert.equal(result.value.job.phase,'publish-generation');
  assert.equal(result.value.job.state,'uncertain');assert.equal(result.value.job.error,'work_data_setup.publish_failed');assert.ok(!result.text.includes(secret));
});
test('fresh private token and stale UI token rejection use existing net refresh contract before status access',async t=>{
  let reads=0;const f=await fixture(t,{readStatus:()=>{reads++;return ordinary();}});
  const missing=await request(f.port);assert.equal(missing.status,403);assert.equal(missing.value.error.code,'auth.token_invalid');assert.equal(reads,0);
  const stale=await request(f.port,undefined,{headers:{'x-wcw-token':'f'.repeat(64)}});assert.equal(stale.status,403);assert.equal(reads,0);
  assert.match(f.token,/^[a-f0-9]{64}$/);const second=await fixture(t);assert.notEqual(second.token,f.token);
  const result=await request(second.port,undefined,{headers:f.headers});assert.equal(result.status,403);
});
test('rebound Host cross-origin bootstrap and browser cross-site requests never expose token or read status',async t=>{
  let reads=0;const f=await fixture(t,{readStatus:()=>{reads++;return ordinary();}});
  for(const headers of [{host:'evil.test:'+f.port},{origin:'http://evil.test:'+f.port},{origin:'null'},{origin:'https://127.0.0.1:'+f.port},
    {'sec-fetch-site':'cross-site'},{host:'127.0.0.1:'+f.port,origin:'http://localhost:'+f.port}]){
    const result=await request(f.port,'/api/bootstrap',{method:'POST',headers});assert.equal(result.status,403);assert.equal(result.value.token,undefined);
  }
  assert.equal(reads,0);
  const same=await request(f.port,'/api/bootstrap',{method:'POST',headers:{origin:'http://127.0.0.1:'+f.port,'sec-fetch-site':'same-origin'}});assert.equal(same.value.token,f.token);
});
test('all writes cancel unknown ids query aliases and warm routes fail closed without calling status owner',async t=>{
  let reads=0;const f=await fixture(t,{readStatus:()=>{reads++;return ordinary();}});
  for(const [url,method] of [['/api/work-data/jobs','POST'],['/api/work-data/jobs/'+id+'/cancel','POST'],['/api/config','POST'],
    ['/api/work-data/jobs/'+other,'GET'],['/api/work-data/status?token='+f.token,'GET'],['/api/status','GET'],['/','GET']]){
    const result=await request(f.port,url,{method,headers:f.headers});assert.ok([404,409].includes(result.status));assert.equal(result.value.ok,false);
  }
  assert.equal(reads,0);
});
test('bootstrap and progress reject bodies and chunked uploads before status access',async t=>{
  let reads=0;const f=await fixture(t,{readStatus:()=>{reads++;return ordinary();}});
  for(const [url,method,headers,body] of [['/api/bootstrap','POST',{'content-length':'2'},'{}'],
    ['/api/work-data/status','GET',{...f.headers,'transfer-encoding':'chunked'},secret]]){
    const result=await request(f.port,url,{method,headers,body});assert.equal(result.status,413);assert.equal(result.value.token,undefined);assert.ok(!result.text.includes(secret));
  }
  assert.equal(reads,0);
});
test('only exact active job and valid authority noncompleted bounded snapshots are accepted',async t=>{
  let value=ordinary();const f=await fixture(t,{readStatus:()=>value});
  for(const change of [v=>v.job.id=other,v=>v.job.state='complete',v=>v.authority.sha256='bogus',v=>v.job.phase=null,
    v=>v.job.backupPath='x'.repeat(4097),v=>v.job.error=secret,v=>v.authority.generation=-1]){
    value=ordinary();change(value);const result=await request(f.port,undefined,{headers:f.headers});assert.equal(result.status,503);assert.ok(!result.text.includes(secret));
  }
});
test('ownership loss before request or during snapshot suppresses authority and progress',async t=>{
  let owned=true,lose=false,reads=0;const f=await fixture(t,{assertColdOwner:()=>owned,readStatus:()=>{reads++;if(lose)owned=false;return ordinary();}});
  owned=false;let result=await request(f.port,undefined,{headers:f.headers});assert.equal(result.status,503);assert.equal(reads,0);
  owned=true;lose=true;result=await request(f.port,undefined,{headers:f.headers});assert.equal(result.status,503);assert.equal(result.value.job,undefined);assert.equal(reads,1);
});
test('status exceptions never leak native message paths passwords or masquerade as completion',async t=>{
  const f=await fixture(t,{readStatus:()=>{throw Error(secret+' C:\\private');}}),result=await request(f.port,undefined,{headers:f.headers});
  assert.equal(result.status,503);assert.equal(result.value.error.code,'work_data_setup.status_unavailable');assert.ok(!result.text.includes(secret));assert.equal(result.value.job,undefined);
});
test('health is low sensitivity and successful close releases original port before successor can bind',async t=>{
  let reads=0;const f=await fixture(t,{readStatus:()=>{reads++;return ordinary();}}),health=await request(f.port,'/health');
  assert.deepEqual(health.value,{ok:true,maintenance:true,ready:false});assert.equal(reads,0);
  await f.host.close();await f.host.close();await assert.rejects(f.host.listen(),{code:'work_data_setup.http_already_started'});
  const successor=http.createServer();await bind(successor,f.port);await new Promise(resolve=>successor.close(resolve));
});
test('close during pending listen releases the listener and does not expose a serving interval',async()=>{
  const port=await freePort(),host=api.create({id,port,assertColdOwner:()=>true,readStatus:ordinary});
  const starting=host.listen();await host.close();await starting;
  const successor=http.createServer();await bind(successor,port);await new Promise(resolve=>successor.close(resolve));
});
test('occupied original port fails once without selecting a substitute port',async t=>{
  const existing=http.createServer(),port=await bind(existing,0);t.after(()=>new Promise(resolve=>existing.close(resolve)));
  const host=api.create({id,port,assertColdOwner:()=>true,readStatus:ordinary});t.after(()=>host.close());
  await assert.rejects(host.listen(),{code:'EADDRINUSE'});await assert.rejects(host.listen(),{code:'work_data_setup.http_already_started'});
});
test('mutable host identity cannot retarget current job port or owner callback after construction',async t=>{
  const port=await freePort(),options={id,port,assertColdOwner:()=>true,readStatus:ordinary},host=api.create(options);t.after(()=>host.close());
  options.id=other;options.port=1;options.assertColdOwner=()=>false;await host.listen();
  const bootstrap=await request(port,'/api/bootstrap',{method:'POST'}),result=await request(port,'/api/work-data/jobs/'+id,{headers:{'x-wcw-token':bootstrap.value.token}});
  assert.equal(result.status,200);assert.equal(result.value.job.id,id);
});
test('ownership lost while original port is binding closes it before listen can succeed',async t=>{
  let calls=0;const port=await freePort(),host=api.create({id,port,assertColdOwner:()=>++calls===1,readStatus:ordinary});t.after(()=>host.close());
  await assert.rejects(host.listen(),{code:'work_data_setup.ownership_required'});
  const successor=http.createServer();await bind(successor,port);await new Promise(resolve=>successor.close(resolve));
});
test('closing destroys this host stalled sockets before releasing port for successor',async t=>{
  const net=require('node:net'),f=await fixture(t),socket=net.connect({host:'127.0.0.1',port:f.port});t.after(()=>socket.destroy());
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});socket.write('GET /api/work-data/status HTTP/1.1\r\n');
  await f.host.close();const successor=http.createServer();await bind(successor,f.port);await new Promise(resolve=>successor.close(resolve));
});
test('original IPv6 loopback binding supports actual bootstrap progress and successor port reuse',async t=>{
  const port=await freePort('::1'),host=api.create({id,port,bindHost:'::1',assertColdOwner:()=>true,readStatus:ordinary});t.after(()=>host.close());await host.listen();
  const bootstrap=await request(port,'/api/bootstrap',{hostname:'::1',method:'POST',headers:{origin:'http://[::1]:'+port}});assert.equal(bootstrap.status,200);
  const result=await request(port,undefined,{hostname:'::1',headers:{'x-wcw-token':bootstrap.value.token}});assert.equal(result.status,200);assert.equal(result.value.job.id,id);
  const rebound=await request(port,'/api/bootstrap',{hostname:'::1',method:'POST',headers:{host:'evil.test:'+port}});assert.equal(rebound.status,403);
  await host.close();const successor=http.createServer();await bind(successor,port,'::1');await new Promise(resolve=>successor.close(resolve));
});
test('arbitrary remote or DNS bind hosts are rejected before listener creation',()=>{
  for(const bindHost of ['0.0.0.0','::','evil.test','127.0.0.1.evil','[::1]',''])assert.throws(()=>api.create({id,port:34567,bindHost,assertColdOwner:()=>true,readStatus:ordinary}),{code:'work_data_setup.http_host_invalid'});
});
