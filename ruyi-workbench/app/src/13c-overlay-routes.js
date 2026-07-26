// 第53波 EC-B 安全更新中心(53b):overlay 离线更新 API 编排层。
//
// 不复制第二套更新实现 -- 只编排 tools/Manage-Overlay.ps1 这一份受测核心(precheck/apply/rollback/verify/audit)。
// 路由(全 token 级,同 checkpoints/rollback 破坏性档):
//   POST /api/overlay/precheck  { zipPath }                  解压 + precheck(写入前全检),返回预览
//   POST /api/overlay/apply      { zipPath, force? }          解压 + apply(PS1 内联 precheck 后才写入)
//   GET  /api/overlay/status                                  当前版本/备份/审计尾(直接读文件,无需 PS1)
//   POST /api/overlay/rollback                                回滚到最近备份(需缓存 PS1)
//
// 安全纪律:
//   - zipPath 必须绝对路径 + .zip 后缀 + 存在;解压到 dataRoot/overlay-tool/extract-<rand>/(工作区内)
//   - 解压用 PowerShell Expand-Archive(零依赖;PS5.1+ 自身有 zip-slip 防护),precheck 再校验 manifest 条目路径
//   - PS1 从解压包内取(包自带 Manage-Overlay.ps1),缓存到 dataRoot/overlay-tool/ 供后续 rollback/audit
//   - 不在前端拼写启动命令;logEvent 审计每个动作
// 共享作用域拼接(同 13b):readJsonBody/send/json/tokenOk/logEvent/externalRoot/dataRoot/fs/fsp/path/crypto/cp 均在 bundle 作用域。

const OVERLAY_TOOL_DIR = () => path.join(dataRoot(), 'overlay-tool');
const OVERLAY_PS1 = () => path.join(OVERLAY_TOOL_DIR(), 'Manage-Overlay.ps1');
const OVERLAY_PS1_TIMEOUT = 300000; // 5min(apply 含 backup+copy+verify;run_command 类对齐桥 650s 但 overlay 更可控)

