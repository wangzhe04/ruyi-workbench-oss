# 96 · M3-3 迁移、恢复包与启用 UI

日期：2026-10-24。基线：`415357604f6465f43b377d1d30ff713464a8fa96`。分支：`codex/3.1-completion-plan`。应用仍为 **3.0.1**。

用户已授权继续多 agent 实施，按批验证、独审后 commit/push；先前“当天收工”的安排已取消。本记录追踪 M3-3，**不将基础模块通过写成迁移或启用 UI 已完成**。合同继续以 [86 §8](86-3.1-completion-and-privacy-roadmap.md)、[93 §4–5](93-m3-1-encrypted-storage-freeze.md)、[94](94-m3-2-encrypted-storage-adapter.md) 为准。

## 1. 首批基础与修复

| 项目 | 已实现范围 | 仍需生产接入 |
|---|---|---|
| `01t-work-data-recovery.js` | 独立于凭据包的口令快照 codec；固定 scrypt/AES-GCM；版本、文件/目录清单、总字节、逐文件 hash、两类独立 master 引用；严格路径和输入预算；返回 Buffer 释放 | 完整树与真实密钥引用发现、一致快照、直接 DPAPI 凭据的可移植表达、新根恢复、NTFS 元数据及恢复后实链验证 |
| `01o-work-data-keys.js` staging | OFF 时显式生成目标独立密钥；已有 master 用原用途本机 DPAPI 重封并往返校验；不读写活动 store/配置/cache | lifecycle 独占、新根冲突判定、目标 key 文件发布；凭据 master 的独立 portable 生命周期 |
| `01u-work-data-transition.js` | generation 准入能力；等现有任务及嵌套操作完成；取消等待；失效 ALS 续调拒绝；不可取消 commit；歧义失败保持 retired | 逐 owner 的生产准入、排空与路径绑定；后台 timer、删除/保留期、缓存以及内部 MCP 子进程都须覆盖 |
| `01v-work-data-manifest.js` | 唯一活动指针文件；隔离候选；严格目录/manifest/UTF-8 验证；exact previous bytes 与 hash 复核；提交失败保留候选和旧根 | Windows 平台持久发布、完整候选内容验证、跨重启候选认领/取消、启动路径选择与自动接续 |
| 通用配置入口 | 所有显式 `workDataEncryptionV1` 值均以 409 + `work_data.encryption_requires_setup` 拒绝；同时返回 `apiCode` | 唯一的本机 lifecycle 入口及启用/关闭 UI |
| 配置变更审计 | logger 等待配置 mutator 与物理写 owner，配置 revision 变化最多重读三轮；不进入 `readConfig`；坏配置/import/vault 变化拒绝 | 此修复已生产接通；未来 mutator 不得 await audit flush，避免自等 |

`01t/01u/01v` 已进入生成服务，但尚未由启用流程调用。没有打开用户开关、迁移真实数据、创建真实恢复包或发布安装包。

手工产品源码 6 文件，新增 558 / 删除 20，净增 538 行；生成 server、manifest 和架构清册另计。测试、研究表和证据不并入产品逻辑增长。

恢复 codec 的 `keyRefs` 仅验证**调用方声明的引用存在**，不能发现实际密文中未声明的引用。默认 256 MiB 是 v1 整包实现的可配置工程预算，预检超限须保留源数据；不是新的业务数据容量，也不代表固定 RAM 上界。JSON/base64/口令字符串不能承诺清零。真实 Windows 同账户重新包装可验证 native DPAPI 路径，不能冒充真实跨账户/跨机器恢复验收。

## 2. 首次失败与独审修复

1. 准入屏障原先在 durable commit 后检查取消，存在指针已提交却放行旧 writer 的窗口。改为 `owner.commit(next, publish)`：取消只在 publish 前生效，开始发布后成功或失败都退役旧进程的准入；失败结果由新进程读真实 manifest 判定。
2. manifest 生成 stage 名时随机数异常会让本地 busy 永久保持；已纳入 try/finally，并验证同候选显式重试。
3. 发布后收到冻结异常时，不能原位写 `commitUncertain`；现统一创建受控异常封装，保留提交歧义。null/string/undefined 异常同样处理。
4. 首轮 HTTP 新断言发现只有 `code` 没有 `apiCode`，通用 `sendError` 返回了通用内部码；修复后保留精确 409 机器码断言。
5. 旧配置回归中的 provider 缩减/清空审计丢失，在基线原服务 + 原测试同环境复现，未放宽原断言或 300 ms 预算。根因是日志先于物理配置写入链排队，随后发布使样本失效；现在等待包括发布的 mutator，再对合法 owner/revision 变化有限重试。
6. 新 foundation E2E 的 `Object.assign(process.env, isolated)` 未删除隔离器明确移除的旧变量，可能继承 `RUYI_TEST_SERVER_JS`。已按返回环境删除缺失变量，再加载生成运行时；不改机器环境。

