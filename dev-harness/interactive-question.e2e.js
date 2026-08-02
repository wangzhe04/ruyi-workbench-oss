(async () => {
﻿'use strict';

// End-to-end contract for request_user_input on both engines:
//   Claude native compatibility event -> text user envelope -> confirmed delivery
//   OpenAI-compatible function call -> awaited UI answer -> role:tool result -> continuation
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { getFreePort } = require('./free-port.js');
const { readFrontendSrc } = require('./read-frontend-src.js');
const PROVIDER_PORT = await getFreePort(), WB_PORT = await getFreePort(); // 自内层 IIFE 提升:顶层 fixture 也要用(9642e26 codemod 事故修复)

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-interactive-question-e2e');
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let failures = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };

function kill(child) {
  if (!child || !child.pid) return;
  try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}
function readToken() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; }
}
function requestJson(port, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: body == null ? 'GET' : 'POST', headers: {
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(token ? { 'x-wcw-token': token } : {}),
    } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => {
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    const r = await requestJson(WB_PORT, '/health', null).catch(() => null);
    if (r && r.status === 200) return true;
    await sleep(100);
  }
  return false;
}
function streamAndAnswer(body, token, answerSpec) {
  let answerPromise = null;
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body); const events = []; let buf = '';
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-wcw-token': token,
    } }, res => {
      const consume = line => {
        if (!line.trim()) return;
        let evt; try { evt = JSON.parse(line); } catch { return; }
        events.push(evt);
        if (evt.type === 'ask_user' && !answerPromise) {
          const answerRow = typeof answerSpec === 'string'
            ? { question: evt.questions?.[0]?.question || 'choice', answer: [answerSpec] }
            : {
              questionId: evt.questions?.[0]?.id,
              question: evt.questions?.[0]?.question || 'choice',
              selectedOptionIds: answerSpec?.selectedOptionIds || [],
              otherText: answerSpec?.otherText || '',
              answer: answerSpec?.answer || [],
            };
          const answerText = answerRow.answer?.length ? answerRow.answer.join(', ') : (answerRow.otherText || '');
          answerPromise = requestJson(WB_PORT, '/api/chat/answer', {
            sessionId: body.sessionId || (events.find(e => e.type === 'session') || {}).session?.id,
            questionId: evt.questionId || evt.id,
            answers: [answerRow],
            content: `${evt.questions?.[0]?.question || 'choice'}: ${answerText}`,
          }, token);
        }
      };
      res.on('data', c => {
        buf += c; let nl;
        while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); consume(line); }
      });
      res.on('end', async () => {
        consume(buf);
        const answer = answerPromise ? await answerPromise : null;
        resolve({ events, answer });
      });
    });
    req.on('error', reject); req.write(raw); req.end();
  });
}

