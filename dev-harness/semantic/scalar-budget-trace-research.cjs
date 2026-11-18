'use strict';
// Opt-in diagnostic wrapper for a single sequential research request stream.
// It does not change deadlines, policy, inputs, guards, cache or native host.
// Only timings and endpoint names are recorded; no request/body/header/text.
const {performance}=require('node:perf_hooks');
function wrapScalarHost(host) {
  if(!host||typeof host.verify!=='function'||typeof host.prepare!=='function')throw TypeError('trace.invalid_host');
  const traces=[];let active=false;
  async function verify(query,source,options={}) {
    if(active||typeof options.beforeVerify!=='function')return host.verify(query,source,options);
    active=true;const started=performance.now(),deadline=options.deadline,priorFetch=global.fetch;let estimate;
    try{estimate=typeof host.estimateVerificationBudget==='function'?host.estimateVerificationBudget(1):null;}catch(error){active=false;throw error;}
    const trace={remainingAtHostMs:Number.isFinite(deadline)?deadline-Date.now():null,estimateMs:estimate,guards:[],http:[],status:'running'};
    const timedFetch=async(input,init)=>{
      let route='other';try{const u=new URL(typeof input==='string'?input:input.url);if(u.hostname==='127.0.0.1'&&['/tokenize','/slots/0','/rerank'].includes(u.pathname))route=u.pathname;}catch{}
      const begin=performance.now();let response;
      try{response=await priorFetch(input,init);}catch(error){if(route!=='other')trace.http.push({route,headersMs:performance.now()-begin,transportError:true});throw error;}
      if(route==='other')return response;
      const entry={route,headersMs:performance.now()-begin,status:response.status},json=response.json.bind(response);trace.http.push(entry);
      response.json=async()=>{const parse=performance.now();try{return await json();}finally{entry.jsonMs=performance.now()-parse;entry.totalMs=performance.now()-begin;}};
      return response;
    };
    global.fetch=timedFetch;
    const beforeVerify=options.beforeVerify;
    try {
      const result=await host.verify(query,source,{...options,beforeVerify:async()=>{
        const begin=performance.now(),remaining=Number.isFinite(deadline)?deadline-Date.now():null;
        try{return await beforeVerify();}finally{trace.guards.push({remainingMs:remaining,elapsedMs:performance.now()-begin});}
      }});
      trace.status=result?.ok?'ok':result?.reason||'unavailable';return result;
    }catch(error){trace.status='threw';throw error;}
    finally{trace.elapsedMs=performance.now()-started;trace.remainingAtReturnMs=Number.isFinite(deadline)?deadline-Date.now():null;
      trace.fetchRestoreConflict=global.fetch!==timedFetch;if(!trace.fetchRestoreConflict)global.fetch=priorFetch;traces.push(trace);active=false;}
  }
  return Object.freeze({...host,verify,takeBudgetTraces:()=>traces.splice(0,traces.length)});
}
module.exports={wrapScalarHost};
