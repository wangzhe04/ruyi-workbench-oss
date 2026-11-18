'use strict';
// Exact sequence representation memo only: every call still reads five inputs.
// Object/function/symbol/bigint paths retain original JSON behavior, uncached.
const fs=require('node:fs'),crypto=require('node:crypto'),prior=require('./scalar-scan-stat-source.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const before=`function sessionFullTextSequence(id) {
  return JSON.stringify([sessionDiskWriteSeqOf(id),sessionFullTextHeadWriteSeq.get(id)||0,
    sessionDeleteTombstones.get(id)?.at||0,sessionPermissionModeOverrides.get(id)||null,sessionDesktopToolsOverrides.get(id)||null]);
}`;
const after=`const SESSION_FULLTEXT_SEQUENCE_MEMO=new Map();
function sessionFullTextSequence(id) {
  const a=sessionDiskWriteSeqOf(id),b=sessionFullTextHeadWriteSeq.get(id)||0,
    c=sessionDeleteTombstones.get(id)?.at||0,d=sessionPermissionModeOverrides.get(id)||null,e=sessionDesktopToolsOverrides.get(id)||null;
  const cached=SESSION_FULLTEXT_SEQUENCE_MEMO.get(id);
  if(cached&&a===cached.a&&b===cached.b&&c===cached.c&&d===cached.d&&e===cached.e)return cached.text;
  const values=[a,b,c,d,e];
  if(!values.every(value=>value===null||['string','number','boolean'].includes(typeof value)))return JSON.stringify(values);
  const text=JSON.stringify(values);
  SESSION_FULLTEXT_SEQUENCE_MEMO.set(id,{a,b,c,d,e,text});
  while(SESSION_FULLTEXT_SEQUENCE_MEMO.size>4096)SESSION_FULLTEXT_SEQUENCE_MEMO.delete(SESSION_FULLTEXT_SEQUENCE_MEMO.keys().next().value);
  return text;
}`;
function transform(source){const value=prior.transform(source);if(value.source.split(before).length!==2)throw Error('Exact sequence owner boundary changed');const derived=value.source.replace(before,after);return {...value,source:derived,transformedSha256:hash(derived),recipe:[...value.recipe,{before,after,purpose:'At most4096 private sequence metadata tuples. Every call reads all five current values; no authority, key, owner, source epoch or final check removed.'}],sequenceMemoScriptSha256:hash(fs.readFileSync(__filename))};}
module.exports={transform,before,after};
