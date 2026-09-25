#!/usr/bin/env node
'use strict';

// 121-K1（34 号文 §8.2／§8.3 第 1 条）：js/thread-facts.js 的真值表。
//
// 这片叶子收编了四类「线程事实折算」的纯函数，来源是随交办台退役删掉的三个文件：
//   preview-task-sheet.js → taskProgress / acceptanceItems / activeAcceptanceIndex / elapsedLabel /
//                           dispatchAcceptanceMilestones
//   preview-shell.js:54   → dockToneForMissionState
//   preview-dock-home.js:7 → missionCardSignature
// 前两类有活的消费者（看板与抽屉，各自的 static 锁钉着 import）；后两个函数【本波零生产调用点】——
// 它们是被刻意保住的能力，不是忘了删的死码，理由见下面 dispatchAcceptanceMilestones 那一段。
// 没有调用点就没有别的机器在看它们，所以这份真值表是它们唯一的守卫。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js', 'thread-facts.js');
let modulePromise;
function loadModule() {
  if (!modulePromise) modulePromise = import(pathToFileURL(MODULE_PATH).href);
  return modulePromise;
}

describe('taskProgress —— 验收进度', () => {
  it('有详情快照时以快照的 acceptance 为准', async () => {
    const { taskProgress } = await loadModule();
    assert.deepEqual(taskProgress(null, { acceptance: { done: 1, total: 4 } }), { total: 4, done: 1, percent: 25 });
  });
  it('没有快照时退回卡片账本的里程碑计数', async () => {
    const { taskProgress } = await loadModule();
    assert.deepEqual(taskProgress({ mission: { milestonesTotal: 2, done: 2 } }), { total: 2, done: 2, percent: 100 });
  });
  it('done 被 total 夹住，total 为 0 时百分比是 0 而不是 NaN', async () => {
    const { taskProgress } = await loadModule();
    assert.deepEqual(taskProgress(null, { acceptance: { done: 9, total: 3 } }), { total: 3, done: 3, percent: 100 });
    assert.deepEqual(taskProgress(null, { acceptance: { done: 0, total: 0 } }), { total: 0, done: 0, percent: 0 });
    assert.deepEqual(taskProgress(null), { total: 0, done: 0, percent: 0 });
  });
});

describe('acceptanceItems / activeAcceptanceIndex —— 验收条目', () => {
  it('条目缺 id 时按位次补，状态只认三值', async () => {
    const { acceptanceItems } = await loadModule();
    const items = acceptanceItems({ acceptance: { items: [{ desc: ' 甲 ' }, { id: 'x', status: 'bogus' }] } });
    assert.equal(items[0].id, 'item-1');
    assert.equal(items[0].desc, '甲');
    assert.equal(items[0].status, 'pending');
    assert.equal(items[1].status, 'pending', '未知状态回落 pending，不原样透传');
    assert.equal(items[1].checkType, 'none');
  });
  it('没有容器时是空数组（不猜、不拿别的东西冒充）', async () => {
    const { acceptanceItems } = await loadModule();
    assert.deepEqual(acceptanceItems(null), []);
    assert.deepEqual(acceptanceItems({ acceptance: {} }), []);
  });
  it('活跃项 = 第一条 pending，没有 pending 才退到 blocked，全完成时 -1', async () => {
    const { activeAcceptanceIndex } = await loadModule();
    assert.equal(activeAcceptanceIndex([{ status: 'done' }, { status: 'blocked' }, { status: 'pending' }]), 2);
    assert.equal(activeAcceptanceIndex([{ status: 'done' }, { status: 'blocked' }]), 1);
    assert.equal(activeAcceptanceIndex([{ status: 'done' }]), -1);
    assert.equal(activeAcceptanceIndex(null), -1);
  });
});

describe('elapsedLabel —— 时长（不是「多久以前」）', () => {
  it('三档格式：秒 / 分秒 / 时分', async () => {
    const { elapsedLabel } = await loadModule();
    const base = '2026-09-11T00:00:00.000Z';
    assert.equal(elapsedLabel(base, new Date('2026-09-11T00:00:12.000Z')), '12s');
    assert.equal(elapsedLabel(base, new Date('2026-09-11T00:03:20.000Z')), '3m 20s');
    assert.equal(elapsedLabel(base, new Date('2026-09-11T01:05:00.000Z')), '1h 05m');
  });
  it('时间在未来、拿不到时间戳、非法输入，一律空串（不猜一个「刚刚」出来）', async () => {
    const { elapsedLabel } = await loadModule();
    const base = '2026-09-11T01:00:00.000Z';
    assert.equal(elapsedLabel(base, new Date('2026-09-11T00:00:00.000Z')), '');
    assert.equal(elapsedLabel('', new Date()), '');
    assert.equal(elapsedLabel(null, new Date()), '');
    assert.equal(elapsedLabel('not-a-date', new Date()), '');
  });
});

