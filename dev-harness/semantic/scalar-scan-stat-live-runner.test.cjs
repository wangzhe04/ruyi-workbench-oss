'use strict';
// Re-execute existing five actual-runner cases with the observation-free source
// and the stricter paired observed-exit contract. Historical tests stay intact.
const fs=require('node:fs'),crypto=require('node:crypto'),Module=require('node:module');
const file=require.resolve('./scalar-composite-live-development.test.cjs'),hash=value=>crypto.createHash('sha256').update(value).digest('hex');let source=fs.readFileSync(file,'utf8');
if(hash(source)!=='82bed18fef8bb5b6fd59567fcd01fa659981a87eb4d0fb897ea27a3755890325')throw Error('Frozen five runner cases changed.');
for(const [before,after]of [["require('./scalar-composite-live-development.cjs')","require('./scalar-scan-stat-live-development.cjs')"],["return { workerExited: true };","return { workerExited: true, cleanupStatus: 'observed' };"]]){if(source.split(before).length!==2)throw Error('Observation-free runner test boundary changed.');source=source.replace(before,after);}
const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(source,__filename);
