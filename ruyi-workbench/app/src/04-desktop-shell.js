const DesktopShell = ((fsModule, fspModule, pathModule, osModule, cpModule, killTreeFn, batchSpawnFn, spawnDetachedFn, decodeConsoleTextFn) => {
  const fs = fsModule;
  const fsp = fspModule;
  const path = pathModule;
  const os = osModule;
  const cp = cpModule;
  const killChildTree = killTreeFn;
  const batchSafeSpawn = batchSpawnFn;
  // 分离式启动带 'error' 监听(见 00-boot spawnDetachedChecked):explorer.exe 起不来时不再是 uncaughtException。
  const spawnDetachedChecked = spawnDetachedFn;
  // v1.0.1 编码修复:Windows 子进程(powershell/cmd/git/python…)在中文系统默认按 OEM 代码页(GBK/cp936)
  // 输出,而非 UTF-8。此前 runProcess 按 UTF-8 逐块 toString → 中文全乱码(GBK 字节 c2a6c9bd… 被读成「¦ɽ」)。
  // 修法:累积原始字节,收尾时智能解码——先按 UTF-8 解;若出现替换符(�,说明不是合法 UTF-8),退回 GBK。
  // 我们自己以 UTF-8 输出的工具不受影响(合法 UTF-8 无替换符,原样保留),GBK 原生命令输出也能正确还原。
  // **headless 安全**:纯 Node 侧解码,不依赖控制台——[Console]::OutputEncoding 那类 PS 方案在无窗口 spawn 下
  // 会因无有效控制台句柄而静默失效(实测端到端仍乱码),Node 侧解码无此坑。
  // 2026-09 起改为【按行】判定(00-boot decodeConsoleText):修前整段只要有一处不是合法 UTF-8 就整段按 GBK 解,
  // 混排输出(git 的 UTF-8 + 系统命令的 GBK)里总有一半是乱码。
  function decodeBestEffort(buf) {
    return decodeConsoleTextFn(buf);
  }
  // ---------------------------------------------------------------------------------------------------
  // 执行结果整形(NE-1)。模型最终只看得到序列化 JSON 的前 ~60K 字符(10 truncateToolResult 平切),而修前 runProcess
  // 把 stdout 放在 stderr/退出码/超时标记之前、单流最多 2MB:输出一过 60K,错误文本、timedOut、尾部(构建报错所在)整块丢失。
  // 修法是在【源头】整形:每条流 头+尾(中间明确写「已省略 N 字符」),键序 ok/code/timedOut/interrupted/error/stderr 在前、
  // stdout 在后,`\r` 覆盖式进度条折叠成最终一行、ANSI 控制序列剥掉。只对 options.shape===true 的调用方(powershell_run /
  // script_run)生效 —— 其余内部调用方(MCP 登记、迁移中心、校验命令)要解析完整 stdout,不能被截。
  // ---------------------------------------------------------------------------------------------------
  const EXEC_TIMEOUT_DEFAULT = 60000;
  const EXEC_TIMEOUT_MIN = 1000;
  const EXEC_TIMEOUT_MAX = 30 * 60 * 1000;
  // NE-5:非数字 / NaN / 非正数 → 默认;其余夹到 [1s, 30min]。修前 `Number('abc')` = NaN → setTimeout(NaN) 约 1ms 就把进程杀了。
  function normalizeExecTimeout(raw, fallback = EXEC_TIMEOUT_DEFAULT) {
    const n = typeof raw === 'string' ? (raw.trim() === '' ? NaN : Number(raw)) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(EXEC_TIMEOUT_MAX, Math.max(EXEC_TIMEOUT_MIN, n));
  }
  const EXEC_STDOUT_HEAD = 8000, EXEC_STDOUT_TAIL = 24000;
  const EXEC_STDERR_HEAD = 4000, EXEC_STDERR_TAIL = 8000;
  const EXEC_JSON_BUDGET = 44000;            // 两条流序列化后的合计上限(远低于 60K 的模型硬顶;换行/引号转义会让 JSON 比原文长)
  const EXEC_HEAD_RAW_BYTES = 64 * 1024;     // 尾部滚动缓冲丢弃旧块后,开头另存这么多原始字节供「头」使用
  const EXEC_EXIT_GRACE_MS = 500;            // NE-4:主进程 exit 后等管道排空的静默宽限
  const EXEC_EXIT_GRACE_MAX_MS = 3000;       // 宽限的总上限(后台孙进程一直往管道写也不无限续期)
  const omitMarker = n => `\n[...已省略 ${n} 字符...]\n`;
  // ANSI CSI/OSC 剥掉;`\r\n` 归一为 `\n`;行内 `\r` 覆盖(pip/curl/winget/git clone 的进度条)只留最后一段非空文本。
  function condenseTerminalText(input) {
    let t = String(input == null ? '' : input);
    if (!t) return t;
    if (t.indexOf('\u001b') !== -1) t = t.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '');
    if (t.indexOf('\r') === -1) return t;
    t = t.replace(/\r\n/g, '\n');
    if (t.indexOf('\r') === -1) return t;
    return t.split('\n').map(line => {
      if (line.indexOf('\r') === -1) return line;
      const segs = line.split('\r');
      for (let i = segs.length - 1; i >= 0; i -= 1) if (segs[i] !== '') return segs[i];
      return '';
    }).join('\n');
  }
  // 头 n 字符,尽量收在整行边界(半行以上才回退),不劈开代理对。
  function cutHead(text, n) {
    if (text.length <= n) return text;
    let end = n;
    const nl = text.lastIndexOf('\n', n - 1);
    if (nl >= n * 0.5) end = nl + 1;
    else if (/[\ud800-\udbff]/.test(text[end - 1] || '')) end -= 1;
    return text.slice(0, end);
  }
  function cutTail(text, n) {
    if (text.length <= n) return text;
    let start = text.length - n;
    const nl = text.indexOf('\n', start);
    if (nl !== -1 && nl - start <= n * 0.5) start = nl + 1;
    else if (/[\udc00-\udfff]/.test(text[start] || '')) start += 1;
    return text.slice(start);
  }
  // 单段文本头+尾。够短原样返回;否则 头 + 省略标记 + 尾,omitted = 被省略的字符数。
  function headTailText(text, headN, tailN) {
    const s = String(text == null ? '' : text);
    if (s.length <= headN + tailN) return { text: s, omitted: 0 };
    const h = cutHead(s, headN);
    const t = cutTail(s, tailN);
    const omitted = Math.max(0, s.length - h.length - t.length);
    return { text: h + omitMarker(omitted) + t, omitted };
  }
  // 只保留开头、使序列化(JSON 转义后)长度不超过 budget。返回 { text, omitted }。
  function headTextToJsonBudget(text, budget) {
    const s = String(text == null ? '' : text);
    if (JSON.stringify(s).length <= budget) return { text: s, omitted: 0 };
    let n = Math.min(s.length, budget);
    let cut = cutHead(s, n);
    for (let i = 0; i < 8 && JSON.stringify(cut).length > budget; i += 1) {
      n = Math.max(1, Math.floor(n * (budget / JSON.stringify(cut).length) * 0.95));
      cut = cutHead(s, n);
    }
    return { text: cut, omitted: s.length - cut.length };
  }
  // src: { full } —— 整段都在;或 { head, tail, gapBytes } —— 滚动缓冲丢过旧块,开头/末尾各一段,中间 gapBytes 字节没了。
  function shapeOneStream(src, headN, tailN) {
    if (src.full !== undefined) {
      const r = headTailText(src.full, headN, tailN);
      return { text: r.text, omitted: r.omitted };
    }
    const h = cutHead(src.head, headN);
    const t = cutTail(src.tail, tailN);
    const omitted = src.gapBytes + (src.head.length - h.length) + (src.tail.length - t.length);
    return { text: h + omitMarker(omitted) + t, omitted };
  }
  function shapeExecStreams(outSrc, errSrc) {
    let scale = 1;
    let o; let e;
    for (;;) {
      o = shapeOneStream(outSrc, Math.floor(EXEC_STDOUT_HEAD * scale), Math.floor(EXEC_STDOUT_TAIL * scale));
      e = shapeOneStream(errSrc, Math.floor(EXEC_STDERR_HEAD * scale), Math.floor(EXEC_STDERR_TAIL * scale));
      if (scale <= 0.1 || JSON.stringify(o.text).length + JSON.stringify(e.text).length <= EXEC_JSON_BUDGET) break;
      scale *= 0.7;
    }
    return { stdout: o.text, stdoutOmitted: o.omitted, stderr: e.text, stderrOmitted: e.omitted };
  }

  function runProcess(command, args, options = {}) {
    return new Promise(resolve => {
      const start = Date.now();
      const timeoutMs = normalizeExecTimeout(options.timeoutMs);
      const shape = options.shape === true;
      const CAP = shape ? 1_000_000 : 2_000_000; // 字节上限(超出从最旧块丢弃,保留尾部;整形模式另存开头,见 EXEC_HEAD_RAW_BYTES)
      // 每条流一个状态:chunks 是滚动尾部,total 累计字节,dropped 被丢弃的旧块字节,head 开头原始字节(仅整形模式用)。
      const mkStream = () => ({ chunks: [], len: 0, total: 0, dropped: 0, head: Buffer.alloc(0), truncated: false });
      const outS = mkStream();
      const errS = mkStream();
      let timedOut = false;
      let interrupted = false;
      const collect = (st, d) => {
        st.chunks.push(d);
        st.len += d.length;
        st.total += d.length;
        if (shape && st.head.length < EXEC_HEAD_RAW_BYTES) st.head = Buffer.concat([st.head, d.subarray(0, EXEC_HEAD_RAW_BYTES - st.head.length)]);
        while (st.len > CAP && st.chunks.length > 1) { const old = st.chunks.shift(); st.len -= old.length; st.dropped += old.length; st.truncated = true; } // 审计 P0:CAP 截断需告知模型
      };
      const rawText = st => decodeBestEffort(Buffer.concat(st.chunks));
      const streamSrc = st => {
        if (!st.dropped) return { full: condenseTerminalText(rawText(st)) };
        if (st.dropped <= st.head.length) return { full: condenseTerminalText(decodeBestEffort(Buffer.concat([st.head.subarray(0, st.dropped), ...st.chunks]))) };
        return { head: condenseTerminalText(decodeBestEffort(st.head)), tail: condenseTerminalText(rawText(st)), gapBytes: st.dropped - st.head.length };
      };
      // Transparently wrap .cmd/.bat targets (e.g. claude.cmd) so they don't throw "spawn EINVAL".
      const s = options.shell ? { command, args, opts: {} } : batchSafeSpawn(command, args);
      const child = cp.spawn(s.command, s.args, {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...(options.env || {}) },
        windowsHide: true,
        shell: options.shell || false,
        // NE-3:一次性运行不给子进程一根永不关闭的 stdin 管道 —— 读 stdin / 弹提示(Read-Host、pause、input()、git commit 缺 -m)
        // 的程序会一直等到超时。'ignore' 让它们立刻读到 EOF / 得到错误;极少数要喂 stdin 的调用方传 options.stdin==='pipe'。
        stdio: options.stdin === 'pipe' ? 'pipe' : ['ignore', 'pipe', 'pipe'],
        ...s.opts,
      });
      // 审计 P2: 单次结算门 —— close/error/exit 宽限/超时兜底四条路径共用,防重复 resolve。
      let settled = false;
      let killGraceTimer = null;
      let exitTimer = null;
      let exitAt = 0;
      let exitInfo = null;
      const signal = options.signal;
      let abortHandler = null;
      const isBudgetKill = () => Boolean(signal && signal.reason === 'tool_time_budget');
      const abortSuffix = () => isBudgetKill() ? '\n[已触发工具时间预算硬上限;进程树已回收]' : '\n[interrupted by user steer; process tree killed]';
      // 收尾载荷。code = 退出码;extra.spawnError / extra.exitNote / extra.forceFail 见各调用点。
      const compose = (code, extra = {}) => {
        const ok = !extra.forceFail && code === 0 && !timedOut && !interrupted;
        const suffix = extra.errorText ? extra.errorText : interrupted ? abortSuffix() : (timedOut ? '\n[timed out; process tree killed]' : '');
        const budgetKilled = interrupted && isBudgetKill();
        if (!shape) {
          const stdout = decodeBestEffort(Buffer.concat(outS.chunks));
          const stderr = decodeBestEffort(Buffer.concat(errS.chunks)) + suffix;
          return { ok, code, stdout, stderr, elapsedMs: Date.now() - start, timedOut, interrupted, ...(budgetKilled ? { budgetKilled: true } : {}), ...(extra.exitNote ? { note: extra.exitNote } : {}) };
        }
        const sh = shapeExecStreams(streamSrc(outS), streamSrc(errS));
        const payload = { ok, code, timedOut, interrupted };
        if (budgetKilled) payload.budgetKilled = true;
        if (!ok) {
          let error; let hint;
          if (extra.spawnError) {
            const cwdMissing = extra.spawnError.code === 'ENOENT' && options.cwd && !fs.existsSync(options.cwd);
            if (cwdMissing) { error = `工作目录不存在: ${options.cwd}`; hint = '确认 cwd 是已存在的目录(Windows 用完整盘符路径),或省略 cwd 用线程工作目录'; }
            else {
              error = `无法启动进程 ${command}: ${extra.spawnError.message || extra.spawnError}`;
              if (extra.spawnError.code === 'ENOENT') hint = `找不到可执行文件 ${command};确认已安装并在 PATH 上`;
            }
          } else if (interrupted) {
            error = budgetKilled ? '已触发工具时间预算硬上限,进程树已回收' : '被用户插话中断,进程树已回收';
          } else if (timedOut) {
            error = `命令超过 ${timeoutMs}ms 仍未结束,已终止(进程树已回收);stdout/stderr 是已产生的部分输出`;
            hint = '长任务请用 shell_start({command}) 后台运行并用 shell_poll 取结果;或加大 timeoutMs(上限 1800000)';
          } else {
            error = code == null ? '进程被信号终止' : `进程以退出码 ${code} 结束`;
          }
          payload.error = error;
          if (hint) payload.hint = hint;
        }
        if (sh.stdoutOmitted || sh.stderrOmitted) {
          const h = '输出过长,只保留开头和结尾(中间已省略);要看完整内容请把命令输出重定向到文件后用 file_read 分段读,或先过滤(Select-String / Select-Object -Last N)';
          payload.hint = payload.hint ? payload.hint + ';' + h : h;
        }
        if (extra.exitNote) payload.note = extra.exitNote;
        payload.stderr = sh.stderr + suffix;
        if (sh.stderrOmitted) payload.stderrOmitted = sh.stderrOmitted;
        payload.stdout = sh.stdout;
        if (sh.stdoutOmitted) payload.stdoutOmitted = sh.stdoutOmitted;
        payload.elapsedMs = Date.now() - start;
        return payload;
      };
      const finish = payload => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killGraceTimer) clearTimeout(killGraceTimer);
        if (exitTimer) clearTimeout(exitTimer);
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
        if (outS.truncated) payload.stdoutTruncated = true;
        if (errS.truncated) payload.stderrTruncated = true;
        resolve(payload);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        // 审计 P2: 超时用 killChildTree 整树杀(128i 起按创建时间认子孙,不再 taskkill /T) —— child.kill('SIGTERM') 在 Windows 上只杀直接子
        // 进程,claude.cmd→node、shell→子命令等孙进程会遗孤泄漏,且其继承的 stdio 句柄不关 → 'close' 迟迟不触发,
        // promise 悬挂到远超 timeoutMs。killChildTree 内含 SIGKILL 兜底。
        killChildTree(child.pid);
        // 二次兜底:即便整树已杀,若仍有句柄让 'close' 不触发,3s 后硬 resolve,绝不让工具调用无限悬挂。
        killGraceTimer = setTimeout(() => finish(compose(-1, { forceFail: true })), 3000);
        if (killGraceTimer.unref) killGraceTimer.unref();
      }, timeoutMs);
      // 106 #13a-t: 中断原因感知 —— 仅新原因 'tool_time_budget' 走专用文案与 budgetKilled 标记;
      // 既有 'user_steer' / 'turn_stopped' 等一切旧原因文案逐字节不变。
      abortHandler = () => {
        if (settled) return;
        interrupted = true;
        killChildTree(child.pid);
        // Keep the normal close event as the primary settlement path, but never make steering wait on a
        // descendant that retained stdio handles after the tree kill.
        killGraceTimer = setTimeout(() => finish(compose(-1, { forceFail: true })), 1000);
        if (killGraceTimer.unref) killGraceTimer.unref();
      };
      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
        if (signal.aborted) abortHandler();
      }
      // NE-4:主进程 exit 后管道被一个脱离的孙进程(gradle/adb/docker daemon、Start-Process)继续占着 → 'close' 迟迟不来,
      // 工具调用被拖到孙进程退出(实测 8s+,甚至撞 timeoutMs 被判超时并杀树)。exit 后给一小段静默宽限排空管道(期间仍有数据就顺延,
      // 总共不超过 EXEC_EXIT_GRACE_MAX_MS),之后销毁我们这一侧的流并按已捕获的输出结算,note 如实说明。
      const settleAfterExit = () => {
        if (settled) return;
        try { if (child.stdout) child.stdout.destroy(); if (child.stderr) child.stderr.destroy(); } catch { /* already closed */ }
        finish(compose(exitInfo ? exitInfo.code : null, { exitNote: '进程已退出,但有后台子进程仍占着输出管道;已按退出时已收到的输出返回(之后写入的输出不含在内)' }));
      };
      const armExitTimer = () => {
        if (exitTimer) clearTimeout(exitTimer);
        exitTimer = setTimeout(settleAfterExit, EXEC_EXIT_GRACE_MS);
      };
      const onData = st => d => {
        collect(st, d);
        if (exitAt && !settled && Date.now() - exitAt < EXEC_EXIT_GRACE_MAX_MS) armExitTimer();
      };
      child.stdout?.on('data', onData(outS));
      child.stderr?.on('data', onData(errS));
      child.on('error', error => finish(compose(-1, { forceFail: true, spawnError: error, errorText: error.message })));
      child.on('exit', code => {
        exitInfo = { code: code === undefined ? null : code };
        exitAt = Date.now();
        armExitTimer();
      });
      child.on('close', code => finish(compose(code)));
    });
  }

  // v1.0.1 编码修复(输入侧):无控制台 spawn(用户双击运行时的真实场景)的 powershell.exe 解析 `-Command`
  // 参数里的中文会损坏(实测「娄山关」→「|???」——输入阶段就丢字,非输出解码问题)。改用带 BOM 的 UTF-8
  // 临时 .ps1 + `-File`:BOM 让 PS 无视控制台代码页、权威按 UTF-8 读脚本,中文 100% 正确进入。输出侧的 GBK
  // 乱码由 runProcess 的 decodeBestEffort 兜底(先 UTF-8、有替换符退 GBK)。两侧合起来彻底解决中文乱码。
  // NE-15:Windows PowerShell 5.1 在有进度条时 Invoke-WebRequest / Expand-Archive 慢一个数量级,无头运行又没人看进度 —— 脚本头静音。
  // 写在【第一行同一行】不加换行(报错行号不漂);脚本以 param()/using/#requires/[CmdletBinding] 开头时它们必须是第一条语句,不加。
  function withQuietProgress(command) {
    const text = String(command == null ? '' : command);
    if (/^\s*(?:param\s*\(|using\s|#requires|\[CmdletBinding)/i.test(text)) return text;
    return "$ProgressPreference='SilentlyContinue'; " + text;
  }
  // opts.shape:powershell_run 用 —— 结果按 runProcess 的整形模式(头+尾、键序、error/hint)返回;桌面截图等内部调用方要完整 stdout,不传。
  // NE-3:-NonInteractive —— Read-Host / pause / -Confirm 这类提示立刻抛错(模型能读到),不再挂到超时。
  async function runPowerShell(command, cwd, timeoutMs, signal, opts = {}) {
    const tmpFile = path.join(os.tmpdir(), `ruyi-ps-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
    await fsp.writeFile(tmpFile, '﻿' + withQuietProgress(command), 'utf8'); // UTF-8 BOM(﻿)+ 命令 → PS -File 权威按 UTF-8 读
    try {
      return await runProcess('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile,
      ], { cwd: cwd || os.homedir(), timeoutMs, signal, shape: !!(opts && opts.shape) });
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
        try { spawnDetachedChecked('explorer.exe', mode === 'open' ? [absPath] : ['/select,' + absPath], { detached: true, stdio: 'ignore' }); } catch { /* give up */ }
      });
      child.unref();
      return true;
    } catch (e) {
      fsp.unlink(tmpFile).catch(() => {});
      // Synchronous spawn failure → last-ditch direct explorer (opens, may be behind the browser).
      try { spawnDetachedChecked('explorer.exe', mode === 'open' ? [absPath] : ['/select,' + absPath], { detached: true, stdio: 'ignore' }); return true; } catch { return false; }
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
  return Object.freeze({ decodeBestEffort, runProcess, runPowerShell, withQuietProgress, normalizeExecTimeout, headTailText, headTextToJsonBudget, condenseTerminalText, revealInExplorer, pickFolder, pickFile });
})(fs, fsp, path, os, cp, killChildTree, batchSafeSpawn, spawnDetachedChecked, decodeConsoleText);
