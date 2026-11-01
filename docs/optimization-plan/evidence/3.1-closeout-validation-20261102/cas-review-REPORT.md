# 3.1 closeout CAS / source recovery — independent engineering review

**PASS_SAFE_CAS_AND_SOURCE_RECOVERY_ONLY，无 P1/P2。** 仅接受 Root/Terra 的选定归档与恢复工程，不是产品晋级、完整3.1/M3/M4验收、正式发布或任何 actual GO。本人是R8实现作者；R8代码由另一位作者独立审查，报告6b7893034fbb736449736380a20eb02a274ee391e8127b331cd541532606a799。本轮不自审R8逻辑，只独立核归档来源、内容种类、字节和恢复关系。

被审 index：docs/optimization-plan/evidence/3.1-closeout-20261102.json，103435 bytes，SHA a6fceae47696c1a81b55601f075426c67cb3792807676d01767611b67e325a47。外置SELECTION-02 SHA4d6f74b7674a3dd7fcb6efd0de055b17820a30a54140a4bfef2ea255a64d107b，Terra RECOVERY-READBACK SHAd6facb4d68bde2516093d6cf234eb1896eb5001fd7d227270f704220025cf9cc，均精确核对。本审没有改151refs index、gzip、任何旧CAS/candidate、源或文档。

独立逐项检查151引用：97个明确选定项加54个冻结候选净源码项；146个物理gzip，packed总13275684 bytes，raw引用总55451002 bytes、unique raw46436710 bytes。所有packed长度/SHA、bounded gunzip后raw长度/SHA、原允许leaf文件bytes均相等。artifact地址严格为该rawSHA的单一blobs/<sha>.gz，没有越界路径或额外文件。151→146来自5组精确别名：两README的GUI/focused共用，另native R1/focused的server、13u、manifest共用；每组packed/raw元数据一致，未把不同内容混成同blob。

解压每文件raw最多16MiB、packed最多8MiB，unique raw总上限128MiB、packed总上限32MiB，所有文件读取总上限256MiB；实际82,812,486 bytes读取。逐blob一次有限解压，无树展开或工具执行。146个payload均为严格UTF8文本，无NUL、DIRC、MZ或PEM private-key起始材料；这一检查与明确来源/字段语义审查共同使用，不把字符串扫描当成任意秘密不存在的证明。

种类逐项对照SELECTION允许清单：84 safe-report、7 recovery-patch、5 source-code、1 safe-result-metadata，另54 raw-source。前97项id/kind/originalFile精确映射，raw54只来自四个freeze的净delta与对应candidate源码leaf；没有自动递归收集。controller/launcher/observer仅作为源码文本读取，没有导入或运行。源代码内固定SYNTHETIC值属于已冻结测试源码，不是本机运行密钥。

没有归档private index二进制、fixture DATA/base/target/archive/key/config/stdin、raw私有stdout/stderr、真实环境值、进程dump、runtime工具exe/dll。SOURCE-FREEZE/PINS中的index/stream路径、bytes/hash是元数据引用，不是其payload，本审没有追读这些传递引用。5个疑似隐私字段逐项澄清：stdout/stderr是file/bytes/sha对象；authorization是固定Root GO类别或null；environment是键/分段数量及hash的clamp观察摘要，不含环境值。未发现禁收内容。

唯一允许的场景leaf为SELECTION明确指定的gui-actual02/result.json安全观察metadata；其已列result字段是checks/inputProof/authority/export/browserClosed/readable/boots等观察及false完整性范围，没有扩大读取其父目录、相邻文件、fixture明文/加密key/归档。这不等于审过整个scene、全部传递引用或OS。

54份raw源码逐一与freeze的path/mode/bytes/rawSHA/expectedGitBlob匹配，也与原candidate对应leaf相等。Git实际stored blob逐一回读；仅在原freeze确有CRLF→LF canonicalization时按这一单一转换核Git blob，不做其他归一化。四组delta与tree净路径集合也逐一相等。

本审另从CAS解出的补丁，在四个全新的外置private index中从真实3284869066ebb3319c3238e97a766aa565fb8bea read-tree，cached apply，再write-tree。没有checkout/reset/clean/default add：

| 恢复组 | 净源码数 | 独立重建tree |
| --- | ---: | --- |
| GUI R2 |9|92c2999e9e86e0834a5508c11008ff696ae73b47|
| M4 R8 |25|e9c8b0c365065b9566897bcd707fafa597c89e33|
| Native size R1 |8|a187ad3a96a06a39b56a71be34a0ac4baf96a70a|
| Native focused R2 |12|36ea4e711fa8499f23125f7edeaba4880a98117f|

四树均与selection/freeze/Terra恢复收据一致。GUI补丁2行EOF空白warning、M4补丁1行trailing-space warning原样保留，没有修补原patch。审查过程中可能写入Git objects，故不称“全只读”；4个private index仅在本审外置private-indexes目录，PINS只记录其semantic/hash证据，排除其二进制payload，不进入CAS。

Main HEAD仍328486；本审默认index raw SHA71ea4b092298223e7fc8187f3990e0b0a8ce3b0051e04c46ba35254b8a69b087、semantic8039ff42a2a03eaf4ece5b8ba418004e6d3b2c698ccf7e204b175983588265f5前后相等。这是Root既有暂存状态，不宣称是旧base58223语义或Main clean。HEAD差异仅4份optimization-plan文档和新增CAS index/146gzip；source/product/dev-harness/public未变。本审未暂存、修改默认index、commit或push。

收据INTEGRITY.json记录每项双hash/读取来源、5组别名、54源码canonical关系、4个新private index元数据及Git命令/原warning。此工程复核不扩大已选证据的原始结论：旧RED/UNKNOWN/HOLD、预算债务、后续actual与qualification/source/build/legal/ready和完整范围继续按原收据保留；恢复源码不等于复制运行资源、恢复OS/工具安装或允许重用旧现场。

本轮0actual：无新E2E/native/browser/PS/CIM/actor/lease/fixture执行或旁数据读取，没有重做大型测试工程。仅归档核验和四个外置Git恢复验证。报告完成后今天收束。
