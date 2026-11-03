# 101 · 生产快照保留读取接线（2026-11-03）

本批在 c5e7fad188841157dcc3d50bbb7747f6e9334834 基底上完成 13aq 生产快照适配器的保留源读取接线、真实 NTFS 双轮及受影响恢复回归。版本仍 **3.0.1**；这是 M3 非空迁移后续中的一片，完整八处生产接线、M3 与 3.1 尚未完成。

## 改动与边界

WorkDataNativeAdapters.fullSnapshot 将现有 bounded-native-v1 reader 交给原 WorkDataFullSnapshot，并在同步与异步 admission 中使用同一同步所有权判据。实际 ServerOwnership lease 和 withSource keeper 跨工作保持；guarded 在 capture 前后检查 helper unknown。已知 async predicate 在 owner 创建与回调执行前拒绝；普通函数返回 Promise/thenable/不透明对象时锁定 uncertainty 并保留所有权，不先 await 成 true。仅观察描述符核过的 native Promise rejection，未知 getter/proxy 不执行。

源保留读取验证文件 ID、DATA/ADS、readonly、别名、四项 Basic 时间与 owner/group/DACL 不变。恢复包仍按原 PROFILE 保存普通默认 DATA 与目录名，不据此升级为 ADS/Basic/security 恢复能力。13ak 的直接 full snapshot、migrationFactory、specialCoverage、rehearsal 清理及恢复激活等后续接线没有在本片全部闭合。

该生产适配器进入现有原生读取器的 10000 entries／96000000 DATA+ADS 字节工程上限；普通 reader 原有更大上限不等于新路径已支持。超限须拒绝，不能截断、跳过流或把未知结果改为成功。新件仍用统一 runner 默认120秒、PARALLEL_EXCLUSIVE 串行，原命令120秒／close2秒／metadata30秒不变；完整 representation 的用户批准240秒合同也不变。

## 验证

九项新增生产 host 单元将该文件从55增至64项，覆盖真实品牌keeper的接线、async零调用拒绝、pending/rejected/getter/proxy、回调中撤销、原生原cause和await间late unknown；直接运行永久E2E的纯VM控制另核metadata/final/chmod/rm时序。这些模型控制不当作NTFS或恢复包实际证据。

官方 build/graph/routes/facts 已重算；syntax1448零失败、build freshness通过。原完整 run-all --fast --parallel4 自然0，含445个unit文件：4849tests／4818PASS／31SKIP／0FAIL；97static全PASS、0flaky、7live排除。31为测试skip，另有POSIX describe跳过；marked缺失时placeholder不是解析覆盖。首次摘要脚本把跨行lane PASS漏计为94的后处理失败保留；随后按原194个start/end token核97distinct完成，原门未重跑。

| 轮次 | 范围 | 原整件预算 | 原全部传输终态 | 结果 |
|---|---|---:|---:|---|
| S01 | 新原生保留读取 | 120秒 | 12.239秒 | 5组PASS / 自然0 |
| S02 | 新原生保留读取 | 120秒 | 10.466秒 | 5组PASS / 自然0 |
| OW01 | 原受影响恢复回归 | 900秒 | 195.326秒 | 14组PASS / 自然0 |
| CI01 | 原受影响恢复回归 | 1200秒 | 300.844秒 | 9组PASS / 自然0 |

S01/S02各用不同新目录/entry进程，以真实生产adapter、真实native capture/metadata helper与genuine owner读取含readonly与ADS的合成非空根，real seal/open核默认DATA。两轮5canonical、strictstderr0、原10终态及source post已各自独审并追加pair。没有另行读取已删fixture，原producer断言与确切源码是有限证据；不虚构独立raw NTFS witness或全OS后代连续关闭。

OW01/CI01运行原未改永久E2E，保各自900/1200秒整件预算与所有原断言；对应源恢复和完成意图恢复。它们构造producer异常退出/故障窗口，不是捕获自然cold-worker崩溃，不是完整非空迁移。源码审查发现的async与E2E unknown两类问题均在实际执行前修复；未靠重跑覆盖功能首红。

## 证据与下一步

[本片有限证据索引](evidence/m3-preserved-snapshot-20261103.json)列出明确安全元数据与canonical日志，含SOURCE、四scope原Root/独审结果、原native pair和完整fast接受。原始fullfast含home provenance，原combinedunit、fixture DATA/包/key/config及DLL等仅留外置或不归档；本索引不声称传递依赖、OS备份或自动重放资格。最终EOL/hygiene与实际本地commit/tree由集成收据和Git记录补充。

下一片先把 13ak 的 full snapshot 源读取与同步 owner 判据接通，再处理 native rehearsal 证明/清理、migrationFactory、非空 special coverage 及私有恢复证明到激活的接线；继续全部family、附件、retention与完整分片索引。M4/M5/M6、完整默认619 E2E、CI、实际包/安装升级回退/跨账户跨机仍待。100保留上批完整原生240秒与GUI双轮身份，不能改写为本批新GUI实际。没有用户数据迁移、真实平台发送、push、tag或发布。
