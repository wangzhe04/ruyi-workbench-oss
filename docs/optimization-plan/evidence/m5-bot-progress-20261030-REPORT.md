# M5-B2 内部候选：进度、主动查询、本地待发；待非作者独审

工作区 `C:/Users/87179/.codex/worktrees/m5-bot-progress/ruyi-workbench-oss`，branch `codex/m5-bot-progress`，base/HEAD `2b47f936d26f80c62d779551986ebacb7dc79f71`。未 stage/commit/push，版本仍3.0.1。旧 T、组合 W/T、MAIN 及其他树未修改。本片交付完整内部候选，不称真实平台、实际 API/browser 或整个 M5/3.1 已验。

## 实现切片

- **原13w intake/ledger**：现有 owner 绑定连接增加可选“开始处理提示”，默认关闭。仅开启或首次只读查询才升级 business payload6；M3 queue 文件、purpose、recordId、scope/AAD schema1、严格缓存外读取、原状态链均不变。旧 payload1–5 兼容读取，旧 reader 必须整体拒绝6。新记录冻结原消息 sentAt、最多一个 progress 投递槽、最终 QQ 序号、最多130个持久发送预留；不建第二个 store/runtime。
- **原 worker**：登记原业务后，在该原 run 的等待期间只处理原 outbox 的进度／查询／最终答复，不能开始第二条业务。一个 busy owner、一个业务 promise、一个可唤醒等待、一个有界唤醒 timer；未发出的开始提示在业务结束或 cold unknown 时明确退休，不能永久伪装“等待发送”。进度发送不覆盖业务或最终投递结果。
- **只读查询**：精确“进度”“查询进度”或 `/status`（可带指令编号）读取同 owner、连接、平台、租户、会话、会话类型、controlRevision 下的原项。无匹配仅返回通用说明，不暴露其他项。不会调用模型或新执行业务，错误的显式查询参数也不降格成新指令。普通非查询消息保持原路。
- **原13x delivery/M2-6**：继续固定官方 HTTPS host/path、原 token、完整原文先投影再裁剪、token 后权威重验、原提交 latch。B2 的进度／final QQ 序号固定1/2；旧无进度答复仍1。飞书保持原 reply/uuid，每个持久 attempt 唯一。源绑定增加 B2 intent/seq 证据；无 feedback 的旧 B1 绑定不变。超窗先保持本地 pending，不切换主动/召回；失回执、持久结果不确定、重启均保 unknown，不重跑业务。
- **预算**：复用原1000正文行、40MiB、128人工重试及永久回执容量。B2 产品预算为12/app/min、6/chat/min、1/chat/sec；预留由原控制身份聚合，删除连接不能重置。平台429/Retry-After 可延后，未决 progress 不可回收。payload6 还在提交前核 pretty-byte 的旧 OFF reader 容量，不能 ACK 一份随后读不了的明文 ledger。
- **retention交叉**：原 commit 改为不降级 payload6；无 progress 旧路径仍升5。确认后的进度/seq/reservations保留在原永久 receipt；pending/sending/unknown progress 不具回收资格。没有自动正文回收。配置关闭进度会阻断未提交进度，不撤销原业务或已确认 final。
- **原面板**：双语进度 checkbox、兼容性说明、指令编号、只读查询说明和本地等待/超窗/节流原因；接受、执行、发送三态与 progress 回执并列。没有新 app、凭据入口、远程待决动作 C 或权限绕过。

API 复用原 connections/callback/inbox/deliveries/retention，无新增 HTTP 路由。未修改02/03c/09/10/13s、13v协议验证、13y凭据、13z身份发现或原 PrivacyGateway 实现；pins 绑定这些未改 owner。

## 官方协议边界

[PROTOCOL](m5-bot-progress-20261030-PROTOCOL.md) 保留2026-10-30核验日期、精确官方 URL、QQ 同页60分钟顶部与5分钟字段冲突及保守交集。QQ 群/单聊均可自动发合法被动提示；无主动/召回能力兜底。飞书官方页面正文在工具中为空，官方组织 reply 参考可验证 endpoint/身份/幂等用途，但不是租户数值配额证明。本地预算不是平台 quota。没有请求真实账号、密钥、回调或联系人授权，也没有真实发送。

## 已执行的内部验证

