'use strict';
// M3-1 work-data encryption census. Source of truth for "which durable data family moves under the
// WorkDataCrypto envelope, which frozen key purpose owns it, what minimal plaintext metadata may stay
// readable, and in which migration batch". JSON/Markdown are generated views. This file makes no
// product change and touches no user data: it freezes the contract the M3-2 adapter has to satisfy.
// Closure (every durable-state-inventory surface classified exactly once) is enforced by
// dev-harness/encrypted-storage-freeze.static.e2e.js.
const fs = require('fs');
const path = require('path');
const inventory = require('./durable-state-inventory.js');
const { constBlock } = require('./lib/source-slice');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');
const JSON_OUT = path.join(ROOT, 'docs', 'architecture', 'encrypted-storage-freeze.json');
const MD_OUT = path.join(ROOT, 'docs', 'architecture', 'encrypted-storage-freeze.md');

const REQUIRED = 'required';
const EXCLUDED = 'excluded';
// Families whose secrets already live in their own authenticated envelope: work-data must not rewrap,
// re-key or duplicate them, and the census has to say so instead of silently omitting them.
const OWN_ENVELOPE = new Set(['credential-vault-v1', 'credential-import-v1', 'privacy-mapping-v1', 'external-bot-credentials']);
// M3-2: families whose adapter is wired while the switch is still off by default and no data has been
// migrated. They may be 'wired' but must never be claimed as implemented until M3-3.
const ADAPTER_WIRED = Object.freeze(['session-head', 'session-messages', 'session-provider', 'session-scratchpad', 'voice-lexicon', 'memory-usage', 'steward-cursor', 'engine-transcript-index', 'steward-memory', 'agent-instructions-import', 'memory-relations', 'memory-proposals', 'session-interventions', 'session-changes', 'mission-container', 'playbooks', 'memory-meta', 'personal-workflows', 'steward-visits', 'agent-run-snapshot', 'web-cache', 'external-bots']);

