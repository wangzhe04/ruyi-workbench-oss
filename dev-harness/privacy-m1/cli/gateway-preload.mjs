// Node public --import entry; no official CLI code is changed.
import net from 'node:net';
import {once} from 'node:events';
import {createFetchAdapter,writePipeFrame} from './fetch-adapter.mjs';
const pipe=process.env.RUYI_M1_PIPE;
if(!/^\\\\\.\\pipe\\LOCAL\\ruyi\.m1\.[a-f0-9]{32}$/.test(pipe||''))throw new Error('owned-pipe-required');
const socket=net.connect(pipe);socket.setEncoding('utf8');await once(socket,'connect');socket.unref();
let pending=null,buffer='';
function fail(){if(pending){const {reject,timer,signal,abort}=pending;pending=null;clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new Error('broker-transport-closed'));}socket.destroy();}
socket.on('error',fail);socket.on('close',fail);
socket.on('data',chunk=>{buffer+=chunk;if(Buffer.byteLength(buffer)>400000){fail();return;}const index=buffer.indexOf('\n');if(index<0)return;
  const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!pending||buffer.trim()){fail();return;}let reply;try{reply=JSON.parse(line);}catch{fail();return;}
  const {resolve,timer,signal,abort}=pending;pending=null;clearTimeout(timer);signal.removeEventListener('abort',abort);socket.unref();resolve(reply);
});
globalThis.fetch=createFetchAdapter((request,signal)=>new Promise((resolve,reject)=>{
  try{signal.throwIfAborted();}catch(error){reject(error);return;}
  if(pending||socket.destroyed){reject(new Error('broker-unavailable'));return;}
  const abort=()=>fail(),timer=setTimeout(fail,12000);pending={resolve,reject,timer,signal,abort};signal.addEventListener('abort',abort,{once:true});socket.ref();try{writePipeFrame(socket,request,signal);}catch{fail();}
}));
