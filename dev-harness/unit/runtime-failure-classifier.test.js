'use strict';
// 20-F1 deterministic-v3 分类器的快通道正反例(只读遥测:这里没有、也不该出现任何重试/修复执行器)。
//   [A] 结构化字段先于文本:web_fetch / http_download / web_search 的 failClass + statusCode + blocked。
//       403 的「网站拒绝了请求」不再被 /拒绝/ 吞成 permission_denied;404/410 → resource_not_found;
//       reset/connect/proxy/timeout/network 读工具 → transient_read,改动类 → side_effect_unknown(安全分支仍最先)。
//   [B] 代理与参数:tier-mismatch、控制面不能经代理、参数不是完整 JSON(argsInvalid)→ invalid_arguments。
//   [C] 策略与预算:计划模式先交 PLAN、steward 读预算/观察回忆配额 → policy_blocked。
//   [D] 找不到与歧义:not_found / not_in_artifacts / ENOENT → resource_not_found;file_edit ambiguous → edit_conflict,
//       而 file_edit 的 oldText 找不到(同样带 code:not_found)仍是 edit_conflict。
//   [E] 防误伤:带 stderr 的进程结果不被当成 HTTP/验证码/ENOENT 信号;只含 "blocked" 字样的文本不成 remote_blocked。
// 报文全部取自 11-native-tools / 12-tool-dispatch / 13k/13l steward / 09-workflow 的真实形状(见各条注释)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-f1-classifier-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const { classifyRuntimeToolFailure } = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));

const classify = (tool, result, tier = 'read', disposition) => classifyRuntimeToolFailure(tool, result, { tier, ...(disposition ? { disposition } : {}) });
const cls = (tool, result, tier, disposition) => { const r = classify(tool, result, tier, disposition); return r && r.failureClass; };

test('[v3] 版本号换成 deterministic-v3(换版本 = 报表换 cohort),成功调用仍不产生记录', () => {
  const r = classify('web_fetch', { ok: false, error: '页面不存在(HTTP 404)', failClass: 'http', statusCode: 404 });
  assert.equal(r.classifierVersion, 'deterministic-v3');
  assert.equal(r.deterministic, true);
  assert.equal(classify('web_fetch', { ok: true, text: 'x' }), null);
  assert.equal(classify('web_fetch', { ok: true, error: 'warning field present' }), null);
});

// ── [A] web_fetch 失败信封 ───────────────────────────────────────────────────────────────────────────────────
test('[A] 403/401/451 → remote_blocked(换源),不再是 permission_denied/request_authority', () => {
  // 11-native-tools webFetchFailMessage:http 403/401 的真实文案
  const r403 = classify('web_fetch', { ok: false, error: '网站拒绝了请求(HTTP 403,可能反爬)', failClass: 'http', statusCode: 403, hint: '可尝试用 web_search 搜索该内容替代' });
  assert.equal(r403.failureClass, 'remote_blocked');
  assert.equal(r403.allowedRepair, 'use_alternative_source');
  assert.equal(r403.recoverableHint, true);
  assert.equal(cls('web_fetch', { ok: false, error: '网站拒绝了请求(HTTP 401,可能反爬)', failClass: 'http', statusCode: 401 }), 'remote_blocked');
  assert.equal(cls('web_fetch', { ok: false, error: '网站返回了错误(HTTP 451)', failClass: 'http', statusCode: 451 }), 'remote_blocked');
  // 结构化码缺失时,「网站拒绝了请求」这句专属文案本身也认
  assert.equal(cls('web_fetch', { ok: false, error: '网站拒绝了请求' }), 'remote_blocked');
  // http_request 的形状:error:'HTTP 403' + statusCode
  assert.equal(cls('http_request', { ok: false, error: 'HTTP 403', failClass: 'http', statusCode: 403 }, 'exec'), 'remote_blocked');
});

