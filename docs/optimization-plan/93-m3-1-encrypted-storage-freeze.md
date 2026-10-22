# 93 · M3-1 工作数据加密冻结：存储清册、独立密钥用途与版本化格式

更新：2026-10-22。状态：**M3-1a 已实现并验证；M3-1b（合成性能基线）未执行**。起点提交 `78884292`，分支 `codex/3.1-completion-plan`，应用版本仍为 `3.0.1`。

本批只冻结合同：没有迁移器、没有开关、没有 UI，没有读取、加密或改写任何用户数据文件，也没有新建任何存储目录。按 [92 §3](92-3.1-implementation-handoff.md) 的队列，"在写迁移器前冻结"由本批完成；M3-2 才动数据族。

## 1. 本批交付

| 交付 | 位置 | 说明 |
|---|---|---|
| 存储族清册（闭合） | `dev-harness/encrypted-storage-freeze.js` → `docs/architecture/encrypted-storage-freeze.{json,md}` | 以 `durable-state-inventory` 的 69 个 surface 为基准，逐族判定必须/必须不进入工作数据 envelope、归属密钥用途、迁移批次与最小可读元数据 |
| 闭合静态门 | `dev-harness/encrypted-storage-freeze.static.e2e.js` | 任一 surface 未分类、用途两侧不一致、字段无理由、提前声称"已加密"都红 |
| 版本化 envelope + 用途隔离派生 | `ruyi-workbench/app/src/01n-work-data-crypto.js` | 纯模块：`WorkDataCrypto.seal/open`，format v2，HKDF 按用途派生，AAD 绑定 schema/scope/seq，不建钥不落盘 |
| AAD 扩展点 | `01h-privacy-core.js` `aadFor` | 可选 `binding.extra` 尾段；不传时字节与 v1 完全一致，已有 envelope 全部仍可解 |
| 单元测试 | `dev-harness/unit/work-data-crypto.test.js` | 7 项：往返、用途隔离、轮换、v1 拒绝、绑定篡改、不隐式建钥、v1 AAD 兼容 |

## 2. 存储族清册

```bash
node dev-harness/encrypted-storage-freeze.js --write   # 重算生成物
node dev-harness/encrypted-storage-freeze.static.e2e.js # 闭合门
```

结果：**69 = 41 必须加密 + 28 必须不加密**，无遗漏、无重复、无未分类 surface。

### 2.1 判定原则

- **必须加密（41）**：工作台自有、含用户内容或可反推用户内容的状态——会话头/正文/provider 历史/命令与变更日志/草稿本/checkpoint 与撤销记录、记忆族、管家收件箱与决策、外部机器人收发与配对、定时任务与触发台账、agent run 与后台任务台账、工作流与 Playbook、以及**由密文派生的索引与缓存**（明文派生索引就是绕过封印的旁路）。
- **必须不加密（28）**，逐族写明理由，只有四类：
  1. 自带认证信封：`credential-vault-v1`、`credential-import-v1`、`privacy-mapping-v1`、`external-bot-credentials`。工作数据不得重新包裹、复制或改密它们。
  2. 外部所有权：CLI 配置与转录（`claude-settings`、`kimi-mcp`、`kimi-*`、`engine-transcripts`）、工作区声明（`project-agents`、`project-workflows`）、迁移备份。工作台不能把别人的文件改写成自己的封印格式。
  3. 可重建位置/运行时件：`runtime-handshake`、`last-start-error`、`generated-mcp`、`mcp-host-v1`、`install-registry`、`overlay-state`。
  4. 无内容记账：`usage-ledger`、`storage-trend`、`context-calibration`、`memory-import-marker`、`mcp-consumers-v1`（只有 token 哈希，且必须在任何解锁前可读才能认证消费者）。

`encryptionImplemented: false` 写进生成物：本批没有加密任何一族，静态门禁止在 M3-2 落地前把任何族标成已实现。

### 2.2 迁移批次（M3-2 执行顺序）

