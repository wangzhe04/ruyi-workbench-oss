'use strict';
// Actual RPC preparation/write boundary in memory: no child/native/helper processes.
const { test, after } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-dispatch-unit-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR']) { process.env[key] = path.join(root, key); fs.mkdirSync(process.env[key]); }
process.env.RUYI_HOME = path.join(root, 'data'); process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
const { McpStdioClient, mcpCallToolParams, DesktopExecutionRuntime } = require('../lib/server-internals').loadServerInternals(['McpStdioClient', 'mcpCallToolParams', 'DesktopExecutionRuntime']);
after(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture() {
  const writes = [], client = new McpStdioClient({ id: 'fixture', command: 'not-spawned' });
  client.child = { stdin: { writable: true, write(value) { writes.push(value); queueMicrotask(() => client._onLine('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')); } } };
  return { client, writes };
}
test('actual metadata preparation and final RPC serialization never run inherited object/array toJSON', async () => {
  const f = fixture(), beforeObject = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON'), beforeArray = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let hooks = 0, result, checked, thrown;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value() { hooks++; return { altered: true }; } });
    Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, value() { hooks++; return []; } });
    const options = { meta: { reserved: { invocation: 'original', values: [1, '你好'] } }, executionCheck(packet) { checked = packet; } };
    const params = mcpCallToolParams('wait', { seconds: 0, values: [1, 2] }, options);
    result = await f.client._rpc('tools/call', params, 2000, options);
  } catch (error) { thrown = error; }
  finally {
    if (beforeObject) Object.defineProperty(Object.prototype, 'toJSON', beforeObject); else delete Object.prototype.toJSON;
    if (beforeArray) Object.defineProperty(Array.prototype, 'toJSON', beforeArray); else delete Array.prototype.toJSON;
  }
  assert.equal(thrown, undefined); assert.equal(hooks, 0); assert.deepEqual(result, { ok: true });
  assert.equal(checked.params._meta.reserved.invocation, 'original'); assert.equal(Object.getPrototypeOf(checked), null);
  const actual = JSON.parse(f.writes[0]); assert.deepEqual(actual.params.arguments, { seconds: 0, values: [1, 2] });
  assert.deepEqual(actual.params._meta, { reserved: { invocation: 'original', values: [1, '你好'] } });
});
test('final serialized packet rejection makes zero actual stdin writes and clears pending request', async () => {
  const f = fixture();
  await assert.rejects(f.client._rpc('tools/call', { name: 'wait', arguments: { seconds: 0 } }, 2000,
    { executionCheck() { throw Object.assign(new Error('prepared/client/admission changed'), { code: 'execution_packet_changed' }); } }), { code: 'execution_packet_changed' });
  assert.equal(f.writes.length, 0); assert.equal(f.client._pending.size, 0);
});
test('own executable serialization hooks refuse before final callback and before stdin', async () => {
  const f = fixture(); let executed = 0, checked = 0;
  const args = { seconds: 0, toJSON() { executed++; return {}; } };
  await assert.rejects(f.client._rpc('tools/call', { name: 'wait', arguments: args }, 2000,
    { executionCheck() { checked++; } }));
  assert.equal(executed, 0); assert.equal(checked, 0); assert.equal(f.writes.length, 0); assert.equal(f.client._pending.size, 0);
});
test('stripped tool text alone cannot acknowledge delivery after image flush was interrupted', () => {
  const row = { role: 'tool', tool_call_id: 'capture', content: '{"ok":true,"image":"[image]"}' };
  const parts = [{ type: 'text', text: 'actual tool image' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }];
  const staged = { index: 0, row: JSON.stringify(row), images: [JSON.stringify(parts)], imageIndices: [1] };
  assert.equal(DesktopExecutionRuntime.mainDeliveryMatches([row], staged), false, 'steer drops pending image');
  assert.equal(DesktopExecutionRuntime.mainDeliveryMatches([row, { role: 'user', content: 'image omitted' }], staged), false);
  assert.equal(DesktopExecutionRuntime.mainDeliveryMatches([row, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'changed' } }] }], staged), false);
  assert.equal(DesktopExecutionRuntime.mainDeliveryMatches([row, { role: 'user', content: parts }], staged), true);
});
test('required image must follow the matching actual tool row, and every image must be present', () => {
  const row = { role: 'tool', tool_call_id: 'capture', content: 'result' }, first = [{ type: 'text', text: 'one' }], second = [{ type: 'text', text: 'two' }];
  const staged = { index: 1, row: JSON.stringify(row), images: [JSON.stringify(first), JSON.stringify(second)], imageIndices: [2,3] };
  assert.equal(DesktopExecutionRuntime.mainDeliveryMatches([{ role: 'user', content: first }, row, { role: 'user', content: second }], staged), false);
  assert.equal(DesktopExecutionRuntime.mainDeliveryMatches([{}, row, { role: 'user', content: first }, { role: 'user', content: second }], staged), true);
  assert.equal(DesktopExecutionRuntime.mainDeliveryMatches([{}, { ...row, content: 'different' }, { role: 'user', content: first }, { role: 'user', content: second }], staged), false);
});

test('identical older image or one repeated row cannot stand in for this call required image instances',()=>{
  const row={role:'tool',tool_call_id:'second',content:'projected result'},parts=[{type:'image_url',image_url:{url:'same pixels'}}],image={role:'user',content:parts};
  const staged={index:0,row:JSON.stringify(row),images:[JSON.stringify(parts)],imageIndices:[2]};
  assert.equal(DesktopExecutionRuntime.mainDeliveryMatches([row,image],staged),false);
  assert.equal(DesktopExecutionRuntime.mainDeliveryMatches([row,image,{role:'user',content:parts}],staged),true);
  const duplicated={...staged,images:[JSON.stringify(parts),JSON.stringify(parts)],imageIndices:[1,1]};
  assert.equal(DesktopExecutionRuntime.mainDeliveryMatches([row,image,image],duplicated),false);
  assert.equal(DesktopExecutionRuntime.mainDeliveryMatches([row,image,image],{...duplicated,imageIndices:[1,2]}),true);
});