| 范围 | 结果与限制 |
|---|---|
| `external-bots-progress-source.e2e.js` | **29/29**。真实 QQ/飞书签名/加密入站、原 M3 加密 queue、原 worker/发送/权威与投影 continuation、原13x HTTPS请求字节、合成响应及 durable receipt。HTTPS是VM内 EventEmitter/stream，无 socket/listener。Steward仅到受控 host boundary 并保持原 promise；最终拒绝为 unknown，不伪造 engine 执行成功。 |
| 新 `.static.e2e.js` | **19/19**。真实 helper/checkbox edit-save/render、固定查询语言、5分钟边界、持久预算/删连接、读容量、双语及精确旧历史 hash。无 store/socket/engine 能力。 |
| 旧源码反证 | **2/2**：原 signed `/status` 被当新业务排队；原 adapter 忽略后续序号仍发 QQ seq1。不是旧产品通过。 |
| cold/并发/不确定 | 独立 cold VM 读同一原密文，pending/sending/final 三阶段；lost ACK、提交已落但返回错误、结果拒写、token await撤权/关闭进度、final取消；旧业务/进度不重放。 |
| retention | 实际原 owner FS 覆盖无progress→5、有progress保持6、未决progress不可回收、原永久receipt保seq/attempt、拒写不ACK和正文回收后原去重。正控的业务结果只经 durable writer 构造，不称执行业务成功。 |
| build/parser | 原 build 和 --check 通过；改动JS11个、0语法失败、0被parser执行的模块。实际HTTP/browser件仅解析。 |
| 静态/生成物 | graph125/863/1SCC、原策略不变；route192/179/0告警；i18n、77项durable inventory及 diff --check 通过。route仅新增 browser 的 QQ callback 测试关联，无鉴权/路由扩展。 |
| facts/README | 初期机械count预览已保存、恢复base原facts后由**原官方generator**覆盖。Root授权的新隔离HOME/两AppData/RUYI_HOME，既有 `media-artifact-test-guard.js` 硬拒native/socket，原generator与原facts静态均exit0。599→601，仅新source/static两件；默认592→594，unit415/smoke25/live7不变。原ACC venv不存在，108是保留值，不是活probe验收；native121经受guard保护的原导出重算。中英README对齐。这些是入口数量，不是601件已全部运行。 |

源证明使用明确的 credential/disclosure processor 边界替身，只验证原 caller 的接收人/用途/源/完整投影与提交装配；**不代替真实 M2-6 processor、HTTP、provider、browser 或平台验收**。未运行 run-all、--fast 或目录 unit。只读官方文档研究另行获准，不等于真实消息请求。

原B1实际入口的旧断言保留：HTTP原行全保留，仅追加新marker/新case；browser仅扩展import并在所有旧case之后追加。新20个有界 inverse spans 精确恢复base13w SHA `b2f8ace6d451c10d4d7248d08979dfd65256be4ab0b67331ded41916a1378e97`，让原v1/v2/v3及retry-core历史合同保持原hash，未改旧history/contracts或弱化断言。

## 永久 actual 入口：已准备，未执行

1. `node dev-harness/external-bots-control.e2e.js`：原隔离HOME/AppData、原fakeProvider及synthetic official HTTPS；旧B1所有case后，QQ/飞书分别走真实callback→原provider held→自动progress→同项/status（provider调用不增加）→释放**同一个原请求**→final独立seq/uuid→实际进程cold及去重。原预算与原回收方式保留。
2. `node dev-harness/external-bots.browser.e2e.js`：原真实浏览器/服务fixture；旧case后，自然新建QQ连接、聚焦/勾选进度、原owner确认。真实旧时间戳callback仍接受并处理，原worker自然产生本地pending/超窗；中英面板检查与截图，不seed ledger，不fake该状态API。

先非作者独审最终pins；接受后由Root给Terra独占窗口，上述两件各两fresh串行，再选择原 bot control/work-data/privacy/retry/retention/cold/浏览器相关回归。不得因为文件名 static/source 自动推断可运行整目录。真实平台专用账号、权限、回调和测试会话仍另需具体授权；全3.1、W/T组合和C不在此候选验收结论内。合并W/T时按源码重建共同server/manifest/facts，不能覆盖组合生成物。

## 首次失败与封口

完整细节见 ignored `execution-notes.json`：source首次6501df/67d5e4是fixture把knownSecrets误纳入绑定、导致发送前拒绝；改为真实binding合同后过。354c60在11控后暴露 token等待跨窗返回predispatch，已修产品重验顺序。111faa新UI断言误用旧文案同义词，修为原catalog label，未改产品标签。原66857自然exit1（route静态18过/2生成物漂移红），原输出保留；原53833仅poll到自然exit0。最终60037e/source29/pure19自然exit0，fixture收尾后又由016212确认原send promises均持有并等待，原引用收尾，无失联进程或未知 cleanup。

没有 PID/CIM/commandline扫描、真实系统/平台/用户数据处理、native/engine/browser执行、版本修改或提交。前任务所有 unknown/首红不被本片覆盖。源码与必要生成物现在冻结，待独审；不因内部绿灯省略后续实际门。