`sessions` → `memory-queue` → `tasks` → `index-cache` → `logs` → `backups`。会话一家先做完整的新旧读写闭环，再逐族接线；不要求一次提交覆盖全部数据族。

### 2.3 最小明文元数据白名单

每一族都必须声明"加密后仍需可读的字段 + 为什么"，空数组表示整条记录封印。原则：

- 标题、摘要（gist）、路径、URL、提示词、消息正文、工具输入输出**一律不进白名单**；静态门会拒绝字段名里出现 `title|gist|path|url|prompt|body|text` 的声明。
- 允许的只有：路由键（不透明 id 或 sessionId/taskId 之类）、排序时间戳、`schema/version`（决定读取器）、计数（分页上界）、幂等键（`occurrenceId`/`runId`）。
- 例外说明：`web-cache` 的键是 URL 哈希，只留 `fetchedAt`；`audit-log` 只留 `at` 与 `kind` 供轮转与分类，明细（命令、路径）全部封印。
- 容器自身的六个字段（`purpose`/`instanceId`/`schema`/`scopeId`/`recordId`/`seq`）恒为明文：open 时要用它们重建 AAD 与选择密钥，因此"空数组 / 整条记录封印"指**没有额外的业务内容字段可读**，不是连记录身份也看不见。它们是否可接受（尤其 `scopeId`/`recordId` 的取值形态）在 M3-2 接线时逐族复核。

## 3. 独立密钥用途与版本化格式

### 3.1 现状与差距

`01k` 的 `sealLocal/openLocal` 生成 `{version, instanceId, envelope}`，`purpose` 只参与 AAD，**所有用途共用同一把 vault master**。因此"用途"目前是绑定标签，不是密钥隔离；92 §6.2 要求 M3-1 先补这一层。

### 3.2 v2 容器

```text
{ version: 2, keyId: "work-data-v2.k<generation>", purpose, instanceId,
  schema, scopeId, recordId, seq, envelope: <PrivacyCore A256GCM envelope> }
```

- 派生：`HKDF-SHA256(master, salt="ruyi.work-data.v1", info="purpose:<purpose>:k<generation>") → 32B`；master 本身永远不当 AEAD 密钥用，两个用途永远不共享一把密钥；代次也进 info，所以轮换改变的是密钥材料，而不只是标签。
- AAD：`PrivacyCore` 原有三元组（instanceId/purpose/recordId）+ 尾段 `[schema, scopeId, seq]`。记录被搬到别的族、scope 或 revision 上，即使用途与密钥都对也解不开。
- 轮换：代次进 `keyId`。期望代次与容器代次不符 → `key_mismatch`，旧代次容器仍可用旧代次解开（轮换不销毁历史）。
- 拒绝矩阵：`format_unsupported`（v1 容器）/ `purpose_mismatch` / `key_mismatch` / `binding_mismatch` / `decrypt_failed` / `envelope_invalid`。v1 容器即使内层 envelope 是用同一把派生密钥封的也拒绝——迁移必须显式，不能"顺手升级"。
- 不隐式建钥：模块不 require `node:fs`、不碰 store、不持有 master 缓存；没有已解锁的 32B master 就报 `key_invalid`。"未启用且无旧引用时不创建密钥"因此是结构性保证，不是策略检查。

### 3.3 冻结的用途表

`WorkDataCrypto.PURPOSES`（11 个，与生成物 `purposes` 逐项相等由静态门钉住）：`session`、`memory`、`queue`、`task`、`workflow`、`search-index`、`cache`、`backup`、`audit`、`migration`、`user-config`。每个用途至少拥有一个族，没有空转用途。

## 4. 密钥生命周期合同（M3-2/M3-3 实施，此处冻结）