test('[A] 反爬 / 验证码 / Cloudflare 文案(只看 error/message,不看 stderr)→ remote_blocked', () => {
  assert.equal(cls('web_search', { ok: false, error: '搜索引擎返回了人机验证页(反爬拦截)' }), 'remote_blocked');
  assert.equal(cls('web_fetch', { ok: false, error: 'Attention: captcha required' }), 'remote_blocked');
  assert.equal(cls('web_fetch', { ok: false, message: 'Blocked by Cloudflare bot protection' }), 'remote_blocked');
});

test('[A] 真正的权限拒绝仍是 permission_denied / request_authority', () => {
  for (const [tool, tier, result] of [
    ['file_write', 'edit', { ok: false, error: 'denied by user' }],
    ['file_write', 'edit', { ok: false, error: '用户拒绝授权' }],
    ['file_write', 'edit', { ok: false, error: 'Access is denied' }],
    ['powershell_run', 'exec', { ok: false, error: 'blocked by permission mode' }],
    ['file_read', 'read', { ok: false, error: '用户拒绝了请求' }],
    ['file_read', 'read', { ok: false, code: 'no_permission', error: '没有读取该文件的权限' }],
  ]) {
    const r = classify(tool, result, tier);
    assert.equal(r.failureClass, 'permission_denied', JSON.stringify(result));
    assert.equal(r.allowedRepair, 'request_authority');
    assert.equal(r.recoverableHint, false);
  }
});

test('[A] SSRF / 重定向拦截(blocked 字段)→ remote_blocked;非 http 协议与无法解析的 URL 是参数问题', () => {
  // 11-native-tools ssrfCheck 的三种 reason
  assert.equal(cls('web_fetch', { ok: false, error: '目标地址不允许(内网/回环)', blocked: '127.0.0.1' }), 'remote_blocked');
  assert.equal(cls('http_download', { ok: false, error: '解析到内网地址', blocked: '10.0.0.8' }, 'edit'), 'remote_blocked');
  assert.equal(cls('web_fetch', { ok: false, error: '仅允许 http/https 协议', blocked: 'example.com' }), 'invalid_arguments');
  assert.equal(cls('web_fetch', { ok: false, error: 'URL 无法解析', blocked: '' }), 'invalid_arguments');
  // blocked 不是字符串(例如布尔)或为空串 → 不触发
  assert.notEqual(cls('web_fetch', { ok: false, error: 'something odd', blocked: true }), 'remote_blocked');
  assert.notEqual(cls('web_fetch', { ok: false, error: 'something odd', blocked: '' }), 'remote_blocked');
});

test('[A] TLS 失败是确定性的远端问题 → remote_blocked,不是 retry_once', () => {
  const r = classify('web_fetch', { ok: false, error: 'HTTPS 证书/握手失败', failClass: 'tls', hint: '该站点的安全证书异常,谨慎访问' });
  assert.equal(r.failureClass, 'remote_blocked');
  assert.notEqual(r.allowedRepair, 'retry_once');
});

test('[A] 404 / 410 → resource_not_found;其它 4xx 不乱猜', () => {
  assert.equal(cls('web_fetch', { ok: false, error: '页面不存在(HTTP 404)', failClass: 'http', statusCode: 404, hint: '检查网址是否正确' }), 'resource_not_found');
  assert.equal(cls('web_fetch', { ok: false, error: '页面不存在(HTTP 410)', failClass: 'http', statusCode: 410 }), 'resource_not_found');
  assert.equal(cls('http_request', { ok: false, error: 'HTTP 404', failClass: 'http', statusCode: 404 }, 'exec'), 'resource_not_found');
  assert.equal(cls('web_fetch', { ok: false, error: '网站返回了错误(HTTP 418)', failClass: 'http', statusCode: 418 }), 'unknown');
  assert.equal(cls('web_fetch', { ok: false, error: '网站返回了错误(HTTP 501)', failClass: 'http', statusCode: 501 }), 'unknown');   // 5xx 只认 500/502/503/504,501 这类确定性的不贴 retry_once
  // 字符串形式的状态码也认(JSON 往返后可能是 "404")
  assert.equal(cls('web_fetch', { ok: false, error: '页面不存在', statusCode: '404' }), 'resource_not_found');
});

