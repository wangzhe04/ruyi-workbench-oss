# 本地语义编码进程

此目录是独立子进程源码。`server.js` 只使用 Node 内建模块启动它，不加载这里的 npm 包。推理需要完整的 Windows x64 CPU 离线资产目录及独立 Node ≥20（开发与验证使用24）；本目录不包含模型、`node_modules` 或 Node 二进制。

## 准备与验证

联网准备只由维护者显式执行，不能由搜索或首次启动触发：

```powershell
node ruyi-workbench/semantic-runtime/install.cjs --source output/semantic-install-staging --out output/semantic-bundle
node ruyi-workbench/semantic-runtime/verify.cjs output/semantic-bundle
node ruyi-workbench/semantic-runtime/worker.cjs --root output/semantic-bundle
```

`--source` 必须为空目录或由脚本标记的安装暂存目录；`--out` 必须不存在。`--offline` 禁止模型下载并要求 npm 缓存和模型已存在。消费者转移准备完成的完整 bundle，无需 npm 或模型下载。维护者也可对现有 npm/模型安装运行 `bundle.cjs <source> <new-output> [modelId|--all]`。它复制 Windows CPU 需要的文件，排除其他平台 native 文件和 Node entry 不使用的 web runtime，不就地裁剪安装目录。

`package-lock.json` 锁 npm 包版本、下载来源及完整性；`runtime-assets.win32-x64.lock.json` 对裁剪后全部697个文件逐一锁大小和 SHA-256。运行时逐一核验并拒绝额外文件，防止新增嵌套 npm 包改变解析路径。`models.lock.json` 锁每个模型的固定 revision、下载来源、权重/分词器/config 哈希以及编码参数。修改 tokenizer、pooling、前缀、长度、阈值、依赖或 worker 实现都会改变指纹。维护者更新锁需要明确的 `--update-lock` / `--refresh-inventory`，正常准备不得刷新锁。

## NDJSON 合同

启动成功输出一条 `{type:'ready',ok:true,modelId,modelFingerprint,dimensions,retrievalThresholds,limits}`；失败仅输出稳定错误，不记录文本或异常栈。发送：

```json
{"op":"encode","requestId":"q-1","role":"query","texts":["如何找回上下文细节"],"deadlineMs":1893456000000}
```

`role` 只能为 `query` 或 `document`，`deadlineMs` 为可选的绝对 epoch 毫秒。成功响应含 `ok:true,vectors,modelFingerprint,dimensions,tokenCounts,encodedTokenCounts,truncated,metrics`，其中 token 数包含实际模型前缀及特殊 token；失败为 `{requestId,ok:false,error:{code}}`。`metrics` 只含进程内存数值。推荐块长是调度建议，消费者必须检查 `truncated`，缩小并重新编码截断片段，不能把未编码的尾部当作已索引。

单次最多16条、每条8192 UTF-16字符、总32768字符、单行256KiB；队列32条，原生推理并发1，尚未开始的 query 优先于 document。默认截止30秒，最长120秒。超时响应不会强行中断正在执行的 native 调用；宿主必须终止超时 worker 以回收资源。重复 requestId、过载、超长行及过期请求均稳定拒绝。EOF 后完成已入队任务并释放会话。

运行期同时设置 `allowRemoteModels=false` / `local_files_only=true`、关闭模型缓存，并禁用 fetch、http、https、net、tls 的出站入口。该防线用于禁止程序的网络路径，不替代操作系统防火墙。编码不写原文、查询或向量文件。第三方日志被丢弃；原生依赖 stderr 由宿主丢弃。

## 编码、来源与许可证

