// Unit：设置页「技能与模板」（public/js/settings-skills.js）的纯函数部分，零 DOM。
//
// 钉的是三段各自的判据：
//   技能   —— 只列 kind:'skill'；常驻名单里清单已找不到的 id 单列成「失效项」；开关在名额满／技能不可用时锁住。
//   一键任务 —— builtin:true 只读、其余（含覆盖了内置 id 的用户文件）归用户；改名只换 title、其余字段原样带回、不带运行时字段。
//   模板   —— localStorage 读回来的东西不可信，按原数组下标改名/改内容/删除，不替人清理其它条目。
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { describe, it } = require('node:test');

const MODULE_PATH = path.resolve(__dirname, '../../ruyi-workbench/app/public/js/settings-skills.js');
let modulePromise = null;
const loadModule = () => (modulePromise ||= import(pathToFileURL(MODULE_PATH).href));

describe('技能：skillRows / residentGhostIds / residentSwitchState', () => {
  it('只留 kind=skill 且有 id 的项（命令与一键任务在别的段）', async () => {
    const { skillRows } = await loadModule();
    const rows = skillRows([
      { kind: 'skill', id: 'a' }, { kind: 'command', id: 'b' }, { kind: 'playbook', id: 'c' },
      { kind: 'skill' }, null, { kind: 'skill', id: 'd', source: 'user' },
    ]);
    assert.deepStrictEqual(rows.map(r => r.id), ['a', 'd']);
    assert.deepStrictEqual(skillRows(undefined), []);
    assert.deepStrictEqual(skillRows('x'), []);
  });

  it('常驻名单里清单找不到的 id 才是失效项；去重、忽略空值', async () => {
    const { residentGhostIds } = await loadModule();
    const rows = [{ id: 'a' }, { id: 'b' }];
    assert.deepStrictEqual(residentGhostIds(rows, ['a', 'gone', 'gone', '', null, 'b', 'also-gone']), ['gone', 'also-gone']);
    assert.deepStrictEqual(residentGhostIds(rows, []), []);
    assert.deepStrictEqual(residentGhostIds(null, ['x']), ['x']);
  });

  it('开关：没满可开；满了且本行没开 → 锁；本行已开永远能关；不可用的不让动', async () => {
    const { residentSwitchState } = await loadModule();
    const full = ['1', '2', '3', '4', '5', '6', '7', '8'];
    assert.deepStrictEqual(residentSwitchState({ id: 'x' }, ['1'], 8), { on: false, unavailable: false, locked: false, disabled: false });
    assert.deepStrictEqual(residentSwitchState({ id: 'x' }, full, 8), { on: false, unavailable: false, locked: true, disabled: true });
    assert.deepStrictEqual(residentSwitchState({ id: '3' }, full, 8), { on: true, unavailable: false, locked: false, disabled: false });
    const unavailable = residentSwitchState({ id: 'x', available: false }, [], 8);
    assert.strictEqual(unavailable.disabled, true);
    assert.strictEqual(unavailable.locked, false);
  });
});

describe('一键任务：splitPlaybooks / playbookRenameBody', () => {
  it('builtin:true 归内置，其余（含覆盖内置 id 的 builtin:false）归用户；无 id 的丢掉', async () => {
    const { splitPlaybooks } = await loadModule();
    const { user, builtin } = splitPlaybooks([
      { id: 'pb1', builtin: true }, { id: 'u1', builtin: false }, { id: 'u2' }, { builtin: false }, null, 7,
    ]);
    assert.deepStrictEqual(builtin.map(p => p.id), ['pb1']);
    assert.deepStrictEqual(user.map(p => p.id), ['u1', 'u2']);
    assert.deepStrictEqual(splitPlaybooks(undefined), { user: [], builtin: [] });
  });

  it('改名只换 title：可存字段原样带回，运行时字段（available/status/builtin…）不带', async () => {
    const { playbookRenameBody } = await loadModule();
    const pb = {
      id: 'weekly', title: '周报', icon: '📝', desc: '每周一', inputs: [{ key: 'notes', label: '笔记', type: 'text' }],
      promptTemplate: '写周报 {notes}', requires: ['network'], engineHint: '', uiMode: 'both', service: 'writing',
      builtin: false, available: true, status: 'available', unavailableReason: '', missingCaps: [],
    };
    const body = playbookRenameBody(pb, '  我的周报  ');
    assert.strictEqual(body.title, '我的周报');
    assert.strictEqual(body.id, 'weekly');
    assert.strictEqual(body.promptTemplate, '写周报 {notes}');
    assert.deepStrictEqual(body.inputs, pb.inputs);
    assert.deepStrictEqual(body.requires, ['network']);
    for (const key of ['builtin', 'available', 'status', 'unavailableReason', 'missingCaps']) assert.ok(!(key in body), key);
    assert.strictEqual(pb.title, '周报', '不改入参');
  });

  it('空名字／空白名字 → null；超长名字截到服务端上限', async () => {
    const { playbookRenameBody, PLAYBOOK_TITLE_MAX } = await loadModule();
    const pb = { id: 'a', title: 'x', promptTemplate: 'y' };
    assert.strictEqual(playbookRenameBody(pb, ''), null);
    assert.strictEqual(playbookRenameBody(pb, '   '), null);
    assert.strictEqual(playbookRenameBody(pb, null), null);
    assert.strictEqual(playbookRenameBody(null, 'n'), null);
    assert.strictEqual(playbookRenameBody(pb, 'n'.repeat(500)).title.length, PLAYBOOK_TITLE_MAX);
    assert.strictEqual(PLAYBOOK_TITLE_MAX, 120, '与服务端 normalizePlaybook 的 title 上限同值');
  });
});