test('[A] 连接类 failClass:读工具 → transient_read(retry_once)', () => {
  const shapes = [
    { error: '对方服务器中断了连接(可能有反爬限制)', failClass: 'reset', hint: '可尝试用 web_search 搜索该内容替代' },   // 不会因为「反爬」二字变 remote_blocked
    { error: '无法连接到该网站', failClass: 'connect' },
    { error: '无法连接代理 http://127.0.0.1:7890: connect ECONNREFUSED', failClass: 'proxy' },
    { error: '抓取超时', failClass: 'timeout' },
    { error: '搜索引擎连不上(request failed)', failClass: 'network' },
    { error: 'request error', failClass: 'other' },        // Node 空 message 的 socket 错误
    { error: 'HTTP 500', failClass: 'http', statusCode: 500 },
    { error: 'HTTP 408', failClass: 'http', statusCode: 408 },
  ];
  for (const shape of shapes) {
    const r = classify('web_fetch', { ok: false, ...shape });
    assert.equal(r.failureClass, 'transient_read', JSON.stringify(shape));
    assert.equal(r.allowedRepair, 'retry_once');
  }
});

test('[A] DNS:EAI_AGAIN 或「疑似离线」探测 → transient_read;其余(主机不存在)→ resource_not_found', () => {
  assert.equal(cls('web_fetch', { ok: false, error: '域名解析失败(网址可能不存在)', failClass: 'dns', hint: '检查网址拼写是否正确;若本机需要经代理上网,请设置 HTTPS_PROXY / HTTP_PROXY 环境变量后重启工作台' }), 'resource_not_found');
  assert.equal(cls('web_fetch', { ok: false, error: '域名解析失败(网址可能不存在)', failClass: 'dns', hint: '当前疑似离线。联网后重试,或先在线抓取一次以建立缓存' }), 'transient_read');
  assert.equal(cls('web_fetch', { ok: false, error: 'getaddrinfo EAI_AGAIN example.com', failClass: 'dns' }), 'transient_read');
});

test('[A] 用户中断(failClass:aborted)读工具不是故障,不贴 retry_once;改动类仍 side_effect_unknown', () => {
  const read = classify('web_fetch', { ok: false, error: '请求已被用户中断', failClass: 'aborted' });
  assert.notEqual(read.failureClass, 'transient_read');
  assert.notEqual(read.allowedRepair, 'retry_once');
  assert.equal(cls('http_download', { ok: false, error: '请求已被用户中断', failClass: 'aborted' }, 'edit'), 'side_effect_unknown');
});

// ── 安全分支:改动中的工具遇到传输歧义一律 side_effect_unknown,先于任何「可修复」规则 ──────────────────────────────
test('[safety] 改动类工具的超时/断连/中断/5xx 一律 side_effect_unknown(不得被新规则抢先)', () => {
  const ambiguous = [
    { error: '对方服务器中断了连接(可能有反爬限制)', failClass: 'reset' },   // 带「反爬」,也不能成 remote_blocked
    { error: '无法连接到该网站', failClass: 'connect' },
    { error: '无法连接代理', failClass: 'proxy' },
    { error: '抓取超时', failClass: 'timeout' },
    { error: '请求已被用户中断', failClass: 'aborted' },
    { error: 'request error', failClass: 'other' },
    { error: 'HTTP 500', failClass: 'http', statusCode: 500 },
    { error: 'HTTP 503', failClass: 'http', statusCode: 503 },
    { error: '域名解析失败', failClass: 'dns', hint: '当前疑似离线。联网后重试' },
    { error: 'getaddrinfo EAI_AGAIN host', failClass: 'dns' },
    { error: 'timeout after dispatch' },
    { error: 'ETIMEDOUT after write' },
    { timedOut: true, code: -1, stderr: '[timed out; process tree killed]' },
  ];
  for (const tier of ['edit', 'exec']) {
    for (const shape of ambiguous) {
      const r = classify('http_download', { ok: false, ...shape }, tier);
      assert.equal(r.failureClass, 'side_effect_unknown', `${tier} ${JSON.stringify(shape)}`);
      assert.equal(r.allowedRepair, 'stop_for_effect_check');
      assert.equal(r.recoverableHint, false);
    }
  }
  assert.equal(cls('file_edit', { ok: false, error: 'interrupted' }, 'edit', 'steer_skipped'), 'side_effect_unknown');
});

