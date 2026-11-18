'use strict';
function remap(ids,map){if(!ids||!map)throw Error('INVALID_MAPPING');const result=new BigInt64Array(ids.length);for(let i=0;i<ids.length;i++){const v=ids[i],n=Number(v);if(!Number.isSafeInteger(n)||n<0||n>=map.length||!Number.isInteger(map[n])||map[n]<0){const e=Error('UNSUPPORTED_TOKEN');e.code='UNSUPPORTED_TOKEN';throw e;}result[i]=BigInt(map[n]);}return result;}
module.exports={remap};
