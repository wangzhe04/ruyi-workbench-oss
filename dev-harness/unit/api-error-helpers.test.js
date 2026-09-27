'use strict';
// 架构还债批 1 #7:接口错误信封。
//   [E1] apiSessionIdInvalid / apiSessionNotFound 与修前的裸串写法逐字节相同(状态码、头、正文)。
//   [E2] 裸串写法 json({ ok:false, error:'…' }) 只减不增 —— 它们只能靠 00-boot 那张 11 条的遗留映射表
//        翻成稳定码,没命中的一律落成 api.request_failed,前端无法区分也无法本地化。新路由请用 apiFailure(code, …)。
//        上限随每次迁移往下调;调上去 = 新增了裸串,请改用 apiFailure。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-api-errors-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const SRC = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const { apiSessionIdInvalid, apiSessionNotFound } = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));

const BARE_ERROR_CEILING = 123;   // 2026-09-27 批 1 #7 迁完两句会话失败之后的实数(修前 159)

// 修前的裸串经 normalizeApiErrorPayload 落出来的样子(00-boot:code ← 遗留映射表,params 空,message 原串)。
const legacy = (code, message, status) => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ ok: false, error: { code, params: {}, message } }, null, 2),
});

test('[E1] 两个会话失败 helper 与修前裸串逐字节相同', () => {
  assert.deepEqual(apiSessionIdInvalid(), legacy('session.id_invalid', 'invalid sessionId', 400));
  assert.deepEqual(apiSessionNotFound(), legacy('session.not_found', 'session not found', 404));
});

test('[E2] 裸串错误信封只减不增', () => {
  let count = 0;
  const per = {};
  for (const f of fs.readdirSync(SRC).filter(n => n.endsWith('.js'))) {
    const n = (fs.readFileSync(path.join(SRC, f), 'utf8').match(/json\(\{ ok: false, error: ['`]/g) || []).length;
    if (n) { per[f] = n; count += n; }
  }
  assert.ok(count <= BARE_ERROR_CEILING,
    `裸串错误信封 ${count} 处,超过上限 ${BARE_ERROR_CEILING}(新路由请用 apiFailure(code, params, message, status)):${JSON.stringify(per)}`);
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
