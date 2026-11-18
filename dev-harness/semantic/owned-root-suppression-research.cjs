'use strict';
const crypto=require('node:crypto'),H=x=>crypto.createHash('sha256').update(x).digest('hex');
function transform(source){const edits=[
 ['  static object Capture(Dictionary<string,object> args) {',String.raw`  // Research-only: -1 requests handle-scoped suppression, never timestamp values.
  static List<string> ResearchBasicDiff(Basic before,Basic after) {
    var f=new List<string>();if(before.Creation!=after.Creation)f.Add("time.creation");if(before.Access!=after.Access)f.Add("time.access");if(before.Write!=after.Write)f.Add("time.write");if(before.Change!=after.Change)f.Add("time.change");if(before.Attr!=after.Attr)f.Add("attrs");return f;
  }
  static object ResearchSuppressProbe(Dictionary<string,object> args) {
    string root=Str(args["root"]),mode=Str(args["mode"]);if(!System.IO.Path.IsPathRooted(root)||!(mode=="all-three"||mode=="access-only")||PreserveTimeHandles)Reject("research_suppress_scope");
    string expected=@"\\?\"+System.IO.Path.GetFullPath(root);bool previous=PreserveTimeHandles;Basic before,afterSuppress,afterEnumerate,afterClose;string rootId;int count;
    try {
      using(var held=Open(root)) {
        rootId=Id(held);if(!String.Equals(PathOf(held),expected,StringComparison.OrdinalIgnoreCase))Reject("research_suppress_alias");before=BasicOf(held);if((before.Attr&16u)==0)Reject("research_suppress_not_directory");
        Basic suppression=new Basic{Access=-1,Write=mode=="all-three"?-1:0,Change=mode=="all-three"?-1:0};
        IntPtr value=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Basic))),iosb=Marshal.AllocHGlobal(IntPtr.Size*2);
        try {Marshal.StructureToPtr(suppression,value,false);int status=NtSetInformationFile(held,iosb,value,(uint)Marshal.SizeOf(typeof(Basic)),4);if(status<0)throw new Win32Exception((int)RtlNtStatusToDosError(status));if(status!=0)Reject("research_suppress_status");}finally{Marshal.FreeHGlobal(value);Marshal.FreeHGlobal(iosb);}
        afterSuppress=BasicOf(held);PreserveTimeHandles=true;count=DirectoryChildren(held,root).Length;afterEnumerate=BasicOf(held);
      }
      PreserveTimeHandles=false;using(var reopened=Open(root)) {if(Id(reopened)!=rootId||!String.Equals(PathOf(reopened),expected,StringComparison.OrdinalIgnoreCase))Reject("research_suppress_identity");afterClose=BasicOf(reopened);}
      return new Dictionary<string,object>{{"mode",mode},{"afterSuppress",ResearchBasicDiff(before,afterSuppress)},{"afterEnumerate",ResearchBasicDiff(before,afterEnumerate)},{"afterClose",ResearchBasicDiff(before,afterClose)},{"entryCount",count},{"timestampValuesWritten",false}};
    }finally{PreserveTimeHandles=previous;}
  }
  static object Capture(Dictionary<string,object> args) {`],
 ['          if (command == "store-info") result=StoreInfo(args);','          if (command == "research-suppress-probe") result=ResearchSuppressProbe(args);\n          else if (command == "store-info") result=StoreInfo(args);']
 ];let out=source;for(const [a,b] of edits){if(out.split(a).length!==2)throw Error('suppression.boundary');out=out.replace(a,b);}return{source:out,originalSha256:H(source),derivedSha256:H(out),edits};}
module.exports={transform};
