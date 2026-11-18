'use strict';
const crypto=require('node:crypto'),H=x=>crypto.createHash('sha256').update(x).digest('hex');
function transform(source){const edits=[
 ['  static object Capture(Dictionary<string,object> args) {',String.raw`  // Observational research on owned synthetic source; no timestamp setter.
  static object ResearchRootOpenProbe(Dictionary<string,object> args) {
    string root=Str(args["root"]),mode=Str(args["mode"]);if(!System.IO.Path.IsPathRooted(root)||!(mode=="quiet"||mode=="extra-open")||PreserveTimeHandles)Reject("research_root_probe_scope");
    string expected=@"\\?\"+System.IO.Path.GetFullPath(root);
    using(var first=Open(root)) {
      string id=Id(first);if(!String.Equals(PathOf(first),expected,StringComparison.OrdinalIgnoreCase))Reject("research_root_probe_alias");
      Basic before=BasicOf(first);if((before.Attr&16u)==0)Reject("research_root_probe_alias");
      if(mode=="extra-open")using(var second=Open(root)) {if(Id(second)!=id||!String.Equals(PathOf(second),expected,StringComparison.OrdinalIgnoreCase))Reject("research_root_probe_changed");}
      Basic after=BasicOf(first);var fields=new List<string>();if(after.Creation!=before.Creation)fields.Add("time.creation");if(after.Access!=before.Access)fields.Add("time.access");if(after.Write!=before.Write)fields.Add("time.write");if(after.Change!=before.Change)fields.Add("time.change");if(after.Attr!=before.Attr)fields.Add("attrs");
      return new Dictionary<string,object>{{"mode",mode},{"fields",fields},{"setTimeCalled",false}};
    }
  }
  static object Capture(Dictionary<string,object> args) {`],
 ['          if (command == "store-info") result=StoreInfo(args);','          if (command == "research-root-open-probe") result=ResearchRootOpenProbe(args);\n          else if (command == "store-info") result=StoreInfo(args);']
 ];let out=source;for(const [a,b] of edits){if(out.split(a).length!==2)throw Error('rootprobe.boundary');out=out.replace(a,b);}return{source:out,originalSha256:H(source),derivedSha256:H(out),edits};}
module.exports={transform};
