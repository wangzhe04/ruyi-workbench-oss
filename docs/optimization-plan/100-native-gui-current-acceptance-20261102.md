# 100 · 当前 Windows 原生恢复与加密 GUI 验收（2026-11-02）

本批已完成当前环境对齐、元数据传输优化验证、用户批准的完整长用例240秒双轮以及最终候选加密恢复GUI双轮。应用版本仍为 **3.0.1**；这不是整个M3、3.1或发布完成。原99和旧CAS保持历史原件，本页补充新的合同与实测。

## 本机与来源身份

Main为当前C盘项目工作区，分支 codex/3.1-completion-plan；本批基底9b219c06d3ce5c9c0c7c1e7b7dd60b428d5ccb70。实际验收在隔离候选 C:/r31-1102/cwt，分支 codex/m3-native-code-cache-20261102。旧E:路径只作为99的历史身份，不能作为当前执行入口；公开记录不包含本机用户profile路径。实际集成commit/tree以本地Git读回及交付收据为准，不预猜未来SHA。

Node24.14.0、Git2.52.0、Windows PowerShell5.1与Edge156.0.4314.58分别绑定当前文件、安装目录和实际caller。候选freeze为 be8597d181e115edd382f74718bce3bb11001344c7b806efa057b36e093736ef；生产模块13u为 b9189bd7463687e4c911cec09aece0ec0902944e998eefc7075a6844cb7b08c8。加入本页、CAS或staging会改变全仓身份，不能说旧完整freeze仍原样；限定引用依赖产品与执行切片逐字节连续性。

## 240秒合同的明确裁定

用户在本轮明确选择“整件调整为240秒，重新双轮验收，再收口最终GUI双轮”。原120秒来自run-all的通用单件防挂死默认值，未针对包含多轮转换/取消/撤销/冷恢复和两次24秒观察窗的完整件做专项性能推导。本次仅给 migration-skill-backup-representation.e2e.js 增加240000覆盖；全局默认、focused整件仍120000。原生命令120000、close2000、metadata30000、cold子进程120000、两次24000等待、原66断言及R1补充全部保留。

T71原120秒合同在120.0162177秒首红，后来139.1042063秒的5PASS/entry自然0单独保留，Root工具仍1；绝不追认为新240秒成功。T81/T82是不同GO、目录、进程与产物的新执行。源码预算测试同时钉住默认/未知件/focused120及完整240、串行分类和内部限度。

## 本批产品与测试

原生Rename缓冲按checked(sizeof24/16+真实UTF16字节)分配并提交，保留name offset20/12、真实FileNameLength、父handle和无覆盖语义；原C# SHA为 c9d7d11fa79a99ace71353a6fb3010eca69eedac855034e3b848a1e91e25e033，原Node factory SHA为 d32f7de37b6f8c16df0eb7a773303051003a90a1e9b64453bde4f4160bfe32b8。

private code-only cache只复用已完成代码字节；每broker仍新建PS/CLR与原native静态状态，工具/目录/heldFD/hash每次重核，不缓存DATA/元数据、不池化live broker。受FullLanguage/系统策略、私有DACL、source/artifact/CLR/MVID/type/reference与known-close/adoption/cleanup共同约束；不通过缓存重放业务或清除unknown。闭合NUL/base64 UTF8元数据传输、大小/字段/路径/hash与非法getter/proxy控制均已有独审和完整回归。

新GUI验收使用真实enable/export结果、独立master和不同package password、原两处folder-picker替身以及真实File201/restore202/receiver/native handoff。正文检索通过真实input/click、唯一选中消息及原renderer DOM；两次普通serve不带root override。并行unit preflight与测试alias批处理属于harness，原安全断言不删除。

新独立C#加载器、context并行和热脚本裁剪仅有外置原型/有限诊断，未纳入本候选。E81仅证明只读校验阶段约45.3ms的中位差；Q81保留首对波动且未证明稳健加速。用户改合同后停止加载器方向，原型未编译执行。不能以这些诊断声称原生120秒性能达标。

## 当前候选标准门与实际双轮

