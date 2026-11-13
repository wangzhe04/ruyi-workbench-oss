'use strict';
// Explicit opt-in live diagnostic. Reads one configured provider through the existing credential vault.
// Sends synthetic text only; never prints credentials, request bodies, URLs or response text.
// node dev-harness/probe-anthropic-cache.js --live [--provider ID] [--model claude-sonnet-5-5] [--report FILE]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const args = process.argv.slice(2);
const option = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : '';
if (!args.includes('--live')) {
  console.log('SKIP: use --live to authorize five synthetic Sonnet requests against a configured Anthropic provider.');
} else {
  main().catch(error => { console.error('Cache probe failed: ' + (error.code || error.name || 'error')); process.exitCode = 1; });
}
async function main() {
  const srv = require('../ruyi-workbench/app/server.js');
  const config = await srv.readConfig();
  const provider = config.providers.find(p => option('--provider') ? p.id === option('--provider') : p.apiStyle === 'anthropic' && /^Yotta A/i.test(p.label));
  if (!provider || provider.apiStyle !== 'anthropic' || !provider.apiKey) throw Object.assign(new Error(), { code: 'configured_anthropic_provider_required' });
  const model = option('--model') || 'claude-sonnet-5-5';
  const wire = srv.PROVIDER_WIRE_PROTOCOLS.anthropic;
  const nonce = crypto.randomBytes(12).toString('hex');
  const fixture = Array.from({ length: 180 }, (_, i) => `Record ${i}: amber cedar river valley. This is synthetic cache test data only.`).join('\n');
  const system = variant => `Cache probe ${nonce} ${variant}. Reply only OK. Do not reason or use tools.\n${fixture}`;
  const rows = [];
  const run = async (label, messages, prefix, uncached = false) => {
    const body = wire.encodeMessages({ model, messages, stream: true, provider: { ...provider, anthropicThinking: 'off' }, cacheUserPrefix: prefix });
    body.max_tokens = 64;
    if (uncached) {
      body.system = body.system.map(block => block.text).join('');
      for (const msg of body.messages) for (const block of msg.content) delete block.cache_control;
    }
    const started = Date.now();
    let u;
    const result = await srv.openAiStreamOnce({ chatUrl: wire.completionUrl(provider.baseUrl), headers: wire.requestHeaders(provider, { model }), body,
      ctrl: { signal: AbortSignal.timeout(90000) }, protocol: wire, onEvent() {}, markUsage: usage => { u = usage; }, touch() {}, rawSeqRef: { n: 0 } });
    if (!u || result.httpError || result.transportError) throw Object.assign(new Error(), { code: 'invalid_usage_response' });
    const row = { label, elapsedMs: Date.now() - started, input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0, stopReason: result.finishReason || '' };
    rows.push(row);
    console.log(JSON.stringify(row));
  };
  const baseline = [{ role: 'system', content: system('baseline') }, { role: 'user', content: 'Reply OK.' }];
  await run('before-cold', baseline, undefined, true);
  await run('before-repeat', baseline, undefined, true);
  const cachedSystem = system('fixed');
  const cached = [{ role: 'system', content: cachedSystem }, { role: 'user', content: 'Reply OK.\n\nRuntime hint for this turn.' }];
  await run('after-cold', cached, 'Reply OK.');
  await run('after-repeat', cached, 'Reply OK.');
  await run('after-next-turn', [{ role: 'system', content: cachedSystem }, { role: 'user', content: 'Reply OK.' },
    { role: 'assistant', content: 'OK' }, { role: 'user', content: 'Again OK.\n\nNew runtime hint.' }], 'Again OK.');
  const report = { schema: 1, createdAt: new Date().toISOString(), providerId: provider.id, model, syntheticOnly: true, rows };
  if (option('--report')) fs.writeFileSync(path.resolve(option('--report')), JSON.stringify(report, null, 2) + '\n');
  if (!(rows[3].cacheRead > 0 && rows[4].cacheRead > 0)) throw Object.assign(new Error(), { code: 'cache_hit_not_observed' });
}
