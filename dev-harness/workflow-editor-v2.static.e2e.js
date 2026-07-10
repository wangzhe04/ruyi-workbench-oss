'use strict';
// dev-harness/workflow-editor-v2.static.e2e.js — 工作流图形编辑器 v2 前端契约护栏（第14波）。
//
// 零依赖、离线、node 直跑、无端口。纯静态：只读前端源码(read-frontend-src.js 聚合 app.js + js/**)与
// styles.css，做字面量/正则断言。真实渲染由指挥官用 preview 核验。仿 ui-v3-wave1.static.e2e.js 风格。
// 判定行：`WORKFLOW EDITOR V2 STATIC E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { readFrontendSrc, PUB } = require('./read-frontend-src.js');

const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const src = readFrontendSrc();

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

// ───────────── A1 模型下拉（核心：为特定职位指派更强模型） ─────────────
ok(/function engineModelOptions\(eng\)/.test(src), 'A1 engineModelOptions 按引擎产出模型列表');
ok(/eng==='openai'[\s\S]{0,120}activeProviderObj\(\)/.test(src), 'A1 openai 引擎取当前激活 provider 的 models');
ok(/state\.config\.knownModels/.test(src) && /state\.config\.extraModels/.test(src), 'A1 claude 引擎取 config.knownModels + extraModels');
ok(/function rebuildModelOptions\(resetForeign\)/.test(src), 'A1 rebuildModelOptions 跟随引擎联动重建选项(对抗轮P3:换引擎重置外来模型)');
ok(/继承（角色\/全局默认）/.test(src), 'A1 模型下拉首项「继承（角色/全局默认）」(value=空)');
ok(/cus\.value='__custom'[\s\S]{0,40}'自定义…'/.test(src), 'A1 模型下拉尾项「自定义…」切出文本输入');
ok(/model\.disabled=true/.test(src) && /引擎为自动时不单独指定模型/.test(src), 'A1 engine=自动 时模型下拉禁用 + 跟随默认提示');
ok(/当前生效：节点指定/.test(src) && /当前生效：角色默认/.test(src) && /当前生效：全局默认/.test(src), 'A1 有效继承链 hint 三态（节点/角色/全局）');
ok(/function roleModelFor\(roleId,eng\)/.test(src) && /function globalModelFor\(eng\)/.test(src), 'A1 继承链解析：角色默认 / 全局默认 各有解析器');
ok(/node\.model\s*=\s*engine\.value\s*\?\s*modelVal\s*:\s*''/.test(src), 'A1 保存回写 node.model（引擎为自动时清空）');

