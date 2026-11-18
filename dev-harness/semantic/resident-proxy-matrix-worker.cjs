'use strict';
// Public synthetic bytes only. no-input intentionally never opens process.stdin.
const fs=require('node:fs'),mode=process.argv[2];if(!['echo','no-input'].includes(mode))throw Error('matrix worker mode');
fs.writeSync(1,Buffer.from(JSON.stringify({type:'matrix-ready',pid:process.pid,mode,hasIPC:typeof process.send==='function'})+'\n'));setInterval(()=>{},1000);
if(mode==='echo')process.stdin.on('data',bytes=>{if(!process.stdout.write(bytes)){process.stdin.pause();process.stdout.once('drain',()=>process.stdin.resume());}});
