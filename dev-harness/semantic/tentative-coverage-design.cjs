'use strict';
// Static feasibility receipt only. No source transformation or live execution.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function main(output){if(fs.existsSync(output))throw Error('Use new output');const producer=fs.readFileSync('ruyi-workbench/app/src/13ap-session-fulltext-index.js','utf8'),consumer=fs.readFileSync('ruyi-workbench/app/src/13as-session-fulltext-consumers.js','utf8');
 if(hash(producer)!=='90a0191d29307ba1f5582f4073bb7a01dc311f5a72481bbc06b01ee3a084a15f'||hash(consumer)!=='67deb8fbb314749ae2befdd3cc7660661a55f930d13ff4a72889a63c5a73f889')throw Error('Analyzed sources changed');
 const report={status:'STATIC_FEASIBLE_ONLY_WITH_PRIVATE_TICKET_AND_STRONGER_FINAL_PROOF_NOT_IMPLEMENTED',nativeStarts:0,productionChanged:false,
 bindings:['13ap-session-fulltext-index.js','13as-session-fulltext-consumers.js','02-session-store.js'].map(name=>{const file=path.resolve('ruyi-workbench/app/src',name);return {file,sha256:hash(fs.readFileSync(file))};}),
 existingFacts:[
  'scanIndex authenticates each compatible current manifest and verifies referenced shard hash/shape before storing a per-search manifests Map. Original-source resolver and beforeEncode remain authoritative for actual encoder text.',
  'Normal enabled searchOnce always reaches index.revalidate even with zero results, empty eligible pool, paused index, metadata strong hits. First pending result may be replaced by a new index.search after preparation.',
  'Short query and feature-off do not enter the index. Deadline catch returns no results plus incomplete/partial coverage and does not call index.revalidate.',
  'Existing revalidate reads fresh currentManifest for every observed sid but compares only generation. A same-generation manifest-field change is not sufficient to trigger changed. Fresh catalog membership is not currently compared there.',
  'Audited scan-stat consumer runs key/stat asynchronous validation before original final fresh source epochs. No additional asynchronous operation may be appended after that final source validation.'
 ],
 privateProtocol:{
  surface:'Prefer a private staged-search port installed synchronously into the actual13as closure by the trusted bind callback. Do not add a boolean/marker opt-in to public index.search. Public search/coverage/prepare remain entirely fresh. The installed port itself never appears in returned index API or DTO.',
  issuer:'Actual13as private closure: WeakMap ticket -> current issued capability and per-search state. Ticket is a frozen empty object; never DTO, option boolean, JSON field or user token.',
  producerAuthority:'Only that private port can invoke the internal staged search core. A trusted disclosure-host callback additionally recognizes the exact live private context/access/attempt. Caller options, fake tickets or copied result fields cannot activate reuse. No public staged method is returned.',
  lifecycle:'One invocation one ticket. Issue after valid query/enabled checks; discard before prepare/replacement or retry; reject use after cap close. Track issued/running/validated/aborted state, preserve cancellation/security errors.',
  snapshot:'Private per-search immutable scanIndex manifest snapshot only; no cross-request Map or TTL. For a sid without a complete snapshot and matching genuine complete source-stat witness, read original currentManifest.',
  eligibility:['compatible manifest','attachments exactly0','full real source scan statistic proof with no unknown/unverified members','same generation/epoch/sourceRevision/source sequence','current scope and authorize assertions','current actual credential witness/mode and fresh source epoch validation retain their existing calls'],
  excluded:'Metadata-only or absent/incompatible manifest, attachment-bearing source, unknown count, incomplete scan, missing credential witness, unauthorized source and new catalog members all retain the original full fresh path.',
  provisional:'Only internal coverage used by the same search computation is tentative. No provisional complete/TN DTO may escape. Internal result exposes incomplete/partial coverage until final validation; actual complete coverage and semantic coverage live in the result WeakMap.',
  final:'Keep every existing revalidate fresh read. For used snapshots additionally compare canonical/full validated manifest content, not merely generation; preserve all current fields and shard declarations. Freshly compare catalog membership to the observed coverage catalog and reject changed membership. Alias/decrypt/permission failures remain original failures.',
  publish:'Private verify returns changed/opaque validation receipt, never complete coverage. After existing final key/source epoch/sequence/scope/PG and mutation serial/active checks, consumer marks that exact attempt final-checked and invokes a synchronous private commit. Only commit creates the published coverage copy. Existing last-async-source-check -> synchronous assert/commit -> sink ordering is unchanged.',
  sameCap:'Starting another search invalidates the earlier attempt even in the same capability. Old result/old validation receipt cannot revalidate, commit, finish or emit. Bind returned actual search DTO objects to their attempt in a private WeakMap; no JSON equality or fields-based substitution.',
  dirtyRetry:'privacy.disclosure_dirty aborts the whole current ticket before disclosures are cleared. The next pass gets a fresh ticket and scan snapshot, never the previous validated flag.',
  catalog:'Capture sorted validated unique source IDs at scanIndex and each real coverage traversal. The final fresh catalog must have the same membership as the actual coverage snapshot; add/delete rejects to incomplete/no-results. Reordering alone is canonical-sort equivalent; alias/duplicate/invalid IDs fail original catalog validation. No stale list silently drops a newly visible source.',
  sinkMapping:'Audit actual emitUI/finish call sites: if a trusted caller clones/maps the search DTO before the sink, preserve its attempt only via a private projection helper/observer, never an exposed marker. An untracked clone must not inherit complete tentative coverage. This must be tested before claiming every model/UI destination is covered.',
  timeout:'Abort/discard the ticket; no candidate from that tentative proof is returned. Original deadline report remains no-results + incomplete/partial, never a true negative. No late commit or background work.',
  atomicBoundary:'This remains the existing in-flight per-owner snapshot contract, not an OS filesystem transaction. Fresh catalog/source observations cannot promise absence of external changes after their final observation. Do not introduce a source-check/key-check retry loop.'
 },
 branchAudit:[
  {branch:'normal enabled + hits',finalRevalidate:true,ticket:'one current attempt, publish only after full final'},
  {branch:'enabled + no hits or all semantic rejected',finalRevalidate:true,ticket:'same; only post-validation complete may be a true negative'},
  {branch:'enabled + ID-empty eligible pool',finalRevalidate:true,ticket:'only eligible manifest/stat snapshots; original deterministic-empty semantics preserved'},
  {branch:'metadata strong result',finalRevalidate:true,ticket:'metadata field itself is not snapshot-optimized; body statistics may be tentative only'},
  {branch:'pending source -> prepare -> replacement search',finalRevalidate:true,ticket:'discard first; prepare unchanged; new ticket/snapshot for replacement'},
  {branch:'two searches in one cap / old result replay',finalRevalidate:'latest only',ticket:'new attempt invalidates old before asynchronous work; old verify/commit/emit is rejected'},
  {branch:'paused index',finalRevalidate:true,ticket:'never issue; retain original full fresh reads and paused report'},
  {branch:'query too short / index disabled',finalRevalidate:false,ticket:'never issued'},
  {branch:'deadline before revalidate',finalRevalidate:false,ticket:'discard all pending; incomplete/partial no-results report only'},
  {branch:'privacy dirty retry / any hard source error',finalRevalidate:'retry or throw',ticket:'abort attempt; do not reuse private snapshot in next pass'},
  {branch:'public coverage / prepare / direct index.search',finalRevalidate:'caller not guaranteed',ticket:'no valid authority; unchanged original reads'}
 ],
 mandatoryAdversaries:[
  'same-generation manifest changes: attachments/chunks/messages/sourceRevision/epoch/shards; final must reject changed full snapshot',
  'manifest delete, malformed replacement, hardlink/symlink/namespace alias; no stale result/complete DTO',
  'catalog addition/deletion captured between scan and validation; fail changed membership instead of omitting unknown source',
  'body/head valid external rewrite/delete with source sequence unchanged; final owner epoch rejection',
  'wrong key, actual decode lease ABA, mode/lock/revocation/cancel reason0; no availability downgrade',
  'malformed or externally redirected index shard never becomes raw encoder text; original shard hash/shape and authenticated resolver/beforeEncode remain',
  'empty eligible, no result, metadata-only strong, partial/unsupported, attachment, paused, preparation retry, deadline after tentative search',
  'direct search/coverage/prepare with fake marker retains original fresh reads; no marker or private digest in public/model DTO',
  'same cap sequential/concurrent searches, old result/old validation replay, privacy.disclosure_dirty retry and tracked/untracked sink mapping',
  'timeout/throw at each staged boundary: only explicit deadline may produce empty incomplete report; authority/source/permission/falsy cancellation errors remain original throw, never a true negative',
  'guard/epoch/source sequence/PG/mutation retirement races and actual last-async source disclosure race remain rejected'
 ],
 expectedCost:'On the frozen warm60-body-source diagnostic only, at most120 manifest reads may be removed: preCoverage60 and finalCoverage60. Initial scanIndex60 and final fresh revalidate60 remain. Do not claim240->120 when sid eligibility/stat witnesses/exclusions cause fallback.',
 nextStep:'Root review of this proof/DTO contract before any new transform. Keep sequence memo r2 independently frozen; first compare snapshot optimization without combining it.'};
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,sha256:hash(fs.readFileSync(output)),status:report.status}));return report;
}
if(require.main===module)main(process.argv[2]||'output/semantic-tentative-coverage-design-r2.json');module.exports={main};
