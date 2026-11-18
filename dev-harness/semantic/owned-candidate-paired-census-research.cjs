'use strict';
// Research of the private handoff only. The production broker's existing close,
// idle timer, shape, first-handle and error fences must remain around this pair.
async function capture({gate,token,owner,candidate,root,revision,finalRevision,broker,assertAuthoritySync,bind}) {
 if(!gate||!broker||typeof broker.command!=='function'||typeof bind!=='function'||typeof assertAuthoritySync!=='function')throw Error('pair.invalid');
 const proofText=gate.consume(token,owner,candidate,root);
 function issue(request){
  const proof=JSON.parse(proofText);
  gate.assertCurrent(token);
  if(assertAuthoritySync(owner,candidate,root)!==true)throw Error('pair.authority');
  gate.assertCurrent(token);
  // No await or callback between last admission and broker.command.
  return broker.command({...request,candidateProof:proof});
 }
 const first=await issue({cmd:'capture-preserved-census-first',root,revision});
 await bind(first.snapshot);
 return issue({cmd:'capture-preserved-census-final',root,firstRevision:revision,revision:finalRevision});
}
module.exports={capture};
