// Serve ownership is an OS-held IPC handle, not a heartbeat file or an expiring lease.
// Only serve acquires it; legitimate MCP children continue to share the data directory.
const ServerOwnership = ((netModule, fsModule, pathModule, osModule, cryptoModule) => {
  async function canonicalRoot(root) {
    let cursor = pathModule.resolve(root);
    const missing = [];
    for (;;) {
      try {
        const real = await fsModule.promises.realpath(cursor);
        const joined = pathModule.join(real, ...missing);
        return process.platform === 'win32' ? joined.toLowerCase() : joined;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = pathModule.dirname(cursor);
        if (parent === cursor) throw error;
        missing.unshift(pathModule.basename(cursor));
        cursor = parent;
      }
    }
  }
  function endpointFor(canonical, platform = process.platform, nodeVersion = process.versions.node) {
    const digest = cryptoModule.createHash('sha256').update(canonical).digest('hex');
    if (platform === 'win32') return '\\\\.\\pipe\\ruyi-serve-' + digest;
    const [major, minor] = nodeVersion.split('.').map(Number);
    if (platform === 'linux' && (major > 20 || (major === 20 && minor >= 8))) return '\0ruyi-serve-' + digest;
    // Portable fallback, also for Linux 20.0–20.7: normal close unlinks our socket.
    // A crash can leave a socket file. Never unlink an unknown owner's endpoint automatically.
    return pathModule.join(osModule.tmpdir(), 'ruyi-serve-' + digest.slice(0, 32) + '.sock');
  }
  function ownershipError(code, message) {
    return Object.assign(new Error(message), { code, ruyiStartErrorKind: 'data-dir-owned' });
  }
  async function bind(canonical) {
    const endpoint = endpointFor(canonical);
    const server = netModule.createServer(socket => { socket.on('error', () => {}); socket.destroy(); });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(endpoint, () => { server.removeListener('error', reject); resolve(); });
      });
    } catch (error) {
      try { server.close(); } catch { /* unbound */ }
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        const residual = endpoint.endsWith('.sock') ? ` 如确认没有实例运行，请核实并清理残留 socket：${endpoint}。` : '';
        throw ownershipError('DATA_ROOT_IN_USE', `这个数据目录已有如意服务持有独占权，未启动第二个实例：${canonical}。请使用已打开的如意，或先退出它。 / Data directory already in use.${residual}`);
      }
      throw error;
    }
    let released = false;
    return {
      canonical, endpoint,
      release() {
        if (released) return Promise.resolve();
        released = true; // A delayed/repeated old release can only close this captured handle.
        return new Promise(resolve => { server.close(() => resolve()); });
      },
    };
  }
  async function checkLegacyRuntime(root) {
    let runtimeText;
    try { runtimeText = await fsModule.promises.readFile(pathModule.join(root, 'runtime.json'), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '无法读取旧服务身份记录；为保护任务，本次没有执行启动恢复。 / Cannot verify the previous data directory owner.');
    }
    let record;
    try { record = JSON.parse(runtimeText); } catch { /* unknown owner: do not guess */ }
    if (!record || !Number.isInteger(record.pid) || record.pid <= 0) {
      throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '无法确认数据目录中旧服务的身份；为保护任务，本次没有执行启动恢复。请先确认旧服务已退出并检查 runtime.json。 / Previous data directory owner is unknown.');
    }
    if (record.pid === process.pid) return;
    try { process.kill(record.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; } // EPERM and all other uncertainty fail closed.
    throw ownershipError('DATA_ROOT_IN_USE', `数据目录登记的旧如意进程仍存活或无法确认（PID ${record.pid}），本次没有接管或结束它。 / Previous service may still be running.`);
  }
  async function acquire(roots) {
    const canonical = [...new Set(await Promise.all(roots.map(canonicalRoot)))].sort();
    const handles = [];
    try {
      for (const root of canonical) handles.push(await bind(root));
      // Old releases have no IPC gate. A live or uncertain PID blocks startup even when its
      // number was reused by an unrelated process: false refusal is safer than destructive recovery.
      for (const root of canonical) await checkLegacyRuntime(root);
    } catch (error) {
      await Promise.all(handles.map(handle => handle.release()));
      throw error;
    }
    let released = false;
    return Object.freeze({
      roots: Object.freeze(canonical),
      portable: handles.some(handle => handle.endpoint.endsWith('.sock')),
      release() {
        if (released) return Promise.resolve();
        released = true;
        return Promise.all(handles.map(handle => handle.release())).then(() => undefined);
      },
    });
  }
  return Object.freeze({ acquire, canonicalRoot, endpointFor });
})(require('net'), require('fs'), require('path'), require('os'), require('crypto'));
