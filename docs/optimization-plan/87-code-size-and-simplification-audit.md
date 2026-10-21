# 87 · 代码规模与合理精简审计

日期：2026-10-21。基线：`master` / `f5223548b74b62b2eefe548c39b33ab5fadd91e3`（3.0.1）。本审计只读源码、测试和已有架构约束；只新增本文，未修改实现、移动测试或运行全量回归。并行进行的文档归档不纳入基线统计。本文是精简候选与实施门槛，不是功能已完成或测试已通过的证明。

## 结论

第一方运行时代码是 **203 个文件、148,824 物理行**；加上构建与开发工具为 **211 个文件、150,342 行**。这是一套已经较大的应用，但不能用整个仓库的 677,205 行指称生产代码：其中有测试、夹具、文档、独立 ACC 组件和重复聚合的生成物。

确有重复基础设施和多个职责集中在大文件的问题；目前证据不足以认定隐私保护整体“过度防御”。隐私、凭据、恢复、相关设置/API 的十个直接模块合计 3,181 行，仅占运行时代码 2.14%（不含散布在引擎/工具中的接线，也不是这次功能的增量）。`01h-privacy-core.js` 为 512 行，真正值得分层的是 1,214 行的 `03a-privacy-gateway.js`。优先合并共同机制，保留权限、持久化、跨作用域与不可逆操作边界。

用户确定的 3.1 范围仍需完成：全链路脱敏、工作数据加密、外部机器人、全文分片索引、线程接力和定时模板。以下精简应帮助这些功能共用边界，不能以删除保护或宣称暂不支持来抵消这一范围。总体功能与发布安排由同期 86 号总计划统一维护。

## 统计口径与结果

统计对象是该 Git 提交的 tracked blobs，**不是本机递归扫盘**。`.git`、`node_modules`、`dist`、worktrees、运行时目录、被忽略的实弹输出均不进入对象集合；独立 `mcp/ai-computer-control/` 与 vendor 另列。`server.js` 是 manifest 拼接产物，不与 `app/src` 重复计入第一方运行时代码。二进制计文件、不计文本行。

“物理行”是原始字节的 `splitlines()` 数量；“非空行”只去除空白行，**仍含注释、字符串内嵌程序和声明，不能叫有效逻辑行/SLOC**。CSS、HTML、PowerShell、C#、Python、启动脚本也属于运行时范围。Minified vendor 的行数与维护成本不可直接比较。

| 分类（互斥） | 文件 | 物理行 | 非空行 |
|---|---:|---:|---:|
| 第一方运行时代码 | 203 | 148,824 | 144,499 |
| 构建/开发工具代码 | 8 | 1,518 | 1,439 |
| dev-harness 代码（测试、公共夹具、生成器、手动探针） | 931 | 199,827 | 189,127 |
| dev-harness 非代码夹具/证据 | 62 | 48,597 | 48,522 |
| 可再生成聚合/清册 | 12 | 164,916 | 162,687 |
| 文档、文档目录中的证据/原型 | 250 | 70,852 | 60,476 |
| 独立 ACC 组件（整体排除主应用规模） | 86 | 24,500 | 21,341 |
| 第三方 vendor（含 rg.exe、WebView2Loader.dll） | 7 | 4,875 | 4,515 |
| package-lock（依赖清单，不是实现） | 1 | 2,095 | 2,095 |
| 其他配置/资源/仓库自动化 | 37 | 11,201 | 11,135 |
| 其他二进制资产 | 2 | 0 | 0 |
| 总计 | 1,599 | 677,205 | 645,836 |

构建/开发八件是 `app/build.js`、`tools/{fake-claude.js,dev-serve.cmd,build-overlay.js,gen-manifest.js,package-offline.ps1}`、`desktop/{build-icon.ps1,build-desktop.ps1}`。运行时工具如 `external-bot-gateway.js`、安装/启动/overlay 管理脚本仍计入运行时，不能按 tools 目录整体当冗余删除。

生成物 164,916 行的组成：`app/server.js` 90,324；`app/src/module-contracts.json` 28,823；依赖图 JSON/MD 37,887；路由清册 JSON/MD 6,327；持久化清册 JSON/MD 1,035；架构快照 JSON/MD 471；`facts.json` 24；`offline-manifest.json` 25。后端源模块本身为 87 件、90,238 行，生产聚合物行数比它多是构建包装造成的，不能视为另一套实现。

