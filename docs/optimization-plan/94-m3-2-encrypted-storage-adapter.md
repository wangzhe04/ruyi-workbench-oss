# 94 · M3-2 加密存储适配：边界、开关与第一个数据族

更新：2026-10-22。状态：**M3-2a/M3-2b 已实现并验证，M3-2c 完成了格式冻结与派生读点接线；M3-2 整体仍在进行中**（清册 41 个"必须加密"族里，已接线 2 个：会话头、草稿本；正文 NDJSON 与索引族仍明文）。起点提交 `c9234040`，分支 `codex/3.1-completion-plan`，应用版本仍为 `3.0.1`。本批**没有迁移任何用户数据**，也没有任何界面入口。

## 1. 本批交付

| 交付 | 位置 | 说明 |
|---|---|---|
| 工作数据主钥 | `app/src/01o-work-data-keys.js` | 独立于凭据库主钥的 32 字节 master，DPAPI CurrentUser 封装，`instanceId` 进 DPAPI entropy；只有显式启用流程（`ensure`）才创建 |
| 受管记录存储 | `app/src/01p-work-data-store.js` | 整件记录的读写适配层：开关关 = 与旧路径逐字节相同；开关开 = `WorkDataCrypto` v2 容器；容器解不开就抛错，绝不回落明文或空记录 |
| 首个数据族接线 | `app/src/02-session-store.js` `sessionScratchpadStore` | 会话草稿本（小 JSON、`cache:false`、旁车语义）改走适配层；键集与 `atomicWriteJson` 由调用方注入 |
| 开关 | `app/src/01-config.js`、`app/src/06k-config-patch.js` | `workDataEncryptionV1` 默认 `false`；管家配置分级钉成 `forbidden`；通用配置补丁 `POST /api/config` 显式拒绝它（409 `work_data.encryption_requires_setup`），M3-3 才有唯一的启用入口 |
| 清册登记 | `dev-harness/durable-state-inventory.js`、`dev-harness/encrypted-storage-freeze.js` | 新增 `<data>/work-data-key-v1.json`（第 70 个持久面）；冻结清册新增该族（excluded：它就是密钥信封本身）并记录 `adapterWired: session-scratchpad` |
| 单元测试 | `dev-harness/unit/work-data-store.test.js` | 10 项：关时与**真实** `atomicWriteJson` 逐字节一致 / 开时封印往返 / **异步 `enabled()`（生产形状）仍能解锁并封印** / 无钥拒写 / 坏密文硬失败 / 跨实例与跨族拒绝 / 明文仍可读且旧"坏=空"合同保留 / 读不建钥 / 通用配置补丁拒绝开关 / 接线结构锁 |

## 2. 适配层合同

`WorkDataStore.create({ file, purpose, schema, scopeId, recordId, keys, writeJson, enabled, prepare, defaultValue, onCorrupt })`

- **读**：文件不存在 → `defaultValue()`；明文 JSON 解析失败或形状不合 → 调 `onCorrupt` 并返回默认值（保住草稿本"坏文件当空 + 诊断"的既有合同）；`workData: 2` 容器 → 解锁并 `WorkDataCrypto.open`，认证失败/密钥不可用 → **抛错**，不返回空记录。
- **写**：开关关 → `writeJson(file, value)`，与旧 `DurableJsonStore` 逐字节一致（单测直接比对）；开关开 → 解不开就抛，解开了写 `{ workData: 2, …容器 }`。**写路径不创建密钥**。
- **绑定**：`purpose / schema / scopeId / recordId` 由族声明，`instanceId` 来自键集，`seq` 目前固定 1。没有外部锚点就**不承诺**抵抗"整盘换回旧快照"这类回滚（93 §5 的合同仍然成立）。
- **上限**：单条明文 ≤ `WorkDataCrypto.MAX_PLAINTEXT`（1 MiB）。NDJSON 追加日志（消息、provider 历史、干预日志）需要"逐记录独立认证"，留给 M3-2b，不在本批假装覆盖。
- **错误码**：`work_data_key.*`（disabled/absent/unavailable/decrypt_failed/unsupported）、`work_data.*`（binding/purpose/keyId/decrypt/envelope）、`work_data_store.corrupt|shape`。都带 `apiCode`，但没有预设 HTTP 状态码——本模块还没有路由消费方。

