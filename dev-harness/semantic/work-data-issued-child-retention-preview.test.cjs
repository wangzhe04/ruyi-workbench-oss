'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const {transform}=require('./work-data-issued-child-retention-preview.cjs');
const source=transform(fs.readFileSync('output/semantic-gemma-q4-backup-diagnostic-v1/source-input/src/13u-migration-center.js','utf8'));
const begin=source.indexOf('const migrationCapsuleIssuedChildren = new Set();'),end=source.indexOf('function migrationCapsulePortableShape',begin);
function fixture(mode){
 const child=new EventEmitter(); child.pid=123;child.stdin=new EventEmitter();child.stdin.end=()=>{};child.stdin.write=()=>{};child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stderr.resume=()=>{};child.kill=()=>{};
 if(mode==='listener-error')child.once=()=>{throw Error('install failure');};
 const context={Buffer,process:{platform:'win32',env:{},hrtime:process.hrtime},MIGRATION_SKILL_CAPSULE_NATIVE:'',MIGRATION_CAPSULE_ARCHIVE_LIMIT:1024,migrationCapsuleCode:{prepare:async()=>null},require:(name)=>name==='node:child_process'?{spawn:()=>child}:require(name)};
 vm.createContext(context);vm.runInContext(source.slice(begin,end)+'\nglobalThis.subject={migrationCapsuleBroker,migrationCapsuleIssuedChildren}',context);
 return {child,...context.subject};
}
test('post-spawn setup failure holds real child and fences future starts',async()=>{const f=fixture('listener-error');await assert.rejects(f.migrationCapsuleBroker(),e=>e.helperMayStillRun===true);assert.equal(f.migrationCapsuleIssuedChildren.has(f.child),true);await assert.rejects(f.migrationCapsuleBroker(),e=>e.helperMayStillRun===true);});
test('normal issued child held until close, not exit',async()=>{const f=fixture();const broker=await f.migrationCapsuleBroker();assert.equal(f.migrationCapsuleIssuedChildren.has(f.child),true);f.child.emit('spawn');f.child.emit('exit',0);assert.equal(f.migrationCapsuleIssuedChildren.has(f.child),true);f.child.emit('close',0);assert.equal(f.migrationCapsuleIssuedChildren.has(f.child),false);await assert.rejects(broker.close());});
test('confirmed spawn failure with no PID can release child',async()=>{const f=fixture();await f.migrationCapsuleBroker();f.child.pid=undefined;f.child.emit('error',Object.assign(Error('spawn failed'),{syscall:'spawn powershell.exe'}));assert.equal(f.migrationCapsuleIssuedChildren.has(f.child),false);});


