'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('FILE MUTATION RECOVERY');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mutation-recovery-'));
process.env.RUYI_HOME = path.join(root, 'data');
const workspace = path.join(root, 'work'); fs.mkdirSync(workspace);
const original = { copyFile: fsp.copyFile, rename: fsp.rename, unlink: fsp.unlink, writeFile: fsp.writeFile, mkdir: fsp.mkdir };
const restore = () => Object.assign(fsp, original);
const fault = code => Object.assign(new Error('fixture ' + code), { code });
(async () => {
  try {
    const S = loadServerInternals(['toolCall', 'journalReadIndex', 'journalDir', 'withFileToolWriteLock', 'fileToolWriteChains']);
    const from = path.join(workspace, 'source.txt'), to = path.join(workspace, 'destination.txt');
    let serial = 0;
    const context = () => { const id = 'mutation-' + (++serial); return { sessionId: id, turnSeq: 1,
      session: { id, cwd: workspace }, config: { permissionMode: 'default', defaultWorkspace: workspace } }; };
    const reset = () => { restore(); fs.writeFileSync(from, 'source'); fs.writeFileSync(to, 'destination'); };
    const args = { from, to, overwrite: true };
    const snapshots = async ctx => {
      const entries = await S.journalReadIndex(ctx.sessionId);
      return entries.map(entry => ({ ...entry, content: entry.op === 'create' ? null : zlib.gunzipSync(fs.readFileSync(path.join(S.journalDir(ctx.sessionId), `${entry.turnSeq}-${entry.entrySeq}.gz`))).toString() }));
    };
    for (const tool of ['file_delete', 'file_copy', 'file_move']) {
      reset(); const ctx = context(), controller = new AbortController();
      fsp.writeFile = async (file, ...rest) => {
        await original.writeFile(file, ...rest);
        if (file === path.join(S.journalDir(ctx.sessionId), 'index.json')) controller.abort();
      };
      // The journal writes via an atomic temporary file, so observe its committed rename too.
      fsp.rename = async (src, dest) => {
        await original.rename(src, dest);
        if (dest === path.join(S.journalDir(ctx.sessionId), 'index.json')) controller.abort();
      };
      const result = await S.toolCall(tool, tool === 'file_delete' ? { path: from } : args, { ...ctx, signal: controller.signal });
      t.ok(controller.signal.aborted && result.code === 'aborted' && result.checkpointRolledBack, tool + ' cancellation after checkpoint prevents commit');
      t.ok(fs.readFileSync(from, 'utf8') === 'source' && fs.readFileSync(to, 'utf8') === 'destination'
        && (await S.journalReadIndex(ctx.sessionId)).length === 0, tool + ' pre-commit cancellation preserves files and removes only new entries');
    }
    for (const tool of ['file_copy', 'file_move']) {
      reset(); const ctx = context();
      if (tool === 'file_move') fsp.rename = async (src, dest) => { if (src === from && dest === to) throw fault('EXDEV'); return original.rename(src, dest); };
      fsp.copyFile = async (src, dest) => {
        if (src !== from || dest !== to) return original.copyFile(src, dest);
        await original.writeFile(to, 'partial'); throw fault('ENOSPC');
      };
      const result = await S.toolCall(tool, args, ctx);
      t.ok(!result.ok && result.partial && result.targetMayBeModified && result.checkpointRetained && !result.checkpointRolledBack,
        tool + ' partial copy retains recovery records');
      const saved = await snapshots(ctx);
      t.ok(saved.some(entry => entry.path === to && entry.content === 'destination')
        && (tool === 'file_copy' || saved.some(entry => entry.path === from && entry.content === 'source')),
        tool + ' retained snapshots contain original target and required source bytes');
      t.ok(fs.readFileSync(to, 'utf8') === 'partial' && fs.readFileSync(from, 'utf8') === 'source', tool + ' reports the actual partial filesystem state');
    }
    reset(); let ctx = context();
    fsp.rename = async (src, dest) => { if (src === from && dest === to) throw fault('EXDEV'); return original.rename(src, dest); };
    fsp.unlink = async file => { if (file === from) throw fault('EACCES'); return original.unlink(file); };
    let result = await S.toolCall('file_move', args, ctx);
    t.ok(result.partial && result.checkpointRetained && (await snapshots(ctx)).length === 2
      && fs.readFileSync(to, 'utf8') === 'source' && fs.existsSync(from), 'cross-volume source deletion failure preserves both snapshots and both files');

    reset(); ctx = context(); const controller = new AbortController();
    fsp.rename = async (src, dest) => { if (src === from && dest === to) throw fault('EXDEV'); return original.rename(src, dest); };
    fsp.copyFile = async (src, dest) => { await original.copyFile(src, dest); if (src === from && dest === to) controller.abort(); };
    result = await S.toolCall('file_move', args, { ...ctx, signal: controller.signal });
    t.ok(result.ok && controller.signal.aborted && !fs.existsSync(from) && fs.readFileSync(to, 'utf8') === 'source', 'cross-volume commit finishes source deletion after late cancellation');

    reset(); ctx = context(); const preFallback = new AbortController();
    fsp.rename = async (src, dest) => { if (src === from && dest === to) { preFallback.abort(); throw fault('EXDEV'); } return original.rename(src, dest); };
    result = await S.toolCall('file_move', args, { ...ctx, signal: preFallback.signal });
    t.ok(result.code === 'aborted' && !result.partial && result.checkpointRolledBack
      && fs.readFileSync(to, 'utf8') === 'destination', 'cancelled EXDEV transition never begins fallback copy');

    reset(); ctx = context();
    await S.toolCall('file_copy', args, ctx);
    const before = await S.journalReadIndex(ctx.sessionId);
    fsp.mkdir = async (dir, ...rest) => { if (dir === workspace) throw fault('EACCES'); return original.mkdir(dir, ...rest); };
    result = await S.toolCall('file_copy', args, ctx);
    t.ok(!result.ok && result.checkpointRolledBack && (await S.journalReadIndex(ctx.sessionId)).length === before.length,
      'copy preparation failure removes only its current checkpoint and retains earlier same-path entry');

    if (process.platform === 'darwin') {
      reset(); ctx = context(); const upper = path.join(workspace, 'SOURCE.TXT');
      if (fs.existsSync(upper)) {
        let recoveryPath;
        fsp.rename = async (src, dest) => {
          if (src === from && String(dest).endsWith('.rn')) { recoveryPath = dest; return original.rename(src, dest); }
          if (src === recoveryPath) throw fault('EACCES');
          return original.rename(src, dest);
        };
        result = await S.toolCall('file_move', { from, to: upper }, ctx);
        t.ok(result.partial && result.recoveryPath === recoveryPath && result.checkpointRetained
          && !result.checkpointRolledBack && fs.readFileSync(recoveryPath, 'utf8') === 'source', 'failed case-only restoration reports retained recovery path');
        t.ok((await snapshots(ctx)).some(entry => entry.path === from && entry.content === 'source'), 'failed case-only restoration retains source snapshot');
        restore(); fs.renameSync(recoveryPath, from);
      } else console.log('SKIP case-only failure fixture requires case-insensitive filesystem');
      if (!fs.existsSync(upper)) return;
      reset(); ctx = context(); let release;
      const held = S.withFileToolWriteLock([from, to], null, () => new Promise(resolve => { release = resolve; }));
      while (!release) await new Promise(resolve => setImmediate(resolve));
      const previous = S.fileToolWriteChains.get('darwin-file-writes');
      const pending = S.toolCall('file_copy', { from, to: upper, overwrite: true }, ctx);
      try {
        const deadline = Date.now() + 5000;
        while (S.fileToolWriteChains.get('darwin-file-writes') === previous && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
        t.ok(S.fileToolWriteChains.get('darwin-file-writes') !== previous, 'copy is queued before source identity changes');
        fs.unlinkSync(from); fs.writeFileSync(from, 'new source');
      } finally { release(); await held; }
      result = await pending;
      t.ok(result.ok && result.unchanged && (await S.journalReadIndex(ctx.sessionId)).length === 0,
        'source identity is refreshed inside lock before same-file classification');
    }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { restore(); fs.rmSync(root, { recursive: true, force: true }); t.done(); }
})();
