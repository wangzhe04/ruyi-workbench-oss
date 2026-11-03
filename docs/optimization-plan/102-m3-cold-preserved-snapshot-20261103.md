# 102 · 冷维护快照保留读取接线（2026-11-03）

本批从 dd923bf7ac8aa15688b00d6189988af7b8670eb9 继续，把 13ak 冷维护快照接到 13aq 真实生产宿主。版本仍 **3.0.1**；这是 M3 非空迁移后续的一片，完整 M3 和 3.1 尚未完成。

## 行为与边界

13ak 的源 seal、恢复演练和显式恢复统一使用宿主 fullSnapshot。缺失能力明确拒绝，不能回落到普通读取器。宿主沿用 genuine ownership、同一同步 admission、preserved reader 和 keeper 生命周期。crypto 后端固定；只有私有冷维护桥接能够在 key/vault owner 脱敏之前观察原始失败，公开快照参数不能替换 protector 或观察器。观察器异常或 pending 返回保留 unknown，原 cause 保持主错误。

异步工厂返回值不能成为快照所有权。只给经描述符校验的普通原生 Promise 安装拒绝观察，仍按 unknown 拒绝并保留 claim；未知 getter/proxy 不执行、不 await 为成功。独立复核发现并修复了 Promise 拒绝未观察、observer constructor getter 和旧 E2E late-unknown 可能误报成功三个 P2，新增反例且保留原断言。

新永久件使用真实 coldOperationHost、真实 export 操作体、恢复演练和独立 work-data-verify 进程。指定 data 子树含只读文件、真实 ADS 和空目录；核 DATA、ADS、ID、别名、Basic 四时间及 owner/group/DACL。控制/结果写入会合法改变根目录，不能把 payload 见证说成整根不变。备份仍只承诺默认 DATA 与目录名，不能升级为 ADS/Basic/security 恢复能力。生产 reader 上限仍为 10000 entries／96000000 DATA+ADS 字节；超限拒绝，不能截断。

## 首红、诊断与修正

首次相关单测 RED 保留。复核确认生产 adapter 的 guarded 原本就会锁存原始 uncertainty；首红也包含旧夹具固定保护器和委托不完整的问题，不能据此声称生产后端已丢失该标志。修复后相关 122 项通过；新增收尾模型后 production-host 为72项通过。模型控制不当作 NTFS 或进程实际证据。

旧 cold-operations 四操作回归 L01 在原120秒合同下触发永久 RED。它后来152.8626457秒才收齐终态，虽有4组业务 PASS、stderr0和旧入口强退0，也不能改判。用户随后**单独授权该件整件240秒并重新双轮**；原命令120秒、close2秒、metadata30秒和全部安全断言不变。统一 runner 只新增该件240秒 override及独占分组，默认120秒、focused/native新件120秒和此前 representation 的独立240秒合同均保留。

生产维护 PM01 在原900秒内148.261659秒退出1，停在 snapshot／preparation_failed，不能称为整件超时。其只读监听和合成现场保留。隔离诊断副本 D01 只在原失败处理后记录有界安全错误码，得到 preparation_failed → work_data_tree.source_changed；它不是产品通过。诊断拒绝 getter/proxy、循环和超长值，每码≤160字符、整条≤8KiB；原hold不变，未读取 DATA/config/key 或操作旧进程。

复核发现 PM/PR 两个 waitSuccessor 在确认 warm 前每50毫秒普通读取 runtime.json，可能与源或演练目标的原生保留证明重叠。现先探测同端口 HTTP，仅 warm 分支内读 runtime；原 PID/token/port/result/authority/quiet/CIM、截止预算和失败诊断判据保留。新增真实函数切片 VM 控制验证非warm零DATA读取、移除守卫反控和原deadline。修后新维护/恢复回归通过，支持观察修正有效；没有第一现场逐字段元数据差异，不追溯宣称唯一根因。PM01/D01/L01原判保持。

## 验证

最终固定源码语法门1449文件零失败，官方 build freshness通过。完整 unit/static 门自然0，含445个unit文件：4864 tests／4833 PASS／31 SKIP／0 FAIL，193 suites；97 static全PASS、0 flaky、7 live排除。31是测试skip，另有POSIX describe跳过；marked未安装时placeholder不是解析覆盖。

最终外置门调用器的字符串替换误把4个pin路径插入argv。实际driver和完整argv保留：本版 includes('--fast') 优先于指定文件分支，unit另构造完整445文件glob；独审以真实选择代码及194个lane start/end token核出同一97 static清单、4路、无裁剪。因此有限接受有效全量fast范围，不把该次说成标准argv、不另跑原PM/PR、不重跑已完成同范围门。较早一次源码门检查期间修源、post pins drift的失效记录也保留，不能用于最终源资格。

| scope | 范围 | 整件预算 | 全部传输终态 | 结果 |
|---|---|---:|---:|---|
| C03 | 最终原生冷导出第一轮 | 120秒 | 22.649秒 | 5组PASS／自然0 |
| C04 | 最终原生冷导出第二轮 | 120秒 | 22.719秒 | 5组PASS／自然0 |
| L02 | 新合同四操作第一轮 | 240秒 | 148.800秒 | 4组PASS／Root0，旧entry强退 |
| L03 | 新合同四操作第二轮 | 240秒 | 154.562秒 | 4组PASS／Root0，旧entry强退 |
| PM02 | 原生产维护回归 | 900秒 | 226.677秒 | 14组PASS／自然0 |
| PR01 | 原生产恢复回归 | 900秒 | 274.490秒 | 26组PASS／自然0 |

各轮使用新scope目录/entry进程，固定同一最终源与Node24身份、strict stderr0、原十项传输终态和source post。C轮入口自然返回；L轮保留旧entry的 forced exit，不能因外层自然0就升级为入口自然关闭。原producer及确切源码构成有限证据，不伪造独立raw NTFS读回或全OS后代连续关闭。

## 证据与下一步

[本批有限安全证据索引](evidence/m3-cold-preserved-snapshot-20261103.json)记录最终源、六个scope的原Root/独审、两组fresh pair和完整unit/static接受，并保留原L01/PM01拒绝及D01诊断。暂存后EOL与隔离repo-hygiene通过，收据在索引中；收据追加后的最终尾门、staged复核与本地提交/快进另由最终检查和Git记录定位，不虚构自引用commit哈希。

公开归档限明确安全元数据和canonical日志。原始full-fast含HOME provenance、combined unit、fixture DATA／恢复包／key／config及native DLL/cache不归档；不跟随任意report引用。原失败现场不清除。没有用户数据迁移、真实平台发送、push、tag或发布。

后续继续 rehearsal 证明/清理、migrationFactory、非空 specialCoverage、私有恢复证明到激活的接线，以及各family、附件、retention与完整分片索引。M4/M5/M6、完整默认620 E2E、CI、实际包/安装升级回退/跨账户跨机仍待。100/101保留各自历史验收身份，本批不把旧GUI双轮称为本批新GUI实际。
