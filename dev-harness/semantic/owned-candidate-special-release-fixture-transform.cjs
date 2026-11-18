'use strict';
// Test-only hooks: retain the captured target reference and inject the requested
// synchronous checker failure. These hooks are not part of the candidate app.
function transform(source){
 const a='async function fixture(t,{preserved=false,uploadsOwnerFactory=null,realUploadsOwner=false,realUploadsRestore=false}={}){',b='async function fixture(t,{preserved=false,uploadsOwnerFactory=null,realUploadsOwner=false,realUploadsRestore=false,failTargetCheck=null}={}){';
 const c=" let hostSource=fs.readFileSync(path.join(draft,'01ad-work-data-migration-host.js'),'utf8');const controls={",d=` let hostSource=fs.readFileSync(path.join(draft,'01ad-work-data-migration-host.js'),'utf8');
 if(failTargetCheck){
   const hold='plan.disposable.push(target);plan.target=target;',observed=hold+'globalThis.__testTarget=target;globalThis.__testTargetReader=targetReader;';
   if(hostSource.split(hold).length!==2)throw Error('target fixture boundary');hostSource=hostSource.replace(hold,observed);
   const check=failTargetCheck==='root'?'targetReader.assertRootId(target,manifest.researchCandidateBoundary(plan.candidate,plan.sourceProof).id);':'targetReader.assertNoNamedStreams(target);';
   if(!hostSource.includes(check))throw Error('check fixture boundary');hostSource=hostSource.replace(check,"throw Object.assign(Error('injected_target_check'),{code:'test.target_check'});");
 }
 const controls={`;
 let out=source;for(const [x,y] of [[a,b],[c,d]]){if(out.split(x).length!==2)throw Error('release.fixture.boundary');out=out.replace(x,y);}return{source:out,edits:[[a,b],[c,d]]};
}
module.exports={transform};