- 工作数据使用**独立数据密钥/派生域**，与凭据密钥分开引用、分开生命周期；不通过改全局 master 来"加密工作数据"，否则已有映射与凭据记录一起失效。
- Windows 账户封装（DPAPI CurrentUser）用于日常自动解锁；恢复包封装用于用户明确发起的跨机/故障恢复。两者是不同的封装目标，不能互相顶替。
- 默认沿用用户选择：用户主动开启后，启动、聊天、搜索、附件首读与备份不新增口令或确认步骤；关闭发送保护不解密存储；关闭凭据加密不销毁仍被工作数据引用的包装密钥；未启用且无旧引用不建钥。
- 只有密钥不可用、空间不足、恢复目标冲突、明文导出才需要用户处理；保留原数据、不静默降级明文、不隐瞒"仍有迁移前明文副本"。
- 口令恢复包必须继续区分"凭据恢复"与"完整工作数据恢复"；前者现有语义不得被改写。

## 5. 迁移状态机与唯一权威（冻结）

- 状态：`plain → preparing → ready-to-switch → encrypted`；暂停/失败停在可恢复的 `preparing`。关闭加密走反向影子迁移，同样认证校验与切换，不在原文件上逐字节覆盖。
- 准备期旧根是唯一权威，只允许既有 owner 写入；影子目录不对任何服务开放。后台准备需要可靠快照 + 写入/删除增量追踪（每 checkpoint 绑源 revision，变化的条目重做，删除有 tombstone）；没有追平机制就等空闲再准备，不得边复制活动目录边声称一致。
- 切换屏障：暂停新写准入 → 排空 inflight 与去抖/缓存 → 追平增量 → 验证影子与备份 → 原子提交活动 manifest。**所有异步 writer 都校验 generation**，不能只锁会话链。
- 提交后缓存、异步写、索引与备份跟随新 generation；迟到旧写拒绝或按新权威重新调度。不开双写权威，不把 read cache 当切换完成证据。提交后不能直接退回陈旧旧根，只能走已验证的恢复流程。
- 每个切点都要注入中断、进程死亡、磁盘满、损坏、文件占用与重复启动；错口令不修改数据，丢 key 保留原数据并在新根恢复。

## 6. 合成性能基线（M3-1b，未执行）

本批**没有测量任何性能数字**，不得据此声称"零开销""无感"。M3-1b 需要在同一台机器上以合成数据（不碰真实用户数据）记录明文基线：聊天首响应、追加写、启动、搜索、附件首读、恢复，各分冷/热两组 p50/p95，外加峰值内存与磁盘占用。冻结规则沿用 86，实施前明确：

- 正常路径新增交互步骤数必须为 0；持续卡顿不可接受。
- 网络等待不得混入本地延迟来掩盖成本；后台迁移单独报告准备总耗时与最终切换停顿。
- 阈值按实测冻结，同机中位数与 p95 变化超过约 10% 先查原因，不靠"波动"机械放行。

## 7. 验证记录（本批实际执行）

| 门 | 结果 |
|---|---|
| `node --test dev-harness/unit/work-data-crypto.test.js` | 7/7 通过（首轮 2 项失败：跨 realm 的 `deepStrictEqual`、把 `identity_invalid` 写成 `binding_invalid`，均为测试预期错，修正后通过） |
| `node dev-harness/encrypted-storage-freeze.static.e2e.js` | 21 项断言全过（首轮 1 项失败：5 个明文元数据理由过短，补全后通过） |
| `node dev-harness/syntax-gate.js` | 1132 文件 0 失败 |
| `node ruyi-workbench/app/build.js` / `--check` | 产物重建，`manifest` 行区间自洽 |
| `durable-state-inventory` / `module-dependency-graph` / `route-inventory` / `facts` 静态门 | 全过；依赖图 90 模块 644 边 1 SCC；facts 557 e2e / 289 unit suite（README 中英计数同步） |

未执行：产品 E2E 与真实包。完整 unit 全集在评审修复前的字节上跑过一次（2578 项 / 2552 过 / 26 条件跳过 / 0 失败 / 192 suites），修复后对最终字节复跑了受影响件（本单测 7/7、闭合门 21 项、`build` 与语法门、`fast` 静态 81 件全过）；局部通过不等于整轮，也不代表 M3 已验收。

