'use strict';

export function pendingCount(pending) {
  return ['permissions', 'questions', 'plans', 'pool']
    .reduce((sum, key) => sum + Math.max(0, Number(pending && pending[key]) || 0), 0);
}

export function taskProgress(card, snapshot = null) {
  if (snapshot && snapshot.acceptance) {
    const total = Math.max(0, Number(snapshot.acceptance.total) || 0);
    const done = Math.min(total, Math.max(0, Number(snapshot.acceptance.done) || 0));
    return { total, done, percent: total ? Math.round(done * 100 / total) : 0 };
  }
  const mission = card && card.mission || {};
  const total = Math.max(0, Number(mission.milestonesTotal) || 0);
  const done = Math.min(total, Math.max(0, Number(mission.done) || 0));
  return { total, done, percent: total ? Math.round(done * 100 / total) : 0 };
}

export function acceptanceItems(snapshot) {
  const source = Array.isArray(snapshot && snapshot.acceptance && snapshot.acceptance.items)
    ? snapshot.acceptance.items : [];
  return source.map((item, index) => ({
    id: String(item && item.id || `item-${index + 1}`),
    desc: String(item && item.desc || '').trim(),
    status: ['done', 'blocked', 'pending'].includes(String(item && item.status)) ? String(item.status) : 'pending',
    evidence: String(item && item.evidence || '').trim(),
    checkType: String(item && item.checkType || 'none'),
  }));
}

export function activeAcceptanceIndex(items) {
  const list = Array.isArray(items) ? items : [];
  const pending = list.findIndex(item => item && item.status === 'pending');
  if (pending >= 0) return pending;
  return list.findIndex(item => item && item.status === 'blocked');
}

export function dispatchAcceptanceMilestones(prompt) {
  const source = String(prompt || '').trim();
  const chinese = /[\u3400-\u9fff]/.test(source);
  const research = /(?:分析|研究|调研|趋势|走势|比较|对比|报告|数据|市场|股票|美股|A股|research|analy[sz]e|trend|compare|market|stock)/i.test(source);
  const engineering = /(?:实现|开发|修复|重构|代码|接口|页面|组件|测试|bug|fix|implement|refactor|code|api|ui|test)/i.test(source);
  const artifact = /(?:文档|方案|表格|幻灯片|文件|交付|导出|生成|document|spreadsheet|slides?|file|deliver|export|create)/i.test(source);
  let outcome;
  let evidence;
  if (research) {
    outcome = chinese
      ? '结论直接回答目标问题，并覆盖点名的对象、范围与时间口径'
      : 'The conclusions directly answer the question and cover the named subjects, scope, and time frame';
    evidence = chinese
      ? '关键判断附有可核验的数据、事实或来源，并说明必要的限制与不确定性'
      : 'Key judgments include verifiable data, facts, or sources and state material limitations and uncertainty';
  } else if (engineering) {
    outcome = chinese
      ? '请求的功能或改动已按约定范围落地，且不引入无关行为变化'
      : 'The requested behavior or change is implemented within scope without unrelated behavior changes';
    evidence = chinese
      ? '相关检查或测试通过，关键交互、边界情况与回归风险均有可核验结果'
      : 'Relevant checks pass with verifiable coverage of key interactions, edge cases, and regression risk';
  } else if (artifact) {
    outcome = chinese
      ? '请求的交付物已生成并可正常打开或使用，内容覆盖明确要求'
      : 'The requested deliverable is produced, usable, and covers the explicit requirements';
    evidence = chinese
      ? '交付物的格式、完整性与关键内容已经过核验，并提供可定位的产出'
      : 'The deliverable format, completeness, and key content are verified with a locatable output';
  } else {
    outcome = chinese
      ? '最终结果完整回应任务目标及其中明确提出的约束'
      : 'The final result fully addresses the task goal and its explicit constraints';
    evidence = chinese
      ? '关键结论或交付附有可核验的事实、产出或检查结果'
      : 'Key conclusions or deliverables include verifiable facts, outputs, or check results';
  }
  return [
    { id: 'accept-outcome', desc: outcome, status: 'pending' },
    { id: 'accept-evidence', desc: evidence, status: 'pending' },
  ];
}

export function elapsedLabel(startedAt, current = new Date()) {
  const start = startedAt instanceof Date ? startedAt.getTime() : Date.parse(String(startedAt || ''));
  const end = current instanceof Date ? current.getTime() : Date.parse(String(current || ''));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
