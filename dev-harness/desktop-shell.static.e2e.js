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

console.log('\nDESKTOP SHELL STATIC E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exit(fail ? 1 : 0);
