'use strict';
// 128c(48 号文 §1):测试收尾「只杀自己的树」—— 替换各件复制的 `taskkill /PID <pid> /T /F`。
//
// 为什么不能再用 /T:taskkill /T 按 ParentProcessId 找子孙,而 Windows 的 ParentProcessId 在父进程死后【不更新】、
// 进程号又复用得很勤。本机当下就有 explorer.exe／WPS／Steam／Qoder 的父进程早已不在 —— 若某次测试服务恰好拿到了
// 它们那个过期父号,/T 会不会把它们当成「子孙」一起杀?128c 取证没能在合理时间内逼出撞号(3 万次 spawn 未复用),
// /T 是否核对创建时间【仍未验证】。F8 那次真实误杀(用户的 Ollama)就是同一机理(自造 runner 按父号认子孙)。
// 所以不赌它:
//   · 根:只杀【还没退出】的自己的子进程。Node 手上的 ChildProcess 句柄没关之前 Windows 不会复用这个号
//     (128c 取证:事件循环不跑、句柄不关时 6000 次 spawn 一次都没复用到) ⇒ 此刻这个号一定还是它。
//     已经退出的根【不碰】—— 它的号可能已经是别人的了。
//   · 子孙:从一次进程表快照里按父号往下找,但【只认创建时间不早于父进程的】—— 父号过期、恰好撞号的陌生进程
//     一定比我们的根更早被创建(它的父号是在我们的根出生之前就挂上的),按构造排除。
//   · 杀子孙前再核一次启动时间(快照与动手之间若有进程退出、号被复用,对不上就不杀),逐个 /PID 不带 /T。
// 纯函数 ownDescendants 与快照解析分开导出,unit/kill-own-tree.test.js 用合成进程表钉住「撞号的陌生人不算子孙」。
const cp = require('child_process');

// 进程表一行:{ pid, ppid, created, name }(created = CreationDate 的 FILETIME,UTC 100ns 刻度,BigInt 以免精度丢失)。
function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(\d+),(\d+),(\d+)(?:,([^,\r\n]*))?\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: BigInt(m[3]), name: String(m[4] || '').trim().toLowerCase() });
  }
  return rows;
}

// 从 rootPid 往下找自己的子孙(广度优先)。认子的判据:ppid === 父.pid 且 created >= 父.created。
// 返回的顺序是「先父后子」;调用方杀的时候先杀根(停止再生),再按这个顺序杀子孙。
function ownDescendants(table, rootPid) {
  const root = table.find(r => r.pid === rootPid);
  if (!root) return { root: null, descendants: [] };
  const descendants = [];
  const seen = new Set([root.pid]);
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift();
    for (const r of table) {
      if (seen.has(r.pid) || r.ppid !== parent.pid || r.pid === parent.pid) continue;
      if (r.created < parent.created) continue;   // 父号过期、撞号的陌生进程:比「父亲」还老,不是它生的
      seen.add(r.pid);
      descendants.push(r);
      queue.push(r);
    }
  }
  return { root, descendants };
}

const SNAPSHOT_PS = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | '
  + 'ForEach-Object { if ($_.CreationDate) { "$($_.ProcessId),$($_.ParentProcessId),$($_.CreationDate.ToFileTimeUtc()),$($_.Name)" } }';

function snapshotProcessTable() {
  const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SNAPSHOT_PS],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (r.error || r.status !== 0) return null;
  return parseProcessTable(r.stdout);
}

// Linux:同形的进程表取自 /proc/<pid>/stat。created 用第 22 列 starttime(开机以来的时钟滴答),
// 与 Windows 的 FILETIME 一样只拿来比先后,所以 ownDescendants 原样复用。进程名在括号里、可能含空格与括号,
// 按最后一个 ')' 切开再数列。
function readProcStat(pid) {
  try {
    const stat = require('fs').readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const tail = stat.slice(close + 2).split(' ');   // tail[0]=state(第 3 列) … tail[19]=starttime(第 22 列)
    return { pid: Number(pid), ppid: Number(tail[1]), created: BigInt(tail[19]), name: stat.slice(stat.indexOf('(') + 1, close).toLowerCase() };
  } catch { return null; }   // 读的当口进程退了
}