## 3. 键与生命周期

- **独立于凭据 master**：93 §4 冻结的两条生命周期不允许合并，所以工作数据有自己的 `<data>/work-data-key-v1.json`（DPAPI CurrentUser + entropy 绑 `instanceId`），凭据库文件一个字节都不动。
- **只在显式启用时创建**：`WorkDataKeys.ensure()` 只该被"用户打开开关"的流程调用（M3-3 的 UI / 本批的测试）。读、写、解密路径都不会建钥；开关关时 `unlock()` 直接 `disabled`。
- **丢了钥不丢密文**：解不开时原文件原地保留、读写都失败，不会把密文覆盖成明文；轮换、恢复包、关闭加密属 M3-3。
- **解锁缓存**：按 `instanceId` 缓存已解锁 master，`clear()` 会先 `fill(0)` 再丢引用。**`clear()` 目前还没有生产调用方**（退出/锁定路径未接），清零只在测试里被触发；这条留给 M3-3 的锁定与恢复接线。

## 4. 为什么先做草稿本

草稿本是清册里最"干净"的一族：每会话一个小 JSON、`cache:false`、本来就是"读失败当空、不阻断回合"的旁车，且不参与会话头/正文那条最难的写链。用它验证适配层的三个关键性质（关时字节不变、开时封印、坏密文不吞空），风险最低、可回退最好。

代价要说清楚：**会话头、消息正文、provider 历史、索引、记忆、队列、任务、日志、备份都还没接线**。在这些族接完之前，任何"会话/工作数据已加密"的说法都是假的。

## 5. 开关与体验

- 默认关闭；关闭时落盘字节与旧实现完全一致（单测逐字节比对），不创建任何新文件。
- 开关**没有专用接口、也没有界面**：通用配置补丁 `POST /api/config` 会显式 409 拒绝 `workDataEncryptionV1`，管家配置分级里是 `forbidden`。启用入口留给 M3-3 的本地设置流程——在此之前要打开只能手工编辑 `config.json`（本批测试就是这么做的）。
- 开关打开后，未迁移的明文记录仍然可读（写才封印）——这是迁移前的真实状态，不宣称"已加密"。
- 草稿本的"坏文件当空"合同对**明文**保留、对**密文**不保留：密文解不开时 `readSessionScratchpad` 仍回落空表，但 `updateSessionScratchpad` 会失败，避免用空表覆盖一份解不开的旧密文。

## 6. 验证

| 门 | 结果 |
|---|---|
| 
ode --test dev-harness/unit/work-data-store.test.js` | 10/10 通过 |
| 
ode --test dev-harness/unit/work-data-crypto.test.js` | 7/7 通过（M3-1 的测试未回归） |
| 完整单测 
ode --test "dev-harness/unit/*.test.js"` | 2588 项 / 2562 过 / 26 条件跳过 / **0 失败**（首轮并行跑时 `steward-queue-robustness` 的 Q3 计时用例抖红一次，单跑与整轮复跑都过，记为既有计时抖动） |
| 
ode dev-harness/run-all.js --fast` | 81 件全过（见下"首次失败"一条条修完后的复跑） |
| 依赖图 / facts / route / 清册 / 冻结清册 | 92 模块 647 边 1 SCC（**SCC 32 → 31**）；facts 557 e2e / 290 unit suite；清册 70 面；冻结清册 41 required / 29 excluded、`adapterWired=session-scratchpad`、`encryptionImplemented: false` |
| `syntax-gate` / `build --check` | 1136 文件 0 失败；产物新鲜、manifest 行区间自洽 |

**首次失败与处理（保留记录，不重写成一次过）**：