describe('dockToneForMissionState —— 五态 → 圆点色调', () => {
  // 117n-M1③ 的契约：settled 只在【调用方主动选它】时才出；默认返回值一个字不变。
  it('默认四档：attention / active / quiet', async () => {
    const { dockToneForMissionState } = await loadModule();
    assert.equal(dockToneForMissionState('needs_you'), 'attention');
    assert.equal(dockToneForMissionState('running'), 'active');
    assert.equal(dockToneForMissionState('dispatching'), 'active');
    assert.equal(dockToneForMissionState('done'), 'quiet', '不传 settleDone 时 done 仍是 quiet（默认返回值零漂移）');
    assert.equal(dockToneForMissionState('stopped'), 'quiet');
    assert.equal(dockToneForMissionState('quick_ask'), 'quiet');
    assert.equal(dockToneForMissionState(undefined), 'quiet');
  });
  it('settleDone:true 只把 done 单独挑成 settled，其余状态不受影响', async () => {
    const { dockToneForMissionState } = await loadModule();
    const opts = { settleDone: true };
    assert.equal(dockToneForMissionState('done', opts), 'settled');
    assert.equal(dockToneForMissionState('needs_you', opts), 'attention');
    assert.equal(dockToneForMissionState('running', opts), 'active');
    assert.equal(dockToneForMissionState('dispatching', opts), 'active');
    assert.equal(dockToneForMissionState('stopped', opts), 'quiet');
    assert.equal(dockToneForMissionState('quick_ask', opts), 'quiet');
  });
});

describe('missionCardSignature —— 任务卡重绘签名', () => {
  // 116-3 A4：签名必须覆盖卡片真的画出来的每一样事实，否则改了标题/目标/验收项却不重绘。
  const base = {
    missionId: 'm1', updatedAt: 'T', runCount: 1, activeTurn: false,
    mission: { done: 1 }, pending: {}, missionTitle: '事项甲', goal: '把周报写完',
    acceptance: { done: 1, total: 3 },
  };
  it('同一张卡片签名稳定；缺字段时不炸', async () => {
    const { missionCardSignature } = await loadModule();
    assert.equal(missionCardSignature(base, {}), missionCardSignature({ ...base }, {}));
    assert.equal(missionCardSignature({ missionId: 'm1' }, {}), missionCardSignature({ missionId: 'm1' }, {}));
  });
  it('标题 / 目标 / 勾一条验收项 / 加一条验收项，四个维度各自改签名', async () => {
    const { missionCardSignature } = await loadModule();
    const sig = card => missionCardSignature(card, {});
    assert.notEqual(sig(base), sig({ ...base, missionTitle: '事项乙' }));
    assert.notEqual(sig(base), sig({ ...base, goal: '把周报写完并发给老板' }));
    assert.notEqual(sig(base), sig({ ...base, acceptance: { done: 2, total: 3 } }));
    assert.notEqual(sig(base), sig({ ...base, acceptance: { done: 1, total: 4 } }));
  });
  it('置顶 / 归档这两个本机视图状态也进签名', async () => {
    const { missionCardSignature } = await loadModule();
    assert.notEqual(missionCardSignature(base, {}), missionCardSignature(base, { pinned: true }));
    assert.notEqual(missionCardSignature(base, {}), missionCardSignature(base, { archived: true }));
  });
});

