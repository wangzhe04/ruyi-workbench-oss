#!/usr/bin/env node
'use strict';

// 手工运行的真实 provider 兼容性/质量矩阵（不纳入 run-all）。不打印 API key，
// 只输出端点状态码、请求字段名、摘要质量和耗时。

const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL_HOME = process.env.WIN_CLAUDE_WORKBENCH_HOME || path.join(os.homedir(), '.win-claude-workbench');
process.env.WIN_CLAUDE_WORKBENCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-provider-matrix-'));
const srv = require(path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js'));
const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const prefix = '--' + name + '=';
  const found = args.find(value => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};

const CASES = [
  { provider: 'openai-compatible', model: 'qwen3.8-flash' },
  { provider: 'glm', model: 'glm-5.3-flash' },
  { provider: 'openai-compatible-2', model: 'mimo-v2.5' },
  { provider: 'openai-compatible-4', model: 'gemma4:e2b-it-qat' },
];
const only = String(arg('only', '')).split(',').map(value => value.trim()).filter(Boolean);
const RUN_CASES = only.length ? CASES.filter(item => only.includes(item.provider) || only.includes(item.model)) : CASES;
const entityCheck = String(arg('entity-check', 'false')).trim().toLowerCase() === 'true';
const FACTS = [
  'PINEAPPLE-42', 'E:\\project\\billing\\invoice.js', '方案B', '修复登录页超时',
  '17 个', '张伟', '2026-08-01', 'PostgreSQL 15', 'token 有效期 2 小时', '不要再动 config.yaml',
];
const factText = [
  '本次任务的暗号是 PINEAPPLE-42，后面问你时要能答出来。',
  '问题出在 E:\\project\\billing\\invoice.js 这个文件。',
  '结论：在方案A和方案B之间，我们最终决定采用方案B（异步队列），放弃方案A。',
  '待办清单第一项：修复登录页超时（用户反馈超过 30 秒）。',
  '扫描完成：一共发现 17 个未处理的异常分支。',
  '接口对接人是张伟，有问题找他确认字段口径。',
  '已确认：上线窗口定在 2026-08-01，不能推迟。',
  '生产库是 PostgreSQL 15，不要用 MySQL 的语法。',
  '查证结果：他们的 access token 有效期 2 小时，过期要重新走刷新流程。',
  '约束：不要再动 config.yaml，上次改坏过一次。',
];
function buildHistory() {
  const h = [{ role: 'user', content: '我们的目标：为账单系统做一次稳定性整改。' }];
  const filler = i => (`第 ${i} 轮讨论：关于缓存、重试、日志与监控的常规展开，` .repeat(30));
  factText.forEach((text, i) => {
    h.push({ role: 'user', content: filler(i) });
    h.push({ role: 'assistant', content: filler(i + 100) });
    h.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: text });
    h.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: '好的，记下了。' });
  });
  h.push({ role: 'user', content: '先到这里，后面继续。' });
  return h;
}
function safeError(value) {
  return String(value || '').replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]').slice(0, 260);
}
function score(summary) {
  const text = String(summary || '');
  return {
    structured: srv.validateStructuredSummary(text),
    hitValues: FACTS.filter(value => text.includes(value.trim())).map(value => value.trim()),
    missValues: FACTS.filter(value => !text.includes(value.trim())).map(value => value.trim()),
    hits: FACTS.filter(value => text.includes(value.trim())).length,
    total: FACTS.length,
  };
}
function pathOf(value) {
  try { return new URL(String(value)).pathname; } catch { return String(value).split('?')[0].slice(0, 120); }
}

(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(REAL_HOME, 'config.json'), 'utf8'));
  const history = buildHistory();
  const estimatedTokens = srv.estimateHistoryTokens(history);
  const rows = [];
  console.log(JSON.stringify({ event: 'matrix_start', estimatedTokens, historyMessages: history.length, entityCheck, cases: RUN_CASES }));
  for (const item of RUN_CASES) {
    const raw = (cfg.providers || []).find(row => row && row.id === item.provider);
    if (!raw) {
      const row = { provider: item.provider, model: item.model, skipped: true, error: 'provider not configured' };
      rows.push(row); console.log(JSON.stringify({ event: 'case_done', ...row }));
      continue;
    }
    const provider = { ...raw, model: item.model };
    if (!provider.baseUrl || (!provider.apiKey && !/^https?:\/\/localhost|127\.0\.0\.1/.test(String(provider.baseUrl)))) {
      const row = { provider: item.provider, model: item.model, skipped: true, error: 'provider has no usable baseUrl/apiKey' };
      rows.push(row); console.log(JSON.stringify({ event: 'case_done', ...row }));
      continue;
    }
    const nativeFetch = global.fetch;
    let calls = 0, inFlight = 0, peak = 0;
    const requests = [];
    global.fetch = async (...fetchArgs) => {
      calls++; inFlight++; peak = Math.max(peak, inFlight);
      let keys = [];
      try { if (fetchArgs[1] && typeof fetchArgs[1].body === 'string') keys = Object.keys(JSON.parse(fetchArgs[1].body)).sort(); } catch { /* observer only */ }
      const entry = { path: pathOf(fetchArgs[0]), keys };
      try {
        const response = await nativeFetch(...fetchArgs);
        entry.status = response.status;
        if (response.ok && response.clone) {
          try {
            const raw = await response.clone().text();
            const body = JSON.parse(raw);
            const content = body?.choices?.[0]?.message?.content
              || body?.output?.map?.(item => item?.content?.map?.(part => part?.text || '').join('') || '').join('')
              || '';
            if (content) entry.responsePreview = String(content).slice(0, 1200);
          } catch { /* observer only */ }
        }
        requests.push(entry);
        return response;
      } catch (error) {
        entry.error = safeError(error && error.message || error);
        requests.push(entry);
        throw error;
      } finally { inFlight--; }
    };
    console.log(JSON.stringify({ event: 'case_start', provider: item.provider, model: item.model, apiStyle: provider.apiStyle || 'chat' }));
    const started = Date.now();
    let result;
    try {
      result = await srv.providerSummaryCall(provider, history, {
        config: {
          runtimeSummarySingleShotV1: true,
          runtimeSummaryFactTableV1: true,
          runtimeSummaryRefineV1: false,
          runtimeSummaryEntityCheckV1: entityCheck,
        },
      });
    } catch (error) {
      result = { ok: false, error: safeError(error && error.message || error) };
    } finally { global.fetch = nativeFetch; }
    const quality = score(result && result.summary);
    const row = {
      provider: item.provider,
      model: item.model,
      apiStyle: provider.apiStyle || 'chat',
      ok: !!(result && result.ok),
      error: result && !result.ok ? safeError(result.error) : '',
      wallMs: Date.now() - started,
      calls,
      peakInFlight: peak,
      requests,
      quality,
      summaryChars: result && result.summary ? result.summary.length : 0,
      summaryPreview: result && result.summary ? String(result.summary).slice(0, 1600) : '',
      mapReduce: result && result.mapReduce || null,
      summaryPolicy: result && result.summaryPolicy || null,
    };
    rows.push(row);
    console.log(JSON.stringify({ event: 'case_done', ...row }));
  }
  const passed = rows.filter(row => !row.skipped && row.ok && row.quality && row.quality.structured && row.quality.hits >= 8).length;
  console.log(JSON.stringify({ event: 'matrix_done', passed, total: rows.filter(row => !row.skipped).length, rows }));
})().catch(error => { console.error(safeError(error && error.stack || error)); process.exitCode = 1; });
