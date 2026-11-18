'use strict';
// Research-only trace inside the existing native guard. It records field names,
// synthetic-root-relative paths and a coarse source/rehearsal scope, never values.
const crypto=require('node:crypto'),path=require('node:path'),H=x=>crypto.createHash('sha256').update(x).digest('hex');
function transform(source,diagnosticFile){
 if(!path.isAbsolute(diagnosticFile)||diagnosticFile.includes('"'))throw Error('basic-diagnostic.path');
 const method='  static void VerifyCapturedBasicUnchanged(List<Node> nodes) {';
 const reporter=`  static void ResearchBasicMismatch(Node node,List<string> times,Basic actual) {
    try {
      string rel=Str(node.Entry["rel"]); bool safe=rel.Length<=1024 && !rel.StartsWith("/") && rel.IndexOfAny(new char[]{'\\\\',':','\\0','\\r','\\n'})<0;
      foreach(char ch in rel)if(ch<32)safe=false;foreach(string part in rel.Split('/')) if(part=="..") safe=false;
      if(!safe)rel="[invalid-relative-path]";
      var fields=new List<string>();
      if(times.Count!=4)fields.Add("times.shape");
      else {if(Str(actual.Creation)!=times[0])fields.Add("time.creation");if(Str(actual.Access)!=times[1])fields.Add("time.access");if(Str(actual.Write)!=times[2])fields.Add("time.write");if(Str(actual.Change)!=times[3])fields.Add("time.change");}
      if(actual.Attr!=Convert.ToUInt32(node.Entry["attrs"]))fields.Add("attrs");
      string location=(OriginalRoot??"").ToLowerInvariant();string scope=location.Contains("\\\\baseline-backups\\\\")?"rehearsal":location.EndsWith("\\\\baseline-data")?"source":"other";
      var row=new Dictionary<string,object>{{"branch","held-basic"},{"scope",scope},{"path",rel},{"fields",fields}};
      System.IO.File.AppendAllText(${JSON.stringify(diagnosticFile)},Json.Serialize(row)+Environment.NewLine);
    } catch { /* A failed trace must never suppress the original reject. */ }
  }
`;
 const before='        || actual.Attr!=Convert.ToUInt32(node.Entry["attrs"])) Reject("metadata_changed");';
 const after='        || actual.Attr!=Convert.ToUInt32(node.Entry["attrs"])) { ResearchBasicMismatch(node,times,actual); Reject("metadata_changed"); }';
 if(source.split(method).length!==2||source.split(before).length!==2)throw Error('basic-diagnostic.boundary');
 let result=source.replace(method,reporter+method).replace(before,after);
 return {source:result,originalSha256:H(source),derivedSha256:H(result),edits:[[method,reporter+method],[before,after]]};
}
module.exports={transform};