// [id, encryption, keyPurpose, migrationBatch, plaintextFields, reason]
// plaintextFields: [[field, why], ...] — the smallest readable metadata the family needs while its
// content stays sealed. Titles, gists, paths, URLs, prompts and message text are never listed.
const families = [
  // Sessions first: one whole family end to end before the others (sessions -> memory/queue -> tasks
  // -> index/cache -> logs -> backups).
  ['session-head', REQUIRED, 'session', 'sessions',
    [['id', 'on-disk filename and sidebar route; opaque random id, never user text'], ['storageVersion', 'chooses the reader before any decrypt'], ['createdAt', 'age/sort only'], ['updatedAt', 'freshness/sort only'], ['messageCount', 'pagination bound without decrypting every line']],
    'title, gist, threadBrief, createdBy and stewardTaint move inside the envelope; the head must still be readable enough to route and sort after unlock'],
  ['session-messages', REQUIRED, 'session', 'sessions', [], 'append-only body: whole records are sealed, the encrypted head owns counts and revisions'],
  ['session-provider', REQUIRED, 'session', 'sessions', [], 'model history and tool results are user content'],
  ['session-interventions', REQUIRED, 'session', 'sessions', [], 'command journal carries the user commands and paths'],
  ['session-changes', REQUIRED, 'session', 'sessions', [], 'change audit carries file paths and diffs'],
  ['session-scratchpad', REQUIRED, 'session', 'sessions', [], 'model-owned notes are task content'],
  ['session-index', REQUIRED, 'session', 'sessions', [['id', 'sidebar row key (opaque session id)'], ['updatedAt', 'sort order only, no user text']], 'sidebar titles and gists are sensitive; only the opaque key and a timestamp stay readable'],
  ['session-v1-backup', REQUIRED, 'session', 'sessions', [], 'legacy migration artifact: sealed like the session it restores, retired after the switch'],
  ['journal-index', REQUIRED, 'session', 'sessions', [['seq', 'checkpoint ordering']], 'file lists, hashes and per-entry payloads stay sealed'],
  ['journal-reverts', REQUIRED, 'session', 'sessions', [], 'records which files the user undid'],
  ['journal-history', REQUIRED, 'session', 'sessions', [], 'compressed context snapshots are conversation content'],
  ['mission-container', REQUIRED, 'task', 'sessions', [['sessionId', 'attach a ledger to its session']], 'mission goals and milestones are user text'],
  ['context-calibration', EXCLUDED, null, 'not-migrated', [], 'numeric calibration coefficients and sample counts only; no user content and no path'],
  ['pretender-index', REQUIRED, 'search-index', 'index-cache', [['sessionId', 'group rows per session']], 'derived from sealed bodies, so it must not become a plaintext side channel'],
  // Memory and queues.
  ['memory-body', REQUIRED, 'memory', 'memory-queue', [['id', 'frontmatter/file name; opaque memory id'], ['scope', 'global vs project bucket; project key is already opaque']], 'memory bodies and frontmatter titles/descriptions are user content'],
  ['memory-meta', REQUIRED, 'memory', 'memory-queue', [], 'project bucket path, label and creation time stay sealed; the opaque project directory key supplies routing'],
  ['memory-usage', REQUIRED, 'memory', 'memory-queue', [], 'usage reveals which memories were used; cheap to seal together with memory-meta'],
  ['memory-relations', REQUIRED, 'memory', 'memory-queue', [], 'relation edges name memory ids and their meaning'],
  ['memory-proposals', REQUIRED, 'memory', 'memory-queue', [], 'pending proposals quote the user content they propose to remember'],
  ['memory-import-marker', EXCLUDED, null, 'not-migrated', [], 'content-free bookkeeping: entry hashes and timestamps, no text and no path'],
  ['agent-instructions-import', REQUIRED, 'memory', 'memory-queue', [], 'per-source file paths, entry hashes and core flags are content-derived and reveal local layout'],
  ['steward-memory', REQUIRED, 'memory', 'memory-queue', [], 'steward notes are task content'],
  ['steward-visits', REQUIRED, 'memory', 'memory-queue', [], 'visit history reveals which threads and items the steward read'],
  ['voice-lexicon', REQUIRED, 'user-config', 'memory-queue', [], 'personal vocabulary and names'],
  ['steward-inbox', REQUIRED, 'queue', 'memory-queue', [], 'inbox items quote incoming messages'],
  ['steward-cursor', REQUIRED, 'queue', 'memory-queue', [], 'cursors rarely carry text but they reveal activity pacing; sealed with the inbox they describe'],
  ['steward-decisions', REQUIRED, 'queue', 'memory-queue', [], 'decisions and rationales quote the triggering content'],
  ['work-data-key-v1', EXCLUDED, null, 'not-migrated', [], 'the key envelope itself: a DPAPI-wrapped master with no user content; every work-data record needs it unlocked first, so it cannot live inside the envelope it protects'],
  ['external-bots', REQUIRED, 'queue', 'memory-queue', [['connectionId', 'route a delivery to its connection']], 'labels, pairing receipts, inbox items and delivery receipts stay sealed; token hashes never leave the file'],
  ['scheduler-tasks', REQUIRED, 'task', 'tasks', [['taskId', 'occurrence routing']], 'templates embed prompts and targets'],
  ['scheduler-fires', REQUIRED, 'task', 'tasks', [['taskId', 'join to the task'], ['occurrenceId', 'idempotency key across restarts']], 'fire records quote the rendered prompt and result status'],
  ['agent-run-snapshot', REQUIRED, 'task', 'tasks', [['sessionId', 'attach to the session'], ['runId', 'idempotency key']], 'run goals and step results are user content'],
  ['agent-run-events', REQUIRED, 'task', 'tasks', [['sessionId', 'attach to the session'], ['runId', 'idempotency key']], 'event stream replays tool input/output'],
  ['background-job-ledger', REQUIRED, 'task', 'tasks', [['sessionId', 'attach to the session'], ['seq', 'append ordering only']], 'job output and exit detail'],
  ['personal-workflows', REQUIRED, 'workflow', 'tasks', [['workflowId', 'workflow identity']], 'workflow steps embed prompts and paths'],
  ['playbooks', REQUIRED, 'workflow', 'tasks', [['playbookId', 'playbook identity']], 'playbook bodies embed prompts and examples'],
  // Index and caches derived from sealed content.
  ['session-search-index', REQUIRED, 'search-index', 'index-cache', [['sessionId', 'group rows per session'], ['version', 'rebuild decision without decrypting every row']], 'derived text units are a plaintext side channel for sealed bodies'],
  ['web-cache', REQUIRED, 'cache', 'index-cache', [['fetchedAt', 'cache freshness only, no page text']], 'URLs and page bodies are sensitive; only a hash key and a timestamp stay readable'],
  ['proxy-models-cache', REQUIRED, 'cache', 'index-cache', [['fetchedAt', 'cache freshness only, no page text']], 'model list is provider metadata but can embed account-scoped ids'],
  ['engine-transcript-index', REQUIRED, 'cache', 'index-cache', [['sessionId', 'join to the session']], 'transcript paths and titles reveal engine sessions'],
  // Logs: pointers stay readable for rotation, content is sealed.
  ['audit-log', REQUIRED, 'audit', 'logs', [['at', 'rotation and ordering'], ['kind', 'routing/classification without decrypting']], 'event detail carries tool names, commands and paths'],
  ['migration-log', REQUIRED, 'migration', 'logs', [['appliedAt', 'listing order']], 'applied file paths and change summaries are user data'],
  // Backups the workbench itself created and can restore.
  ['migration-skill-backups', REQUIRED, 'backup', 'backups', [['skillId', 'restore target directory']], 'verbatim user skill copies'],
  ['skill-import-record', REQUIRED, 'backup', 'backups', [['skillId', 'import target']], 'provenance paths and source hashes'],
  // Excluded families: own envelope, external ownership, regenerable locators or content-free
  // bookkeeping. Every one needs a reason, and a surface cannot be left out of this table at all.
  ['credential-vault-v1', EXCLUDED, null, 'not-migrated', [], 'own authenticated credential envelope (DPAPI CurrentUser master, AES-GCM records): work-data must never rewrap or duplicate it'],
  ['credential-import-v1', EXCLUDED, null, 'not-migrated', [], 'rollback journal already sealed by the credential envelope under its own purpose'],
  ['privacy-mapping-v1', EXCLUDED, null, 'not-migrated', [], 'privacy reference map is already sealed under the credential envelope purpose privacy-mapping and must restore with the same unlock'],
  ['external-bot-credentials', EXCLUDED, null, 'not-migrated', [], 'dedicated DPAPI-protected secret records with their own connection-bound envelope'],
  ['config', EXCLUDED, null, 'not-migrated', [], 'settings skeleton: every secret already lives in the credential vault, and M3 does not change the user-chosen settings file format'],
  ['config-backups', EXCLUDED, null, 'not-migrated', [], 'insurance copies written before a settings save; they must stay human-restorable outside the unlock path'],
  ['migration-backups', EXCLUDED, null, 'not-migrated', [], 'verbatim copies beside externally owned CLI configs, kept for hand recovery'],
  ['claude-settings', EXCLUDED, null, 'not-migrated', [], 'externally owned merge target: the workbench may not rewrite it into a sealed format'],
  ['kimi-mcp', EXCLUDED, null, 'not-migrated', [], 'externally owned merge target'],
  ['claude-settings-sidecar', EXCLUDED, null, 'not-migrated', [], 'ownership sidecar recording only the values this workbench wrote'],
  ['kimi-mcp-sidecar', EXCLUDED, null, 'not-migrated', [], 'ownership sidecar recording only the managed ids this workbench wrote'],
  ['project-agents', EXCLUDED, null, 'not-migrated', [], 'workspace-owned interoperable declaration; encrypting it would break the user-readable/VCS-shared contract'],
  ['project-workflows', EXCLUDED, null, 'not-migrated', [], 'workspace-owned interoperable declaration'],
  ['steward-workspace-derived', EXCLUDED, null, 'not-migrated', [], 'derived steward workspace artifacts written for external consumption; the sealed steward state stays authoritative'],
  ['overlay-state', EXCLUDED, null, 'not-migrated', [], 'external overlay installer bookkeeping'],
  ['kimi-session-index', EXCLUDED, null, 'not-migrated', [], 'external CLI-owned state; the workbench must not rewrite another tool\'s files'],
  ['kimi-wire', EXCLUDED, null, 'not-migrated', [], 'external CLI-owned transcript'],
  ['engine-transcripts', EXCLUDED, null, 'not-migrated', [], 'external engine-owned transcript protocol'],
  ['mcp-consumers-v1', EXCLUDED, null, 'not-migrated', [], 'authorization registry: token hashes only, and it must be readable before any unlock to authenticate a consumer'],
  ['install-registry', EXCLUDED, null, 'not-migrated', [], 'local package locators with no user content; every launch re-registers itself'],
  ['runtime-handshake', EXCLUDED, null, 'not-migrated', [], 'ephemeral boot handshake'],
  ['last-start-error', EXCLUDED, null, 'not-migrated', [], 'one-shot boot notice with no user content'],
  ['generated-mcp', EXCLUDED, null, 'not-migrated', [], 'regenerable launcher input'],
  ['mcp-host-v1', EXCLUDED, null, 'not-migrated', [], 'regenerable non-secret runtime locator'],
  ['usage-ledger', EXCLUDED, null, 'not-migrated', [], 'numeric monthly counters only'],
  ['storage-trend', EXCLUDED, null, 'not-migrated', [], 'numeric trend samples only'],
];