新完整九门batch57552自然0：官方build/graph/routes/facts、116定向、syntax1447、build freshness、完整fast及hygiene。该次fast自身包含445文件的完整unit preflight：4840tests、4809PASS、0FAIL、31SKIP、193suite；97不同static全PASS、0flaky、7live排除。31是测试skip，另有POSIX describe suite跳过；marked缺失时1个placeholder PASS不是实际解析覆盖，ACC/route原覆盖边界不变。unit保存的是原combined stdout/stderr，不冒称每unit独立CLI guard或stderr0。

顺序为生成器与116完成→freeze（readonly syntax期间）→syntax终态/buildcheck/新完整fast/hygiene；不是整batch开始前已冻。V8仅runner和对应budget unit两份raw内容相对V7改变，ruyi-workbench/下371份冻结文件（其中app/263份）及focused/long/GUI执行源码未改。V7 S71/S72 focused13.102/12.786秒的原有限pair只按相同执行切片引用，不称V8新跑。

原生第一列时长从紧邻entry spawn的Case起点计；GUI第一列从原launcher begin（含spawn前pins）计到all10，属于整件观察时长，不冒称纯entry执行时长。外层列包含证据观测与后验校验。

| 轮次 | 合同 | 整件观察至全部传输终态 | 外层证据终态 | 业务结果 |
|---|---|---:|---:|---|
| T81 | 原完整 representation / 240秒 | 136.358秒 | 330.209秒 | 5组PASS / 自然0 / 默认清理 |
| T82 | 原完整 representation / 240秒 | 135.399秒 | 320.550秒 | 5组PASS / 自然0 / 默认清理 |
| G81 | 最终候选加密 GUI / 900秒 | 229.508秒 | 369.613秒 | 6组PASS / 自然0 / 两普通boot |
| G82 | 最终候选加密 GUI / 900秒 | 233.542秒 | 373.554秒 | 6组PASS / 自然0 / 两普通boot |

两次原生均完整parent122+独立cold4，实际source编译/热字节加载及新artifact/MVID可对照。原IDs、DATA/ADS、四Basic含Access、shortname/readonly/security和history/DPAPI/cold语义按原断言保留。完整native件采用受控generation/owner-host接缝，不等于整条生产桌面root-switch流程。默认成功清理在入口结束前完成；已删fixture只按安全记录与源控制流接受，不额外重读DATA或虚构保留根。

两次GUI均284输入，digest ee237f5a3bd37e5ee6610f432c67c087f7520ca2e80a8f350b184128bea66041；各148journal/8checkpoint按hash读回。实际文件分别62177/62185字节，不写成恰1MiB验收。全部单轮及pair均独立复核/Root接受，按单scope attempts1自然终态推进，无重试覆盖首红。

## 证据和边界

[本批有限安全CAS与原始源码恢复索引](evidence/v8-native-gui-acceptance-20261102.json)包含250引用/229唯一gzip/6419840 packed字节；逐packed hash/长度、有界解压raw hash/长度和源码恢复校验另有交付记录。原始freeze和fast日志留外置，公开CAS使用明确标注的宿主路径脱敏派生，不冒用原raw SHA。旧[99安全CAS](evidence/3.1-closeout-20261102.json)保持不变。

归档只显式选择安全报告/公共源码/标准日志/元数据投影，不含fixture DATA/base/target/archive、key/config/stdin/env值、密文包、DLL/PE/缓存base64、private/default Git index payload、原browser正文/DOM/journal/checkpoint payload或进程dump。投影记录原对象hash不等于完整传递依赖或NTFS/OS备份。恢复旧source/caller/GO不会自动恢复执行授权。

原始secret-clear初始flag仍false；最终采用tracked await/assert控制流，不伪造最终flag或声称OS/JS历史明文抹除。CDP不能看File原始body，采用File对象构造控制流+后端receiver哈希；browser是采样身份与known Job收尾，target owned serve close不是所有OS后代连续自然0。cold子进程只按原spawnSync status/marker/正断言接受，不新增独立cold raw/CIM/all10证明。

R1/D11/P21/Q31/unit/S51/T71首红、环境/Root读回纠正及旧unknown保原标签，不由本批成功清除。完整默认618 E2E、CI、全M3（全部family/附件/retention/分片索引/非空八接线）、M4–M6与86其余范围继续；未打包、未push、未tag或发布，也没有执行用户数据迁移。
