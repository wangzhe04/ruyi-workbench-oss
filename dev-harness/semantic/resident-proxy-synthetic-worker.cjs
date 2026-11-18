'use strict';
// Public synthetic Win32 Job qualification worker. No model or user content.
const mode=process.argv[2]||'echo',allowed=new Set(['echo','block-input','busy','flood-output','flood-stderr','delayed-ready']);if(!allowed.has(mode))throw Error('unknown synthetic worker mode');
const ready=()=>process.stdout.write(JSON.stringify({type:'synthetic-ready',pid:process.pid,mode,publicText:'resident proxy synthetic lifecycle qualification'})+'\n');
if(mode==='delayed-ready')setTimeout(ready,750);else ready();
const keep=setInterval(()=>{},1000);
if(mode==='busy'){const until=Date.now()+20000;while(Date.now()<until){};}
else if(mode==='block-input')process.stdin.pause();
else if(mode==='flood-output'||mode==='flood-stderr'){const stream=mode==='flood-output'?process.stdout:process.stderr,bytes=Buffer.alloc(16384,mode==='flood-output'?120:101);function pump(){let count=0;while(count++<8){if(!stream.write(bytes)){stream.once('drain',pump);return;}}setImmediate(pump);}pump();}
else {process.stdin.on('data',bytes=>{if(!process.stdout.write(bytes)){process.stdin.pause();process.stdout.once('drain',()=>process.stdin.resume());}});process.stdin.once('end',()=>{clearInterval(keep);process.stdout.end();});}
