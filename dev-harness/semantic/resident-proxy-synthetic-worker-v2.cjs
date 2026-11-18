'use strict';
// Qualification-only worker. Its public payload is unrelated to user/model data.
const fs=require('node:fs'),mode=process.argv[2];if(!['echo','tail','busy','idle'].includes(mode))throw Error('synthetic mode');
const ready=Buffer.from(JSON.stringify({type:'synthetic-ready',pid:process.pid,mode})+'\n');fs.writeSync(1,ready);const keep=setInterval(()=>{},1000);
if(mode==='echo'){process.stdin.on('data',bytes=>{if(!process.stdout.write(bytes)){process.stdin.pause();process.stdout.once('drain',()=>process.stdin.resume());}});}
else if(mode==='tail'){process.stdin.once('data',()=>{const tail=Buffer.from(JSON.stringify({type:'synthetic-tail',value:'界'.repeat(100000)})+'\n');let at=0;while(at<tail.length)at+=fs.writeSync(1,tail,at,tail.length-at);process.exit(0);});}
else if(mode==='busy'){process.stdin.once('data',()=>{const until=Date.now()+20000;while(Date.now()<until){};});}
else process.stdin.resume();
