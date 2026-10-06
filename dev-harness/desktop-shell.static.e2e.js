'use strict';
// Native desktop-shell regression locks: rounded restored windows and a parent-owned resize band.
const fs = require('fs');
const path = require('path');
const { bracedBlock } = require('./lib/source-slice.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'ruyi-workbench', 'desktop', 'RuyiDesktop.cs'), 'utf8');
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail++; console.log('FAIL ' + label); }
};

ok(/DWMWA_WINDOW_CORNER_PREFERENCE\s*=\s*33/.test(source), 'Win11 DWM corner preference declared');
ok(/DwmSetWindowAttribute\(Handle,[\s\S]*DWMWA_WINDOW_CORNER_PREFERENCE/.test(source), 'DWM rounded corners applied after handle creation');
ok(/UpdateFallbackWindowRegion\(\)/.test(source) && /new Region\(path\)/.test(source), 'Win10 rounded-region fallback retained');
ok(/WindowState\s*==\s*FormWindowState\.Maximized\s*\?\s*0\s*:\s*ResizeBorder/.test(source), 'restored window reserves native resize band; maximized window does not');
ok(/titlePanel\.SetBounds\(inset, inset/.test(source) && /webPanel\.SetBounds\(inset, inset \+ TitlebarHeight/.test(source), 'WebView/title children stay inside resize band');
for (const hit of [13, 14, 16, 17, 10, 11, 12, 15])
  ok(new RegExp(`m\\.Result = \\(IntPtr\\)${hit}`).test(source), `native hit-test result ${hit} present`);
ok(/ruyiNotification/.test(source) && /ShowDesktopNotification/.test(source) && /ShowBalloonTip\(10000\)/.test(source),
  'WebView messages bridge task notifications to the native Windows tray');
ok(/BalloonTipClicked/.test(source) && /ActivateShellWindow\(\)/.test(source),
  'clicking a native notification restores and focuses the desktop window');
ok(/new NewWinHandler\(this\)/.test(source) && /owner\.OpenExternalUri\(uri\)/.test(source),
  'new-window links are delegated to the owning desktop shell');
ok(/new ProcessStartInfo\(uri\)/.test(source) && /UseShellExecute\s*=\s*true/.test(source),
  'external links use the Windows default URI handler');
ok(/UriSchemeHttp/.test(source) && /UriSchemeHttps/.test(source) && /UriSchemeMailto/.test(source),
  'desktop shell allowlists external URI schemes');
ok(/无法打开外部链接/.test(source) && /复制链接/.test(source) && /用默认程序重试/.test(source),
  'failed external launches expose a closeable native retry/copy fallback');
ok(/关闭网页，返回工作台/.test(source) && /ruyiReturnHome/.test(source),
  'escaped embedded pages receive an explicit return-to-workbench escape hatch');

ok(!/\b(LParam|WParam)\.ToInt32\(\)/.test(source), 'x64 下 IntPtr.ToInt32() 遇到负坐标会抛 OverflowException（117l 用户真机崩溃）——LPARAM 一律先 ToInt64 再截低 32 位');
ok(/unchecked\(\(int\)(\(long\)m\.LParam|m\.LParam\.ToInt64\(\))\)/.test(source), 'LPARAM 改用 unchecked 截取低 32 位解码，不经过会抛异常的 checked ToInt32()');
ok(/\/platform:x64/.test(fs.readFileSync(path.join(__dirname, '..', 'ruyi-workbench', 'desktop', 'build-desktop.ps1'), 'utf8')), '桌面壳按 x64 编译（上面那条锁的前提）');

// 用户首启走查（2026-09-19）：MaybeNavigate 只有真的发出了导航才记 navigated。修前 `navigated = true` 排在
// `if (!webViewReady) return;` 前面 —— 服务地址先到、WebView2 首启还没好时那一发空转，WebView2 好了再调又被挡住，
// 窗口永远停在占位转圈页、标题栏却写「已连接」。钉次序：就绪检查 → 记 navigated → Navigate；外加 WebView2 就绪后补调一次。
{
  const body = (/private void MaybeNavigate\(\)\s*\{([\s\S]*?)\r?\n        \}/.exec(source) || [])[1] || '';
  const readyAt = body.indexOf('if (!webViewReady) return;');
  const setAt = body.lastIndexOf('navigated = true;');
  const navAt = body.indexOf('webView.Navigate(serverUrl)');
  ok(body.length > 0 && readyAt >= 0 && setAt > readyAt && navAt > setAt,
    'MaybeNavigate 先确认 WebView2 就绪、发出导航前一刻才记 navigated（服务先到时不会空转卡在转圈页）');
  ok(/webViewReady = true;\s*\r?\n\s*MaybeNavigate\(\);/.test(source), 'WebView2 就绪之后补调一次 MaybeNavigate（服务先到的那一路靠它导航）');
}

// 114e（26 号文；用户 2026-09-19 拍板提前）：桌面窗口里输入框麦克风能用 —— 挂 PermissionRequested，【只】放行
// 「麦克风 ＋ 本服务自己的源」。桌面壳跑不了 e2e（26 号文原定：静态锁 ＋ 人工走查），这里把处理器的形状逐项钉住：
// 真接口（不是 IntPtr 空挂）、注册了、只认 kind == 1、源判定逐项比协议／主机／端口、Allow 只出现在源判定通过的那一支。
{
  const handler = (/private sealed class PermHandler : ICoreWebView2PermissionRequestedEventHandler\s*\{([\s\S]*?)\r?\n        \}\r?\n/.exec(source) || [])[1] || '';
  const origin = (/internal bool IsOwnWorkbenchOrigin\(string uri\)\s*\{([\s\S]*?)\r?\n        \}/.exec(source) || [])[1] || '';
  ok(/int add_PermissionRequested\(ICoreWebView2PermissionRequestedEventHandler handler, out EventRegistrationToken token\);/.test(source)
    && /Guid\("15e1c6a3-c72a-4df3-91d7-d097fbec6bfd"\)[\s\S]{0,200}interface ICoreWebView2PermissionRequestedEventHandler/.test(source)
    && /Guid\("973ae2ef-ff18-4894-8fb2-3c758f046810"\)[\s\S]{0,200}interface ICoreWebView2PermissionRequestedEventArgs/.test(source),
    '114e 权限事件用真接口声明（IID 在本机 WebView2 运行时与官方 .NET 程序集里核过），不是 IntPtr 空挂');
  ok(/permHandler = new PermHandler\(this\);\s*\r?\n\s*core\.add_PermissionRequested\(permHandler, out token\);/.test(source), '114e 处理器注册到 CoreWebView2 上');
  ok(/private const int PermissionKindMicrophone = 1;/.test(handler) && /kind != PermissionKindMicrophone\) return 0;/.test(handler),
    '114e 只处理麦克风（kind == 1），其余权限一律不碰、走缺省');
  ok(/string\.Equals\(own\.Scheme, asked\.Scheme/.test(origin) && /string\.Equals\(own\.Host, asked\.Host/.test(origin) && /own\.Port == asked\.Port/.test(origin)
    && /if \(string\.IsNullOrEmpty\(serverUrl\) \|\| string\.IsNullOrEmpty\(uri\)\) return false;/.test(origin),
    '114e 源判定逐项比协议、主机、端口（与服务真实监听地址相同才算本机工作台）；地址还没到就一律不放行');
  const allows = (handler.match(/put_State\(/g) || []).length;
  ok(allows === 1 && /bool own = owner\.IsOwnWorkbenchOrigin\(uri\);\s*\r?\n\s*if \(own\) args\.put_State\(PermissionStateAllow\);/.test(handler),
    `114e Allow 只出现在「源判定通过」那一支（处理器里 put_State 恰好 ${allows} 处）`);
}

// 2026-09-24:最大化时点开别的程序,失焦重画旧式非客户区框架 → 客户区边缘碎线。lParam=-1 只改激活态不重画。
{
  const nc = (source.match(/if \(m\.Msg == Native\.WM_NCACTIVATE\)\s*\{[\s\S]*?\n\s*\}/) || [''])[0];
  ok(/WM_NCACTIVATE\s*=\s*0x0086/.test(source), 'WM_NCACTIVATE 常量声明');
  ok(/m\.LParam = new IntPtr\(-1\);\s*base\.WndProc\(ref m\);\s*return;/.test(nc),
    'WM_NCACTIVATE 以 lParam=-1 交给 DefWindowProc(失焦不重画非客户区边框)');
}

// 走查 S-09：宿主这一头（上面第 19 行那条）只收 chrome.webview.postMessage({ ruyiNotification:{ title, body } })，
// 修前前端却【没有任何发送方】（quiet-card 只会 new Notification，WebView2 里权限是 default、静默不显示）。
// 钉「前端真有发送方」：桌面壳判据与宿主桥写法、消息字段名与 C# 解析的 title／body 一一对上，
// 且浏览器模式（没有桌面壳）仍回落到 Notification。
{
  const quiet = fs.readFileSync(path.join(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'js', 'quiet-card.js'), 'utf8');
  ok(/globalThis\.__ruyiDesktop === 1 && bridge && typeof bridge\.postMessage === 'function'/.test(quiet)
    && /bridge\.postMessage\(\{ ruyiNotification: \{ id: entry\.key, title, body \} \}\)/.test(quiet),
    'S-09 前端有发送方：桌面壳里 maybeNotify 经 chrome.webview.postMessage({ ruyiNotification:{ title, body } }) 投递');
  ok(/TryGetValue\("title"/.test(source) && /TryGetValue\("body"/.test(source) && /TryGetValue\("ruyiNotification"/.test(source),
    'S-09 宿主解析的字段名就是前端发的 ruyiNotification.title／.body');
  ok(/new notificationApi\(title, \{ body, tag: entry\.key \}\)/.test(quiet),
    'S-09 没有桌面壳（浏览器模式）仍回落到 Notification');
}

// 走查第二波 #23:无边框最大化(WM_GETMINMAXINFO)的 ptMaxPosition。它相对【所在显示器自己的左上角】(系统会加上 rcMonitor.left/top,
// 所以副屏不用传绝对坐标),但工作区可能从显示器内部开始 —— 任务栏停靠在左 / 上时工作区原点是 (宽, 0) / (0, 高)。
// 修前恒为 0,窗口被压在任务栏下面、右 / 下露一条缝。本机没有 C# 编译器,字段名靠这里与上面的结构体声明逐字对上。
{
  const body = bracedBlock(source, 'if (m.Msg == Native.WM_GETMINMAXINFO)');
  ok(body.length > 300, '#23 切到了 WM_GETMINMAXINFO 处理块');
  ok(/mmi\.ptMaxPosition\.x = mi\.rcWork\.left - mi\.rcMonitor\.left;/.test(body)
    && /mmi\.ptMaxPosition\.y = mi\.rcWork\.top - mi\.rcMonitor\.top;/.test(body)
    && !/ptMaxPosition\.[xy] = 0\b/.test(body),
    '#23 ptMaxPosition = 工作区原点 - 显示器原点(任务栏在左 / 上时窗口不再压在任务栏下)');
  ok(/mmi\.ptMaxSize\.x = mi\.rcWork\.right - mi\.rcWork\.left;/.test(body) && /mmi\.ptMaxSize\.y = mi\.rcWork\.bottom - mi\.rcWork\.top;/.test(body),
    '#23 ptMaxSize 仍是工作区宽高(与上面的原点配套)');
  const monitorInfo = bracedBlock(source, 'public struct MONITORINFO');
  const minMax = bracedBlock(source, 'public struct MINMAXINFO');
  ok(/public RECT rcMonitor;/.test(monitorInfo) && /public RECT rcWork;/.test(monitorInfo) && /public POINT ptMaxPosition;/.test(minMax)
    && /public struct RECT \{ public int left, top, right, bottom; \}/.test(source) && /public struct POINT \{ public int x, y; \}/.test(source),
    '#23 用到的 P/Invoke 结构体字段(rcMonitor / rcWork / ptMaxPosition / left,top / x,y)声明都在');
}

// 走查第二波 #24:服务先于地址就绪就失败时只弹一次。修前 OnServerExited 弹「后台服务已退出」,30 秒后 OnBootTimeout 又弹
// 「30 秒内未就绪」并关窗(第一个模态框还开着时第二个嵌套弹出)。两处共用 bootFailureShown(UI 线程内读写),谁先弹谁置位。
{
  const timeout = bracedBlock(source, 'private void OnBootTimeout(object state)');
  const exited = bracedBlock(source, 'public void OnServerExited(int code)');
  ok(timeout.length > 200 && exited.length > 200, '#24 切到了 OnBootTimeout / OnServerExited');
  ok(/private bool bootFailureShown;/.test(source), '#24 共享标志 bootFailureShown 声明在');
  ok(/bootFailureShown\) return;\s*\r?\n\s*bootFailureShown = true;/.test(timeout) && (timeout.match(/MessageBox\.Show/g) || []).length === 1,
    '#24 OnBootTimeout:已弹过就不再弹,弹之前置位,仍只有一处 MessageBox');
  ok(/if \(!webViewReady && !bootFailureShown\)/.test(exited) && /bootFailureShown = true;[\s\S]*MessageBox\.Show/.test(exited)
    && (exited.match(/MessageBox\.Show/g) || []).length === 1,
    '#24 OnServerExited:同一个标志,置位在弹窗之前,仍只有一处 MessageBox');
  ok(/MessageBox\.Show[\s\S]*?if \(string\.IsNullOrEmpty\(serverUrl\) && !IsDisposed\) Close\(\);/.test(exited),
    '#24 服务在地址就绪前就退了:提示关掉后收窗(与启动超时同一出口;没有页面可显示)');
}

// 本机没有 C# 编译器,编译只在 release-dryrun(Windows,系统 csc.exe = C# 5)里发生 —— 这里钉住 C# 6+ 语法没有混进来。
ok(!/\?\.[A-Za-z_]/.test(source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\\n]|\\.)*"/g, '""'))
  && !/\$"/.test(source) && !/\bnameof\(/.test(source),
  'C# 5 语法:无 ?. 空条件、无 $"" 插值、无 nameof(系统 csc 不认)');

console.log('\nDESKTOP SHELL STATIC E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exit(fail ? 1 : 0);
