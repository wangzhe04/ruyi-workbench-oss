'use strict';
// Explicit NEW profile. Legacy verify-media-artifacts.cjs and its four pinned
// files remain unchanged. Disk manifests/receipts are data, never authority.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { verifyClosedTree } = require('./media-profile-tree.cjs');
const ID = 'm4-image-cpython312-candidate-v2';
const PIN = Object.freeze({ profileBytes:681912, profileSha256:'c01f10516422efc066ebcfa877dba12d31f2b1fb2bd8639c19dd09df518be89f',
  sourcesBytes:24134, sourcesSha256:'d55ab549e614a602fecfdbd9c9f33bdb77798795f90118efdcab9348eb6fa0e8', files:3251, bytes:396911379 });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (suffix,cause) => Object.assign(new Error('media.profile_' + suffix,cause ? {cause} : undefined),{code:'media.profile_' + suffix,retry:false});
const captures = new WeakMap();
function readJson(file, bytes, digest) {
  let data;
  try { data=fs.readFileSync(path.join(__dirname,'../resources/media-profiles',file)); }
  catch(cause) { throw fail(cause?.code === 'ENOENT' ? 'missing' : 'unavailable',cause); }
  if (data.length !== bytes || sha(data) !== digest) throw fail('changed');
  try { return JSON.parse(data); } catch(cause) { throw fail('invalid',cause); }
}
function readProfile(profileId) {
  if (profileId !== ID) throw fail('unknown');
  const profile=readJson(ID+'.json',PIN.profileBytes,PIN.profileSha256);
  const sources=readJson(ID+'-sources.json',PIN.sourcesBytes,PIN.sourcesSha256);
  for (const value of [profile,sources]) {
    if (value.schema !== 1 || value.ready !== false || value.executionAuthorized !== false || value.sourceArchiveAvailable !== false || value.provenanceComplete !== false || value.legalAcceptance !== false) throw fail('state_invalid');
  }
  if (profile.id !== ID || sources.profileId !== ID || profile.status !== 'qualification-pending' || profile.files !== PIN.files || profile.bytes !== PIN.bytes || !Array.isArray(profile.artifacts) || profile.artifacts.length !== PIN.files
    || profile.sourceRecipe.sha256 !== PIN.sourcesSha256 || profile.sourceRecipe.bytes !== PIN.sourcesBytes) throw fail('invalid');
  return profile;
}
function captureMediaProfile({ profileId, workerHash, language } = {}) {
  const profile=readProfile(profileId);
  if (!/^[a-f0-9]{64}$/.test(workerHash) || workerHash !== profile.worker.sha256 || typeof language !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(language)) throw fail('binding_invalid');
  const value=Object.freeze({ schema:1, profileId:ID, profileHash:PIN.profileSha256, sourceRecipeHash:PIN.sourcesSha256, workerHash, language,
    hash:sha(JSON.stringify({schema:1,profileId:ID,profileHash:PIN.profileSha256,sourceRecipeHash:PIN.sourcesSha256,workerHash,language})) });
  captures.set(value,value.hash); return value;
}
function assertMediaProfileExecutable(capture) {
  if (!capture || captures.get(capture) !== capture.hash) throw fail('owner_invalid');
  readProfile(capture.profileId); // A stale capture cannot bypass changed data.
  // No true flag or successful byte census can enter an execution branch here.
  // Activation needs a separately reviewed owner/OS lease/startup/source gate.
  throw fail('qualification_pending');
}
async function verifyMediaProfileTree({ profileId, root, signal } = {}) {
  const profile=readProfile(profileId);
  const result=await verifyClosedTree(root,profile.artifacts,{signal});
  readProfile(profileId);
  if (result.files !== PIN.files || result.bytes !== PIN.bytes || result.executionAuthorized !== false || result.namespaceLeaseProved !== false) throw fail('receipt_invalid');
  return Object.freeze({...result,profileId:ID,profileHash:PIN.profileSha256,sourceRecipeHash:PIN.sourcesSha256,pythonVersion:'3.12.10',qualification:'pending'});
}
module.exports=Object.freeze({ captureMediaProfile, assertMediaProfileExecutable, verifyMediaProfileTree });
if (require.main === module) {
  const [profileId,root]=process.argv.slice(2);
  verifyMediaProfileTree({profileId,root}).then(result=>console.log(JSON.stringify(result)),error=>{console.error(error.code || 'media.profile_failed');process.exitCode=1;});
}
