'use strict';
// Data-only cache identity canonicalization. No score signer or registry is public.
const invalid=()=>Error('semantic.score_evidence_invalid');
function identity(value){if(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);if(Array.isArray(value)&&value.length<=64&&value.every(v=>v===null||['string','boolean'].includes(typeof v)||typeof v==='number'&&Number.isFinite(v)))return JSON.stringify(value);throw invalid();}
module.exports={identity};
