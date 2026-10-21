import {installOwnedRealpath} from './claude-realpath.mjs';
console.log(JSON.stringify({kind:'claude-realpath-compat',...installOwnedRealpath(process.env.RUYI_M1_PROJECTION)}));
console.log(JSON.stringify({kind:'claude-runtime-preload',runtime:typeof Bun==='object'?'Bun':'other',version:typeof Bun==='object'?Bun.version:null}));