dev-harness 的 199,827 行是比“测试断言”更宽的口径：其中 `unit/` 278 件/48,585 行、`lib/` 30 件/2,673 行、`privacy-31/` 12 件/1,731 行；根目录正式 `*.e2e.js` 有 539 件，含需外部条件的 live 件。测试代码/运行时代码约 1.34 倍，不能由此推导测试多余；大部分行为边界有多入口和恢复时序需要覆盖。

### 可复现统计

在仓库根目录将下面 Python 代码经 `python -X utf8` 执行。只读 Git 对象，不初始化应用、不读取用户配置、不写统计文件；生成器固定清单与分类顺序是本次统计的一部分。

```python
import collections, pathlib, subprocess

ref = 'f5223548b74b62b2eefe548c39b33ab5fadd91e3'
paths = [p for p in subprocess.check_output(
    ['git', 'ls-tree', '-rz', '--name-only', ref]).decode().split('\0') if p]
proc = subprocess.Popen(['git', 'cat-file', '--batch'],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE)
data, _ = proc.communicate(''.join(ref + ':' + p + '\n' for p in paths).encode())
code = {'.js', '.mjs', '.cjs', '.py', '.cs', '.ps1', '.cmd', '.sh', '.bat', '.html', '.css'}
binary_ext = {'.png', '.jpg', '.gif', '.exe', '.dll', '.ico', '.zip', '.gz',
              '.woff', '.woff2', '.ttf', '.pdf'}
generated = {'ruyi-workbench/app/server.js', 'facts.json',
             'ruyi-workbench/resources/offline-manifest.json',
             'ruyi-workbench/app/src/module-contracts.json'}
tooling = {'ruyi-workbench/' + p for p in (
    'app/build.js', 'tools/fake-claude.js', 'tools/dev-serve.cmd',
    'tools/build-overlay.js', 'tools/gen-manifest.js', 'tools/package-offline.ps1',
    'desktop/build-icon.ps1', 'desktop/build-desktop.ps1')}
totals = collections.defaultdict(lambda: [0, 0, 0])
cursor = 0
for p in paths:
    end = data.index(b'\n', cursor)
    size = int(data[cursor:end].split()[-1])
    raw = data[end + 1:end + 1 + size]
    cursor = end + 2 + size
    q = pathlib.PurePosixPath(p)
    binary = b'\0' in raw or q.suffix.lower() in binary_ext
    lines = [] if binary else raw.splitlines()
    if any(x in p.split('/') for x in ('.git', 'node_modules', 'dist', 'worktrees', '.worktrees')):
        group = 'excluded-build-deps'
    elif p.startswith('mcp/ai-computer-control/'):
        group = 'separate-ACC'
    elif '/vendor/' in p or '/vendor-bin/' in p or p.endswith('WebView2Loader.dll'):
        group = 'vendor'
    elif p in generated or (p.startswith('docs/architecture/')
          and q.suffix in {'.json', '.md'} and q.stem != 'source-text-locks'):
        group = 'generated'
    elif p.endswith('package-lock.json'):
        group = 'dependency-lock'
    elif p.startswith('dev-harness/'):
        group = 'tests' if q.suffix.lower() in code else 'test-fixtures-evidence'
    elif q.suffix.lower() in {'.md', '.txt'} or p.startswith('docs/'):
        group = 'docs-evidence'
    elif q.suffix.lower() in code and p.startswith('ruyi-workbench/'):
        group = 'build-dev-tooling' if p in tooling else 'first-party-runtime'
    elif binary:
        group = 'binary-assets'
    else:
        group = 'config-resources-other'
    row = totals[group]
    row[0] += 1
    row[1] += len(lines)
    row[2] += sum(bool(line.strip()) for line in lines)
for group, row in totals.items():
    print(group, *row)
```

本脚本是基线专用，不应在未来新增架构手写文档后继续按目录后缀猜生成物；届时应更新显式生成物清单再重算。

## 约束与热点

遵循 `CONTRIBUTING.md` 五条约束：离线、后端零 npm 运行时依赖、clean-room、Windows 优先、行为变更附 e2e；遵循 `CLAUDE.md` 的 manifest 构建、已有 store/keyed chain/错误 helper 复用、Hook 延迟绑定和新增导出需要直调测试等要求。架构依赖图当前显示 87 模块、621 条模块边、67 条前向边；仅按行数切文件不能减少这些边。