1. 新模块把依赖图 SCC 顶到 33（`01p → 01-config`、`02 → 01p`）。按仓库规矩把键集与原子写改成调用方注入，`01p` 不静态引用 `01-config`，并顺手修掉 `01p` 里局部名 `text` 误命中 `00-boot` 的假边。
2. `02 → 01j` 让 `01j` 进了大环，`01j` 里 `const path = require('node:path')` 的局部别名又假命中 `00-boot` 的 `path` → 改名 
odePath` 后 SCC 回到 31，并把静态门上限从 32 调到 31（只降不升）。
3. 清册登记行的 owner/anchor 一度指向 `01p`，而键文件实际在 `02` 构造 → 清册校验报 stale anchor，改到 `02-session-store.js`。
4. `process-safety` 的"使用 killOwnTree 的文件数"从 345 变 346（M3-1b 的基线件），按门的要求回来改数并写明原因。
5. `steward-config-tier` 要求默认表里每个键都有显式分级：`workDataEncryptionV1` 判为 `forbidden`（改存储格式与密钥生命周期不是管家能远程翻的开关）。
6. 单测首轮 4 项失败：跨 realm 的 `deepStrictEqual`（vm 对象原型不同）与一处过严的 `corrupts` 断言，改按 JSON 形状比较后通过。

## 7. 残留风险与下一批

- **1/41**：清册里 41 个"必须加密"族只有草稿本接线。会话头/正文/索引/记忆/队列/任务/日志/备份全部未接，不得声称已加密。
- 没有迁移器、没有启用 UI、没有轮换、没有恢复包、没有"关闭加密"的反向迁移（M3-3）。
- `seq` 固定 1 且没有外部锚点：不抵抗整盘回滚，也不抵抗"把旧密文换回来但认证仍然成立"（认证只能证明它属于本实例/本族/本记录）。
- NDJSON 追加（消息与 provider 历史）需要逐记录独立认证与序号绑定，M3-2b 设计；附件需要分块与认证清单，属于附件批。
- 一次性的 `workDataKeys` 建在 `02-session-store` 顶层：它只构造对象、不读盘，但意味着"启用开关"的最终入口仍要等 M3-3 的 UI 调用 `ensure()`。
- **没有封印态的产品级 e2e**：`session-scratchpad.e2e.js` 目前只在开关关闭下跑（开关不能被 HTTP 打开、`ensure()` 也没有入口），封印路径由单测覆盖；等 M3-3 提供启用入口后再补一条开态 e2e。
- 下一批：M3-2b —— 会话头（整件 JSON）+ messages/provider（NDJSON 逐记录）+ 会话索引/搜索索引；再接 M3-2c（记忆、队列、任务族）。

## 8. 独立审查记录（2026-10-22）

审查方式：独立子代理（worker、exec 档、57 次工具调用、DeepSeek `deepseek-flash`），在工作树冻结后审查，并自己用真实 DPAPI 复刻了生产接线形状。原始结论：**需修复**——1 项阻塞 + 1 项重要 + 3 项次要。

| 编号 | 严重度 | 问题 | 处理 |
|---|---|---|---|
| C1 | **阻塞** | `01o` 的 `enabled()` 写成 `return host.enabled() === true`，没有 `await`；生产接线 `02` 传的是 `readConfig().then(...)` 的 Promise，恒不等于 `true` → 开关永远关着、`ensure()` 建不出钥、开开关后草稿本写入全废。8 项单测没抓到是因为 stub 是同步布尔 | 改为 `(await host.enabled()) === true`；测试改用**异步** `enabled` 复刻生产形状，并新增"异步 enabled 仍能解锁并封印"回归 |
| C2 | 重要 | doc 94 §5 写"只从配置文件读，没有路由"，但 `POST /api/config` 的通用补丁能把 `workDataEncryptionV1` 打开 | `06k-config-patch.js` 显式拒绝该键（409 `work_data.encryption_requires_setup`），并加单测；doc §5 改成"没有专用接口/界面，通用补丁拒绝，M3-3 才有启用入口" |
| C3 | 次要 | `WorkDataKeys.clear()` 没有生产调用方，解锁后的 master 在进程内常驻 | doc §3 明写"清零待 M3-3 锁定/恢复接线"，不声称已生效 |
| C4 | 次要 | 密文读失败与"本来没有草稿"在下游不可区分 | `readSessionScratchpad` 对 `work_data*` 错误记一条 `session_scratchpad_unreadable` 诊断；仍回落空表（写侧会失败，不会覆盖密文） |
| C5 | 次要 | 单测的"逐字节一致"比的是本地 stub，不是真实 `atomicWriteJson` | 改为从 `server.js` 取真实 `atomicWriteJson`，并与同对象的一次参考写逐字节比对（另核：真实 writer 不追加尾换行，`payload = JSON.stringify(value, null, 2)`） |

审查者复核通过、未改动的点：主钥与凭据库完全独立（只写 `<data>/work-data-key-v1.json`）、DPAPI entropy 绑 `instanceId`、三处失败路径都 `fill(0)`、错误码不含路径或密钥、关时字节与旧实现一致、无钥写入硬拒、坏密文不吞空、草稿本只有一处读写路径、删除会话同删旁车（e2e D0–D2）、管家分级 forbidden 真实生效、零新依赖、依赖图 647 边 / SCC 31、`build --check` 与 `syntax-gate` 通过、doc 未把迁移/UI 写成已完成。

修复后复跑：`work-data-store` 10/10、`work-data-crypto` 7/7、完整单测 2588/2562/26 跳过/0 失败（首轮 Q3 计时抖动一次，复跑通过）、`fast` 静态 81 件全过、`session-scratchpad.e2e` 全过、`syntax-gate` 1136 文件、`build --check` 新鲜、依赖图 `--check` 通过。

## 9. M3-2b：会话头接线（已验）

会话头是第一个"整件 JSON、被大量路径读取"的族，也是 M3-2 里风险最高的一刀，所以单独成批。

**唯一读写口**（`02-session-store.js`）：`sessionHeadStore(id)` → `WorkDataStore.createText`，配套 `readSessionHeadText(id)` / `writeSessionHead(id, payload)`。02 内共 **12 处读写调用点**，其中 **7 处是删掉的旧直读/直写**：

- `loadSession` 的头读取、`saveSession` 的头写入与 `mergeMissionFromDisk` / `diskTurnSeq` 守卫读；
- 索引扫描（重建与 
oteSessionIndexBadHead`）—— 开关开时先解密再判「好头/坏头」，否则密文会被误判成坏头、整库会话从列表消失；
- `readSessionHeadResilient`（`/api/status`、`/api/models`、mission 头读）、`readSessionChangesWithMeta`、`bumpMissionChangeSeq` 的头改写、`journalResolveTurnSeq`、标题覆盖读取。

