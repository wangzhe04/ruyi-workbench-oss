'use strict';

const { readServerSource } = require('./src-reader');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'ruyi-workbench/app/public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'ruyi-workbench/app/public/styles.css'), 'utf8');
const server = readServerSource();

let fail = 0;
function ok(cond, label) {
  if (cond) console.log(`PASS ${label}`);
  else { fail++; console.log(`FAIL ${label}`); }
}

ok(app.includes("initialId === '__blank' ? workflowBlank()"), 'workflow editor can start from a clearly blank template');
ok(app.includes("t('workflow.editor.editSelected')") && app.includes("t('workflow.editor.newBlank')") && app.includes("t('workflow.editor.saveAsNew')"), 'template actions distinguish edit, blank-new, and save-as-new');
ok(app.includes("footLeft.append(forkBtn,remove)") && app.includes("workflow-editor-foot-left"), 'save-as-new lives in the lower-left footer group');
ok(app.includes("const sourceKey=wf.source === 'builtin'") && app.includes("o.textContent=t(sourceKey)"), 'template selector labels show template source');

ok(app.includes('const nodeSelect = document.createElement') && app.includes('syncNodeSelect()') && app.includes('nodeSelect.onchange'), 'editor has a quick node selector');
ok(app.includes('card.dataset.nodeId=node.id') && app.includes('selectedId=node.id;selectedEdge=null;renderInspector();markSelectedCards()'), 'clicking a graph node immediately switches the inspector');

ok(app.includes('deps.multiple=true') && app.includes('for(const other of draft.nodes.filter(x=>x.id!==node.id))'), 'dependencies are selected from existing nodes as a multi-select');
ok(app.includes('const nextDependsOn=[...deps.selectedOptions].map(x=>x.value)'), 'dependency apply reads selected options instead of manual text');

ok(app.includes('resetConnectMode()') && app.includes('connectBtn.onclick') && app.includes('connectFromId=selectedId||draft.nodes[0]?.id||'), 'graph supports explicit connect-arrow mode');
ok(app.includes('if(connectFromId&&connectFromId!==node.id)') && app.includes('node.dependsOn=[...(node.dependsOn||[]),connectFromId]'), 'clicking a target node adds an edge dependency');
ok(css.includes('.workflow-node-card.connect-source') && css.includes('.workflow-help'), 'connect mode and dependency help have visible styling');

ok(app.includes("edgeDeleteBtn=el('button','mini danger workflow-btn',t('workflow.editor.deleteEdge'))") && app.includes("maxBtn=el('button','workflow-window-btn','□')"), 'toolbar exposes delete-edge and the title bar exposes a Windows-style maximize action');
ok(app.includes("graph.addEventListener('contextmenu'") && app.includes("if(e.button!==2)return") && app.includes("graph.scrollLeft=sl-(ev.clientX-sx)"), 'right mouse drag pans the workflow graph');
ok(app.includes("classList.add('workflow-edge')") && app.includes('workflow-edge-hit') && app.includes('edgeEndpointByPointer(e,from,node)'), 'edges are interactive and choose the dragged endpoint from pointer position');
ok(app.includes('replaceWorkflowEdge(edge,endpoint,targetId)') && app.includes('nodeIdAtClientPoint(ev.clientX,ev.clientY)'), 'dragging an edge endpoint can retarget it to a node');
ok(app.includes('removeWorkflowEdge(selectedEdge)') && app.includes('已删除箭头'), 'selected edges can be deleted');
ok(css.includes('.modal.workflow-modal.workflow-fullscreen') && css.includes('.workflow-window-btn') && css.includes('.workflow-graph.panning') && css.includes('.workflow-edge.selected .workflow-edge-line'), 'fullscreen, titlebar, panning, and selected-edge states are styled');
ok(css.includes('.workflow-editor-foot-left') && css.includes('.workflow-btn.save-as'), 'footer save-as and workflow buttons are styled');

ok(!app.includes('confidenceTag'), 'agent workflow node UI no longer renders confidence tags');
// 收窄(v1.5 第14波):原全文件禁「置信度」误伤了运行监控视图合法的置信度结果展示(wf-gate-conf,
// UI-ORCHESTRATION-REDESIGN §2.3 交付项)。原意=编辑器/模板不暴露置信度**配置项**,以配置词汇断言之。
ok(!app.includes('minConfidence') && !app.includes('最低置信度'), 'editor exposes no confidence-threshold configuration wording');
ok(!server.includes('带置信度') && !server.includes('confidence thresholds') && !server.includes('minimum accepted confidence'), 'server-facing template/tool copy no longer exposes confidence wording');
ok(!server.includes("gate: { mode: 'cross_review', minConfidence"), 'built-in templates do not seed visible confidence thresholds');

if (fail) {
  console.error(`\nAGENT WORKFLOW EDITOR UI E2E: ${fail} FAIL`);
  process.exit(1);
}
console.log('\nAGENT WORKFLOW EDITOR UI E2E: ALL PASS');
