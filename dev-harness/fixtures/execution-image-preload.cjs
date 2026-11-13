'use strict';
// Owned test service only: bounded post-delivery rendezvous and single IO faults.
const fs = require('node:fs'), path = require('node:path');
const root = process.env.RUYI_IMAGE_TEST_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('isolated image fixture root required');
const ledger = path.join(root, 'data/desktop-executions-v1/state.json');
const control = path.join(root, 'control.json'), marker = path.join(root, 'delivered.json'), release = path.join(root, 'release');
const rename = fs.promises.rename;
let fired = false;
fs.promises.rename = async function(from, to) {
  const config = fs.existsSync(control) ? JSON.parse(fs.readFileSync(control, 'utf8')) : null;
  let hit;
  if (config && !fired) {
    if (['stop', 'steer'].includes(config.kind) && to === ledger) {
      const state = JSON.parse(fs.readFileSync(from, 'utf8'));
      hit = state.entries.find(row => row.toolName === 'fixture_image' && row.deliverySha256 && !config.seen.includes(row.invocationId));
    } else if (['intent_save_fault', 'image_save_fault'].includes(config.kind)
        && path.dirname(to) === path.join(root, 'data/sessions') && to.endsWith('.json')) {
      const head = JSON.parse(fs.readFileSync(from, 'utf8'));
      const provider = path.join(path.dirname(to), head.id + '.provider.ndjson');
      const history = fs.existsSync(provider) ? fs.readFileSync(provider, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      const matches = config.kind === 'intent_save_fault'
        ? history.at(-1)?.role === 'assistant' && history.at(-1).tool_calls?.some(call => call.id === config.callId)
        : history.some(row => row.role === 'tool' && row.tool_call_id === config.callId)
          && history.some(row => row.role === 'user' && Array.isArray(row.content) && row.content.some(part => part.type === 'image_url'));
      if (matches) {
        fired = true;
        fs.writeFileSync(marker, JSON.stringify({ kind: config.kind, sessionId: head.id, history }));
        throw Object.assign(new Error('isolated ' + config.kind), { code: 'EIO' });
      }
    }
  }
  const result = await rename.call(this, from, to);
  if (hit) {
    fired = true;
    fs.writeFileSync(marker, JSON.stringify(hit));
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(release)) {
      if (Date.now() > deadline) throw new Error('bounded fixture delivery gate timed out');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  return result;
};
