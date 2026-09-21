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
  // 第 116 波 116g(§3.1 事项跨会话升格):事项容器的写面。新建事项是裸路径 POST(上面那条 GET 是
  // 精确匹配、下面那条 POST 是带尾斜杠的前缀,两条都盖不到它),PATCH 走既有的方法改写双通道 ——
  // 原生 PATCH 由这条前缀条兜,POST + x-http-method:PATCH 由下面那条 POST 前缀条兜。写面一律 token 级。
  { m: 'POST', p: '/api/missions', auth: 'token' },
  { m: 'PATCH', p: '/api/missions/', auth: 'token', prefix: true },
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
  // 113b: 会话内容搜索。比 /api/sessions 严一档（token 而非 token-browser）：它返回的是会话正文摘录，
  // 不只是列表元数据。须排在下面 '/api/sessions/' 前缀条之前，否则会被它先匹配。
  { m: 'GET', p: '/api/sessions/search', auth: 'token' },
  { m: 'GET', p: '/api/sessions/', auth: 'token-browser', prefix: true },
  { m: 'GET', p: '/api/skills', auth: 'token-browser' },
  { m: 'GET', p: '/api/agent-roles', auth: 'token-browser' },
  { m: 'GET', p: '/api/agent-workflows', auth: 'token-browser' },
  { m: 'GET', p: '/api/playbooks', auth: 'token-browser' },
  { m: 'POST', p: '/api/chat/stream', auth: 'token-browser' },
  // 第121波 K2a(34 号文 §6.1):服务端推送(SSE)。与上面那条写流【同档】—— 它下发的是同一批
  // 会话事实(哪条线程在跑、在调什么工具、有什么等你),只是方向反过来。浏览器须带 token;
  // 非浏览器 loopback 须同源。**后果**:`EventSource` 不能设请求头,所以客户端(K2b)要用
  // fetch + ReadableStream 读这条流(前端本来就是这么发 /api/chat/stream 的),不用 EventSource。
  { m: 'GET', p: '/api/events/stream', auth: 'token-browser' },
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
  // 127-114b(26 号文 §3): ASR 语音转写 —— 全波唯一出网面(用户音频字节出网到所配 ASR 端点),
  // 写面且内容敏感,一律 token 级(不给 token-browser,与 /api/steward/* 同一档)。
  { m: 'POST', p: '/api/audio/transcribe', auth: 'token' },
  // 130(51 号文 §2.3):实时识别的代理路由(开会话／喂音频／收尾／关会话)—— 同一条出网面的流式形,同档 token 级。
  { m: 'POST', p: '/api/audio/stream/sessions', auth: 'token', prefix: true },
  { m: 'DELETE', p: '/api/audio/stream/sessions/', auth: 'token', prefix: true },
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
  // 127-A-S02:自然语言服务入口匹配 —— 只读计算(评既有清单,零持久化),与 GET /api/playbooks 同档
  // token-browser;必须排在下一条 /api/playbooks/ 前缀 token 规则【之前】,否则被它抢先吞成 token 级。
  { m: 'POST', p: '/api/playbooks/service-match', auth: 'token-browser' },
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
  // 118d: 帮助菜单的两条真动作通道。
  //   open-path:只接受 data/logs/workspace/manuals 四个源码枚举,绝不接受客户端传路径,
  //             服务端映射到绝对目录后用 /api/file/reveal 同款方式打开资源管理器;token 级同 file/reveal。
  //   logs/tail:只读工作台自己的当天日志尾部(行数上限 2000),路径来自服务端常量;token 级同 /api/audit。
  { m: 'POST', p: '/api/open-path', auth: 'token' },
  { m: 'GET', p: '/api/logs/tail', auth: 'token' },
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
  // 第116波116b(27号文§11.3): 管家收件箱。start/stop 是控制面(起停后台轮询),state/inbox 返回跨会话
  // 的待决与失败摘要 —— 内容敏感度同 /api/audit 与 /api/missions 的写面,一律 token 级(不给 token-browser)。
  { m: 'POST', p: '/api/steward/start', auth: 'token' },
  { m: 'POST', p: '/api/steward/stop', auth: 'token' },
  { m: 'GET', p: '/api/steward/state', auth: 'token' },
  { m: 'GET', p: '/api/steward/inbox', auth: 'token' },
  // 第116波116f(27号文§11.3): 管家回合与到访。visit 会归档并清空管家对话、message 直接起一个管家回合、
  // act 替用户执行一条按钮 —— 三条都是写面,内容敏感度同上,一律 token 级(不给 token-browser)。
  { m: 'POST', p: '/api/steward/visit', auth: 'token' },
  { m: 'POST', p: '/api/steward/message', auth: 'token' },
  { m: 'POST', p: '/api/steward/act', auth: 'token' },
  // 第117波117l(27号文§11.9 D2): 递话通道的单口。抽屉「直接对这条线程说」与问答卡的自由回答都走它;
  // 它会按目标线程状态选「答/批/插/新」四条通道之一,写面(能回答一条待决、能起一个回合),token 级。
  { m: 'POST', p: '/api/steward/relay', auth: 'token' },
  // 第116波116-pre(27号文§8.12/§11.1第3项/§11.3): 递话预判 — 只读、零模型、不写盘,内容敏感度同上
  // (透出线程标题/最后一句原话),一律 token 级(不给 token-browser)。
  { m: 'GET', p: '/api/steward/preroute', auth: 'token' },
  // 116h(27 号文 §3.1 116h 行 / §8.10):线程间仲裁的只读状态与插队。
  { m: 'GET', p: '/api/steward/arbiter', auth: 'token' },
  { m: 'POST', p: '/api/steward/arbiter/prioritize', auth: 'token' },
  // 第116波116-2e(27号文§4「面板」): 管家记忆面板。读面透出的是「管家记得的关于你」的全部原文
  // (身份/偏好/习惯),写面能改能清 —— 敏感度同上,六条一律 token 级(不给 token-browser)。
  { m: 'GET', p: '/api/steward/memory', auth: 'token' },
  { m: 'GET', p: '/api/steward/memory/export', auth: 'token' },
  { m: 'POST', p: '/api/steward/memory/edit', auth: 'token' },
  { m: 'POST', p: '/api/steward/memory/veto', auth: 'token' },
  { m: 'POST', p: '/api/steward/memory/restore', auth: 'token' },
  { m: 'POST', p: '/api/steward/memory/clear', auth: 'token' },
  // 第117波117e第0步(27号文§8.6「行动流水」): 管家决策日志的只读面。透出的是「管家替你做过什么」
  // 的全部依据(目标线程、线程权限、undoRef、费用) —— 敏感度同记忆面板,token 级(不给 token-browser)。
  { m: 'GET', p: '/api/steward/decisions', auth: 'token' },
  // 第123波 M1(37 号文 §3.3;设计权威 29 号文 §10 红线三「任务定义只能由 token 级 API 或管家工具写入」):
  // 定时任务六条。**一律 token,一条 body-token 都不给** —— body-token 是 MCP 子进程与跨源 loopback 的档,
  // 那条路上的调用方是【模型驱动的子进程】;让它写得动任务定义,等于把「以后每天替我做这件事」
  // 这种最长效的授权交给一次工具调用。读面也不给 token-browser:任务定义里带着载荷正文与目标线程,
  // 敏感度同 /api/steward/*。
  // 六条的形状:两条精确(裸路径的读与建)+ 四条带尾斜杠的前缀(改/删/立即运行/最近几次)。
  // 前缀条盖不到裸路径(startsWith 带尾斜杠),所以两组不冲突,顺序也不敏感。
  { m: 'GET', p: '/api/scheduler/tasks', auth: 'token' },
  { m: 'POST', p: '/api/scheduler/tasks', auth: 'token' },
  // GET 前缀 = /api/scheduler/tasks/:id/runs;POST 前缀 = /:id/run-now 与方法改写(x-http-method)双通道。
  { m: 'GET', p: '/api/scheduler/tasks/', auth: 'token', prefix: true },
  { m: 'POST', p: '/api/scheduler/tasks/', auth: 'token', prefix: true },
  { m: 'PATCH', p: '/api/scheduler/tasks/', auth: 'token', prefix: true },
  { m: 'DELETE', p: '/api/scheduler/tasks/', auth: 'token', prefix: true },
  // 75a-2: test-only CAS primitive probe (failure-injection matrix). token-gated (ROUTE_AUTH -> 403) AND
  // env-gated in handler (RUYI_TEST_HOOKS=1 -> 404 when off). No mutation in production. Not user-facing.
  { m: 'POST', p: '/api/_test/intervention-cas', auth: 'token' },
  { m: 'POST', p: '/api/_test/pretender-maintenance', auth: 'token' },
];
