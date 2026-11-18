'use strict';
// Explicitly authorized, read-only metadata audit of the invalid attempt's cache
// scope. No content is printed/read for interpretation and no path is cleaned.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const root = path.resolve('output/semantic-qwen-reranker-official-v1');
const executionPath = path.join(root, 'converter-f16-invalid-isolation-attempt-execution.json');
const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8').replace(/^\uFEFF/, ''));
const end = fs.statSync(executionPath).mtimeMs, start = end - execution.elapsedMs;
const userProfile = os.homedir();
const roots = [path.join(userProfile, 'cache'), path.join(userProfile, 'temp'), path.join(userProfile, '.cache/huggingface')];
const report = { schemaVersion: 1, status: 'READ_ONLY_METADATA_AUDIT', executionPath,
  attempt: { startEstimated: new Date(start).toISOString(), endEstimated: new Date(end).toISOString(), windowPaddingMs: 3000 },
  knownAssignmentsFromExecutedScript: { HOME: userProfile, USERPROFILE: userProfile, APPDATA: userProfile, LOCALAPPDATA: userProfile,
    HF_HOME: path.join(userProfile, 'cache'), TEMP: path.join(userProfile, 'temp'), TMP: path.join(userProfile, 'temp'), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  inheritanceLimit: 'The invalid process environment was not snapshotted. These assignments are reconstructed from the executed script and the read-only PowerShell HOME value; inherited cache overrides/token variables cannot be reconstructed with certainty.',
  scopes: [], changes: [], scanned: 0, truncated: false,
  limits: ['No pre-attempt filesystem baseline exists: temporal matches cannot prove exclusive process attribution or prove no earlier overwritten content.', 'Only known HF/cache/temp metadata is enumerated. Contents are never interpreted or emitted. Hashes are permitted byte-stream digests only.', 'No non-owner file/directory is modified, deleted or cleaned. Symbolic links are not followed.', 'This audit cannot retrospectively qualify the invalid conversion environment.'] };
function stat(file) { const x = fs.lstatSync(file); return { file, kind: x.isDirectory() ? 'directory' : x.isSymbolicLink() ? 'link' : 'file', bytes: x.size,
  createdAt: x.birthtime.toISOString(), modifiedAt: x.mtime.toISOString(), createdMs: x.birthtimeMs, modifiedMs: x.mtimeMs }; }
async function visit(file, depth = 0) {
  if (report.scanned >= 10000 || depth > 12) { report.truncated = true; return; }
  let meta; try { meta = stat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  report.scanned++;
  if ([meta.createdMs, meta.modifiedMs].some(time => time >= start - 3000 && time <= end + 3000)) {
    const { createdMs, modifiedMs, ...record } = meta;
    if (meta.kind === 'file' && meta.bytes <= 64 * 1024 * 1024) {
      const hash = crypto.createHash('sha256'); for await (const data of fs.createReadStream(file)) hash.update(data); record.sha256 = hash.digest('hex');
    } else if (meta.kind === 'file') record.hashSkipped = '64MiB audit bound';
    report.changes.push(record);
  }
  if (meta.kind === 'directory') for (const entry of fs.readdirSync(file)) await visit(path.join(file, entry), depth + 1);
}
(async () => {
  for (const file of roots) {
    let meta; try { const { createdMs, modifiedMs, ...record } = stat(file); meta = record; } catch (error) { if (error.code !== 'ENOENT') throw error; meta = { file, exists: false }; }
    report.scopes.push(meta); await visit(file);
  }
  fs.writeFileSync(path.join(root, 'invalid-isolation-metadata-audit.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ scopes: report.scopes.length, scannedMetadataEntries: report.scanned, timeWindowChanges: report.changes.length,
    hashedFiles: report.changes.filter(x => x.sha256).length, truncated: report.truncated, nonOwnerPathsModifiedByAudit: 0 }));
})().catch(error => { console.error(error); process.exitCode = 1; });
