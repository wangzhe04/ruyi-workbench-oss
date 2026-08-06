'use strict';

// EC-D：Agent 工作流编辑、运行监控与 Workbench 适配领域。
import { state } from './state.js';
import { api, wcwToken } from './net.js';
import { $, el, fmtTokens, toast } from './util.js';
import { t } from './i18n.js';
import { createWorkbenchDomain } from './workbench.js';

export function createAgentWorkflowsDomain({
  apiErrText = error => String(error && error.message || error || ''),
  currentWorkspace = () => '',
  switchTab = () => {},
  buildModal = () => null,
  activeProviderObj = () => null,
  activeTurns = new Map(),
  newSession = async () => {},
  openToolPane = () => {},
  scheduleRender = () => {},
  renderCurrentSession = () => {},
  renderSessions = () => {},
  scrollIsSticky = () => true,
} = {}) {
let agentWorkflowLibrary = [];
function cloneWorkflow(value) { return JSON.parse(JSON.stringify(value || {})); }
async function loadAgentWorkflows() {
  try { const r = await api(`/api/agent-workflows?cwd=${encodeURIComponent(currentWorkspace())}`); agentWorkflowLibrary = r.workflows || []; }
  catch { agentWorkflowLibrary = []; }
  const select = $('workflowQuickSelect'); if (!select) return;
  const previous = select.value; select.textContent = '';
  for (const wf of agentWorkflowLibrary) {
    const o = document.createElement('option');
    o.value = wf.id;
    const sourceKey = wf.source === 'builtin' ? 'workflow.source.builtin' : wf.source === 'project' ? 'workflow.source.project' : 'workflow.source.personal';
    o.textContent = t(sourceKey) + ' · ' + wf.title;
    select.appendChild(o);
  }
  if (agentWorkflowLibrary.some(x => x.id === previous)) select.value = previous;
}
async function launchAgentWorkflow(workflow, context) {
  if (!state.currentSession?.id) await newSession();
  const wf = workflow || agentWorkflowLibrary.find(x => x.id === $('workflowQuickSelect')?.value); if (!wf) return toast(t('workflow.selectRequired'), 'err');
  try {
    const body = { token: wcwToken(), sessionId: state.currentSession.id, nodes: wf.nodes, workflowId: wf.id, async: true };
    if (context && context.trim()) body.context = context.trim();
    const r = await api('/api/agent-workflow/launch', { method: 'POST', body: JSON.stringify(body) });
    if (!r || (!r.ok && !r.runId)) throw new Error(r && r.error || t('chat.startFailed'));
    toast(t('workflow.started', { title: wf.title }), 'ok'); switchTab('agent-runs'); await loadAgentRuns(true);
  } catch (e) { toast(t('workflow.start.failed', { reason: apiErrText(e) }), 'err'); }
}
// Quick "运行模板" launch, from the dropdown in the Agent 工作流 tab. Unlike the graphical editor's own
// "保存并运行" (where the user has already written real per-node task text), a quick-select template's
// node tasks are generic placeholders with no actual subject — clicking straight through ran it blind
// with no relevant task context. Ask for one line of context first; it's prepended to every node's task.
function launchAgentWorkflowFromQuickSelect() {
  const wf = agentWorkflowLibrary.find(x => x.id === $('workflowQuickSelect')?.value);
  if (!wf) return toast(t('workflow.selectRequired'), 'err');
  const body = el('div');
  body.append(el('p', 'muted', t('workflow.quickRun.description', { title: wf.title })));
  const ctx = document.createElement('textarea'); ctx.rows = 4; ctx.placeholder = t('workflow.quickRun.contextPlaceholder');
  body.appendChild(workflowField(t('workflow.quickRun.contextLabel'), ctx));
  const foot = el('div', 'modal-actions');
  const cancel = el('button', '', t('common.cancel')); const run = el('button', 'primary', t('workflow.start'));
  foot.append(cancel, run);
  const modal = buildModal(t('workflow.quickRun.title', { title: wf.title }), body, foot);
  cancel.onclick = () => modal.close();
  run.onclick = async () => { const context = ctx.value; modal.close(); await launchAgentWorkflow(wf, context); };
}
function workflowBlank() { return { id: `workflow-${Date.now().toString(36)}`, title: t('workflow.editor.newBlank'), description: '', source: 'personal', nodes: [{ id: 'step_1', task: t('workflow.editor.defaultTask'), role: 'worker', dependsOn: [], failurePolicy: 'block', position: { x: 40, y: 120 } }] }; }
function workflowField(label, input) { const wrap = el('label', 'workflow-field'); wrap.append(el('span', '', label), input); return wrap; }
function workflowConditionText(value) { return value ? `${value.node ? value.node + '.' : ''}${value.path || ''} ${value.operator || 'truthy'}${value.value === undefined ? '' : ' ' + JSON.stringify(value.value)}`.trim() : ''; }
function parseWorkflowConditionText(text) {
  const t = String(text || '').trim();
  const OPS = 'equals|not_equals|truthy|falsy|contains|greater|greater_equal|less|less_equal|status_is|==|!=|>=|<=|>|<';
  const aliases = { '==': 'equals', '!=': 'not_equals', '>': 'greater', '>=': 'greater_equal', '<': 'less', '<=': 'less_equal' };
  // 对抗轮 P2: 服务器端合法条件含「无 node 前缀」(对当前节点求值,如 "done truthy")与「空 path」(对整个结构化
  // 结果求值,如 "a. status_is")两形态——原正则强制 node.path 双非空,这类条件(高级 JSON/项目文件导入)一经选中
  // 就把整个保存硬阻断且报错误导。四形态全支持:node.path op / path op / node. op / 纯 op。
  let m = t.match(new RegExp(`^(?:([A-Za-z0-9_-]+)\\.)?([^\\s]*)\\s+(${OPS})(?:\\s+(.+))?$`));
  if (!m) { const bare = t.match(new RegExp(`^(${OPS})(?:\\s+(.+))?$`)); if (bare) m = [t, '', '', bare[1], bare[2]]; }
  if (!m) return null;
  let value; if (m[4]) { try { value = JSON.parse(m[4]); } catch { value = m[4]; } }
  return { node: m[1] || '', path: m[2] || '', operator: aliases[m[3]] || m[3], value };
}
async function openWorkflowEditor(initialId) {
  await loadAgentWorkflows();
  let draft = initialId === '__blank' ? workflowBlank() : cloneWorkflow(agentWorkflowLibrary.find(x => x.id === initialId) || agentWorkflowLibrary.find(x => x.id === $('workflowQuickSelect')?.value) || workflowBlank());
  draft.source = draft.source === 'project' ? 'project' : 'personal'; let selectedId = draft.nodes[0] && draft.nodes[0].id;
  let connectFromId = '';
  let selectedEdge = null;
  let commitSelectedNode = null;
  // 对抗轮 P2: 切换选中节点前 flush 检查器未应用的编辑(saveDraft 同款,堵"编辑后切走即静默丢弃"的另一半)。
  // 校验失败不阻断切换(免困死),但 doApplyNode 已弹具体错误,这里补一句"已放弃"让丢弃不再无声。
  function flushInspector() {
    if (!commitSelectedNode) return;
    if (commitSelectedNode() === false) toast(t("toast.wfEditDiscarded"), 'err');
  }
  let roles = []; try { roles = (await api(`/api/agent-roles?cwd=${encodeURIComponent(currentWorkspace())}`)).roles || []; } catch {}
  const body = el('div', 'workflow-editor');
  const meta = el('div', 'workflow-meta'); const idInput = document.createElement('input'); idInput.value = draft.id; const titleInput = document.createElement('input'); titleInput.value = draft.title; const descInput = document.createElement('input'); descInput.value = draft.description || '';
  const scopeSelect = document.createElement('select'); for (const [v, key] of [['personal','workflow.source.personal'],['project','workflow.source.project']]) { const o=document.createElement('option');o.value=v;o.textContent=t(key);scopeSelect.appendChild(o); } scopeSelect.value=draft.source;
  meta.append(workflowField(t('workflow.editor.id'), idInput), workflowField(t('workflow.editor.name'), titleInput), workflowField(t('workflow.editor.description'), descInput), workflowField(t('workflow.editor.scope'), scopeSelect)); body.appendChild(meta);
  const toolbar = el('div', 'workflow-editor-toolbar'); const templateSelect = document.createElement('select'); for (const wf of agentWorkflowLibrary) { const o=document.createElement('option');o.value=wf.id;const sourceKey=wf.source === 'builtin' ? 'workflow.source.builtin' : wf.source === 'project' ? 'workflow.source.project' : 'workflow.source.personal';o.textContent=t(sourceKey) + ' · ' + wf.title;templateSelect.appendChild(o); } templateSelect.value=draft.id;
  const nodeSelect = document.createElement('select'); nodeSelect.title = t('workflow.canvas.quickSelect');
  const loadBtn=el('button','mini workflow-btn',t('workflow.editor.editSelected')), blankBtn=el('button','mini workflow-btn',t('workflow.editor.newBlank')), addBtn=el('button','mini workflow-btn',t('workflow.editor.addNode')), connectBtn=el('button','mini workflow-btn',t('workflow.editor.connect')), edgeDeleteBtn=el('button','mini danger workflow-btn',t('workflow.editor.deleteEdge')), deleteBtn=el('button','mini danger workflow-btn',t('workflow.editor.deleteNode')); const _tbGroup=(...els)=>{const g=el('div','wf-tb-group');g.append(...els);return g;}; toolbar.append(_tbGroup(templateSelect,loadBtn,blankBtn),el('div','wf-tb-sep'),_tbGroup(nodeSelect,addBtn,deleteBtn),el('div','wf-tb-sep'),_tbGroup(connectBtn,edgeDeleteBtn)); body.appendChild(toolbar);
  const layout=el('div','workflow-editor-layout'), graph=el('div','workflow-graph'), inspector=el('div','workflow-inspector'); layout.append(graph,inspector); body.appendChild(layout);
  const foot=el('div','modal-actions workflow-editor-foot'), footLeft=el('div','workflow-editor-foot-left'), footRight=el('div','workflow-editor-foot-right'), forkBtn=el('button','mini workflow-btn save-as',t('workflow.editor.saveAsNew')), cancel=el('button','',t('common.cancel')), remove=el('button','ghost-danger',t('workflow.editor.deleteSaved')), save=el('button','',t('common.save')), run=el('button','primary',t('workflow.editor.saveAndRun')); footLeft.append(forkBtn,remove); footRight.append(cancel,save,run); foot.append(footLeft,footRight); const modal=buildModal(t('workflow.editor.title'),body,foot); const modalEl=modal.backdrop.querySelector('.modal'); modalEl?.classList.add('workflow-modal'); const maxBtn=el('button','workflow-window-btn','□'); maxBtn.type='button'; maxBtn.title=t('workflow.editor.maximize'); maxBtn.setAttribute('aria-label',t('workflow.editor.maximize')); modalEl?.querySelector('.modal-head button')?.before(maxBtn);
  graph.tabIndex=0;graph.addEventListener('contextmenu',e=>e.preventDefault());graph.addEventListener('pointerdown',e=>{if(e.button!==2)return;e.preventDefault();const sx=e.clientX,sy=e.clientY,sl=graph.scrollLeft,st=graph.scrollTop;graph.classList.add('panning');graph.setPointerCapture?.(e.pointerId);const move=ev=>{graph.scrollLeft=sl-(ev.clientX-sx);graph.scrollTop=st-(ev.clientY-sy);};const up=()=>{graph.classList.remove('panning');graph.removeEventListener('pointermove',move);graph.removeEventListener('pointerup',up);};graph.addEventListener('pointermove',move);graph.addEventListener('pointerup',up);},true);
  function syncMeta(){draft.id=idInput.value.trim();draft.title=titleInput.value.trim();draft.description=descInput.value.trim();draft.source=scopeSelect.value;}
  function edgeKey(edge){return edge ? `${edge.from}->${edge.to}` : '';}
  function edgeExists(edge){const to=draft.nodes.find(n=>n.id===edge?.to);return !!(to&&to.dependsOn||[]).includes(edge?.from);}
  function resetConnectMode(){connectFromId='';connectBtn.textContent=t('workflow.editor.connect');}
  function syncNodeSelect(){const prev=nodeSelect.value;nodeSelect.textContent='';for(const n of draft.nodes){const o=document.createElement('option');o.value=n.id;o.textContent=`${t('workflow.nodeLabel', {id: n.id})}`;nodeSelect.appendChild(o);}nodeSelect.value=draft.nodes.some(n=>n.id===selectedId)?selectedId:(draft.nodes.some(n=>n.id===prev)?prev:(draft.nodes[0]?.id||''));}
  function markSelectedCards(){graph.querySelectorAll('.workflow-node-card').forEach(x=>{x.classList.toggle('selected',x.dataset.nodeId===selectedId);x.classList.toggle('connect-source',x.dataset.nodeId===connectFromId);});nodeSelect.value=selectedId||'';}
  function markSelectedEdges(){graph.querySelectorAll('.workflow-edge').forEach(x=>x.classList.toggle('selected',x.dataset.edgeKey===edgeKey(selectedEdge)));edgeDeleteBtn.disabled=!selectedEdge;}
  function removeWorkflowEdge(edge){const to=draft.nodes.find(n=>n.id===edge?.to);if(!to)return false;const before=(to.dependsOn||[]).length;to.dependsOn=(to.dependsOn||[]).filter(x=>x!==edge.from);return to.dependsOn.length!==before;}
  function addWorkflowEdge(from,to){if(!from||!to||from===to)return false;if(!draft.nodes.some(n=>n.id===from)||!draft.nodes.some(n=>n.id===to))return false;const target=draft.nodes.find(n=>n.id===to);target.dependsOn=target.dependsOn||[];if(target.dependsOn.includes(from))return false;target.dependsOn.push(from);return true;}
  function replaceWorkflowEdge(edge, endpoint, nextNodeId){if(!edge||!nextNodeId)return false;const next=edge&&endpoint==='from'?{from:nextNodeId,to:edge.to}:{from:edge.from,to:nextNodeId};if(next.from===next.to)return false;if(edgeKey(next)!==edgeKey(edge)&&edgeExists(next))return false;removeWorkflowEdge(edge);const ok=addWorkflowEdge(next.from,next.to);if(ok)selectedEdge=next;else addWorkflowEdge(edge.from,edge.to);return ok;}
  function nodeIdAtClientPoint(x,y){const direct=document.elementFromPoint(x,y)?.closest?.('.workflow-node-card');if(direct&&graph.contains(direct))return direct.dataset.nodeId;for(const card of graph.querySelectorAll('.workflow-node-card')){const r=card.getBoundingClientRect();if(x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom)return card.dataset.nodeId;}return '';}
  function edgeEndpointByPointer(e,fromNode,toNode){const gr=graph.getBoundingClientRect();const sx=gr.left-graph.scrollLeft+(fromNode.position?.x||0)+210,sy=gr.top-graph.scrollTop+(fromNode.position?.y||0)+45,tx=gr.left-graph.scrollLeft+(toNode.position?.x||0),ty=gr.top-graph.scrollTop+(toNode.position?.y||0)+45;const ds=Math.hypot(e.clientX-sx,e.clientY-sy),dt=Math.hypot(e.clientX-tx,e.clientY-ty);return ds<=dt?'from':'to';}
  function forkWorkflowDraft(){
    syncMeta();
    const base = draft.id || 'workflow';
    const suffix = Date.now().toString(36);
    draft.id = `${base.replace(/-copy-[a-z0-9]+$/,'')}-copy-${suffix}`.toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'');
    draft.title = t('workflow.editor.copyTitle', { title: draft.title || t('workflow.title') });
    draft.source = 'personal';
    idInput.value = draft.id; titleInput.value = draft.title; scopeSelect.value = draft.source;
    toast(t('workflow.editor.copyCreated'), 'ok');
  }
  function drawEdges(svg){
    const NS='http://www.w3.org/2000/svg'; const defs=document.createElementNS(NS,'defs'), marker=document.createElementNS(NS,'marker'); marker.setAttribute('id','wf-arrow');marker.setAttribute('markerWidth','8');marker.setAttribute('markerHeight','8');marker.setAttribute('refX','7');marker.setAttribute('refY','3');marker.setAttribute('orient','auto');const path=document.createElementNS(NS,'path');path.setAttribute('d','M0,0 L0,6 L8,3 z');marker.appendChild(path);defs.appendChild(marker);svg.appendChild(defs);
    for(const node of draft.nodes){for(const dep of node.dependsOn||[]){const from=draft.nodes.find(x=>x.id===dep);if(!from)continue;const edge={from:dep,to:node.id},x1=(from.position?.x||0)+210,y1=(from.position?.y||0)+45,x2=node.position?.x||0,y2=(node.position?.y||0)+45;const g=document.createElementNS(NS,'g');g.classList.add('workflow-edge');if(edgeKey(selectedEdge)===edgeKey(edge))g.classList.add('selected');g.dataset.from=dep;g.dataset.to=node.id;g.dataset.edgeKey=edgeKey(edge);const line=document.createElementNS(NS,'line');line.classList.add('workflow-edge-line');line.setAttribute('x1',String(x1));line.setAttribute('y1',String(y1));line.setAttribute('x2',String(x2));line.setAttribute('y2',String(y2));line.setAttribute('marker-end','url(#wf-arrow)');const hit=document.createElementNS(NS,'line');hit.classList.add('workflow-edge-hit');hit.setAttribute('x1',String(x1));hit.setAttribute('y1',String(y1));hit.setAttribute('x2',String(x2));hit.setAttribute('y2',String(y2));hit.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();selectedEdge=edge;selectedId='';resetConnectMode();markSelectedCards();markSelectedEdges();renderInspector();const endpoint=edgeEndpointByPointer(e,from,node);const sx=e.clientX,sy=e.clientY;let moved=false;hit.setPointerCapture?.(e.pointerId);const move=ev=>{if(Math.abs(ev.clientX-sx)+Math.abs(ev.clientY-sy)>4)moved=true;};const up=ev=>{hit.removeEventListener('pointermove',move);hit.removeEventListener('pointerup',up);if(moved){const targetId=nodeIdAtClientPoint(ev.clientX,ev.clientY);if(targetId&&(snapshot(),replaceWorkflowEdge(edge,endpoint,targetId))){selectedId='';renderGraph();renderInspector();toast(endpoint==='from'?t('workflow.canvas.arrowStartAdjusted'):t('workflow.canvas.arrowEndAdjusted'),'ok');}else{renderGraph();renderInspector();if(targetId)toast(t("toast.wfEdgeInvalid"),'err');}}else markSelectedEdges();};hit.addEventListener('pointermove',move);hit.addEventListener('pointerup',up);});g.append(line,hit);svg.appendChild(g);}}
  }
  // ── 编辑器 v2 基础设施：撤销栈 / 实时校验 / 模型数据源（第14波）──
  let undoStack = [];
  function snapshot(){ try { undoStack.push(structuredClone(draft.nodes)); } catch { undoStack.push(cloneWorkflow(draft.nodes)); } if (undoStack.length > 20) undoStack.shift(); }
  function undo(){ if(!undoStack.length){ toast(t("toast.wfNoUndo"),''); return; } const prev=undoStack.pop(); draft.nodes=prev; if(!draft.nodes.some(n=>n.id===selectedId)) selectedId=(draft.nodes[0]&&draft.nodes[0].id)||''; selectedEdge=null; resetConnectMode(); renderGraph(); renderInspector(); toast(t("toast.wfUndone"),'ok'); }
  const problemChip = el('button','wf-problem-chip'); problemChip.type='button'; problemChip.hidden=true; toolbar.appendChild(problemChip);
  let lastProblems=[];
  problemChip.onclick=()=>{ if(lastProblems.length) toast(t("toast.wfProblems") + '\n' + lastProblems.join('\n'), 'err'); };
  function validateDraft(){
    const nodes=draft.nodes, ids=new Set(nodes.map(n=>n.id)), problems=[], bad=new Set(), seen=new Set();
    for(const n of nodes){ if(seen.has(n.id)){ problems.push(t('workflow.canvas.duplicateNodeId')+n.id); bad.add(n.id); } seen.add(n.id); }
    for(const n of nodes){ if(!String(n.task||'').trim()){ problems.push(t('workflow.canvas.problemPrefix',{id:n.id})+t('workflow.canvas.emptyTask')); bad.add(n.id); } }
    for(const n of nodes){ for(const d of n.dependsOn||[]){ if(!ids.has(d)){ problems.push(t('workflow.canvas.problemPrefix',{id:n.id})+t('workflow.canvas.missingDep')+d+'」'); bad.add(n.id); } } }
    const color=new Map(); let cyc=false;
    const dfs=id=>{ color.set(id,1); const n=nodes.find(x=>x.id===id); for(const d of (n&&n.dependsOn||[]).filter(x=>ids.has(x))){ const c=color.get(d)||0; if(c===1){ cyc=true; bad.add(id); bad.add(d); } else if(c===0) dfs(d); } color.set(id,2); };
    for(const n of nodes){ if((color.get(n.id)||0)===0) dfs(n.id); }
    if(cyc) problems.push(t('workflow.canvas.cycleDeps'));
    return { problems, bad };
  }
  let validateTimer=null;
  function scheduleValidate(){ clearTimeout(validateTimer); validateTimer=setTimeout(()=>{ const r=validateDraft(); lastProblems=r.problems; graph.querySelectorAll('.workflow-node-card').forEach(c=>c.classList.toggle('wf-node-invalid',r.bad.has(c.dataset.nodeId))); if(r.problems.length){ problemChip.hidden=false; problemChip.textContent='⚠ '+r.problems.length+t('workflow.canvas.issueCount'); } else problemChip.hidden=true; }, 300); }
  function roleById(id){ return roles.find(r=>r.id===id)||null; }
  function engineModelOptions(eng){
    if(eng==='openai'){ const p=activeProviderObj(); return (p&&p.models||[]).map(m=>({value:m.id,label:m.label||m.id})); }
    if(eng==='claude'){ const out=[],seen=new Set(); for(const raw of (state.config.extraModels||[])){ const parts=String(raw).split('|'); const v=(parts[0]||'').trim(); if(v&&!seen.has(v)){ seen.add(v); out.push({value:v,label:(parts[1]||'').trim()||v}); } } for(const id of (state.config.knownModels||[])){ const v=String(id||'').trim(); if(v&&!seen.has(v)){ seen.add(v); out.push({value:v,label:v}); } } for(const m of ((state.status&&state.status.models)||[])){ const v=String(m.id||'').trim(); if(v&&!seen.has(v)){ seen.add(v); out.push({value:v,label:m.label||v}); } } return out; }
    return [];
  }
  function roleModelFor(roleId,eng){ const r=roleById(roleId); if(!r||!r.models) return ''; return eng==='claude' ? (r.models.claude&&r.models.claude!=='inherit'?r.models.claude:'') : (r.models.openai||''); }
  function globalModelFor(eng){ return eng==='openai' ? ((activeProviderObj()||{}).model||'') : (state.config.model||''); }
  if(modalEl) modalEl.addEventListener('keydown',e=>{ const tag=(e.target&&e.target.tagName)||''; if(/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return; if(e.key==='Delete'){ if(selectedEdge){ e.preventDefault(); edgeDeleteBtn.click(); } else if(selectedId){ e.preventDefault(); deleteBtn.click(); } } else if((e.ctrlKey||e.metaKey)&&(e.key==='z'||e.key==='Z')){ e.preventDefault(); undo(); } });
  function fitView(){ if(!draft.nodes.length) return; let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity; for(const n of draft.nodes){ const x=n.position?.x||0,y=n.position?.y||0; a=Math.min(a,x); b=Math.min(b,y); c=Math.max(c,x+210); d=Math.max(d,y+96); } const cx=(a+c)/2,cy=(b+d)/2; graph.scrollTo({left:Math.max(0,cx-graph.clientWidth/2),top:Math.max(0,cy-graph.clientHeight/2),behavior:'smooth'}); }
  function clientToCanvas(cx,cy){ const r=graph.getBoundingClientRect(); return { x:cx-r.left+graph.scrollLeft, y:cy-r.top+graph.scrollTop }; }
  function renderGraph(){ graph.textContent=''; const NS='http://www.w3.org/2000/svg',svg=document.createElementNS(NS,'svg');svg.classList.add('workflow-edges');graph.appendChild(svg);drawEdges(svg);
    for(const node of draft.nodes){const card=el('button',`workflow-node-card${node.id===selectedId?' selected':''}${node.id===connectFromId?' connect-source':''}`);card.type='button';card.dataset.nodeId=node.id;card.style.left=`${node.position?.x||0}px`;card.style.top=`${node.position?.y||0}px`;
      const head=el('div','wf-node-head');head.appendChild(el('strong','',node.id));const badge=agentEngineBadge(node.engine);if(badge)head.appendChild(badge);if(node.gate&&node.gate.mode){const gm=el('span','wf-node-gate','⚖');gm.title=t('workflow.canvas.qualityGate')+node.gate.mode;head.appendChild(gm);}card.appendChild(head);
      const _role=roleById(node.role);const _rc=_role&&_role.color?_role.color:'';if(_rc)card.style.setProperty('--wf-role-color',`var(--role-${_rc}, var(--muted))`);card.appendChild(el('span','wf-role-chip',_role?(_role.label||node.role):(node.role||t('workflow.canvas.noRole'))));
      if(node.model){const mv=el('span','wf-node-model',node.model.length>18?node.model.slice(0,18)+'…':node.model);mv.title=t('workflow.canvas.model')+node.model;card.appendChild(mv);}
      card.appendChild(el('small','',(node.dependsOn||[]).length?`${t('workflow.canvas.deps', {deps: (node.dependsOn||[]).join(', ')})}`:t('workflow.canvas.startNode')));
      const port=el('span','wf-port');port.title=t('workflow.canvas.dragHint');
      port.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();const gsvg=graph.querySelector('svg.workflow-edges');const temp=document.createElementNS(NS,'line');temp.setAttribute('class','wf-temp-edge');const x1=(node.position?.x||0)+210,y1=(node.position?.y||0)+45;temp.setAttribute('x1',x1);temp.setAttribute('y1',y1);temp.setAttribute('x2',x1);temp.setAttribute('y2',y1);if(gsvg)gsvg.appendChild(temp);port.setPointerCapture?.(e.pointerId);const move=ev=>{const p=clientToCanvas(ev.clientX,ev.clientY);temp.setAttribute('x2',p.x);temp.setAttribute('y2',p.y);};const up=ev=>{port.removeEventListener('pointermove',move);port.removeEventListener('pointerup',up);temp.remove();const targetId=nodeIdAtClientPoint(ev.clientX,ev.clientY);if(targetId&&targetId!==node.id){snapshot();if(addWorkflowEdge(node.id,targetId)){selectedEdge=null;renderGraph();renderInspector();toast(t("toast.wfEdgeAdded"),'ok');}else{undoStack.pop();toast(t("toast.wfEdgeInvalid"),'err');}}};port.addEventListener('pointermove',move);port.addEventListener('pointerup',up);});
      card.appendChild(port);
      card.addEventListener('dblclick',ev=>{ev.preventDefault();if(selectedId!==node.id)flushInspector();selectedId=node.id;selectedEdge=null;renderInspector();const t=inspector.querySelector('[data-wf-field="task"]');if(t)t.focus();});
      card.addEventListener('pointerdown',e=>{if(e.button!==0)return;if(connectFromId&&connectFromId!==node.id){snapshot();if(!(node.dependsOn||[]).includes(connectFromId))node.dependsOn=[...(node.dependsOn||[]),connectFromId];else undoStack.pop();selectedId=node.id;selectedEdge=null;resetConnectMode();syncNodeSelect();renderGraph();renderInspector();toast(t("toast.wfDepAdded"),'ok');return;}if(selectedId!==node.id)flushInspector();selectedId=node.id;selectedEdge=null;renderInspector();markSelectedCards();markSelectedEdges();const sx=e.clientX,sy=e.clientY,ox=node.position?.x||0,oy=node.position?.y||0;let moved=false;card.setPointerCapture(e.pointerId);const move=ev=>{const dx=ev.clientX-sx,dy=ev.clientY-sy;if(Math.abs(dx)+Math.abs(dy)>3){if(!moved){moved=true;snapshot();}node.position={x:Math.max(0,ox+dx),y:Math.max(0,oy+dy)};card.style.left=`${node.position.x}px`;card.style.top=`${node.position.y}px`;}};const up=()=>{card.removeEventListener('pointermove',move);card.removeEventListener('pointerup',up);if(moved)renderGraph();else{markSelectedCards();markSelectedEdges();}};card.addEventListener('pointermove',move);card.addEventListener('pointerup',up);});
      graph.appendChild(card); }
    if(!draft.nodes.length){const guide=el('div','wf-canvas-empty');guide.appendChild(el('div','wf-canvas-empty-title',t('workflow.canvas.emptyHint')));const row=el('div','wf-canvas-empty-actions');const fromTpl=el('button','mini',t('workflow.canvas.fromTemplate'));fromTpl.type='button';fromTpl.onclick=()=>{templateSelect.focus();};const addFirst=el('button','mini primary',t('workflow.canvas.addFirstNode'));addFirst.type='button';addFirst.onclick=()=>addBtn.click();row.append(fromTpl,addFirst);guide.appendChild(row);graph.appendChild(guide);}
    const controls=el('div','wf-canvas-controls');const fitBtn=el('button','mini wf-fit-btn',t('workflow.canvas.fitView'));fitBtn.type='button';fitBtn.title=t('workflow.canvas.fitViewHint');fitBtn.onclick=fitView;controls.appendChild(fitBtn);graph.appendChild(controls);
    syncNodeSelect();
    markSelectedEdges();
    scheduleValidate();
  }
  // Remap any OTHER node's reference to a node id across all three reference kinds (dependsOn, its own
  // condition, and its loop's until condition) — rename must keep all three in sync, not just dependsOn,
  // or a save is rejected server-side with no indication of which reference broke it.
  function remapWorkflowNodeRef(fromId,toId){
    for(const n of draft.nodes){
      n.dependsOn=(n.dependsOn||[]).map(x=>x===fromId?toId:x);
      if(n.condition&&n.condition.node===fromId)n.condition={...n.condition,node:toId};
      if(n.loop&&n.loop.until&&n.loop.until.node===fromId)n.loop={...n.loop,until:{...n.loop.until,node:toId}};
    }
  }
  // Clear (not remap) any OTHER node's reference to a deleted node id, across the same three kinds.
  // Returns how many condition/loop references were cleared (dependsOn silently drops — that's just a
  // graph edge — but clearing a condition changes the node's behavior, so the caller should tell the user).
  function clearWorkflowNodeRef(deadId){
    let cleared=0;
    for(const n of draft.nodes){
      n.dependsOn=(n.dependsOn||[]).filter(x=>x!==deadId);
      if(n.condition&&n.condition.node===deadId){n.condition=null;cleared++;}
      if(n.loop&&n.loop.until&&n.loop.until.node===deadId){n.loop={...n.loop,until:null};cleared++;}
    }
    return cleared;
  }
  function renderInspector(){inspector.textContent='';commitSelectedNode=null;if(selectedEdge&&!edgeExists(selectedEdge))selectedEdge=null;if(selectedEdge){const fromSel=document.createElement('select'),toSel=document.createElement('select');for(const n of draft.nodes){const a=document.createElement('option');a.value=n.id;a.textContent=n.id;fromSel.appendChild(a);const b=document.createElement('option');b.value=n.id;b.textContent=n.id;toSel.appendChild(b);}fromSel.value=selectedEdge.from;toSel.value=selectedEdge.to;const applyEdge=el('button','mini primary',t('workflow.canvas.applyArrow')),delEdge=el('button','mini danger',t('workflow.canvas.deleteArrow'));inspector.append(el('p','workflow-help',t('workflow.canvas.arrowSelected')),workflowField(t('workflow.canvas.startNodeId'),fromSel),workflowField(t('workflow.canvas.endNodeId'),toSel));applyEdge.onclick=()=>{const next={from:fromSel.value,to:toSel.value};if(next.from===next.to)return toast(t("toast.wfEdgeSelf"),'err');if(edgeKey(next)!==edgeKey(selectedEdge)&&edgeExists(next))return toast(t("toast.wfEdgeDup"),'err');snapshot();const old=selectedEdge;removeWorkflowEdge(old);if(!addWorkflowEdge(next.from,next.to)){addWorkflowEdge(old.from,old.to);return toast(t("toast.wfEdgeApplyFail"),'err');}selectedEdge=next;renderGraph();renderInspector();};delEdge.onclick=()=>{snapshot();if(removeWorkflowEdge(selectedEdge)){selectedEdge=null;renderGraph();renderInspector();toast(t("toast.wfEdgeDeleted"),'ok');}};inspector.append(applyEdge,delEdge);return;}const node=draft.nodes.find(x=>x.id===selectedId);
    if(!node){ inspector.append(el('p','muted',t('workflow.canvas.selectNode'))); return; }
    const oldId=node.id;
    // ── 身份 ──
    const nid=document.createElement('input'); nid.value=node.id;
    const task=document.createElement('textarea'); task.rows=5; task.value=node.task||''; task.dataset.wfField='task';
    const role=document.createElement('select'); { const empty=document.createElement('option'); empty.value=''; empty.textContent=t('workflow.canvas.noRole'); role.appendChild(empty); for(const r of roles){ const o=document.createElement('option'); o.value=r.id; o.textContent=r.label||r.id; role.appendChild(o); } role.value=node.role||''; }
    // ── 执行 ──
    const engine=document.createElement('select'); for(const [v,t] of [['',t('workflow.canvas.autoEngine')],['openai','OpenAI Provider'],['claude','Claude CLI']]){ const o=document.createElement('option'); o.value=v; o.textContent=t; engine.appendChild(o); } engine.value=node.engine||'';
    const model=document.createElement('select');
    const modelCustom=document.createElement('input'); modelCustom.className='wf-model-custom'; modelCustom.placeholder=t('workflow.canvas.customModelPlaceholder'); modelCustom.style.display='none';
    const modelHint=el('div','wf-model-hint');
    function currentModelChoice(){ return model.value==='__custom' ? modelCustom.value.trim() : model.value; }
    function updateModelHint(){ const eng=engine.value; if(!eng){ modelHint.textContent=t('workflow.canvas.engineAutoHint'); return; } const chosen=currentModelChoice(); if(chosen){ modelHint.textContent=t('workflow.canvas.currentEffect.node')+chosen; return; } const rm=roleModelFor(role.value,eng); if(rm){ modelHint.textContent=t('workflow.canvas.currentEffect.role')+rm; return; } const g=globalModelFor(eng); modelHint.textContent = g ? t('workflow.canvas.currentEffect.global')+g : t('workflow.canvas.currentEffect.engine'); }
    function rebuildModelOptions(resetForeign){ const eng=engine.value; const cur=node.model||''; model.textContent=''; const inh=document.createElement('option'); inh.value=''; inh.textContent=t('workflow.canvas.inherit'); model.appendChild(inh); for(const m of engineModelOptions(eng)){ const o=document.createElement('option'); o.value=m.value; o.textContent=m.label; model.appendChild(o); } const cus=document.createElement('option'); cus.value='__custom'; cus.textContent=t('common.custom'); model.appendChild(cus); if(eng===''){ model.value=''; model.disabled=true; modelCustom.style.display='none'; } else { model.disabled=false; if(!cur) model.value=''; else if([...model.options].some(o=>o.value===cur)) model.value=cur; else if(resetForeign){ model.value=''; modelCustom.value=''; } else { model.value='__custom'; modelCustom.value=cur; } modelCustom.style.display = model.value==='__custom' ? '' : 'none'; } updateModelHint(); }
    model.onchange=()=>{ modelCustom.style.display = model.value==='__custom' ? '' : 'none'; if(model.value==='__custom') modelCustom.focus(); updateModelHint(); };
    modelCustom.oninput=updateModelHint;
    engine.onchange=()=>{ rebuildModelOptions(true); };   // 对抗轮 P3: 换引擎时旧引擎模型重置为继承,不再结转为"自定义"(跨引擎必非法)
    role.onchange=updateModelHint;
    rebuildModelOptions();
    const maxIters=document.createElement('input'); maxIters.type='number'; maxIters.min='1'; maxIters.max='300'; maxIters.placeholder=t('common.default'); maxIters.value=(node.maxIters!=null&&node.maxIters!=='')?node.maxIters:'';
    const toolTier=document.createElement('select'); for(const [v,t] of [['',t('workflow.canvas.inheritRole')],['read',t('workflow.toolTier.read')],['edit',t('workflow.toolTier.edit')],['exec',t('workflow.toolTier.exec')]]){ const o=document.createElement('option'); o.value=v; o.textContent=t; toolTier.appendChild(o); } toolTier.value=node.toolTier||'';
    // ── 编排 ──
    const deps=document.createElement('select'); deps.multiple=true; deps.size=Math.min(8,Math.max(3,draft.nodes.length-1)); for(const other of draft.nodes.filter(x=>x.id!==node.id)){ const o=document.createElement('option'); o.value=other.id; o.textContent=other.id; o.selected=(node.dependsOn||[]).includes(other.id); deps.appendChild(o); }
    const condition=document.createElement('input'); condition.placeholder=t('workflow.condition.reviewVerdict'); condition.value=workflowConditionText(node.condition);
    const loopMax=document.createElement('input'); loopMax.type='number'; loopMax.min='1'; loopMax.max='20'; loopMax.value=node.loop?.maxIterations||1;
    const loopUntil=document.createElement('input'); loopUntil.placeholder=t('workflow.condition.loopDone'); loopUntil.value=workflowConditionText(node.loop?.until);
    const progressPath=document.createElement('input'); progressPath.placeholder=t('workflow.condition.progressPath'); progressPath.value=node.loop?.progressPath||'';
    const noProgress=document.createElement('input'); noProgress.type='number'; noProgress.min='1'; noProgress.max='10'; noProgress.value=node.loop?.noProgressLimit||2;
    // ── 质量 ──
    const gate=document.createElement('select'); for(const [v,t] of [['',t('workflow.gate.none')],['review',t('workflow.gate.review')],['verify',t('workflow.gate.verify')],['vote',t('workflow.gate.vote')],['cross_review',t('workflow.gate.crossReview')],['dedupe',t('workflow.gate.dedupe')]]){ const o=document.createElement('option'); o.value=v; o.textContent=t; gate.appendChild(o); } gate.value=(node.gate&&node.gate.mode)||'';
    const failure=document.createElement('select'); for(const [v,t] of [['block',t('workflow.failurePolicy.block')],['continue',t('workflow.failurePolicy.continue')],['retry',t('workflow.failurePolicy.retry')]]){ const o=document.createElement('option'); o.value=v; o.textContent=t; failure.appendChild(o); } failure.value=node.failurePolicy||'block';
    const dependencyPolicy=document.createElement('select'); for(const [v,t] of [['all_success',t('workflow.depPolicy.allSuccess')],['all_settled',t('workflow.depPolicy.allSettled')]]){ const o=document.createElement('option'); o.value=v; o.textContent=t; dependencyPolicy.appendChild(o); } dependencyPolicy.value=node.dependencyPolicy||'all_success';
    const maxRetries=document.createElement('input'); maxRetries.type='number'; maxRetries.min='1'; maxRetries.max='5'; maxRetries.value=node.maxRetries||1;
    const minToolEvidence=document.createElement('input'); minToolEvidence.type='number'; minToolEvidence.min='0'; minToolEvidence.max='20'; minToolEvidence.value=node.minSuccessfulToolCalls||0;
    // ── 高级 JSON ──
    const adv=el('details','wf-insp-advanced'); adv.appendChild(el('summary','',t('workflow.advancedJson'))); const advTa=document.createElement('textarea'); advTa.className='wf-adv-json'; advTa.rows=8; advTa.spellcheck=false; advTa.value=JSON.stringify(node,null,2); const advApply=el('button','mini',t('workflow.applyJson')); advApply.type='button'; adv.append(workflowField(t('workflow.fullNodeJson'),advTa),advApply);
    advApply.onclick=()=>{ let parsed; try{ parsed=JSON.parse(advTa.value); }catch(err){ return toast(t("toast.wfJsonParseFail", { p1: err.message }), 'err'); } if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)) return toast(t("toast.wfJsonNotObject"),'err'); const nextId=String(parsed.id||'').trim(); if(!/^[A-Za-z0-9_-]+$/.test(nextId)) return toast(t("toast.wfJsonIdIllegal"),'err'); if(nextId!==oldId&&draft.nodes.some(x=>x.id===nextId)) return toast(t("toast.wfJsonIdDup"),'err'); snapshot(); for(const k of Object.keys(node)) delete node[k]; Object.assign(node,parsed); node.id=nextId; if(nextId!==oldId) remapWorkflowNodeRef(oldId,nextId); selectedId=nextId; renderGraph(); renderInspector(); toast(t("toast.wfJsonApplied"),'ok'); };
    // ── 分组装配（身份 / 执行 / 编排 / 质量）──
    const group=(title,...items)=>{ const g=el('div','wf-insp-group'); g.appendChild(el('div','wf-insp-group-title',title)); for(const it of items) if(it) g.appendChild(it); return g; };
    const modelField=workflowField(t('workflow.nodeModel'),model); modelField.append(modelCustom,modelHint);
    inspector.append(
      group(t('workflow.nodeIdentity'), workflowField(t('workflow.nodeId'),nid), workflowField(t('workflow.nodeTask'),task), workflowField(t('workflow.nodeRole'),role)),
      group(t('workflow.nodeExecution'), workflowField(t('workflow.nodeEngine'),engine), modelField, workflowField(t('workflow.nodeMaxIters'),maxIters), workflowField(t('workflow.nodeToolTier'),toolTier)),
      group(t('workflow.nodeOrchestration'), workflowField(t('workflow.nodeDependsOn'),deps), el('div','workflow-help',t('workflow.nodeDependsOnHint')), workflowField(t('workflow.nodeDependencyPolicy'),dependencyPolicy), workflowField(t('workflow.nodeCondition'),condition), workflowField(t('workflow.nodeLoopMax'),loopMax), workflowField(t('workflow.nodeLoopUntil'),loopUntil), workflowField(t('workflow.nodeProgressPath'),progressPath), el('div','workflow-help',t('workflow.nodeProgressPathHint')), workflowField(t('workflow.nodeNoProgressLimit'),noProgress)),
      group(t('workflow.nodeQuality'), workflowField(t('workflow.nodeGate'),gate), el('div','workflow-help',t('workflow.nodeGateHint')), workflowField(t('workflow.nodeFailurePolicy'),failure), workflowField(t('workflow.nodeMinToolCalls'),minToolEvidence), workflowField(t('workflow.nodeMaxRetries'),maxRetries)),
      adv
    );
    const apply=el('button','primary wf-apply',t('workflow.applyNodeSettings'));
    const doApplyNode=()=>{
      // Validate EVERYTHING first — nothing on `node`/`draft` is written until every field parses.
      const nextId=nid.value.trim();
      if(!/^[A-Za-z0-9_-]+$/.test(nextId)){ toast(t("toast.wfIdCharset"),'err'); return false; }
      if(nextId!==oldId&&draft.nodes.some(x=>x.id===nextId)){ toast(t("toast.wfIdDup"),'err'); return false; }
      const nextDependsOn=[...deps.selectedOptions].map(x=>x.value).filter(x=>x&&x!==nextId);
      const nextCondition=parseWorkflowConditionText(condition.value);
      if(condition.value.trim()&&!nextCondition){ toast(t("toast.wfCondInvalid"),'err'); return false; }
      const lm=Math.max(1,Number(loopMax.value)||1);
      const nextUntil=parseWorkflowConditionText(loopUntil.value);
      if(loopUntil.value.trim()&&!nextUntil){ toast(t("toast.wfLoopCondInvalid"),'err'); return false; }
      const mi=maxIters.value.trim();
      const modelVal=currentModelChoice();
      // All parsed OK — snapshot then commit.
      snapshot();
      if(nextCondition?.node&&nextCondition.node!==nextId&&!nextDependsOn.includes(nextCondition.node)) nextDependsOn.push(nextCondition.node);
      const nextLoop=lm>1?{maxIterations:lm,until:nextUntil,progressPath:progressPath.value.trim(),noProgressLimit:Math.max(1,Number(noProgress.value)||2),onNoProgress:'continue'}:null;
      node.id=nextId; node.task=task.value.trim(); node.role=role.value; node.engine=engine.value;
      node.model = engine.value ? modelVal : '';
      node.dependsOn=nextDependsOn; node.failurePolicy=failure.value;
      node.dependencyPolicy=dependencyPolicy.value;
      node.minSuccessfulToolCalls=Math.max(0,Math.min(20,Math.round(Number(minToolEvidence.value)||0)));
      node.maxRetries=failure.value==='retry'?Math.max(1,Math.min(5,Math.round(Number(maxRetries.value)||1))):0;
      node.condition=nextCondition; node.loop=nextLoop;
      node.gate = gate.value ? { ...(node.gate&&typeof node.gate==='object'?node.gate:{}), mode:gate.value } : false;   // 对抗轮 P2: 显式 false=明确无门(null 会被服务端按 reviewer/verifier 角色回填)
      if(mi) node.maxIters=Math.max(1,Math.min(300,Math.round(Number(mi)||100))); else delete node.maxIters;
      if(toolTier.value) node.toolTier=toolTier.value; else delete node.toolTier;
      if(nextId!==oldId) remapWorkflowNodeRef(oldId,nextId);
      selectedId=nextId; renderGraph(); renderInspector();
      return true;
    };
    apply.onclick=doApplyNode; commitSelectedNode=doApplyNode;
    inspector.appendChild(apply);
  }
  loadBtn.onclick=()=>{const wf=agentWorkflowLibrary.find(x=>x.id===templateSelect.value);if(!wf)return;undoStack.length=0;draft=cloneWorkflow(wf);draft.source=wf.source==='project'?'project':'personal';idInput.value=draft.id;titleInput.value=draft.title;descInput.value=draft.description||'';scopeSelect.value=draft.source;selectedId=draft.nodes[0]?.id;selectedEdge=null;resetConnectMode();renderGraph();renderInspector();toast(t('workflow.editor.loaded'),'');};
  blankBtn.onclick=()=>{undoStack.length=0;draft=workflowBlank();idInput.value=draft.id;titleInput.value=draft.title;descInput.value=draft.description||'';scopeSelect.value=draft.source;selectedId=draft.nodes[0]?.id;selectedEdge=null;resetConnectMode();renderGraph();renderInspector();toast(t('workflow.editor.blankCreated'),'ok');};
  forkBtn.onclick=()=>{undoStack.length=0;selectedEdge=null;forkWorkflowDraft();renderGraph();renderInspector();};
  nodeSelect.onchange=()=>{if(selectedId!==nodeSelect.value)flushInspector();selectedId=nodeSelect.value;selectedEdge=null;renderGraph();renderInspector();};
  connectBtn.onclick=()=>{if(connectFromId){resetConnectMode();markSelectedCards();return;}selectedEdge=null;connectFromId=selectedId||draft.nodes[0]?.id||'';connectBtn.textContent=t('common.cancel');markSelectedCards();markSelectedEdges();toast(t('workflow.editor.connectHint'),'');};
  edgeDeleteBtn.onclick=()=>{if(!selectedEdge)return;snapshot();if(removeWorkflowEdge(selectedEdge)){selectedEdge=null;renderGraph();renderInspector();toast(t('workflow.editor.edgeDeleted'),'ok');}};
  maxBtn.onclick=()=>{const on=modalEl?.classList.toggle('workflow-fullscreen');maxBtn.textContent=on?'❐':'□';maxBtn.title=on?t('workflow.editor.restore'):t('workflow.editor.maximize');maxBtn.setAttribute('aria-label',on?t('workflow.editor.restore'):t('workflow.editor.maximize'));setTimeout(()=>{renderGraph();renderInspector();},0);};
  addBtn.onclick=()=>{flushInspector();snapshot();let i=draft.nodes.length+1,id=`step_${i}`;while(draft.nodes.some(x=>x.id===id))id=`step_${++i}`;draft.nodes.push({id,task:t('workflow.describeTask'),role:'worker',dependsOn:[],failurePolicy:'block',position:{x:60+(i%3)*250,y:80+Math.floor(i/3)*150}});selectedId=id;selectedEdge=null;resetConnectMode();renderGraph();renderInspector();};
  deleteBtn.onclick=()=>{
    if(draft.nodes.length<=1)return toast(t("toast.wfKeepOne"),'err');
    if(!confirm(`删除节点「${selectedId}」？其依赖它的运行条件/循环停止条件将被清除（可用 Ctrl+Z 撤销）。`))return;   // 对抗轮 P3: 原文案称"不可撤销"与 snapshot/undo 实现矛盾
    snapshot();const deadId=selectedId;
    draft.nodes=draft.nodes.filter(x=>x.id!==deadId);
    const cleared=clearWorkflowNodeRef(deadId);
    selectedId=draft.nodes[0]?.id;selectedEdge=null;resetConnectMode();renderGraph();renderInspector();
    if(cleared)toast(t("toast.wfNodeDeleted", { p1: cleared }),'');
  };
  async function saveDraft(){if(commitSelectedNode){const okc=commitSelectedNode();if(okc===false){const err=new Error(t('workflow.invalidFields'));err.__quiet=true;throw err;}}syncMeta();const r=await api('/api/agent-workflows',{method:'POST',body:JSON.stringify({scope:draft.source,cwd:currentWorkspace(),workflow:draft})});if(!r.ok)throw new Error(r.error||t('workflow.saveFailed'));draft=cloneWorkflow(r.workflow);await loadAgentWorkflows();return draft;}
  cancel.onclick=()=>modal.close();save.onclick=async()=>{try{await saveDraft();toast(t('workflow.editor.saved'),'ok');modal.close();}catch(e){if(!e||!e.__quiet)toast(apiErrText(e),'err');}};run.onclick=async()=>{try{const wf=await saveDraft();modal.close();await launchAgentWorkflow(wf);}catch(e){if(!e||!e.__quiet)toast(apiErrText(e),'err');}};remove.onclick=async()=>{syncMeta();if(draft.source==='builtin')return toast(t('workflow.editor.builtinCannotDelete'),'err');if(!confirm(t('workflow.editor.delete.confirm',{title:draft.title||draft.id})))return;try{const r=await api(`/api/agent-workflows/${encodeURIComponent(draft.id)}`,{method:'POST',headers:{'x-http-method':'DELETE'},body:JSON.stringify({scope:draft.source,cwd:currentWorkspace()})});await loadAgentWorkflows();if(r&&r.ok===false){toast(t('workflow.editor.delete.none'),'err');}else{toast(t('workflow.editor.deleted'),'ok');modal.close();}}catch(e){toast(apiErrText(e),'err');}};
  renderGraph();renderInspector();
}

