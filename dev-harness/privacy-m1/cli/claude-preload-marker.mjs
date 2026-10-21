// Original marker only. This never replaces the official application's entrypoint.
console.log(JSON.stringify({kind:'claude-runtime-preload',runtime:typeof Bun==='object'?'Bun':'other',version:typeof Bun==='object'?Bun.version:null}));
