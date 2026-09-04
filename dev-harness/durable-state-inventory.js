'use strict';
// 103c durable data surface inventory. This file is the auditable source; JSON/Markdown are generated views.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');
const JSON_OUT = path.join(ROOT, 'docs', 'architecture', 'durable-state-inventory.json');
const MD_OUT = path.join(ROOT, 'docs', 'architecture', 'durable-state-inventory.md');

const DEDICATED = 'dedicated-exemption';
const EXTERNAL = 'external-exemption';
const REBUILD = 'regenerable-exemption';
const SHARED = 'shared-lifecycle';

const entries = [
  ['config','<data>/config.json','01-config.js','paths.config','object / configSchema 7','atomicWriteJson + serialized chain','normalize; parse failure falls back (legacy behavior)','bounded fields in normalizeConfig','uncached by contract','defaults + migration rewrite','shared atomic write; read lifecycle retained until direct-test writes gain mtime invalidation',SHARED],
  ['runtime-handshake','<data>/runtime.json','13-http-router.js',"'runtime.json'",'ephemeral object','atomicWriteJson','next boot replaces','one record','RUNTIME memory is authority','restart server','boot handshake is intentionally ephemeral',SHARED],
  ['last-start-error','<data>/last-start-error.json','13-http-router.js',"'last-start-error.json'",'object / implicit v1','atomicWriteJson','unknown kind or unparsable is dropped (no notice shown)','one record','START_NOTICE holds the consumed copy for this process','the next failed start rewrites it','118c one-shot boot notice: written only when a start fails, read once on the next successful start and deleted immediately',REBUILD],
  ['usage-ledger','<data>/usage/YYYY-MM.jsonl','00-boot.js',"'.jsonl'",'NDJSON rows','appendFile through usage chain','bad rows skipped by readers','monthly partition + storage policy','none','retain valid rows; append continues','append-only ledger cannot use whole-file JSON replacement',DEDICATED],
  ['audit-log','<data>/logs/workbench-YYYY-MM-DD.ndjson','04-permission-runtime.js','workbench-','NDJSON events','single append stream','bad rows ignored by audit readers','logsKeepDays','open stream','rotate by day','append stream and rotation are dedicated protocols',DEDICATED],
  ['claude-settings','~/.claude/settings.json','01-config.js',"'settings.json'",'external object','atomicWriteJson after merge','invalid external file treated as empty','owned keys only','none','Claude keeps primary semantics','externally owned merge target; sidecar proves field ownership',EXTERNAL],
  ['claude-settings-sidecar','<data>/claude-settings-sync.json','01-config.js',"'claude-settings-sync.json'",'object / implicit v1','atomicWriteJson','missing means conservative no-delete','one record','none','recreated on next sync','small shared-atomic ownership sidecar',SHARED],
  ['kimi-mcp','~/.kimi-code/mcp.json','01-config.js',"'mcp.json'",'external object','atomicWriteJson after merge','invalid external file treated as empty','managed IDs only','none','Kimi retains built-ins','externally owned merge target; sidecar proves server ownership',EXTERNAL],
  ['kimi-mcp-sidecar','<data>/kimi-mcp-sync.json','01-config.js',"'kimi-mcp-sync.json'",'object / implicit v1','atomicWriteJson','missing means no managed IDs','one record','none','recreated on next sync','small shared-atomic ownership sidecar',SHARED],
  ['generated-mcp','<data>/generated/workbench.mcp[.<session>].json','01-config.js','workbench.mcp.','generated object','atomicWriteJson','regenerate','global + per active session','none','generateMcpConfig','derived launcher input',REBUILD],
  ['session-head','<data>/sessions/<id>.json','02-session-store.js','sessionPath(id)','object / storageVersion 2','atomicWriteJson + per-session chain','rename to .corrupt on invalid','one per session','session cache/index','load v1 backup or reconstruct v2 head','session v2 head has dedicated migration and body coordination',DEDICATED],
  ['session-messages','<data>/sessions/<id>.messages.ndjson','02-session-store.js','.messages.ndjson','NDJSON messages','append whole newline records','ignore torn tail; reject corrupt interior','message count in head','loaded per request','v1 backup / head counts','append-only session v2 body protocol',DEDICATED],
  ['session-provider','<data>/sessions/<id>.provider.ndjson','02-session-store.js','.provider.ndjson','NDJSON provider history','append whole newline records','ignore torn tail; reject corrupt interior','count in head','loaded per request','v1 backup / head counts','append-only session v2 body protocol',DEDICATED],
  ['session-interventions','<data>/sessions/<id>.interventions.ndjson','02-session-store.js','.interventions.ndjson','NDJSON command journal','serialized append + compaction','degraded flag and corrupt-row count','compaction threshold','none','replay valid commands','authoritative append/CAS journal',DEDICATED],
  ['session-changes','<data>/sessions/<id>.changes.ndjson','02-session-store.js','.changes.ndjson','NDJSON change records','serialized append','bad rows isolated from valid rows','session lifecycle','none','replay valid rows','append-only change audit',DEDICATED],
  ['session-index','<data>/sessions/index.json','02-session-store.js','SESSION_INDEX_FILE','array / implicit v1','atomicWriteJson; unique sync tmp on exit','rebuild from session heads','one row per session','Map + dirty/debounce','full disk scan','exit-time synchronous flush is an explicit exemption',DEDICATED],
  ['session-search-index','<data>/sessions/_search-index-v1.json','13d-core-domain-routes.js',"SESSION_SEARCH_INDEX_FILE",'object / version 1','atomicWriteJson','missing or wrong version rebuilds from scratch','one 4KB unit per session','entries kept in memory for the current request only','rebuild by re-extracting units from session bodies','fully derived search cache: every byte is recomputable from session NDJSON bodies',REBUILD],
  ['session-v1-backup','<data>/sessions/<id>.json.v1bak','02-session-store.js',"'.v1bak'",'legacy session object','COPYFILE_EXCL','never overwrite','one per migrating session','none','restore legacy session','migration rollback artifact',DEDICATED],
  ['journal-index','<data>/sessions/<id>.journal/index.json','02-session-store.js','journalIndexPath','array / implicit v1','atomicWriteJson','rebuild from journal files','journal size cap','journal GC cache','directory scan','coordinated checkpoint journal protocol',DEDICATED],
  ['journal-history','<data>/sessions/<id>.journal/history-*.json.gz','10-context-governance.js','history-','gzip JSON','binary write','drop unreadable snapshot','journal cap','none','other checkpoints/session history','compressed binary is not a JSON-file lifecycle',DEDICATED],
  ['kimi-session-index','<kimi-home>/session_index.jsonl','05b-kimi-bridge.js',"'session_index.jsonl'",'external JSONL','Kimi-owned append','adapter skips invalid rows','Kimi-owned','short-lived lookup','Kimi rebuild','read-only external engine state',EXTERNAL],
  ['kimi-wire','<kimi-session>/agents/*/wire.jsonl','05b-kimi-bridge.js',"'wire.jsonl'",'external JSONL','Kimi-owned append','adapter tolerates incomplete stream','Kimi-owned','tail cursor','Kimi session replay','read-only external engine state',EXTERNAL],
  ['storage-trend','<data>/storage-trend.json','06-provider-engine.js',"'storage-trend.json'",'array / implicit v1','atomicWriteJson','invalid means empty','240 hourly samples','none','new samples rebuild trend','legacy array remains byte-compatible; derived observability data',REBUILD],
  ['engine-transcript-index','<data>/engine-transcripts.json','06-provider-engine.js',"'engine-transcripts.json'",'object / version 1','atomicWriteJson + chain','sanitize to empty known set','one row per transcript','process chain only','scan transcript roots','shared atomic index with reconstructible authority',SHARED],
  ['engine-transcripts','<engine-root>/<type>/<session>.jsonl','06-provider-engine.js',"'.jsonl'",'external JSONL transcript','engine-owned','reader skips invalid lines','engineTranscriptDays','none','engine replay','external engine append protocol',EXTERNAL],
  ['playbooks','<data>/playbooks/<id>.json','06-provider-engine.js','paths.playbooks','object / normalized','atomicWriteJson','invalid playbook skipped','bounded by user files','none','user edits or delete','shared atomic write; domain validator owns schema',SHARED],
  // 113a: 103c 缺口补登记 —— 五个 sidecar 全在表里，真正存用户内容的记忆正文反而一直没登记。
  ['memory-body','<data>/memory/{global,project/<key>}/<id>.md','06d-memory-domain.js',"'.md'",'markdown + frontmatter','atomicWriteJson (markdown string passthrough)','unparsable head yields defaults; oversized (>260KB) file is skipped by the registry','one file per memory; 260KB write-side cap','in-process head cache keyed by size+mtime (113a)','user rewrite or re-propose; sidecars are rebuilt from bodies','memory bodies are user-authored content, not derived state: the workbench never regenerates them',SHARED],
  ['memory-usage','<data>/memory/_usage-v1.json','06d-memory-domain.js',"'_usage-v1.json'",'object / schema 1','atomicWriteJson','sanitize to empty entries','entry TTL/cap policy','process state','recompute from use','shared atomic write; domain sanitizer owns entries',SHARED],
  ['memory-meta','<data>/memory/**/meta.json','06d-memory-domain.js',"'meta.json'",'object / implicit v1','atomicWriteJson','invalid memory omitted','one per memory','registry scan','recreate from memory content','shared atomic metadata',SHARED],
  ['memory-import-marker','<data>/memory/.acc-memory-import-v1.json','06d-memory-domain.js',"'.acc-memory-import-v1.json'",'object / schema 1','atomicWriteJson','missing reruns idempotent import','one record','none','repeat idempotent import','shared atomic marker',SHARED],
  ['memory-proposals','<data>/memory/proposals/<session>.json','06d-memory-domain.js',"'proposals'",'object / schema 1','atomicWriteJson','invalid proposal ignored','one per session','none','regenerate proposal','shared atomic transient proposal',SHARED],
  ['memory-relations','<data>/memory/**/_relations.json','06d-memory-domain.js',"'_relations.json'",'array / domain normalized','atomicWriteJson','invalid rows filtered','domain bounded','none','re-propose relations','shared atomic domain state',SHARED],
  ['agent-run-snapshot','<data>/agent-runs/<session>/<run>.json','07-autonomy.js','agentRunFile','object / domain versioned','atomicWriteJson + per-run chain','degraded persistence surfaced','one per run + retention','live run map','events/checkpoint replay','shared atomic snapshot with dedicated event recovery',SHARED],
  ['agent-run-events','<data>/agent-runs/<session>/<run>.events.ndjson','08-agent-runs.js','.events.ndjson','NDJSON events','serialized append','valid prefix replay','compress after terminal age','per-run sequence','snapshot + replay','append-only recovery authority',DEDICATED],
  ['project-agents','<workspace>/.ruyi/agents.json','07-autonomy.js',"'agents.json'",'object / external-compatible','atomicWriteJson','invalid roles skipped','32 normalized roles','none','user/VCS restore','workspace-owned interoperable declaration',EXTERNAL],
  ['project-workflows','<workspace>/.ruyi/workflows.json','08-agent-runs.js',"'workflows.json'",'object / schemaVersion 1','atomicWriteJson','invalid workflows skipped','domain list','none','user/VCS restore','workspace-owned interoperable declaration',EXTERNAL],
  ['personal-workflows','<data>/agent-workflows/<id>.json','08-agent-runs.js','paths.agentWorkflows','object / normalized','atomicWriteJson','invalid workflow skipped','one per workflow','none','user recreates','shared atomic domain state',SHARED],
  ['context-calibration','<data>/context-calibration.json','10-context-governance.js',"'context-calibration.json'",'object / schema 1','DurableJsonStore -> atomicWriteJson','copy byte-for-byte to .corrupt; diagnostic event','200 factors + 200 window caps','process cache + explicit invalidate','sanitized defaults then safe write','103c representative full-lifecycle migration',SHARED],
  ['web-cache','<data>/webcache/<sha256>.json','11-native-tools.js','webCachePath','object / domain fields','atomicWriteJson','invalid entry is cache miss','storagePolicy.webcacheMaxEntries','none','refetch or offline miss','derived cache; shared atomic write',REBUILD],
  ['proxy-models-cache','<data>/proxy-models-cache.json','13-http-router.js',"'proxy-models-cache.json'",'object / implicit v1','atomicWriteJson','invalid is cache miss','provider-keyed','60s process cache','refetch providers','derived cache; shared atomic write',REBUILD],
  ['overlay-state','<install>/.overlay-applied.json + .overlay-audit.jsonl','13c-overlay-routes.js',"'.overlay-applied.json'",'PowerShell applicator protocol','external script atomic/append','applicator rollback/audit','release history','none','overlay rollback','owned by separately tested overlay applicator',EXTERNAL],
  ['pretender-index','<data>/sessions/.pretender/projection-index.json','13e-pretender-index.js','PRETENDER_INDEX_FILE','object / schemaVersion 2','atomicWriteJson','invalid triggers rebuild','one materialized projection','stamp-aware process cache','rebuild from sessions/runs/usage','fully regenerable materialized index',REBUILD],
].map(([id, pattern, owner, anchor, schema, writePrimitive, corruption, capacity, cache, recovery, exemptionReason, lifecycle]) => ({
  id, pattern, owner, anchor, schema, writePrimitive, corruption, capacity, cache, recovery, lifecycle, exemptionReason,
}));