默认候选为 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`：真实 XLM-R tokenizer、attention-mask mean pooling、L2归一化、128 token，建议96字符块。BGE 中文对照为真实 tokenizer、中文 query 指令、CLS、512 token；E5 对照为 query:/passage: 前缀、mask mean、512 token。不得互换前缀、pooling 或阈值。

模型锁明确区分原作者和 ONNX 转换仓库：前三个量化候选来自 Xenova 转换，第四个 E5 诊断对照为 intfloat 仓库自己的 qint8 导出。后者文件名含 avx512_vnni，已在本次 Ryzen CPU 上成功运行，但不由此承诺其它 CPU 性能。模型卡声明 BGE/E5 为 MIT，MiniLM 为 Apache-2.0：

- https://huggingface.co/BAAI/bge-small-zh-v1.5
- https://huggingface.co/intfloat/multilingual-e5-small
- https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2

npm 包的许可证文件保留在 bundle，完整文件库存与 npm lock 可审查。公开分发前仍须完成模型许可证正文/NOTICE、Node运行时及Slim/Full最终包审核，不能将模型卡声明当作最终分发验收。

## S2b 文本专用构建与资源平衡

当前运行时保留原 MiniLM INT8 权重及完整分词器，不删除网络层、词表或语言。`text-only.cjs` 对固定 Transformers.js 3.8.1 Node entry 作唯一静态 import 适配：禁用本 worker 不提供的图像操作，去掉 Sharp/其原生库及纯类型文件。上游/适配后 SHA 与改动说明见 `licenses/NOTICE.md`，未知源码拒绝变换；已适配资产可以幂等重新打包。

编码仍使用原 tokenizer；ONNX 权重由原生 `onnxruntime-node` 从已验证文件直接加载，省去 AutoModel 额外的整文件 JavaScript ArrayBuffer。该改动不采用强制GC或更改图优化级别。原始40文档/40查询pilot及新60文档/310查询开发集分别验证新旧向量逐值一致；非默认诊断模型尚未由这项证据覆盖。

裁剪后依赖 **40,533,717字节**，加模型 **175,926,205字节**（不含脚本/许可/Node）；先前依赖64,305,395字节。新开发集同机worker峰值 **561,061,888字节**，先前约765MB；这不是整桌面程序总内存，也不是所有输入的硬上限。千片段与完整包的实测仍由147发布清单绑定最终收据。

新显式搜索策略为 `.34` 加通用结构化标识符一致性检查，来自独立开发train/calibration选择，见 `search-admission-policy.json`。只门控语义补位，保留词法/精确命中。它减少了开发误召回但尚未达到自动注入门槛；`automatic:null` 不变，`answerability:not-assessed` 表示相关材料仍须回读，不能把检索命中当作已经回答问题。

## 可重现评测与边界

后续分阶段资源诊断：独立Node加载库后RSS61.4MiB，加载现JS tokenizer后347.0MiB，加载原生ONNX Session后509.7MiB，峰值577.1MiB。阶段差值包含分配器与GC时序，不是独占内存归属或整个桌面增量。官方Rust/NAPI tokenizer另行试验：370条开发输入全部一致；64条边界中19条长截断EOS差异均在现有`truncated=true`拒绝门外，3条孤立surrogate另列未支持。其常态RSS仅比JS约低29MiB、冷峰更高，且新增原生许可/CRT材料，因此未正式接入。生产仍使用原JS tokenizer及已验证的原生ONNX文件加载优化，研究收据不改变默认资产。

```powershell
node dev-harness/semantic/download-candidates.cjs output/semantic-install-all
node dev-harness/semantic/evaluate.cjs output/semantic-bundle output/semantic-pilot.json
$env:RUYI_SEMANTIC_TEST_ROOT=(Resolve-Path output/semantic-bundle).Path
node --test dev-harness/unit/semantic-runtime.test.js
```

全候选评测需包含全候选资产；单模型 bundle 可设置 `RUYI_SEMANTIC_EVAL_MODEL`。评测第四个位置参数可明确传冻结 fixture。`RUYI_SEMANTIC_EVAL_BATCH=1`用于批次诊断，`RUYI_SEMANTIC_DISABLE_ARENA=1`仅用于内存诊断，不能按 holdout 反复调参。

2026-11-16 Windows/Ryzen 5 5500/Node24 实测：原始 npm 依赖391635408字节，CPU裁剪64305395字节；默认模型和分词器135392488字节，runtime+模型约199.7MB，ZIP103324273字节（未包含独立Node）。40文档/40查询开发pilot中，MiniLM跨语言Recall@5均.90、中文.80；独立48文档/48查询holdout中中文.9167、双向跨语1.0、总体MRR.8809。短查询p95约7ms，进程峰值RSS约740–780MB，不能外推长文本或千片段性能。

search阈值.22在开发pilot六条无答案上校准后冻结，但独立holdout20条无答案误召回10条。因此 `automatic:null`，禁止据此开启语义独有记忆注入或其它自动候选。只允许有来源核验的显式检索与既有候选的重排。holdout头部曾在结构检查时被阅读，此后未修改候选、标签、阈值；相关召回通过不代表全部发布门通过。原始收据位于忽略的 `output/`，最终发布门由主集成文档维护。