**三条新合同**：

1. **开关只控制写**。读一个已封的头不需要开关打开；`WorkDataKeys.unlock()` 不再检查开关（创建仍由 `ensure()` 把关）。否则用户一关开关，所有已加密会话立刻读不出来。
2. **ENOENT 照旧冒泡**。`createText.read()` 不把"文件不存在"吞成 null —— `readSessionHeadResilient` 的瞬时锁重试（5/15/25/35ms 退避）和 `loadSession` 的"读不到 = 会话不存在"判据都建立在 ENOENT 上，吞掉它会退化成"看起来没有这个会话"。
3. **解不开的密文必须冒泡**。`loadSession` 对 `work_data*` 错误直接抛出（不是返回 null、不是当坏文件改名 `.corrupt`）；`readSessionHeadResilient` 这类只读路由仍按原有契约返回 null。缺钥的用户提示归 M3-3。

**验证**（`dev-harness/unit/work-data-session-head.test.js`，用**真实 DPAPI** 与真实 `createSession/saveSession/loadSession`）：

- 开关关：头文件是旧字节（含标题明文），没有任何密钥文件；
- 开关开：头是 `workData: 2` 容器，标题与消息正文都不在文件里，`loadSession` 仍能读回；把容器拷成另一个 session id 必须解不开；
- 开关关回去：已封的头仍然可读（写才受开关控制）；
- 篡改密文或移走密钥信封：`loadSession` / 读口**报错**，恢复密钥后数据仍在、可读。

完整单测 2592 项 / 2566 过 / 26 跳过 / 0 失败；`session-head-read` 的瞬时重试与隔离用例全过；`session-scratchpad`、`checkpoint-visibility`、`session-get-etag` 三件 e2e 全过。

**还没接的**（都不损坏数据，但开关打开后会降级，属 M3-2c）：

- 消息与 provider 正文仍是明文 NDJSON；会话索引/搜索索引仍未接线。
- **6 处非 02 的派生读点仍按明文读会话头**：`06-provider-engine.js`（孤儿驱动重置）、`13-http-router.js`（`resetOrphanedMissionDrivers`）、`13d-core-domain-routes.js`（`sessionEnvelopeStamp`）、`13e-pretender-index.js`、`13i-steward-inbox.js`、`13j-steward-tool-base.js`。开关打开时它们读到容器对象，表现为"读不到 → 返回 null / 跳过"（例如孤儿驱动不再被重置、信封戳为空），不会写坏文件、也不会把密文改名 `.corrupt`。