| 大型文件（`ruyi-workbench/app/` 下） | 物理行 | 应收敛的职责 |
|---|---:|---|
| `src/11-native-tools.js` | 5,748 | shell、Git、网络、归档、桌面等工具族 |
| `src/02-session-store.js` | 5,735 | 正文/头、索引、journal、待决、mission、恢复 |
| `src/10-context-governance.js` | 4,248 | 压缩、辅助请求、回合调度、HTTP 流壳 |
| `src/01-config.js` | 4,095 | 配置、原子写/store、CLI 同步、发现 |
| `src/09-workflow.js` | 3,950 | 工作流和主 provider 工具循环 |
| `src/12-tool-dispatch.js` | 3,735 | 工具注册、桥接、参数/权限派发 |
| `src/04-permission-runtime.js` | 3,121 | 权限、pending、视觉/交互运行时 |
| `src/05b-kimi-bridge.js` | 2,957 | CLI 协议与 Kimi 生命周期 |
| `src/08-agent-runs.js` | 2,886 | 子任务生命周期、子 provider 工具循环 |
| `src/13-http-router.js` | 2,818 | 路由、启动与健康检查 |

以上十件共 39,293 行，占运行时 26.4%。前端也有 `steward-conversation.js` 2,710、`provider-settings.js` 2,690、`steward-board.js` 2,333、`steward-drawer.js` 2,171 行。拆模块可以改善定位和依赖，但净减少行数需要合并真实重复逻辑，不能以增加 wrapper 换取小文件数字。

## 具体发现与精简候选

以下行号均相对上述提交；源码目录前缀为 `ruyi-workbench/app/`。

### A1 · 两份 NDJSON 合批壳，适合先提取（证据强，低至中风险）

- `src/10-context-governance.js:4150–4177` 与 `src/13h-steward-runner.js:310–337` 都有 delta 队列、50ms timer、相邻同类合并、边界先 flush、流已结束判断、带时间戳 NDJSON 写入。后者 308 行注释明确称其为 `streamChat` 的“同形副本”。
- 调用路径：普通 `/api/chat/stream → streamChat → runSessionTurn`；管家 `/api/steward/message → runStewardTurn`。两者都在合批前套 `PrivacyGateway.createDisplayStream`，分别位于 10:4185 和 13h:338。
- 提取单一流 sink/flush/close 工厂，两入口保留自己的鉴权、body 清洗、启动时机和断线语义。普通会话在核心 `onStart` 后才发 200；管家入口提前发头并以 `steward_reply` 结尾，不能一起抹平。
- 预计删除约 20–30 行重复机制（估算，未实施），更大收益是后续隐私显示/流关闭修复只改一处。必须保留 `writableEnded/destroyed`、`res.on('error')`、最终 await display flush；它们防止异步 write-after-end 使服务退出。

### A2 · 工具结果入模型历史的 17 个相同管道（证据强，中风险）

- `src/08-agent-runs.js` 七处：1062、1075、1104、1113、1140、1154、1288；`src/09-workflow.js` 十处：2705、3023、3193、3207、3242、3256、3286、3354、3600、3620。
- 共同表达式是 `truncateToolResult(name, JSON.stringify(await PrivacyGateway.modelToolResult(value)))`，外加相同的可用性判断。分支包括预算拒绝、权限拒绝、兄弟调用跳过、普通原生/MCP 返回、编排结果。
- 适合提供一个纯数据结果编码 helper，再由各自循环保持 `role:'tool'`、调用 ID、事件与历史追加的顺序。先不要合并整个主/子工具循环，两者角色、预算、心跳与编排规则不同。
- 净行数收益很小（不少现状已是一行），但会将 17 个独立漏接机会收敛到一个，方便全链路脱敏补齐。保留先保护完整结果、再序列化/截断的顺序；`03a:798–805` 的 `operationMayHaveExecuted` 回执必须保留，不能在过滤失败后自动重跑写工具。

### A3 · 最终模型 HTTP 边界四处相同接线（证据强，中风险）

- `src/04h-provider-http.js:71–75`（非流式通用）；`src/07-autonomy.js:74–76`（探测）；同文件 1898–1901（流式及兼容重试）；`src/10-context-governance.js:2111–2113`（摘要）。均是 `beforeModelRequest → assertPolicyAvailable → JSON.stringify → fetch`。
- 建议在 04h 的传输原语层收敛 **一次 POST 的发送边界**，由调用者保留超时/AbortSignal、SSE/JSON 解码和错误分类。不要把“ping 探测也重复检查”视为多余：策略恢复故障和动态开关一样约束探测。
- 预计仅省十余行接线，主要收益是未来出站介质策略、接收方绑定与检查顺序的单一入口。重试仍需在每次实际发送前核验当前策略，不能把过滤结果按回合永久缓存。流式首字节后故障不得转为可重放重试（07:1886–1913）。

