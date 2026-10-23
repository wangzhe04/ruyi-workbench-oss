'use strict';
// Opt-in synthetic browser proof. Never connects to an existing user instance or a real model.
require('../lib/self-isolate-home');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createRunner } = require('../lib/harness');
const { startBrowserFixture } = require('../lib/browser-fixture');
const { createCorpus, createMixedCorpus } = require('./synthetic-catalog-corpus');
const REPO = path.resolve(__dirname, '../..');
const outputArgument = process.argv.slice(2).find(arg => arg.startsWith('--output='));
const ARCHIVE = outputArgument ? path.resolve(REPO, outputArgument.slice('--output='.length)) : path.join(REPO, 'ruyi-workbench/dist/privacy31-20261020-ux/validation');
const SERVER = path.join(REPO, 'ruyi-workbench/app/server.js');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHash = hash(SERVER), scriptHash = hash(__filename);
const runner = createRunner('PRIVACY BROWSER INPUT VALIDATION');
const report = { sourceHash, scriptHash, startedAt: new Date().toISOString(), groups: [], checks: [], failures: [], providerRequests: 0, domSends: 0 };
function check(condition, label) { runner.ok(condition, label); report.checks.push({ label, passed: !!condition }); if (!condition) report.failures.push(label); }
const TOKEN = /\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(work, name, limit = 45000) { const end = Date.now() + limit; do { if (await work()) return; await sleep(40); } while (Date.now() < end); throw Error('timeout_' + name); }
// Independent, reviewed tier contract. Do not derive expected secrecy from detector output.
const CATALOG_COUNT = 45;
const BASIC = new Set(['credential.gitlab','credential.npm','credential.pypi','credential.huggingface','credential.google-api','credential.google-oauth','credential.stripe','credential.sendgrid','credential.slack-webhook','credential.discord-webhook','credential.teams-webhook','credential.aws-temporary-id','credential.azure-sas','credential.signed-query','credential.redis-auth','credential.sql-password','credential.xml-secret','credential.docker-auth','credential.ssh-password','credential.otp','credential.recovery-code','credential.wallet-private','credential.integration-secret','personal.payment-security']);
const PERSONAL = new Set(['personal.cn-landline','personal.international-phone','personal.passport-labelled','personal.social-security','personal.driver-license','personal.tax-id','personal.bank-account','personal.birth-date','personal.contact-name','personal.address','personal.health-record','personal.diagnosis','personal.payment-expiry','personal.vehicle','personal.work-identifier','personal.profile-url']);
const TECHNICAL = new Set(['technical.ipv4','technical.mac','technical.windows-user-path','technical.posix-user-path']);
const CONFIDENTIAL = new Set(['internal.classified-line']);
function corpus() {
  const rows = createCorpus('browser-input-proof-v2').map(row => ({ ...row, tier: BASIC.has(row.id) ? 'basic' : PERSONAL.has(row.id) ? 'personal' : TECHNICAL.has(row.id) ? 'technical' : CONFIDENTIAL.has(row.id) ? 'confidential' : null }));
  if (rows.some(row => !row.tier) || rows.length !== CATALOG_COUNT) throw Error('static_catalog_contract_drift');
  const otp = rows.find(row => row.id === 'credential.otp');
  const otpValue = ['864297','975286','842976'].find(value => rows.every(row=>row===otp || !row.secret.includes(value)));
  if(!otpValue) throw Error('synthetic_otp_collision'); otp.secret=otpValue; otp.sample='验证码：'+otpValue;
  // Short secrets are checked inside exact case blocks, never against random PVT IDs or other rows.
  const cvv = rows.find(row => row.id === 'personal.payment-security');
  const short = ['987', '964', '983', '972', '953'].find(value => rows.every(row => row === cvv || !row.secret.includes(value)));
  if (!short) throw Error('synthetic_short_value_collision'); cvv.secret = short; cvv.sample = 'CVV: ' + short;
  const prefix = '11010120000101001', weights = [7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2];
  const valid = prefix + '10X98765432'[weights.reduce((sum, n, i) => sum + n * Number(prefix[i]), 0) % 11];
  const wrong = valid.slice(0, -1) + (valid.endsWith('0') ? '1' : '0');
  const extra = (id, sample, secret, tier) => rows.push({ id, sample, secret, tier });
  extra('adversary.identity-checksum', '身份证号码：' + wrong, wrong, 'personal');
  const full = wrong.replace(/[0-9]/g, n => String.fromCharCode(n.charCodeAt(0) + 0xfee0));
  extra('adversary.identity-fullwidth', '我的身份证号是' + full, full, 'personal');
  extra('adversary.identity-old15', '居民身份证号：110101000101001', '110101000101001', 'personal');
  const grouped = wrong.slice(0,6) + ' ' + wrong.slice(6,14) + ' ' + wrong.slice(14);
  extra('adversary.identity-grouped', '身份证号为' + grouped, grouped, 'personal');
  extra('adversary.chinese-key', 'API密钥：SYNTHETIC-CHINESE-KEY-ONLY', 'SYNTHETIC-CHINESE-KEY-ONLY', 'basic');
  extra('adversary.chinese-key-field', '{"API密钥":"SYNTHETIC-CHINESE-FIELD-ONLY"}', 'SYNTHETIC-CHINESE-FIELD-ONLY', 'basic');
  extra('adversary.mobile-grouped', '手机号：138 0013 8000', '138 0013 8000', 'personal');
  extra('adversary.name-is', '姓名是合成示例甲', '合成示例甲', 'personal');
  extra('adversary.name-as', '联系人为合成示例乙', '合成示例乙', 'personal');
  return rows;
}
function expected(row, mode, technical) { return mode !== 'off' && (row.tier === 'basic' || row.tier === 'personal' && ['enhanced','strict'].includes(mode) || row.tier === 'technical' && technical || row.tier === 'confidential' && mode === 'strict'); }
function containsOriginal(text, secret) {
  return secret.length >= 8 ? text.includes(secret) : new RegExp('(?<![A-Za-z0-9])' + secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])').test(text);
}
function textContent(value) { if (typeof value === 'string') return value; if (Array.isArray(value)) return value.map(row => typeof row === 'string' ? row : row.text || '').join('\n'); return ''; }
function textViews(value, depth=0, out=[]) {
  if(depth>12)return out;
  if(typeof value==='string'){out.push(value);if(/^\s*[\[{\"]/.test(value)){try{textViews(JSON.parse(value),depth+1,out);}catch{}}}
  else if(value && typeof value==='object')for(const [key,row] of Object.entries(value)){out.push(key);textViews(row,depth+1,out);}
  return out;
}
function shape(text) { return { length: text.length, begins: (text.match(/CASE_\d+_BEGIN/g)||[]).length, ends: (text.match(/CASE_\d+_END/g)||[]).length, finalBoundary: /BROWSER_INPUT_END_/.test(text) }; }
let fx, active = null, livePolicy={mode:'off',technical:false}; const errors = [], observations = [], seenRefs=new Set();
const TOOL_EMAIL = 'synthetic-tool-contact@example.test';
const mixedCorpus = createMixedCorpus();
const second = require('./second-scenario-corpus').createSecondCorpus();
const secondCorpus = { cases: [...second.cases, ...second.negatives.map((sample, index) => ({ id: 'public-' + index, tier: 'public', sample, secret: sample })),
  ...second.technical.map((sample, index) => ({ id: 'technical-second-' + index, tier: 'technical', sample, secret: sample }))] };
secondCorpus.prose = secondCorpus.cases.map(row => row.sample).join('\n') + '\nPUBLIC count=200 request_id=99887766';
const third = require('./third-scenario-corpus').createThirdCorpus();
const thirdCorpus = { cases: [...third.cases, ...third.negatives.map((sample, index) => ({ id: 'third-public-' + index, tier: 'public', sample, secret: sample })),
  ...third.technical.map((sample, index) => ({ id: 'third-technical-' + index, tier: 'technical', sample, secret: sample }))] };
thirdCorpus.prose = thirdCorpus.cases.map(row => row.sample).join('\n') + '\nPUBLIC count=200 request_id=99887766';
async function main() {
 try {
  if (process.platform !== 'win32') throw Error('Windows_DPAPI_required_for_this_opt_in_proof');
  fs.mkdirSync(ARCHIVE, { recursive: true });
  const rows = corpus();
  check(mixedCorpus.cases.every(row=>(row.secrets||[row.secret]).every(secret=>(mixedCorpus.prose||mixedCorpus.sample).includes(secret))), 'every independent mixed entity is actually present in the natural input fixture');
  fx = await startBrowserFixture({ prefix: 'ruyi-browser-input-proof-', ok: check,
    config: { stewardEnabledV1: false, schedulerEnabledV1: false, importAgentInstructions: false, permissionMode: 'acceptEdits', toolLoadingMode: 'full', bridgeExternalToolsToProvider: false, runtimeOptimizationShadowV1: false, contextAutoCompactEnabled: false, memoryAutoProposeEnabled: false, missionAutoContinue: false },
    prepare: async ({ work }) => {
      fs.writeFileSync(path.join(work, 'browser-source.json'), JSON.stringify({ email: TOOL_EMAIL, password: 'SYNTHETIC-TOOL-PASSWORD-ONLY' }));
      fs.writeFileSync(path.join(work, 'browser-mixed-source.txt'), (mixedCorpus.prose || mixedCorpus.sample) + '\nBrowser tool contact: ' + TOOL_EMAIL);
      fs.writeFileSync(path.join(work, 'browser-second-source.txt'), secondCorpus.prose + '\nBrowser tool contact: ' + TOOL_EMAIL);
      fs.writeFileSync(path.join(work, 'browser-third-source.txt'), thirdCorpus.prose + '\nBrowser tool contact: ' + TOOL_EMAIL);
    },
    provider: ctx => {
      try {
        report.providerRequests++;
        const bodyViews=textViews(ctx.body).map(value=>value.replace(TOKEN,''));
        const leaked=[...rows,...mixedCorpus.cases,...secondCorpus.cases,...thirdCorpus.cases].filter(row=>expected(row,livePolicy.mode,livePolicy.technical)).find(row=>(row.secrets||[row.secret]).some(secret=>bodyViews.some(value=>containsOriginal(value,secret))));
        check(!leaked, 'wire '+report.providerRequests+': complete recursively decoded body, including all roles and tool returns, contains no protected originals'+(leaked?' ['+leaked.id+']':''));
        const user = ctx.messages.filter(row => row.role === 'user').map(row => textContent(row.content)).findLast(value => value.includes('BROWSER_INPUT_BEGIN_')) || '';
        const label = user.match(/BROWSER_INPUT_BEGIN_([a-z-]+)/)?.[1];
        const policy = {...livePolicy};
        const refs=user.match(TOKEN)||[];
        if (label) observations.push({ label, policy, stream:ctx.body.stream === true, user, priorReferences:refs.every(ref=>seenRefs.has(ref)), wireShape:ctx.messages.map(row => ({role:row.role,...shape(textContent(row.content))})) });
        for(const ref of refs) seenRefs.add(ref);
        // Title/brief requests contain intentionally clipped user input. They must neither finish
        // the real turn nor overwrite its full wire body; they are audited separately below.
        if (ctx.body.stream !== true) { ctx.text('Synthetic browser validation title'); ctx.stop(); return; }
        if (!active || !user.includes('BROWSER_INPUT_BEGIN_' + active.label)) { ctx.text('fixture auxiliary response'); ctx.stop(); return; }
        active.requests.push(structuredClone(ctx.body)); active.fullUser = user;
        const start=user.lastIndexOf('BROWSER_INPUT_BEGIN_'+active.label), stop=user.indexOf('BROWSER_INPUT_END_'+active.label,start);
        active.user=start<0||stop<0?'':user.slice(start,stop+('BROWSER_INPUT_END_'+active.label).length);
        active.wireShape = ctx.messages.map(row => ({role: row.role, ...shape(textContent(row.content))}));
        if (active.toolLoop && active.requests.length === 1) { ctx.toolCall('file_read', { path: active.third ? 'browser-third-source.txt' : active.second ? 'browser-second-source.txt' : active.mixed ? 'browser-mixed-source.txt' : 'browser-source.json' }); return; }
        if (active.toolLoop && active.requests.length === 2) {
          const output = textContent(ctx.messages.filter(row => row.role === 'tool').at(-1)?.content);
          const references = [...output.matchAll(/\[\[RUYI_PVT:EMAIL:[a-f0-9]{32}\]\]/g)];
          const reference = (active.mixed ? references.at(-1) : references[0])?.[0];
          active.toolReference = reference || ''; active.toolOutput = output;
          ctx.toolCall('file_write', { path: 'browser-restored.txt', content: 'Browser contact: ' + (reference || 'MISSING_REFERENCE') }); return;
        }
        const steward = (ctx.body.tools || []).some(tool => (tool.function?.name || tool.name || '').startsWith('steward_'));
        ctx.text(steward ? JSON.stringify({ say: 'BROWSER_INPUT_ACCEPTED', why: 'synthetic fixture', acts: [], actions: [] }) : 'BROWSER_INPUT_ACCEPTED'); ctx.stop(); active.done = true;
      } catch (error) { errors.push(String(error.stack || error)); ctx.text('fixture failed'); ctx.stop(); }
    } });
  await fx.setLens('classic');
  const settings = await fx.request('GET', '/api/privacy/settings');
  check(settings.json.catalog.length === CATALOG_COUNT && settings.json.catalog.every(rule => rows.some(row => row.id === rule.id)), 'static 45-rule tier table covers the actual executable catalog');
  async function sendGroup(mode, technical, steward = false, draft = false) {
    const label = (steward ? 'steward-' : '') + mode + '-' + String(technical);
    const encryption = mode !== 'off' || (await fx.request('GET','/api/privacy/settings')).json.encryption === true;
    const changed = await fx.request('POST','/api/privacy/settings',{ mode, technical, rules: [], encryption });
    if (changed.status !== 200) throw Error('settings_setup_' + label);
    livePolicy={mode,technical};
    if (!steward) {
      const previous = await fx.evaluate('window.state.currentSession?.id || ""');
      await fx.evaluate('document.querySelector("#newSessionBtn").click();true');
      if (!await fx.waitForEval(`window.state.currentSession?.id && window.state.currentSession.id!==${JSON.stringify(previous)} && !window.state.streaming ? 1 : null`)) throw Error('new_session_' + label);
    }
    if (draft) {
      await fx.evaluate('document.querySelector("#openSettingsBtn").click();document.querySelector("[data-stab=security]").click();true');
      if (!await fx.waitForEval('!document.querySelector("#privacyLevel-strict").disabled ? 1 : null')) throw Error('draft_load');
      await fx.evaluate('document.querySelector("#privacyLevel-strict").click();document.querySelector("#settingsModal [data-close-modal]").click();true');
      check((await fx.request('GET','/api/privacy/settings')).json.mode === mode, label + ': selecting an unsaved strict draft does not change the saved off policy');
    }
    const sentinel = 'BROWSER_INPUT_BEGIN_' + label;
    const prompt = sentinel + '\nPUBLIC_NEIGHBOR_VISIBLE\n' + rows.map((row,i) => 'CASE_' + i + '_BEGIN\n' + row.sample + '\nCASE_' + i + '_END').join('\n') + '\nBROWSER_INPUT_END_' + label;
    active = { label, mode, technical, steward, toolLoop: !steward && mode === 'enhanced' && !technical, requests: [], done: false };
    const group = active;
    const input = steward ? '#stewardComposerInput' : '#promptInput', send = steward ? '#stewardComposerSend' : '#sendBtn';
    if (!await fx.waitForEval(`document.querySelector(${JSON.stringify(input)}) && !document.querySelector(${JSON.stringify(input)}).disabled ? 1 : null`)) throw Error('input_ready_' + label);
    group.domShape = await fx.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(input)});input.value=${JSON.stringify(prompt)};input.dispatchEvent(new Event('input',{bubbles:true}));const value=input.value;const send=document.querySelector(${JSON.stringify(send)});if(!send || send.disabled)throw Error('send_not_ready');send.click();return {length:value.length,begins:(value.match(/CASE_\\d+_BEGIN/g)||[]).length,ends:(value.match(/CASE_\\d+_END/g)||[]).length};})()`); report.domSends++;
    await until(() => group.done, 'provider_' + label, 90000);
    if (!steward) { if (!await fx.waitForEval('!window.state.streaming ? 1 : null')) throw Error('stream_settle_' + label); }
    await until(async () => { const sid = steward ? 'steward' : await fx.evaluate('window.state.currentSession.id'); const state = await fx.request('GET','/api/sessions/'+sid); return state.json && state.json.execution === null; },'turn_settle_'+label);
    check(group.requests.length >= 1 && group.user.includes('PUBLIC_NEIGHBOR_VISIBLE'), label + ': real DOM send reaches provider with adjacent public text intact');
    check(group.domShape.begins === rows.length && group.domShape.ends === rows.length && shape(group.user).ends === rows.length && shape(group.user).finalBoundary, label + ': complete DOM corpus and final boundary survive the actual streaming wire');
    for (const [i,row] of rows.entries()) {
      const begin = 'CASE_' + i + '_BEGIN\n', end = '\nCASE_' + i + '_END', at = group.user.indexOf(begin), close = group.user.indexOf(end, at + begin.length);
      const block = at < 0 || close < 0 ? '' : group.user.slice(at + begin.length, close);
      const conceal = expected(row,mode,technical), visible = block.replace(TOKEN,'');
      check(!!block && (conceal ? !visible.includes(row.secret) && /\[\[RUYI_PVT:/.test(block) : block.includes(row.secret)), label + ': ' + row.id + (conceal ? ' concealed' : ' remains visible'));
    }
    if (mode === 'off') check(!/\[\[RUYI_PVT:/.test(group.user), label + ': off mode has no substitutions despite the current draft');
    if (group.toolLoop) {
      check(!!group.toolReference && !group.toolOutput.includes(TOOL_EMAIL) && !group.toolOutput.includes('SYNTHETIC-TOOL-PASSWORD-ONLY'), label + ': actual file-read tool returns opaque references');
      check(fs.readFileSync(path.join(fx.work,'browser-restored.txt'),'utf8') === 'Browser contact: ' + TOOL_EMAIL, label + ': model reference arguments restore exactly before real file-write');
    }
    report.groups.push({ label, mode, technical, steward, catalogCases: CATALOG_COUNT, adversarialCases: rows.length-CATALOG_COUNT, providerRequests: group.requests.length, toolLoop: group.toolLoop, domShape:group.domShape, selectedWireShape:shape(group.user), wireShape:group.wireShape }); active = null;
  }
  for (const mode of ['off','basic','enhanced','strict']) for (const technical of [false,true]) await sendGroup(mode,technical,false,mode==='off' && !technical);
  check(report.groups.length === 8 && report.domSends === 8, 'all eight saved mode/technical combinations executed through input and send controls');
  await fx.request('POST','/api/config',{stewardEnabledV1:true,stewardPollMs:120000});
  await fx.cdp.send('Page.reload');
  if (!await fx.waitForEval('window.state?.config?.stewardEnabledV1 && document.querySelector("#lensSeg [data-lens=steward]") ? 1 : null')) throw Error('steward_reload');
  await fx.setLens('steward'); await sendGroup('enhanced',false,true);
  check(report.domSends === 9 && report.groups.at(-1).steward, 'steward composer also sends the synthetic corpus through its actual button');
  await fx.setLens('classic');
  report.mixedGroups = [];
  report.secondGroups = [];
  report.thirdGroups = [];
  for (const [kind, selectedCorpus] of [['mixed', mixedCorpus], ['second', secondCorpus], ['third', thirdCorpus]]) {
  for (const technical of [false, true]) {
    const label = kind + '-enhanced-' + String(technical), mode = 'enhanced';
    const changed = await fx.request('POST','/api/privacy/settings',{mode,technical,rules:[],encryption:true});
    if (changed.status !== 200) throw Error('mixed_settings'); livePolicy={mode,technical};
    const prior=await fx.evaluate('window.state.currentSession?.id || ""');
    await fx.evaluate('document.querySelector("#newSessionBtn").click();true');
    if(!await fx.waitForEval(`window.state.currentSession?.id && window.state.currentSession.id!==${JSON.stringify(prior)} && !window.state.streaming ? 1 : null`))throw Error('mixed_session');
    const prompt='BROWSER_INPUT_BEGIN_'+label+'\n'+(selectedCorpus.prose||selectedCorpus.sample)+'\nBROWSER_INPUT_END_'+label;
    const group=active={label,mode,technical,mixed:true,second:kind==='second',third:kind==='third',toolLoop:true,requests:[],done:false};
    await fx.evaluate(`(() => {const input=document.querySelector('#promptInput');input.value=${JSON.stringify(prompt)};input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#sendBtn').click();return true;})()`); report.domSends++;
    await until(()=>group.done,'mixed_provider_'+label,90000);
    if(!await fx.waitForEval('!window.state.streaming ? 1 : null'))throw Error('mixed_settle');
    await until(async()=>{const sid=await fx.evaluate('window.state.currentSession.id');return(await fx.request('GET','/api/sessions/'+sid)).json?.execution===null;},'mixed_turn_settle');
    const expectedRequests=kind==='mixed'?3:4;
    check(group.requests.length===expectedRequests && group.user.includes('BROWSER_INPUT_END_'+label),label+': whole natural mixed paragraph reaches the actual DOM send and read/write tool loop');
    if(kind!=='mixed')check(group.requests[3].messages.some(row=>row.role==='user' && textContent(row.content).includes('【产物自检】')),label+': fourth request is the existing completion self-check, with no additional tool execution');
    const userVisible=group.user.replace(TOKEN,''),toolViews=textViews(group.toolOutput),toolVisible=toolViews.map(value=>value.replace(TOKEN,''));
    for(const row of selectedCorpus.cases) for(const [index,secret] of (row.secrets||[row.secret]).entries()) {
      const conceal=expected(row,mode,technical);
      check(conceal ? !userVisible.includes(secret) : group.user.includes(secret),label+': '+row.id+'/'+index+' input follows its tier');
      check(conceal ? toolVisible.every(value=>!value.includes(secret)) : toolViews.some(value=>value.includes(secret)),label+': '+row.id+'/'+index+' actual file-read return follows its tier');
    }
    check(fs.readFileSync(path.join(fx.work,'browser-restored.txt'),'utf8')==='Browser contact: '+TOOL_EMAIL,label+': model alias arguments restore before actual file-write');
    check(group.user.includes('count=200') && group.user.includes('request_id=99887766') && toolViews.some(value=>value.includes('count=200')),label+': adjacent public counters and identifiers remain readable');
    report[kind==='mixed'?'mixedGroups':kind==='second'?'secondGroups':'thirdGroups'].push({label,technical,entities:selectedCorpus.cases.reduce((n,row)=>n+(row.secrets||[row.secret]).length,0),providerRequests:group.requests.length});active=null;
  }
  }
  for(const [n,observation] of observations.filter(row=>row.stream).entries()) {
    const visible=observation.user.replace(TOKEN,'');
    check(rows.filter(row=>expected(row,observation.policy.mode,observation.policy.technical)).every(row=>!containsOriginal(visible,row.secret)), 'stream '+n+': every actual main request protects all sensitive values across the full user context');
  }
  for(const [n,observation] of observations.filter(row=>row.label.startsWith('mixed-')).entries()) {
    const visible=observation.user.replace(TOKEN,'');
    check(mixedCorpus.cases.filter(row=>expected(row,observation.policy.mode,observation.policy.technical)).every(row=>(row.secrets||[row.secret]).every(secret=>!containsOriginal(visible,secret))), 'mixed request '+n+': main or auxiliary wire contains no protected originals');
  }
  const auxiliary = observations.filter(row => !row.stream);
  check(auxiliary.length > 0, 'real non-streaming title/brief requests were captured separately');
  for (const [n, observation] of auxiliary.entries()) {
    const {mode,technical}=observation.policy, visible=observation.user.replace(TOKEN,'');
    check(rows.filter(row=>expected(row,mode,technical)).every(row=>!containsOriginal(visible,row.secret)), 'auxiliary '+n+' '+observation.label+': protected original values absent from actual title/brief request');
    if(mode==='off') check(observation.priorReferences,'auxiliary '+n+' '+observation.label+': off emits no newly observed references');
    for(const [i,row] of rows.entries()) {
      const begin='CASE_'+i+'_BEGIN\n',end='\nCASE_'+i+'_END',at=observation.user.indexOf(begin),close=observation.user.indexOf(end,at+begin.length);
      if(at<0||close<0) continue;
      const block=observation.user.slice(at+begin.length,close),conceal=expected(row,mode,technical);
      check(conceal ? !block.replace(TOKEN,'').includes(row.secret)&&/\[\[RUYI_PVT:/.test(block) : block.includes(row.secret)||/\[\[RUYI_PVT:/.test(block)&&observation.priorReferences, 'auxiliary '+n+' '+observation.label+': complete CASE '+i+' follows effective tier or retains prior opaque history');
    }
  }
  report.observations=observations.map(({user,policy,...entry})=>({...entry,mode:policy.mode,technical:policy.technical,selectedWireShape:shape(user)}));
  check(errors.length === 0 && fx.exceptions.length === 0, 'fake provider and browser have no hidden exceptions');
  check(hash(SERVER) === sourceHash && hash(__filename) === scriptHash, 'product source and validation script hashes stayed frozen');
 } catch(error) {
   runner.fail('fatal: ' + String(error.code || error.message || error.name).slice(0,180)); report.failures.push(String(error.code || error.message || error.name));
   report.diagnostics = { active, errors, observations, fixtureRoot:fx?.root };
   if(fx) try { const sid=await fx.evaluate('window.state.currentSession?.id'); report.diagnostics.browserState=await fx.evaluate('({streaming:window.state.streaming,currentSession:window.state.currentSession})');report.diagnostics.session=(await fx.request('GET','/api/sessions/'+sid)).json; } catch(diagnosticError) { report.diagnostics.error=String(diagnosticError); }
 }
 finally {
   if (fx) await fx.close({keepRoot:!!runner.failures});
   report.finishedAt = new Date().toISOString(); report.complete = report.groups.length === 9 && report.mixedGroups?.length === 2 && report.secondGroups?.length === 2 && report.thirdGroups?.length === 2 && !runner.failures; report.checkCount = report.checks.length;
   fs.mkdirSync(ARCHIVE,{recursive:true}); fs.writeFileSync(path.join(ARCHIVE,'browser-input-validation.json'),JSON.stringify(report,null,2)+'\n'); runner.done();
 }
}
main();
