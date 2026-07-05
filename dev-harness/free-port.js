'use strict';
// v0.8-S8 公共件 —— getFreePort(): 拿一个当前空闲的 TCP 端口。
//
// 实现:让内置 net.Server 监听端口 0(OS 分配一个空闲端口),读回 address().port,关闭后返回。
// 存在「拿到后到真正使用之间被别人抢占」的天然竞态窗口——**现有 e2e 不用它**(它们硬编码端口、串行
// 跑,确定性更好、失败定位更清)。本 helper 供**未来并行/CI** 场景使用:并行跑多组 e2e 时,固定端口段
// 会互撞,那时用 getFreePort() 为每组动态取端口(fake 走 env FAKE_OPENAI_PORT,workbench 走 --port)。
//
// 零 npm:仅用内置 `net`。返回 Promise<number>。
const net = require('net');

/**
 * 取一个空闲 TCP 端口。
 * @param {string} [host='127.0.0.1'] 绑定主机(默认 loopback)。
 * @returns {Promise<number>} 一个当拿到时空闲的端口号。
 */
function getFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    // listen(0) → OS 分配空闲端口
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : null;
      srv.close(err => {
        if (err) return reject(err);
        if (!port) return reject(new Error('could not determine a free port'));
        resolve(port);
      });
    });
  });
}

/**
 * 取 N 个互不相同的空闲端口(串行取,避免同一次 listen(0) 拿到重复)。
 * @param {number} count 需要的端口数。
 * @param {string} [host='127.0.0.1']
 * @returns {Promise<number[]>}
 */
async function getFreePorts(count, host = '127.0.0.1') {
  const out = [];
  const seen = new Set();
  let guard = 0;
  while (out.length < count && guard < count * 20) {
    guard++;
    const p = await getFreePort(host);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  if (out.length < count) throw new Error(`only got ${out.length}/${count} distinct free ports`);
  return out;
}

module.exports = { getFreePort, getFreePorts };

// CLI: `node free-port.js` 打印一个空闲端口(手动调试用)。
if (require.main === module) {
  getFreePort().then(p => { process.stdout.write(String(p) + '\n'); }).catch(e => {
    process.stderr.write('free-port error: ' + (e && e.message) + '\n');
    process.exit(1);
  });
}