### A4 · 权限超时/暂停 timer 双实现（证据强，中风险）

- `src/07-autonomy.js:1715–1733` 与 `src/13d-core-domain-routes.js:2286–2309` 出现相同的暂停 TTL、自动 deny、`runAutomaticInterventionDecision`、`timeout:<requestId>` 幂等键和 pending 身份复检。前者用于原生 provider 权限请求，后者是 CLI 权限桥。
- 合并 timer 生命周期与超时决策构造，保留各自 settle/resolve 适配。预计可移除约 15–30 行重复（估算）。`pendingPermissions.get(requestId) === entry`、`commandApplying`、CAS/幂等和“只 settle 一次”负责竞态，不应删除。

### B1 · Gateway 多种遍历和 JSON 词法扫描可分层；不能用 JSON.parse/stringify 替换（证据中等，高风险）

- `src/03a-privacy-gateway.js:129–154` 收集 worker 输入；376–472 保护 JSON 字面量；529–603 投影失效历史，其中 539–554 又有一套 JSON cursor walker；772–788 检查源 proof；1059 后恢复历史；1146–1201 还原工具参数。全都“递归”不代表工作相同。
- 可以提取有界 JSON 词法 visitor：提供原始 token 坐标、解码值、pointer、重复键、长数字原始拼写，由保护与历史投影各自决定动作。另按 `model request / history / source proof / local display / execution args` 分成 gateway 内部协作者，保持对外命名空间不变。
- 收益优先是减少重复的 JSON 语法实现和降低 1,214 行文件的认知负担；暂不承诺净减少多少行。需要先建立两条 cursor 路径的等价语料与拒绝语义，避免建一个复杂“万能递归框架”。
- 不能删掉 lexical 层直接 parse/stringify：JSON 重复键会被覆盖，长整数会舍入，转义的原始拼写会丢失，文件精确编辑和源范围 proof 将被破坏。`protectJson` 的 97 行与历史 scanner 的 16 行语义并不等价，不能机械择一。
- `prepareCall:1195–1199` 的原树预遍历与 `restoreArgs:1147/1161` 的递归限额看似重复，但代理工具壳重新起 pointer、还原字典 key、展开 token 后的字节预算不同。本次不把这七行当作已证明可删；若后续统一预算，需要保留原始树和展开树的双重上限。

### B2 · typed detector 重建会重复枚举配置，但只是优化候选（证据强，收益待测）

- `src/03a-privacy-gateway.js:326` 为取 `.personal` 调用 `options(context.config)`；`options:55–57` 还会调用 `secrets(config)`，遍历 provider/MCP URL、headers、env 和 args。`protectedTransform:206–215` 最多执行四次稳定扫描，每次都会走到这里。
- 可以将当前模式的布尔能力与规则快照放入 context，typed detector 缓存到策略签名对应的 scope，避免每轮为取得一个布尔值枚举全部凭据。缓存应以策略签名失效，关闭路径仍在构造 detector 前返回。
- 这是少量配置遍历与 detector 构造，不是整个隐私性能瓶颈的实测结论。先用已有 `privacy-31/profile-overhead.js` 加“配置较多/字段较多”的对照测量；不应为这点开销删除晚学习稳定重扫。

### C1 · 测试样板还有较多重复，采用已有公共件即可（证据强，分批低风险）

- 539 件根 e2e 中，131 件文本出现 `createRunner`，395 件定义自己的 `ok`/`check`（扫描函数声明及变量定义；两集合无交集）。这是样板识别数量，**不是 395 件测试冗余，更不是应删除的断言数**。
- `dev-harness/lib/harness.js:25–58` 已提供相同 PASS/FAIL/退出码协议；配置与贡献规则已要求新件复用。按改动顺手迁移老件，保留每条断言、label 和退出时机。
- 同样复用 `lib/fake-openai-provider.js`、`fixture-home.js`、`kill-own-tree.js`；不新建同类 runner。测试代码总量可望下降，但应先抽样量化每件样板再给行数预算，不做一次性全仓 codemod。

### 重复扫描的限制

对 `app/src/*.js` 与 `app/public/js/*.js` 去空白行、去整行 `//` 后，按连续八行相同文本扫描，发现 **37 个跨文件重复窗口**；窗口相互重叠，不可相加当可删除行。人工核对得到 A1/A4，也发现以下刻意镜像：

