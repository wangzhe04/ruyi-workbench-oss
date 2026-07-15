#!/usr/bin/env node
'use strict';

// Live, deterministic benchmark for models configured in a running Ruyi Workbench.
// It uses Ruyi's own session/stream/tool loop rather than calling providers directly.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');

const BASE = process.env.RUYI_URL || 'http://127.0.0.1:8765';
const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'benchmark-results', 'fixtures');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.join(ROOT, 'benchmark-results', RUN_ID);

const MODELS = [
  { key: 'mimo-v2.5', providerId: 'openai-compatible-2', model: 'mimo-v2.5' },
  { key: 'mimo-v2.5-pro', providerId: 'openai-compatible-2', model: 'mimo-v2.5-pro' },
  { key: 'hy3', providerId: 'openai-compatible', model: 'hy3' },
  { key: 'deepseek-v4-flash', providerId: 'deepseek', model: 'deepseek-v4-flash' },
  { key: 'deepseek-v4-pro', providerId: 'deepseek', model: 'deepseek-v4-pro' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function round(n, d = 2) { const p = 10 ** d; return Math.round(n * p) / p; }
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
function median(xs) { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function jsonFromText(text) {
  const s = String(text || '').trim();
  const candidates = [s, (s.match(/```(?:json)?\s*([\s\S]*?)```/i) || [])[1], (s.match(/(\{[\s\S]*\}|\[[\s\S]*\])/m) || [])[1]].filter(Boolean);
  for (const c of candidates) { try { return JSON.parse(c.trim()); } catch { /* continue */ } }
  return null;
}
function extractCode(text) {
  const m = String(text || '').match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : text).trim();
}
function safeName(s) { return String(s).replace(/[^a-z0-9._-]+/gi, '_'); }

function buildLongContext() {
  const rows = [];
  for (let i = 1; i <= 90; i++) {
    const fake = String((i * 7919) % 100000).padStart(5, '0');
    rows.push(`记录${String(i).padStart(3, '0')}：项目代号 P-${fake}，负责人 用户${i % 17}，状态 ${i % 3 === 0 ? '等待' : '进行中'}。`);
    if (i === 17) rows.push('【有效指令A】北区最终批准码 = NQ-7319；旧码 NQ-1111 已作废。');
    if (i === 46) rows.push('【有效指令B】南区最终批准码 = SQ-2048；草案 SQ-9999 不得采用。');
    if (i === 83) rows.push('【有效指令C】审计批次 = AUD-55-K；任何其他批次号均为干扰项。');
  }
  return rows.join('\n');
}

const TASKS = [
  {
    id: 'daily_exact_json_a', category: 'daily', weight: 10,
    prompt: '严格按要求回答，不要解释，不要 Markdown。订单：3件单价19.90元，2件单价5.50元；优惠8.40元；优惠后按6%计税，金额四舍五入到分。只输出一行 JSON，键顺序必须是 subtotal,discount,tax,total，值必须是数字。',
    score(text) {
      const j = jsonFromText(text); let s = 0;
      if (j && !Array.isArray(j)) s += 1;
      if (j && j.subtotal === 70.7) s += 2;
      if (j && j.discount === 8.4) s += 1;
      if (j && j.tax === 3.74) s += 2;
      if (j && j.total === 66.04) s += 2;
      if (/^\{[^\r\n]+\}$/.test(String(text).trim()) && !/```/.test(text)) s += 1;
      if (j && Object.keys(j).join(',') === 'subtotal,discount,tax,total') s += 1;
      return { score: s, max: 10 };
    },
  },
  {
    id: 'daily_exact_json_b', category: 'daily', weight: 10,
    prompt: '只输出 JSON 数组，不要解释。把下列工单依次分类为 billing、bug、feature、other：①重复扣款 ②导出按钮点了没反应 ③希望增加深色模式 ④忘记密码 ⑤发票金额错误 ⑥页面加载后白屏 ⑦建议支持批量重命名 ⑧咨询营业时间。每项格式必须是 {"id":数字,"label":"分类"}。',
    score(text) {
      const j = jsonFromText(text); const exp = ['billing','bug','feature','other','billing','bug','feature','other'];
      let correct = 0;
      if (Array.isArray(j) && j.length === 8) for (let i = 0; i < 8; i++) if (j[i] && j[i].id === i + 1 && j[i].label === exp[i]) correct++;
      return { score: round(correct / 8 * 9 + (/^\[[\s\S]*\]$/.test(String(text).trim()) && !/```/.test(text) ? 1 : 0)), max: 10 };
    },
  },
  {
    id: 'daily_meeting_extract', category: 'daily', weight: 10,
    prompt: '从会议纪要提取信息，只输出 JSON：{"decisions":[],"actions":[],"risks":[]}。纪要：团队决定8月1日灰度上线支付重构；决定旧支付接口保留到9月15日。李雷在7月20日前补齐回归测试；韩梅梅在7月22日前完成监控看板。风险：第三方支付沙箱偶发超时；法务尚未确认退款文案。不要加入未明确的信息。',
    score(text) {
      const j = jsonFromText(text); if (!j) return { score: 0, max: 10 };
      const all = JSON.stringify(j); let s = 0;
      for (const k of ['decisions','actions','risks']) if (Array.isArray(j[k])) s += 1;
      for (const k of ['8月1日','9月15日','李雷','7月20日','韩梅梅','7月22日','沙箱','法务']) if (all.includes(k)) s += 0.8;
      if (Object.keys(j).every(k => ['decisions','actions','risks'].includes(k))) s += 0.6;
      return { score: Math.min(10, round(s)), max: 10 };
    },
  },
  {
    id: 'complex_schedule', category: 'complex', weight: 12,
    prompt: '你有2名相同工人，任务不可抢占：A=3小时，B=2小时，C=4小时且依赖A，D=2小时且依赖A和B，E=3小时且依赖C和D。所有任务从0时开始可用。求最短完工时间，并给出一个合法排程；再用一句话说明为什么不可能更短。只输出 JSON：{"makespan":数字,"schedule":[{"task":"A","start":0,"end":3,"worker":1}],"lower_bound":"..."}。',
    score(text) {
      const j = jsonFromText(text); if (!j || !Array.isArray(j.schedule)) return { score: 0, max: 12 };
      let s = j.makespan === 10 ? 4 : 0; const by = Object.fromEntries(j.schedule.map(x => [x.task, x]));
      const dur = {A:3,B:2,C:4,D:2,E:3};
      for (const [k,d] of Object.entries(dur)) if (by[k] && by[k].end - by[k].start === d) s += 0.6;
      const deps = by.C && by.A && by.C.start >= by.A.end && by.D && by.B && by.D.start >= Math.max(by.A.end,by.B.end) && by.E && by.E.start >= Math.max(by.C.end,by.D.end);
      if (deps) s += 2;
      let overlapOk = true;
      for (const w of [1,2]) { const xs=j.schedule.filter(x=>x.worker===w).sort((a,b)=>a.start-b.start); for(let i=1;i<xs.length;i++) if(xs[i].start<xs[i-1].end) overlapOk=false; }
      if (overlapOk) s += 1;
      if (String(j.lower_bound || '').match(/E|C|关键|依赖|链|10/)) s += 2;
      return { score: Math.min(12, round(s)), max: 12 };
    },
  },
  {
    id: 'complex_long_context', category: 'complex', weight: 12,
    prompt: `阅读以下长记录。忽略旧码、草案和普通项目代号，只提取三条“有效指令”。只输出一行 JSON：{"north":"...","south":"...","audit":"..."}。\n\n${buildLongContext()}`,
    score(text) {
      const j=jsonFromText(text); let s=0;
      if(j&&j.north==='NQ-7319')s+=4;if(j&&j.south==='SQ-2048')s+=4;if(j&&j.audit==='AUD-55-K')s+=4;
      return { score:s,max:12 };
    },
  },
  {
    id: 'code_generation', category: 'coding', weight: 16,
    prompt: '实现 JavaScript 函数 reconcileRanges(ranges)。输入是数组；每项应为两个有限数字 [a,b]。忽略格式错误或含 NaN/Infinity 的项；若 a>b 先交换；将重叠或首尾相接的闭区间合并；按起点升序返回新数组；不得修改输入。只输出完整函数代码，不要解释。',
    score(text) {
      const code=extractCode(text); let fn;
      try { const ctx={}; vm.createContext(ctx); vm.runInContext(`${code}; this.__fn = reconcileRanges;`,ctx,{timeout:500}); fn=ctx.__fn; } catch(e){ return {score:0,max:16,detail:e.message}; }
      const cases=[
        [[],[]], [[[1,3],[2,4]],[[1,4]]], [[[5,3],[1,2]],[[1,2],[3,5]]], [[[1,2],[2,3]],[[1,3]]],
        [[[1,1],[1,1]],[[1,1]]], [[[3,4],['x',2],[8,9]],[[3,4],[8,9]]], [[[Infinity,2],[0,1]],[[0,1]]],
        [[[-2,-1],[-1,0],[2,2]],[[-2,0],[2,2]]], [[[10,11],[1,9],[9,10]],[[1,11]]], [[[0.1,0.2],[0.2,0.3]],[[0.1,0.3]]],
      ];
      let pass=0;
      for(const [inp,exp] of cases){try{const before=JSON.stringify(inp);const got=fn(inp);if(JSON.stringify(got)===JSON.stringify(exp)&&JSON.stringify(inp)===before)pass++;}catch{/*fail*/}}
      return {score:round(pass/cases.length*16),max:16,detail:`${pass}/${cases.length} tests`};
    },
  },
  {
    id: 'code_review', category: 'coding', weight: 12,
    prompt: `审查下面代码，只输出 JSON 数组。每个元素必须含 severity、line、bug、fix。只报告会导致错误结果、资源泄漏或并发错误的实质问题，不报风格问题。\n\nasync function getUser(id) {\n  if (cache[id]) return cache[id];\n  const controller = new AbortController();\n  const timer = setTimeout(() => controller.abort(), 1000);\n  const p = fetch('/users/' + id, { signal: controller.signal })\n    .then(r => r.json());\n  cache[id] = p;\n  const user = await p;\n  clearTimeout(timer);\n  return user;\n}\n\n已知：HTTP 非 2xx 时 fetch 不会自动 reject；失败的 Promise 不应永久留在 cache；id 可能含 /、?、#。`,
    score(text) {
      const j=jsonFromText(text); if(!Array.isArray(j))return {score:0,max:12}; const all=JSON.stringify(j).toLowerCase(); let s=0;
      if(/response\.ok|r\.ok|非.?2xx|http/.test(all))s+=3;
      if(/catch|delete|失败.*缓存|rejected|promise/.test(all))s+=3;
      if(/finally|cleartimeout|timer|泄漏/.test(all))s+=3;
      if(/encodeuricomponent|url.*编码|转义/.test(all))s+=3;
      return {score:s,max:12};
    },
  },
  {
    id: 'ruyi_tool_loop', category: 'ruyi', weight: 10, toolExpected: ['file_read','file_write'],
    prompt: '这是 Ruyi 工具适配测试。必须先调用 file_read 读取 benchmark-results/fixtures/tool_input.txt，取出其中 nonce；再调用 file_write，把完全相同的 nonce（不要任何额外字符）写入 benchmark-results/fixtures/tool_output.txt；最后只回复 nonce。不要用 shell 工具。',
    score(text, run) {
      let s=0; const names=run.toolNames||[];
      if(names.includes('file_read'))s+=2;if(names.includes('file_write'))s+=2;
      let out='';try{out=fs.readFileSync(path.join(FIXTURE_DIR,'tool_output.txt'),'utf8');}catch{}
      if(out==='RUYI-NONCE-7F3A')s+=4;if(String(text).trim()==='RUYI-NONCE-7F3A')s+=2;
      return {score:s,max:10};
    },
  },
  {
    id: 'ruyi_subagent', category: 'ruyi', weight: 8, toolExpected: ['spawn_agent'],
    prompt: '这是 Ruyi 子代理适配测试。你必须调用且只调用一次 spawn_agent；子任务为：读取 benchmark-results/fixtures/subagent_numbers.txt，计算所有整数之和，并只返回整数。拿到子代理结果后，你最终只回复该整数。不要自己读取文件，不要用其他工具。',
    score(text, run) {
      const n=(run.toolNames||[]).filter(x=>x==='spawn_agent').length; let s=0;if(n===1)s+=4;if(String(text).trim()==='116')s+=4;return {score:s,max:8};
    },
  },
  {
    id: 'coding_agent_fix', category: 'coding', weight: 20,
    prepare() {
      const dir=path.join(FIXTURE_DIR,'agent_case'); fs.rmSync(dir,{recursive:true,force:true}); fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,'README.md'),`# Task\nImplement mergeConfig(base, override) in lib.js.\n\nRules:\n- Recursively merge plain objects.\n- Arrays and non-objects replace the base value.\n- null deletes a key; undefined leaves the base value unchanged.\n- Do not mutate either input.\n- Ignore inherited properties.\n- Ignore __proto__, prototype, and constructor keys at every depth.\n- Only modify lib.js.\n`,'utf8');
      fs.writeFileSync(path.join(dir,'lib.js'),`function mergeConfig(base, override) {\n  // Intentionally incomplete implementation.\n  return { ...base, ...override };\n}\nmodule.exports = { mergeConfig };\n`,'utf8');
      fs.writeFileSync(path.join(dir,'test.js'),`const { mergeConfig } = require('./lib');\nconst tests=[];function t(name,fn){try{fn();tests.push([name,true]);}catch(e){tests.push([name,false,e.message]);}}\nconst eq=(a,b)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(JSON.stringify(a)+' != '+JSON.stringify(b));};\nt('deep merge',()=>eq(mergeConfig({a:1,n:{x:1,y:2}},{n:{y:9,z:3}}),{a:1,n:{x:1,y:9,z:3}}));\nt('array replace',()=>eq(mergeConfig({a:[1,2]},{a:[3]}),{a:[3]}));\nt('null delete',()=>eq(mergeConfig({a:1,n:{x:1,y:2}},{a:null,n:{x:null}}),{n:{y:2}}));\nt('undefined ignore',()=>eq(mergeConfig({a:1,n:{x:2}},{a:undefined,n:{x:undefined}}),{a:1,n:{x:2}}));\nt('immutable',()=>{const a={n:{x:1},z:[1]},b={n:{y:2},z:[2]};const aa=JSON.stringify(a),bb=JSON.stringify(b);mergeConfig(a,b);if(JSON.stringify(a)!==aa||JSON.stringify(b)!==bb)throw Error('mutated');});\nt('inherited ignored',()=>{const o=Object.create({bad:1});o.good=2;eq(mergeConfig({a:1},o),{a:1,good:2});});\nt('pollution guarded',()=>{const evil=JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"evil":true}}}');const r=mergeConfig({},evil);if(({}).polluted||({}).evil||Object.prototype.hasOwnProperty.call(r,'constructor'))throw Error('polluted');});\nt('nested pollution guarded',()=>{const evil=JSON.parse('{"n":{"prototype":{"bad":1},"ok":2}}');eq(mergeConfig({n:{x:1}},evil),{n:{x:1,ok:2}});});\nconst pass=tests.filter(x=>x[1]).length;console.log('RESULT '+pass+'/'+tests.length);for(const x of tests)if(!x[1])console.log('FAIL '+x[0]+': '+x[2]);process.exitCode=pass===tests.length?0:1;\n`,'utf8');
    },
    prompt: '这是 Ruyi 编码代理实测。请阅读 benchmark-results/fixtures/agent_case/README.md、lib.js 和 test.js；只修改 lib.js，完整实现需求；然后运行 node benchmark-results/fixtures/agent_case/test.js 验证，若失败就修到全部通过。最终简短报告测试结果。',
    score(text, run) {
      const dir=path.join(FIXTURE_DIR,'agent_case'); let stdout='',pass=0,total=8;
      try{stdout=cp.execFileSync(process.execPath,[path.join(dir,'test.js')],{cwd:ROOT,encoding:'utf8',timeout:3000});}catch(e){stdout=String((e&&e.stdout)||'')+String((e&&e.stderr)||'');}
      const m=stdout.match(/RESULT\s+(\d+)\/(\d+)/);if(m){pass=Number(m[1]);total=Number(m[2]);}
      return {score:round(pass/total*20),max:20,detail:`${pass}/${total} tests; tools=${(run.toolNames||[]).join(',')}`};
    },
  },
];