审查按文件分别由非作者完成，首失败、负控、修后 SHA 及独立探针保留在本批证据中。原配置回归断言全部保留。

## 3. 后续集成的具体约束

- 活动 manifest 是唯一格式/根提交权威；不能先翻活动 config 为 ON 来调用 `ensure()`。使用独立 staged key 和目标 codec，提交后才派生配置镜像。
- 启动恢复放在 `ServerOwnership.acquire` 之后、`ensureDirs` 和全部 boot consumer 之前。`MigrationHooks.recover` 目前在 ensureDirs 后，不能直接把全局切换塞进去。
- 当前 paths、缓存与异步工作会捕获文件身份。单个内存 barrier 不构成生产屏障；提交后的旧进程必须保持 retired，完整的路径/缓存失效或受控重启仍需实接。
- 等待空闲不能调用现有 stop 方法：它们会 abort 正在运行的任务。需关闭新工作准入并允许旧任务完成，包括其待决权限/提问回答及 stop 操作。
- 覆盖配置两条链、全部会话写/变更/笔记链、去抖索引、audit Writable、记忆、管家、scheduler、外部投递、后台任务、迁移 owner。内部 MCP 默认可直接 `toolCall` 写盘，serve 的 OS 锁不能代表子进程写入已排空。
- 41 族主文件之外，覆盖 `.prevbody`、`.v1bak`、事件 `.gz`、隔离损坏件、未完成 staging 和应用管理备份。gzip 内层日志反迁移需同时解封，不能只解外层 binary envelope。
- 迁移采用固定 binding 的严格文本/二进制转换，避免 `createJson` 的 sanitize/default/quarantine 改写旧数据。对逻辑字节做完整 hash 及认证，不能用 stat 作内容证明。
- NTFS 原对象 capsule 依赖 file ID、ADS、ACL 和短名；普通 `fs.cp` 会破坏恢复协议。必须走专用迁移/portable 恢复，不得为“完成”忽略旧备份或删除唯一副本。
- uploads、用户 skill 内容和其它明确 excluded 的工作台数据可能仍是明文；完整恢复包仍须包含所需内容并准确披露保护范围，不能把 41/41 适配器等同于全部媒体已加密。

