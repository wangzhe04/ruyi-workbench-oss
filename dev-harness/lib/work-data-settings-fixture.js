'use strict';
// Source module + DOM event/tree fixture. This verifies actual UI handlers and
// request outcomes; it is not a layout/accessibility browser verification.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/public/js/work-data-settings.js'),'utf8');
function fixture(respond){
 const calls=[],timers=new Map(),listeners=new Map();let serial=0,locale='en-US';
 class Element{
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.events=new Map();this.value='';this.disabled=false;this.hidden=false;this.checked=false;this._text='';this.parentNode=null;this.className='';this.classList={add:(...names)=>{this.className=[...new Set([...this.className.split(' ').filter(Boolean),...names])].join(' ');}};}
  append(...items){for(const item of items){this.children.push(item);item.parentNode=this;if(this.tagName==='SELECT'&&!this.value&&item.tagName==='OPTION')this.value=item.value;}}
  replaceChildren(...items){this.children=[];this._text='';this.append(...items);}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(x=>x.textContent||'').join('');}
  setAttribute(key,value){this.attributes[key]=String(value);}
  getAttribute(key){return this.attributes[key];}
  addEventListener(key,handler){if(!this.events.has(key))this.events.set(key,[]);this.events.get(key).push(handler);}
  removeEventListener(key,handler){this.events.set(key,(this.events.get(key)||[]).filter(fn=>fn!==handler));}
  dispatchEvent(event){for(const handler of this.events.get(event.type)||[])handler(event);return !event.defaultPrevented;}
  querySelectorAll(selector){const rows=[];const visit=e=>{for(const child of e.children){if(selector==='[data-i18n]'&&child.dataset.i18n||selector==='input'&&child.tagName==='INPUT'||selector==='form'&&child.tagName==='FORM')rows.push(child);visit(child);}};visit(this);return rows;}
 }
 const host=new Element('section');host.id='workDataSettings';
 const find=id=>{const walk=e=>e.id===id?e:e.children.map(walk).find(Boolean);return walk(host);};
 const document={getElementById:find,createElement:tag=>new Element(tag)};
 const window={addEventListener:(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn)};
 const dictionaries=Object.fromEntries(['en-US','zh-CN'].map(lang=>[lang,JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/public/locales',lang+'.json'),'utf8'))]));
 const t=(key,params={})=>{let value=dictionaries[locale][key]||key;for(const[k,v]of Object.entries(params))value=value.replaceAll('{{'+k+'}}',String(v));return value;};
 const api=async(route,options={})=>{const body=options.body?JSON.parse(options.body):null;calls.push({route,method:options.method||'GET',body});return respond(route,options,body,calls);};
 const context={document,window,WeakMap,Set,TextEncoder,api,t,apiErrorInfo:error=>({code:error?.error?.code||error?.code||(error?.name==='TypeError'?'net.disconnected':'')}),setTimeout:fn=>{const id=++serial;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
  localStorage:{setItem(){throw Error('UI stored a secret');}},sessionStorage:{setItem(){throw Error('UI stored a secret');}}};
 const mount=vm.runInNewContext(source.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nmountWorkDataSettings;',context);
 const panel=mount();
 const event=type=>({type,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}});
 const flush=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
 return {panel,mount,host,find,calls,timers,flush,change(id,value,type='input'){const e=find(id);if(typeof value==='boolean')e.checked=value;else e.value=value;e.dispatchEvent(event(type));},click(id){const e=find(id);if(!e.disabled)e.dispatchEvent(event('click'));},async poll(){const first=timers.entries().next().value;if(first){timers.delete(first[0]);first[1]();await flush();}},language(lang){locale=lang;for(const fn of listeners.get('i18n:change')||[])fn();}};
}
const authority=(mode='plain')=>({generation:mode==='plain'?0:1,id:mode==='plain'?null:'b'.repeat(48),mode,sha256:mode==='plain'?null:'c'.repeat(64)});
const job=(extra={})=>({id:'a'.repeat(48),operation:'enable',state:'draining',createdAt:'2026-10-24T00:00:00Z',cancellable:true,takeover:false,retry:false,error:null,operationMayHaveExecuted:false,...extra});
const status=(extra={})=>({ok:true,authority:authority(),configMirror:false,maintenance:{phase:'open'},job:null,lastResult:null,capabilities:{worker:true,upload:false,download:false},processRestartRequired:true,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
module.exports={fixture,authority,job,status,deferred};
