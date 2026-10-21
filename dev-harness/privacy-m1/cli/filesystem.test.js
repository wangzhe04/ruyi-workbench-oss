'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {safeRemove,launch}=require('./run');
const {summarizeFilesystem,compileHelper,helperEnvironment}=require('./filesystem');
test('missing, crashed, partial, denied and wrong-token rows cannot establish a strict filesystem view',()=>{
  for(const attempt of [{code:1,output:[],events:[]},{code:0,output:[{kind:'filesystem',descendant:false,name:'probe',operation:'ready',verified:true}],events:[]}]) {
    const summary=summarizeFilesystem(attempt,[{name:'arap-read'}]);assert.equal(summary.rootAndChildExecuted,false);assert.equal(summary.matrixComplete,false);assert.equal(summary.rootAndDescendantTokensVerified,false);assert.equal(summary.strictFilesystemContract,'unknown');assert.equal(summary.exclusiveFilesystemAllowlistEstablished,false);
  }
  const summary=summarizeFilesystem({code:0,events:[],output:[{kind:'filesystem',name:'arap-read',operation:'read',allowed:true,verified:true,descendant:false}]},[{name:'arap-read'}]);assert.equal(summary.strictFilesystemContract,'failed');assert.equal(summary.rootAndDescendantTokensVerified,false);
});
test('launch options reject arbitrary executable/profile overrides before any file or process creation',async()=>{
  for(const options of [{profile:'unexpected'},{exe:'unexpected'},{filesystemStorage:true,cwd:'unexpected'}])await assert.rejects(launch('unused','unused','unused','unused','unused',[],1,{},'LPAC',true,null,options),/unsupported-launch-option/);
});
test('native fixture prevalidation rejects path, principal, rights, ancestor and descendant reparse escapes', {skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-m1-cli-filesystem-unit-')),sibling=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-m1-cli-filesystem-other-'));
  try {
    const directory=path.join(root,'fixtures'),nested=path.join(directory,'nested');fs.mkdirSync(nested,{recursive:true});fs.writeFileSync(path.join(directory,'file.txt'),'SYNTHETIC');
    const {helper}=compileHelper(root),config=path.join(root,'validate.json'),valid={directory,principal:'arap',rights:'read'};
    const validate=fixtures=>{fs.writeFileSync(config,JSON.stringify({filesystemFixtures:fixtures}));return cp.spawnSync(helper,['--validate-filesystem-fixtures',config],{windowsHide:true,encoding:'utf8',env:helperEnvironment(root,root),timeout:5000});};
    assert.equal(validate([valid]).status,0);
    for(const fixture of [{...valid,directory:root},{...valid,directory:sibling},{...valid,directory:'fixtures'},{...valid,directory:path.join(directory,'file.txt')},{...valid,principal:'S-1-15-2-2'},{...valid,rights:'FullControl'},{...valid,extra:true}])assert.equal(validate([valid,fixture]).status,1);
    assert.equal(validate(Array.from({length:17},()=>valid)).status,1);
    const alias=path.join(root,'alias');fs.symlinkSync(sibling,alias,'junction');assert.equal(validate([{...valid,directory:alias}]).status,1);assert.equal(validate([{...valid,directory:path.join(alias,'nested')}]).status,1);
    const descendant=path.join(nested,'alias');fs.symlinkSync(sibling,descendant,'junction');assert.equal(validate([valid]).status,1);
    fs.unlinkSync(descendant);fs.unlinkSync(alias);assert.equal(validate([valid]).status,0);assert.equal(fs.readFileSync(path.join(directory,'file.txt'),'utf8'),'SYNTHETIC');
    fs.writeFileSync(path.join(sibling,'source.txt'),'SYNTHETIC_OUTSIDE_ROOT');fs.linkSync(path.join(sibling,'source.txt'),path.join(directory,'linked.txt'));assert.equal(validate([valid]).status,1);fs.unlinkSync(path.join(directory,'linked.txt'));assert.equal(validate([valid]).status,0);
  } finally {safeRemove(root);safeRemove(sibling);}
});