describe('dispatchAcceptanceMilestones —— 前端唯一的 mission 里程碑生产者', () => {
  // 34 号文 §8.3 第 1 条把它列为「删掉就丢功能」的两处之一。121-K1 的实测结论（写在这里，
  // 因为这份真值表是它现在唯一的守卫）：
  //   · 交办台退役后，全前端【零】生产调用点 —— 唯一那个 POST /api/mission {action:'start'}
  //     的路径（原 app.js startPreviewDispatchCommand）住在交办台的派单输入框里，随它一起删了；
  //     幸存的 /api/mission 调用只剩 session-experience.js 那一处 {action:'stop'}。
  //   · 服务端 13k stewardImplThreadNew 只写 session.kind='mission'，【不】建里程碑账本 ——
  //     所以管家自己开的线程在 121-K1 之前就没有里程碑，本刀没有让任何幸存界面倒退。
  //   · 真正的调用点是 34 号文 §5 那个还没建的左栏「＋ 新任务」（K4/K5）。
  // 结论：函数保住、行为钉住，接线归 K4/K5。它现在没有调用点这件事本身就写在这段注释里，
  // 不许被当成「忘了删的死码」清掉。
  it('恒定返回两条 pending 里程碑，id 固定（服务端建账本要求至少一条）', async () => {
    const { dispatchAcceptanceMilestones } = await loadModule();
    for (const prompt of ['随便什么', '', null, undefined, 'anything at all']) {
      const out = dispatchAcceptanceMilestones(prompt);
      assert.equal(out.length, 2);
      assert.deepEqual(out.map(m => m.id), ['accept-outcome', 'accept-evidence']);
      assert.ok(out.every(m => m.status === 'pending'));
      assert.ok(out.every(m => typeof m.desc === 'string' && m.desc.length > 0));
    }
  });
  it('验收项【不是把任务原文抄一遍】——原话一个字都不出现在里程碑里', async () => {
    const { dispatchAcceptanceMilestones } = await loadModule();
    const prompt = '帮我把 Q3 财报里的异常科目挑出来';
    const out = dispatchAcceptanceMilestones(prompt);
    assert.ok(out.every(m => !m.desc.includes(prompt)), '账本要说清「什么叫做完」，不是把任务再说一遍');
  });
  it('中文输入出中文验收项，英文输入出英文验收项', async () => {
    const { dispatchAcceptanceMilestones } = await loadModule();
    const cjk = /[㐀-鿿]/;
    assert.ok(dispatchAcceptanceMilestones('分析一下这个趋势').every(m => cjk.test(m.desc)));
    assert.ok(dispatchAcceptanceMilestones('analyze this trend').every(m => !cjk.test(m.desc)));
  });
  it('四类任务各出各的措辞：调研 / 工程 / 交付物 / 兜底', async () => {
    const { dispatchAcceptanceMilestones } = await loadModule();
    const descOf = prompt => dispatchAcceptanceMilestones(prompt).map(m => m.desc).join('|');
    const research = descOf('调研一下这个市场');
    const engineering = descOf('修复这个 bug');
    const artifact = descOf('生成一份文档');
    const fallback = descOf('陪我聊聊天气');
    const all = [research, engineering, artifact, fallback];
    assert.equal(new Set(all).size, 4, '四类措辞两两不同（实测 ' + JSON.stringify(all.map(s => s.slice(0, 12))) + '）');
    // 判定顺序也钉住：调研 > 工程 > 交付物 > 兜底 —— 同时命中调研与工程时按调研出。
    assert.equal(descOf('分析并修复这个 bug'), research, '同时命中时按调研档出（判定顺序不许被重排）');
  });
});

