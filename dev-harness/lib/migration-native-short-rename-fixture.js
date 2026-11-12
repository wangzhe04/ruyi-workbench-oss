'use strict';
// Test-only, bounded B0 plan/assertions. Importing this file does no FS/native work.
const path=require('node:path'),crypto=require('node:crypto'),a=require('node:assert/strict');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const LIMITS=Object.freeze({outerMs:120000,commandMs:120000,closeMs:2000,metadataMs:30000,capsules:8,metadata:2,wireBytes:1048576});
const RELS=Object.freeze(['','D','D/A','D/B']);
const PHASES=Object.freeze([['initial-preserved',['capture-preserved-census-first','capture-preserved-census-final']],['initial-verify',['capture-preserved-census-first','capture-preserved-census-final']],['N0',['capture-preserved']],['seal',['attach','seal-attached','verify']],['restore',['attach','publish-check','restore','publish']],['final-preserved',['capture-preserved-census-first','capture-preserved-census-final']],['final-verify',['capture-preserved-census-first','capture-preserved-census-final']],['final-native',['capture-preserved']]]);
const FACTORY_SHA='d32f7de37b6f8c16df0eb7a773303051003a90a1e9b64453bde4f4160bfe32b8';
function error(code,cause){return Object.assign(Error(code),{code,...(cause===undefined?{}:{cause})});}
class State{
 constructor(now,started=now(),retain=()=>{}){a.equal(typeof now,'function');a(Number.isSafeInteger(started)&&started>=0&&started<=now());this.now=now;this.started=started;this.deadline=started+LIMITS.outerMs;this.first=null;this.unknown=false;this.native=0;this.metadata=0;this.retainOwner=retain;}
 red(value){this.first ||= value;return value;}
 retain(value){this.red(value);this.unknown=true;this.retainOwner(this.first);}
 admit(){if(this.now()>=this.deadline)this.retain(error('short_rename.deadline_unknown'));if(this.first)throw this.first;}
 count(kind){this.admit();a(['native','metadata'].includes(kind));this[kind]++;if(this[kind]>(kind==='native'?LIMITS.capsules:LIMITS.metadata))throw this.red(error('short_rename.unplanned_helper'));}
 safe(allKnown,originalLatch){if(this.now()>=this.deadline)this.retain(error('short_rename.deadline_unknown'));if(this.unknown||this.first||!allKnown||originalLatch===true)throw this.first||error('short_rename.release_unproven');return true;}
}
function fixture(){const bytes=(n,salt)=>Buffer.from(Array.from({length:n},(_,i)=>(i*29+salt)%256));return[{rel:'D/A',stream:'',data:bytes(32768,7)},{rel:'D/B',stream:'',data:bytes(32736,11)},{rel:'D/A',stream:':public-ads:$DATA',data:bytes(32,19)}];}
function check(snapshot){a.equal(snapshot.schema,1);a.equal(snapshot.platform,'ntfs-objects-v1');a.match(snapshot.revision,/^[a-f0-9]{64}$/);a.deepEqual(snapshot.entries.map(r=>r.rel).sort(),[...RELS].sort());a.equal(new Set(snapshot.entries.map(r=>r.id)).size,4);a.equal(new Set(snapshot.entries.map(r=>r.id.slice(0,8))).size,1);const expected=fixture(),found=[];try{for(const row of snapshot.entries){a.equal(row.dir,row.rel===''||row.rel==='D');a.match(row.id,/^[a-f0-9]{24}$/);a.match(row.opaque,/^[a-f0-9]{64}$/);a.equal(row.times.length,4);row.times.forEach(t=>a.match(t,/^\d{1,19}$/));a.equal(typeof row.shortName,'string');if(row.dir)a.deepEqual(row.streams,[]);for(const stream of row.streams){const wanted=expected.find(r=>r.rel===row.rel&&r.stream===stream.name);a(wanted);a.equal(stream.size,wanted.data.length);a.equal(stream.hash,sha(wanted.data));a.equal(stream.data,wanted.data.toString('base64'));found.push(row.rel+'|'+stream.name)}}a.equal(found.length,3);a.equal(new Set(found).size,3);a.equal(snapshot.entries.find(r=>r.rel==='D/A').attrs&1,1);}finally{expected.forEach(r=>r.data.fill(0));}}
function publicSnapshot(value){return{schema:value.schema,platform:value.platform,revision:value.revision,entries:value.entries.map(row=>({...row,times:[...row.times],streams:row.streams.map(({data,...stream})=>stream)})).sort((a,b)=>a.rel<b.rel?-1:a.rel>b.rel?1:0)};}
function same(actual,expected){a.deepEqual(publicSnapshot(actual).entries.map(({opaque,...row})=>row),publicSnapshot(expected).entries.map(({opaque,...row})=>row));}
function metadata(rows,snapshot,baseline){a.equal(rows.length,4);a.deepEqual(rows.map(r=>r.rel).sort(),[...RELS].sort());for(const row of rows){const expected=snapshot.entries.find(r=>r.rel===row.rel);a.equal(row.attrs,expected.attrs);a.deepEqual(row.times,[...expected.times]);a.equal(row.shortName,expected.shortName);a.equal(typeof row.sddl,'string');a(row.sddl.includes('O:')&&row.sddl.includes('G:')&&row.sddl.includes('D:'));if(baseline)a.equal(row.sddl,baseline.find(r=>r.rel===row.rel).sddl);}}
// The original producer remains the sole factory/child/command/close. Its factory
// Promise and returned object necessarily change identity through this test seam;
// command/close return the exact original Promise, receiver and argument references.
function installAdmission(api,{admit,afterFactory,latch}){
 const install=api.__eval('('+function(admit,afterFactory,latch,sha,expected){
  const original=migrationCapsuleBroker;let active=true;
  if(sha(original.toString())!==expected||original.helperMayStillRun!==undefined)throw Error('short_rename.factory_source_changed');
  const wrapper=async function(...args){if(!active)throw Error('short_rename.factory_seam_closed');admit();const broker=await Reflect.apply(original,this,args);try{admit();if(afterFactory(broker)!==undefined)throw Error('short_rename.factory_observer_async');admit();}catch(primary){try{latch(primary);}catch{/* preserve original primary */}try{await Reflect.apply(broker.close,broker,[]);}catch(secondary){try{latch(secondary);}catch{/* no replacement primary */}}throw primary;}
   const command=broker.command,close=broker.close;
   return Object.freeze({command:function(...values){if(!active)throw Error('short_rename.factory_seam_closed');admit();return Reflect.apply(command,broker,values);},close:function(...values){return Reflect.apply(close,broker,values);}});
  };
  Object.defineProperty(wrapper,'helperMayStillRun',{get(){return original.helperMayStillRun;},set(value){original.helperMayStillRun=value;},configurable:false});
  migrationCapsuleBroker=wrapper;
  return Object.freeze({factory:wrapper,restore(){if(migrationCapsuleBroker!==wrapper){latch(Error('short_rename.factory_replaced'));throw Error('short_rename.factory_replaced');}active=false;migrationCapsuleBroker=original;if(migrationCapsuleBroker!==original||sha(original.toString())!==expected)throw Error('short_rename.factory_restore_unproven');return{sourceSha256:sha(original.toString()),originalHelperUnknown:original.helperMayStillRun===true};}});
 }.toString()+')');
 return install(admit,afterFactory,latch,sha,FACTORY_SHA);
}
module.exports={sha,LIMITS,RELS,PHASES,FACTORY_SHA,State,error,fixture,check,publicSnapshot,same,metadata,installAdmission};
