'use strict';
// Source-level guard for the native shell's recovery path. The desktop build is run separately to compile it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'ruyi-workbench', 'desktop', 'RuyiDesktop.cs');
const source = fs.readFileSync(file, 'utf8');
const overlayBuilder = fs.readFileSync(path.join(__dirname, '..', 'ruyi-workbench', 'tools', 'build-overlay.js'), 'utf8');

assert.match(source, /WM_DPICHANGED/);
assert.match(source, /WM_DISPLAYCHANGE/);
assert.match(source, /private Rectangle SuggestedDpiBounds\(IntPtr lParam\)/);
assert.match(source, /private Rectangle ClampWindowBoundsToWorkingArea\(Rectangle wanted\)/);
assert.match(source, /private void EnsureWindowVisible\(\)/);
assert.match(source, /ActivateShellWindow\(\)[\s\S]{0,600}EnsureWindowVisible\(\)/);
assert.match(source, /m\.Msg == Native\.WM_DPICHANGED[\s\S]{0,1200}SetBounds\(safe\.X, safe\.Y, safe\.Width, safe\.Height\)/);
assert.match(source, /m\.Msg == Native\.WM_DISPLAYCHANGE[\s\S]{0,900}EnsureWindowVisible\(\)/);
assert.match(overlayBuilder, /'RuyiDesktop\.exe'/);
assert.match(overlayBuilder, /'WebView2Loader\.dll'/);

console.log('DESKTOP DPI STATIC E2E: ALL PASS');
