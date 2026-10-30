# M5-B2 R1：两项 P2 窄修，待同 peer 复审

工作区 `C:/Users/87179/.codex/worktrees/m5-bot-progress/ruyi-workbench-oss`，branch `codex/m5-bot-progress`，HEAD/base `2b47f936d26f80c62d779551986ebacb7dc79f71`。原候选30文件、17 protected owner 及原 pins 已逐字节核验并保存到 ignored `.ruyi-runtime/m5-bot-progress-r1-20261030/before/`；原报告、pins、PROTOCOL、独审 packet 及所有旧首红均未改写。未 stage/commit/push、未改版本或其他树。

输入独审：`.ruyi-runtime/m5-bot-progress-peer-20261030/review.json`；其 `review-seal.json` SHA256 `8d954c87680c4b6ad1652b259faf888c67876a18f698657c40e6effa33d43d80`，全部 seal members 验证一致。该轮只报告以下两项确定 P2；其余完整范围及实际验收限制沿用原报告，不把本轮作者验证当独审。

## 精确修复

1. **永久测试不再依赖作者 ignored 基线**。现有 history helper 导出已有 `beforeProgress`，source e2e 从 tracked 当前13w及 tracked inverse spans 还原 payload5，并断言原 SHA256 `b2f8ace6d451c10d4d7248d08979dfd65256be4ab0b67331ded41916a1378e97` 后才求值原 validator。原“旧 reader 拒绝 payload6”断言保留。默认执行无需 ignored 报告、历史 server 或作者目录；显式旧源码反证参数仍只用于重放指定的冻结输入。
2. **查询复用原 public authority 投影**。原 intake 完成同本人/连接/平台/租户/群或会话/类型/controlRevision/指令编号筛选后，调用原 `externalBotPublicItem` 取 execution/delivery 状态，再用原 target 的 identity/window/feedback 事实生成固定查询文本。因此原 owner 已结束、结果写未确认时，查询与本地列表同为 unknown。没有猜测执行进度、提前运行 recovery、新增 store/runtime、权限或结果字段。

原项目、原进度和最终投递 attempt、QQ seq1/seq2、查询自己 reply identity 均保持；恢复只持久化不确定性，不能重跑原业务或重发原进度/最终消息。查询仍是原同一 worker/outbox 下的只读元数据答复。

相对原冻结候选仅6个文件改变，完整精确 before/after hash、numstat 见新 pins 的 `delta`；可直接审 ignored `R0-to-R1.patch`：

| 文件 | R0→R1 |
|---|---|
| `app/src/13w-external-bots.js` | +5/-1；同一 public projection，不改 worker/recovery/发送实现 |
| `external-bots-progress-source.e2e.js` | +37/-3；自足旧 reader、新增完成/最终回执拒写查询控及显式负控入口 |
| `lib/external-bots-source-history.js` | +1/-1；只导出已有 inverse helper |
| `fixtures/external-bots-progress/history.json` | +2/-2；原20个 inverse spans 精确覆盖新13w，原 base hash不变 |
| `app/server.js` | +5/-1；原 build 生成 |
| `app/src/manifest.json` | +45/-45；原 build 回填4行位移 |

上述 app 路径均位于 `ruyi-workbench/`，其余测试路径均位于 `dev-harness/`。其余原24个候选文件及17个 protected 文件逐字节不变，特别是13x、实际 HTTP/browser 入口、UI/四catalog、retention/inventory、原facts601/README、graph/route；无新e2e文件、路由、跨模块依赖或业务schema变化，故不重复事实生成器或无关静态门。

## 本轮已执行的纯验证

全部在本 B2 树显式 cwd 下串行；source/FS 用原 `media-artifact-test-guard.js` 硬拒 child/native/socket。仍是原签名/加密入站、原 M3 encrypted queue、原 worker及原官方 adapter，HTTPS仅VM内合成事件；无HTTP监听、真实provider、engine、浏览器、Python、平台账号或发送。原29个source断言和19个pure断言未弱化。

- **旧 fresh-checkout 负控**：冻结原测试在原精确 ignored-baseline read 拒绝 preload 下，16 PASS 后 ENOENT、exit1；保留独审的同类旧反证及本轮 `portable-negative.stdout.txt`。
- **旧 B2 查询负控2/2**：冻结原13w/13x/13v，用新最小控制复现完成写拒绝→磁盘 running/本地 unknown/冻结 processing，以及平台 ACK 后 final receipt 写拒绝→磁盘 sending/本地 unknown/冻结 sending；随后 recovery 成 unknown，旧查询仍发送旧文本。原业务进入次数分别1、0（后者是明确 durable-writer 正控，不称 engine 成功）。
- **新 source31/31**：在同一精确 ignored-baseline read 拒绝 preload 下全过，包含原29项（owner/revision隔离、keyloss、拒写、QQ窗口、cold pending/sending/final、撤权/关闭进度、取消与最终竞争、retention5/6）和新增2项拒写查询。检查 query accepted 内容与发出的内容均 unknown，original target/control/sourceKey/seq/attempt不变，恢复后仅发送查询一次，businessEntries不增加，也不重发原消息。
- **pure19/19**、原 base 反证 **2/2** 仍过；原 v1/v2/v3/retry-core 历史 hash 不变。
- **build、build --check、graph static16/16** 通过；改动JS及生成server共4件 `node --check` 通过，0模块被parser执行；`git diff --check` 通过。

本轮工具均自然 terminal，没有 live/unknown 原handle。`6a22dc` exit0 是3组负控调度（其中 portability 子件预期exit1）；`d2648d` exit1 是验证脚本先完成 source31/pure19/base2，随后错误地把 build 也套入 native-deny guard，原 build 的已知 `node --check -` 子进程被拒绝，未执行该子进程。原 `build-guard-rejected.stdout.txt` 和该版 runner 保留。核读原build后，按已授权 build/parser 范围执行原 build/check（它们只启动 Node语法parser），`5bdb83` 自然exit0；无需重跑此前已通过的source/pure。不是actual失败或engine执行，也未把首红抹去。

## 交接与未过门

新 packet：`m5-bot-progress-r1-20261030.json`，绑定当前32个候选文件（包含原报告/pins及新报告，排除其自身）、17 protected 文件、原基线和 peer seal、精确6项 delta、必要验证日志及补丁。原首轮候选 pins 故意保持原字节；其中6个旧hash是历史输入，不代表当前输出。

先由原非作者 peer 窄复审两项修复及必要回归，接受后由 Root 给 Terra 独占窗口。永久 actual 入口仍按原顺序：`node dev-harness/external-bots-control.e2e.js`、`node dev-harness/external-bots.browser.e2e.js` 各两 fresh 串行，再由 Root 选择原B1/privacy/retry/retention/cold相关门。本轮这两个入口原字节未变，只保留已准备状态，未执行。真实平台仍无条件和授权；未运行目录 unit/run-all、没有PID/CIM/系统清理，未称actual accepted、whole M5或3.1 ready。
