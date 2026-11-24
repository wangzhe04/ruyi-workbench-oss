'use strict';
// Executed in the isolated migration runtime to generate pre-P1 backup fixtures.
module.exports = async function legacyCapsulePrepare(dest, stage, backup) {
  const descriptor = migrationCapsuleDescriptor(backup), revision = crypto.randomBytes(32).toString('hex');
  const broker = await migrationCapsuleBroker();
  let intent = null;
  try {
    await broker.command({ cmd: 'short-probe', root: stage });
    const snapshot = await broker.command({ cmd: 'capture', root: dest, revision });
    if (!migrationCapsuleShape(snapshot)) migrationCapsuleFail('shape');
    const staged = await migrationCapsuleCapture(stage, revision);
    const raw = Buffer.from(JSON.stringify(snapshot), 'utf8');
    if (raw.length > MIGRATION_CAPSULE_ARCHIVE_LIMIT) { raw.fill(0); migrationCapsuleFail('capacity'); }
    let bytes;
    try { bytes = require('node:zlib').gzipSync(raw); } finally { raw.fill(0); }
    try {
      if (bytes.length > MIGRATION_CAPSULE_BINARY_LIMIT) migrationCapsuleFail('capacity');
      if (await migrationLstat(backup)) migrationCapsuleFail('target_exists');
      await fsp.mkdir(path.dirname(backup), { recursive: true });
      await fsp.mkdir(backup);
      await atomicWriteJson(path.join(backup, MIGRATION_CAPSULE_MARKER), { version: 1 });
      await fsp.mkdir(path.join(backup, 'objects'));
      await migrationCapsuleArchive(descriptor).write(bytes);
    } finally { if (bytes) bytes.fill(0); }
    intent = { schema: 1, id: descriptor.id, stamp: descriptor.stamp, revision, phase: 'preparing',
      oldRoot: snapshot.entries.find(entry => entry.rel === '').id, newTree: migrationCapsuleFingerprint(staged), sourceStage: path.basename(stage) };
    migrationRecoveryNeeded = true;
    await migrationCapsuleWriteIntent(descriptor, intent);
    // Authenticate the durable authority and all business/path/size bindings before
    // the first truncation/rename. No archive is ever written as a plaintext temp.
    await migrationCapsuleRead(descriptor);
    await broker.command({ cmd: 'seal', container: path.join(backup, 'objects') });
    intent.phase = 'ready';
    await migrationCapsuleWriteIntent(descriptor, intent);
    await broker.command({ cmd: 'verify', cleared: true });
    await migrationCapsuleAssertTree(stage, intent.newTree, revision);
    await fsp.rename(stage, dest);
    await migrationCapsuleAssertTree(dest, intent.newTree, revision);
    intent.phase = 'published';
    await migrationCapsuleWriteIntent(descriptor, intent);
    migrationRecoveryNeeded = false;
    return descriptor;
  } catch (error) {
    if (intent) {
      // Recovery is durable; never hide an executed publication behind a retryable
      // copy-failed result. The next owner/startup resolves the same intent once.
      error.operationMayHaveExecuted = true; error.resultUnavailable = true; error.retry = false;
    }
    throw error;
  } finally { await broker.close(); }
};