- `06i-steward-core.js:1002–1009` 与前端 `mission-state.js:49–65` 的五态规则；`unit/thread-state-differential.test.js` 已对真实行为做差分。前后端执行环境不同，短表同步比为了省几行引入新构建步骤更清楚，暂保留。
- `13-http-router.js:2698–2705` 与 `public/js/health-i18n.js:55–62` 是服务端/前端健康状态映射；应维持契约一致，不凭文本相同删除一端。
- `help-viewer.js:121–128` 与 `modal.js:67–74` 有焦点回退重复，另有 onboarding 焦点围栏片段。可在 UI 维护时复用 focus helper，但不能删除可见性检查/键盘可访问性以减代码。

## 必须保留的防线及其实际作用

| 边界 | 证据与调用路径 | 保留理由 |
|---|---|---|
| 策略/配置并发变化 | `03a:10–15,202–238,640–647`，回合/辅助工作绑定 signature，await 后再核对 | 开关变化不能让旧的已截断数据或旧上下文继续外发；相邻 await 前后检查不是同一时点 |
| 代号所有权和真实权限 | `01h:252–278,394–424` → `03a:1146–1203` → `09:3090` 后权限派发 | 随机代号不是授权；scope、过期、撤销、凭据类别、宿主真实登记能力与还原后的权限都要保留 |
| 完整扫描与源范围证明 | `03a:692–788` + `01h:29–38` | 切片/搜索/Git diff 可能只含敏感值一半；先扫完整源、保留坐标和 WeakMap proof，拒绝预算外尾部 |
| 有界晚学习重扫 | `03a:202–216` | 后一个结构字段能识别前面出现的值，alias 类别还能升级；有界四次并非无限“试到安全”为止 |
| 自定义正则隔离 | `01m-privacy-regex.js:47–92` | worker 可被终止，限制并发、输入、命中和内存；Promise timeout 无法打断主线程灾难回溯 |
| AEAD 与存储绑定 | `01h:475–507`；`01k:144–181` | nonce/tag/AAD 绑定 instance/purpose/record，严格 envelope 和统一错误；不能只保留“加密后是乱码” |
| 映射持久化与去重 | `03a:87–118,790–795` | 映射落盘成功后才交出模型副本；相同 revision/pending promise 复用已经避免重复 AES/写盘 |
| 恢复事务、旧引用可用性 | `01l:62–99`、`01k:175` | vault append、配置写、加密 journal、revision 和单次票据解决失败/崩溃后的恢复；不能压成一个无回滚写调用 |
| 本机/模型/审计视图隔离 | `03a:519–636,843–1058`、`10:4178–4191` | UI 可还原不意味着原值可回流 providerHistory；失效旧历史可以隔离，新伪造输入仍须拒绝 |
| 副作用后的结果缺失 | `03a:798–805` | 工具已执行但结果不能外发时需明确 `operationMayHaveExecuted`；否则重试会重复写文件、命令或远端操作 |
| Windows 文件竞态 | `02-session-store.js:3313–3337`、`01-config.js:1668` | 有界读取重试只处理 ENOENT/占用等瞬态；注释有具体复现历史，不是泛化吞错 |
| 流关闭与观测隔离 | `10:4161–4176,4212–4215`；`10:2085–2105` | 前者防异步 socket error 崩服务；后者使影子经济账失败不破坏压缩。安全检查异常不能照此吞掉 |
| 机器人凭据归属 | `13y-external-bot-credentials.js:16–22,58–75` | 机器人绑定、revision、环境引用不是通用 vault 加密的重复职责；DPAPI 已复用 `LocalSecretCrypto.run`，无需再造统一密钥库来“去重” |

本次未证明可安全删除上述任何保护。未来覆盖 CLI、媒体、远端 MCP 等能力后可以由经测试的适配替代当前拒绝分支；不能先移除拒绝、再把入口称为“已覆盖”。

## 散落脚本与实验产物：先分类，再归位

