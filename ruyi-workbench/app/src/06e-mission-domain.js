// 第26波b: buildMissionPromptSection(mission, engine) —— <mission-ledger> 围栏,注入目标/里程碑进度/约束,
// 让模型每回合都知道「整体目标是什么、还差哪几步」。fits-or-drop 语义(≤1200,超则整段丢,防截断毁闭合围栏);
// 伪造围栏中和(同 memory/skill fence);内容为「当前任务状态」参考,不得覆盖守则。两引擎共用(对称)。
const MISSION_DIGEST_CAP = 1200;
function buildMissionPromptSection(mission, engine, config) {
  if (!mission || !mission.goal || !Array.isArray(mission.milestones) || !mission.milestones.length) return '';
  const fence = t => String(t == null ? '' : t).replace(/<(\/?)mission-ledger/gi, '[$1mission-ledger').replace(/\s+/g, ' ').trim();
  const tool = engine === 'claude' ? 'mission_update' : 'mission_update';
  const doneN = mission.milestones.filter(m => m.status === 'done').length;
  const lines = [];
  lines.push(getPromptPack(config && config.locale).mission.header);
  lines.push(getPromptPack(config && config.locale).mission.goal(fence(mission.goal).slice(0, 400)));
  lines.push(getPromptPack(config && config.locale).mission.progress(doneN, mission.milestones.length));
  for (const m of mission.milestones) {
    const mark = m.status === 'done' ? '✓' : m.status === 'blocked' ? '✗' : '·';
    lines.push(getPromptPack(config && config.locale).mission.milestone(mark, fence(m.id), fence(m.desc).slice(0, 160), m.status === 'blocked'));
  }
  if (mission.constraints && mission.constraints.length) lines.push(getPromptPack(config && config.locale).mission.constraints(mission.constraints.map(c => fence(c).slice(0, 120)).join(';').slice(0, 300)));
  lines.push(getPromptPack(config && config.locale).mission.guide(tool));
  const OPEN = '\n<mission-ledger>\n', CLOSE = '\n</mission-ledger>';
  let text = lines.join('\n');
  const budget = MISSION_DIGEST_CAP - OPEN.length - CLOSE.length;
  if (text.length > budget) return ''; // fits-or-drop:超预算整段丢,绝不中途截断(毁闭合围栏)
  return OPEN + text + CLOSE;
}