test('[safety] 任何 edit/exec 档的结果都不会得到 retry_once', () => {
  const fixtures = [
    { error: '网站拒绝了请求(HTTP 403,可能反爬)', failClass: 'http', statusCode: 403 },
    { error: '页面不存在(HTTP 404)', failClass: 'http', statusCode: 404 },
    { error: 'HTTP 429', statusCode: 429 },
    { error: 'tool_invoke: risk tier mismatch', code: 'tier-mismatch' },
    { error: 'HTTPS 证书/握手失败', failClass: 'tls' },
    { error: 'budget_exceeded', message: 'steward read budget exhausted' },
    { error: '文件不存在', code: 'not_found' },
    { error: 'timeout' },
  ];
  for (const tier of ['edit', 'exec']) {
    for (const fixture of fixtures) {
      const r = classify('some_tool', { ok: false, ...fixture }, tier);
      assert.notEqual(r.allowedRepair, 'retry_once', `${tier} ${JSON.stringify(fixture)}`);
    }
  }
});

test('[safety] 改动类工具收到确定的远端回答(403/404)不是歧义:仍按回答分类', () => {
  assert.equal(cls('http_download', { ok: false, error: '网站拒绝了请求(HTTP 403,可能反爬)', failClass: 'http', statusCode: 403 }, 'edit'), 'remote_blocked');
  assert.equal(cls('http_download', { ok: false, error: '页面不存在(HTTP 404)', failClass: 'http', statusCode: 404 }, 'edit'), 'resource_not_found');
});

// ── [B] 代理与参数 ─────────────────────────────────────────────────────────────────────────────────────────
test('[B] tier-mismatch / 控制面不能经代理 / 参数不是完整 JSON → invalid_arguments(modify_arguments)', () => {
  const shapes = [
    // 12-tool-dispatch invokeAdaptiveMcpTool
    ['tool_invoke_read', { ok: false, code: 'tier-mismatch', error: "risk tier mismatch: file_write is 'edit', higher than 'read'", hint: 'call tool_invoke_edit for this tool' }, 'read'],
    ['tool_invoke_read', { ok: false, code: 'tier-mismatch', error: "tier mismatch (bridged recheck): x is 'exec' for these arguments, higher than 'read'", hint: 'call tool_invoke_exec for this tool with these arguments' }, 'read'],
    ['tool_invoke_edit', { ok: false, error: 'control-plane tools cannot be invoked through a proxy' }, 'edit'],
    // 早期版本(严格相等档位)的措辞,没有 code 字段:真机历史里留着,靠文案前缀认
    ['tool_invoke_edit', { ok: false, error: "risk tier mismatch: file_read is 'read', not 'edit'" }, 'edit'],
    // 09-workflow toolArgsRefusal(两句 + argsInvalid 结构位)
    ['file_write', { ok: false, argsInvalid: true, error: '工具调用参数不是完整的 JSON 对象,该调用未执行;请按工具的参数格式给出完整参数后重试' }, 'edit'],
    ['file_write', { ok: false, argsInvalid: true, error: '工具调用参数被截断(模型输出达到上限),该调用未执行;请把内容拆小(分几次写入)后重试' }, 'edit'],
    ['file_write', { ok: false, error: '工具调用参数不是完整的 JSON 对象' }, 'edit'],       // 没有结构位时靠文案
    ['file_write', { ok: false, error: 'whatever' }, 'edit', 'args_invalid'],                 // 或靠 disposition
    // 12-tool-dispatch 的参数校验码
    ['file_read', { ok: false, code: 'invalid-arguments', error: 'file_read: arguments must be a JSON object (got string)' }, 'read'],
    ['powershell_run', { ok: false, code: 'invalid_args', error: 'command 不能为空' }, 'exec'],
    ['steward_thread_read', { ok: false, error: 'invalid_request', message: 'sessionId is required' }, 'read'],
  ];
  for (const [tool, result, tier, disposition] of shapes) {
    const r = classify(tool, result, tier, disposition);
    assert.equal(r.failureClass, 'invalid_arguments', JSON.stringify(result));
    assert.equal(r.allowedRepair, 'modify_arguments');
    assert.equal(r.recoverableHint, true);
  }
});

