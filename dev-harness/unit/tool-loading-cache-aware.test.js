'use strict';
// 按需装载按「缓存账」调整(2026-10)。背景:本机日志里工具表在会话中途每变一次,提供方的前缀缓存就整段失效
// (命中率 97%→3%、94%→8%),所以优化目标从「每发少带几百 token」换成「一个会话里工具表少变几次」。
//   [C1] 起手工具:模型服务商回合第一发就带 web_search / web_fetch / powershell_run;被设置关掉的、管家会话、full 模式不受影响。
//   [C2] 分包精度:话题词(编码能力 / 测一下 / 偏好 / file_edit 里的 edit)不再把 code、memory 包带进来;明确的代码 / 记忆意图照旧。
//   [C3] 会话工具表跨重启:进程内冻结表是空的时,按会话头上记的表原序恢复;坏名字、目录里没有的不恢复;进程内已有就不再恢复。
//   [C4] 装载原因:按原因装进来的工具追加在冻结表尾部(顺序只增不改),frozenNames 给 09 写回会话头。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-tool-loading-cache-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const cfg = srv.defaultConfig();
const offered = srv.buildOpenAiTools(cfg, null, { skillsEnabled: true });
const names = state => state.current().map(t => t.function.name);
const STARTER = ['web_search', 'web_fetch', 'powershell_run'];
let keySeq = 0;
const freshKey = () => `sess_cachetest${process.pid}x${(keySeq += 1)}`;   // 冻结表是进程级的,每条用例一把新钥匙

test('[C1] 起手工具第一发就在;被关掉的、管家会话、full 模式不受影响', () => {
  const chit = names(srv.createToolLoadingState(cfg, '你好', null, offered, null, null));
  for (const n of STARTER) assert.ok(chit.includes(n), `${n} 应在闲聊回合的第一发里`);
  assert.ok(!chit.includes('file_read'), 'file_read 仍按需(tool-loading e2e 钉着的那条)');
  // allowCommandTools:false → powershell_run 根本不在目录里,起手也不会带
  const noCmd = { ...cfg, allowCommandTools: false };
  const noCmdNames = names(srv.createToolLoadingState(noCmd, '你好', null, srv.buildOpenAiTools(noCmd, null, {}), null, null));
  assert.ok(!noCmdNames.includes('powershell_run'));
  assert.ok(noCmdNames.includes('web_search'));
  // 管家会话的目录里只有 steward_*,起手工具不会混进来
  const stewardTools = srv.buildOpenAiTools(cfg, null, { stewardSession: true });
  const st = names(srv.createToolLoadingState(cfg, '你好', null, stewardTools, null, null));
  assert.ok(st.length > 0 && st.every(n => n.startsWith('steward_')), st.join(','));
  // full 模式本来就全装,起手工具不影响它
  const full = { ...cfg, toolLoadingMode: 'full' };
  const fullTools = srv.buildOpenAiTools(full, null, {});
  assert.equal(names(srv.createToolLoadingState(full, '你好', null, fullTools, null, null)).length, fullTools.length);
});

test('[C2] 话题词不再带进 code / memory 包,明确意图照旧', () => {
  const packs = msg => srv.classifyToolPacks(msg);
  // 本机真实回合里误装的三类
  assert.ok(!packs('你帮我分析一下现在OpenAI和Anthropic这两家的模型,编码能力谁更强').includes('code'));
  assert.ok(!packs('现在应该好了，你能对比测试一下吗').includes('code'));
  assert.ok(packs('现在应该好了，你能对比测试一下吗').includes('shell'), '「测试」仍带命令行');
  const fe = packs('我有一点好奇，你的tool_invoke_read/edit/exec是怎么判断的，file_edit这些似乎就不会有？');
  assert.ok(fe.includes('files_write') && !fe.includes('code'), fe.join(','));
  assert.ok(!packs('这两家模型在用户偏好上的差别').includes('memory'));
  // 明确的意图照旧
  for (const msg of ['帮我重构这个函数', '修复这个 bug', 'git 提交一下', '给 utils 写单元测试', '实现一个 LRU 缓存']) {
    assert.ok(packs(msg).includes('code'), msg);
  }
  for (const msg of ['记住我喜欢用 tabs', 'remember this preference', 'which memory is outdated?']) {
    assert.ok(packs(msg).includes('memory'), msg);
  }
  assert.ok(packs('帮我更新一下这份文档').includes('files_write'));
});

test('[C3] 会话工具表跨重启按原序恢复', () => {
  const key = freshKey();
  const restoredNames = ['file_read', 'web_search', 'glob', 'bad name!', 'no_such_tool_xyz', 'file_read', 42, null];
  const s1 = srv.createToolLoadingState(cfg, '你好', null, offered, null, key, { restoredNames });
  const got = names(s1);
  assert.deepEqual(got.slice(0, 3), ['file_read', 'web_search', 'glob'], `恢复的部分保持原序在最前(got ${got.slice(0, 6).join(',')})`);
  assert.ok(!got.includes('no_such_tool_xyz') && !got.includes('bad name!'));
  assert.equal(got.filter(n => n === 'file_read').length, 1, '去重');
  for (const n of STARTER) assert.ok(got.includes(n));
  assert.deepEqual(s1.frozenNames(), got, 'frozenNames 就是这张表(给 09 写回会话头)');
  // 进程内已有冻结表(同一进程的下一回合):不再拿会话头覆盖/重复恢复
  const s2 = srv.createToolLoadingState(cfg, '你好', null, offered, null, key, { restoredNames: ['git_status'] });
  assert.deepEqual(names(s2), got, '同进程下一回合与上一回合完全同序');
  // 会话头上不是数组 / 没有:照常按分包起表
  const s3 = srv.createToolLoadingState(cfg, '你好', null, offered, null, freshKey(), { restoredNames: 'file_read' });
  assert.ok(!names(s3).includes('file_read'));
  // 没开冻结(或不是主循环):不恢复,frozenNames 为 null
  const s4 = srv.createToolLoadingState(cfg, '你好', null, offered, null, null, { restoredNames: ['file_read'] });
  assert.equal(s4.frozenNames(), null);
  assert.ok(!names(s4).includes('file_read'));
});

test('[C4] 中途装载只追加在尾部,frozenNames 跟着变', () => {
  const key = freshKey();
  const st = srv.createToolLoadingState(cfg, '你好', null, offered, null, key);
  const before = names(st);
  const r = st.load({ packs: ['files_read'], tools: ['file_read'] }, 'proxy_promote');
  assert.ok(r.ok && r.loaded.includes('file_read') && r.loaded.includes('glob'), JSON.stringify(r.loaded));
  const afterNames = names(st);
  assert.deepEqual(afterNames.slice(0, before.length), before, '已有的不挪位(只追加)');
  assert.deepEqual(st.frozenNames(), afterNames);
});
