'use strict';
// A small in-memory DOM recorder for module event/state controls. It is not a
// browser and makes no layout, native dialog, accessibility-tree or pixel claim.
const vm=require('node:vm');
const {fixture:frontend,moduleBody}=require('./media-image-frontend-fixture');
async function fixture(options={}) {
  const f=await frontend(options);await f.prepareProtectedImages([f.record],f.state.currentSession.id);
  let doc;
  class Node {
    constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.attributes={};this.style={};this.dataset={};this.complete=true;this.naturalWidth=32;this.value='';}
    append(...nodes){for(const node of nodes){if(typeof node==='string')continue;node.parentNode=this;this.children.push(node);}}
    appendChild(node){this.append(node);return node;}
    replaceChildren(...nodes){for(const child of this.children)child.parentNode=null;this.children=[];this.append(...nodes);}
    setAttribute(name,value){this.attributes[name]=value;}
    addEventListener(name,callback){(this.listeners[name]||=[]).push(callback);}
    emit(name,event={}){for(const callback of this.listeners[name]||[])callback({preventDefault(){},...event});}
    remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(node=>node!==this);this.parentNode=null;}}
    get isConnected(){return this===doc.body||!!this.parentNode?.isConnected;}
    focus(){if(!this.disabled)doc.activeElement=this;}
    querySelectorAll(tag){return this.children.flatMap(node=>[...(node.tagName===tag?[node]:[]),...node.querySelectorAll(tag)]);}
    querySelector(tag){return this.querySelectorAll(tag)[0]||null;}
    showModal(){this.open=true;}
    close(){this.open=false;this.emit('close');}
    getBoundingClientRect(){return{left:20,top:30,width:320,height:160};}
    setPointerCapture(id){this.capture=id;}
    releasePointerCapture(id){if(this.capture===id)this.capture=null;}
    reportValidity(){return this.querySelectorAll('input').every(input=>input.value!==''&&Number.isFinite(Number(input.value)));}
    requestSubmit(){this.onsubmit?.({preventDefault(){}});}
  }
  doc={body:new Node('body'),activeElement:null,createElement:tag=>new Node(tag),querySelectorAll:()=>[]};
  const trigger=new Node('button');doc.body.append(trigger);trigger.focus();
  const timers=new Map(),notifications=[];
  const el=(tag,className='',text='')=>{const node=new Node(tag);node.className=className;node.textContent=text;return node;};
  const sandbox={...f,document:doc,el,toast:(...args)=>notifications.push(args),t:(key,params)=>key+(params?JSON.stringify(params):''),AbortController,
    setInterval:callback=>{const id={};timers.set(id,callback);return id;},clearInterval:id=>timers.delete(id)};
  const open=vm.runInNewContext(moduleBody('image-region-editor.js')+';openImageRegionEditor;',sandbox,{filename:'image-region-editor.js'});
  const dialog=()=>doc.body.children.find(node=>node.tagName==='dialog');
  const button=key=>dialog()?.querySelectorAll('button').find(node=>node.textContent===key);
  const fill=(values)=>dialog().querySelectorAll('input').forEach((node,index)=>node.value=String(values[index]));
  const settle=async()=>{
    for(let n=0;n<1000&&dialog()?.attributes['aria-busy']==='true';n++)await new Promise(resolve=>setTimeout(resolve,1));
    if(dialog()?.attributes['aria-busy']==='true')throw Error('DOM recorder preparation did not settle');
  };
  return{...f,document:doc,trigger,timers,notifications,open:()=>open(f.record),dialog,button,fill,settle,tick:()=>{for(const callback of [...timers.values()])callback();}};
}
module.exports={fixture};