// ── [C] 策略与预算 ─────────────────────────────────────────────────────────────────────────────────────────
test('[C] 计划模式:先提交 PLAN → policy_blocked / replan;无论改动类还是只读', () => {
  const refuse = { ok: false, error: '计划模式:请先提交 PLAN: 开头的计划' };      // 09-workflow plan 相位拒绝的真实措辞
  for (const tier of ['read', 'edit', 'exec']) {
    const r = classify('file_write', refuse, tier, 'plan_refused');
    assert.equal(r.failureClass, 'policy_blocked');
    assert.equal(r.allowedRepair, 'replan');
    assert.equal(r.recoverableHint, true);
  }
  assert.equal(cls('file_write', refuse, 'edit'), 'policy_blocked');               // disposition 缺失时靠文案
});

test('[C] 读预算/配额耗尽 → policy_blocked,且不宣称可修复(原文就写了别重试)', () => {
  const shapes = [
    // 13k/13l stewardFail:code 在 error 里、人话在 message
    { ok: false, error: 'budget_exceeded', message: 'steward read budget exhausted for this visit (60000 chars, stewardReadBudgetChars); answer from the overview instead of retrying' },
    { ok: false, error: 'quota_exceeded', message: 'steward_thread_read quota exhausted for this turn (6 deep reads); answer from the overview instead of retrying' },
    // observation_recall
    { ok: false, error: 'quota_exceeded', message: 'observation_recall quota exhausted for this turn (8); do not retry the same ref' },
  ];
  for (const shape of shapes) {
    const r = classify('steward_thread_read', shape);
    assert.equal(r.failureClass, 'policy_blocked', JSON.stringify(shape));
    assert.equal(r.recoverableHint, false);
    assert.equal(r.allowedRepair, 'diagnose_only');
  }
});

// ── [D] 找不到 / 歧义 ──────────────────────────────────────────────────────────────────────────────────────
test('[D] not_found / not_in_artifacts / ENOENT → resource_not_found(reacquire_resource)', () => {
  const shapes = [
    ['file_read', { ok: false, error: '文件不存在', code: 'not_found' }, 'read'],                                     // 11-native-tools 读文件
    ['file_list', { ok: false, code: 'not_found', error: '目录不存在: C:\\x', hint: '确认 root 拼写' }, 'read'],        // 12-tool-dispatch
    ['file_read', { ok: false, code: 'not_found', error: '文件或目录不存在', hint: '先用 glob 或 file_list 确认路径' }, 'read'],
    ['file_edit', { ok: false, code: 'not_found', error: '文件不存在', path: 'C:\\x\\a.txt' }, 'edit'],
    ['observation_recall', { ok: false, error: 'not_found', message: 'observation recall failed: ENOENT — the raw snapshot is no longer on disk; do not retry the same rawRef. Re-run the original tool call' }, 'read'],
    ['steward_thread_read', { ok: false, error: 'not_found', message: 'thread s1 not found' }, 'read'],
    ['steward_thread_artifact_read', { ok: false, error: 'not_in_artifacts', message: "that path is not in this thread's delivered files" }, 'read'],
    ['file_read', { ok: false, error: 'ENOENT: no such file or directory, open x' }, 'read'],                          // 非进程结果里的裸 ENOENT
  ];
  for (const [tool, result, tier] of shapes) {
    const r = classify(tool, result, tier);
    assert.equal(r.failureClass, 'resource_not_found', JSON.stringify(result));
    assert.equal(r.allowedRepair, 'reacquire_resource');
  }
});

