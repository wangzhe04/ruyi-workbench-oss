'use strict';
// Orthographic script, not inferred language or domain. Freeze before measuring
// stratified scores. Digits/punctuation are ignored; other scripts count toward
// the denominator, so they cannot silently become Latin/CJK.
function scriptClass(value){let letters=0,han=0,latin=0;for(const char of String(value).normalize('NFKC'))if(/\p{L}/u.test(char)){letters++;if(/\p{Script=Han}/u.test(char))han++;else if(/\p{Script=Latin}/u.test(char))latin++;}if(han>=2&&han/letters>=.8)return'cjk';if(latin>=3&&latin/letters>=.8)return'latin';return'uncertain';}
function pairScript(query,document){const q=scriptClass(query),d=scriptClass(document);return q==='uncertain'||d==='uncertain'?'uncertain':q===d?'same':'cross';}
module.exports={id:'dominant-unicode-script-80-v1',scriptClass,pairScript};
