#!/usr/bin/env node
'use strict';

// 前端 bug 扫查批:三处「写错一个字符就静默失效」的前端小锁。
//
//   ① 输入法组合守卫:中文输入法选字时按回车/Esc,keydown 照样派发(isComposing=true,keyCode=229)。
//      文本框上的「回车提交 / Esc 关闭」不认这一条,就会把半截拼音当命令执行、提交、或把整个浮层关掉。
//      这是结构性判据(处理器挂在各模块的 DOM 接线里,运行时拿不到),所以按 source-slice 切出处理器体来断言;
//      另有一道发现式扫描:public/ 下任何新写的 `key === 'Enter'` 要么自带守卫,要么是按钮类控件的
//      Enter/空格激活、或 Ctrl/⌘+Enter 组合键,否则红。
//   ② 工作流「提议池」两处的 i18n 插值名必须与语言包占位符一致({{iters}})—— 语言包是运行时 JSON,直接读值。
//   ③ 已决行的任务摘要把空白压成一个空格:正则是 /\s+/,不是 /s+/(后者把字母 s 换成空格)。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bracedBlock, sliceBlock } = require('../lib/source-slice');

const PUBLIC = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public');
const read = rel => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');

const IME_GUARD = /isComposing[\s\S]*keyCode\s*[!=]==\s*229|keyCode\s*[!=]==\s*229[\s\S]*isComposing/;

// [文件, 处理器起点标记, 终点标记?] —— 无终点时切该处理器的函数体(起点之后第一个 { 的配对 });
// 守卫写在分支条件里的(全局 Esc),用 sliceBlock 切到给定终点。
const GUARDED_HANDLERS = [
  ['app.js', "$('paletteInput').addEventListener('keydown', e =>"],                 // 命令面板:回车执行
  ['app.js', "else if (e.key === 'Escape'", '{'],                                     // 全局 Esc:关模态/停回合
  ['js/navigation-controls.js', "inp.addEventListener('keydown', e =>"],             // 会话重命名
  ['js/navigation-controls.js', "custom.addEventListener('keydown', e =>"],          // 上下文窗口自定义上限
  ['js/skills-memory.js', "search.addEventListener('keydown', event =>"],            // 技能搜索
  ['js/workspace-preferences.js', "input.addEventListener('keydown', e =>"],         // 粘贴工作区路径
  ['js/provider-settings.js', "addInput.addEventListener('keydown', e =>"],          // 设置里加工作区
  ['js/onboarding-wizard.js', 'pathInput.onkeydown = e =>'],                          // 首启向导路径
  ['js/popover.js', 'const onKey = e =>'],                                            // 浮层 Esc
  ['js/steward-chips.js', 'menu.onkeydown = event =>'],                               // 管家菜单(焦点可在搜索框)
];

describe('输入法组合守卫', () => {
  for (const [file, marker, end] of GUARDED_HANDLERS) {
    it(`${file} · ${marker}`, () => {
      const src = read(file);
      assert.ok(src.includes(marker), `标记在源码里找不到:${marker}`);
      const block = end ? sliceBlock(src, marker, end) : bracedBlock(src, marker);
      assert.ok(block.length > 20, `切到了处理器(${block.length} 字)`);
      assert.match(block, IME_GUARD, `${file} 这一处缺 isComposing / keyCode 229 守卫`);
    });
  }

  it('public/ 下每一处 key === \'Enter\' 都带守卫,或属于按钮激活/组合键', () => {
    const files = ['app.js', ...fs.readdirSync(path.join(PUBLIC, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f)];
    const guardedStarts = new Map();
    for (const [file, marker, end] of GUARDED_HANDLERS) {
      if (end) continue; // 分支条件式守卫只管那一分支,不代表整段处理器
      const src = read(file);
      const at = src.indexOf(marker);
      const block = bracedBlock(src, marker);
      if (at >= 0 && block) (guardedStarts.get(file) || guardedStarts.set(file, []).get(file)).push([at, at + block.length]);
    }
    const offenders = [];
    for (const file of files) {
      const src = read(file);
      const re = /key\s*===\s*'Enter'/g;
      let m;
      while ((m = re.exec(src))) {
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        const lineEnd = src.indexOf('\n', m.index);
        const line = src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd);
        if (/isComposing/.test(line)) continue;                                   // 同一行自带守卫
        if (/'Enter'\s*\|\|\s*\w+\.key\s*===\s*' '/.test(line)) continue;       // 按钮类控件的 Enter/空格激活
        if (/ctrlKey|metaKey/.test(line)) continue;                               // Ctrl/⌘+Enter 组合键
        if ((guardedStarts.get(file) || []).some(([a, b]) => m.index >= a && m.index <= b)) continue; // 处理器顶部统一守卫
        if (/steward-chips\.js$/.test(file) && /return\s+Boolean\(event\)/.test(line)) continue;       // isSubmitEnter 本体(同行判 isComposing)
        offenders.push(`${file}: ${line.trim().slice(0, 120)}`);
      }
    }
    assert.deepEqual(offenders, [], '新写的回车处理器要加 `e.isComposing || e.keyCode === 229` 守卫');
  });
});

describe('工作流提议池', () => {
  it('workflow.pool.cost 的调用点都按语言包占位符 {{iters}} 传参', () => {
    for (const locale of ['zh-CN', 'en-US']) {
      const table = JSON.parse(read(`locales/${locale}.json`));
      assert.match(String(table['workflow.pool.cost'] || ''), /\{\{iters\}\}/, `${locale} 语言包占位符`);
    }
    let sites = 0;
    for (const file of ['js/workbench.js', 'js/agent-workflows.js']) {
      const src = read(file);
      let from = 0;
      for (;;) {
        const at = src.indexOf("t('workflow.pool.cost', {", from);
        if (at < 0) break;
        const marker = "t('workflow.pool.cost', ";
        const params = bracedBlock(src.slice(at), marker).slice(marker.length);
        assert.match(params, /^\{\s*iters:/, `${file} 的 workflow.pool.cost 传的是 ${params}`);
        sites += 1;
        from = at + 1;
      }
    }
    assert.ok(sites >= 2, `两处提议卡都找到了(${sites})`);
  });

  it('已决行压空白用 /\\s+/,public/ 里不再有 /s+/ 这种漏了反斜杠的正则', () => {
    const files = ['app.js', ...fs.readdirSync(path.join(PUBLIC, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f)];
    const bad = files.filter(file => /\.replace\(\/s\+\/g/.test(read(file)));
    assert.deepEqual(bad, []);
    // 行为本身:同一条正则对多行任务文本的效果
    const task = 'check  sources\n\tand  tests';
    assert.equal(task.replace(/\s+/g, ' '), 'check sources and tests');
  });
});