// ── 124 还债①（40 号文 §8.5 ①）：让【看板】也答得出「未记录验收」───────────────────────
// 被钉的是一句话：**「没有验收项」（记过、是空的）与「未记录验收」（压根没人记过）不是一回事。**
// 抽屉从 124-P1 起就分得开（它读详情投影里的 `ledger`）；看板修前分不开，因为列表行
// （GET /api/missions）上只有容器那三个数。13d 现在把 `ledger` / `tracked` 两个组级事实一起
// 投影下来，判据仍然只有 acceptanceRecorded 这一处 —— 下面这一组守的就是「同一个函数吃两种
// 入参形状、答案都对」。
describe('acceptanceRecorded —— 记过验收没有（详情快照 ／ 列表行 两种形状）', () => {
  it('详情形状：有账本 → 记过', async () => {
    const { acceptanceRecorded } = await loadModule();
    assert.equal(acceptanceRecorded({ acceptance: { ledger: true, items: [{}], container: { items: [] } } }), true);
  });
  it('详情形状：无账本、容器也没验收项 → 没记过', async () => {
    const { acceptanceRecorded } = await loadModule();
    assert.equal(acceptanceRecorded({ acceptance: { ledger: false, items: [], container: { items: [] } } }), false);
  });
  it('详情形状：无账本但容器里有验收项 → 记过', async () => {
    const { acceptanceRecorded } = await loadModule();
    assert.equal(acceptanceRecorded({ acceptance: { ledger: false, items: [], container: { items: [{ text: 'a' }] } } }), true);
  });
  // ── 列表行那一形状（本刀新加的那半句）──────────────────────────────────────────
  // 列表行没有第二层 container，事项验收项就直接躺在 acceptance.items 里。
  it('列表形状：组里有账本 → 记过（哪怕一条验收项都没有）', async () => {
    const { acceptanceRecorded } = await loadModule();
    assert.equal(acceptanceRecorded({ acceptance: { done: 0, total: 0, items: [], ledger: true, tracked: true } }), true);
  });
  it('列表形状：没账本、也没验收项 → 没记过（这一格才配说「未记录验收」）', async () => {
    const { acceptanceRecorded } = await loadModule();
    assert.equal(acceptanceRecorded({ acceptance: { done: 0, total: 0, items: [], ledger: false, tracked: true } }), false);
  });
  it('列表形状：没账本但有事项验收项 → 记过', async () => {
    const { acceptanceRecorded } = await loadModule();
    assert.equal(acceptanceRecorded({ acceptance: { done: 0, total: 1, items: [{ text: 'a', done: false }], ledger: false, tracked: true } }), true);
  });
  // 回落到 items 为什么安全：详情那边 ledger===false 时里程碑必为空（items 由 mission.milestones
  // 来，没账本就没里程碑），所以回落读到的不可能是里程碑。这一条把那个前提也钉住。
  it('回落不会误读详情的里程碑：无账本时详情的 items 恒空，这条前提被钉住', async () => {
    const { acceptanceRecorded } = await loadModule();
    assert.equal(acceptanceRecorded({ acceptance: { ledger: false, items: [], container: { items: [] } } }), false);
    // 有 container 键时一律以 container 为准，items 再怎么填也不看
    assert.equal(acceptanceRecorded({ acceptance: { ledger: false, items: [{ desc: 'x' }], container: { items: [] } } }), false);
  });
  it('空入参不编答案', async () => {
    const { acceptanceRecorded } = await loadModule();
    assert.equal(acceptanceRecorded(null), false);
    assert.equal(acceptanceRecorded({}), false);
    assert.equal(acceptanceRecorded({ acceptance: null }), false);
  });
});

// missionStateSettled：「这一件收工了没有」。它不判五态，只对算好的字符串做一次折算。
// 住在这片叶子而不是 steward-board.js —— 看板的 M6／N3 钉着「本模块零 'done'／'stopped' 字面量」，
// 那是「不许在看板里长出第二套五态判据」的机械保证（第一版写在看板里，两条当场转红）。
describe('missionStateSettled —— 收工了没有', () => {
  it('done / stopped 是收工', async () => {
    const { missionStateSettled } = await loadModule();
    assert.equal(missionStateSettled('done'), true);
    assert.equal(missionStateSettled('stopped'), true);
  });
  it('在动的三态都不是收工', async () => {
    const { missionStateSettled } = await loadModule();
    for (const state of ['needs_you', 'running', 'dispatching']) assert.equal(missionStateSettled(state), false);
  });
  it('quick_ask 不算 —— 它不是一件交办出去的活，由调用方的 tracked 门挡，不在这里替它下定义', async () => {
    const { missionStateSettled } = await loadModule();
    assert.equal(missionStateSettled('quick_ask'), false);
  });
  it('空值与未知串不编答案', async () => {
    const { missionStateSettled } = await loadModule();
    for (const value of ['', null, undefined, 'DONE', 'finished', 0]) assert.equal(missionStateSettled(value), false);
  });
});

describe('threadShownTitle —— 看板／抽屉页签上的线程名', () => {
  it('后端未命名占位换成调用方给的本地化占位（第一回合时左栏曾印出英文 New session）', async () => {
    const { threadShownTitle } = await loadModule();
    for (const raw of ['New session', '新会话', 'New chat', '', '   ']) {
      assert.equal(threadShownTitle({ displayTitle: raw, title: raw, sessionId: 'sess_1' }, '未命名线程'), '未命名线程');
    }
  });
  it('有名字就照原样；displayTitle 优先，缺席回落 title', async () => {
    const { threadShownTitle } = await loadModule();
    assert.equal(threadShownTitle({ displayTitle: '一季度销售小结', title: 'New session' }, '未命名线程'), '一季度销售小结');
    assert.equal(threadShownTitle({ title: '帮我分析 sales.csv' }, '未命名线程'), '帮我分析 sales.csv');
    assert.equal(threadShownTitle({ displayTitle: 'New session:续', title: 'x' }, '未命名线程'), 'New session:续');
  });
  it('没给本地化占位时回落 sessionId；坏入参不抛', async () => {
    const { threadShownTitle } = await loadModule();
    assert.equal(threadShownTitle({ title: 'New session', sessionId: 'sess_9' }), 'sess_9');
    assert.equal(threadShownTitle(null, '未命名线程'), '未命名线程');
  });
});
