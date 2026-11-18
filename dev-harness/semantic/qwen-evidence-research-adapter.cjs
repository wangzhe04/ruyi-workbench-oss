'use strict';
// Fixed, unregistered evidence-instruction research profile. Reuse the exact
// reviewed native controller with bounded, source-pinned substitutions.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const baseFile=path.join(__dirname,'qwen-research-adapter.cjs');
const base=fs.readFileSync(baseFile,'utf8');
if(crypto.createHash('sha256').update(base).digest('hex')!=='fb2b86d3646374d80a5481bf14b3ff88e16451444d5ed52a76f40383da74f89f')throw Error('Evidence profile base controller changed');
const oldPrefix="const PREFIX = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\\nQuery:';";
const newPrefix="const PREFIX = 'Instruct: Given a user question, retrieve prior messages that contain evidence relevant to answering it\\nQuery:';";
const oldPolicy='minimumScore: .44, searchThreshold: .44, retrievalThresholds: { search: .44, automatic: null },';
const newPolicy='minimumScore: .46, searchThreshold: .46, retrievalThresholds: { search: .46, automatic: null },';
// The original collector fingerprints its original query contract. Verify that
// foundation unchanged; the returned profile FP independently binds the NEW
// CONTRACT plus this complete transformation source, never reuses the old FP.
const oldReference='JSON.stringify([lock, PIN.inventory, CONTRACT, PIN.collector])';
const newReference="JSON.stringify([lock, PIN.inventory, { ...CONTRACT, queryPrefix: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\\nQuery:' }, PIN.collector])";
const oldCache="'--no-cache-prompt', '--host',";
const newCache="'--no-cache-prompt', '--cache-ram', '0', '--no-cache-idle-slots', '--slot-prompt-similarity', '0', '--slot-save-path', path.join(home, 'cache'), '--host',";
// b11146 embedding route constructs default task params and ignores the body
// cache_prompt flag. Explicitly erase the single idle slot before every encode;
// recheck source authority after that await before sending any embedding text.
const oldEmbed="stats.embeddingWrites++; const result = await request('/v1/embeddings',";
const newEmbed="const erased = await request('/slots/0?action=erase', {}, target); if (erased?.id_slot !== 0 || !Number.isSafeInteger(erased.n_erased) || erased.n_erased < 0) throw failure('SLOT_ERASE_FAILED'); await guard(); stats.embeddingWrites++; const result = await request('/v1/embeddings',";
if([oldPrefix,oldPolicy,oldReference,oldCache,oldEmbed].some(value=>base.split(value).length!==2))throw Error('Evidence profile transform shape changed');
const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=Module._nodeModulePaths(__dirname);
compiled._compile(base.replace(oldPrefix,newPrefix).replace(oldPolicy,newPolicy).replace(oldReference,newReference).replace(oldCache,newCache).replace(oldEmbed,newEmbed),__filename);
module.exports=compiled.exports;