const identity = /^[a-zA-Z0-9_.:-]{1,160}$/;
const norm = rows => rows.map(([id, encryption, purpose, batch, plaintext, reason]) => ({
  id, encryption, keyPurpose: purpose, migrationBatch: batch,
  plaintextMetadata: plaintext.map(([field, why]) => ({ field, why })), reason,
}));

function codePurposes() {
  const block = constBlock(fs.readFileSync(path.join(SRC, '01n-work-data-crypto.js'), 'utf8'), 'PURPOSES');
  if (!block) throw new Error('cannot slice WorkDataCrypto PURPOSES; the census cannot be checked against the code');
  return [...new Set((block.match(/'([a-z0-9-]+)'/g) || []).map(literal => literal.slice(1, -1)))];
}

function codeSalt() {
  const block = constBlock(fs.readFileSync(path.join(SRC, '01n-work-data-crypto.js'), 'utf8'), 'SALT_TEXT');
  const literal = (block.match(/'([^']+)'/) || [])[1];
  if (!literal) throw new Error('cannot slice WorkDataCrypto SALT_TEXT; the derivation description cannot be checked');
  return literal;
}

function validate() {
  const entries = norm(families), ids = new Set(), inventoryIds = new Set(inventory.entries.map(row => row.id));
  const purposes = codePurposes();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error('duplicate census id: ' + entry.id);
    ids.add(entry.id);
    if (!inventoryIds.has(entry.id)) throw new Error(entry.id + ': not a durable-state-inventory surface');
    if (!entry.reason) throw new Error(entry.id + ': missing reason');
    if (entry.encryption === REQUIRED) {
      if (OWN_ENVELOPE.has(entry.id)) throw new Error(entry.id + ': its own credential envelope owns this family');
      if (!purposes.includes(entry.keyPurpose)) throw new Error(entry.id + ': key purpose ' + entry.keyPurpose + ' is not in WorkDataCrypto.PURPOSES');
      if (entry.migrationBatch === 'not-migrated') throw new Error(entry.id + ': required family needs a migration batch');
      for (const field of entry.plaintextMetadata) {
        if (!identity.test(field.field) || !field.why) throw new Error(entry.id + ': malformed plaintext metadata field ' + field.field);
      }
    } else if (entry.encryption === EXCLUDED) {
      if (entry.keyPurpose !== null) throw new Error(entry.id + ': excluded family must not claim a key purpose');
      if (entry.migrationBatch !== 'not-migrated') throw new Error(entry.id + ': excluded family must not claim a migration batch');
      if (entry.plaintextMetadata.length) throw new Error(entry.id + ': excluded family must not declare plaintext metadata');
    } else throw new Error(entry.id + ': bad encryption class ' + entry.encryption);
  }
  for (const id of OWN_ENVELOPE) if (!entries.some(entry => entry.id === id && entry.encryption === EXCLUDED)) throw new Error(id + ': own-envelope family must be classified as excluded');
  const missing = [...inventoryIds].filter(id => !ids.has(id));
  if (missing.length) throw new Error('unclassified durable surfaces: ' + missing.join(', '));
  for (const purpose of purposes) if (!entries.some(entry => entry.keyPurpose === purpose)) throw new Error('frozen purpose with no family: ' + purpose);
  return entries;
}

