'use strict';

// End-to-end contract for request_user_input on both engines:
//   Claude native compatibility event -> text user envelope -> confirmed delivery
//   OpenAI-compatible function call -> awaited UI answer -> role:tool result -> continuation
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-interactive-question-e2e');
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const PROVIDER_PORT = 9130;
const WB_PORT = 9131;
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
function streamAndAnswer(body, token, answerLabel) {
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
          answerPromise = requestJson(WB_PORT, '/api/chat/answer', {
            sessionId: body.sessionId || (events.find(e => e.type === 'session') || {}).session?.id,
            questionId: evt.questionId || evt.id,
            answers: [{ question: evt.questions?.[0]?.question || 'choice', answer: [answerLabel] }],
            content: `${evt.questions?.[0]?.question || 'choice'}: ${answerLabel}`,
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
    const hasAnswer = (body.messages || []).some(m => m.role === 'tool' && String(m.content || '').includes('Vue'));
    if (!hasAnswer) {
      const args = JSON.stringify({ questions: [{ header: 'Framework', question: 'Which framework?', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: false }] });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_question_1', type: 'function', function: { name: 'request_user_input', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Provider received Vue' }, finish_reason: null }] });
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
    ok(claude.events.filter(e => e.type === 'assistant_delta').map(e => String(e.text || '')).join('').includes('React'), 'Claude continues with the selected answer');
    const meta = claude.events.find(e => e.type === 'meta');
    ok(meta?.args?.includes('--disallowedTools') && meta?.args?.includes('AskUserQuestion'), 'real Claude runs prefer the reliable workbench MCP question tool');
    const stale = await requestJson(WB_PORT, '/api/chat/answer', { sessionId, questionId: claudeAsk.questionId, content: 'duplicate' }, token);
    ok(stale.status === 409, 'a stale duplicate answer is rejected instead of reported as success');

    const switched = await requestJson(WB_PORT, '/api/config', { activeProvider: 'fake' }, token);
    ok(switched.status === 200 && switched.json?.ok, 'switches to OpenAI-compatible Provider');
    const providerTurn = await streamAndAnswer({ sessionId, message: 'ask me which framework to use', cwd: HOME }, token, 'Vue');
    ok(!!providerTurn.events.find(e => e.type === 'ask_user'), 'Provider request_user_input opens the same UI question channel');
    ok(providerTurn.answer?.status === 200 && providerTurn.answer?.json?.delivered === true, 'Provider answer is confirmed delivered');
    ok(captures[0]?.tools?.some(t => t.function?.name === 'request_user_input'), 'Provider receives the request_user_input tool schema');
    ok(captures.some(c => c.messages?.some(m => m.role === 'tool' && String(m.content || '').includes('Vue'))), 'Provider continuation receives the selected answer as a tool result');
    ok(providerTurn.events.some(e => e.type === 'assistant_delta' && String(e.text).includes('Provider received Vue')), 'Provider continues after the user selection');

    const app = fs.readFileSync(path.join(WB, 'app', 'public', 'app.js'), 'utf8');
    ok(app.includes("turn.answeredQuestions?.has(String(evt.questionId || evt.id || ''))"), 'active-turn replay skips already answered questions');
    ok(app.includes('b.dataset.sessionId === sid && b.dataset.questionId === qid'), 'duplicate question events reuse the open modal without auto-cancelling it');
    ok(app.includes("if (evt?.type === 'ask_user') showAskUserModal"), 'a background-session question is surfaced immediately instead of waiting for chat remount');
    ok(app.includes("if (!r?.ok || !r.delivered) throw new Error('answer was not delivered')"), 'UI closes the modal only after delivery acknowledgement');
  } finally {
    kill(wb); await new Promise(resolve => provider.close(resolve));
    await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nINTERACTIVE QUESTION E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
