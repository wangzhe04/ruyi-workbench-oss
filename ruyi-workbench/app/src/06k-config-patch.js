// ============================================================================
// 架构还债批 2 B2:配置补丁的落盘与副作用 —— 配置域的业务规则,不是传输层的事。
//
// applyConfigPatch 原先住在 13-http-router.js:掩码密钥冲突检测、toolbox- 服务商归属、服务商缩水自动备份 +
// 审计事件、Claude CLI / agent roles / MCP 同步触发,全是配置域的规矩;13l 的 steward_config_set 为了走同一条
// 落盘路径,只能回头伸进路由文件里调它。现在它住在这里,路由层只剩 body 解析与错误翻译。
//
// 为什么是一个排在 06j 之后的独立模块、而不是塞进 01-config.js:
//   · 它要调 02(rememberLastUsedEngineRoute / sessionEngineRouteFromConfig)、05(掩码三件)、06i(StewardHooks):
//     放在 01 里就是 01->02、01->06i 两条新前向边;放在这里全是后向边。
//   · 两个调用方(13、13l)若直接引用 applyConfigPatch,本模块就会经 13 -> 06k -> 01 被卷进唯一的大 SCC(已在
//     上限 32)。所以调用方经 01 的 ConfigPatchHooks 调(与 06j / 13t 同一个模具),本模块零入边、不进任何环。
// ============================================================================

