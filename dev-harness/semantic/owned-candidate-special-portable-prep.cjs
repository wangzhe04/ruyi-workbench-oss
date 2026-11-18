'use strict';
// Adapt only the owned modeled test fixture; never touches the frozen app.
const fs=require('node:fs'),path=require('node:path');
const repo=path.resolve(__dirname,'../..'),owned=path.join(repo,'output/semantic-candidate-special-integration-draft-v2'),test=fs.readFileSync(path.join(repo,'dev-harness/unit/work-data-portable.test.js'),'utf8');
const changed=require('./owned-candidate-special-portable-test-transform.cjs').transform(test);let inverse=changed.source;for(const [a,b,n] of [...changed.edits].reverse()){if(inverse.split(b).length!==n+1)throw Error('test inverse');inverse=inverse.split(b).join(a);}if(inverse!==test)throw Error('test mismatch');
fs.writeFileSync(path.join(owned,'dev-harness/unit/work-data-portable.test.js'),changed.source);
for(const file of ['migration-backup-representation-fixture.js','migration-backup-owner-fixture.js']){
 const dest=path.join(owned,'dev-harness/lib',file),source=fs.readFileSync(dest,'utf8');
 const before="'00000001'+fs.statSync(file,{bigint:true}).ino.toString(16).padStart(16,'0')",after="fs.statSync(file,{bigint:true}).dev.toString(16).padStart(8,'0')+fs.statSync(file,{bigint:true}).ino.toString(16).padStart(16,'0')";
 if(source.split(before).length!==2)throw Error('fixture boundary');const result=source.replace(before,after);if(result.replace(after,before)!==source)throw Error('fixture inverse');fs.writeFileSync(dest,result);
}
console.log('owned fixture transformations reversible');
