'use strict';
// Native desktop-shell regression locks: rounded restored windows and a parent-owned resize band.
const fs = require('fs');
const path = require('path');
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

console.log('\nDESKTOP SHELL STATIC E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exit(fail ? 1 : 0);
