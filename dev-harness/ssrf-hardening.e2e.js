// E2E (v0.9 F1/F2): SSRF hardening — IPv4-mapped/compatible IPv6 literals + NAT64 must be BLOCKED; public
// mappings ALLOWED; the pre-existing SSRF allow/deny list must NOT regress. Pure-function direct test against
// the EXPORTED ssrfCheck / embeddedIpv4FromV6 / isPrivateIpv4 — deterministic, no network. Ports 9018-9019 are
// reserved for this pin (registered) but not used: every assertion is a pure-function call so no socket opens.
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-ssrf-hardening-e2e');

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  // Isolate dataRoot before require (server.js resolves WIN_CLAUDE_WORKBENCH_HOME at load).
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
  const mod = require(path.join(WB, 'app', 'server.js'));

  const blocked = u => mod.ssrfCheck(u).allowed === false;
  const allowed = u => mod.ssrfCheck(u).allowed === true;

  // ── exports present ────────────────────────────────────────────────────────────────────────────────
  ok(typeof mod.ssrfCheck === 'function', 'ssrfCheck exported');
  ok(typeof mod.embeddedIpv4FromV6 === 'function', 'embeddedIpv4FromV6 exported (F1)');
  ok(typeof mod.isPrivateIpv4 === 'function', 'isPrivateIpv4 exported');

  // ── UNIT: embeddedIpv4FromV6 extraction ──────────────────────────────────────────────────────────────
  ok(mod.embeddedIpv4FromV6('::ffff:127.0.0.1') === '127.0.0.1', 'embed: ::ffff:127.0.0.1 → 127.0.0.1 (dotted mapped)');
  ok(mod.embeddedIpv4FromV6('::ffff:169.254.169.254') === '169.254.169.254', 'embed: ::ffff:169.254.169.254 → dotted');
  ok(mod.embeddedIpv4FromV6('::ffff:7f00:1') === '127.0.0.1', 'embed: ::ffff:7f00:1 (hex) → 127.0.0.1');
  ok(mod.embeddedIpv4FromV6('::ffff:a9fe:a9fe') === '169.254.169.254', 'embed: ::ffff:a9fe:a9fe (hex) → 169.254.169.254');
  ok(mod.embeddedIpv4FromV6('::a9fe:a9fe') === '169.254.169.254', 'embed: ::a9fe:a9fe (bare hex) → 169.254.169.254');
  ok(mod.embeddedIpv4FromV6('::127.0.0.1') === '127.0.0.1', 'embed: ::127.0.0.1 (deprecated compat) → 127.0.0.1');
  ok(mod.embeddedIpv4FromV6('::ffff:0808:0808') === '8.8.8.8', 'embed: ::ffff:0808:0808 (hex) → 8.8.8.8 (public)');
  ok(mod.embeddedIpv4FromV6('example.com') === null, 'embed: plain hostname → null');
  ok(mod.embeddedIpv4FromV6('2001:db8::1') === null, 'embed: real IPv6 (not mapped) → null');

  // ── F1: IPv4-mapped / compatible IPv6 literals must be BLOCKED ────────────────────────────────────────
  ok(blocked('http://[::ffff:127.0.0.1]/'), 'F1: [::ffff:127.0.0.1] (mapped loopback) BLOCKED');
  ok(blocked('http://[::ffff:169.254.169.254]/'), 'F1: [::ffff:169.254.169.254] (mapped CLOUD METADATA) BLOCKED');
  ok(blocked('http://[::ffff:10.0.0.1]/'), 'F1: [::ffff:10.0.0.1] (mapped private) BLOCKED');
  ok(blocked('http://[::ffff:192.168.1.1]/'), 'F1: [::ffff:192.168.1.1] (mapped private) BLOCKED');
  ok(blocked('http://[::ffff:172.16.5.5]/'), 'F1: [::ffff:172.16.5.5] (mapped private) BLOCKED');
  ok(blocked('http://[::ffff:7f00:1]/'), 'F1: [::ffff:7f00:1] (HEX mapped loopback) BLOCKED');
  ok(blocked('http://[::ffff:a9fe:a9fe]/'), 'F1: [::ffff:a9fe:a9fe] (HEX mapped metadata) BLOCKED');
  ok(blocked('http://[::127.0.0.1]/'), 'F1: [::127.0.0.1] (deprecated compat loopback) BLOCKED');
  ok(blocked('http://[64:ff9b::a9fe:a9fe]/'), 'F1: [64:ff9b::…] (NAT64 prefix) BLOCKED');
  ok(blocked('http://[64:ff9b::169.254.169.254]/'), 'F1: [64:ff9b::169.254.169.254] (NAT64 dotted) BLOCKED');

  // ── F1: a PUBLIC IPv4 mapped into IPv6 is a legitimate mapping → ALLOWED ──────────────────────────────
  ok(allowed('http://[::ffff:8.8.8.8]/'), 'F1: [::ffff:8.8.8.8] (mapped PUBLIC) ALLOWED');
  ok(allowed('http://[::ffff:0808:0808]/'), 'F1: [::ffff:0808:0808] (HEX mapped PUBLIC 8.8.8.8) ALLOWED');
  ok(allowed('http://[::ffff:1.1.1.1]/'), 'F1: [::ffff:1.1.1.1] (mapped PUBLIC) ALLOWED');

  // ── REGRESSION: the pre-existing SSRF allow/deny list must NOT regress ────────────────────────────────
  ok(blocked('http://127.0.0.1:8080/'), 'regress: 127.0.0.1 BLOCKED');
  ok(blocked('http://169.254.169.254/'), 'regress: 169.254.169.254 (cloud metadata) BLOCKED');
  ok(blocked('http://10.0.0.1/'), 'regress: 10.0.0.1 (private) BLOCKED');
  ok(blocked('http://192.168.1.1'), 'regress: 192.168.1.1 (private) BLOCKED');
  ok(blocked('http://172.16.5.5/'), 'regress: 172.16.5.5 (private) BLOCKED');
  ok(blocked('http://172.31.255.255/'), 'regress: 172.31.x (private edge) BLOCKED');
  ok(blocked('http://localhost/'), 'regress: localhost BLOCKED');
  ok(blocked('http://[::1]/'), 'regress: ::1 (ipv6 loopback) BLOCKED');
  ok(blocked('http://[fc00::1]/'), 'regress: fc00:: (ULA) BLOCKED');
  ok(blocked('http://[fe80::1]/'), 'regress: fe80:: (link-local) BLOCKED');
  ok(blocked('http://svc.internal/'), 'regress: *.internal BLOCKED');
  ok(blocked('http://foo.local/'), 'regress: *.local BLOCKED');
  ok(blocked('file:///etc/passwd'), 'regress: file:// protocol REJECTED');
  ok(blocked('ftp://example.com/'), 'regress: ftp:// protocol REJECTED');
  ok(allowed('https://example.com/page'), 'regress: public https host ALLOWED');
  ok(allowed('http://8.8.8.8/'), 'regress: public IPv4 8.8.8.8 ALLOWED');
  ok(allowed('http://172.32.0.1/'), 'regress: 172.32.x (outside 172.16-31) ALLOWED');

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\nSSRF-HARDENING E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})();