## 8. 残留风险与下一批

- 未做迁移器与开关；41 个"必须加密"族目前仍是明文，不得对外声称工作数据已加密。
- 合成性能基线未测（见第 6 节），这是 M3-1 尚未闭合的唯一一项。
- v2 容器尚未接入任何产品路径；现有 `sealLocal` 的 v1 用途（`privacy-mapping`、`credential-import`）按第 2.1 节继续留在凭据信封内，不被工作数据信封覆盖。
- `aadFor` 的可选尾段是隐私核心的合同扩展，已由单元测试钉住 v1 字节不变，但仍需在 M3-2 接线时复核所有调用点。
- 附件分块、范围读与认证清单尚未设计；M3-2 只需小 JSON 整体认证，分块是附件批的前置。
- 下一批：M3-1b（合成性能基线）→ M3-2（会话族加密适配与接线）。

## 9. 独立审查记录（2026-10-22）

审查方式：独立子代理只读审查（reviewer 角色，逐行静态分析 + parse-only 语法检查）。该节点的 exec 权限被钳在 plan 档，无法实跑命令，因此"实际运行"类证据由主会话执行并在第 7 节引用输出，审查者负责设计、合同与数字核对。

原始结论：**未发现阻塞级密码学或合同缺陷**；质量门判 fail 的唯一原因是审查节点不能执行命令。共 10 条问题，本批逐条处理：

| 编号 | 严重度 | 问题 | 处理结果 |
|---|---|---|---|
| F1 | 中 | 中英 README 仍写"89 个有序模块"，`manifest` 已 90 | 已改为 90（两文件各 2 处） |
| F2 | 低 | 文档写闭合静态门"18 项断言"，实际不止 | 文档改为实际值（加固后 21 项） |
| F3 | 低 | `docs/README` 写成"单个密钥用途" | 改为"独立密钥用途" |
| F4 | 低 | HKDF info 未含 generation，轮换只是标签、无密钥材料隔离 | generation 并入 info；新增"改写 keyId 仍解不开旧材料"回归；文档与生成物同步 |
| F5 | 低 | 01n 对所有错误统一 `statusCode: 503` | 去掉预设 statusCode（模块未接线，与 01h 一致） |
| F6 | 低 | 生成物 derivation 描述是手写常量，无门校验 | 生成器从源码切片组合描述；静态门断言 salt、代次 token 与代码一致 |
| F7 | 低 | `codePurposes` 正则看不见含数字/大写的用途名 | 放宽为 `[a-z0-9-]`，并钉住两侧集合相等 |
| F8 | 低 | "空数组=整条封印"与容器明文六字段冲突 | §2.3 补明容器字段恒为明文及复核责任 |
| F9 | 中 | 审查者未能实跑 5 条命令与 AAD 对比 | 主会话实跑并记录（第 7 节）；另做旧版/新版 `01h` 双向加解密对比 |
| F10 | 低 | 单测里有一处无操作的对象展开，注释易误导 | 删除无操作，改为有意义的"re-version 但仍是旧 AAD"用例 |

审查者静态核验通过、本批未改动的要点：`aadFor` 无 extra 路径与 HEAD 逐字节同构且没有其他调用方带 extra；容器对 `__proto__`/额外键/数组/NaN/非安全整数/巨大 seq 均失败关闭；nonce 只由 `PrivacyCore.seal` 生成；69 个 id 与清册逐一点数吻合，41/28、批次数、11 个用途在代码/生成物/文档三处一致；`manifest` 行区间算术与 `server.js` 再生成内容逐字一致；93/92 对未做事项如实标注。

修复后复跑：单测 7/7、闭合门 21 项全过、`encrypted-storage-freeze.js` check 通过、`build`/`build --check` 与语法门通过；`facts` 计数不变（本批未增减 E2E 与 suite 数量）。