describe('模板：cleanTemplates / templatesWithout / templatesWithEdit', () => {
  it('cleanTemplates 只认有名字有正文的对象，并保留原数组下标', async () => {
    const { cleanTemplates } = await loadModule();
    const raw = [{ name: 'a', text: 'A' }, null, { name: '', text: 'x' }, { name: 'b', text: '   ' }, 'str', { name: 'c', text: 'C', extra: 1 }];
    assert.deepStrictEqual(cleanTemplates(raw), [{ index: 0, name: 'a', text: 'A' }, { index: 5, name: 'c', text: 'C' }]);
    assert.deepStrictEqual(cleanTemplates({}), []);
    assert.deepStrictEqual(cleanTemplates(undefined), []);
  });

  it('templatesWithout 按原下标删一条，其余（含不合规的）原样保留；越界 → null', async () => {
    const { templatesWithout } = await loadModule();
    const raw = [{ name: 'a', text: 'A' }, null, { name: 'c', text: 'C' }];
    assert.deepStrictEqual(templatesWithout(raw, 2), [{ name: 'a', text: 'A' }, null]);
    assert.deepStrictEqual(templatesWithout(raw, 0), [null, { name: 'c', text: 'C' }]);
    assert.strictEqual(templatesWithout(raw, 3), null);
    assert.strictEqual(templatesWithout(raw, -1), null);
    assert.strictEqual(templatesWithout(raw, 1.5), null);
    assert.strictEqual(templatesWithout('x', 0), null);
    assert.strictEqual(raw.length, 3, '不改入参');
  });

  it('templatesWithEdit：改名与内容；名字空 → name、内容空 → text、下标不对 → range；不改入参', async () => {
    const { templatesWithEdit, TEMPLATE_NAME_MAX, TEMPLATE_TEXT_MAX } = await loadModule();
    const raw = [{ name: 'a', text: 'A', keep: true }, { name: 'b', text: 'B' }];
    const ok = templatesWithEdit(raw, 0, { name: '  新名字 ', text: '新内容\n第二行' });
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(ok.list[0], { name: '新名字', text: '新内容\n第二行', keep: true });
    assert.deepStrictEqual(ok.list[1], raw[1]);
    assert.deepStrictEqual(raw[0], { name: 'a', text: 'A', keep: true }, '不改入参');
    assert.deepStrictEqual(templatesWithEdit(raw, 0, { name: '  ', text: 'x' }), { ok: false, reason: 'name' });
    assert.deepStrictEqual(templatesWithEdit(raw, 0, { name: 'x', text: ' \n ' }), { ok: false, reason: 'text' });
    assert.deepStrictEqual(templatesWithEdit(raw, 2, { name: 'x', text: 'y' }), { ok: false, reason: 'range' });
    assert.deepStrictEqual(templatesWithEdit([null], 0, { name: 'x', text: 'y' }), { ok: false, reason: 'range' });
    assert.deepStrictEqual(templatesWithEdit('nope', 0, { name: 'x', text: 'y' }), { ok: false, reason: 'range' });
    const long = templatesWithEdit(raw, 1, { name: 'n'.repeat(TEMPLATE_NAME_MAX + 50), text: 't'.repeat(TEMPLATE_TEXT_MAX + 50) });
    assert.strictEqual(long.list[1].name.length, TEMPLATE_NAME_MAX);
    assert.strictEqual(long.list[1].text.length, TEMPLATE_TEXT_MAX);
  });

  it('previewText 折叠空白并截断', async () => {
    const { previewText } = await loadModule();
    assert.strictEqual(previewText('  你好\n\n  世界 '), '你好 世界');
    assert.strictEqual(previewText('a'.repeat(200), 10), 'aaaaaaaaa…');
    assert.strictEqual(previewText(null), '');
  });
});

describe('组合：三段登记与无 DOM 宿主', () => {
  it('三段 id/kind/文案键齐全且登记表冻结（段本身是 section.settings-section，由浏览器件 K1c 钉）', async () => {
    const { SETTINGS_SKILLS_SECTIONS } = await loadModule();
    assert.deepStrictEqual(SETTINGS_SKILLS_SECTIONS.map(s => s.kind), ['skills', 'playbooks', 'templates']);
    for (const section of SETTINGS_SKILLS_SECTIONS) {
      assert.match(section.id, /^setskill[A-Z]/);
      assert.match(section.titleKey, /^settings\.skills\.section\./);
      assert.match(section.hintKey, /^settings\.skills\./);
    }
    assert.ok(Object.isFrozen(SETTINGS_SKILLS_SECTIONS));
  });

  it('没有 document（或没有挂载点）时 mount 返回 false、open 不抛', async () => {
    const { createSettingsSkillsDomain } = await loadModule();
    const bare = createSettingsSkillsDomain({ doc: null });
    assert.strictEqual(bare.mount(), false);
    await bare.open();
    const noHost = createSettingsSkillsDomain({ doc: { getElementById: () => null } });
    assert.strictEqual(noHost.mount(), false);
    await noHost.open();
  });
});