function artifact() {
  const entries = validate();
  const classCounts = { [REQUIRED]: entries.filter(entry => entry.encryption === REQUIRED).length, [EXCLUDED]: entries.filter(entry => entry.encryption === EXCLUDED).length };
  const batchCounts = {};
  for (const entry of entries) batchCounts[entry.migrationBatch] = (batchCounts[entry.migrationBatch] || 0) + 1;
  return {
    schema: 1, generatedBy: 'dev-harness/encrypted-storage-freeze.js',
    scope: 'M3-1 freeze: every durable-state-inventory surface classified for the work-data envelope; no product change and no user-data migration',
    encryptionImplemented: false,
    count: entries.length, classCounts, batchCounts, purposes: codePurposes(),
    adapterWired: [...ADAPTER_WIRED],
    envelope: { formatVersion: 2, keyIdPrefix: 'work-data-v2.k', aadBinding: ['schema', 'scopeId', 'seq'],
      derivation: `HKDF-SHA256(master, salt=${codeSalt()}, info=purpose:<purpose>:k<generation>)` },
    entries: entries.map(entry => ({ ...entry, adapter: ADAPTER_WIRED.includes(entry.id) ? 'wired' : 'pending' })),
  };
}

function markdown(data) {
  const lines = [
    '# Encrypted storage freeze (M3-1)',
    '',
    '> Generated by `node dev-harness/encrypted-storage-freeze.js --write`; do not edit by hand.',
    '> Source: `dev-harness/encrypted-storage-freeze.js`. Closure against `durable-state-inventory` is enforced by `dev-harness/encrypted-storage-freeze.static.e2e.js`.',
    '',
    `Coverage: **${data.count} surfaces** — ${data.classCounts[REQUIRED]} move under the work-data envelope, ${data.classCounts[EXCLUDED]} stay outside it with a reason.`,
    '',
    `Batches: ${Object.entries(data.batchCounts).map(([batch, count]) => `${batch} ${count}`).join(', ')}.`,
    '',
    `Frozen purposes (\`WorkDataCrypto.PURPOSES\`): ${data.purposes.map(purpose => '`' + purpose + '`').join(', ')}.`,
    '',
    `Envelope: format version ${data.envelope.formatVersion}, key id \`${data.envelope.keyIdPrefix}<generation>\`, derivation \`${data.envelope.derivation}\`, AAD binds ${data.envelope.aadBinding.map(field => '`' + field + '`').join(' / ')} on top of the privacy-core triple.`,
    '',
    'Explicit opt-in large text may use workData:3 / chunks-v1 around authenticated v2 manifest and chunk envelopes. See [93 section 11](../optimization-plan/93-m3-1-encrypted-storage-freeze.md#11-m3-2-大记录格式补充2026-10-23); the frozen v2 crypto envelope is unchanged.',
    '',
    `\`encryptionImplemented\`: **${data.encryptionImplemented}** — no user data has been migrated. \`adapterWired\`: ${data.adapterWired.map(id => '`' + id + '`').join(', ') || 'none'} (adapter exists, switch still off by default).`,
    '',
    '| ID | Class | Key purpose | Batch | Adapter | Minimal plaintext metadata | Reason |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const entry of data.entries) {
    const plaintext = entry.plaintextMetadata.length ? entry.plaintextMetadata.map(field => `\`${field.field}\` (${field.why})`).join('; ') : '— (nothing readable)';
    lines.push(`| ${entry.id} | ${entry.encryption} | ${entry.keyPurpose ? '`' + entry.keyPurpose + '`' : '—'} | ${entry.migrationBatch} | ${entry.adapter} | ${plaintext} | ${entry.reason} |`);
  }
  lines.push('', '## Freeze rules', '',
    '- Migration order is `sessions` → `memory-queue` → `tasks` → `index-cache` → `logs` → `backups`; one family completes old/new read-write before the next starts (M3-2).',
    '- A family may only be marked implemented after its adapter, its scope/parameter binding, and its offline + interrupted-migration evidence exist; the static gate fails while `encryptionImplemented` is false and any family claims `implemented`.',
    '- Titles, gists, paths, URLs, prompts and message text are never default-readable metadata. Anything listed above must stay sufficient for routing, sorting, planning and recovery without decrypting content.',
    '- Ciphertext-derived caches and indexes are classified as required: a derived plaintext index would be a side channel around the sealed bodies.',
    '- Families owned by another tool (CLI configs and transcripts, workspace declarations) and families with their own authenticated credential envelope stay outside; the workbench may not silently rewrite them into a sealed format.',
    '- Key purposes never share a key: `WorkDataCrypto.deriveKey` derives them with HKDF from the unlocked master, and the generation is part of the derivation info (not only the key id), so a rotation changes key material instead of just relabelling it.', '');
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
  const out = outputs(), failures = [];
  if (!fs.existsSync(JSON_OUT) || fs.readFileSync(JSON_OUT, 'utf8') !== out.json) failures.push(path.relative(ROOT, JSON_OUT));
  if (!fs.existsSync(MD_OUT) || fs.readFileSync(MD_OUT, 'utf8') !== out.md) failures.push(path.relative(ROOT, MD_OUT));
  if (failures.length) throw new Error('stale encrypted storage freeze: ' + failures.join(', '));
  return artifact();
}

if (require.main === module) {
  try {
    const data = process.argv.includes('--write') ? write() : check();
    console.log(`encrypted storage freeze: ${data.count} surfaces (${data.classCounts[REQUIRED]} required, ${data.classCounts[EXCLUDED]} excluded)`);
  } catch (error) { console.error(error.message || error); process.exitCode = 1; }
}

module.exports = { artifact, outputs, write, check, codePurposes, codeSalt };