// 解压 zip 到 destDir(PowerShell Expand-Archive,零依赖)。返回 {ok, error?}。
async function extractOverlayZip(zipPath, destDir) {
  try {
    await fsp.mkdir(destDir, { recursive: true });
    // 单引号转义(PS 单引号字符串内 '' 表示一个 ');-Force 覆盖。
    const qs = s => String(s).replace(/'/g, "''");
    const ps = "try { Expand-Archive -LiteralPath '" + qs(zipPath) + "' -DestinationPath '" + qs(destDir) + "' -Force -ErrorAction Stop; 'OK' } catch { 'ERR:' + $_.Exception.Message }";
    const out = cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    const trimmed = String(out || '').trim();
    if (trimmed.startsWith('ERR:')) return { ok: false, error: trimmed.slice(4) };
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// 在解压目录里找 overlay 根(含 Manage-Overlay.ps1 + payload/update-manifest.json)。深度 ≤2(根或一层子目录)。
async function findOverlayRoot(extractedDir) {
  const candidates = [extractedDir];
  try {
    for (const e of await fsp.readdir(extractedDir, { withFileTypes: true })) {
      if (e.isDirectory()) candidates.push(path.join(extractedDir, e.name));
    }
  } catch { /* ignore */ }
  for (const c of candidates) {
    const ps1 = path.join(c, 'Manage-Overlay.ps1');
    const mani = path.join(c, 'payload', 'update-manifest.json');
    if (fs.existsSync(ps1) && fs.existsSync(mani)) return c;
  }
  return null;
}

// 调用 PS1,捕获 stdout(期待 -Json 单对象输出),切片解析。返回 {ok, json?, raw?, error?}。
// 对抗审查 F4:用 cp.execFile(异步)非 execFileSync -- 后者阻塞 Node 事件循环最长 5min,apply 期间全服务挂起。
// 路由处 await。PS1 非 0 退出(precheck 失败/apply 拒绝)仍向 stdout 写 JSON 再 exit 1,故从 stdout 取。
function runOverlayPs1(ps1Path, action, overlayRoot, target, extraArgs) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1Path, '-Action', action, '-Json'];
  if (overlayRoot) args.push('-OverlayRoot', overlayRoot);
  if (target) args.push('-Target', target);
  if (Array.isArray(extraArgs)) args.push(...extraArgs);
  return new Promise(resolve => {
    cp.execFile('powershell', args, { encoding: 'utf8', timeout: OVERLAY_PS1_TIMEOUT, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const so = String(stdout || (err && err.stdout) || '');
      const j = tryParseJson(so);
      if (j) return resolve({ ok: true, json: j, raw: so });
      if (err && !so) return resolve({ ok: false, error: String(err.message || err), stderr: String(stderr || ''), raw: '' });
      if (err) return resolve({ ok: false, error: String(err.message || err), stderr: String(stderr || ''), raw: so });
      resolve({ ok: false, error: 'non-JSON output from PS1', raw: so });
    });
  });
}

// 从可能含杂质的 stdout 中切首个 {...} 解析(PS1 -Json 应只输出单对象,但防御性切片)。
function tryParseJson(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
}

// 缓存 PS1(从解压包内拷到 dataRoot/overlay-tool/,供后续 rollback/audit)。best-effort。
async function cacheOverlayPs1(overlayRoot) {
  try {
    await fsp.mkdir(OVERLAY_TOOL_DIR(), { recursive: true });
    await fsp.copyFile(path.join(overlayRoot, 'Manage-Overlay.ps1'), OVERLAY_PS1());
    return true;
  } catch { return false; }
}

// 读部署根的 overlay 状态(直接读文件,无需 PS1;status 路由用,无 PS1 缓存也能工作)。
// 注意:PS1 用 Set-Content/Add-Content -Encoding UTF8 写文件(PS5.1 带BOM),Node JSON.parse 遇BOM会抛;
// 故读后剥 BOM(﻿)。update-manifest.json 由 gen-manifest.js 写(无BOM),不受影响。
function stripBom(s) { return String(s || '').replace(/^﻿/, ''); }
async function readOverlayStatusDirect(target) {
  const status = { current: null, backups: [], audit: [] };
  const appliedPath = path.join(target, '.overlay-applied.json');
  if (fs.existsSync(appliedPath)) {
    try { status.current = JSON.parse(stripBom(await fsp.readFile(appliedPath, 'utf8'))); } catch { /* ignore */ }
  }
  const backupsDir = path.join(target, '.overlay-backups');
  if (fs.existsSync(backupsDir)) {
    try {
      const entries = await fsp.readdir(backupsDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          let fileCount = 0;
          try { const walk = dir => fsp.readdir(dir, { withFileTypes: true }).then(es => Promise.all(es.map(x => x.isDirectory() ? walk(path.join(dir, x.name)) : Promise.resolve(fileCount++)))); await walk(path.join(backupsDir, e.name)); } catch { /* ignore */ }
          status.backups.push({ name: e.name, fileCount, createdAt: e.mtimeMs || null });
        }
      }
      status.backups.sort((a, b) => String(b.name).localeCompare(String(a.name)));
    } catch { /* ignore */ }
  }
  const auditLog = path.join(target, '.overlay-audit.jsonl');
  if (fs.existsSync(auditLog)) {
    try {
      const lines = stripBom(await fsp.readFile(auditLog, 'utf8')).split(/\r?\n/).filter(x => x.trim());
      const tail = lines.slice(-50);
      for (const line of tail) { try { status.audit.push(JSON.parse(line)); } catch { /* ignore */ } }
    } catch { /* ignore */ }
  }
  return status;
}

