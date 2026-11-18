'use strict';
// Additional separate synthetic parity command. Never used by capture arm.
const nt=require('./owned-volume-nt-query-research.cjs'),crypto=require('node:crypto'),H=x=>crypto.createHash('sha256').update(x).digest('hex');
function transform(source){const base=nt.transform(source);let out=base.source;const edits=[
 ['  static object Capture(Dictionary<string,object> args) {',String.raw`  static object ResearchVolumeParity(Dictionary<string,object> args) {
    string root=Str(args["root"]);if(!System.IO.Path.IsPathRooted(root))Reject("research_parity_root");
    using(var handle=Open(root)) {
      if((BasicOf(handle).Attr&16u)==0)Reject("research_parity_root");Id(handle);
      string ntName;uint ntSerial,ntComponent,ntFlags;ResearchVolumeInfo(handle,out ntSerial,out ntComponent,out ntFlags,out ntName);
      var winName=new StringBuilder(64);uint winSerial,winComponent,winFlags;
      Check(GetVolumeInformationByHandleW(handle,null,0,out winSerial,out winComponent,out winFlags,winName,64));
      return new Dictionary<string,object>{{"filesystem",String.Equals(ntName,winName.ToString(),StringComparison.Ordinal)},
        {"serial",ntSerial==winSerial},{"component",ntComponent==winComponent},{"flags",ntFlags==winFlags}};
    }
  }
  static object Capture(Dictionary<string,object> args) {`],
 ['          if (command == "store-info") result=StoreInfo(args);','          if (command == "research-volume-parity") result=ResearchVolumeParity(args);\n          else if (command == "store-info") result=StoreInfo(args);']
 ];for(const [a,b] of edits){if(out.split(a).length!==2)throw Error('parity.boundary');out=out.replace(a,b);}return{source:out,originalSha256:H(source),derivedSha256:H(out),edits:[...base.edits,...edits]};}
module.exports={transform};
