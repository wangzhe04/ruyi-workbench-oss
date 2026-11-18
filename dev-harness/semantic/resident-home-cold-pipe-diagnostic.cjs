'use strict';
// Source-bound, observational diagnostics for an isolated cold actor.
const assert = require('node:assert/strict');
const { hash, fixture: r3Fixture, probe: r3Probe, controller } = require('./resident-home-handoff-diagnostic.cjs');

const hostPin = 'c78aee4be7c0b2a6863a8189feaa1889ad8e40bdc5e84e7003838b14b3b7a350';
function replace(source, from, to) {
  assert.equal(source.split(from).length, 2, 'frozen diagnostic anchor');
  return source.replace(from, () => to);
}
function host(bytes) {
  assert.equal(hash(bytes), hostPin);
  return replace(replace(bytes.toString('utf8'), 'else if(error!=null)switch(error.Message)',
    'else if(error is EndOfStreamException)reason="end_of_stream";\n                else if(error!=null)switch(error.Message)'),
  'membersCount=lastCloseMembersCount', 'hresult=error is IOException?(int?)error.HResult:null,membersCount=lastCloseMembersCount');
}
function probe(bytes) {
  return replace(r3Probe(bytes), '"nativeCode","membersCount"', '"nativeCode","hresult","membersCount"');
}
function fixture(bytes) {
  let result = r3Fixture(bytes);
  result = replace(result, "const marker=phase=>process.stderr.write(", [
    "const coldTrace=role==='cold'?require('./cold-phase-trace.cjs')(fs,path,config.output,process):null;",
    "const marker=phase=>{coldTrace?.record(phase);return process.stderr.write(",
  ].join('\n'));
  result = replace(result, "phase,pid:process.pid,role})+'\\n');", "phase,pid:process.pid,role})+'\\n');};");
  result = replace(result, "connect:name=>net.createConnection(name)", "connect:name=>{const socket=net.createConnection(name);coldTrace?.observe(socket);return socket;}");
  result = replace(result, "function fail(error){if(firstFailure)return;", "function fail(error){if(firstFailure)return;coldTrace?.failure('fixture-failed',error);");
  result = replace(result, "events.push('transfer-request');await client.transfer", "coldTrace?.record('transfer-request');events.push('transfer-request');await client.transfer");
  result = replace(result, "async function next(targetRole){const grant=await client.issue", "async function next(targetRole){coldTrace?.record('issue-request');const grant=await client.issue");
  result = replace(result, " const target=cp.spawn(config.node", " coldTrace?.record('issue-reply');const target=cp.spawn(config.node");
  return result;
}
module.exports = Object.freeze({ hash, host, probe, fixture, controller, hostPin });