Windows Node 24.14.1 在实测目录 handle.sync() 返回 EPERM；当前 manifest 默认 publisher 在 rename **之前**明确拒绝，保留旧权威。需专门平台适配后才可称 Windows 切换可用。微软 [MoveFileExW 文档](https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/winbase/nf-winbase-movefileexw.md) 给出 WRITE_THROUGH/REPLACE_EXISTING 语义，[目录句柄文档](https://learn.microsoft.com/en-us/windows/win32/fileio/obtaining-a-handle-to-a-directory) 列出可用操作；这两份文档不能代替实际 native 进程死亡/占用/磁盘故障验证，也不构成物理断电保证。

## 4. 验收状态

本批最终验证见[基础证据](evidence/privacy-m3-3-foundation.json)：Node 24 全量 unit **3132 项：3106 通过、26 条件跳过、零失败**（Node 报告执行次数，不当作唯一覆盖数）；相关 unit 104 项通过；配置 HTTP、实际 DPAPI 恢复底层组合、实际 DPAPI audit 各连续两遍通过；语法 1225 文件零错，生成服务新鲜。

81 个静态件首轮 80 过、1 个 facts 失败：新增测试后 README 双语计数尚旧。只同步 579 项 E2E / 默认离线 572 项 / 341 组 unit suite，原 facts 断言不变，单件重跑通过；其余 80 件没有修改，不称首轮全部通过。全量默认 572 个离线 E2E、真实跨账户/跨机器恢复、实际包未跑。

旧 76 项 egress 错误集合逐项不变；本片 4 个新词法候选分别登记真实 DPAPI process、ALS 本地 callback 与文件写边界，不将普通子进程/文件写升级成受保护外发。

[41 族研究表](evidence/privacy-m3-3-storage-catalog-research.json) 只提供路径和 codec 线索，不是可运行迁移闭合；external-bots 的初稿格式标签已按真实 `chunked:true` owner 改正。独立模块的单测、合成故障探针及生成服务组合件，都不能替代完整首次迁移、后台等待/取消、启用 UI、反向关闭、完整恢复与真实升级旅程。**M3-3 继续进行中**；不标整体完成。

## 5. 第二批：本机发布、凭据 staging 与转换桥（2026-10-24）

基线 `c773068c4904ecb322a3edf112bb53a82d88a9dd`。本节更新第 3 节的 Windows publisher 状态；首批失败记录保留。`01w` 已向 manifest 注入固定 native publisher；Windows 本地 NTFS 的原生目录 `FlushFileBuffers` 实测成功，Node 目录 handle 的 EPERM 不能推断为平台不支持。

| 实现 | 验证范围与限制 |
|---|---|
| `01w-work-data-native-publish.js` | 固定 PowerShell/C# 桥；同卷本地 NTFS、严格路径/文件身份、源文件及祖先 guards、发布前后目录 flush、`MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` 与目标身份/hash 回读。真实发布、占用、错误与 helper 生命周期已验证；未证明物理断电或整个 shadow 正文的持久性，也不提供恶意同账户 namespace CAS。 |
| `01v` hook 与错误传播 | publisher 在实例创建时捕获；显式注入优先。helper 仍可能运行时向 host 保留 `helperMayStillRun`，不能先释放维护所有权或恢复旧 writer。 |
| `01k` 恢复 staging | 独立持有 DPAPI 解出的 master，认证所有不可变历史凭据记录及 fingerprint；完整解析状态序列化证明，不借用可被 cache.clear 清零的 master。目标保持 instance/记录，重新 DPAPI 包装，不发布活动配置或 vault。该证明不是 raw 文件 CAS，实际配置引用闭合仍由 host 完成。 |
| `01x-work-data-migration-codecs.js` | 41 项描述中 40 项为 codec-only，NTFS capsule 明确专用 owner。固定真实 binding，严格文本/记录/二进制及 gzip 内层转换，校验逻辑原始字节；不 sanitize、修坏数据或覆盖目标。返回 `domainValidation: host-owner-required`。保留副本、未完成 staging、NTFS 对象和完整目录 census 继续接入。 |

独审发现并修复 Windows 混合大小写技能 ID 的 recordId 绑定错误。原 25 项转换单测沿用了描述表，未发现这一点；现在独立捕获 30 个真实整文件 owner 的 binding，30/30 一致，并增加真实 owner 互读及移除修复即失败的负控。原生发布初稿的目标 guard 导致 Win32 5、timeout 早于实际退出及 kill error 被误判为未启动，均保留首次失败并修正；只有无 PID 的真正 spawn 失败才能报告明确未发布。

最终生成运行时的恢复组合由 5 扩到 10 组，连续两遍通过：工作数据与凭据/privacy 两个独立 master、历史凭据、冷 cache 本机 DPAPI 重封、错误口令/损坏包保留所有源字节、实际 manifest 发布/占用重试，以及四种文件原始字节的加密与反向转换。仅测试指针发布和 codec 组合，**没有执行完整生产迁移或真实跨机恢复**。直接 DPAPI 外部机器人凭据没有第三个 master，正在单独实施 portable auxiliary。

修前完整 unit **3181 项执行，3155 通过、26 条件跳过、零失败**；定向 109 项通过；凭据 HTTP E2E 连续两遍通过；语法 1230 文件零错。81 个静态件首轮 80 过、1 个 NDJSON feeder 锁失败：新 publisher 仍逐块 `toString`。修复为在原 8 KiB 限额内保留 Buffer、close 后统一解码；原静态断言保留。修后 native 7 项 unit、生成运行时组合两遍、原失败静态件及 manifest ranges、源码/生成服务语法和构建新鲜检查通过；其余 79 静态件未改，未重跑完整 unit。全部精确身份、独审和负控见[第二批证据](evidence/privacy-m3-3-native-and-codecs.json)。新增三组 unit suite 后，清册为 579 E2E / 默认离线 572 / 344 unit suite。旧 76 项 egress 错误逐项保留，6 个新词法候选按真实 process/capability/regex 分类，不升级为受保护外发。

下一批正在实施直接 DPAPI 凭据的 typed auxiliary 与内部 MCP 单一 writer 接入。完整 owner 屏障、启动根选择、完整备份/恢复、NTFS 专用迁移和启用/反向关闭 UI 仍未完成；全量默认离线 E2E 与实际包仍待最后集成验收。
