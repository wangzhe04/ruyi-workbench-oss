// Unit（用户首启走查 2026-09-19 ＋ Brief §4.2 第 6 条「启动探针偶发把机器判成离线并缓存 60 s（机制未证）」）：
// 网络探针撞上一段同步阻塞时，不许把「对端已经回话」判成离线。
//
// 机制（本件 [S1] 的修前读数就是判别实验）：探测进行中事件循环若被同步活占住（启动期 detectDesktopMcp → pickPython 的
// spawnSync，Full 包冷缓存数秒），循环回来时【计时器阶段先于 I/O 阶段】—— 中止计时器先到期，早已到达的响应还没读就被判
// 超时。修前：本地秒回的对端 ＋ 探测中同步忙等 800 ms（超时 300 ms）→ 5/5 判 false（离线），在线机器被判离线、缓存 60 s。
// 修后：超时比约定晚到一个余量以上 ⇒ 这一发量不准 ⇒ 记 null（未知），未知只缓存几秒。
//   [S1] 对端秒回、探测中同步阻塞 → null（不是 false）；
//   [S2] 对端秒回、不阻塞 → true（对照：正常路径不受影响）；
//   [S3] 对端不回话、不阻塞 → false（对照：真超时仍判离线）；
//   [S4] 多目标里一个秒回一个不回话、探测中阻塞 → 任一 true 即 true；全是「量不准」→ null；
//   [S5] 能力缓存：未知只缓存几秒，下一次调用会重新探（不再是 60 s）。
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { describe, it, before, after } = require('node:test');

process.env.RUYI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-probe-stall-'));
process.env.WCW_TEST_NO_NET_ANCHORS = '1';   // 不让真 baidu/bing 替本地对端作答
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));
const busy = ms => { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } };

describe('能力探针:同步阻塞不再伪造离线', () => {
  let fast, silent, fastUrl, silentUrl;
  before(async () => {
    fast = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
    silent = http.createServer(() => { /* never answers */ });
    await new Promise(r => fast.listen(0, '127.0.0.1', r));
    await new Promise(r => silent.listen(0, '127.0.0.1', r));
    fastUrl = `http://127.0.0.1:${fast.address().port}/`;
    silentUrl = `http://127.0.0.1:${silent.address().port}/`;
  });
  after(() => { fast.close(); silent.close(); });

  it('[S1] 对端秒回、探测中同步阻塞 → null(未知),不是 false', async () => {
    for (let i = 0; i < 3; i++) {
      const p = srv.probeAny([fastUrl], 300);
      busy(800);
      assert.strictEqual(await p, null);
    }
  });
  it('[S2] 对端秒回、不阻塞 → true', async () => {
    assert.strictEqual(await srv.probeAny([fastUrl], 300), true);
  });
  it('[S3] 对端不回话、不阻塞 → false(真超时仍判离线)', async () => {
    assert.strictEqual(await srv.probeAny([silentUrl], 300), false);
  });
  it('[S4] 多目标:任一 true 即 true;全是量不准 → null', async () => {
    assert.strictEqual(await srv.probeAny([silentUrl, fastUrl], 300), true);
    const p = srv.probeAny([fastUrl, fastUrl + 'x'], 300);
    busy(800);
    assert.strictEqual(await p, null);
  });
  it('[S5] 能力缓存:未知 TTL 从探测完成开始计时,几秒后重新探测', async t => {
    const realNow = Date.now;
    let elapsedDuringProbe = 0;
    t.mock.method(Date, 'now', () => realNow() + elapsedDuringProbe);
    assert.ok(Number(srv.CAP_UNKNOWN_TTL_MS) > 0 && Number(srv.CAP_UNKNOWN_TTL_MS) <= 10000, `未知的缓存期(实 ${srv.CAP_UNKNOWN_TTL_MS})`);
    srv.invalidateCapabilityCache();
    // 用 capabilityProbeUrl 把探测目标钉成本地对端;探测中同步阻塞 → 这一次记未知
    const config = { capabilityProbeUrl: fastUrl, providers: [], externalMcpServers: [] };
    const p = srv.getCapabilities(config, true);
    busy(3600);
    // Simulate slow executable/desktop probes after the network request starts. The cache must
    // still have its full TTL when the result is published, independent of machine load.
    elapsedDuringProbe = Number(srv.CAP_UNKNOWN_TTL_MS) * 2;
    const first = await p;
    assert.strictEqual(first.network.online, null, '阻塞中的那一次记未知');
    // 未知的缓存期内命中缓存;过期后重新探测拿到 true
    const again = await srv.getCapabilities(config);
    assert.strictEqual(again.network.online, null, '缓存期内命中同一份');
    await new Promise(r => setTimeout(r, Number(srv.CAP_UNKNOWN_TTL_MS) + 100));
    const later = await srv.getCapabilities(config);
    assert.strictEqual(later.network.online, true, '未知过期后重新探测拿到 true(修前要等满 60 s,且那 60 s 里一直是离线)');
  });
});

it('[P3-04] browser target cache does not publish an older probe over the current snapshot', async () => {
  const { loadServerInternals } = require('../lib/server-internals');
  const h = loadServerInternals(['getCapabilities', 'peekCapabilities'], { withEval: true });
  h.__eval(`globalThis.__ruyiP3Cache={gates:[],counts:new Map()};
    activeOpenAiProvider=()=>null;networkAnchors=()=>[];
    probeDesktopMcp=async config=>{const mode=config.browserAutomation.mode;
      __ruyiP3Cache.counts.set(mode,(__ruyiP3Cache.counts.get(mode)||0)+1);
      await new Promise(resolve=>__ruyiP3Cache.gates.push({mode,resolve}));
      return {present:true,browser:{mode,ready:false}};};
    probeRgAsync=async()=>null;existsExecutableAsync=async()=>false;
    probeGitCliAsync=async()=>false;withRuntimeCapabilities=async x=>x;`);
  const state = globalThis.__ruyiP3Cache, pending = [];
  const start = (mode, force) => { const result = h.getCapabilities({ browserAutomation: { mode } }, force); pending.push(result); return result; };
  const release = async (mode, result) => {
    const gate = state.gates.find(g => g.mode === mode && !g.done);
    assert.ok(gate, 'actual capability probe entered ' + mode);
    gate.done = true; gate.resolve(); await result;
  };
  try {
    const old = start('system'), current = start('bundled');
    await release('bundled', current);
    assert.equal(h.peekCapabilities().desktopMcp.browser.mode, 'bundled');
    await release('system', old);
    assert.equal(h.peekCapabilities().desktopMcp.browser.mode, 'bundled', 'older completion cannot publish to the hot snapshot');
    const nextOld = start('system', true);
    await start('bundled'); // cache hit must still establish the requested target
    await release('system', nextOld);
    assert.equal(h.peekCapabilities().desktopMcp.browser.mode, 'bundled', 'cache hit also prevents a pending older target from publishing');
    const same1 = start('cdp'), same2 = start('cdp');
    await release('cdp', same1); await same2;
    assert.equal(state.counts.get('cdp'), 1, 'same-target callers still share one inflight probe');
    assert.equal(h.peekCapabilities().desktopMcp.browser.mode, 'cdp');
  } finally {
    for (const gate of state.gates) gate.resolve();
    await Promise.allSettled(pending);
    delete globalThis.__ruyiP3Cache;
  }
});
