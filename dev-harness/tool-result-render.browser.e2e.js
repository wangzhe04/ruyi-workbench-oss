#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 浏览器 e2e(N11):工具结果的渲染。
//   R  回放路径(落盘会话里的 toolCalls[].result):
//      R1 shell 的 stdout/stderr 是真正的多行文本块 —— 卡片里没有字面的 `\n`(修前是一行 "stdout": "a\nb\n…" 的转义串);
//      R2 长 stdout(400 行)默认只画前 40 行、带「展开全部(N 行)」,点开后全文在;DOM 文本有界;
//      R3 N3 落盘后的截图(imageAttachments → uploads 附件)画成 <img>,不是 base64 文本;
//      R4 N3 之前存下的老会话(result.image_base64 内嵌在结果里)也画 <img>,页面里没有整墙 base64 文本;
//      R5 小结果(只有标量键)外观不变:仍是 JSON 文本,没有富渲染容器。
//   L  live 路径(真回合里 file_read 读一份多行文件):tool_result 到达后同样画成多行文本块。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('TOOL RESULT RENDER BROWSER');
const { ok } = t;

// 一张真 PNG(2x2 红色):用 zlib 现造,不凭记忆抄 base64;老会话那份内嵌 base64 要过 ≥2000 字符的门槛,补零字节撑大(PNG 尾巴垃圾浏览器照画)。
const zlib = require('zlib');
function makePng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([len, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;   // 8 位 RGB
  const row = Buffer.from([0, 255, 0, 0, 255, 0, 0]);                                                              // filter 0 + 2 个红像素
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))]);
}
const PNG_1x1 = makePng();
const BIG_B64 = Buffer.concat([PNG_1x1, Buffer.alloc(9216, 0)]).toString('base64');

