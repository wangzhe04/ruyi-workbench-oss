'use strict';
// Test-owned filesystem boundary only. Never supplies a consumer, human witness,
// receipt, journal plaintext, key, worker, scheduler or product export.
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.RUYI_C2_FAULT_DIR;
if (dir) {
  const io = fs.promises, rename = io.rename, appendFile = io.appendFile;
  const control = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'fault.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; } };
  const mark = (name, data) => fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(data));
  io.rename = async function(from, to) {
    const spec = control();
    if (spec.kind === 'refuse-bot-completed' && String(to).replaceAll('\\', '/').endsWith('/external-bots/state-v1.json')) {
      const state = JSON.parse(fs.readFileSync(from, 'utf8'));
      const item = state.items.find(row => row.messageId === spec.messageId && row.execution?.status === 'completed');
      if (item) { mark('bot-completed-refused', { messageId: spec.messageId, itemId: item.id }); throw Object.assign(Error('C2 fixture refuses original bot completion rename'), { code: 'ENOSPC' }); }
    }
    return rename.call(this, from, to);
  };
  io.appendFile = async function(file, data, ...args) {
    const result = await appendFile.call(this, file, data, ...args);
    const spec = control();
    if (spec.kind === 'lose-core-terminal-ack' && String(file) === spec.file) {
      const row = JSON.parse(String(data));
      if (row.id === spec.interventionId && ['allowed', 'answered', 'approved', 'denied', 'rejected'].includes(row.status)) {
        fs.unlinkSync(path.join(dir, 'fault.json'));
        mark('core-terminal-committed', { id: row.id, status: row.status });
        throw Object.assign(Error('C2 fixture loses original terminal append acknowledgement'), { code: 'EIO' });
      }
    }
    return result;
  };
}
