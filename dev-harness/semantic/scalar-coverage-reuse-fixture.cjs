'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const basePath=require.resolve('./scalar-window-append-public-consumer-fixture.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function factory(reuse=true){
  let source=fs.readFileSync(basePath,'utf8');
  if(hash(source)!=='ab58857df9c7fc8a877a7f2d08cf4e369e4acce6ea0cc46c3b975d523c9d4167')throw Error('Frozen append fixture changed.');
  const before="\"'./scalar-window-append-live-layout.cjs'\"",after=JSON.stringify(reuse?"'./scalar-coverage-reuse-layout.cjs'":"'./scalar-producer-timing-layout.cjs'");
  if(source.split(before).length!==2)throw Error('Timing fixture selector changed.');source=source.replace(before,after);
  const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(source,__filename);return compiled.exports;
}
module.exports={fixture:async(options={})=>factory(options.reuse!==false).fixture(options)};