let agentRunsPoll = null;
const agentRunSummarySeen = new Set();
// 团队模式 v2: waiting_pool(收尾宽限窗,等待任务池审批)是活跃 live 态,并入 ACTIVE 集(卡片自动展开、不当作已完成)。
const AGENT_RUN_ACTIVE = new Set(['running', 'paused', 'waiting_pool']);
function agentRunStatusLabel(status) {
  return t('workflow.node.status.' + status) || status || t('common.unknown');
}
// 团队模式 v2 (A4): 任务池提案状态人话标签。
function poolStatusLabel(s) { return t('workflow.pool.status.' + s) || s || ''; } // 第50波 i18n
// 团队模式 v2 (A4): 审批/拒绝一条任务池提案 → POST pool_approve/pool_reject（服务器要求 run 仍 live 且未收尾）。
async function poolDecide(runId, poolId, approve) {
  const sid = state.currentSession?.id; if (!sid) return;
  try {
    const r = await api(`/api/agent-runs/${encodeURIComponent(runId)}`, { method: 'POST', body: JSON.stringify({ sessionId: sid, action: approve ? 'pool_approve' : 'pool_reject', poolId }) });
    if (!r || !r.ok) throw new Error((r && r.error) || t('workflow.operationFailed'));
    toast(approve ? t('workflow.pool.approvedToast') : t('workflow.pool.rejectedToast'), 'ok');
    await loadAgentRuns(true); // 29a: 动作后强制全量(审批物化的新节点等不靠事件推断,直接拉权威快照)
  } catch (e) { toast(t('workflow.pool.err', { err: apiErrText(e) }), 'err'); }
}
// v1.5 运行监控：展示态状态语义。把「质量门判否」从「执行失败」里分出来——后端可能已直接发 'rejected'，也可能
// 仍发 'failed' 但带 gateVerdict/structuredResult.verdict==='fail'。两种都归一到 rejected（琥珀，语义=「发现问题
// ≠崩了」），条件下游据此评估而非阻塞。defensive：后端没发 rejected 也不崩，退化为 failed。
function nodeDisplayStatus(node) {
  const s = (node && node.status) || 'unknown';
  if (s === 'rejected') return 'rejected';
  if (s === 'failed') {
    const verdict = (node && node.gateVerdict) || (node && node.structuredResult && node.structuredResult.verdict);
    if (verdict && String(verdict).toLowerCase() === 'fail') return 'rejected';
  }
  if (s === 'succeeded' && node && node.degraded) return 'degraded';
  return s;
}
// 状态徽标图标（符号，不含色；颜色由 CSS 的 .st-<status> 语义 token 驱动，不硬编码）。
const AGENT_STATUS_ICON = { queued: '○', running: '◐', succeeded: '✓', failed: '✗', rejected: '⚑', skipped: '↷', waiting_resource: '⏸', blocked: '⊘', cancelled: '⏹', stopped: '⏹', interrupted: '⚠', degraded: '⚠', paused: '⏸', partial: '◑' };
function agentStatusIcon(s) { return AGENT_STATUS_ICON[s] || '○'; }
// 毫秒 → mm:ss / h:mm:ss（运行时长/节点计时用；2s 轮询即刷新，无需秒级 ticker）。
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.floor(ms / 1000), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
// run 已运行/总时长（live 用 now，历史用 completedAt/updatedAt）。
function runElapsedMs(run) {
  const start = run && run.createdAt ? Date.parse(run.createdAt) : NaN;
  if (!Number.isFinite(start)) return 0;
  const end = run.live ? Date.now() : (run.completedAt ? Date.parse(run.completedAt) : (run.updatedAt ? Date.parse(run.updatedAt) : Date.now()));
  return Number.isFinite(end) ? Math.max(0, end - start) : 0;
}
// 累计 token/成本聚合（defensive：字段可能不存在——后端并行落地中——此时返回 '' 不显示 chip）。
function runCostLabel(run) {
  const u = (run && (run.usage || run.usageTotals)) || null;
  const tok = (u && (Number(u.input_tokens || 0) + Number(u.output_tokens || 0))) || Number((run && run.totalTokens) || 0) || 0;
  const cost = Number(run && run.costUsd != null ? run.costUsd : run && run.totalCostUsd != null ? run.totalCostUsd : (u && u.costUsd) || 0) || 0;
  const parts = [];
  if (tok) parts.push(`${fmtTokens(tok)} tok`);
  if (cost) parts.push(`$${cost.toFixed(cost < 1 ? 4 : 2)}`);
  return parts.join(' · ');
}
// 引擎徽标：Claude=青花蓝(--accent)、Provider=釉里红/赭(--wf-provider)，双色区分（§3.2）。engine 为空则不渲染。
function agentEngineBadge(engine) {
  if (engine === 'claude') return el('span', 'wf-engine-badge eng-claude', 'Claude');
  if (engine === 'openai') return el('span', 'wf-engine-badge eng-provider', 'Provider');
  return null;
}
async function agentRunAction(runId, action, extra) {
  const sid = state.currentSession?.id; if (!sid) return;
  try {
    const r = await api(`/api/agent-runs/${encodeURIComponent(runId)}`, { method: 'POST', body: JSON.stringify({ sessionId: sid, action, ...(extra || {}) }) });
    if (!r.ok) throw new Error(r.error || t('workflow.operationFailed'));
    toast(t("toast.wfActionSubmitted"), 'ok'); await loadAgentRuns(true); // 29a: 动作后强制全量(apply_isolation 等冷路径不发事件)
  } catch (e) { toast(t("toast.wfError", { p1: apiErrText(e) }), 'err'); }
}
// 定向插话（steer 到指定运行中子代理节点）：Provider 在下一次 API 调用前注入，Claude 通过其持续
// stream-json stdin 通道注入。prompt() 取文本（与现有 confirm 风格一致，不引入新组件）；成功后刷新
// 运行列表让「插话」里程碑尽快显现。失败用 apiErrText 提示。
// v3 P3b:presetText 提供时走内联提交（工作台右板段1 的插话框直接传输入值，不弹 prompt）；不提供时保留原
// prompt() 交互（右栏 agent-runs tab 的「插话」按钮仍是 3 参调用）。两条路径共用同一 steer_node action 与 toast。
async function steerAgentNode(runId, nodeId, nodeStatus, presetText, engine) {
  const sid = state.currentSession?.id; if (!sid) return;
  const hint = `对节点 ${nodeId} 插话（运行中节点会立即接收，排队节点在启动时接收）：`;
  const text = (presetText != null ? presetText : (prompt(hint) || '')).trim();
  if (!text) return;
  try {
    const r = await api(`/api/agent-runs/${encodeURIComponent(runId)}`, { method: 'POST', body: JSON.stringify({ sessionId: sid, action: 'steer_node', nodeId, text }) });
    if (!r || !r.ok) throw new Error(r?.error ? apiErrText(r.error) : t('workflow.injectFailed'));
    // running 节点在下一次迭代边界（下一次模型调用前）就会消费队列；queued/waiting_resource 节点要等它真正
    // 开跑才会消费——如果节点在那之前被跳过/阻塞/工作流停止，排队的插话会被直接丢弃，成功提示要如实区分这两种情况。
    const msg = nodeStatus === 'running' ? t('workflow.injectImmediate') : t('workflow.injectQueued');
    toast(msg, 'ok');
    await loadAgentRuns(true);
    return true;
  } catch (e) { toast(t("toast.steerFail", { p1: apiErrText(e) }), 'err'); return false; }   // 对抗轮 P2: 调用方按返回值区分失败以回填文本
}
async function deleteAgentRun(runId) {
  const sid = state.currentSession?.id; if (!sid || !confirm(t('workflow.deleteConfirm'))) return;
  try { await api(`/api/agent-runs/${encodeURIComponent(runId)}?sessionId=${encodeURIComponent(sid)}`, { method: 'DELETE' }); await loadAgentRuns(true); }
  catch (e) { toast(t("toast.deleteFail", { p1: apiErrText(e) }), 'err'); }
}
// v1.5 运行监控重设计（§2 多 Agent 编排实时监控）：把纵向 <details> 列表升级为「聚合头 + 状态徽标节点卡」的
// 实时监控。数据仍来自 /api/agent-runs 的 2s 轮询（协议不变）。所有不可信内容一律 el()/textContent 渲染，
// 绝不 innerHTML 拼接。保留 .agent-run-card/.agent-node 基类与 data-* 以复用展开态保存逻辑。
// v3 (§2.9 P2):宽限窗进度条的客户端窗宽提示(与服务端 POOL_GRACE_MS 默认 60s 对齐;env 覆写时条比例近似)。
const POOL_GRACE_HINT_MS = 60000;
const {
  bindWorkbench,
  isWorkbenchCanvasView,
  markWorkbenchConnectionLost,
  restoreMainView,
  wbNativeClaudeFinalize,
  wbNativeClaudeOnSubagent,
  wbOnRuns,
} = createWorkbenchDomain({
  agentRunActive: AGENT_RUN_ACTIVE,
  poolGraceHintMs: POOL_GRACE_HINT_MS,
  getActiveTurn: sessionId => activeTurns.get(sessionId),
  agentRunStatusLabel,
  poolStatusLabel,
  poolDecide,
  nodeDisplayStatus,
  agentStatusIcon,
  fmtDuration,
  runElapsedMs,
  agentEngineBadge,
  agentRunAction,
  steerAgentNode,
  openToolPane,
  switchTab,
  syncAgentRunsPolling,
  scheduleRender,
});
function renderAgentRuns(runs) {
  const host = $('agentRunsList'); if (!host) return;
  const knownRuns = new Set([...host.querySelectorAll('.agent-run-card')].map(x => x.dataset.runId).filter(Boolean));
  const openRuns = new Set([...host.querySelectorAll('.agent-run-card[open]')].map(x => x.dataset.runId).filter(Boolean));
  const knownNodes = new Set([...host.querySelectorAll('.agent-node')].map(x => `${x.dataset.runId}:${x.dataset.nodeId}`).filter(Boolean));
  const openNodes = new Set([...host.querySelectorAll('.agent-node[open]')].map(x => `${x.dataset.runId}:${x.dataset.nodeId}`).filter(Boolean));
  host.textContent = '';
  if (!runs.length) { host.appendChild(el('div', 'muted', t('workflow.empty'))); return; }
  for (const run of runs) {
    const card = el('details', `agent-run-card ar-${run.status || 'unknown'}`); card.dataset.runId = run.id; card.open = knownRuns.has(run.id) ? openRuns.has(run.id) : (AGENT_RUN_ACTIVE.has(run.status) || run.status === 'interrupted');
    const nodes = Array.isArray(run.nodes) ? run.nodes : [];
    const done = nodes.filter(n => n.status === 'succeeded' || n.status === 'skipped').length;
    // ── 聚合头（§2.7）：状态 chip + 已运行时长 + 节点 done/total +（若有）累计 token/成本 ──
    const sum = el('summary', 'agent-run-head');
    sum.appendChild(el('span', 'ar-title', `🕸️ ${run.id}`));
    const agg = el('div', 'ar-agg');
    agg.appendChild(el('span', `ar-agg-chip st-${run.status || 'unknown'}`, agentRunStatusLabel(run.status)));
    // 29b: 恢复分级徽章 —— 只在等人/等续跑的档位(interrupted/paused)显示,终态与运行中不挂。
    if ((run.status === 'interrupted' || run.status === 'paused') && run.resumeTier === 'manual_resume_required') agg.appendChild(el('span', 'ar-agg-chip st-interrupted', t('workflow.resumeManual')));
    else if (run.status === 'interrupted' && run.resumeTier === 'auto_resumable') agg.appendChild(el('span', 'ar-agg-chip st-queued', t('workflow.resumeAutomatic')));
    agg.appendChild(el('span', 'ar-agg-nodes', t('workflow.nodes', { done, total: nodes.length })));
    const elapsed = runElapsedMs(run); if (elapsed) agg.appendChild(el('span', 'ar-agg-time', t(run.live ? 'workflow.elapsed' : 'workflow.duration', { duration: fmtDuration(elapsed) })));
    const cost = runCostLabel(run); if (cost) agg.appendChild(el('span', 'ar-agg-cost', cost));
    sum.appendChild(agg);
    // v3 (§2.9 P2):当前活动行提升到聚合头 —— 收起态也能看到「现在谁在干嘛」。取运行中节点 progressLog 末条。
    if (run.live) {
      const runningNode = nodes.find(n => n.status === 'running');
      const rlog = runningNode && Array.isArray(runningNode.progressLog) ? runningNode.progressLog : [];
      const rlast = rlog.length ? rlog[rlog.length - 1] : null;
      if (runningNode && rlast && rlast.text) {
        const live = el('div', 'ar-agg-live');
        live.appendChild(el('span', 'ar-agg-live-dot'));
        live.appendChild(el('span', 'ar-agg-live-text num', `${runningNode.id}：${rlast.text}`));
        sum.appendChild(live);
      }
    }
    card.appendChild(sum);
    // ── 停滞/失败横幅（§2.5）：run.idleAborted 或有节点在资源上等待且有 blocker → 琥珀横幅 + [查看][停止] ──
    // 第25波 25.2: persistenceDegraded(快照连续写失败,经 live 叠加下发)并入同一横幅——持久化失败不得静默。
    const waitingBlocked = nodes.filter(n => nodeDisplayStatus(n) === 'waiting_resource' && Array.isArray(n.resourceBlockers) && n.resourceBlockers.length);
    if (run.persistenceDegraded || run.idleAborted || (run.live && waitingBlocked.length)) {
      const banner = el('div', 'wf-stall-banner'); banner.setAttribute('role', 'alert');
      const stallMsg = run.persistenceDegraded ? t('workflow.stall.persistence')
        : run.idleAborted ? t('workflow.stall.idle') : t('workflow.stall.waiting', { count: waitingBlocked.length });
      banner.append(el('span', 'wf-stall-icon', '⚠'), el('span', 'wf-stall-text', stallMsg));
      const stallActions = el('div', 'wf-stall-actions');
      const view = el('button', 'mini', t('workflow.view')); view.setAttribute('aria-label', t('workflow.viewStalled'));
      view.onclick = () => {
        const target = waitingBlocked[0] || nodes.find(n => n.status !== 'succeeded' && n.status !== 'skipped');
        if (target) { const rowEl = card.querySelector(`.agent-node[data-node-id="${CSS.escape(target.id)}"]`); if (rowEl) { rowEl.open = true; rowEl.scrollIntoView({ block: 'nearest' }); } }
      };
      stallActions.appendChild(view);
      if (run.live) { const stop = el('button', 'mini danger', t('workflow.stop')); stop.setAttribute('aria-label', t('workflow.stop')); stop.onclick = () => agentRunAction(run.id, 'stop'); stallActions.appendChild(stop); }
      banner.appendChild(stallActions);
      card.appendChild(banner);
    }
    // ── 运行控制（§5.3 失败一键处置）：运行中=暂停/继续/停止；已结束未完成=恢复；结束=删除记录。wire 到 POST
    //    /api/agent-runs/:id（action: pause/resume/stop）。按钮均带 aria-label。 ──
    const controls = el('div', 'agent-run-controls');
    if (run.live && !run.paused) {
      const pause = el('button', 'mini', t('workflow.pause')); pause.setAttribute('aria-label', t('workflow.pause')); pause.onclick = () => agentRunAction(run.id, 'pause'); controls.appendChild(pause);
      const stop = el('button', 'mini danger', t('workflow.stop')); stop.setAttribute('aria-label', t('workflow.stop')); stop.onclick = () => agentRunAction(run.id, 'stop'); controls.appendChild(stop);
    } else if (run.live && run.paused) {
      const resume = el('button', 'mini primary', t('workflow.resume')); resume.setAttribute('aria-label', t('workflow.resume')); resume.onclick = () => agentRunAction(run.id, 'resume'); controls.appendChild(resume);
      const stop = el('button', 'mini danger', t('workflow.stop')); stop.setAttribute('aria-label', t('workflow.stop')); stop.onclick = () => agentRunAction(run.id, 'stop'); controls.appendChild(stop);
    } else if (run.status !== 'succeeded') {
      const resume = el('button', 'mini primary', t('workflow.resumeIncomplete')); resume.setAttribute('aria-label', t('workflow.resumeIncompleteAria')); resume.onclick = () => agentRunAction(run.id, 'resume'); controls.appendChild(resume);
    }
    if (!run.live) { const del = el('button', 'mini', t('workflow.deleteRecord')); del.setAttribute('aria-label', t('workflow.deleteRecordAria')); del.onclick = () => deleteAgentRun(run.id); controls.appendChild(del); }
    card.appendChild(controls);
    if (run.summary) card.appendChild(el('pre', 'agent-run-summary', run.summary));
    // ── 团队模式 v2 (A4) 共享任务池分区：simple 模式仅当有 proposed 时浮出「待批准的新任务 N」徽标+审批卡；pro 模式
    //    常驻全状态列表。审批卡三行人话（谁提议/做什么≤60字/预计消耗）+「同意添加 / 不用了」→ POST pool_approve/reject。
    //    waiting_pool（宽限窗）显示剩余秒数。所有文本走 el()/textContent（XSS 安全，绝不 innerHTML）。 ──
    const pool = Array.isArray(run.taskPool) ? run.taskPool : [];
    const proposedItems = pool.filter(p => p && p.status === 'proposed');
    const simpleMode = document.documentElement.getAttribute('data-ui-mode') === 'simple';
    if (pool.length && (proposedItems.length || !simpleMode)) {
      const section = el('div', 'pool-section');
      const ptitle = el('div', 'pool-title');
      ptitle.appendChild(el('span', 'pool-title-text', t('workflow.pool.title')));
      if (proposedItems.length) ptitle.appendChild(el('span', 'pool-badge', t('workflow.pool.pending', { count: proposedItems.length })));
      section.appendChild(ptitle);
      if (run.status === 'waiting_pool' && run.live) {
        // v3 (§2.9 P2):宽限窗倒计时改细进度条(发丝倒计时)替代纯秒数文字。
        const remainMs = run.poolGraceUntil ? Math.max(0, Number(run.poolGraceUntil) - Date.now()) : 0;
        const grace = el('div', 'pool-grace');
        const bar = el('div', 'pool-grace-bar'); const fill = el('i');
        fill.style.width = `${Math.max(0, Math.min(100, Math.round((remainMs / POOL_GRACE_HINT_MS) * 100)))}%`;
        bar.appendChild(fill); grace.appendChild(bar);
        grace.appendChild(el('span', 'pool-grace-label num', t('workflow.pool.waitingApproval', { seconds: Math.round(remainMs / 1000) })));
        section.appendChild(grace);
      }
      const listItems = simpleMode ? proposedItems : pool;
      for (const item of listItems) {
        const pcard = el('div', `pool-card ps-${item.status || 'proposed'}`);
        const whoNode = (run.nodes || []).find(n => n.id === item.proposedBy);
        const whoLabel = whoNode ? (whoNode.roleLabel || whoNode.id) : (item.proposedBy || t('workflow.pool.unknownNode'));
        pcard.appendChild(el('div', 'pool-line pool-who', t('workflow.pool.proposedBy', { name: whoLabel })));
        // 团队模式 v2 (P3-6): pro 模式渲染 task 全文(完整可读);simple 模式截 60 字并把全文挂 title 属性(hover tooltip 看全文)。
        const taskFull = String(item.task || '').trim();
        const taskShort = taskFull.replace(/\s+/g, ' ').slice(0, 60);
        const whatLine = el('div', 'pool-line pool-what', t('workflow.pool.task', { task: simpleMode ? taskShort : taskFull }));
        if (simpleMode && taskFull.replace(/\s+/g, ' ').length > taskShort.length) whatLine.title = taskFull;
        pcard.appendChild(whatLine);
        pcard.appendChild(el('div', 'pool-line pool-cost', t('workflow.pool.cost', { maxIters: item.maxIters || 100 })));
        if (!simpleMode && item.reason) pcard.appendChild(el('div', 'pool-line pool-reason', t('workflow.pool.reasonLabel', { reason: item.reason })));
        if (!simpleMode && item.status !== 'proposed') pcard.appendChild(el('div', 'pool-line pool-status', t('workflow.pool.statusLabel', { status: poolStatusLabel(item.status) }) + (item.resultNodeId ? ' · ' + t('workflow.pool.node', { id: item.resultNodeId }) : '')));
        if (item.status === 'proposed' && run.live) {
          const pactions = el('div', 'pool-actions');
          const yes = el('button', 'mini primary', t('workflow.pool.approve')); yes.setAttribute('aria-label', t('workflow.pool.approveAria')); yes.onclick = () => poolDecide(run.id, item.id, true);
          const no = el('button', 'mini', t('workflow.pool.reject')); no.setAttribute('aria-label', t('workflow.pool.rejectAria')); no.onclick = () => poolDecide(run.id, item.id, false);
          pactions.append(yes, no);
          pcard.appendChild(pactions);
        }
        section.appendChild(pcard);
      }
      card.appendChild(section);
    }
    const graph = el('div', 'agent-run-graph');
    for (const node of nodes) {
      const disp = nodeDisplayStatus(node);
      const row = el('details', `agent-node wf-node an-${disp}`); row.dataset.runId = run.id; row.dataset.nodeId = node.id;
      const nodeKey = `${run.id}:${node.id}`; row.open = knownNodes.has(nodeKey) ? openNodes.has(nodeKey) : ['running', 'waiting_resource', 'failed', 'rejected', 'blocked'].includes(disp);
      // ── 节点卡头（§2.3）：状态徽标 + 标题(id·角色) + 引擎徽标 + 状态文案 ──
      const head = el('summary', 'agent-node-head wf-node-head');
      head.appendChild(el('span', `wf-status-badge st-${disp}`, agentStatusIcon(disp)));
      const titleWrap = el('span', 'wf-node-title');
      titleWrap.appendChild(el('span', 'wf-node-id', node.id));
      if (node.roleLabel || node.roleId) titleWrap.appendChild(el('span', 'wf-node-role', node.roleLabel || node.roleId));
      head.appendChild(titleWrap);
      const engBadge = agentEngineBadge(node.engine); if (engBadge) head.appendChild(engBadge);
      head.appendChild(el('span', 'wf-node-status-label', agentRunStatusLabel(disp)));
      row.appendChild(head);
      const body = el('div', 'agent-node-body');
      // 元信息条：依赖 / 门 / 失败策略 / 尝试次数。
      const metaBits = [];
      if (Array.isArray(node.dependsOn) && node.dependsOn.length) metaBits.push(t('workflow.meta.deps', { deps: node.dependsOn.join(', ') }));
      if (node.gate && node.gate.mode) metaBits.push(t('workflow.meta.gate', { mode: node.gate.mode }));
      if (node.failurePolicy) metaBits.push(t('workflow.meta.failure', { policy: node.failurePolicy }));
      if (node.loopStopReason) metaBits.push(t('workflow.meta.loopStop', { reason: node.loopStopReason }));
      metaBits.push(t('workflow.meta.attempts', { n: node.attempts || 0 }));
      const meta = el('div', 'wf-node-meta'); for (const bit of metaBits) meta.appendChild(el('span', 'wf-meta-chip', bit)); body.appendChild(meta);
      body.appendChild(el('div', 'agent-node-task', node.task || ''));
      // v1.4.6: 当前活动行——node.progressLog 末条（后端把 live 子代理事件折进它并节流落盘，轮询即见）。运行/等待
      // 中的节点带旋转点；succeeded/skipped 不在这里显示（历史在下方「最近进展」）。
      const activityLog = Array.isArray(node.progressLog) ? node.progressLog : [];
      const lastActivity = activityLog.length ? activityLog[activityLog.length - 1] : null;
      if (lastActivity && lastActivity.text && node.status !== 'succeeded' && node.status !== 'skipped') {
        const active = node.status === 'running' || node.status === 'waiting_resource';
        const act = el('div', `agent-node-activity${active ? ' active' : ''}`);
        act.append(el('span', 'agent-node-activity-dot', active ? '◐' : '·'), el('span', 'agent-node-activity-text', lastActivity.text));
        body.appendChild(act);
      }
      // ── 迭代/预算 mini 进度（§2.3）：loop 优先显示 loopIteration；否则 iters/maxIters（迭代预算）。 ──
      let budgetLabel = '', budgetCur = 0, budgetMax = 0;
      if (node.loop) { budgetLabel = t('workflow.budget.loop'); budgetCur = node.loopIteration || 0; budgetMax = node.loop.maxIterations || 0; }
      else if (Number.isFinite(Number(node.maxIters))) { budgetLabel = t('workflow.budget.iter'); budgetCur = Number(node.iters) || 0; budgetMax = Number(node.maxIters) || 0; }
      if (budgetMax > 0) {
        const bwrap = el('div', 'wf-node-budget');
        bwrap.appendChild(el('span', 'wf-budget-label', `${budgetLabel} ${budgetCur}/${budgetMax}`));
        const bar = el('div', 'wf-budget-bar'); const fill = el('div', 'wf-budget-fill'); fill.style.width = `${Math.max(0, Math.min(100, Math.round((budgetCur / budgetMax) * 100)))}%`; bar.appendChild(fill); bwrap.appendChild(bar);
        if (node.noProgressCount) bwrap.appendChild(el('span', 'wf-budget-warn', t('workflow.budget.noProgress', { n: node.noProgressCount })));
        body.appendChild(bwrap);
      }
      // ── 计时（§2.3）：已运行/用时 now-startedAt。 ──
      if (node.startedAt) {
        const st = Date.parse(node.startedAt);
        if (Number.isFinite(st)) {
          const active = node.status === 'running' || node.status === 'waiting_resource';
          const end = node.completedAt ? Date.parse(node.completedAt) : Date.now();
          const dur = fmtDuration(end - st);
          if (dur) body.appendChild(el('div', 'wf-node-timer', t(active ? 'workflow.timer.running' : 'workflow.timer.elapsed', { dur })));
        }
      }
      // ── 质量门 verdict + 置信度（§2.3）：仅门/带 verdict 的节点。 ──
      const verdict = node.gateVerdict || (node.structuredResult && node.structuredResult.verdict);
      if (verdict || (node.confidence != null && Number.isFinite(Number(node.confidence)))) {
        const g = el('div', 'wf-node-gate');
        if (verdict) g.appendChild(el('span', `wf-gate-verdict gv-${String(verdict).toLowerCase()}`, t('workflow.meta.verdict', { verdict })));
        if (node.confidence != null && Number.isFinite(Number(node.confidence))) g.appendChild(el('span', 'wf-gate-conf', `置信度 ${(Number(node.confidence) * 100).toFixed(0)}%`));
        body.appendChild(g);
      }
      // ── 资源锁 chip（§2.3）：等待中高亮 blocker。 ──
      if (Array.isArray(node.resources) && node.resources.length) {
        const waitingSet = new Set(Array.isArray(node.waitingForResources) ? node.waitingForResources : []);
        const resourceRow = el('div', 'agent-node-resources');
        resourceRow.appendChild(el('span', 'agent-resource-label', disp === 'waiting_resource' ? t('workflow.resource.waiting') : t('workflow.resource.label')));
        for (const resource of node.resources) resourceRow.appendChild(el('span', `agent-resource-chip${waitingSet.has(resource) ? ' blocking' : ''}`, resource));
        body.appendChild(resourceRow);
      }
      if (Array.isArray(node.resourceBlockers) && node.resourceBlockers.length) body.appendChild(el('div', 'agent-resource-wait', `${t('workflow.resourceBlocked',{groups:node.resourceBlockers.map(b=>b.group).join(', ')})}`));
      if (node.isolation && node.isolation.mode === 'worktree') {
        const iso = el('div', `agent-isolation ai-${node.isolation.status || 'unknown'}`);
        const shortCommit = node.isolation.commit ? String(node.isolation.commit).slice(0, 10) : '';
        iso.appendChild(el('span', 'agent-isolation-status', t('workflow.isolation.status', { status: node.isolation.status || 'unknown' }) + (shortCommit ? ` · ${shortCommit}` : '')));
        if (!run.live && node.isolation.status === 'ready' && node.isolation.commit) {
          const apply = el('button', 'mini primary', t('workflow.isolation.apply')); apply.setAttribute('aria-label', t('workflow.isolation.applyAria', { node: node.id }));
          apply.onclick = () => agentRunAction(run.id, 'apply_isolation', { nodeId: node.id });
          iso.appendChild(apply);
        }
        if (Array.isArray(node.isolation.changeSummary) && node.isolation.changeSummary.length) iso.appendChild(el('pre', 'agent-isolation-changes', node.isolation.changeSummary.join('\n')));
        body.appendChild(iso);
      }
      if (Array.isArray(node.progressLog) && node.progressLog.length) {
        const prog = el('div', 'agent-node-progress');
        prog.appendChild(el('div', 'agent-progress-title', t('workflow.progress.recent')));
        for (const item of node.progressLog.slice(-12)) prog.appendChild(el('div', 'agent-progress-line', `${item.at ? new Date(item.at).toLocaleTimeString() + ' · ' : ''}${item.text || ''}`));
        body.appendChild(prog);
      }
      // 结果/错误摘要：pre + textContent（el 内部用 textContent，XSS 安全，绝不 innerHTML）。
      if (node.result) body.appendChild(el('pre', 'agent-node-result', node.result));
      if (Array.isArray(node.schemaErrors) && node.schemaErrors.length) body.appendChild(el('pre', 'agent-node-error', `Schema: ${node.schemaErrors.join('; ')}`));
      if (node.error) body.appendChild(el('pre', 'agent-node-error', node.error));
      // ── 失败一键处置（§5.3）：非运行态给「仅重试此节点」「重试此节点及下游」；失败/判否节点另给「查看错误」。
      //    retry_node wire 到 POST /api/agent-runs/:id（action: retry_node，服务器要求 run 非 live）。 ──
      if (!run.live) {
        const actions = el('div', 'agent-node-actions');
        const retry = el('button', 'mini', t('workflow.retry.node')); retry.setAttribute('aria-label', t('workflow.retry.nodeAria', { nodeId: node.id })); retry.onclick = () => agentRunAction(run.id, 'retry_node', { nodeId: node.id, cascade: false });
        const cascade = el('button', 'mini', t('workflow.retry.cascade')); cascade.setAttribute('aria-label', t('workflow.retry.cascadeAria', { nodeId: node.id })); cascade.onclick = () => agentRunAction(run.id, 'retry_node', { nodeId: node.id, cascade: true });
        actions.append(retry, cascade);
        if ((disp === 'failed' || disp === 'rejected') && (node.error || (Array.isArray(node.schemaErrors) && node.schemaErrors.length))) {
          const viewErr = el('button', 'mini', t('workflow.viewError')); viewErr.setAttribute('aria-label', t('workflow.viewErrorAria', { nodeId: node.id }));
          viewErr.onclick = () => { row.open = true; const errEl = body.querySelector('.agent-node-error'); if (errEl) errEl.scrollIntoView({ block: 'nearest' }); };
          actions.appendChild(viewErr);
        }
        body.appendChild(actions);
      }
      // 对 live run 中运行/排队/等待资源的模型节点给「插话」按钮。Provider 在下一次调用前注入，
      // Claude 通过持续 stream-json stdin 注入；排队节点都在启动时消费。
      // vote/dedupe 质量门节点是确定性短路，从不调用模型、没有迭代边界会消费插话队列，同样不提供（与后端一致）。
      const isDeterministicGate = node.gate && ['vote', 'dedupe'].includes(node.gate.mode);
      if (run.live && ['running', 'queued', 'waiting_resource'].includes(node.status) && !isDeterministicGate) {
        const steerActions = el('div', 'agent-node-actions');
        const steer = el('button', 'mini', t('workflow.steer'));
        steer.setAttribute('aria-label', t('workflow.steerAria', { nodeId: node.id }));
        steer.onclick = () => steerAgentNode(run.id, node.id, node.status, undefined, node.engine);
        steerActions.appendChild(steer);
        body.appendChild(steerActions);
      }
      row.appendChild(body); graph.appendChild(row);
    }
    card.appendChild(graph); host.appendChild(card);
  }
}
let agentRunsSeq = 0;   // 对抗轮 P3: 轮询响应序号——慢包乱序落地时丢弃过期响应,防"审批已生效"被在途旧包闪回旧状态
// ── 第29波(§29a 增量监控)────────────────────────────────────────────────────────────────────────
// per-run 客户端缓存:每 tick 只拉 digest(run 级标量,~百字节/run),eventSeq 前进才去拉增量事件;完整快照仅在
// 【未知 run / settle 类事件 / live run 低频兜底 / 事件僵局自愈 / 手动 force】时按 run 单拉 —— 历史终态 run 不再
// 每 2s 全量重传。断线补播天然免费:缓存里的 lastSeq 就是断点,重开面板 afterSeq=lastSeq 续拉。渲染层零改动
// (仍喂 runs 数组;缓存对象原地演进,画布 renderSig 按内容签名跳过不受影响)。config.monitorIncremental=false
// 或 digest 不可用时回落旧全量轮询。
const agentRunsCache = { sid: '', runs: new Map() }; // runId -> { run, lastSeq, lastFullAt, stuckTicks }
const AGENT_RUN_SLOW_REFRESH_MS = 10000; // live run 的化妆性兜底刷新(gen 字数/邮箱等不走事件的时效字段)
// 事件轻应用:progressLog 里程碑与 node_start 可直接演进缓存(与后端同文案同 cap);其余(settle/run 级)一律
// 返回 false → 单 run 快照刷新(result/结构化输出不在事件里,快照才是权威状态源)。
function applyAgentRunEvent(run, evt) {
  if (!run || !evt) return false;
  const t = String(evt.type || '');
  if (t === 'node_progress') {
    const node = (Array.isArray(run.nodes) ? run.nodes : []).find(n => n && n.id === evt.nodeId);
    if (!node) return false;
    if (!Array.isArray(node.progressLog)) node.progressLog = [];
    node.progressLog.push({ at: evt.ts || nowIsoLocal(), text: String((evt.data && evt.data.text) || '') });
    if (node.progressLog.length > 80) node.progressLog = node.progressLog.slice(-80);
    return true;
  }
  if (t === 'node_start') {
    const node = (Array.isArray(run.nodes) ? run.nodes : []).find(n => n && n.id === evt.nodeId);
    if (!node) return false;
    node.status = 'running'; if (Number(evt.attemptId)) node.attempts = Number(evt.attemptId); if (!node.startedAt) node.startedAt = evt.ts || '';
    return true;
  }
  return false;
}
function nowIsoLocal() { try { return new Date().toISOString(); } catch { return ''; } }
// 渲染投递(全量/增量两条路共用):监控列表 + 画布 + "刚结束带 summary"的会话流补拉,原 loadAgentRuns 尾段原样。
async function deliverAgentRuns(sid, runs) {
  renderAgentRuns(runs);
  wbOnRuns(runs); // v3 P3a:同一份轮询数据喂工作台画布(缓存 + 亮点标 + 画布态重绘),不新增请求
  const finishedWithSummary = runs.find(run => run && run.summary && !run.live && !AGENT_RUN_ACTIVE.has(run.status) && !agentRunSummarySeen.has(`${sid}:${run.id}`));
  if (finishedWithSummary) {
    // The live message tree is the stream's write target. Replacing it here makes subsequent deltas land on
    // detached nodes, which looks frozen until a later full-session reload dumps the completed answer.
    if (activeTurns.has(sid)) return;
    agentRunSummarySeen.add(`${sid}:${finishedWithSummary.id}`);
    const fresh = await api(`/api/sessions/${encodeURIComponent(sid)}`).catch(() => null);
    if (fresh && fresh.session && state.currentSession?.id === sid) {
      state.currentSession = fresh.session;
      // 用户粘在底部时全量重渲染会 restoreScrollAnchor 回底部、无感知；若已上滑阅读（sticky=false），
      // 窗口化重渲染会把视口跳到别处（锚点行可能被新窗口丢弃）——只刷新侧栏，不打扰阅读位置。
      // 新回合开启时 mountActiveTurn 会按需重建消息区，静态内容不因此过期。
      if (scrollIsSticky()) { renderCurrentSession(); renderSessions(); }
      else renderSessions();
    }
  }
}
async function loadAgentRuns(force) {
  const sid = state.currentSession?.id; const host = $('agentRunsList'); if (!host) return;
  if (!sid) { renderAgentRuns([]); return; }
  const mySeq = ++agentRunsSeq;
  const incremental = force !== true && !!(state.config && state.config.monitorIncremental !== false);
  try {
    if (agentRunsCache.sid !== sid) { agentRunsCache.sid = sid; agentRunsCache.runs.clear(); } // 切会话清缓存
    if (!incremental) {
      // 旧全量路径(总开关关闭 / 动作后 force 刷新):顺带重建缓存与 lastSeq(=快照里的 eventSeq —— seq 之前的
      // 事件已烙进快照,跳过它们是正确语义,不是丢失)。
      const r = await api(`/api/agent-runs?sessionId=${encodeURIComponent(sid)}`);
      if (mySeq !== agentRunsSeq) return;   // 已有更新的请求发出,本响应过期
      const runs = Array.isArray(r.runs) ? r.runs : [];
      agentRunsCache.runs.clear();
      for (const run of runs) if (run && run.id) agentRunsCache.runs.set(run.id, { run, lastSeq: Number(run.eventSeq) || 0, lastFullAt: Date.now(), stuckTicks: 0 });
      await deliverAgentRuns(sid, runs);
      return;
    }
    const d = await api(`/api/agent-runs?sessionId=${encodeURIComponent(sid)}&view=digest`);
    if (mySeq !== agentRunsSeq) return;
    const digests = Array.isArray(d.runs) ? d.runs : [];
    const seen = new Set();
    for (const dg of digests) {
      if (!dg || !dg.id) continue;
      seen.add(dg.id);
      const c = agentRunsCache.runs.get(dg.id);
      let needFull = !c;
      if (c) {
        if ((Number(dg.eventSeq) || 0) > c.lastSeq) {
          const er = await api(`/api/agent-runs/${encodeURIComponent(dg.id)}/events?sessionId=${encodeURIComponent(sid)}&afterSeq=${c.lastSeq}`).catch(() => null);
          if (mySeq !== agentRunsSeq) return;
          const evts = er && Array.isArray(er.events) ? er.events : [];
          if (!evts.length) {
            // digest 说 seq 前进了、事件文件却拉不到(事件写失败/落盘滞后):连续 3 tick 僵住 → 全量自愈,
            // 防止"每 tick 空拉事件"的静默死循环(事件是 best-effort 通道,快照才可靠)。
            c.stuckTicks = (c.stuckTicks || 0) + 1;
            if (c.stuckTicks >= 3) needFull = true;
          } else {
            c.stuckTicks = 0;
            for (const evt of evts) {
              if (!(Number(evt.seq) > c.lastSeq)) continue;
              c.lastSeq = Number(evt.seq);
              if (!applyAgentRunEvent(c.run, evt)) needFull = true;
            }
            if (er.hasMore) needFull = true;
          }
        }
        if (!needFull && dg.live && Date.now() - c.lastFullAt > AGENT_RUN_SLOW_REFRESH_MS) needFull = true;
        // 对抗轮 P2(#15): status 漂移检测【不能带 !dg.live 门】—— 调度器把 live run 转 waiting_pool/paused 等【不发事件、
        // 不增 eventSeq】(server 只 saveAgentRun);旧的 `!dg.live` 门让 live run 的 dg.status 被无条件忽略,审批倒计时
        // 最长盲 10s(60s 宽限窗被吃掉 1/6)。改为任何 run 的 status 与缓存不一致即刷新(live/非 live 一致对待)。
        if (dg.status && c.run.status !== dg.status) needFull = true;
        // 对抗轮 P3(#13): digest 的 updatedAt 前进也触发刷新 —— 冷路径 apply_isolation 只改 node.isolation.status + saveAgentRun,
        // 不发事件、不改 run.status、eventSeq 冻结,旧逻辑三个 needFull 条件全不命中 → 缓存永久停在 ready、无自愈。updatedAt
        // 是快照写就变的字段,拿它当"内容动过"的兜底信号。
        if (dg.updatedAt && c.run.updatedAt && dg.updatedAt !== c.run.updatedAt) needFull = true;
        // digest 旗标即时叠加(live/paused 在内存,快照里没有;25.2 的 persistenceDegraded 同理必须绕过磁盘)。
        // 对抗轮 P3(#16): 旗标叠加必须【对称】—— resume 分支 delete resumeTier / 快照写恢复撤 persistenceDegraded 后,
        // digest 里这些字段已空,旧的"只置不清"会让缓存残留旧值(与 live 徽章同屏矛盾)直到下次 needFull。用 dg 值覆写(含空)。
        c.run.live = dg.live === true; c.run.paused = dg.paused === true;
        c.run.persistenceDegraded = dg.persistenceDegraded === true;
        c.run.resumeTier = dg.resumeTier || '';
      }
      if (needFull) {
        const fr = await api(`/api/agent-runs/${encodeURIComponent(dg.id)}?sessionId=${encodeURIComponent(sid)}`).catch(() => null);
        if (mySeq !== agentRunsSeq) return;
        if (fr && fr.ok && fr.run) agentRunsCache.runs.set(dg.id, { run: fr.run, lastSeq: Number(fr.run.eventSeq) || 0, lastFullAt: Date.now(), stuckTicks: 0 });
      }
    }
    for (const id of [...agentRunsCache.runs.keys()]) if (!seen.has(id)) agentRunsCache.runs.delete(id); // 已删除的 run 随 digest 消失
    const runs = digests.map(dg => { const c = agentRunsCache.runs.get(dg.id); return c && c.run; }).filter(Boolean);
    await deliverAgentRuns(sid, runs);
  }
  catch (e) {
    if (mySeq !== agentRunsSeq) return;
    host.textContent = t('workflow.loadFailed', { err: apiErrText(e) });
    // 对抗轮 P3: 画布态同步给出断连指示——原先只写监控列表,画布保持最后一帧"运行中"脉动,误导数据仍新鲜。
    markWorkbenchConnectionLost();
  }
}
// v3 P3a:轮询期望态由「监控页签激活」∪「工作台画布视图激活」共同决定 —— 画布复用同一份 2s 轮询(loadAgentRuns
// 内联刷新画布),不新增请求。tab 参数保留兼容既有 switchTab 调用点;实际期望态从 DOM(激活页签)+ Workbench 域派生。
function agentRunsPollWanted() {
  const tabActive = !!document.querySelector('.tool-pane .tool-tabs button[data-tab="agent-runs"].active');
  return tabActive || isWorkbenchCanvasView();
}
function syncAgentRunsPolling() {
  if (agentRunsPoll) { clearInterval(agentRunsPoll); agentRunsPoll = null; }
  if (agentRunsPollWanted()) { loadAgentRuns(); agentRunsPoll = setInterval(loadAgentRuns, 2000); }
}
function updateAgentRunsPolling(tab) { syncAgentRunsPolling(); }

/* 第60波：Workbench DAG 视图、状态与原生 Claude Agent 投影已拆入 ./js/workbench.js。 */

/* 第61波：成本/用量看板已拆入 ./js/usage-dashboard.js。 */
  return Object.freeze({
    bindWorkbench,
    launchAgentWorkflowFromQuickSelect,
    loadAgentRuns,
    loadAgentWorkflows,
    openWorkflowEditor,
    restoreMainView,
    updateAgentRunsPolling,
    wbNativeClaudeFinalize,
    wbNativeClaudeOnSubagent,
  });
}