test('[D] file_edit:oldText 找不到(同样带 code:not_found)与多处匹配 → edit_conflict', () => {
  // 12-tool-dispatch file_edit 的两个真实形状
  const stale = classify('file_edit', { ok: false, code: 'not_found', error: 'oldText was not found', path: 'a.txt' }, 'edit');
  assert.equal(stale.failureClass, 'edit_conflict');
  assert.equal(stale.allowedRepair, 'refresh_then_modify');
  const ambiguous = classify('file_edit', { ok: false, code: 'ambiguous', error: 'oldText appears 3 times; set replaceAll=true', count: 3 }, 'edit');
  assert.equal(ambiguous.failureClass, 'edit_conflict');
  assert.equal(ambiguous.allowedRepair, 'refresh_then_modify');
  // 只认精确的 code,git 之类文案里的 ambiguous 不算
  assert.notEqual(cls('git_log', { ok: false, error: "ambiguous argument 'x': unknown revision" }), 'edit_conflict');
});

// ── [E] 防误伤 ────────────────────────────────────────────────────────────────────────────────────────────
test('[E] 进程结果(非零退出 / 有 stderr)里的 HTTP/验证码/ENOENT 字样不被当成工具级信号', () => {
  const notRemote = [
    { ok: false, code: 1, stderr: 'curl: (22) The requested URL returned error: 403' },
    { ok: false, code: 1, stderr: 'captcha solver crashed: cloudflare module missing' },
    { ok: false, code: 1, stderr: 'Error: ENOENT: no such file or directory, open config.json' },
    { ok: false, code: 2, stderr: 'request blocked', statusCode: 404 },
  ];
  for (const result of notRemote) {
    const r = classify('script_run', result, 'exec');
    assert.equal(r.failureClass, 'execution_failed', JSON.stringify(result));
  }
});

test('[E] 只提到 "blocked"/"captcha" 的普通文本、stderr、hint 不会成为 remote_blocked', () => {
  assert.equal(cls('some_tool', { ok: false, error: 'the item is blocked by a dependency' }), 'unknown');
  assert.equal(cls('some_tool', { ok: false, error: 'plain failure', stderr: 'captcha cloudflare 反爬' }), 'unknown');
  assert.equal(cls('some_tool', { ok: false, error: 'plain failure', hint: 'try a captcha solver' }), 'unknown');
  assert.equal(cls('some_tool', { ok: false, error: 'plain failure', blocked: true }), 'unknown');
  assert.equal(cls('some_tool', { ok: false, error: 'cloudflared tunnel is not configured' }), 'unknown');   // 词边界:cloudflared ≠ cloudflare
});

