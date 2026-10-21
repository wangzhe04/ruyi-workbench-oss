import crypto from 'node:crypto';
import {installOwnedRealpath} from './claude-realpath.mjs';
let phase='compat-preflight',emitted=0;
const observe=value=>{if(emitted++>=32)return;console.log(JSON.stringify({kind:'claude-fs-diagnostic',operation:value.operation,phase,pathClass:'projection',pathSha256:crypto.createHash('sha256').update(value.input).digest('hex'),ok:value.operation==='owned-native-success',errorCode:value.errorCode}));};
console.log(JSON.stringify({kind:'claude-realpath-compat',...installOwnedRealpath(process.env.RUYI_M1_PROJECTION,observe)}));
await import('./claude-diagnostic.mjs');
phase='application';