| 位置/候选 | 当前消费关系 | 建议 |
|---|---|---|
| 根 `*.log`、`.ruyi-runtime/`、`benchmark-results/` | `.gitignore` 已排除；含实际会话/配置、release 上传/分支清理脚本和日志 | 本地运行数据与实验输出，不计源码。可按日期/发布整理到既有忽略目录，但先检查活进程、引用与保留价值；不读取/展示真实凭据，不当普通文档提交 |
| 四个历史脚本：`codemod-slice-modules.js` 62 行、`codemod-toolcall-table.js` 193 行、`migrate-ports.js` 182 行、`migrate-ports-v2.js` 139 行 | 根 e2e runner 不执行；未发现运行／构建／生成清册调用者；语法门扫描深度为 1 | 共 576 行，已于 2026-10-21 字节原样迁入 [历史工具目录](../../dev-harness/archive/README.md)，仍由语法门覆盖。原相对路径只适用于原布局；复现须在对应历史版本恢复原路径，不在当前树执行旧切片／迁移 |
| [v25-smoke.js](../../dev-harness/archive/v25-smoke.js) 180 行 | 文件头写“临时”“跑完即弃”“不进正式套件”；无其他 tracked 调用引用 | 已于 2026-10-21 字节原样归档，未执行／删除。技能注册表、MCP 导入已有正式领域回归，但不宣称逐条等价；完整保留旧复现 |
| `dev-harness/privacy-31/` 12 件/1,731 行 | 手动 probes、合成语料与基准，有彼此 require 和相对源码路径；不被根 `*.e2e.js` 自动发现 | 已有专题目录，先补一个入口/用途/是否联网/输出目录/适用 SHA 清单。正式回归迁到 unit/e2e 时只搬入口，保留 corpus/helper；不要把实弹验证当默认 CI |
| 根 `*.e2e.js` / `unit/*.test.js` | `run-all.js:285–286,463–470` 只按固定层级发现 | 暂不按领域直接搬文件，否则会静默漏测；先改发现规则并证明前后件名集合相同，再考虑目录化 |
| 清册生成器、`src-reader.js`、`read-frontend-*`、fake providers | CI、静态门和大量测试直接引用；`syntax-gate.js:17–21` 有目录深度范围 | 保留当前入口，目录化须同步引用和语法门；不能看到不叫 e2e 就当一次性文件 |
| `publish-github-release.js`、`release-package-acceptance.js` | 发布文档与验收使用；后者还有进程安全静态门约束 | 正式发布工具，未来可迁到统一 release tooling，但本次保留稳定入口 |
| `tools/external-bot-gateway.js` | `tools/package-offline.ps1:286` 与 `tools/build-overlay.js:274` 明确进包 | 生产能力，不纳入“零散实验脚本”迁移 |
| `tools/fake-claude.js`、`tools/dev-serve.cmd` | fake 被多个 Claude e2e 和开发启动脚本引用；overlay 275 行明确不进部署载荷 | 可以未来搬到测试 fixtures，但必须改所有调用点；不属于生产膨胀，也不属于无用文件 |

这些建议不授权执行旧迁移、发布或分支清理脚本。文件移动不会改变功能复杂度，也不能作为“已经精简生产代码”的证据。

## 分阶段实施与出门要求

1. **当前整理批**：提交可复现规模基线和一次性工具清册；文档/证据归档由对应整理批处理。只动可确认安全的非运行材料，不移动正式测试入口。
2. **3.1 施工前/随功能接线**：优先 A1（统一流 sink）、A2（工具结果模型编码）、A3（最终出站原语）。每项独立提交、独立 review，不以“总行数必须降低”作为门槛。A1/A3 合计预期仅省约 30–50 行，A2 主要减少重复接线点；收益在减少未来遗漏。
3. **3.1 功能稳定后**：按风险选择 A4、B2；B1 的词法 visitor/历史分层在反例语料完备后再做，避免与媒体、工作数据加密和多引擎覆盖同时大改语义。大型 session store/原生工具按依赖图与领域逐个分离；分离不是删保护。
4. **持续维护**：旧测试按触达迁往既有公共 harness/fake；历史 codemod 与临时冒烟归档。不要为减几千行样板改变 539 件测试的发现、判定或进程隔离合同。

实现验证按仓库规定执行构建新鲜度、语法、unit、静态门和相关 e2e；行为改动应有代表 API/工具全链路反例，独立代理复核后提交。A1 需覆盖 delta/边界顺序、断线、晚事件、显示还原和首帧前故障；A2 覆盖主/子、拒绝/跳过、MCP、过滤失败不重放；A3 覆盖三线协议、摘要、探测、重试、故障切换及策略 await 间变更；A4 覆盖暂停 TTL、并发人工决定、崩溃恢复与只 settle 一次。发布全量和成品验收仍属于总发布计划，不因本文只读审计而视为已跑。

本次没有运行性能基准，因此所有性能改善均是待验证假设；也没有发现足以支持“大删防御代码可以安全发布”的证据。
