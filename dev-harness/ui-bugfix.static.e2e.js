'use strict';
// dev-harness/ui-bugfix.static.e2e.js — 两个用户实测 bug 的前端契约护栏(纯静态,零依赖,node 直跑,无端口)。
// 只读聚合前端源码(read-frontend-src.js:app.js + js/**)做字面量/正则断言。真实渲染由指挥官 preview 核验。
//
// BUG1:工作台节点详情「任务全文/查看结果」展开后被 2s 轮询重建 DOM 冲回关闭态。修法仿三段折叠 panelOpen:
//   wbState.detailExpand 记忆两内层 <details> 开合,轮询重建时按记忆恢复,toggle 监听回写;换节点时重置。
// BUG2:图形编辑器改节点引擎/模型未点「应用」就「保存」→ 检查器编辑未 flush 进 draft.nodes → 存旧值。
//   修法:renderInspector 节点分支把 apply 逻辑具名为 doApplyNode 并挂到 commitSelectedNode;saveDraft 保存前
//   先调 commitSelectedNode() flush(校验失败抛错),再 POST。边/无选中分支 commitSelectedNode=null。
// 判定行:`UI BUGFIX STATIC E2E: ALL PASS`。
const { readFrontendSrc } = require('./read-frontend-src.js');
const src = readFrontendSrc(); // app.js + js/**

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const has = (s, ...subs) => subs.every(x => s.includes(x));
// 取一个 JS 函数体切片(从 `function NAME(` 到下一个顶层 `\nfunction ` 或长度上限)。
function fnBody(name, cap = 6000) {
  const i = src.indexOf(`function ${name}(`); if (i < 0) return '';
  const next = src.indexOf('\nfunction ', i + 1);
  return src.slice(i, next > i ? Math.min(next, i + cap) : i + cap);
}

// ═══════════ BUG1:工作台内层 <details> 展开态跨 2s 轮询重建保留 ═══════════
// A. wbState 新增 detailExpand 记忆位(与 panelOpen 同族,初始收起)。
ok(has(src, 'detailExpand: { task: false, result: false }, sideOpen: false'), 'BUG1-A wbState 新增 detailExpand:{task,result}(与 panelOpen 同族)');

const det = fnBody('wbNodeDetailBody', 6000);
ok(det.length > 0, 'BUG1-B wbNodeDetailBody 函数体可定位');
// B. 「任务全文」<details> 按记忆恢复展开态 + toggle 回写(轮询重建不丢用户展开)。
ok(has(det, "el('details', 'wb-det-task')", 'tw.open = !!wbState.detailExpand.task'), 'BUG1-B 任务全文 <details> 按 detailExpand.task 恢复展开态');
ok(has(det, "tw.addEventListener('toggle'", 'wbState.detailExpand.task = tw.open'), 'BUG1-B 任务全文 toggle 监听回写记忆(手动开合更新)');
// C. 「查看结果」<details> 同理。
ok(has(det, "el('details', 'wb-det-result')", 'rw.open = !!wbState.detailExpand.result'), 'BUG1-C 查看结果 <details> 按 detailExpand.result 恢复展开态');
ok(has(det, "rw.addEventListener('toggle'", 'wbState.detailExpand.result = rw.open'), 'BUG1-C 查看结果 toggle 监听回写记忆');
// D. 换节点时重置(不继承上个节点的展开态)。
ok(has(fnBody('wbFocusRunNode'), 'wbState.detailExpand = { task: false, result: false }'), 'BUG1-D wbFocusRunNode 切节点重置 detailExpand(不继承上个节点)');

// ═══════════ BUG2:保存前 flush 当前选中节点检查器编辑(引擎/模型不丢) ═══════════
// A. 编辑器作用域声明 commitSelectedNode(与 draft/selectedId 同级)。
ok(has(src, 'let commitSelectedNode = null;'), 'BUG2-A openWorkflowEditor 作用域声明 commitSelectedNode');
// B. renderInspector 进入即清空 commitSelectedNode(边分支/无选中分支天然无可 flush 项)。
ok(/function renderInspector\(\)\{inspector\.textContent='';commitSelectedNode=null;/.test(src), 'BUG2-B renderInspector 入口重置 commitSelectedNode=null(覆盖边/无选中分支)');
// C. 节点分支:apply 逻辑具名为 doApplyNode 并挂 apply.onclick + commitSelectedNode(供 saveDraft flush)。
ok(has(src, 'const doApplyNode=()=>{'), 'BUG2-C 节点 apply 逻辑具名为 doApplyNode');
ok(has(src, 'apply.onclick=doApplyNode; commitSelectedNode=doApplyNode;'), 'BUG2-C doApplyNode 同时挂 apply.onclick 与 commitSelectedNode');
// D. 校验早退返回 false(而非原 return toast 的 undefined),成功路径 return true —— 供 saveDraft 判定 flush 成败。
ok(has(src, 'toast(t("toast.wfIdDup"),\'err\'); return false;', 'toast(t("toast.wfCondInvalid"),\'err\'); return false;'), 'BUG2-D i18n 校验失败早退为 toast(t(...)); return false');
ok(/selectedId=nextId; renderGraph\(\); renderInspector\(\);\s*\n\s*return true;/.test(src), 'BUG2-D doApplyNode 成功路径末尾 return true');
ok(!/apply\.onclick=\(\)=>\{/.test(src), 'BUG2-D 旧匿名 apply.onclick=()=>{ 已被具名 doApplyNode 取代');
// E. saveDraft 保存前先 flush,校验失败抛错阻断 POST,且 flush 早于 POST。
ok(has(src, "if(commitSelectedNode){const okc=commitSelectedNode();if(okc===false){const err=new Error(t('workflow.invalidFields'));err.__quiet=true;throw err;}}"), 'BUG2-E saveDraft 保存前 flush commitSelectedNode(失败抛错且文案走 i18n)');
const saveIdx = src.indexOf('async function saveDraft(){');
const flushIdx = src.indexOf('if(commitSelectedNode){const okc=commitSelectedNode();', saveIdx);
const postIdx = src.indexOf("api('/api/agent-workflows',{method:'POST'", saveIdx);
ok(saveIdx >= 0 && flushIdx > saveIdx && postIdx > flushIdx, 'BUG2-E flush 位于 saveDraft 内且早于 POST(先落盘检查器编辑再提交)');

if (fail === 0) console.log('\nUI BUGFIX STATIC E2E: ALL PASS');
else { console.log(`\nUI BUGFIX STATIC E2E: ${fail} FAIL`); process.exitCode = 1; }
