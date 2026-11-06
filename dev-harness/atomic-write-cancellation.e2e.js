'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('ATOMIC WRITE CANCELLATION');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-atomic-cancel-'));
process.env.RUYI_HOME = path.join(root, 'data');
const workspace = path.join(root, 'work'); fs.mkdirSync(workspace);
const original = { writeFile: fsp.writeFile, rename: fsp.rename, unlink: fsp.unlink };
const fault = code => Object.assign(new Error('fixture ' + code), { code });
const restore = () => Object.assign(fsp, original);
(async () => {
  try {
    const S = loadServerInternals(['FileTextIo', 'toolCall', 'journalReadIndex', 'journalDir']);
    const target = path.join(workspace, '中文 target.txt');
    const reset = () => { restore(); fs.writeFileSync(target, 'original'); };
    const unchanged = () => fs.readFileSync(target, 'utf8') === 'original';
    const clean = () => !fs.readdirSync(workspace).some(name => name.endsWith('.tmp'));
    const write = signal => S.FileTextIo.writeFileAtomic(target, Buffer.from('changed'), { signal, retries: 1 });
    const failure = promise => promise.then(() => null, error => error);
    let controller = new AbortController(); controller.abort(); reset();
    t.ok((await failure(write(controller.signal))).code === 'ABORT_ERR' && unchanged() && clean(), 'pre-abort leaves target and directory intact');
    for (const phase of ['temp', 'retry', 'fallback']) {
      reset(); controller = new AbortController(); let renames = 0, targetWrites = 0;
      fsp.writeFile = async (file, ...args) => {
        if (file === target) targetWrites++;
        await original.writeFile(file, ...args);
        if (phase === 'temp' && path.basename(file).endsWith('.tmp')) controller.abort();
      };
      fsp.rename = async (from, to) => {
        if (to !== target) return original.rename(from, to);
        renames++; controller.abort(); throw fault(phase === 'fallback' ? 'EIO' : 'EBUSY');
      };
      const error = await failure(write(controller.signal));
      t.ok(error?.code === 'ABORT_ERR' && unchanged() && clean() && targetWrites === 0,
        phase + ' cancellation prevents target fallback and awaits temporary cleanup');
      t.ok(renames === (phase === 'temp' ? 0 : 1), phase + ' cancellation stops further rename attempts');
    }
    reset(); controller = new AbortController();
    fsp.rename = async (from, to) => { await original.rename(from, to); if (to === target) controller.abort(); };
    t.ok((await write(controller.signal)).atomic && fs.readFileSync(target, 'utf8') === 'changed', 'abort after successful rename reports committed success');
    reset();
    fsp.rename = async (from, to) => { if (to === target) throw fault('EBUSY'); return original.rename(from, to); };
    t.ok(!(await write()).atomic && fs.readFileSync(target, 'utf8') === 'changed' && clean(), 'ordinary exhausted rename retains in-place fallback');
    reset();
    fsp.writeFile = async (file, ...args) => { if (path.basename(file).endsWith('.tmp')) throw fault('ENOSPC'); return original.writeFile(file, ...args); };
    t.ok((await failure(write())).code === 'ENOSPC' && unchanged() && clean(), 'temporary disk-full never truncates target');

    reset(); controller = new AbortController();
    fsp.writeFile = async (file, ...args) => {
      if (path.basename(file).endsWith('.tmp')) { controller.abort(); throw fault('EACCES'); }
      return original.writeFile(file, ...args);
    };
    t.ok((await failure(write(controller.signal))).code === 'ABORT_ERR' && unchanged() && clean(), 'cancelled temporary creation cannot enter permission fallback');
    for (const kind of ['hardlink', 'symlink']) {
      reset();
      const link = path.join(workspace, kind);
      try {
        if (kind === 'hardlink') fs.linkSync(target, link); else fs.symlinkSync(target, link);
      } catch (error) {
        if (process.platform === 'win32' && kind === 'symlink' && error.code === 'EPERM') {
          console.log('SKIP symlink fixture requires Windows symlink privilege');
          continue;
        }
        throw error;
      }
      try {
        await S.FileTextIo.writeFileAtomic(link, Buffer.from('linked'));
        t.ok(fs.readFileSync(target, 'utf8') === 'linked', kind + ' in-place write preserves link semantics');
        fsp.writeFile = async (file, ...args) => {
          if (file !== link) return original.writeFile(file, ...args);
          await original.writeFile(file, 'partial'); throw fault('EIO');
        };
        const error = await failure(S.FileTextIo.writeFileAtomic(link, Buffer.from('changed')));
        t.ok(error?.targetMayBeModified && error.code === 'EIO', kind + ' partial error carries mutation uncertainty');
      } finally { fs.unlinkSync(link); }
    }
    const context = { sessionId: 'atomic-cancel', session: { id: 'atomic-cancel', cwd: workspace }, turnSeq: 1,
      config: { permissionMode: 'default', defaultWorkspace: workspace } };
    reset();
    const seeded = await S.toolCall('file_write', { path: target, content: 'seeded' }, context);
    t.ok(seeded.ok && (await S.journalReadIndex(context.session.id)).length > 0, 'seed an earlier checkpoint for the same target before cancellation');
    for (const tool of ['file_write', 'file_edit']) {
      reset(); controller = new AbortController();
      const args = tool === 'file_write' ? { path: target, content: 'changed' } : { path: target, oldText: 'original', newText: 'changed' };
      const before = await S.journalReadIndex(context.session.id);
      fsp.writeFile = async (file, ...rest) => {
        await original.writeFile(file, ...rest);
        if (path.dirname(file) === workspace && path.basename(file).endsWith('.tmp')) controller.abort();
      };
      const cancelled = await S.toolCall(tool, args, { ...context, signal: controller.signal });
      t.ok(cancelled.code === 'aborted' && cancelled.checkpointRolledBack && unchanged() && clean(), tool + ' public cancellation rolls back its uncommitted checkpoint');
      t.ok((await S.journalReadIndex(context.session.id)).length === before.length, tool + ' cancellation preserves prior checkpoint entries');
    }
    const input = path.join(workspace, 'input.txt'); fs.writeFileSync(input, 'zip input');
    for (const tool of ['file_write', 'file_edit', 'archive_zip']) {
      reset();
      const args = tool === 'archive_zip' ? { paths: [input], dest: target }
        : tool === 'file_write' ? { path: target, content: 'changed' } : { path: target, oldText: 'original', newText: 'changed' };
      fsp.rename = async (from, to) => { if (to === target) throw fault('EIO'); return original.rename(from, to); };
      fsp.writeFile = async (file, ...rest) => {
        if (file !== target) return original.writeFile(file, ...rest);
        await original.writeFile(target, 'partial'); throw fault('ENOSPC');
      };
      const result = await S.toolCall(tool, args, context);
      t.ok(!result.ok && result.targetMayBeModified && !result.checkpointRolledBack && result.checkpointRetained
        && result.errno === 'ENOSPC' && fs.readFileSync(target, 'utf8') === 'partial', tool + ' partial fallback reports actual error and retains checkpoint');
      const entries = await S.journalReadIndex(context.session.id);
      const entry = entries.filter(entry => entry.tool === tool).at(-1);
      const snapshot = entry && require('zlib').gunzipSync(fs.readFileSync(path.join(S.journalDir(context.session.id), `${entry.turnSeq}-${entry.entrySeq}.gz`))).toString();
      t.ok(snapshot === 'original' && clean(), tool + ' failed partial write retains original bytes and cleans temporary file');
    }
    reset(); controller = new AbortController();
    fsp.rename = async (from, to) => { if (to === target) throw fault('EIO'); return original.rename(from, to); };
    fsp.writeFile = async (file, ...args) => { await original.writeFile(file, ...args); if (file === target) controller.abort(); };
    t.ok(!(await write(controller.signal)).atomic && fs.readFileSync(target, 'utf8') === 'changed', 'abort after successful in-place commit reports success');
    for (const tool of ['file_write', 'file_edit', 'archive_zip']) {
      for (const mode of ['success', 'partial']) {
        reset(); let retained;
        const args = tool === 'archive_zip' ? { paths: [input], dest: target }
          : tool === 'file_write' ? { path: target, content: 'changed' } : { path: target, oldText: 'original', newText: 'changed' };
        fsp.rename = async (from, to) => { if (to === target) throw fault('EIO'); return original.rename(from, to); };
        fsp.unlink = async file => {
          if (path.dirname(file) === workspace && path.basename(file).endsWith('.tmp')) { retained = file; throw fault('EACCES'); }
          return original.unlink(file);
        };
        fsp.writeFile = async (file, ...args) => {
          if (file === target && mode === 'partial') { await original.writeFile(file, 'partial'); throw fault('ENOSPC'); }
          return original.writeFile(file, ...args);
        };
        const result = await S.toolCall(tool, args, context);
        t.ok(result.cleanupIncomplete && result.cleanupPath === retained && result.cleanupError === 'EACCES'
          && result.cleanupWarning && fs.existsSync(retained), tool + ' ' + mode + ' reports the actual retained temporary file');
        t.ok(mode === 'success' ? result.ok && fs.readFileSync(target).length > 0
          : !result.ok && result.errno === 'ENOSPC' && result.targetMayBeModified && result.checkpointRetained,
          tool + ' ' + mode + ' cleanup failure preserves commit and checkpoint outcome');
        restore(); fs.unlinkSync(retained);
      }
    }
    for (const mode of ['abort', 'unknown-error']) {
      reset(); controller = new AbortController(); let retained;
      fsp.writeFile = async (file, ...args) => {
        await original.writeFile(file, ...args);
        if (path.dirname(file) === workspace && path.basename(file).endsWith('.tmp')) {
          if (mode === 'abort') controller.abort(); else throw fault('EIO');
        }
      };
      fsp.unlink = async file => {
        if (path.dirname(file) === workspace && path.basename(file).endsWith('.tmp')) { retained = file; throw fault('EPERM'); }
        return original.unlink(file);
      };
      const result = await S.toolCall('file_write', { path: target, content: 'changed' }, { ...context, signal: controller.signal });
      t.ok(result.code === (mode === 'abort' ? 'aborted' : 'write_failed') && result.cleanupIncomplete
        && result.cleanupPath === retained && result.checkpointRolledBack && unchanged(), mode + ' preserves original failure and reports cleanup uncertainty');
      restore(); fs.unlinkSync(retained);
    }
    reset(); let cleanupCalls = 0;
    fsp.unlink = async file => {
      if (path.dirname(file) === workspace && path.basename(file).endsWith('.tmp')) { cleanupCalls++; throw fault('EACCES'); }
      return original.unlink(file);
    };
    const committed = await S.toolCall('file_write', { path: target, content: 'committed' }, context);
    t.ok(committed.ok && !committed.cleanupIncomplete && cleanupCalls === 0 && fs.readFileSync(target, 'utf8') === 'committed',
      'successful rename consumes the temporary path without a redundant cleanup warning');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { restore(); fs.rmSync(root, { recursive: true, force: true }); t.done(); }
})();
