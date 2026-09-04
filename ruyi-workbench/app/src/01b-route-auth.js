// 01b-route-auth.js - 110-2a: 从 01-config.js 搬出的 ROUTE_AUTH 路由鉴权表(纯搬家,零行为变更)。
const ROUTE_AUTH = [
  // open: 低敏读(host 门已过,无 token 需求)
  { m: 'GET', p: '/api/status', auth: 'open' },
  { m: 'GET', p: '/api/capabilities', auth: 'open' },
  { m: 'GET', p: '/api/models', auth: 'open' },
  // 47c(S1):bootstrap 握手 —— 浏览器拿 token 的【唯一】通道(HTML 不再明文下发)。open 级的安全性 =
  // 顶层 host 门(rebinding 的 Host 是攻击域,直接被拒)+ 与旧 GET / 明文下发完全同等的信任面。
  { m: 'POST', p: '/api/bootstrap', auth: 'open' },
  // body-token: MCP 子进程 / 跨源 loopback(handler 自查 body token,豁免 originOk)
  { m: 'POST', p: '/api/permission/request', auth: 'body-token' },
  { m: 'POST', p: '/api/question/request', auth: 'body-token' },
  { m: 'POST', p: '/api/todo', auth: 'body-token' },
  { m: '*', p: '/api/mission', auth: 'body-token' },
  // 第70波(EC-E):/api/missions 聚合只读投影 —— 内容型 GET,与 /api/sessions 同门(token-browser)。
  { m: 'GET', p: '/api/missions', auth: 'token-browser' },
  { m: 'GET', p: '/api/missions/', auth: 'token-browser', prefix: true },
  // 第75b波:统一跨会话决策契约。批准/物化可触发高风险动作,始终要求 header token;
  // handler 再校验 missionId/interventionId 归属与 expectedVersion CAS。
  { m: 'POST', p: '/api/missions/', auth: 'token', prefix: true },
  // 第71波(EC-E):/api/interventions/:sessionId 只读派生 -- 内容型 GET,同 /api/missions 门(token-browser)。
  { m: 'GET', p: '/api/interventions/', auth: 'token-browser', prefix: true },
  // 第56波(Pretender 立项门):/api/interventions 全局「需要你」聚合 -- 内容型 GET,同门(token-browser)。
  // (前缀条目带尾斜杠,按 startsWith 匹配不到本裸路径,两条不冲突。)
  { m: 'GET', p: '/api/interventions', auth: 'token-browser' },
  { m: 'POST', p: '/api/agent-workflow/launch', auth: 'body-token' },
  // token-browser: 敏感内容型 GET + UI 变更型(浏览器须 token;loopback 非浏览器须同源,无需 token)
  { m: 'GET', p: '/api/sessions', auth: 'token-browser' },
  { m: 'GET', p: '/api/sessions/', auth: 'token-browser', prefix: true },
  { m: 'GET', p: '/api/skills', auth: 'token-browser' },
  { m: 'GET', p: '/api/agent-roles', auth: 'token-browser' },
  { m: 'GET', p: '/api/agent-workflows', auth: 'token-browser' },
  { m: 'GET', p: '/api/playbooks', auth: 'token-browser' },
  { m: 'POST', p: '/api/chat/stream', auth: 'token-browser' },
  { m: 'POST', p: '/api/upload', auth: 'token-browser' },
  // 图片/附件回显:聊天里已发送附件的原字节只读读取。内容型 GET,token 级同 /api/file/preview;
  // handler 内再做 uploads 目录 realpath 包含校验(只服务 makeAttachmentRecord 写下的文件)。
  { m: 'GET', p: '/api/upload/content', auth: 'token' },
  { m: 'POST', p: '/api/sessions', auth: 'token-browser' },
  { m: 'POST', p: '/api/sessions/', auth: 'token-browser', prefix: true },
  { m: 'PATCH', p: '/api/sessions/', auth: 'token-browser', prefix: true },
  { m: 'DELETE', p: '/api/sessions/', auth: 'token-browser', prefix: true },
  { m: 'POST', p: '/api/session/skills', auth: 'token-browser' },
  // v2.5: 删除用户技能(写盘 paths.skills/<id>)。token 级同 /api/mcp/connectors DELETE(配置变更)。
  { m: 'DELETE', p: '/api/skills', auth: 'token' },
  { m: 'POST', p: '/api/session/memories', auth: 'token-browser' },
  { m: 'POST', p: '/api/memory', auth: 'token-browser' },
  { m: 'POST', p: '/api/memory/', auth: 'token-browser', prefix: true },
  { m: 'DELETE', p: '/api/memory/', auth: 'token-browser', prefix: true },
  { m: 'POST', p: '/api/stop', auth: 'token-browser' },
  { m: 'POST', p: '/api/provider/compact', auth: 'token-browser' },
  { m: 'POST', p: '/api/agent/compact', auth: 'token-browser' },
  { m: 'GET', p: '/api/kimi/status', auth: 'token-browser' },
  { m: 'POST', p: '/api/permission/decision', auth: 'token-browser' },
  { m: 'POST', p: '/api/chat/answer', auth: 'token-browser' },
  // 提问续时心跳:弹窗打开期间前端周期调用,把挂起提问的超时重新上满(打字多也不被掐断)。
  { m: 'POST', p: '/api/question/heartbeat', auth: 'token-browser' },
  // origin: UI 变更但仅同源基线(现状保持,不收紧)
  // token: 始终 tokenOk(敏感变更 + 内容型 GET,handler 多有自查作纵深)
  { m: 'POST', p: '/api/tools/', auth: 'token', prefix: true },
  { m: 'POST', p: '/api/config', auth: 'token' },
  { m: 'POST', p: '/api/provider/test', auth: 'token' },
  { m: 'POST', p: '/api/workspace/resolve', auth: 'token' },
  { m: 'POST', p: '/api/pick-folder', auth: 'token' },
  { m: 'POST', p: '/api/pick-file', auth: 'token' },  // 第53波 EC-B(53d):原生文件选择器(选 overlay zip)
  { m: 'POST', p: '/api/plan/decision', auth: 'token' },
  { m: 'POST', p: '/api/steer', auth: 'token' },
  { m: 'DELETE', p: '/api/steer', auth: 'token' },
  { m: 'POST', p: '/api/session/rewind', auth: 'token' },
  { m: 'POST', p: '/api/checkpoints/', auth: 'token', prefix: true },
  { m: 'POST', p: '/api/file/reveal', auth: 'token' },
  { m: 'POST', p: '/api/mcp/import-folder', auth: 'token' },
  // 48c:MCP 配置导入器(scan 发现+冲突检测 / apply 勾选写回),token 级同 import-folder。
  { m: 'POST', p: '/api/mcp/import-config/scan', auth: 'token' },
  { m: 'POST', p: '/api/mcp/import-config/apply', auth: 'token' },
  // 第55波 EC-C(55a):MCP 运维闭环 -- 统一连接器读模型 + 健康探针。token 级(只读清单 + 探针,不改配置)。
  { m: 'GET', p: '/api/mcp/connectors', auth: 'token' },
  { m: 'POST', p: '/api/mcp/connectors/health', auth: 'token' },
  // 55b:启停/删除持久化 -- 写配置路径,token 级同 import/apply。
  { m: 'POST', p: '/api/mcp/connectors/toggle', auth: 'token' },
  { m: 'DELETE', p: '/api/mcp/connectors', auth: 'token' },
  { m: 'POST', p: '/api/playbooks/draft', auth: 'token' },
  { m: 'POST', p: '/api/playbooks', auth: 'token' },
  { m: 'POST', p: '/api/playbooks/', auth: 'token', prefix: true },
  { m: 'DELETE', p: '/api/playbooks/', auth: 'token', prefix: true },
  { m: 'POST', p: '/api/agent-roles', auth: 'token' },
  { m: 'POST', p: '/api/agent-workflows', auth: 'token' },
  { m: 'POST', p: '/api/agent-workflows/', auth: 'token', prefix: true },
  { m: 'DELETE', p: '/api/agent-workflows/', auth: 'token', prefix: true },
  { m: 'POST', p: '/api/autonomy/', auth: 'token', prefix: true },
  { m: '*', p: '/api/autonomy/grants', auth: 'token' },
  { m: 'POST', p: '/api/agent-runs/', auth: 'token', prefix: true },
  { m: 'DELETE', p: '/api/agent-runs/', auth: 'token', prefix: true },
  { m: 'GET', p: '/api/agent-runs', auth: 'token', prefix: true },
  // R4关系/维护读取会返回项目记忆 id、来源与绝对作用域信息；与 /api/memory 同属敏感内容型 GET。
  { m: 'GET', p: '/api/memory/relations', auth: 'token' },
  { m: 'GET', p: '/api/memory/maintenance', auth: 'token' },
  { m: 'GET', p: '/api/memory', auth: 'token' },
  { m: 'GET', p: '/api/memory/item', auth: 'token' },
  { m: 'GET', p: '/api/usage/summary', auth: 'token' },
  { m: 'GET', p: '/api/ops/metrics', auth: 'token' },
  { m: 'GET', p: '/api/checkpoints', auth: 'token' },
  { m: 'GET', p: '/api/checkpoints/', auth: 'token', prefix: true },
  { m: 'GET', p: '/api/file/preview', auth: 'token' },
  // 118a-fix: 应用内手册阅读器的取文端点。只服务源码里写死的白名单文档(docs/manuals/*),
  // 客户端只能传 id/lang 两个受控枚举,永不把用户输入拼进文件路径;token 级同 /api/file/preview。
  { m: 'GET', p: '/api/help/doc', auth: 'token' },
  { m: 'GET', p: '/api/audit', auth: 'token' },
  { m: 'GET', p: '/api/storage/summary', auth: 'token' },
  { m: 'POST', p: '/api/storage/policy', auth: 'token' },
  { m: 'POST', p: '/api/storage/clean', auth: 'token' },
  { m: 'GET', p: '/api/metrics', auth: 'token' },
  // 第53波 EC-B(53b): overlay 离线更新 -- 破坏性档(同 checkpoints/rollback),token 级把门。
  { m: 'POST', p: '/api/overlay/precheck', auth: 'token' },
  { m: 'POST', p: '/api/overlay/apply', auth: 'token' },
  { m: 'GET', p: '/api/overlay/status', auth: 'token' },
  { m: 'POST', p: '/api/overlay/rollback', auth: 'token' },
  // 75a-2: test-only CAS primitive probe (failure-injection matrix). token-gated (ROUTE_AUTH -> 403) AND
  // env-gated in handler (RUYI_TEST_HOOKS=1 -> 404 when off). No mutation in production. Not user-facing.
  { m: 'POST', p: '/api/_test/intervention-cas', auth: 'token' },
  { m: 'POST', p: '/api/_test/pretender-maintenance', auth: 'token' },
];
