'use strict';
// Opt-in comparison of the actual wire encoders, using synthetic prompts and one harmless local echo tool.
// node dev-harness/probe-provider-loop-cache.js --live [--model claude-sonnet-5-5] [--style anthropic] [--stream] [--count-tokens] [--report FILE]
// Uses configured Yotta/Yotta A credentials in memory. Reports counters only; no request/response text or keys.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : '';
if (!args.includes('--live')) console.log('SKIP: --live authorizes up to twelve synthetic Sonnet requests across three wire protocols.');
else main().catch(error => { console.error('Loop probe failed: ' + (error.code || error.name)); process.exitCode = 1; });

async function main() {
  const srv = require('../ruyi-workbench/app/server.js');
  const config = await srv.readConfig();
  const model = option('--model') || 'claude-sonnet-5-5';
  const nonce = crypto.randomBytes(12).toString('hex');
  const fixture = Array.from({ length: 180 }, (_, i) => `Record ${i}: amber cedar river valley. This is synthetic cache test data only.`).join('\n');
  const tool = { type: 'function', function: { name: 'cache_probe_echo', description: 'Return OK. Harmless synthetic probe with no IO.', parameters: { type: 'object', properties: {}, additionalProperties: false } } };
  const streaming = args.includes('--stream');
  if (option('--style') && !['chat', 'responses', 'anthropic'].includes(option('--style'))) throw Object.assign(new Error(), { code: 'unsupported_style' });
  const report = { schema: 1, createdAt: new Date().toISOString(), model, streaming, syntheticOnly: true, comparisons: [] };
  for (const style of ['chat', 'responses', 'anthropic'].filter(style => !option('--style') || option('--style') === style)) {
    const configured = config.providers.find(p => style === 'anthropic' ? p.apiStyle === 'anthropic' && /^Yotta A/i.test(p.label) : p.label === 'Yotta');
    const run = { style, providerId: configured?.id || '', rows: [], status: 'pending' };
    report.comparisons.push(run);
    try {
      if (!configured?.apiKey) throw Object.assign(new Error(), { code: 'provider_not_configured' });
      const provider = { ...configured, apiStyle: style, model, anthropicThinking: 'off' };
      const wire = srv.PROVIDER_WIRE_PROTOCOLS[style];
      const system = `Loop cache probe ${nonce} ${style}. For RUN_TOOL call cache_probe_echo once with {}. After its result reply only OK. For NEXT_TURN reply only OK without tools.\n${fixture}`;
      const history = [{ role: 'system', content: system }, { role: 'user', content: 'RUN_TOOL\n\nRuntime hint for this turn.' }];
      const request = async (stage, prefix, noCache = false) => {
        const body = wire.encodeMessages({ model, messages: history, instructions: system, stream: streaming, provider, hasTools: true, cacheUserPrefix: prefix });
        wire.applyTools(body, [tool]);
        body[wire.outputTokensField] = 512;
        if (noCache) {
          if (Array.isArray(body.system)) body.system = body.system.map(({ cache_control, ...block }) => block);
          for (const message of body.messages || []) if (Array.isArray(message.content)) message.content = message.content.map(({ cache_control, ...block }) => block);
        }
        let countProbe = null;
        if (args.includes('--count-tokens') && style === 'anthropic') {
          const { max_tokens, stream, ...countBody } = body;
          const counted = await fetch(wire.completionUrl(provider.baseUrl) + '/count_tokens', { method: 'POST', redirect: 'error',
            headers: wire.requestHeaders(provider, { model }), body: JSON.stringify(countBody), signal: AbortSignal.timeout(30000) });
          countProbe = { status: counted.status };
          if (counted.ok) {
            const result = await counted.json();
            countProbe.inputTokens = Number.isFinite(result.input_tokens) ? result.input_tokens : null;
          } else await counted.body?.cancel();
        }
        const started = Date.now();
        let json, decoded;
        if (streaming) {
          const rawUsage = {}; let responseModel = '';
          decoded = await srv.openAiStreamOnce({ chatUrl: wire.completionUrl(provider.baseUrl), headers: wire.requestHeaders(provider, { model }), body,
            protocol: wire, ctrl: { signal: AbortSignal.timeout(90000) }, rawSeqRef: { n: 0 }, touch() {}, markUsage() {},
            onEvent(event) {
              if (event.type !== 'raw_line') return;
              let payload; try { payload = JSON.parse(event.line); } catch { return; }
              responseModel = payload.model || payload.message?.model || payload.response?.model || responseModel;
              const usage = payload.usage || payload.message?.usage || payload.response?.usage;
              for (const [key, value] of Object.entries(usage || {})) if (value != null) rawUsage[key] = value;
            } });
          if (decoded.httpError || decoded.transportError) throw Object.assign(new Error(), { code: 'stream_failed' });
          json = { model: responseModel, usage: rawUsage };
        } else {
          const response = await fetch(wire.completionUrl(provider.baseUrl), { method: 'POST', redirect: 'error',
            headers: wire.requestHeaders(provider, { model }), body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
          if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(), { code: 'http_' + response.status }); }
          json = await response.json();
        }
        if (!json.usage || json.type === 'error') throw Object.assign(new Error(), { code: 'missing_usage' });
        const usage = wire.normalizeUsage(json.usage);
        const total = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
        const read = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? usage.prompt_cache_hit_tokens) || 0;
        const write = Number(usage.cache_creation_input_tokens ?? usage.input_tokens_details?.cache_write_tokens) || 0;
        decoded = decoded || wire.decodeCompletion(json, { requestModel: model });
        if (decoded.failed) throw Object.assign(new Error(), { code: 'provider_response_failed' });
        const row = { stage, usageKeys: Object.keys(json.usage).sort(), ...(countProbe ? { countProbe } : {}), responseModel: String(json.model || ''), elapsedMs: Date.now() - started, inputTotal: total, cacheRead: read, cacheWrite: write,
          rawInputTokens: json.usage.input_tokens ?? null, rawPromptTokens: json.usage.prompt_tokens ?? null,
          rawTotalTokens: json.usage.total_tokens ?? null, rawCachedDetails: json.usage.input_tokens_details?.cached_tokens ?? json.usage.prompt_tokens_details?.cached_tokens ?? null,
          reportedCostUsd: typeof json.usage.cost_usd === 'number' ? json.usage.cost_usd : null,
          uncachedInput: Math.max(0, total - read - write), output: Number(usage.completion_tokens ?? usage.output_tokens) || 0, toolCalls: decoded.toolCalls.length };
        run.rows.push(row);
        console.log(JSON.stringify({ style, ...row }));
        return decoded;
      };
      const first = await request('cold-tool-call', 'RUN_TOOL');
      if (first.toolCalls.length !== 1 || first.toolCalls[0].name !== 'cache_probe_echo') throw Object.assign(new Error(), { code: 'expected_echo_tool_call' });
      history.push({ role: 'assistant', content: first.text || '', ...wire.assistantHistoryFields(first), tool_calls: first.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.rawArgs } })) });
      history.push({ role: 'tool', tool_call_id: first.toolCalls[0].id, content: 'OK' });
      const second = await request('tool-result-followup', 'RUN_TOOL');
      await request('repeat-followup', 'RUN_TOOL');
      if (args.includes('--uncached-control')) await request('same-followup-without-breakpoints', 'RUN_TOOL', true);
      history[1] = { role: 'user', content: 'RUN_TOOL' };
      history.push({ role: 'assistant', content: second.text || '', ...wire.assistantHistoryFields(second) });
      history.push({ role: 'user', content: 'NEXT_TURN\n\nNew runtime hint.' });
      await request('next-user-turn', 'NEXT_TURN');
      run.status = 'completed';
    } catch (error) {
      run.status = 'failed'; run.code = error.code || error.name;
      console.log(JSON.stringify({ style, status: run.status, code: run.code }));
    }
    if (option('--report')) fs.writeFileSync(path.resolve(option('--report')), JSON.stringify(report, null, 2) + '\n');
  }
  if (report.comparisons.some(run => run.status !== 'completed')) process.exitCode = 1;
}
