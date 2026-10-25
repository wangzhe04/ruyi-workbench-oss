'use strict';
const Module=require('node:module'),load=Module._load;
const deny=code=>function(){throw Object.assign(Error(code),{code});};
const groups=new Map([['child_process','fixture.native_forbidden'],['node:child_process','fixture.native_forbidden'],['net','fixture.socket_forbidden'],['node:net','fixture.socket_forbidden'],['tls','fixture.socket_forbidden'],['node:tls','fixture.socket_forbidden'],['dgram','fixture.socket_forbidden'],['node:dgram','fixture.socket_forbidden'],['http','fixture.socket_forbidden'],['node:http','fixture.socket_forbidden'],['https','fixture.socket_forbidden'],['node:https','fixture.socket_forbidden'],['http2','fixture.socket_forbidden'],['node:http2','fixture.socket_forbidden'],['cluster','fixture.native_or_socket_forbidden'],['node:cluster','fixture.native_or_socket_forbidden'],['worker_threads','fixture.native_or_socket_forbidden'],['node:worker_threads','fixture.native_or_socket_forbidden']]),facades=new Map();
function facade(value,code,seen=new WeakMap()){
 if(typeof value==='function')return deny(code);if(value===null||typeof value!=='object')return value;if(seen.has(value))return seen.get(value);
 const output=Array.isArray(value)?[]:Object.create(null);seen.set(value,output);
 for(const key of Reflect.ownKeys(value)){if(Array.isArray(output)&&key==='length')continue;let item;try{item=Reflect.get(value,key);}catch{item=undefined;}Object.defineProperty(output,key,{enumerable:true,configurable:false,writable:false,value:facade(item,code,seen)});}return Object.freeze(output);
}
Module._load=function(name,...args){const code=groups.get(name);if(!code)return load.call(this,name,...args);if(!facades.has(name))facades.set(name,facade(load.call(this,name,...args),code));return facades.get(name);};
if(globalThis.fetch)globalThis.fetch=deny('fixture.socket_forbidden');if(globalThis.WebSocket)globalThis.WebSocket=deny('fixture.socket_forbidden');
