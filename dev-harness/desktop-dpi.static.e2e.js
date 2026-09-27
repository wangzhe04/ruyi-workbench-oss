'use strict';
// Source-level guard for the native shell's recovery path. The desktop build is run separately to compile it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'ruyi-workbench', 'desktop', 'RuyiDesktop.cs');
const source = fs.readFileSync(file, 'utf8');
// 架构还债批 3·D:载荷表读打包器运行时的那份数组(require 零副作用),不再正则匹配源码字面量。
const overlayPayload = require(path.join(__dirname, '..', 'ruyi-workbench', 'tools', 'build-overlay.js')).PAYLOAD_FILES;

assert.match(source, /WM_DPICHANGED/);
assert.match(source, /WM_DISPLAYCHANGE/);
assert.match(source, /private Rectangle SuggestedDpiBounds\(IntPtr lParam\)/);
assert.match(source, /private Rectangle ClampWindowBoundsToWorkingArea\(Rectangle wanted\)/);
assert.match(source, /private void EnsureWindowVisible\(\)/);
assert.match(source, /ActivateShellWindow\(\)[\s\S]{0,600}EnsureWindowVisible\(\)/);
assert.match(source, /m\.Msg == Native\.WM_DPICHANGED[\s\S]{0,1200}SetBounds\(safe\.X, safe\.Y, safe\.Width, safe\.Height\)/);
assert.match(source, /m\.Msg == Native\.WM_DISPLAYCHANGE[\s\S]{0,900}EnsureWindowVisible\(\)/);
assert.ok(overlayPayload.includes('RuyiDesktop.exe'), 'overlay payload ships RuyiDesktop.exe');
assert.ok(overlayPayload.includes('WebView2Loader.dll'), 'overlay payload ships WebView2Loader.dll');

console.log('DESKTOP DPI STATIC E2E: ALL PASS');
