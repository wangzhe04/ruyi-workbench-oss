#!/usr/bin/env node
'use strict';

// 长上下文压力测试（手工运行，不纳入 run-all）：默认生成接近 1M 窗口 80% 的
// 多轮真实形态 history，调用生产 summary kernel，观测 map/reduce 分块、并发、
// 请求体大小、完整性与关键事实保留。API key 只从本机 config 读取，不打印。

const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL_HOME = process.env.WIN_CLAUDE_WORKBENCH_HOME || path.join(os.homedir(), '.win-claude-workbench');
process.env.WIN_CLAUDE_WORKBENCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-long-context-pressure-'));
const srv = require(path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js'));

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const prefix = '--' + name + '=';
  const found = args.find(value => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};
const targetTokens = Math.max(10000, Number(arg('target', '800000')) || 800000);
const contextWindow = Math.max(targetTokens + 20000, Number(arg('context-window', '1000000')) || 1000000);
const concurrencyArg = String(arg('concurrency', 'auto')).trim().toLowerCase();
const concurrency = /^\d+$/.test(concurrencyArg)
  ? Math.min(8, Math.max(1, Math.round(Number(concurrencyArg)))) : null;
const requestedProvider = String(arg('provider', process.env.COMPACT_QUALITY_PROVIDER || 'deepseek')).trim();
const requestedModel = String(arg('model', 'deepseek-v4-flash')).trim();

const FACTS = [
  'LONG-PRESSURE-CODEX-105',
  'C:\\ruyi\\pressure\\checkpoint-105.json',
  'RELEASE=2026.09.02',
  'DECISION=parallel-map-reduce',
  'TASK-LONG-CONTEXT-VERIFY',
  'OWNER=张伟',
];

function buildHistory() {
  const history = [];
  let turn = 0;
  const filler = `本轮讨论围绕缓存一致性、重试退避、日志采样、任务交接和回滚路径展开。`;
  const chunkChars = 10000;
  while (srv.estimateHistoryTokens(history) < targetTokens) {
    const n = ++turn;
    const repeated = (`第 ${n} 轮上下文记录：${filler} `).repeat(Math.ceil(chunkChars / 48)).slice(0, chunkChars);
    // 固定落在可达到的轮次，避免用 targetTokens 推导轮次后在不同估算桶下越界，
    // 使压力测试的事实保留分数真正有意义。
    const marker = n === 8 ? `关键事实：${FACTS[0]}；关键文件 ${FACTS[1]}。` :
      n === 24 ? `版本锚点：${FACTS[2]}；负责人：${FACTS[5]}。` :
      n === 40 ? `未完成事项锚点：${FACTS[4]}。` :
      n === 56 ? `最新决定锚点：${FACTS[3]}。` : '';
    history.push({ role: 'user', content: repeated + marker });
    history.push({ role: 'assistant', content: (`已记录第 ${n} 轮：${filler} `).repeat(Math.ceil(chunkChars / 52)).slice(0, chunkChars) });
  }
  history.push({ role: 'user', content: `收束记录：当前唯一有效决定是 ${FACTS[3]}，${FACTS[4]} 仍未完成；请保留 ${FACTS[0]}、${FACTS[1]}、${FACTS[2]} 与 ${FACTS[5]}。` });
  return history;
}

function score(summary) {
  const text = String(summary || '');
  return {
    structured: srv.validateStructuredSummary(text),
    retained: FACTS.filter(value => text.includes(value)).length,
    total: FACTS.length,
  };
}

(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(REAL_HOME, 'config.json'), 'utf8'));
  const raw = (cfg.providers || []).find(row => row && row.id === requestedProvider);
  if (!raw) throw new Error('provider not found: ' + requestedProvider);
  const provider = { ...raw, model: requestedModel || raw.model, contextWindow };
  if (!provider.apiKey) throw new Error('selected provider has no API key');
  const history = buildHistory();
  const estimated = srv.estimateHistoryTokens(history);
  const nativeFetch = global.fetch;
  let calls = 0, inFlight = 0, peak = 0, requestBytes = 0, maxRequestBytes = 0;
  global.fetch = async (...fetchArgs) => {
    calls++;
    const body = fetchArgs[1] && fetchArgs[1].body;
    const bytes = typeof body === 'string' ? Buffer.byteLength(body) : 0;
    requestBytes += bytes;
    maxRequestBytes = Math.max(maxRequestBytes, bytes);
    inFlight++;
    peak = Math.max(peak, inFlight);
    try { return await nativeFetch(...fetchArgs); }
    finally { inFlight--; }
  };
  const pressureConfig = {
    runtimeSummarySingleShotV1: true,
    runtimeSummaryFactTableV1: true,
    runtimeSummaryRefineV1: false,
    runtimeSummaryEntityCheckV1: false,
    ...(concurrency == null ? {} : { summaryMaxConcurrentV1: concurrency }),
  };
  const effectiveConcurrency = srv.summaryMaxConcurrent(pressureConfig, provider, provider.model);
  console.log(JSON.stringify({ event: 'pressure_start', provider: provider.id, model: provider.model, apiStyle: provider.apiStyle || 'chat', targetTokens, estimatedTokens: estimated, contextWindow, concurrency: effectiveConcurrency, concurrencySource: concurrency == null ? 'model-default' : 'explicit-test-override', historyMessages: history.length }));
  const started = Date.now();
  let result;
  try {
    result = await srv.providerSummaryCall(provider, history, {
      config: pressureConfig,
    });
  } finally {
    global.fetch = nativeFetch;
  }
  const wallMs = Date.now() - started;
  const usage = result && result.usage || {};
  const row = {
    ok: !!(result && result.ok),
    error: result && !result.ok ? String(result.error || '').slice(0, 240) : '',
    wallMs,
    calls,
    peakInFlight: peak,
    requestBytes,
    maxRequestBytes,
    inputTokens: Number(usage.prompt_tokens != null ? usage.prompt_tokens : usage.input_tokens) || 0,
    outputTokens: Number(usage.completion_tokens != null ? usage.completion_tokens : usage.output_tokens) || 0,
    mapReduce: result && result.mapReduce || null,
    score: score(result && result.summary),
    summaryChars: result && result.summary ? result.summary.length : 0,
  };
  console.log(JSON.stringify({ event: 'pressure_done', ...row }));
  if (result && result.ok) console.log(String(result.summary || '').slice(0, 1600));
  if (!row.ok || !row.score.structured) process.exitCode = 1;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