因此**41 个必需族里现在接了 2 个**（会话头、草稿本），不能说"会话已加密"。

**手工打开开关的后果**：本批没有启用流程，直接改 `config.json` 把 `workDataEncryptionV1` 置 true 而没有密钥信封时，会话头读写会以 `work_data_key.absent` 失败（安全方向正确：不静默降级明文），恢复办法是走 M3-3 的启用流程或手工删除该开关。

## 10. M3-2b 独立审查记录（2026-10-22）

审查方式：独立子代理（worker、exec 档、126 次工具调用、DeepSeek `deepseek-flash`），工作树冻结后审查，自己跑了 4 组命令。结论：**需修复**（1 项待定判定 + 1 项重要 + 2 项次要），主体读写契约复核通过。

| 编号 | 严重度 | 问题 | 处理 |
|---|---|---|---|
| D1 | 待定→排除 | 复审时 `session-get-etag.e2e.js` 两次 exit 1 且日志无判定行，与本批"三件 e2e 全过"的说法冲突 | 主会话连跑 5 次全部 `ALL PASS`（exit 0，含判定行）；该件不在 `run-all` 的 flaky 桶里，复审那两次是它自己在多个 shell 里并行跑 e2e 的环境产物。文档改为如实记录"5 次全过 + 复审两次未复现" |
| D2 | 重要 | 02 之外还有 6 处**派生读点**按明文读会话头（`06-provider-engine`、`13-http-router` 的 `resetOrphanedMissionDrivers`、`13d` 的 `sessionEnvelopeStamp`、`13e-pretender-index`、`13i-steward-inbox`、`13j-steward-tool-base`）：开关打开时读到容器对象，表现为"读不到 → null/跳过"，不损坏数据但功能降级 | §9 明确列出这 6 处、说明降级形态与"不写坏文件、不改名 .corrupt"的边界，并归到 M3-2c（92 队列表同步），不再让人误以为会话头所有读路径都已接线 |
| D3 | 次要 | §9 写"替换了 11 处"，实测口径不符（02 内读写调用点 12 处、删掉的旧直读/直写 7 处） | 改成这两个可复核的数 |
| D4 | 次要 | "手工置 true 但无密钥信封"的后果没写 | §9 补明 `work_data_key.absent` 与恢复方式 |

复审复核通过、未改动的点：开关关时头字节与旧路径一致（字符串交给 `atomicWriteJson` 直接落盘）；密文错误全部走 `fail('corrupt')`，没有 `return null`、没有 `.corrupt` 改名；ENOENT 未被吞，`readSessionHeadResilient` 的退避重试与 `loadSession` 的"不存在"判据仍成立；空/非 JSON 头文件按旧契约原样返回；`workData≠2` 的容器对象当损坏处理；未启用用户拿不到密钥材料；`01n` 的 recordId 字符类本来就允许 `-`（本批只加注释）；`13d`/`13j`/`06` 的调用形态会安全降级。

## 11. M3-2c：逐记录格式冻结与派生读点接线（本批范围）

会话头接完之后，94 §9 列出的两件遗留是：正文 NDJSON（消息与 provider 历史）仍是明文，以及 6 处非 02 的派生读点仍按明文读头。本批只做了**可控的那一半**。

### 11.1 逐记录格式已冻结（`01q-work-data-records.js`）

每行一条独立认证的记录：`{"w":2,"e":<WorkDataCrypto v2 容器>}`，绑定 `purpose=session`、`instanceId`、`scopeId=会话 id`、`recordId=<kind>:<ordinal>`、`seq=ordinal`，`kind` 只能是 `messages` / `provider`。这组绑定让下面每一种"读错位置"都失败，而不是被当成内容：

- 行被**调换 / 复制 / 中间挖空**（ordinal 对不上）→ `ordinal_mismatch`；
- 整行**搬到另一条会话**或另一个 kind → `authenticate_failed`；
- 换一个实例/密钥，或**改一个密文字节** → `authenticate_failed`；
- 同一份正文里**混进明文行**、空行、未知版本 → `corrupt` / `format_unsupported`。

