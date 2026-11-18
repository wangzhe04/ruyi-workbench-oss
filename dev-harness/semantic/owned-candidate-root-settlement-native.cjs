'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function transform(source){
 const fragment=fs.readFileSync(path.join(__dirname,'owned-candidate-root-settlement.csfrag'),'utf8'),edits=[
  ['  static object Capture(Dictionary<string,object> args) {',fragment+'\n  static object Capture(Dictionary<string,object> args) {'],
  ['CapturedDirectoryWrite && directory ? 0xC0010100u : writable ? 0xC0010000u : 0x80010100u','(CapturedDirectoryWrite && directory || CandidateSettlementCapture && directory && String.Equals(file,CandidateSettlementRoot,StringComparison.OrdinalIgnoreCase)) ? 0xC0010100u : writable ? 0xC0010000u : 0x80010100u'],
  ['directory ? 7u : 5u, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);','directory ? (CandidateSettlementCapture?3u:7u) : 5u, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);'],
  ['          if (command == "research-candidate-start") result=ResearchCandidateStart(args);','          if (command == "candidate-settle-root") result=CandidateSettleRoot(args);\n          else if (command == "research-candidate-start") result=ResearchCandidateStart(args);']
 ];let out=source;for(const [i,[a,b]] of edits.entries()){if(out.split(a).length!==2)throw Error('settlement.native.boundary.'+i);out=out.replace(a,b);}return{source:out,edits,sha256:crypto.createHash('sha256').update(out).digest('hex')};
}
module.exports={transform};
