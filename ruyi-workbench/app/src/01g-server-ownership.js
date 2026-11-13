// Serve ownership is an OS-held handle, not a heartbeat file or an expiring lease.
// Only serve acquires it; legitimate MCP children continue to share the data directory.
const ServerOwnership = ((netModule, fsModule, pathModule, osModule, cryptoModule) => {
  async function resolveRoot(root) {
    let cursor = pathModule.resolve(root);
    const missing = [];
    for (;;) {
      let real;
      try { real = await fsModule.promises.realpath(cursor); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = pathModule.dirname(cursor);
        if (parent === cursor) throw error;
        missing.unshift(pathModule.basename(cursor));
        cursor = parent;
        continue;
      }
      const legacy = pathModule.join(real, ...missing);
      if (process.platform === 'darwin') {
        // getcwd resolves stored directory-entry casing and APFS firmlinks, unlike realpath.
        // Verify its output against the same filesystem object before using it as a lock key.
        const result = require('child_process').spawnSync('/bin/pwd', ['-P'], {
          cwd: real, encoding: 'utf8', timeout: 2000, maxBuffer: 16384,
        });
        const primary = String(result.stdout || '').replace(/\n$/, '');
        if (result.error || result.status !== 0 || !pathModule.isAbsolute(primary)) {
          throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '无法确认数据目录的真实路径。 / Cannot resolve data directory identity.');
        }
        const [originalStat, primaryStat] = await Promise.all([
          fsModule.promises.stat(real, { bigint: true }),
          fsModule.promises.stat(primary, { bigint: true }),
        ]);
        if (originalStat.dev !== primaryStat.dev || originalStat.ino !== primaryStat.ino) {
          throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '数据目录身份发生变化，请重新启动。 / Data directory identity changed.');
        }
        real = primary;
      }
      const joined = pathModule.join(real, ...missing);
      return { canonical: process.platform === 'win32' ? joined.toLowerCase() : joined, legacy, missing: missing.length > 0 };
    }
  }
  async function canonicalRoot(root) { return (await resolveRoot(root)).canonical; }
  function endpointFor(canonical, platform = process.platform, nodeVersion = process.versions.node) {
    const digest = cryptoModule.createHash('sha256').update(canonical).digest('hex');
    if (platform === 'win32') return '\\\\.\\pipe\\ruyi-serve-' + digest;
    if (platform === 'darwin') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
      return pathModule.posix.join('/private/tmp', 'ruyi-serve-v1-' + uid, digest.slice(0, 32) + '.lock');
    }
    const [major, minor] = nodeVersion.split('.').map(Number);
    if (platform === 'linux' && (major > 20 || (major === 20 && minor >= 8))) return '\0ruyi-serve-' + digest;
    // Portable fallback, also for Linux 20.0–20.7: normal close unlinks our socket.
    // A crash can leave a socket file. Never unlink an unknown owner's endpoint automatically.
    return pathModule.join(osModule.tmpdir(), 'ruyi-serve-' + digest.slice(0, 32) + '.sock');
  }
  function legacyEndpointFor(canonical) {
    const digest = cryptoModule.createHash('sha256').update(canonical).digest('hex');
    return pathModule.join(osModule.tmpdir(), 'ruyi-serve-' + digest.slice(0, 32) + '.sock');
  }
  function socketRecordFor(canonical, endpoint = legacyEndpointFor(canonical)) {
    const digest = cryptoModule.createHash('sha256').update(endpoint).digest('hex').slice(0, 32);
    return endpointFor(canonical) + '.' + digest + '.owner.json';
  }
  function ownershipError(code, message) {
    return Object.assign(new Error(message), { code, ruyiStartErrorKind: 'data-dir-owned' });
  }
  async function bind(canonical, legacyCanonicals) {
    if (process.platform === 'darwin') return bindMac(canonical, legacyCanonicals);
    const endpoint = endpointFor(canonical);
    return bindSocket(canonical, endpoint);
  }
  async function bindSocket(canonical, endpoint) {
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
      isHeld() { return !released && server.listening; },
      release() {
        if (released) return Promise.resolve();
        released = true; // A delayed/repeated old release can only close this captured handle.
        return new Promise(resolve => { server.close(() => resolve()); });
      },
    };
  }
  function privateFile(file, flags) {
    let fd;
    try { fd = fsModule.openSync(file, flags | fsModule.constants.O_NOFOLLOW | fsModule.constants.O_NONBLOCK, 0o600); }
    catch { throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '无法安全打开启动锁文件，请检查专属锁目录。 / Cannot safely open ownership file.'); }
    try {
      const stat = fsModule.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077)) {
        throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '启动锁文件身份或权限异常，请检查专属锁目录。 / Invalid ownership file.');
      }
      return fd;
    } catch (error) { fsModule.closeSync(fd); throw error; }
  }
  function sameFile(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
  }
  function readSocketOwner(file) {
    const fd = privateFile(file, fsModule.constants.O_RDONLY);
    try {
      if (fsModule.fstatSync(fd).size > 4096) throw new Error('ownership record too large');
      // Bound the actual read as well as the initial stat: a file can grow between the two.
      const buffer = Buffer.alloc(4097);
      let length = 0;
      while (length < buffer.length) {
        const count = fsModule.readSync(fd, buffer, length, buffer.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > 4096) throw new Error('ownership record too large');
      return JSON.parse(buffer.subarray(0, length).toString('utf8'));
    } finally { fsModule.closeSync(fd); }
  }
  function socketRefused(endpoint) {
    return new Promise(resolve => {
      const socket = netModule.createConnection(endpoint);
      let settled = false;
      const finish = refused => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(refused);
      };
      const timer = setTimeout(() => finish(false), 500);
      socket.once('connect', () => finish(false));
      socket.once('error', error => finish(error.code === 'ECONNREFUSED'));
    });
  }
  async function recoverSocket(canonical, endpoint, recordFile) {
    let stat;
    try { stat = fsModule.lstatSync(endpoint); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const unknown = () => ownershipError('DATA_ROOT_OWNER_UNKNOWN',
      `无法确认遗留 socket 的所有权，已保留现场，请核实原服务并人工处理：${endpoint}。 / Cannot verify residual socket owner.`);
    let record;
    try { record = readSocketOwner(recordFile); } catch { throw unknown(); }
    if (!stat.isSocket() || stat.uid !== process.getuid() || !record || record.schema !== 1
        || record.canonical !== canonical || record.endpoint !== endpoint || !sameFile(stat, record)
        || !Number.isInteger(record.pid) || record.pid <= 0) throw unknown();
    try { process.kill(record.pid, 0); throw unknown(); }
    catch (error) { if (error.code !== 'ESRCH') throw unknown(); }
    if (!await socketRefused(endpoint)) throw unknown();
    // The kernel file lock serializes all new contenders. A legacy server cannot bind this
    // occupied name; its recorded owner is dead and cannot later unlink a replacement.
    if (!sameFile(stat, fsModule.lstatSync(endpoint))) throw unknown();
    fsModule.unlinkSync(endpoint);
  }
  function acquireMacFileLock(endpoint) {
    const directory = pathModule.dirname(endpoint);
    try { fsModule.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const directoryStat = fsModule.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
        || directoryStat.uid !== process.getuid() || (directoryStat.mode & 0o077)) {
      throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '启动锁目录身份或权限异常，请检查 /private/tmp 下的如意专属目录。 / Invalid ownership directory.');
    }
    const fd = privateFile(endpoint, fsModule.constants.O_CREAT | fsModule.constants.O_RDWR);
    try {
      // flock is attached to the inherited open file description. lockf exits after acquiring
      // fd 3; this process retains the kernel lock until its own fd closes, including SIGKILL.
      // Never unlink the lock file: all contenders must continue opening the same inode.
      const result = require('child_process').spawnSync('/usr/bin/lockf', ['-s', '-t', '0', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 2000,
      });
      if (result.error || result.status !== 0) {
        const busy = !result.error && result.status === 75;
        throw ownershipError(busy ? 'DATA_ROOT_IN_USE' : 'DATA_ROOT_OWNER_UNKNOWN', busy
          ? '这个数据目录已有如意服务持有独占权。 / Data directory already in use.'
          : '无法取得系统启动锁，请检查 /usr/bin/lockf。 / System ownership lock unavailable.');
      }
      if (!sameFile(fsModule.fstatSync(fd), fsModule.lstatSync(endpoint))
          || !sameFile(directoryStat, fsModule.lstatSync(directory))) {
        throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '启动锁路径发生变化，请检查专属锁目录。 / Ownership path changed.');
      }
      return fd;
    } catch (error) { fsModule.closeSync(fd); throw error; }
  }
  async function bindMac(canonical, legacyCanonicals = []) {
    const endpoint = endpointFor(canonical);
    const fd = acquireMacFileLock(endpoint);
    const legacy = [];
    try {
      // Keep both the normalized name and the old algorithm's spelling for older builds.
      // macOS rejects socket names beyond sun_path's 103-byte payload.
      const oldEndpoints = [...new Set([canonical, ...legacyCanonicals].map(legacyEndpointFor))].sort();
      for (const oldEndpoint of oldEndpoints) {
        if (Buffer.byteLength(oldEndpoint) > 103) continue;
        const recordFile = socketRecordFor(canonical, oldEndpoint);
        await recoverSocket(canonical, oldEndpoint, recordFile);
        legacy.push(await bindSocket(canonical, oldEndpoint));
        const stat = fsModule.lstatSync(oldEndpoint);
        const recordFd = privateFile(recordFile, fsModule.constants.O_CREAT | fsModule.constants.O_WRONLY);
        try {
          fsModule.ftruncateSync(recordFd, 0);
          fsModule.writeFileSync(recordFd, JSON.stringify({ schema: 1, canonical, endpoint: oldEndpoint,
            pid: process.pid, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }));
        } finally { fsModule.closeSync(recordFd); }
      }
    } catch (error) {
      try { await Promise.all(legacy.map(handle => handle.release())); } finally { fsModule.closeSync(fd); }
      throw error;
    }
    const identity = fsModule.fstatSync(fd);
    let releasePromise;
    return { canonical, endpoint, isHeld() {
      if (releasePromise || !legacy.every(handle => handle.isHeld())) return false;
      try {
        const current = fsModule.fstatSync(fd), named = fsModule.lstatSync(endpoint);
        return current.isFile() && named.isFile() && !named.isSymbolicLink()
          && current.nlink === 1 && current.uid === process.getuid() && !(current.mode & 0o077)
          && sameFile(identity, current) && sameFile(current, named);
      } catch { return false; }
    }, release() {
      if (!releasePromise) releasePromise = Promise.resolve().then(async () => {
        try { await Promise.all(legacy.map(handle => handle.release())); } finally { fsModule.closeSync(fd); }
      });
      return releasePromise;
    } };
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
  async function acquireMacStartupLock() {
    const deadline = Date.now() + 2000;
    for (;;) {
      try { return acquireMacFileLock(endpointFor('startup-gate-v1')); }
      catch (error) {
        if (error.code !== 'DATA_ROOT_IN_USE') throw error;
        if (Date.now() >= deadline) {
          throw ownershipError('DATA_ROOT_IN_USE', '另一个如意实例正在初始化数据目录，请稍后重试。 / Another instance is initializing a data directory.');
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }
  async function acquire(roots) {
    const startupFds = [];
    const closeStartup = () => { for (const fd of startupFds.splice(0)) fsModule.closeSync(fd); };
    const handles = [];
    const identities = new Map();
    const rootAliases = new Map();
    const retiredRoots = new Set();
    let canonical;
    const rootMatches = root => {
      if (retiredRoots.has(root)) return false;
      const expected = identities.get(root);
      if (!expected) return identities.has(root); // absent leaf is protected by startup + canonical gates
      try { const stat = fsModule.statSync(root, { bigint: true });
        return stat.isDirectory() && stat.dev === expected.dev && stat.ino === expected.ino && stat.birthtimeNs === expected.birthtimeNs;
      } catch { return false; }
    };
    try {
      // Every Mac startup respects this gate, including roots that appeared during another
      // startup's recursive mkdir. Missing names have no stable filesystem spelling yet.
      if (process.platform === 'darwin') startupFds.push(await acquireMacStartupLock());
      const resolved = await Promise.all(roots.map(resolveRoot));
      for (let index = 0; index < roots.length; index++) rootAliases.set(pathModule.resolve(roots[index]), resolved[index].canonical);
      canonical = [...new Set(resolved.map(root => root.canonical))].sort();
      for (const root of canonical) {
        identities.set(root, resolved.some(item => item.canonical === root && !item.missing)
          ? await fsModule.promises.stat(root, { bigint: true }) : null);
      }
      for (const root of canonical) {
        handles.push(await bind(root, resolved.filter(item => item.canonical === root).map(item => item.legacy)));
      }
      if (!canonical.every(rootMatches)) throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '取得启动锁时数据目录发生变化。 / Data directory changed during ownership acquisition.');
      // Old releases have no kernel file gate. A live or uncertain PID blocks recovery.
      for (const root of canonical) await checkLegacyRuntime(root);
      if (!resolved.some(root => root.missing)) closeStartup();
    } catch (error) {
      try { await Promise.all(handles.map(handle => handle.release())); } finally { closeStartup(); }
      throw error;
    }
    let releasePromise;
    return Object.freeze({
      roots: Object.freeze(canonical),
      portable: handles.some(handle => handle.endpoint.endsWith('.sock')),
      isHeld() { return !releasePromise && handles.length > 0 && handles.every(handle => handle.isHeld()); },
      isRootCurrent(root) { return !releasePromise && handles.every(handle => handle.isHeld()) && rootMatches(root); },
      async confirmRoot(root, migratedFrom) {
        if (releasePromise || !handles.every(handle => handle.isHeld())) {
          throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '服务所有权或数据目录身份已经失效。 / Ownership or data directory identity changed.');
        }
        const resolved = await resolveRoot(root);
        if (resolved.missing || !identities.has(resolved.canonical) || retiredRoots.has(resolved.canonical)) {
          throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '初始化的数据目录不属于当前服务。 / Initialized root is not owned.');
        }
        if (!identities.get(resolved.canonical)) {
          if (process.platform !== 'darwin' || !startupFds.length) throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '创建目录的启动锁已经释放。 / Root creation startup gate is no longer held.');
          const actual = await fsModule.promises.stat(resolved.canonical, { bigint: true });
          if (migratedFrom !== undefined) {
            // Migration can leave a legacy junction pointing at the destination. Use the
            // pre-move alias captured at acquisition, not today's symlink resolution.
            const source = rootAliases.get(pathModule.resolve(migratedFrom)), expected = identities.get(source);
            if (!expected || retiredRoots.has(source) || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.birthtimeNs !== expected.birthtimeNs) {
              throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '迁移后的目录不是原服务持有的数据目录。 / Migrated directory identity changed.');
            }
            retiredRoots.add(source);
          }
          identities.set(resolved.canonical, actual);
        }
        if (releasePromise || !handles.every(handle => handle.isHeld()) || !rootMatches(resolved.canonical)) {
          throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '确认时数据目录身份发生变化。 / Data directory changed during confirmation.');
        }
      },
      async releaseStartup() {
        if (!startupFds.length) return;
        // A confirmed rename may intentionally leave no legacy junction. Only source roots
        // whose original inode was verified at the destination may be omitted here.
        const retained = roots.filter(root => !retiredRoots.has(rootAliases.get(pathModule.resolve(root))));
        const finalRoots = await Promise.all(retained.map(resolveRoot));
        if (finalRoots.some(root => root.missing || !canonical.includes(root.canonical) || !rootMatches(root.canonical))) {
          throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '初始化后的数据目录身份发生变化，请重新启动。 / Initialized data directory identity changed.');
        }
        closeStartup();
      },
      release() {
        if (!releasePromise) releasePromise = Promise.all(handles.map(handle => handle.release())).finally(closeStartup).then(() => undefined);
        return releasePromise;
      },
    });
  }
  return Object.freeze({ acquire, canonicalRoot, endpointFor, legacyEndpointFor, socketRecordFor });
})(require('net'), require('fs'), require('path'), require('os'), require('crypto'));
