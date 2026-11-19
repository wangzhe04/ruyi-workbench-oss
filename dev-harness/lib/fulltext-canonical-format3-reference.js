'use strict';
// 150 S5 修前的 FORMAT3 canonical 切片实现,原样冻结作差分基准(由 13ap-session-fulltext-index.js @ a9b306e5 的
// canonicalText / canonicalGroups / canonicalPieces / rangeAt / slices 逐字节摘录,摘录时用 source-slice 切,不手改)。
// 用途只有一个:unit/fulltext-canonical-fast-path.test.js 在同一 Node/ICU 上把新实现与它逐字节比对 ——
// 新实现吐出的窗口(text/ranges/start/end/canonicalStart)与它任何一处不同,就意味着旧索引失效或命中错位。
// 不随产品代码更新:若 FORMAT3 真要变,必须连 FORMAT/NORMALIZER 一起升版,并另立新基准。
module.exports = function format3Reference() {
const CHARS=4096,OVERLAP=256,segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
const fail=suffix=>Object.assign(Error('session_fulltext.'+suffix),{code:'session_fulltext.'+suffix});
const canonicalText=text=>text.normalize('NFKC').toUpperCase().normalize('NFKC');
function* canonicalGroups(text){
    let tail=null;
    for(const part of segmenter.segment(text)){const incoming=canonicalText(part.segment),boundary=tail?tail.text.length:0,joined=(tail?tail.text:'')+incoming;let next=null;
      for(const unit of segmenter.segment(joined)){const from=unit.index<boundary?tail.from:part.index,to=unit.index+unit.segment.length>boundary?part.index+part.segment.length:tail.to;
        for(const normalized of segmenter.segment(canonicalText(unit.segment))){if(next)yield next;next={text:normalized.segment,from,to,linear:normalized.segment.length===1&&to-from===1};}
      }
      tail=next;
    }
    if(tail)yield tail;
  }
function* canonicalPieces(text){
    let whitespace=null;
    function* asciiParts(){for(let index=0;index<text.length;index+=CHARS)yield {text:text.slice(index,index+CHARS).toUpperCase(),from:index,to:Math.min(text.length,index+CHARS),linear:true};}
    const parts=/^[\x00-\x7f]*$/.test(text)?asciiParts():canonicalGroups(text);
    for(const part of parts){const matcher=/\s+|\S+/gu;let match;
      while((match=matcher.exec(part.text))){const blank=/^\s/u.test(match[0]),linear=part.linear,from=linear?part.from+match.index:part.from,to=linear?from+match[0].length:part.to;
        if(blank){if(whitespace)whitespace.to=to;else whitespace={from,to};continue;}
        if(whitespace){yield {text:' ',from:whitespace.from,to:whitespace.to,linear:false};whitespace=null;}
        yield {text:match[0],from,to,linear};
      }
    }
    if(whitespace)yield {text:' ',from:whitespace.from,to:whitespace.to,linear:false};
  }
function rangeAt(ranges,position){for(const run of ranges)if(position>=run[0]&&position<run[0]+run[1])return run.length===3?{from:run[2]+position-run[0],to:run[2]+position-run[0]+1}:{from:run[2],to:run[3]};throw fail('shard_invalid');}
function* slices(text){
    let buffer='',ranges=[],absolute=0,lastYield=0;
    const append=(value,from,to,linear)=>{const at=buffer.length,prior=ranges[ranges.length-1];buffer+=value;
      if(prior&&prior[0]+prior[1]===at&&prior.length===(linear?3:4)&&(linear?prior[2]+prior[1]===from:prior[2]===from&&prior[3]===to))prior[1]+=value.length;
      else ranges.push(linear?[at,value.length,from]:[at,value.length,from,to]);
    };
    const selected=end=>ranges.filter(run=>run[0]<end).map(run=>[run[0],Math.min(run[1],end-run[0]),...run.slice(2)]);
    const window=end=>{const chosen=selected(end),start=rangeAt(chosen,0).from,finish=rangeAt(chosen,end-1).to;lastYield=absolute+end;return{canonicalStart:absolute,start,end:finish,text:buffer.slice(0,end),ranges:chosen};};
    const drop=count=>{buffer=buffer.slice(count);ranges=ranges.filter(run=>run[0]+run[1]>count).map(run=>{const begin=Math.max(run[0],count),length=run[0]+run[1]-begin;return run.length===3?[begin-count,length,run[2]+begin-run[0]]:[begin-count,length,run[2],run[3]];});absolute+=count;};
    for(const part of canonicalPieces(text)){for(let offset=0;offset<part.text.length;){const count=Math.min(CHARS+1-buffer.length,part.text.length-offset),value=part.text.slice(offset,offset+count);append(value,part.linear?part.from+offset:part.from,part.linear?part.from+offset+count:part.to,part.linear);offset+=count;
        if(buffer.length>CHARS){let end=CHARS;if(/[\uDC00-\uDFFF]/.test(buffer[end]))end--;yield window(end);let count=end-OVERLAP;if(/[\uDC00-\uDFFF]/.test(buffer[count]))count--;drop(count);}
      }}
    if(buffer.length&&absolute+buffer.length>lastYield)yield window(buffer.length);
  }
return {pieces:text=>Array.from(canonicalPieces(text)),windows:text=>Array.from(slices(text))};
};
