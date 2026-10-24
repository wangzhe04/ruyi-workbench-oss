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
