# 103 · 恢复演练保留读取与安全清理（2026-11-03）

本片从 `cb03470fd99efb34db19da7828dbd4502af49674` 继续，完成冷维护恢复演练的原生保留读取、跨复验进程的真实所有权交接及清理收口。这是 M3 后续的一片；版本仍 **3.0.1**，完整 M3 和 3.1 尚未完成、未发布。

## 产品变化与合同

13ak 不再用普通 WorkDataTree 读取恢复演练目标，必须调用生产宿主的 captureRehearsal。13aq 使用真实 createPreserved、同步 genuine owner 判据和 source keeper；独立复验前释放原目标 lease，复验后重新 acquire 的 lease 才能授权下一次读取。跨进程保留的初始字节与身份指纹是私有闭包，公开 snapshot 行不是删除许可。

两次新 owner 复查之间保留原生 exact namespace/default-stream census，额外对象、ADS、链接、替换身份或 DATA 变化仍拒绝。初始缓冲区必须在删除及目标 owner 关闭前完成同步 void 释放；失败、pending Promise 或不透明返回均保留 unknown，释放只尝试一次。主错误与随后清理错误共同保留，最后一次 genuine keeper 也会因释放不确定性撤销关闭资格。

跨复验的 sha256 绑定路径、原对象身份和 DATA，**不冻结跨窗口的 Basic、ADS 或 security**。每次原生读取本身保留其支持的元数据；最终 disposal 仍限制精确默认流与目录。备份继续是默认 DATA/目录名合同，不能称为元数据恢复或非空 special portable 已完成。源 metadata 见证只针对合成 data 子树，控制/结果写入会合法改变源根。

独立源码审查修复了跨独立 restore 目标的 admission 回归、主错误被后续 release 覆盖、非 void 拒绝 Promise 未观察、释放不确定性未撤销已检查 keeper 四项问题。公开 fullSnapshot 仍接纳原合同下的 source/target genuine lease；rehearsal 读取严格绑定其目标根。

## 验证与首红保留

最终针对性 155 项通过，含真实 01g 所有权模型、清理/错误反例、冷操作、调度夹具及整件 engine-env-brief 集成检查。模型、普通临时文件与整件入口检查不代替 NTFS 验收。

三个完整门的首红分别保留：

| cohort | 原结果 | 处理与边界 |
|---|---|---|
| v1 | unit 4846 PASS/31 SKIP；static 最终97 PASS但1 flaky | engine-env-brief 在 ALL PASS 后出现 Node Windows async.c 原生退出断言；runner 自动重试不清除首红 |
| v2 | unit 4849 PASS/31 SKIP；static96 PASS/1 FAIL | 夹具错误地把私有 flush 当公共导出；改为单次内部测试加载，同一模块保留真实公共导出检查与私有 drain |
| v3 | unit4849 PASS/31 SKIP/1 FAIL；static未启动 | scheduler U3 的 needs_you/timeout 首红保留；确认夹具漏隔离公网探测并补实际空目标断言，不追认原现场唯一分支或负载根因 |

两件夹具使用既有 NO_NET_ANCHORS 开关，原预算和业务断言不变；engine-env-brief 真实 rg/git 探测保留，等待同模块日志 drain 后自然退出。调度夹具仍保留1500毫秒批准/回合预算、4秒慢回合及原时间断言，产品 timer 未改。新整件子进程检查实际覆盖公共 API/私有 drain 的组合，补上只靠 stub 未发现的导出缺口。

最终 v4 固定源码门：1449 文件语法零失败，官方 build freshness 通过；完整 `run-all --fast --parallel 4` 自然0，含445个 unit 文件、4881 tests/4850 PASS/31 SKIP/0 FAIL、194 suites；97 static 全过、0 flaky、7 live 排除，浏览器预检与残留均0。31为测试 skip，另有 POSIX describe 跳过；marked 缺失时 placeholder 不作为解析覆盖。unit 原报告是合并输出，不称每个 unit 独立 stderr0。

## 当前固定源实际验收

下列 scope 全部属于新的 `rehearsal-task/v4`，不重命名或改判102中的历史同名记录。每窗新隔离 HOME/双 AppData/TEMP，使用 Node24 固定源、guard、原被动观察器，严格 stderr0、十项传输终态、后验 source pins；每窗 Root 与独审接受后才进入下一窗。

| scope | 范围 | 整件预算 | 全部传输终态 | 结果 |
|---|---|---:|---:|---|
| R01 | 原生冷导出/演练第一轮 | 120秒 | 27.730秒 | 5组 PASS/入口自然0 |
| R02 | 原生冷导出/演练第二轮 | 120秒 | 27.761秒 | 5组 PASS/入口自然0 |
| L01 | 冷操作完整长回归第一轮 | 240秒 | 170.859秒 | 4组 PASS/外层自然0，旧入口强退 |
| L02 | 冷操作完整长回归第二轮 | 240秒 | 168.042秒 | 4组 PASS/外层自然0，旧入口强退 |
| PM01 | 原生产维护回归 | 900秒 | 241.663秒 | 14组 PASS/入口自然0 |
| PR01 | 原生产恢复回归 | 900秒 | 297.589秒 | 26组 PASS/入口自然0 |

L 轮沿用用户对 cold-operations 单件的独立240秒授权；原命令120秒、关闭2秒、元数据30秒及安全断言保持。它不变更 representation 的另一份240秒合同，也不清除原120秒 RED。双轮 source/caller 相同、scope 与入口 PID 不同；已删除夹具不伪造重新读回，父进程传输闭合不升级为所有 OS 后代连续关闭。

## 证据、集成与下一片

[有限安全证据索引](evidence/m3-native-rehearsal-preserved-20261103.json)包含显式安全元数据、Root/独审锚、canonical 派生日志及原失败摘要。原始 unit/HOME provenance、fixture DATA、恢复包、key/config/stdin/env 内容、DLL/cache 不公开归档，不跟随任意传递引用。原场景与旧未知 actor 不清除。批次签署记录保留签署时尚待归档/尾门/集成的历史状态；最终暂存、尾门及本地提交/快进由后续独审、Git和源外集成收据定位，不虚构自引用 commit。

用户要求持续完成 M3。下一片继续 migrationFactory 的 genuine/sync/preserved 接线及实际 codec 源读取；只读解码 scope 与目标写入分离，目标写后比较另取新证明，不能把旧完整 capture 穿过合法 candidate/intent 写入。随后完成非空 special 覆盖、精确 owner delta、同 producer 恢复证明到清理/激活、全部 family、附件、retention sealed-fault 与完整索引组合验收。

当前清册78面为45 required/33 excluded，required 中 adapter 声明42 wired、3个全文索引 pending；既有索引核心不能因 pending 标签重写，也不能以历史41/41代替当前全族组合。uploads/tool-image/send 派生件的二进制面仍须独立登记和接线；86 §8.1 的分块认证、范围读取与完整性要求保留。旧明文源按86 §8.2明确显示受管位置与用户退休选择，不称所有副本全部加密。

100/101/102各保历史验收身份，本片不新增 GUI 双轮身份。M4/M5/M6、完整默认620 E2E、CI、实际包、安装升级回退及跨账户跨机仍待。没有用户数据迁移、真实平台发送、push、tag、版本升级或发布。