(async () => {
  let fx = null;
  let multiLineFile = '';
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-tool-result-render-',
      config: { permissionMode: 'bypass', stewardEnabledV1: false },
      provider: async ctx => {
        if (!ctx.answered) { ctx.toolCall('file_read', { path: multiLineFile }, 'call_read'); }
        else ctx.text('读完了。');
        ctx.stop();
      },
      prepare: async f => {
        multiLineFile = path.join(f.work, 'notes.txt');
        fs.writeFileSync(multiLineFile, Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行内容`).join('\n') + '\n', 'utf8');
        const created = await f.request('POST', '/api/sessions', { title: '结果渲染回放', cwd: f.work });
        const sid = created && created.json && created.json.session ? created.json.session.id : '';
        ok(Boolean(sid), 'S0 建出回放会话');
        await f.request('GET', `/api/sessions/${sid}`);   // 先读一次,把第一次装载的副作用了结掉
        // 截图附件:与 N3 落盘后的形状一致 —— uploads/<id>/<name>,结果里只有 imageAttachments。
        const attId = 'toolimg_0123456789abcdef01234567';
        fs.mkdirSync(path.join(f.home, 'uploads', attId), { recursive: true });
        fs.writeFileSync(path.join(f.home, 'uploads', attId, 'screenshot.png'), PNG_1x1);
        const stdout400 = Array.from({ length: 400 }, (_, i) => `build line ${i}`).join('\n');
        const rows = [
          { role: 'user', content: '跑一下构建' },
          {
            role: 'assistant', content: '跑完了', turnSeq: 1,
            toolCalls: [
              { id: 'c1', name: 'script_run', input: { language: 'node', code: 'x' }, result: { ok: false, code: 3, stdout: stdout400, stderr: 'fatal: boom\nsecond line', elapsedMs: 12, timedOut: false } },
              { id: 'c2', name: 'ai_computer_control__screenshot', input: {}, result: { ok: true, width: 1, height: 1, image_base64: '[image omitted from stored result: 400000 base64 chars, saved as attachment ' + attId + '/screenshot.png]', imageAttachments: [{ field: 'image_base64', id: attId, name: 'screenshot.png', mime: 'image/png', size: PNG_1x1.length }] } },
              { id: 'c3', name: 'ai_computer_control__screenshot', input: {}, result: { ok: true, width: 1, height: 1, image_base64: BIG_B64 } },
              { id: 'c4', name: 'file_delete', input: { path: 'a.txt' }, result: { ok: true, path: 'a.txt' } },
            ],
          },
        ];
        const dir = path.join(f.home, 'sessions');
        const headFile = path.join(dir, `${sid}.json`);
        const head = JSON.parse(fs.readFileSync(headFile, 'utf8'));
        fs.writeFileSync(path.join(dir, `${sid}.messages.ndjson`), rows.map(m => JSON.stringify({ ...m, createdAt: head.createdAt })).join('\n') + '\n');
        fs.writeFileSync(headFile, JSON.stringify({ ...head, messageCount: rows.length, turnSeq: 1 }, null, 2));
        fs.rmSync(path.join(dir, 'index.json'), { force: true });
        f.replaySessionId = sid;
      },
    });

    await fx.evaluate(`(() => { try { localStorage.setItem('wcw.shellMode', 'classic'); localStorage.setItem('wcw.lastSession', ${JSON.stringify(fx.replaySessionId)}); } catch (e) {} location.reload(); return true; })()`);
    await sleep(600);
    const loaded = await fx.waitForEval(`(() => {
      const cards = document.querySelectorAll('.tool-card');
      return cards.length >= 4 ? cards.length : null;
    })()`, 1000);
    ok(Boolean(loaded), `S1 回放会话的 4 张工具卡都画出来了(实得 ${loaded})`);

    // 取每张卡「结果」那一块的快照。卡默认折叠,textContent 照样在。
    const SNAP = `(() => [...document.querySelectorAll('.tool-card')].map(card => {
      const rich = card.querySelector('.tc-result-rich');
      return {
        name: (card.querySelector('.tc-name') || {}).textContent || '',
        text: card.textContent || '',
        rich: Boolean(rich),
        blocks: rich ? [...rich.querySelectorAll('.tc-res-block')].map(b => ({
          key: (b.querySelector('.tc-res-key') || {}).childNodes ? b.querySelector('.tc-res-key').childNodes[0].textContent : '',
          text: (b.querySelector('.tc-res-text') || {}).textContent || '',
          more: b.querySelector('.tc-res-more') ? b.querySelector('.tc-res-more').textContent : '',
        })) : [],
        imgs: [...card.querySelectorAll('.tc-res-img img')].map(i => ({ src: i.getAttribute('src') || '', w: i.naturalWidth })),
        resultPreText: rich ? rich.textContent.length : -1,
      };
    }))()`;
    const snap = await fx.waitForEval(`(() => { const s = ${SNAP}; return s.length >= 4 && s[0].rich ? s : null; })()`, 400);
    ok(Boolean(snap), 'R0 shell 结果走了富渲染容器');
    if (snap) {
      const shell = snap[0];
      const out = shell.blocks.find(b => b.key === 'stdout');
      const err = shell.blocks.find(b => b.key === 'stderr');
      ok(Boolean(out && err), `R1a stdout / stderr 各一个文本块(实得 ${JSON.stringify(shell.blocks.map(b => b.key))})`);
      ok(err && err.text === 'fatal: boom\nsecond line', 'R1b stderr 是真的两行文本(含真换行),不是一行转义串');
      ok(!/\\n/.test(shell.text), 'R1c 整张卡的文本里没有字面的 "\\n"(修前 "stdout": "build line 0\\nbuild line 1\\n…")');
      ok(out && out.text.split('\n').length === 40 && out.text.startsWith('build line 0\nbuild line 1'), `R2a 400 行 stdout 默认只画前 40 行(实得 ${out && out.text.split('\n').length})`);
      ok(out && /400/.test(out.more), `R2b 带「展开全部(400 行)」按钮(实得 ${JSON.stringify(out && out.more)})`);
      ok(/"code": 3/.test(shell.text) && /"timedOut": false/.test(shell.text), 'R2c 其余键(code/timedOut)仍以 JSON 文本可见');
      await fx.evaluate(`(() => { const b = document.querySelector('.tc-result-rich .tc-res-more'); b.click(); return true; })()`);
      const expanded = await fx.evaluate(`(() => { const b = document.querySelector('.tc-result-rich .tc-res-block .tc-res-text'); return b.textContent.split('\\n').length; })()`);
      ok(expanded === 400, `R2d 点「展开全部」后 400 行全在(实得 ${expanded})`);

      const att = snap[1];
      const attImgs = await fx.waitForEval(`(() => { const n = document.querySelectorAll('.tool-card')[1].querySelectorAll('.tc-res-img img').length; return n || null; })()`, 200);   // 附件经带鉴权头的 fetch 异步取回
      ok(att.rich && attImgs === 1, `R3a 落盘截图(imageAttachments)画成一张 <img>(实得 ${attImgs})`);
      const attLoaded = await fx.waitForEval(`(() => { const i = document.querySelectorAll('.tool-card')[1].querySelector('.tc-res-img img'); return i && i.complete && i.naturalWidth > 0 ? i.naturalWidth : null; })()`, 200);
      ok(Boolean(attLoaded), 'R3b 这张图真的经 /api/upload/content 取回并解码了(naturalWidth > 0)');
      ok(!/\[image omitted/.test(att.text) || att.text.indexOf('base64') < 0 || att.text.length < 2000, 'R3c 卡里没有 base64 文本墙');

      const legacy = snap[2];
      ok(legacy.rich && legacy.imgs.length === 1 && /^data:image\/png;base64,/.test(legacy.imgs[0].src), 'R4a 老会话里内嵌的 image_base64 也画成 <img>(data URI)');
      ok(!legacy.text.includes(BIG_B64.slice(0, 200)), 'R4b 卡的文本里没有那段 base64(不再整墙文本)');

      const small = snap[3];
      ok(!small.rich && /"ok": true/.test(small.text), 'R5 只有标量键的小结果:不走富渲染,仍是 JSON 文本');
    }

    // ── L: live 路径 ──
    await fx.evaluate(`(() => { const b = document.getElementById('newSessionBtn'); if (b) b.click(); return true; })()`);
    await fx.waitForEval(`(window.state && window.state.currentSession && window.state.currentSession.id !== ${JSON.stringify(fx.replaySessionId)}) ? 1 : null`, 300);
    await fx.evaluate(`(() => {
      const input = document.getElementById('promptInput');
      input.value = '读一下那份笔记';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('sendBtn').click();
      return true;
    })()`);
    const live = await fx.waitForEval(`(() => {
      const card = [...document.querySelectorAll('.tool-card')].filter(c => (c.querySelector('.tc-name') || {}).textContent === 'file_read').pop();   // 回放会话的卡可能还没被换掉
      if (!card) return null;
      const rich = card.querySelector('.tc-result-rich');
      if (!rich) return null;
      const block = rich.querySelector('.tc-res-block');
      return block ? { key: block.querySelector('.tc-res-key').childNodes[0].textContent, text: block.querySelector('.tc-res-text').textContent, cardText: card.textContent } : null;
    })()`, 600);
    ok(Boolean(live), 'L1 live:file_read 的 tool_result 到达后画成文本块');
    ok(live && live.key === 'content' && live.text.startsWith('第 1 行内容\n第 2 行内容'), 'L2 live:content 是真多行文本' + (live ? ' 现场:' + JSON.stringify([live.key, live.text.slice(0, 40)]) : ''));
    // 元数据里嵌套对象(如 file_read 的 non_ascii 采样)内部的换行仍按 JSON 转义显示 —— 那是紧凑元数据,不是正文;断言正文那一块。
    ok(live && !/\\n/.test(live.text) && !/"content":/.test(live.cardText), 'L3 live:正文块里没有字面的 "\\n",正文也不再以 "content": "…" 的 JSON 串出现');
    ok(fx.exceptions.length === 0, `X 页面没有未捕获异常(${fx.exceptions.join(' | ')})`);
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    if (fx) await fx.close();
    t.done();
  }
})();
