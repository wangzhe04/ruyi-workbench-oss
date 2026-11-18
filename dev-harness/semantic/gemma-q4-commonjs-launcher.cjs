'use strict';
// Candidate launcher is inert unless supplied a separately frozen run contract.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const H=x=>crypto.createHash('sha256').update(x).digest('hex');
function inside(base,child){const r=path.relative(base,child);return r!==''&&!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);}
function validate({root,contractFile,pin,env=process.env}){
 root=fs.realpathSync(root);if(!/^[a-f0-9]{64}$/.test(pin||''))throw Error('candidate.freeze_pin_invalid');const bytes=fs.readFileSync(contractFile);if(H(bytes)!==pin)throw Error('candidate.freeze_pin_mismatch');const c=JSON.parse(bytes);if(c.status!=='FROZEN_COMMONJS_REPLAY_BOOT'||fs.realpathSync(c.root)!==root)throw Error('candidate.freeze_scope');const marker=JSON.parse(fs.readFileSync(path.join(root,'OWNER.json')));if(marker.nonce!==c.ownerNonce||!/^([a-f0-9]{64})$/.test(marker.nonce))throw Error('candidate.owner_mismatch');
 for(const name of ['HOME','USERPROFILE','RUYI_HOME','WIN_CLAUDE_WORKBENCH_HOME','APPDATA','LOCALAPPDATA','CLAUDE_CONFIG_DIR','KIMI_CODE_HOME','CODEX_HOME','TEMP','TMP']){if(typeof env[name]!=='string'||!inside(root,fs.realpathSync(env[name])))throw Error('candidate.isolation.'+name);}
 if(env.WCW_NO_BROWSER!=='1'||env.HF_HUB_OFFLINE!=='1'||env.TRANSFORMERS_OFFLINE!=='1')throw Error('candidate.offline_required');
 const candidate=fs.readFileSync(c.bundle);if(H(candidate)!==c.bundleSha256)throw Error('candidate.bundle_changed');for(const b of c.bindings){const v=fs.readFileSync(b.file);if(v.length!==b.bytes||H(v)!==b.sha256)throw Error('candidate.binding_changed');}
 if(!Number.isInteger(c.port)||c.port<1||c.port>65535)throw Error('candidate.port_invalid');return {c,candidate};
}
function launch(){const {c,candidate}=validate({root:process.env.RUYI_RESEARCH_ROOT,contractFile:process.env.RUYI_RESEARCH_FREEZE,pin:process.env.RUYI_RESEARCH_FREEZE_SHA256});const appFile=path.resolve(c.originalAppFile);if(path.basename(appFile)!=='server.js')throw Error('candidate.virtual_filename');const m=new Module(appFile,module);m.filename=appFile;m.paths=Module._nodeModulePaths(path.dirname(appFile));process.argv=[process.execPath,appFile,'serve','--host','127.0.0.1','--port',String(c.port)];m._compile(candidate.toString('utf8')+'\nmain().catch(error=>{console.error(error.stack||String(error));process.exitCode=1;});\n',appFile);}
if(require.main===module){try{launch();}catch(e){console.error(e.stack||e);process.exitCode=1;}}module.exports={inside,validate};
