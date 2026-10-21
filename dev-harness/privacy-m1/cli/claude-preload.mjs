// Relative BUN_OPTIONS preload. This import completes before the official entrypoint.
if(process.env.RUYI_M1_REALPATH_COMPAT!==undefined){
  if(process.env.RUYI_M1_REALPATH_COMPAT!=='owned-native-on-permission-error')throw new Error('realpath-compat-mode-denied');
  const {installOwnedRealpath}=await import('./claude-realpath.mjs');
  console.log(JSON.stringify({kind:'claude-realpath-compat',...installOwnedRealpath(process.env.RUYI_M1_PROJECTION)}));
}
await import('./gateway-preload.mjs');
console.log(JSON.stringify({kind:'claude-runtime-preload',runtime:typeof Bun==='object'?'Bun':'other',version:typeof Bun==='object'?Bun.version:null,gatewayConnected:true}));