// ============================================================================
// 第26波b(AUTONOMY-PLAN §26b):until-done 驱动器 —— 一次用户回合后,若会话有 until-done 账本,服务端在【同一个
// HTTP 响应流】上自动续跑,直到:①全部里程碑 done(mission_complete);②预算耗尽(archive-pause,非报错);
// ③停滞(digest K 轮不变 → 降 supervised + mission_stuck 卡片)。红线:驱动器不放宽任何权限(exec 弹窗照旧等人/
// 超时,权限门在各引擎内部,驱动器够不着也不试图绕);自动回合全额记账(runOpenAiTurn 内 appendUsageLedger 照常)。
async function runMissionDriver({ session, config, provider, emit, runTurn, getLastTokens, isAlive }) {
  const cwd = normalizeCwd(session.cwd, config.defaultWorkspace);
  const allDone = () => (session.mission.milestones.length > 0 && session.mission.milestones.every(m => m.status === 'done'));
  // 每轮:跑机器验收(自动标 done)→ 判完成/预算/停滞 → 决定停或续。
  for (let guard = 0; guard < 100; guard++) {   // guard 只是死循环兜底,真正上限是 maxAutoTurns
    const m = session.mission;
    if (!m || m.autoMode !== 'until-done') return;
    if (!isAlive()) return;   // 用户断开/停止 → 立即收手

    // ① 机器验收:pass 的 pending/blocked 里程碑标 done(证据落 evidence)。
    let checkedAny = false;
    for (const ms of m.milestones) {
      if (ms.status === 'done') continue;
      const r = await evaluateMissionCheck(ms.check, cwd);
      if (r) { checkedAny = true; if (r.pass) { ms.status = 'done'; ms.evidence = String(r.detail || '机器验收通过').slice(0, MISSION_MAX_TEXT); } }
    }
    if (checkedAny) { m.updatedAt = nowIso(); await saveSession(session).catch(() => {}); emit({ type: 'mission', mission: m }); }

    // ② 全部完成 → 收尾。
    if (allDone()) {
      m.autoMode = 'off'; m.updatedAt = nowIso();
      // 第97波对抗复审(B3):机器验收把最后一个里程碑标 done 的路径,模型本轮可能没调 mission_update
      // (无 __missionFinalizeHow),09 回合收尾不会盖 complete 章 → 这里补盖,收工卡才有验收报告。
      // 若 09 已盖(result 存在)maybeFinalizeMission 会直接返回 false,不重复。
      try { if (await maybeFinalizeMission(session, 'driver')) { /* 章已盖,emit 由下方统一发 */ } } catch { /* 盖章失败不阻断收尾 */ }
      await saveSession(session).catch(() => {}); emit({ type: 'mission', mission: m, state: 'complete' }); return;
    }

    // ③ 预算:自动续跑回合数 / token 上限。达上限 → 存档暂停(autoMode→supervised,保留进度,非报错)。
    if (m.spent.autoTurns >= m.budget.maxAutoTurns || (m.budget.maxTokens > 0 && m.spent.tokens >= m.budget.maxTokens)) {
      // 对抗轮 P2(#6): 只在【转入】耗尽时落一次审计账 —— 用户经 action:'update' 把 autoMode 重设回 until-done 后,
      // 预算仍是耗尽态(applyMissionUpdate 不改 budget/spent),驱动器每次再入都会立刻再命中本判定;若每次都 logEvent,
      // budgetExhausted 分子随再武装无限 +1 而分母(started)恒为 1,超支率可 >100%。budgetExhaustedAt 已置 = 本轮耗尽
      // 已记过,不重复落账(下次 start 全新任务时 normalizeMission prev=null 会清掉它,新任务的耗尽正常重记)。
      const firstExhaust = !m.budgetExhaustedAt;
      m.autoMode = 'supervised'; m.budgetExhaustedAt = m.budgetExhaustedAt || nowIso(); m.updatedAt = nowIso(); await saveSession(session).catch(() => {});
      if (firstExhaust) logEvent({ kind: 'mission_budget_exhausted', sessionId: session.id, autoTurns: m.spent.autoTurns, maxAutoTurns: m.budget.maxAutoTurns, tokens: m.spent.tokens, maxTokens: m.budget.maxTokens });
      emit({ type: 'mission', mission: m, state: 'budget_exhausted', reason: `自动推进预算已用尽(${m.spent.autoTurns}/${m.budget.maxAutoTurns} 回合),已暂停等待你的指示` });
      return;
    }

    // ④ 停滞:进度指纹连续 K 轮不变 → 降 supervised + 卡片(交给用户;可选一次重规划由用户触发)。
    const digest = missionProgressDigest(m);
    if (digest === m.stall.lastDigest) m.stall.sameCount = (Number(m.stall.sameCount) || 0) + 1;
    else { m.stall.lastDigest = digest; m.stall.sameCount = 0; }
    if (m.stall.sameCount >= MISSION_STALL_LIMIT) {
      m.autoMode = 'supervised'; m.updatedAt = nowIso(); await saveSession(session).catch(() => {});
      emit({ type: 'mission', mission: m, state: 'stuck', reason: `连续 ${m.stall.sameCount} 个回合无进展,已暂停。你可以补充信息、手动调整里程碑,或结束任务。` });
      return;
    }

    // ⑤ 续跑:构造推进消息(列出未完成里程碑),自动发起下一回合(全额记账,标 driverAuto)。
    // 对抗轮 P3: goal/desc 可被模型经 mission_update 写入 —— 扁平化空白后再拼进这条自动 user 消息,
    // 避免 desc 里的换行+指令伪装成额外的用户指令(与 digest 的 fence 纪律一致)。
    const flat = s => String(s || '').replace(/\s+/g, ' ').trim();
    const pending = m.milestones.filter(ms => ms.status !== 'done');
    const contMsg = '请继续推进当前任务(Mission)。目标:' + flat(m.goal).slice(0, 300) + '\n未完成的里程碑:\n' +
      pending.map(ms => '- [' + flat(ms.id).slice(0, 64) + '] ' + flat(ms.desc).slice(0, 200)).join('\n') +
      '\n聚焦下一个里程碑,完成后用 mission_update 工具把它标 done 并附证据。若某步确实无法推进,请说明原因。';
    m.spent.autoTurns += 1;
    await saveSession(session).catch(() => {});
    emit({ type: 'mission', mission: m, state: 'continue', autoTurn: m.spent.autoTurns });
    await runTurn(contMsg, true);   // driverAuto=true
    if (getLastTokens) { try { session.mission.spent.tokens += Number(getLastTokens()) || 0; } catch {} }
  }
}

