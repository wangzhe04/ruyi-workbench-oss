'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
for(const [name,old]of [['scalar-scan-stat.test.cjs',"'./scalar-scan-stat-fixture.cjs'"],['bge-zh-producer.test.cjs',"'./bge-zh-live-fixture.cjs'"]]){const file=path.join(__dirname,name),source=fs.readFileSync(file,'utf8');if(source.split(old).length!==2)throw Error('Regression import changed');const compiled=new Module(file,module);compiled.filename=file;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(source.replace(old,"'./ui-tentative-coverage-fixture.cjs'"),file);}