// ───────────── A2 补三字段：质量门 / 迭代预算 / 工具权限 ─────────────
ok(/\['cross_review','cross_review 交叉审查'\]/.test(src) && /\['dedupe','dedupe 去重'\]/.test(src), 'A2 质量门下拉含五种模式');
ok(/node\.gate\s*=\s*gate\.value\s*\?\s*\{[\s\S]{0,80}mode:gate\.value\s*\}\s*:\s*false/.test(src), 'A2 保存回写 node.gate={...,mode}/false 显式无门(对抗轮P2:null 会被服务端按角色回填)');
ok(/迭代预算 maxIters/.test(src) && /maxIters\.type='number'/.test(src) && /maxIters\.max='100'/.test(src), 'A2 迭代预算 maxIters（number 1-100，空=默认）');
ok(/if\(mi\)\s*node\.maxIters=Math\.max\(1,Math\.min\(100/.test(src) && /else delete node\.maxIters/.test(src), 'A2 maxIters 空=删除 / 有值 clamp 回写');
ok(/工具权限 toolTier/.test(src) && /\['read','只读 read'\]/.test(src) && /\['exec','可执行 exec'\]/.test(src), 'A2 工具权限 toolTier 下拉（继承/read/edit/exec）');
ok(/if\(toolTier\.value\)\s*node\.toolTier=toolTier\.value;\s*else delete node\.toolTier/.test(src), 'A2 toolTier 保存回写/删除');

// ───────────── A3 高级 JSON 折叠区 ─────────────
ok(/el\('details','wf-insp-advanced'\)/.test(src), 'A3 高级区 <details class=wf-insp-advanced>');
ok(/advTa\.value=JSON\.stringify\(node,null,2\)/.test(src), 'A3 textarea 预填当前节点完整 JSON');
ok(/JSON\.parse\(advTa\.value\)/.test(src) && /toast\('JSON 解析失败/.test(src), 'A3 应用按钮 JSON.parse 校验，坏 JSON toast 拒绝');
ok(/for\(const k of Object\.keys\(node\)\) delete node\[k\]/.test(src) && /Object\.assign\(node,parsed\)/.test(src), 'A3 应用 JSON 原地重写节点（保持 draft 引用）');

// ───────────── A4 检查器四分组 ─────────────
ok(/const group=\(title,\.\.\.items\)=>/.test(src), 'A4 group() 分组装配器');
for (const g of ['身份', '执行', '编排', '质量']) ok(new RegExp("group\\('" + g + "'").test(src), 'A4 分组「' + g + '」存在');
ok(/\.wf-insp-group-title\s*\{[^}]*var\(--muted\)[^}]*text-transform:\s*uppercase/.test(css), 'A4 .wf-insp-group-title muted 大写小字（同 skill-group-title 族）');
ok(/\.wf-insp-group\s*\{[^}]*margin-bottom:\s*var\(--sp-4\)/.test(css), 'A4 组间距 var(--sp-4)');

// ───────────── B1 节点卡 v2：引擎徽标 + 模型名 + 质量门标 ─────────────
ok(/const badge=agentEngineBadge\(node\.engine\)/.test(src), 'B1 节点卡复用 agentEngineBadge（替代 engineTag 文本拼接）');
ok(!/const engineTag=node\.engine==='claude'\?' · Claude CLI'/.test(src), 'B1 旧 engineTag 文本拼接已移除');
ok(/wf-node-model'[\s\S]{0,80}node\.model\.slice\(0,18\)/.test(src), 'B1 有 node.model 时第二行 mono 显示模型名（截 18 字）');
ok(/el\('span','wf-node-gate','⚖'\)/.test(src), 'B1 有 gate 时显示 ⚖ 小标');
ok(/\.workflow-node-card\.selected\s*\{[^}]*var\(--elev-2\)/.test(css), 'B1 选中态 box-shadow 升 var(--elev-2)');

// ───────────── B2 画布悬浮控件：适应视图 + 空画布引导 ─────────────
ok(/function fitView\(\)/.test(src) && /graph\.scrollTo\(/.test(src), 'B2 fitView 计算包围盒并 scrollTo 居中');
ok(/wf-canvas-controls/.test(src) && /'适应视图'/.test(src), 'B2 右下角悬浮控件组「适应视图」');
ok(/if\(!draft\.nodes\.length\)\{const guide=el\('div','wf-canvas-empty'\)/.test(src), 'B2 空画布引导浮层 .wf-canvas-empty');
ok(/'从模板开始'/.test(src) && /＋ 添加第一个节点/.test(src), 'B2 空态两按钮引导（模板 / 加首节点）');

// ───────────── C1 边缘拖拽连线（连接手柄） ─────────────
ok(/const port=el\('span','wf-port'\)/.test(src), 'C1 节点卡右缘连接手柄 .wf-port');
ok(/temp\.setAttribute\('class','wf-temp-edge'\)/.test(src), 'C1 拖拽时画临时虚线 .wf-temp-edge');
ok(/addWorkflowEdge\(node\.id,targetId\)/.test(src), 'C1 落点吸附成边（复用 addWorkflowEdge 校验）');
ok(/connectBtn/.test(src) && /连接箭头/.test(src), 'C1 保留既有「连接箭头」按钮流程（触屏兜底）');
ok(/\.wf-port\s*\{[^}]*cursor:\s*crosshair/.test(css) && /\.wf-port:hover\s*\{[^}]*scale\(1\.35\)/.test(css), 'C1 手柄 hover 放大');

// ───────────── C2 保存前实时校验（防抖 300ms） ─────────────
ok(/function validateDraft\(\)/.test(src), 'C2 validateDraft 校验器');
ok(/存在环依赖/.test(src) && /let cyc=false/.test(src), 'C2 环依赖 DFS 检测');
ok(/依赖不存在的/.test(src) && /任务为空/.test(src) && /节点 ID 重复/.test(src), 'C2 覆盖悬空依赖 / 空任务 / 重复 ID');
ok(/\},\s*300\)/.test(src) && /function scheduleValidate\(\)/.test(src), 'C2 防抖 300ms 调度');
ok(/classList\.toggle\('wf-node-invalid'/.test(src), 'C2 问题节点卡加 .wf-node-invalid（danger 描边）');
ok(/wf-problem-chip/.test(src) && /个问题/.test(src), 'C2 工具栏「⚠ N 个问题」chip');
ok(/\.workflow-node-card\.wf-node-invalid\s*\{[^}]*var\(--danger\)/.test(css), 'C2 .wf-node-invalid danger 描边');

// ───────────── C3 键盘 + 撤销栈 ─────────────
ok(/let undoStack\s*=\s*\[\]/.test(src) && /function snapshot\(\)/.test(src), 'C3 draft 快照撤销栈 + snapshot()');
ok(/structuredClone\(draft\.nodes\)/.test(src), 'C3 深拷贝 structuredClone');
ok(/undoStack\.length\s*>\s*20/.test(src), 'C3 快照栈 cap 20');
ok(/undoStack\.length=0/.test(src), 'C3 外部 draft 替换（载入/新建/另存）时清空撤销栈（一致性）');
ok(/e\.key==='Delete'/.test(src), 'C3 Delete 删除选中节点/边');
ok(/e\.ctrlKey\|\|e\.metaKey[\s\S]{0,90}undo\(\)/.test(src), 'C3 Ctrl+Z 撤销');
ok(/addEventListener\('dblclick'[\s\S]{0,220}data-wf-field="task"/.test(src), 'C3 双击节点卡聚焦检查器任务框(对抗轮P2:中间新增 flushInspector)');

// ───────────── C4 保存并运行（入口归一） ─────────────
ok(/run=el\('button','primary','保存并运行'\)/.test(src), 'C4 底部「保存并运行」primary 按钮');
ok(/run\.onclick=async\(\)=>\{[\s\S]{0,120}launchAgentWorkflow\(wf\)/.test(src), 'C4 保存并运行串联 saveDraft→launchAgentWorkflow');

// ───────────── D 令牌纪律：新增 CSS 无硬编码色 / 无未定义 token ─────────────
const wfV2Block = (css.match(/工作流图形编辑器 v2（第14波）[\s\S]*?\.wf-canvas-empty-actions[^}]*\}/) || [''])[0];
ok(wfV2Block.length > 400, 'D v2 CSS 块可定位');
ok(!/#[0-9a-fA-F]{3,6}\b/.test(wfV2Block), 'D v2 CSS 块无 #hex 硬编码色（全走 token/color-mix）');
const usedTokens = [...wfV2Block.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]);
const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
const undef = [...new Set(usedTokens)].filter(t => !defined.has(t));
ok(undef.length === 0, 'D v2 CSS 无引用未定义 token' + (undef.length ? '（缺：' + undef.join('、') + '）' : ''));

if (fail === 0) console.log('\nWORKFLOW EDITOR V2 STATIC E2E: ALL PASS');
else { console.log(`\nWORKFLOW EDITOR V2 STATIC E2E: ${fail} FAIL`); process.exitCode = 1; }