const TASK_FILTER = new Set(String(process.env.RUYI_BENCH_TASKS||'').split(',').map(s=>s.trim()).filter(Boolean));
const SELECTED_TASKS = TASK_FILTER.size ? TASKS.filter(t=>TASK_FILTER.has(t.id)) : TASKS;

async function getToken() {
  const html = await (await fetch(BASE + '/')).text();
  const m = html.match(/<meta\s+name=["']wcw-token["']\s+content=["']([^"']+)/i);
  if (!m) throw new Error('Ruyi token meta not found');
  return m[1];
}

async function api(token, p, options = {}) {
  const res = await fetch(BASE + p, { ...options, headers: { 'content-type':'application/json', 'x-wcw-token':token, ...(options.headers||{}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${p} HTTP ${res.status}: ${text.slice(0,500)}`);
  return text ? JSON.parse(text) : {};
}

async function setModel(token, originalConfig, target) {
  const providers = originalConfig.providers.map(p => p.id === target.providerId ? { ...p, model: target.model } : p);
  await api(token, '/api/config', { method:'POST', body:JSON.stringify({ activeProvider:target.providerId, providers }) });
  const status = await api(token, '/api/status');
  const p = status.config.providers.find(x => x.id === target.providerId);
  if (status.config.activeProvider !== target.providerId || !p || p.model !== target.model) throw new Error(`model switch verification failed: ${target.key}`);
}

async function restoreConfig(token, originalConfig) {
  await api(token, '/api/config', { method:'POST', body:JSON.stringify({ activeProvider:originalConfig.activeProvider, model:originalConfig.model, providers:originalConfig.providers }) });
}

async function createSession(token, title) {
  const j = await api(token, '/api/sessions', { method:'POST', body:JSON.stringify({ title, cwd:ROOT }) });
  return j.session.id;
}

async function runStream(token, sessionId, prompt, timeoutMs = 240000) {
  const controller = new AbortController(); const timeout=setTimeout(()=>controller.abort(),timeoutMs);
  const started=Date.now(); let firstByte=null, firstText=null, buf='', answer='', thinking='', status=0; const events=[]; const toolNames=[];
  try {
    const res=await fetch(BASE+'/api/chat/stream',{method:'POST',headers:{'content-type':'application/json','x-wcw-token':token},body:JSON.stringify({sessionId,message:prompt,cwd:ROOT,attachments:[]}),signal:controller.signal});
    status=res.status;if(!res.ok||!res.body)throw new Error(`stream HTTP ${res.status}: ${(await res.text()).slice(0,500)}`);
    const reader=res.body.getReader();const decoder=new TextDecoder();
    while(true){const {done,value}=await reader.read();if(done)break;if(firstByte===null)firstByte=Date.now()-started;buf+=decoder.decode(value,{stream:true});let nl;
      while((nl=buf.indexOf('\n'))>=0){const line=buf.slice(0,nl).trim();buf=buf.slice(nl+1);if(!line)continue;let e;try{e=JSON.parse(line);}catch{continue;}events.push(e);
        if(e.type==='assistant_delta'){if(firstText===null&&e.text)firstText=Date.now()-started;answer+=e.text||'';}
        if(e.type==='thinking_delta')thinking+=e.text||'';
        if(e.type==='tool_use')toolNames.push(e.name||e.tool||e.toolName||'unknown');
      }
    }
    if(buf.trim()){try{events.push(JSON.parse(buf));}catch{}}
    return {ok:true,httpStatus:status,answer,thinkingChars:thinking.length,totalMs:Date.now()-started,ttfbMs:firstByte,ttftMs:firstText,eventTypes:events.map(e=>e.type),toolNames,events};
  } catch(e){return {ok:false,httpStatus:status,error:e.name==='AbortError'?'timeout':e.message,answer,thinkingChars:thinking.length,totalMs:Date.now()-started,ttfbMs:firstByte,ttftMs:firstText,eventTypes:events.map(x=>x.type),toolNames,events};}
  finally{clearTimeout(timeout);}
}

function compactRun(model, task, run) {
  const resultEvent=[...run.events].reverse().find(e=>e.type==='result')||null;
  const usageEvents=run.events.filter(e=>e.type==='usage');
  const usage=usageEvents.length?usageEvents[usageEvents.length-1]:null;
  const meta=run.events.find(e=>e.type==='meta')||null;
  const judged=task.score(run.answer,run);
  const protocolChecks={
    meta:!!meta, result:!!resultEvent, resultOk:!!(resultEvent&&resultEvent.ok!==false), usage:!!usage,
    assistantDelta:run.eventTypes.includes('assistant_delta'), noUnknownTool:!run.toolNames.includes('unknown'),
  };
  const protocolScore=Object.values(protocolChecks).filter(Boolean).length/Object.keys(protocolChecks).length;
  return {
    model:model.key,providerId:model.providerId,taskId:task.id,category:task.category,
    ok:run.ok,answer:run.answer,error:run.error||null,totalMs:run.totalMs,ttfbMs:run.ttfbMs,ttftMs:run.ttftMs,
    thinkingChars:run.thinkingChars,toolNames:run.toolNames,eventTypes:[...new Set(run.eventTypes)],usage,meta,resultEvent,
    taskScore:judged.score,taskMax:judged.max,scoreDetail:judged.detail||null,protocolScore:round(protocolScore*100),protocolChecks,
  };
}

function summarize(rows) {
  return MODELS.map(m=>{
    const rs=rows.filter(r=>r.model===m.key); const byCat={};
    for(const cat of ['daily','complex','coding','ruyi']){const xs=rs.filter(r=>r.category===cat);byCat[cat]=round(xs.reduce((a,r)=>a+r.taskScore,0)/Math.max(1,xs.reduce((a,r)=>a+r.taskMax,0))*100);}
    const taskPct=rs.reduce((a,r)=>a+r.taskScore,0)/rs.reduce((a,r)=>a+r.taskMax,0)*100;
    const protocol=mean(rs.map(r=>r.protocolScore)); const success=rs.filter(r=>r.ok&&r.resultEvent&&r.resultEvent.ok!==false).length/rs.length*100;
    const usage=rs.map(r=>r.usage).filter(Boolean); const inTok=usage.reduce((a,u)=>a+Number((u.usage&&u.usage.input_tokens)||u.inputTokens||u.input_tokens||0),0); const outTok=usage.reduce((a,u)=>a+Number((u.usage&&u.usage.output_tokens)||u.outputTokens||u.output_tokens||0),0);
    return {model:m.key,providerId:m.providerId,...byCat,taskScore:round(taskPct),protocol:round(protocol),successRate:round(success),medianTTFTms:round(median(rs.map(r=>r.ttftMs).filter(Number.isFinite))),medianTotalMs:round(median(rs.map(r=>r.totalMs).filter(Number.isFinite))),inputTokens:inTok,outputTokens:outTok,overall:round(taskPct*0.85+protocol*0.10+success*0.05)};
  }).sort((a,b)=>b.overall-a.overall);
}

async function main(){
  fs.mkdirSync(FIXTURE_DIR,{recursive:true});fs.mkdirSync(OUT_DIR,{recursive:true});
  fs.writeFileSync(path.join(FIXTURE_DIR,'tool_input.txt'),'RUYI-NONCE-7F3A','utf8');
  fs.writeFileSync(path.join(FIXTURE_DIR,'subagent_numbers.txt'),'7\n11\n23\n31\n44\n','utf8');
  const token=await getToken();const status=await api(token,'/api/status');const original=status.config;
  const rows=[];const startedAt=new Date().toISOString();
  console.log(`Ruyi live benchmark ${RUN_ID}: ${MODELS.length} models x ${SELECTED_TASKS.length} tasks`);
  try{
    for(const model of MODELS){
      console.log(`\n[model] ${model.key}`);await setModel(token,original,model);await sleep(250);
      for(const task of SELECTED_TASKS){
        if(task.prepare)task.prepare(model);
        try{fs.rmSync(path.join(FIXTURE_DIR,'tool_output.txt'),{force:true});}catch{}
        const sid=await createSession(token,`BENCH ${RUN_ID} ${model.key} ${task.id}`);
        process.stdout.write(`  ${task.id} ... `);
        const raw=await runStream(token,sid,task.prompt,task.id==='ruyi_subagent'?360000:240000);
        const row=compactRun(model,task,raw);rows.push(row);
        fs.writeFileSync(path.join(OUT_DIR,`${safeName(model.key)}__${task.id}.json`),JSON.stringify(row,null,2),'utf8');
        if(task.id==='coding_agent_fix')fs.copyFileSync(path.join(FIXTURE_DIR,'agent_case','lib.js'),path.join(OUT_DIR,`${safeName(model.key)}__agent_fix.js`));
        console.log(`${row.taskScore}/${row.taskMax}, ${row.ttftMs??'-'}ms TTFT, ${row.totalMs}ms total${row.error?' ERROR '+row.error:''}`);
        await sleep(300);
      }
    }
  } finally { await restoreConfig(token,original).catch(e=>console.error('CONFIG RESTORE FAILED:',e.message)); }
  const summary=summarize(rows);const report={runId:RUN_ID,startedAt,finishedAt:new Date().toISOString(),base:BASE,root:ROOT,models:MODELS,tasks:SELECTED_TASKS.map(({score,prepare,prompt,...x})=>({...x,promptChars:prompt.length})),summary,rows};
  fs.writeFileSync(path.join(OUT_DIR,'report.json'),JSON.stringify(report,null,2),'utf8');
  fs.writeFileSync(path.join(OUT_DIR,'summary.json'),JSON.stringify(summary,null,2),'utf8');
  console.log('\nSUMMARY');console.table(summary);
  console.log(`\nArtifacts: ${OUT_DIR}`);
}

main().catch(e=>{console.error(e&&e.stack||e);process.exitCode=1;});
