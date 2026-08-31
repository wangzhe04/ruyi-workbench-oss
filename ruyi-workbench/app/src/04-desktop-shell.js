const DesktopShell = ((fsModule, fspModule, pathModule, osModule, cpModule, killTreeFn, batchSpawnFn) => {
  const fs = fsModule;
  const fsp = fspModule;
  const path = pathModule;
  const os = osModule;
  const cp = cpModule;
  const killChildTree = killTreeFn;
  const batchSafeSpawn = batchSpawnFn;
  // v1.0.1 编码修复:Windows 子进程(powershell/cmd/git/python…)在中文系统默认按 OEM 代码页(GBK/cp936)
  // 输出,而非 UTF-8。此前 runProcess 按 UTF-8 逐块 toString → 中文全乱码(GBK 字节 c2a6c9bd… 被读成「¦ɽ」)。
  // 修法:累积原始字节,收尾时智能解码——先按 UTF-8 解;若出现替换符(�,说明不是合法 UTF-8),退回 GBK。
  // 我们自己以 UTF-8 输出的工具不受影响(合法 UTF-8 无替换符,原样保留),GBK 原生命令输出也能正确还原。
  // **headless 安全**:纯 Node 侧解码,不依赖控制台——[Console]::OutputEncoding 那类 PS 方案在无窗口 spawn 下
  // 会因无有效控制台句柄而静默失效(实测端到端仍乱码),Node 侧解码无此坑。
  let _gbkDecoder = null;
  function decodeBestEffort(buf) {
    const utf8 = buf.toString('utf8');
    if (!utf8.includes('�')) return utf8;
    try { if (!_gbkDecoder) _gbkDecoder = new TextDecoder('gbk'); return _gbkDecoder.decode(buf); }
    catch { return utf8; } // 该 node 无 gbk ICU → 退回 UTF-8(至少不崩)
  }
  function runProcess(command, args, options = {}) {
    return new Promise(resolve => {
      const start = Date.now();
      const timeoutMs = Math.max(1000, Number(options.timeoutMs || 60000));
      const CAP = 2_000_000; // 字节上限(超出从最旧块丢弃,保留尾部,与旧行为一致)
      const outChunks = []; let outLen = 0;
      const errChunks = []; let errLen = 0;
      let timedOut = false;
      let interrupted = false;
      let outTruncated = false, errTruncated = false;  // 审计 P0:CAP 截断需告知模型(命令输出被工具层截,非下游 60KB 再截)
      const collect = (chunks, d, isOut) => {
        chunks.push(d);
        if (isOut) { outLen += d.length; while (outLen > CAP && outChunks.length > 1) { outLen -= outChunks.shift().length; outTruncated = true; } }
        else { errLen += d.length; while (errLen > CAP && errChunks.length > 1) { errLen -= errChunks.shift().length; errTruncated = true; } }
      };
      // Transparently wrap .cmd/.bat targets (e.g. claude.cmd) so they don't throw "spawn EINVAL".
      const s = options.shell ? { command, args, opts: {} } : batchSafeSpawn(command, args);
      const child = cp.spawn(s.command, s.args, {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...(options.env || {}) },
        windowsHide: true,
        shell: options.shell || false,
        ...s.opts,
      });
      // 审计 P2: 单次结算门 —— close/error/超时兜底三条路径共用,防重复 resolve。
      let settled = false;
      let killGraceTimer = null;
      const signal = options.signal;
      let abortHandler = null;
      const finish = payload => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killGraceTimer) clearTimeout(killGraceTimer);
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
        if (outTruncated) payload.stdoutTruncated = true;
        if (errTruncated) payload.stderrTruncated = true;
        resolve(payload);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        // 审计 P2: 超时用 killChildTree(taskkill /T /F)整树杀 —— child.kill('SIGTERM') 在 Windows 上只杀直接子
        // 进程,claude.cmd→node、shell→子命令等孙进程会遗孤泄漏,且其继承的 stdio 句柄不关 → 'close' 迟迟不触发,
        // promise 悬挂到远超 timeoutMs。killChildTree 内含 SIGKILL 兜底。
        killChildTree(child.pid);
        // 二次兜底:即便整树已杀,若仍有句柄让 'close' 不触发,3s 后硬 resolve,绝不让工具调用无限悬挂。
        killGraceTimer = setTimeout(() => finish({ ok: false, code: -1, stdout: decodeBestEffort(Buffer.concat(outChunks)), stderr: decodeBestEffort(Buffer.concat(errChunks)) + '\n[timed out; process tree killed]', elapsedMs: Date.now() - start, timedOut: true }), 3000);
        if (killGraceTimer.unref) killGraceTimer.unref();
      }, timeoutMs);
      abortHandler = () => {
        if (settled) return;
        interrupted = true;
        killChildTree(child.pid);
        // Keep the normal close event as the primary settlement path, but never make steering wait on a
        // descendant that retained stdio handles after the tree kill.
        killGraceTimer = setTimeout(() => finish({ ok: false, code: -1, stdout: decodeBestEffort(Buffer.concat(outChunks)), stderr: decodeBestEffort(Buffer.concat(errChunks)) + '\n[interrupted by user steer; process tree killed]', elapsedMs: Date.now() - start, interrupted: true }), 1000);
        if (killGraceTimer.unref) killGraceTimer.unref();
      };
      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
        if (signal.aborted) abortHandler();
      }
      child.stdout?.on('data', d => collect(outChunks, d, true));
      child.stderr?.on('data', d => collect(errChunks, d, false));
      child.on('error', error => finish({ ok: false, code: -1, stdout: decodeBestEffort(Buffer.concat(outChunks)), stderr: decodeBestEffort(Buffer.concat(errChunks)) + error.message, elapsedMs: Date.now() - start, timedOut }));
      child.on('close', code => finish({ ok: code === 0 && !timedOut && !interrupted, code, stdout: decodeBestEffort(Buffer.concat(outChunks)), stderr: decodeBestEffort(Buffer.concat(errChunks)) + (interrupted ? '\n[interrupted by user steer; process tree killed]' : ''), elapsedMs: Date.now() - start, timedOut, interrupted }));
    });
  }

  // v1.0.1 编码修复(输入侧):无控制台 spawn(用户双击运行时的真实场景)的 powershell.exe 解析 `-Command`
  // 参数里的中文会损坏(实测「娄山关」→「|???」——输入阶段就丢字,非输出解码问题)。改用带 BOM 的 UTF-8
  // 临时 .ps1 + `-File`:BOM 让 PS 无视控制台代码页、权威按 UTF-8 读脚本,中文 100% 正确进入。输出侧的 GBK
  // 乱码由 runProcess 的 decodeBestEffort 兜底(先 UTF-8、有替换符退 GBK)。两侧合起来彻底解决中文乱码。
  async function runPowerShell(command, cwd, timeoutMs, signal) {
    const tmpFile = path.join(os.tmpdir(), `ruyi-ps-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
    await fsp.writeFile(tmpFile, '﻿' + command, 'utf8'); // UTF-8 BOM(﻿)+ 命令 → PS -File 权威按 UTF-8 读
    try {
      return await runProcess('powershell.exe', [
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile,
      ], { cwd: cwd || os.homedir(), timeoutMs, signal });
    } finally {
      fsp.unlink(tmpFile).catch(() => {});
    }
  }

  // v1.0.2 返修三:reveal-in-explorer WITH foreground.  真机诊断(把关人亲验):/api/file/reveal 直接
  // cp.spawn('explorer.exe','/select,…') 从【后台服务进程】启动时,资源管理器窗口开在浏览器【后面】—— Windows
  // 前台锁不让后台进程抢占前台(实测:server 端点调用后 revfg 窗口数 +1 但前台仍是 chrome)。用户遂报「弹不出来」。
  // 修:改由 PowerShell 助手打开/定位后,用 AttachThreadInput+SetForegroundWindow 把窗口提到最前(从前台锁绕行的
  // 标准手法,已实测 claude→explorer 生效)。安全:目标路径经【环境变量 RUYI_REVEAL_PATH】传入,绝不拼进脚本文本
  // → 零命令注入;脚本纯 ASCII + BOM 临时文件(v1.0.1 编码教训)。windowsHide 只作用于 powershell 自身(消除其
  // 控制台闪窗),它 Start-Process 出来的 explorer 是独立进程、照常显示并被提前台(与 office_open 的 cmd/c start 同理)。
  // mode:'select'=定位并选中 | 'open'=用默认程序打开(server 已对可执行/脚本降级为 select,见 buildRevealSpawn)。
  const REVEAL_PS_SCRIPT = [
    "$target = $env:RUYI_REVEAL_PATH",
    "if (-not $target) { exit 2 }",
    "$mode = $env:RUYI_REVEAL_MODE; if (-not $mode) { $mode = 'select' }",
    "if ($mode -eq 'open') { Start-Process -FilePath $target; exit 0 }",
    "Add-Type -TypeDefinition @\"",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class RuyiFg {",
    "  [DllImport(\"user32.dll\")] static extern bool SetForegroundWindow(IntPtr h);",
    "  [DllImport(\"user32.dll\")] static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);",
    "  [DllImport(\"user32.dll\")] static extern bool AttachThreadInput(uint a, uint b, bool f);",
    "  [DllImport(\"user32.dll\")] static extern bool BringWindowToTop(IntPtr h);",
    "  [DllImport(\"user32.dll\")] static extern bool ShowWindow(IntPtr h, int n);",
    "  [DllImport(\"kernel32.dll\")] static extern uint GetCurrentThreadId();",
    "  public static void Force(long hw) {",
    "    IntPtr h = new IntPtr(hw);",
    "    if (h == IntPtr.Zero) return;",
    "    ShowWindow(h, 9);", // SW_RESTORE
    "    IntPtr fg = GetForegroundWindow();",
    "    uint pidA; uint tA = GetWindowThreadProcessId(fg, out pidA);",
    "    uint me = GetCurrentThreadId();",
    "    if (tA != me) AttachThreadInput(me, tA, true);",
    "    BringWindowToTop(h); SetForegroundWindow(h);",
    "    if (tA != me) AttachThreadInput(me, tA, false);",
    "  }",
    "}",
    "\"@",
    "Start-Process explorer.exe -ArgumentList ('/select,' + $target)",
    "Start-Sleep -Milliseconds 500",
    "$folder = (Split-Path -Parent $target).TrimEnd('\\')",
    "$sh = New-Object -ComObject Shell.Application",
    "foreach ($w in @($sh.Windows())) {",
    "  $u = $null; try { $u = $w.LocationURL } catch {}",
    "  if ($u) { try { if (([Uri]$u).LocalPath.TrimEnd('\\') -ieq $folder) { [RuyiFg]::Force([int64]$w.HWND); break } } catch {} }",
    "}",
    "exit 0",
  ].join('\r\n');
  // Fire-and-forget reveal. Writes the BOM'd ASCII script to a temp .ps1 and spawns powershell with the target
  // path in the environment (never in the argv/script text). Never throws to the caller — best-effort; the HTTP
  // handler returns ok as soon as the spawn is initiated (matching prior behavior; the window appears ~1s later).
  function revealInExplorer(absPath, mode) {
    const tmpFile = path.join(os.tmpdir(), `ruyi-reveal-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
    try {
      fs.writeFileSync(tmpFile, '﻿' + REVEAL_PS_SCRIPT, 'utf8'); // sync so the file exists before spawn reads it
      const child = cp.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile], {
        stdio: 'ignore', windowsHide: true, // hides PS console only; Start-Process'd explorer still shows + foregrounds
        env: { ...process.env, RUYI_REVEAL_PATH: absPath, RUYI_REVEAL_MODE: (mode === 'open' ? 'open' : 'select') },
      });
      const cleanup = () => { fsp.unlink(tmpFile).catch(() => {}); };
      child.on('exit', cleanup);
      child.on('error', () => { // powershell missing → fall back to a plain (possibly-behind) explorer open
        cleanup();
        try { cp.spawn('explorer.exe', mode === 'open' ? [absPath] : ['/select,' + absPath], { detached: true, stdio: 'ignore' }).unref(); } catch { /* give up */ }
      });
      child.unref();
      return true;
    } catch (e) {
      fsp.unlink(tmpFile).catch(() => {});
      // Synchronous spawn failure → last-ditch direct explorer (opens, may be behind the browser).
      try { cp.spawn('explorer.exe', mode === 'open' ? [absPath] : ['/select,' + absPath], { detached: true, stdio: 'ignore' }).unref(); return true; } catch { return false; }
    }
  }

  // v0.9-S3 (C3): pop the native Windows folder picker (System.Windows.Forms.FolderBrowserDialog). The
  // dialog REQUIRES a Single-Threaded Apartment — `powershell -STA` (WinForms deadlocks/misbehaves under the
  // default MTA). Returns { ok:true, path } on selection, { ok:true, cancelled:true } on cancel, or
  // { ok:false, error, hint } when unavailable (non-Windows, or WinForms can't load). 120s timeout: the user
  // is interacting with a modal dialog, so this must outlast a normal tool. STDOUT = the selected path (or
  // empty on cancel); we echo a sentinel prefix to disambiguate cancel from an empty selection.
  async function pickFolder() {
    if (process.platform !== 'win32') {
      return { ok: false, error: '原生文件夹选择器仅支持 Windows', hint: '请在文件夹输入框中直接粘贴完整路径' };
    }
    // The script is passed to `-Command`; it Add-Types WinForms, shows the dialog, and prints either
    // "OK\t<path>" or "CANCEL". A failure to load WinForms throws and is caught below.
    // v1.0.2 返修:无 owner 的 ShowDialog() 常被压在浏览器窗口后面 —— 用户以为「点了没反应」(真机反馈
    // 「工作区改不了」的一大来源)。造一个隐形 TopMost owner form,对话框随 owner 置顶到最前。纯 ASCII 脚本
    // (v1.0.1 编码教训:-Command 里不放中文)。
    const script = "Add-Type -AssemblyName System.Windows.Forms; "
      + "$f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $f.ShowInTaskbar = $false; "
      + "$f.FormBorderStyle = 'None'; $f.Opacity = 0; "
      + "$f.StartPosition = 'CenterScreen'; $f.Show(); $f.Activate(); "
      + "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
      // v1.0.2 返修·致命修复:原脚本写 ('OK`t' + …) —— PowerShell 单引号字符串里反引号【不】转义,输出的是
      // 字面 OK`t 而非 TAB,下方 /^OK\t/ 正则永不匹配 → 用户选好的路径被当「取消」静默丢弃。原生选择器自
      // v0.9-S3 上线起从未真正工作过(真弹窗无法进自动化 e2e,一直漏网;Node spawn 实测复现)。改用 [char]9
      // 显式拼 TAB,协议两侧终于一致。
      + "if ($d.ShowDialog($f) -eq 'OK') { Write-Output ('OK' + [char]9 + $d.SelectedPath) } else { Write-Output 'CANCEL' }; "
      + "$f.Close()";
    let result;
    try {
      // -STA is the load-bearing flag (COM/WinForms apartment). windowsHide would hide the dialog too, so
      // runProcess must NOT hide the window here — runProcess sets windowsHide:true, but the modal dialog is
      // owned by the STA message loop and still shows; the parent console stays hidden which is fine.
      result = await runProcess('powershell.exe', [
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-Command', script,
      ], { cwd: os.homedir(), timeoutMs: 120000 });
    } catch (e) {
      return { ok: false, error: '无法启动文件夹选择器: ' + (e && e.message || e), hint: '请在文件夹输入框中直接粘贴完整路径' };
    }
    const out = String((result && result.stdout) || '').trim();
    // WinForms load failure surfaces on stderr with a non-zero exit → treat as unavailable.
    if (result && result.ok === false && !out) {
      return { ok: false, error: String(result.stderr || '选择器不可用').slice(0, 400), hint: '请在文件夹输入框中直接粘贴完整路径' };
    }
    if (/^CANCEL$/m.test(out) || out === '') return { ok: true, cancelled: true };
    const m = out.match(/^OK\t(.+)$/m);
    if (m && m[1].trim()) return { ok: true, path: path.resolve(m[1].trim()) };
    // Unexpected shape → treat as cancel rather than inventing a path.
    return { ok: true, cancelled: true };
  }

  // 第53波 EC-B(53d):原生文件选择器(OpenFileDialog,选 overlay zip 等单文件)。同 pickFolder 的 TopMost owner
  // 模式(无 owner 的 ShowDialog 会被压浏览器后面);filter 如 "Zip 包 (*.zip)|*.zip|所有文件|*.*"。
  async function pickFile(filter) {
    if (process.platform !== 'win32') {
      return { ok: false, error: '原生文件选择器仅支持 Windows', hint: '请直接粘贴完整路径' };
    }
    const safeFilter = String(filter || 'All files|*.*').replace(/'/g, '');
    const script = "Add-Type -AssemblyName System.Windows.Forms; "
      + "$f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $f.ShowInTaskbar = $false; "
      + "$f.FormBorderStyle = 'None'; $f.Opacity = 0; "
      + "$f.StartPosition = 'CenterScreen'; $f.Show(); $f.Activate(); "
      + "$d = New-Object System.Windows.Forms.OpenFileDialog; "
      + "$d.Filter = '" + safeFilter + "'; "
      + "if ($d.ShowDialog($f) -eq 'OK') { Write-Output ('OK' + [char]9 + $d.FileName) } else { Write-Output 'CANCEL' }; "
      + "$f.Close()";
    let result;
    try {
      result = await runProcess('powershell.exe', [
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-Command', script,
      ], { cwd: os.homedir(), timeoutMs: 120000 });
    } catch (e) {
      return { ok: false, error: '无法启动文件选择器: ' + (e && e.message || e), hint: '请直接粘贴完整路径' };
    }
    const out = String((result && result.stdout) || '').trim();
    if (result && result.ok === false && !out) {
      return { ok: false, error: String(result.stderr || '选择器不可用').slice(0, 400), hint: '请直接粘贴完整路径' };
    }
    if (/^CANCEL$/m.test(out) || out === '') return { ok: true, cancelled: true };
    const m = out.match(/^OK	(.+)$/m);
    if (m && m[1].trim()) return { ok: true, path: path.resolve(m[1].trim()) };
    return { ok: true, cancelled: true };
  }
  return Object.freeze({ decodeBestEffort, runProcess, runPowerShell, revealInExplorer, pickFolder, pickFile });
})(fs, fsp, path, os, cp, killChildTree, batchSafeSpawn);