test('[E] v2 行为不退化:超时/权限/参数/策略/句柄/执行失败', () => {
  assert.equal(cls('file_read', { ok: false, error: 'ETIMEDOUT' }, 'read'), 'transient_read');
  assert.equal(cls('file_edit', { ok: false, error: 'timeout after dispatch' }, 'edit'), 'side_effect_unknown');
  assert.equal(cls('file_read', { ok: false, error: 'required property path is missing' }, 'read'), 'invalid_arguments');
  assert.equal(cls('file_read', { ok: false, code: 'not-allowed', error: '该路径属于应用内部数据，已禁止文件工具访问' }, 'read'), 'policy_blocked');
  assert.equal(cls('shell_send', { ok: false, error: "未知 shellId 'gone'" }, 'exec'), 'resource_not_found');
  assert.equal(cls('script_run', { ok: false, code: 1, stderr: 'Traceback (most recent call last)' }, 'exec'), 'execution_failed');
  assert.equal(cls('some_tool', { ok: false, error: 'tool not found: x. Call tool_search first.', code: 'unknown-tool' }), 'tool_unavailable');
  assert.equal(cls('some_tool', { ok: false, error: 'opaque Z-19' }), 'unknown');
});

test('[E] 产出只含固定枚举、不回显原文;同一输入同一输出', () => {
  const secret = 'C:\\private\\secret-project\\token.txt';
  const result = { ok: false, error: `页面不存在 ${secret}`, failClass: 'http', statusCode: 404, hint: 'hint-secret', stderr: '' };
  const a = classify('web_fetch', result);
  const b = classify('web_fetch', result);
  assert.deepEqual(a, b);
  const serialized = JSON.stringify(a);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('hint-secret'), false);
  assert.deepEqual(Object.keys(a).sort(), ['allowedRepair', 'classifierVersion', 'deterministic', 'disposition', 'evidenceHash', 'failureClass', 'recoverableHint', 'tier']);
  assert.match(a.evidenceHash, /^[0-9a-f]{16}$/);
});

test('[enum] failureClass / allowedRepair 的固定枚举:新类 remote_blocked 配 use_alternative_source', () => {
  const KNOWN_CLASSES = new Set(['transient_read', 'side_effect_unknown', 'policy_blocked', 'remote_blocked', 'permission_denied', 'edit_conflict', 'invalid_arguments', 'resource_not_found', 'tool_unavailable', 'no_progress', 'verification_failed', 'execution_failed', 'unknown']);
  const KNOWN_REPAIRS = new Set(['retry_once', 'stop_for_effect_check', 'use_supported_tool', 'replan', 'use_alternative_source', 'request_authority', 'refresh_then_modify', 'modify_arguments', 'reacquire_resource', 'retrieve_alternative_tool', 'repair_then_verify', 'inspect_error_then_modify', 'diagnose_only']);
  const samples = [
    ['web_fetch', { ok: false, error: '网站拒绝了请求', statusCode: 403 }, 'read'],
    ['web_fetch', { ok: false, error: 'x', failClass: 'reset' }, 'read'],
    ['http_download', { ok: false, error: 'x', failClass: 'reset' }, 'edit'],
    ['file_edit', { ok: false, code: 'ambiguous', error: 'x' }, 'edit'],
    ['file_write', { ok: false, error: '计划模式:请先提交 PLAN: 开头的计划' }, 'edit', 'plan_refused'],
    ['steward_thread_read', { ok: false, error: 'budget_exceeded', message: 'x' }, 'read'],
    ['file_read', { ok: false, code: 'not_found', error: 'x' }, 'read'],
    ['tool_invoke_read', { ok: false, code: 'tier-mismatch', error: 'x' }, 'read'],
    ['some_tool', { ok: false, error: 'opaque' }, 'read'],
  ];
  const seen = new Set();
  for (const [tool, result, tier, disposition] of samples) {
    const r = classify(tool, result, tier, disposition);
    assert.ok(KNOWN_CLASSES.has(r.failureClass), r.failureClass);
    assert.ok(KNOWN_REPAIRS.has(r.allowedRepair), r.allowedRepair);
    seen.add(r.failureClass);
  }
  assert.ok(seen.has('remote_blocked'));
  const remote = classify('web_fetch', { ok: false, statusCode: 403, error: 'x' });
  assert.deepEqual([remote.failureClass, remote.allowedRepair, remote.recoverableHint], ['remote_blocked', 'use_alternative_source', true]);
});

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