async function handleOverlayApiRoutes(req, res, pathname) {
  // POST /api/overlay/precheck { zipPath } -- 解压 + precheck(写入前全检),返回预览。
  if (req.method === 'POST' && pathname === '/api/overlay/precheck') {
    const body = await readJsonBody(req);
    const zipPath = body && typeof body.zipPath === 'string' ? body.zipPath.trim() : '';
    if (!zipPath || !path.isAbsolute(zipPath)) return send(res, json({ ok: false, error: '请提供 overlay zip 包的绝对路径' }, 400));
    if (!zipPath.toLowerCase().endsWith('.zip') || !fs.existsSync(zipPath)) return send(res, json({ ok: false, error: 'zip 包不存在或不是 .zip 文件' }, 400));
    const extractDir = path.join(OVERLAY_TOOL_DIR(), 'extract-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'));
    const ext = await extractOverlayZip(zipPath, extractDir);
    if (!ext.ok) { await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {}); return send(res, json({ ok: false, error: '解压失败: ' + ext.error }, 500)); }
    const overlayRoot = await findOverlayRoot(extractDir);
    if (!overlayRoot) { await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {}); return send(res, json({ ok: false, error: '解压后未找到 overlay 包(缺 Manage-Overlay.ps1 + payload/update-manifest.json)' }, 400)); }
    await cacheOverlayPs1(overlayRoot);
    const target = externalRoot();
    const r = await runOverlayPs1(OVERLAY_PS1(), 'precheck', overlayRoot, target, []);
    await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    logEvent({ kind: 'overlay_precheck', ok: !!(r.ok && r.json && r.json.ok), version: r.json && r.json.version });
    if (!r.ok || !r.json) return send(res, json({ ok: false, error: (r && r.error) || 'PS1 调用失败', raw: r && r.raw }, 500));
    return send(res, json(r.json));
  }

  // POST /api/overlay/apply { zipPath, force? } -- 解压 + apply(PS1 内联 precheck 后才写入)。
  if (req.method === 'POST' && pathname === '/api/overlay/apply') {
    const body = await readJsonBody(req);
    const zipPath = body && typeof body.zipPath === 'string' ? body.zipPath.trim() : '';
    const force = !!(body && body.force);
    if (!zipPath || !path.isAbsolute(zipPath)) return send(res, json({ ok: false, error: '请提供 overlay zip 包的绝对路径' }, 400));
    if (!zipPath.toLowerCase().endsWith('.zip') || !fs.existsSync(zipPath)) return send(res, json({ ok: false, error: 'zip 包不存在或不是 .zip 文件' }, 400));
    const extractDir = path.join(OVERLAY_TOOL_DIR(), 'extract-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'));
    const ext = await extractOverlayZip(zipPath, extractDir);
    if (!ext.ok) { await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {}); return send(res, json({ ok: false, error: '解压失败: ' + ext.error }, 500)); }
    const overlayRoot = await findOverlayRoot(extractDir);
    if (!overlayRoot) { await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {}); return send(res, json({ ok: false, error: '解压后未找到 overlay 包' }, 400)); }
    await cacheOverlayPs1(overlayRoot);
    const target = externalRoot();
    const r = await runOverlayPs1(OVERLAY_PS1(), 'apply', overlayRoot, target, force ? ['-Force'] : []);
    await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    logEvent({ kind: 'overlay_apply', ok: !!(r.ok && r.json && r.json.ok), version: r.json && r.json.version, force });
    if (!r.ok || !r.json) return send(res, json({ ok: false, error: (r && r.error) || 'PS1 调用失败', raw: r && r.raw }, 500));
    return send(res, json(r.json));
  }

  // GET /api/overlay/status -- 当前版本/备份/审计尾(直接读文件,无需 PS1)。GET 须 handler 内自查 token(同 /api/audit 纪律)。
  if (req.method === 'GET' && pathname === '/api/overlay/status') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    try {
      const status = await readOverlayStatusDirect(externalRoot());
      return send(res, json({ ok: true, ...status }));
    } catch (e) {
      return send(res, json({ ok: false, error: String(e && e.message || e) }, 500));
    }
  }

  // POST /api/overlay/rollback -- 回滚到最近备份(需缓存 PS1;无则提示预检或 CLI 救援)。
  if (req.method === 'POST' && pathname === '/api/overlay/rollback') {
    if (!fs.existsSync(OVERLAY_PS1())) return send(res, json({ ok: false, error: '未缓存 overlay 工具;请先对一个 overlay 包执行预检,或用 Manage-Overlay.cmd rollback 作为救援路径' }, 409));
    const target = externalRoot();
    // -Force:API 跑在服务内,PS1 rollback 默认拒(服务在跑);-Force 跳过端口拒,文件覆写后 restart 加载恢复的旧文件(同 apply 语义)。
    const r = await runOverlayPs1(OVERLAY_PS1(), 'rollback', null, target, ['-Force']);
    logEvent({ kind: 'overlay_rollback', ok: !!(r.ok && r.json && r.json.ok) });
    if (!r.ok || !r.json) return send(res, json({ ok: false, error: (r && r.error) || 'PS1 调用失败', raw: r && r.raw }, 500));
    return send(res, json(r.json));
  }
}
