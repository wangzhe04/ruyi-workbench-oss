'use strict';
// Test-only CLI model: consume its actual production MCP definition over stdio.
const cp = require('node:child_process');
const { killOwnTree } = require('./kill-own-tree');
async function requestPermissions(definition, requests) {
  if (!definition || !definition.command || !Array.isArray(definition.args)) throw Error('Missing actual MCP definition');
  const child = cp.spawn(definition.command, definition.args, { env: { ...process.env, ...definition.env },
    ...(definition.cwd ? { cwd: definition.cwd } : {}), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let buffer = '', seq = 0;
  const closed = new Promise(resolve => child.once('close', resolve));
  const fail = error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); };
  child.once('error', fail); child.once('close', () => fail(Error('MCP closed before reply')));
  child.stdin.on('error', fail); child.stderr.resume(); child.stdout.setEncoding('utf8');
  child.stdout.on('data', text => {
    buffer += text; if (Buffer.byteLength(buffer) > 1024 * 1024) { fail(Error('MCP fixture frame limit')); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
      let value; try { value = JSON.parse(line); } catch { fail(Error('Invalid MCP JSON')); continue; }
      const entry = pending.get(value.id); if (!entry) continue;
      pending.delete(value.id); clearTimeout(entry.timer); entry.resolve(value);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error('MCP fixture reply deadline')); }, 75000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline-permission-fixture', version: '1' } });
    if (init.error) throw Error('MCP fixture initialize refused');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const replies = [];
    for (const request of requests) {
      const reply = await rpc('tools/call', { name: 'permission_prompt', arguments: { tool_name: request.toolName, input: request.input } });
      if (reply.error) replies.push({ error: reply.error.message });
      else replies.push(JSON.parse(reply.result.content.find(row => row.type === 'text').text));
    }
    return replies;
  } finally {
    child.stdin.end(); let timer;
    try { await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); }
    finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { killOwnTree(child); await closed; } fail(Error('MCP fixture finished')); }
  }
}
module.exports = { requestPermissions };
