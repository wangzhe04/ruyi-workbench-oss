'use strict';
// Deterministic, version-pinned adaptation of the Apache-2.0 Transformers.js build.
// Text tokenization/inference code is unchanged. Image operations explicitly fail.
const crypto=require('node:crypto');
const target='@huggingface/transformers/dist/transformers.node.mjs';
const upstreamSha256='ee3b84624fee88b9db4b85be1fbfde1e2637957ee92eaaaaa720edbca5448e6c';
const adaptedSha256='0f74bee1213b810d6f0c44996fff13980429f933ab59eb5e7fdcd087d26f96d8';
const from='import * as __WEBPACK_EXTERNAL_MODULE_sharp__ from "sharp";';
const to='// Ruyi text-only build: image operations are unavailable; original Apache-2.0 license retained.\nconst __WEBPACK_EXTERNAL_MODULE_sharp__ = Object.freeze({ default: () => { throw new Error("RUYI_TEXT_ONLY_RUNTIME"); } });';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function transform(relative,bytes){
 if(relative!==target)return bytes;
 const digest=sha(bytes);if(digest===adaptedSha256)return bytes;
 if(digest!==upstreamSha256)throw Error('TEXT_RUNTIME_UPSTREAM_MISMATCH');
 const text=bytes.toString('utf8');if(text.split(from).length!==2)throw Error('TEXT_RUNTIME_PATCH_MISMATCH');
 const result=Buffer.from(text.replace(from,to));if(sha(result)!==adaptedSha256)throw Error('TEXT_RUNTIME_PATCH_MISMATCH');return result;
}
module.exports={transform,target,upstreamSha256,adaptedSha256};
