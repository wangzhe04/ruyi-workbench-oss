'use strict';
const rules=require('./calibration-content-rules.json');
const english=new Set(rules.english),escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const chinese=new RegExp(rules.chinese.slice().sort((a,b)=>b.length-a.length).map(escape).join('|'),'g');
function contentQuery(query){
 const text=String(query).normalize('NFKC');
 // Protect literal spans structurally before removing any function words. A
 // code such as WHAT-91 must survive even though WHAT is an interrogative.
 const protectedPattern=/\b(?=[a-z0-9:_-]*[a-z])(?=[a-z0-9:_-]*\d)[a-z0-9]+(?:[-_:][a-z0-9]+)*\b|[-+]?\d+(?:[.,:/-]\d+)*(?:%|‰)?/gi;
 const clean=value=>value.replace(chinese,' ').replace(/\b[a-z]+(?:['’][a-z]+)*\b/gi,word=>english.has(word.toLowerCase())?' ':word);
 let result='',at=0;for(const match of text.matchAll(protectedPattern)){result+=clean(text.slice(at,match.index))+match[0];at=match.index+match[0].length;}result+=clean(text.slice(at));
 result=result.replace(/[吗呢呀吧](?=[?？!！。]*$)/u,' ').replace(/[?？!！。]+/g,' ').replace(/\s+/g,' ').trim();
 if(!/[\p{L}\p{N}]/u.test(result))result='';
 return{text:result,changed:result!==text,policyId:rules.id};
}
module.exports={contentQuery,rules};