// 第 116 波 116-2e:POST /api/config 的落盘与全部副作用,零行为抽出为 applyConfigPatch(body)。
// 为什么抽:`steward_config_set`(§3.5「如意设置」行)必须经【同一个落盘函数】写入 —— 116h 的
// arbiterRefresh、Claude CLI settings 同步、agent roles 同步、MCP 同步都挂在这条路径上,管家走
// 另一条路就会静默漏掉它们(「改了上限要等下一条线程跑完才生效」正是这种漏的样子)。
// 入参 body = 用户/管家提交的 patch(未 normalize);返回 writeConfig 之后已 normalize 的 next。
// 路由层(13 的 POST /api/config)只剩 body 解析与错误翻译、掩码回包;13l 的 steward_config_set 同样调它。
// 架构还债批 2 B2:从 13-http-router.js 原样搬到这里(同名、同行为)。两个调用方都经 01 的 ConfigPatchHooks 调,
// 不直接引用本模块的符号 —— 本模块因此零入边、挂在唯一大 SCC 之外(见文件头)。
async function applyConfigPatch(rawBody) {
  // 116-3 B1(会话/权限口径子审查):把全局默认权限切到「全自动」此前【没有服务端门】——
  // §8.6 那条二次确认只由界面出,任何别的调用方(脚本、117 壳、管家自己)一个 POST 就能把全局
  // 默认档改成 auto/bypass。13d 的 PATCH /api/sessions/:id 早就有这道门(同一张
  // PERMISSION_MODES_REQUIRING_CONFIRM、同一个 permission.confirm_required 错误码),这里补齐另一半。
  // `confirm` 是请求级信号不是配置键,判完就从 patch 里剥掉,绝不能跟着 merged 落进 config.json。
  const raw = (rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)) ? rawBody : {};
  const confirmed = raw.confirm === true;
  const body = { ...raw };
  delete body.confirm;
  if (Object.prototype.hasOwnProperty.call(body, 'permissionMode')) {
    const requested = body.permissionMode == null ? '' : String(body.permissionMode);
    if (PERMISSION_MODES_REQUIRING_CONFIRM.includes(requested) && !confirmed) {
      throw Object.assign(new Error('switching the global default to full-auto requires an explicit confirm:true (it can change files and run commands while you are away)'), {
        code: 'permission.confirm_required', statusCode: 409, permissionMode: requested,
      });
    }
  }
  // 117n-M2:整段「读 current -> merge -> 落盘」搬进 mutateConfig 的临界区。外部契约与顺序不变
  // (确认门仍在读之前、三路同步仍在写之后),变的只是这段临界区不再能被并发的另一次配置改动
  //  穿插 —— 此前 /api/config 与 storage/policy、agent-roles、连接器启停彼此吞字段。
  const patched = await mutateConfig(async (current) => {
    const merged = { ...current, ...body };
    // F2 (安全·防掩码覆盖): if the payload carries providers[] or searchBackend, any apiKey still the mask
    // (`••••…`) means the UI round-tripped the masked value from GET /api/status — restore the real key
    // from the same-id provider (or on-disk searchBackend) before persisting, so a save never wipes the
    // stored key. unmaskSecrets covers BOTH secret sites in one pass (v0.9-S9).
    // 107-S0:modelsApiKey 也在 GET /api/status 里掩码下发了,设置页把掩码原样回传 —— 同一处还原,否则一次保存就把
    // 真密钥写成「••••末四位」。
    // 107-S0b:externalMcpServers 的 env／headers／args 也在 GET /api/status(与 steward_config_get)里掩码下发了 ——
    // 调用方原样回传时同一处按 id＋键名还原;不还原的话残留掩码会被 sanitize 那道闸清空,等于一次保存抹掉连接器密钥。
    // 107-S2(46 号文 §5 ⑦b M5):启动向量闸。掩码回传只有在「密钥会去的地址一个都没变」时才算
    // 「用户没动这个框」;地址变了(或压根没有同 id 那一条)就整份拒绝、零写入,并如实告诉用户要重填
    // 哪几条的密钥 —— 不静默把旧密钥贴到新端点上(那是 M5 的洞),也不静默清空(那是用户看不见的丢失)。
    // 判据在 05 的 maskedSecretConflicts;它与 unmaskSecrets 读的是【同一份 current】(都在这个临界区里),
    // 所以不存在「检查用的是旧快照、落盘用的是新快照」那一类竞态。
    const conflicts = maskedSecretConflicts(body, current);
    if (conflicts.length) {
      throw Object.assign(new Error(maskedSecretConflictMessage(conflicts)), {
        code: 'config.masked_secret_vector_changed', statusCode: 409, conflicts,
      });
    }
    // 107-S2:modelsApiBase 也进这一组 —— 它自己可能带凭据(`?api_key=…`),下发时被 safeUrlForDisplay
    // 遮过,原样回传要对回真值;不写回的话一次保存就把它写成脱敏形(且 normalizeConfig 那道闸会清空它)。
    if ((body && Array.isArray(body.providers)) || (body && body.searchBackend && typeof body.searchBackend === 'object')
      || (body && typeof body.modelsApiKey === 'string') || (body && typeof body.modelsApiBase === 'string')
      || (body && Array.isArray(body.externalMcpServers))) {
      const restored = unmaskSecrets(body, current);
      if (Array.isArray(body.providers)) merged.providers = restored.providers;
      if (body.searchBackend && typeof body.searchBackend === 'object') merged.searchBackend = restored.searchBackend;
      if (typeof body.modelsApiKey === 'string') merged.modelsApiKey = restored.modelsApiKey;
      if (typeof body.modelsApiBase === 'string') merged.modelsApiBase = restored.modelsApiBase;
      if (Array.isArray(body.externalMcpServers)) merged.externalMcpServers = restored.externalMcpServers;
    }
    // 2026-09-21(用户真机,日志 config_providers_shrunk lost:['toolbox-asr-shim']):`toolbox-` 前缀的服务商归自动发现所有 ——
    // 04f syncToolboxProviders 增删它们,走 mutateConfig 不经这里。设置页整份保存上传的是一份【草稿快照】:页面加载时播种,
    // 而 toolbox 组件要晚一两秒才起好、才把自己的条目写进配置;快照里没有它,一次保存就把它撤掉,normalizeConfig 随即把
    // 指着它的语音识别选择清空 —— 用户看到的是「本地语音识别突然没了、设置里也不见、再配也配不上」。所以来件里的
    // toolbox- 条目一律以【现值】为准:改不了、造不出、也撤不掉(现值有、来件没有的补回末尾,位置照 04f)。
    // 停用／卸载才是撤走它的正途,那条路(04f)不经过本函数。只在来件真带了 providers 时做,别的保存一字不动。
    if (Array.isArray(body.providers) && Array.isArray(merged.providers)) {
      const isToolbox = p => Boolean(p && typeof p === 'object' && String(p.id || '').startsWith('toolbox-'));
      const owned = (Array.isArray(current.providers) ? current.providers : []).filter(isToolbox);
      const foreign = merged.providers.filter(p => !isToolbox(p));
      if (owned.length || foreign.length !== merged.providers.length) merged.providers = [...foreign, ...owned];
    }
    // Remember an explicitly-chosen model so it persists in the list even if the proxy later drops it.
    if (body && typeof body.model === 'string' && body.model && !(merged.knownModels || []).includes(body.model)) {
      merged.knownModels = [...(merged.knownModels || []), body.model];
    }
    // 2026-09-06 事故(用户的五个 Provider 连同密钥被一次整份保存写成 providers: [])后的服务端保险:
    // 现值有 Provider、来件要把它清成空数组时,先把当前 config 原样另存一份(config.json.bak-providers-
    // <时间戳>,与既有 config.json.bak-<日期> 同一目录同一命名族),并记一条审计事件。【不拦截】——
    // 逐个删除到最后一个也是合法的 [],这里只保证永远有得救。备份失败不阻塞写入。
    // 设置弹窗子审查追加：不只「清空」，任何【缩水】（现值里某个 id 在来件里没了）都先备份——用户以为在
    // 原有列表上加一条、实际把整份换成只剩一条，正是那种既不为空也没告警的丢法。
    if (Array.isArray(current.providers) && current.providers.length > 0 && Array.isArray(merged.providers)) {
      const nextIds = new Set(merged.providers.map(p => String((p && p.id) || '')));
      const lost = current.providers.map(p => String((p && p.id) || '')).filter(id => id && !nextIds.has(id));
      if (lost.length) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = `config.json.bak-providers-${stamp}`;
        try { await fsp.copyFile(paths.config, path.join(path.dirname(paths.config), backupName)); } catch { /* 备份失败不阻塞写入 */ }
        logEvent({ kind: merged.providers.length === 0 ? 'config_providers_cleared' : 'config_providers_shrunk', before: current.providers.length, after: merged.providers.length, lost, backup: backupName });
      }
    }
    return { next: merged, value: current };
  });
  const next = patched.config;
  const current = patched.value; // 落盘前那一份(锁内读到的),下面的三路同步判「改没改」要用它
  // 133(用户 2026-09-21「切走了大模型就立刻从显存里卸掉」):整段识别的选择换了(换模型／换服务商／关掉)→ 04f 去打
  // 原来那个组件的 unload 路。fire-and-forget:保存的回包不等它;没登记 unload 路的组件只靠自己的空闲卸载。
  if (typeof ToolboxHooks.asrSelectionChanged === 'function') void ToolboxHooks.asrSelectionChanged(current, next).catch(() => {});
  // 116h(27 号文 §8.10「并发上限就地可调,改完立即生效,不需重启」):配置落盘后立刻唤醒线程仲裁器
  // 的队列 —— 仲裁器每次唤醒都重读配置(不缓存),但唤醒本身只由「入队/释放/插队」触发,没有这一行
  // 的话调大上限要等下一条线程跑完才生效。队列为空(含管家关着)时是无操作。
  if (typeof StewardHooks.arbiterRefresh === 'function') { try { StewardHooks.arbiterRefresh(); } catch { /* best-effort */ } }
  if (body && ['agentCliType', 'claudePath', 'kimiPath'].some(k => Object.prototype.hasOwnProperty.call(body, k))) {
    invalidateAgentCliPathCaches();
  }
  // 123-N2 合并复核（主会话）：用户在设置里改全局引擎（activeProvider／agentCliType／model）也是一次
  // 【显式选择】，要成为「上次用的」—— 否则改完全局、新开一条线程，仍跟着改之前的那一路走
  // （agent-team-mode.e2e 合并后串行必红：切回 Claude 驱动后新会话仍走上一轮的 fake 端点）。
  // 只在这三个键真的在 body 里时记；与现值相同则 rememberLastUsedEngineRoute 自己短路不落盘。
  // 【await 而不是 void】：保存请求回 200 之前记录就得落盘——调用方（设置页、e2e）改完全局马上
  // 新开线程是常见序列，fire-and-forget 会让那条新线程仍跟着上一路走（本机实测 agent-team-mode 就这么红）。
  if (body && ['activeProvider', 'agentCliType', 'model'].some(k => Object.prototype.hasOwnProperty.call(body, k))) {
    await rememberLastUsedEngineRoute(sessionEngineRouteFromConfig(next), next);
  }
  // v1.4.3: keep ~/.claude/ in sync — settings.json + agent roles + MCP servers
  if (body && (Object.prototype.hasOwnProperty.call(body, 'permissionMode') || Object.prototype.hasOwnProperty.call(body, 'model') || Object.prototype.hasOwnProperty.call(body, 'thinkingBudget') || Object.prototype.hasOwnProperty.call(body, 'appendSystemPrompt'))) {
    await syncClaudeCliSettings(next);
  }
  if (body && (Object.prototype.hasOwnProperty.call(body, 'agentRoleOverrides') || Object.prototype.hasOwnProperty.call(body, 'permissionMode'))) {
    await syncAgentRolesToClaude(next.defaultWorkspace || os.homedir(), next);
  }
  if (body && Object.prototype.hasOwnProperty.call(body, 'externalMcpServers')) {
    await syncMcpServersToClaude(next);
    if (next.agentCliType === 'kimi' && next.includeWorkbenchMcp) await syncMcpServersToKimi(next);
  }
  if (body && (Object.prototype.hasOwnProperty.call(body, 'agentCliType') || Object.prototype.hasOwnProperty.call(body, 'includeWorkbenchMcp'))) {
    if (next.agentCliType === 'kimi') await syncMcpServersToKimi(next);
    else if (current.agentCliType === 'kimi') await syncMcpServersToKimi({ ...next, includeWorkbenchMcp: false });
  }
  return next;
}

// 加载即登记:13 / 13l 只经这个键调(见 01 的 ConfigPatchHooks)。
ConfigPatchHooks.applyConfigPatch = applyConfigPatch;