两条边界要写清：① 正文行**不得为空**（内部空行视为损坏，`encodeLine` 也拒绝空文本）；② **尾部整行截断检测不到**——AAD 里没有总行数，"行 0..k 的前缀"仍然是可验证的合法块。能拦住的是调换、复制、中间挖空；截断防线在调用方（正文的字节级截断规则），这正是 §11.3 把"字节级截断"列为不接正文的原因之一。

纯模块、不碰文件；6 项单测覆盖上述全部反面（`work-data-records.test.js`）。**这一层故意还没有接进正文快路径**，原因见 11.3。

### 11.2 6 处派生读点已接到唯一解密读口

| 文件 | 用途 | 改法 |
|---|---|---|
| `06-provider-engine.js` | 扫描活引擎转录（孤儿驱动回收） | 逐文件改走 `readSessionHeadResilient(id)` |
| `13-http-router.js` | `resetOrphanedMissionDrivers` 的关键词预筛 | 改走 `readSessionHeadText(id)`（先解密再做 `until-done` 判定） |
| `13d-core-domain-routes.js` | `sessionEnvelopeStamp`（条件 GET 的 ETag） | 头哈希改为哈希**解密后**的文本（同一内容换随机 nonce 不再让 ETag 抖动） |
| `13e-pretender-index.js` | 看板投影 | 改走 `readSessionHeadResilient(sid)` |
| `13i-steward-inbox.js` | `stewardReadTurnHead` | 改走 `readSessionHeadResilient(sessionId)` |
| `13j-steward-tool-base.js` | 管家读会话权限档 | 改走 `readSessionHeadResilient(sid)` + 原有内存覆盖 |

开关打开时这 6 处**能正常解密**了；但它们的容错语义原样保留：`readSessionHeadResilient` 只对瞬时错误（ENOENT/EPERM/EBUSY/EACCES）退避重试，其余错误（**包括缺钥与解不开的密文**）一律 `return null`；`loadSession` 那条权威装载路径仍然抛出。也就是说：**能解密时不再降级；缺钥/密文损坏仍按既有容错返回 null 或跳过**，排障时会被伪装成"会话不存在"。缺钥的用户可见提示归 M3-3——这条边界不藏，也不假装已经做到"永远冒泡"。

### 11.3 正文 NDJSON 为什么还留着明文

正文这条链比头难得多，硬塞逐记录加密会同时踩四个雷：

1. **行哈希是前缀判据**：`sessionLineHash` 对**行原文**算 sha1，用来判断"调用方手里的消息是盘上正文的严格前缀"（并发写者补齐、陈旧副本 rebase）。随机 nonce 让同一条内容每次重写都换字节，前缀判定会失效——必须先解码成明文再哈希。
2. **字节级截断**：撕裂尾行按**字节偏移**截断（`lineEndBytes`、`truncateSessionBody(file, len)`），密文边界与明文不一致，截断点要重算。
3. **崩溃窗口**：快路径 append、慢路径整份重写 + 删 `.prevbody` 快照、头后提交，各有自己的崩溃语义；逐记录解码要在这三条路径上都成立。
4. **性能**：装载是热路径（基线里会话首读 p50 8–10 ms、搜索首查约 800 ms），每行一次 AEAD 解码会把成本乘上行数。

所以正确顺序是**先写故障注入用例**（追加中途崩溃、撕裂尾、慢路径重写中断、并发写者、解密失败不回退明文），再接线快路径。本批只冻格式，不接线。

### 11.4 状态与验证

- 清册 41 个"必须加密"族里，**已接线 2 个**（会话头、草稿本）；正文 NDJSON、索引族、其余数据族仍明文，不能说"会话已加密"。
- 派生读点 6/6 已接：开关打开时它们能解密；缺钥/密文损坏仍按既有容错返回 null 或跳过（`loadSession` 那条权威路径才抛），缺钥提示归 M3-3。
- 本批验证：`work-data-records` 6/6；完整单测 2603 项 / 2577 过 / 26 跳过 / 0 失败；`session-get-etag`、`checkpoint-visibility`、`steward-conversation`、`interventions-pool`、`mission-index-late-materialize`、`autonomy-durability` 六件 e2e 全过；依赖图 93 模块 649 边、SCC 仍 31（01q 在环外）；facts 557 e2e / 294 unit suite。