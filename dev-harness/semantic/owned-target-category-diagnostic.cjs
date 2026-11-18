'use strict';
// Fixed category only; rel is inspected for emptiness and never recorded.
function transform(source,file,baseNative){
 const base=baseNative.transform(source,file),edits=[
  ['  static void ResearchRejectBasic(string branch,Node node,Basic before,Basic after) {',
   '  static string ResearchObjectClass(Node node) {try {object rel=null,dir=null;if(node==null||node.Entry==null||!node.Entry.TryGetValue("rel",out rel)||!(rel is string))return "unknown";if((string)rel=="")return "root";if(!node.Entry.TryGetValue("dir",out dir)||!(dir is bool))return "unknown";return (bool)dir?"directory":"file";}catch{return "unknown";}}\n  static void ResearchRejectBasic(string branch,Node node,Basic before,Basic after) {'],
  ['{{"branch",branch},{"fields",ResearchFields(before,after)}}','{{"branch",branch},{"class",ResearchObjectClass(node)},{"fields",ResearchFields(before,after)}}'],
  ['{{"branch","held-basic"},{"fields",f}}','{{"branch","held-basic"},{"class",ResearchObjectClass(node)},{"fields",f}}']
 ];let out=base.source;for(const [i,[a,b]] of edits.entries()){if(out.split(a).length!==2)throw Error('category.boundary.'+i);out=out.replace(a,b);}return{source:out,baseEdits:base.edits,edits};
}
module.exports={transform};