function validate() {
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error('duplicate inventory id: ' + entry.id);
    ids.add(entry.id);
    for (const field of ['pattern','owner','anchor','schema','writePrimitive','corruption','capacity','cache','recovery','lifecycle','exemptionReason']) {
      if (!entry[field]) throw new Error(entry.id + ': missing ' + field);
    }
    if (![DEDICATED, EXTERNAL, REBUILD, SHARED].includes(entry.lifecycle)) throw new Error(entry.id + ': bad lifecycle');
    const file = path.join(SRC, entry.owner);
    if (!fs.existsSync(file)) throw new Error(entry.id + ': missing owner ' + entry.owner);
    if (!fs.readFileSync(file, 'utf8').includes(entry.anchor)) throw new Error(entry.id + ': stale source anchor ' + entry.anchor);
  }
}

function artifact() {
  validate();
  const counts = Object.fromEntries([DEDICATED, EXTERNAL, REBUILD, SHARED].map(key => [key, entries.filter(e => e.lifecycle === key).length]));
  return { schema: 1, generatedBy: 'dev-harness/durable-state-inventory.js', scope: 'workbench-managed JSON, JSONL/NDJSON and ownership sidecars plus consumed external state', count: entries.length, lifecycleCounts: counts, entries };
}

function markdown(data) {
  const lines = [
    '# Durable state inventory', '',
    '> Generated by `node dev-harness/durable-state-inventory.js --write`; do not edit by hand.', '',
    `Coverage: **${data.count} surfaces** — shared lifecycle ${data.lifecycleCounts[SHARED]}, dedicated protocol ${data.lifecycleCounts[DEDICATED]}, external ownership ${data.lifecycleCounts[EXTERNAL]}, regenerable ${data.lifecycleCounts[REBUILD]}.`, '',
    '| ID | Path/pattern | Owner | Schema | Write | Corruption | Capacity | Cache | Recovery | Decision |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const e of data.entries) lines.push(`| ${e.id} | \`${e.pattern}\` | \`${e.owner}\` | ${e.schema} | ${e.writePrimitive} | ${e.corruption} | ${e.capacity} | ${e.cache} | ${e.recovery} | **${e.lifecycle}** — ${e.exemptionReason} |`);
  lines.push('', '## Scope notes', '', '- NDJSON append logs, session v2, compressed binary snapshots and exit-time synchronous writes retain their dedicated protocols.', '- External files are merged or consumed without claiming ownership; workbench sidecars track only fields it owns.', '- Regenerable caches may treat invalid data as a miss when authoritative inputs can rebuild them.', '- `context-calibration` is the 103c full-lifecycle pilot and exercises schema, sanitize, quarantine, capacity, serialized atomic write, cache invalidation and recovery.', '');
  return lines.join('\n');
}

function outputs() {
  const data = artifact();
  return { json: JSON.stringify(data, null, 2) + '\n', md: markdown(data) };
}

function write() {
  const out = outputs();
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, out.json);
  fs.writeFileSync(MD_OUT, out.md);
  return artifact();
}

function check() {
  const out = outputs();
  const failures = [];
  if (!fs.existsSync(JSON_OUT) || fs.readFileSync(JSON_OUT, 'utf8') !== out.json) failures.push(path.relative(ROOT, JSON_OUT));
  if (!fs.existsSync(MD_OUT) || fs.readFileSync(MD_OUT, 'utf8') !== out.md) failures.push(path.relative(ROOT, MD_OUT));
  if (failures.length) throw new Error('stale durable-state inventory: ' + failures.join(', '));
  return artifact();
}

if (require.main === module) {
  try {
    const data = process.argv.includes('--write') ? write() : check();
    console.log(`durable state inventory: ${data.count} surfaces (${data.lifecycleCounts[SHARED]} shared, ${data.lifecycleCounts[DEDICATED]} dedicated, ${data.lifecycleCounts[EXTERNAL]} external, ${data.lifecycleCounts[REBUILD]} regenerable)`);
  } catch (error) { console.error(error.message || error); process.exitCode = 1; }
}

module.exports = { artifact, outputs, write, check, entries };
