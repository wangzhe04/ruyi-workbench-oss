// Original, narrow compatibility layer. This is not a filesystem boundary.
import fs,{realpathSync as namedRealpath} from 'node:fs';
import path from 'node:path';
import {createRequire,syncBuiltinESMExports} from 'node:module';
const require=createRequire(import.meta.url);
function comparable(value){if(process.platform==='win32'&&/^\\\\\?\\[A-Za-z]:\\/.test(value))value=value.slice(4);const normalized=path.resolve(value);return process.platform==='win32'?normalized.toLowerCase():normalized;}
function encodingOf(options){
  if(options===undefined||options===null)return 'utf8';
  if(typeof options==='string')return ['utf8','utf-8','buffer'].includes(options)?options:null;
  if(typeof options!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(options)))return null;
  const descriptor=Object.getOwnPropertyDescriptor(options,'encoding');if(!descriptor)return 'encoding' in options?null:'utf8';
  if(!Object.hasOwn(descriptor,'value'))return null;return descriptor.value===undefined?'utf8':['utf8','utf-8','buffer'].includes(descriptor.value)?descriptor.value:null;
}
export function createOwnedRealpath(original,ownedRoot,observe=null){
  if(typeof original!=='function'||typeof original.native!=='function'||typeof ownedRoot!=='string'||!path.isAbsolute(ownedRoot))throw new Error('owned-native-realpath-required');
  const native=original.native,root=comparable(ownedRoot),within=value=>{const normalized=comparable(value);return normalized===root||normalized.startsWith(root+path.sep);};
  const wrapper=function(...args){
    let originalError;try{return Reflect.apply(original,this,args);}catch(error){originalError=error;}
    const input=args[0];if(!['EPERM','EACCES'].includes(originalError?.code)||typeof input!=='string'||input.includes('\0'))throw originalError;
    let encoding;try{encoding=encodingOf(args[1]);}catch{throw originalError;}
    if(encoding===null||!within(input))throw originalError;
    const event=(operation,errorCode=null)=>{if(typeof observe==='function')try{observe({operation,input,errorCode});}catch{}};
    event('owned-regular-denied',originalError.code);
    let result;try{result=Reflect.apply(native,this,args);}catch(error){event('owned-native-error',error?.code||error?.name||'unknown');throw error;}let canonical;
    if(encoding==='buffer'){if(!Buffer.isBuffer(result))throw originalError;canonical=result.toString('utf8');if(!Buffer.from(canonical,'utf8').equals(result))throw originalError;}
    else {if(typeof result!=='string')throw originalError;canonical=result;}
    if(!path.isAbsolute(canonical)||!within(canonical)){event('owned-native-escape',originalError.code);throw originalError;}
    event('owned-native-success');
    return result;
  };
  Object.assign(wrapper,original);wrapper.native=native;return wrapper;
}
export function installOwnedRealpath(ownedRoot,observe=null){
  const original=fs.realpathSync;
  // A host-frozen, non-reparse projection must resolve to the same actual root.
  if(typeof ownedRoot!=='string'||!path.isAbsolute(ownedRoot)||typeof original.native!=='function'||comparable(original.native(ownedRoot))!==comparable(ownedRoot))throw new Error('owned-native-root-mismatch');
  const wrapper=createOwnedRealpath(original,ownedRoot,observe);fs.realpathSync=wrapper;
  let esmSyncSucceeded=true;try{syncBuiltinESMExports();}catch{esmSyncSucceeded=false;}
  return {installed:true,esmSyncSucceeded,namedBindingMatched:namedRealpath===wrapper,requireBindingMatched:require('node:fs').realpathSync===wrapper};
}