function snapshotProcessTableLinux() {
  let entries;
  try { entries = require('fs').readdirSync('/proc'); } catch { return null; }
  return entries.filter(n => /^\d+$/.test(n)).map(readProcStat).filter(Boolean);
}

// 逐个杀子孙:动手前按 FILETIME 再核一次(Get-Process 的 StartTime 与 CreationDate 同源),对不上就跳过。
function killVerified(list) {
  if (!list.length) return [];
  const items = list.map(d => `${d.pid}:${d.created.toString()}`).join(',');
  const script = `$ErrorActionPreference='SilentlyContinue'; foreach ($it in '${items}'.Split(',')) { `
    + `$pid0,$ft = $it.Split(':'); $p = Get-Process -Id ([int]$pid0); `
    + `if ($p -and [math]::Abs($p.StartTime.ToFileTimeUtc() - [int64]$ft) -lt 10000) { Stop-Process -Id ([int]$pid0) -Force; "KILLED $pid0" } }`;
  const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return String((r && r.stdout) || '').split(/\r?\n/).map(l => /^KILLED (\d+)$/.exec(l.trim())).filter(Boolean).map(m => Number(m[1]));
}

// child:测试自己 spawn 出来的 ChildProcess。返回 { killed: [pid...], skipped?: 原因 },从不抛。
function killOwnTree(child) {
  try {
    if (!child || !child.pid) return { killed: [], skipped: 'no-pid' };
    if (child.exitCode !== null || child.signalCode !== null) return { killed: [], skipped: 'root-exited' };
    if (process.platform !== 'win32') {
      // 只杀进程组不够:测试多半不带 detached 起服务,-pid 落空后只剩根被杀,它拉起的组件/子服务成了孤儿
      // (toolbox-discovery J1 就是这么红的)。有 /proc 就同 Windows 一样按「创建不早于父亲」往下认子孙。
      const table = process.platform === 'linux' ? snapshotProcessTableLinux() : null;
      const tree = table ? ownDescendants(table, child.pid) : { root: null, descendants: [] };
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已退 */ } }
      const killed = [child.pid];
      for (const d of tree.descendants.reverse()) {
        const now = readProcStat(d.pid);   // 动手前再核一次启动时刻,号被复用就不杀
        if (!now || now.created !== d.created) continue;
        try { process.kill(d.pid, 'SIGKILL'); killed.push(d.pid); } catch { /* 已退 */ }
      }
      return { killed };
    }
    const table = snapshotProcessTable();
    const tree = table ? ownDescendants(table, child.pid) : { root: null, descendants: [] };
    // 根:句柄在手 ⇒ 号一定还是它,直接 /PID 杀(不带 /T)。
    cp.spawnSync('taskkill', ['/PID', String(child.pid), '/F'], { stdio: 'ignore', windowsHide: true });
    // conhost.exe 不杀:它是系统替这棵树开的控制台宿主,最后一个挂在它上面的进程一退它自己就走。128c 取证时
    // 先杀了它:同一控制台上的孙子被连带杀掉,核验脚本自己也没了输出(退出码 1)。其余按「深的先杀」。
    const targets = tree.descendants.filter(d => d.name !== 'conhost.exe').reverse();
    const killed = [child.pid, ...killVerified(targets)];
    return table ? { killed } : { killed, skipped: 'snapshot-failed(descendants-not-walked)' };
  } catch (e) {
    return { killed: [], skipped: 'error:' + (e && e.message ? e.message : String(e)) };
  }
}

module.exports = { killOwnTree, ownDescendants, parseProcessTable, snapshotProcessTable };
