'use strict';
// Each control runs only the narrow permanent pure test against a surgical source
// deletion in its VM host. A control succeeds only when its safety assertion fails.
const cp=require('node:child_process'),path=require('node:path'),a=require('node:assert/strict');
const cases={fence:'pool final fence',forge:'forged witness',receipt:'effect and durable proof',payload:'lost volatile answer',phase:'extra journal row after own applying'};
const rows=[];
for(const[mode,pattern]of Object.entries(cases)){
 const result=cp.spawnSync(process.execPath,['--test','--test-name-pattern='+pattern,'dev-harness/unit/external-bots-human-decisions.test.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,RUYI_C2_NEGATIVE:mode},encoding:'utf8',timeout:30000,windowsHide:true});
 const output=result.stdout+result.stderr;
 a.equal(result.status,1,mode+' must make its safety test red: '+output);
 a.match(output,/AssertionError|ERR_ASSERTION/,mode+' must fail an assertion');
 rows.push({mode,pattern,exitCode:result.status,assertionFailed:true});
}
console.log(JSON.stringify({schema:1,sourcePureOnly:true,controls:rows},null,2));