function startProvider(captures) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' || req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(req.url === '/health' ? '{"ok":true}' : '{"data":[{"id":"fake-model"}]}');
    }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); captures.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const sse = value => res.write('data: ' + JSON.stringify(value) + '\n\n');
    const hasAnswer = (body.messages || []).some(m => m.role === 'tool' && String(m.content || '').includes('Svelte'));
    if (!hasAnswer) {
      const args = JSON.stringify({ questions: [
        {
          id: 'frameworks', header: 'Framework', question: 'Which frameworks?',
          answerMode: 'multiple', allowOther: true, otherLabel: 'Another framework',
          options: [{ id: 'react', label: 'React', description: 'Large ecosystem' }, { id: 'vue', label: 'Vue', description: 'Progressive framework' }],
        },
        {
          id: 'notes', header: 'Notes', question: 'Anything else?',
          answerMode: 'single', // Invalid choice shape on purpose: normalization must keep the UI answerable.
        },
      ] });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'The project constraints make the framework choice consequential. ' }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_question_1', type: 'function', function: { name: 'request_user_input', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Provider received Vue and Svelte' }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(resolve => server.listen(PROVIDER_PORT, '127.0.0.1', () => resolve(server)));
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, activeProvider: '', engineMode: 'interactive', permissionMode: 'bypass', includeWorkbenchMcp: true,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
  }), 'utf8');
  const captures = [];
  const provider = await startProvider(captures);
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_SCENARIO: 'ask' },
    windowsHide: true,
  });
  wb.stderr.on('data', d => String(d).trim() && console.error('[workbench] ' + String(d).trim()));
  try {
    ok(await waitHealth(), 'workbench starts');
    const token = readToken(); ok(!!token, 'runtime token is available');

    const claude = await streamAndAnswer({ message: 'ask for the framework' }, token, 'React');
    const sessionId = (claude.events.find(e => e.type === 'session') || {}).session?.id;
    const claudeAsk = claude.events.find(e => e.type === 'ask_user');
    ok(!!claudeAsk && Array.isArray(claudeAsk.questions), 'Claude question is emitted to the UI stream');
    ok(claude.answer?.status === 200 && claude.answer?.json?.delivered === true, 'Claude answer endpoint confirms actual delivery');
    ok(claude.events.some(e => e.type === 'question_answer' && e.questionId === claudeAsk.questionId && e.ok === true),
      'Claude emits the answered semantic state before continuing');
    ok(claude.events.filter(e => e.type === 'assistant_delta').map(e => String(e.text || '')).join('').includes('React'), 'Claude continues with the selected answer');
    const meta = claude.events.find(e => e.type === 'meta');
    ok(meta?.args?.includes('--disallowedTools') && meta?.args?.includes('AskUserQuestion'), 'real Claude runs prefer the reliable workbench MCP question tool');
    ok(meta?.args?.some(arg => String(arg).includes('工具批次') && String(arg).includes('分阶段调用')),
      'Claude CLI receives the same independent-batch/dependent-stage tool guidance');
    const stale = await requestJson(WB_PORT, '/api/chat/answer', { sessionId, questionId: claudeAsk.questionId, content: 'duplicate' }, token);
    ok(stale.status === 409, 'a stale duplicate answer is rejected instead of reported as success');

    const switched = await requestJson(WB_PORT, '/api/config', { activeProvider: 'fake' }, token);
    ok(switched.status === 200 && switched.json?.ok, 'switches to OpenAI-compatible Provider');
    const providerTurn = await streamAndAnswer({ sessionId, message: 'ask me which framework to use', cwd: HOME }, token, {
      selectedOptionIds: ['vue'], otherText: 'Svelte', answer: ['Vue', 'Svelte'],
    });
    const providerAsk = providerTurn.events.find(e => e.type === 'ask_user');
    ok(!!providerAsk, 'Provider request_user_input opens the same UI question channel');
    ok(String(providerAsk?.context || '').includes('framework choice consequential'), 'question event carries the assistant background that preceded the options');
    ok(providerAsk?.questions?.[0]?.answerMode === 'multiple' && providerAsk.questions[0].multiSelect === true,
      'question normalization exposes canonical multiple mode and the legacy multiSelect alias');
    ok(providerAsk?.questions?.[0]?.allowOther === true && providerAsk.questions[0].options?.[1]?.id === 'vue'
      && providerAsk.questions[0].options[1].description === 'Progressive framework',
      'question event preserves stable option ids, descriptions, and custom-answer capability');
    ok(providerAsk?.questions?.[1]?.answerMode === 'text',
      'choice modes without options normalize to an answerable text question');
    ok(providerTurn.answer?.status === 200 && providerTurn.answer?.json?.delivered === true, 'Provider answer is confirmed delivered');
    ok(providerTurn.events.some(e => e.type === 'question_answer' && e.ok === true),
      'Provider emits the same answered semantic state');
    ok(captures[0]?.tools?.some(t => t.function?.name === 'request_user_input'), 'Provider receives the request_user_input tool schema');
    const questionSchema = captures[0]?.tools?.find(t => t.function?.name === 'request_user_input')?.function?.parameters;
    const questionProps = questionSchema?.properties?.questions?.items?.properties || {};
    ok(questionProps.answerMode?.enum?.includes('multiple') && questionProps.allowOther?.type === 'boolean'
      && questionProps.options?.items?.properties?.id?.type === 'string',
      'Provider tool schema advertises answerMode, allowOther, and stable option ids');
    const answerToolMessage = captures.flatMap(c => c.messages || []).find(m => m.role === 'tool' && String(m.content || '').includes('Svelte'));
    ok(!!answerToolMessage && String(answerToolMessage.content).includes('"selectedOptionIds":["vue"]')
      && String(answerToolMessage.content).includes('"otherText":"Svelte"'),
      'Provider continuation receives structured selections plus the typed custom answer');
    ok(providerTurn.events.some(e => e.type === 'assistant_delta' && String(e.text).includes('Provider received Vue and Svelte')), 'Provider continues after the mixed option/custom answer');

    const app = readFrontendSrc();
    ok(app.includes("turn.answeredQuestions?.has(String(evt.questionId || evt.id || ''))"), 'active-turn replay skips already answered questions');
    ok(app.includes('b.dataset.sessionId === sid && b.dataset.questionId === qid'), 'duplicate question events reuse the open modal without auto-cancelling it');
    ok(app.includes("if (evt?.type === 'ask_user') showAskUserModal"), 'a background-session question is surfaced immediately instead of waiting for chat remount');
    ok(app.includes("if (!r?.ok || !r.delivered) throw new Error('answer was not delivered')"), 'UI closes the modal only after delivery acknowledgement');
    ok(app.includes("selectedOptionIds: selected.map(option => option.id)") && app.includes("otherText: text"),
      'UI sends stable selected ids and a separate custom-answer field');
    ok(app.includes("q.allowOther !== false") && app.includes("ask-option-description"),
      'UI renders an Other input alongside option descriptions');
    ok(app.includes("el('section', 'ask-context')") && app.includes('evt.context'), 'classic question UI renders the carried background context');
    ok(app.includes("if (!options.length && mode !== 'text') mode = 'text'")
      && app.includes("const otherComplete = !state.otherInput?.checked || otherReady"),
      'UI keeps malformed empty-choice questions answerable and requires selected custom answers to contain text');
    ok(!app.includes("if (!multi && oi === 0) inp.checked = true"), 'single-choice questions no longer silently preselect the first option');
  } finally {
    kill(wb); await new Promise(resolve => provider.close(resolve));
    await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nINTERACTIVE QUESTION E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
