# 89 · 音频发送修复与 CLI 隔离续验

> 2026-10-21。承接 [88 号原型](88-privacy-m1-prototypes.md)，基线提交 `6d1e6544`。用户调整顺序：先修音频策略切换漏检查，再验证 LPAC 与 CLI 网关；ASR 先评估，成本过高可撤下。应用版本与正式发布门仍按 [86 号路线](86-3.1-completion-and-privacy-roadmap.md)。

## 音频修复合同

`transcribeAudioViaProvider` 与非 DELETE 的 `audioStreamUpstream` 在最后一次异步等待之后、实际 `fetch` 提交之前，同步检查当前权威策略。旧 off 配置快照不能覆盖已经开启的保护。DELETE 只负责回收已有会话，不因开启保护而禁止清理。

审查进一步发现，旧 `readConfig` 可在异步凭据处理之后迟到返回，并重新发布旧 off 策略，覆盖较晚保存的新 basic。仅增加发送检查不足以修复这个竞态；配置读取的迟到完成不得回退已经提交的权威策略与恢复快照。配置恢复事务必须在持久提交后发布，不能被修复绕过。

回归以真实生成服务器函数、可控制的等待点和独立本机 HTTP 接收端验证：off 正常传递原字节，basic/enhanced/strict 已开启或等待期间开启时零音频外发；旧读取不能撤销新策略；PCM 与 DELETE 路径分别验收。初始化或读配置失败不得继续发送，privacy 错误不转换成普通上游网络错误。

生产修复已完成并独立复核：发送点同步检查、旧 off 快照不能覆盖当前 on；配置读取、缓存、lastGood 与读派生迁移回写采用代次门控，普通写入不被静默取消，凭据恢复的 defer/提交/回滚顺序保留。已提交请求的字节无法撤回，本修复验证的是发送提交之前的策略约束。

修复提交：`60ca5e13`。源码哈希、回归及首次失败汇总见[验证记录](evidence/audio-policy-send-fix.json)。

验证：新音频 E2E 22 项通过，使用真实生成服务器函数及本机 HTTP 接收端；新增配置发布单测 6 项通过，独立审查连同缓存/恢复等五份相关 unit 共 46 项通过。原有转写、预热 E2E 通过。既有 unit 全套 2494 项中 2468 通过、26 按原条件跳过、零失败；这次全套启动时尚未发现新增 publication 测试，新增六项与最终配置代码由后续定向复验覆盖。没有将跳过项计作通过。

扩大检查保留失败：最终代码下的 fast 入口先跑 unit，2500 项中 2473 通过、26 跳过、既有 `kill-own-tree.test.js` R1b 一次失败，因此原入口没有运行静态阶段。该 unit 随后单独五项通过，原因未确定，不改写为整轮通过。独立复用同一 runner 的静态阶段得到 77/80 通过，另三项是归档/新增原型后的计数锁及新配置 helper 的生成合同未更新；确认具体来源后补齐元数据，三个定向检查通过。原始日志保存在仓库外维护目录，汇总绑定其哈希；未改 runner 或放宽断言，也未为取得绿灯重复全套。

清册按六份已审源码及生成 manifest 更新指纹，保持 267 份源码/配置、653 条候选；音频合同记录修复后的真实行为，仍不声称已有本地 ASR 或完整接收方保护。

## LPAC 与网关裁决

前一轮普通 AppContainer 实测可读取投影外带 `ALL APPLICATION PACKAGES` 权限的文件，且真实 CLI 无法访问宿主网关。续验需同时回答文件范围和模型传输两个问题。

LPAC 先不添加网络 capability，通过额外进程创建属性退出普通应用包的通用资源授权。重复普通 AppContainer 的文件负控、后代继承和独立接收端测试；不修改系统或用户目录 ACL，不添加 loopback 豁免。运行时缺资源时只记录失败，或逐项评估必要的只读程序资源，不授予整个用户目录。机制依据：[Microsoft LPAC 启动说明](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)。

网关需提供固定接收方、有界载荷、明确 purpose 和实际发送保护；任意 URL 代理不能作为通过。区分固定 IPC fixture、原始 HTTP 传输、实际官方 CLI 模型请求和完整工具闭环。Node 运行器的公开预加载机制、同进程 loopback 与本地命名管道可以作为候选实验，但需要实测，不能因为模拟脚本可用就认定 Claude/Kimi 已支持。参考 [Microsoft IPC 限制](https://learn.microsoft.com/windows/uwp/communication/interprocess-communication)。

续验结果见[CLI 运行说明](../../dev-harness/privacy-m1/cli/README.md)和[LPAC 证据](evidence/privacy-m1-cli-lpac.json)。本机 Windows build 26200、Node 24 的分闸观察：

| 环境 | 程序与文件结果 | 网络/网关结果 |
|---|---|---|
| 普通 AppContainer，零 capability | 父子可运行；AAP 投影外文件可读 | 六个独立接收端未收到隔离请求，同进程 HTTP 可用 |
| LPAC，零 capability | 启动属性设置成功，但 Node 在 JS 执行前 WSAStartup 10107 退出 | 未执行到探针，不计作出口封锁通过 |
| LPAC + registryRead | Node 与后代可运行，实际 token 的 package SID/唯一 capability SID 匹配；父子 AAP 投影外文件均拒绝 | 六个独立接收端有成功正控制、隔离请求零到达；同进程 HTTP 在 listen 阶段 EACCES |
| LPAC + registryRead + 专用 LOCAL pipe | 命名空间按目标 profile SID 绑定；原始值在宿主先投影，CLI stdin 为 NUL | 原创 Node 公开预加载 fetch 适配器，经受限 pipe 和宿主 PrivacyCore 到独立本机假模型服务；实际未修改的 Kimi 0.42.0 请求及助手完成已观察到 |

registryRead 是额外资源授权，不能沿用“零 capability”的结论；不含互联网或局域网网络 capability。未约束或测试完整注册表视图，文件负控通过也不意味着独占全部系统资源。`GetTokenInformation` class 46 在普通 AC/LPAC 均返回 87，证据保留 null/unknown；不能伪称直接查询到 LPAC flag。限定结论来自成功设置 opt-out、真实 package/capability token 和父子行为对照。

首轮 pipe 创建时合并 SACL 引发缺特权错误，之后仅创建自有 DACL 再对自有 handle 降低完整性；没有提权。第一版 LOCAL 名称在子进程命名空间中 ENOENT，按实际 profile 的 AppContainerNamedObjects 命名空间修正后才连通。这些首次失败保留，不将接收端零请求冒充成功保护。

网关只接受固定虚拟 origin、recipient/purpose 和明确模型路径，不解析该虚拟主机的 DNS；实际外发由宿主固定上游处理。正文及响应有界，拒绝任意 URL、重定向与未知代号。适配器是传输桥，不承担 OS 安全边界。Kimi 的有限请求验证使用宿主独有的随机响应挑战，挑战不在 prompt、环境、argv 或投影源码中，并检查真实助手完成事件；仅回显用户输入不能通过。

审查发现并修复 CLI stderr 可伪造宿主控制消息的问题：受管模式将 CLI stderr 合并到只作哈希/计数的 CLI 输出通道，不向 CLI 继承宿主控制 stderr；宿主事件仅保存白名单字段。伪造 broker/cleanup/error 行不能触发请求或污染控制证据。管道 ACL 授权目标 profile 与宿主用户、拒绝 NETWORK；错误 profile 访问若未单独实测，不能声称已通过全调用者隔离矩阵。

此轮是固定模型 schema 的可行性桥，尚未验证任意 JSON 的长整数、重复键或原始转义保真，也没有集成生产 Gateway、真实外部模型、完整工具/编辑/压缩/恢复流程。实际 Claude 原生程序没有接入这条 Node 预加载路径；此前普通 AC 的超时保留，新 LPAC 模型闭环尚未取得。M1 仍未完成，不能开放全部托管 CLI 支持。

实现冻结后，独立审查复验三份定向 unit 共 15 项通过，并将第二次真实 OS 实验写到自有 TEMP，不覆盖入库结果：两次均观察到真实 Kimi 0.42.0 退出 0、一次模型请求、接收正文哈希与 broker 提交哈希一致、原合成秘密未到达、助手最终内容严格匹配宿主随机挑战、六个未授权接收端均零连接；固定 IPC fixture 的伪造控制负例通过。取消负例覆盖 body 最后一次读取结束时 abort 和已 abort 的 pipe 提交，均零交换/写入。五次启动的 Job、profile 与临时目录清理均 verified。

13 份 CLI 原型文件的 manifest SHA-256 为 `cd67ddfb3224e68f1a1850d6960d4aab07eef8f9084e2f087b5a0d0c9de2b25c`，与入库证据及独立复验一致；四项直接加载的第一方依赖哈希匹配，所有 CLI JS/MJS 语法检查通过。证据还绑定 Node、helper/编译器、原 Claude 11 份与 Kimi 1196 份程序文件；Kimi 原程序与临时副本完整树哈希相同。独立复验结果 SHA-256 为 `6659038699e7f57c57a3ec23ad8c227a3955f00fbdee7875b8f17dd75fe94494`，归档到仓库外维护目录 `checks/m1-lpac-review/`。审查没有新增阻断；结论仍限定为本机、冻结版本的模型传输原型，`completedM1` 保持 false。

## ASR 评估与缩小范围

此前媒体探针只检查 ACC、系统 Python、主仓已知模型目录及 PATH。相邻的既有 `ruyi-toolbox/asr-stream` 实际有 SenseVoice 及 sherpa-onnx 依赖，因此“ACC 缺包”不能解释为整机没有本地 ASR。

只读评估证实：本机候选 `model.int8.onnx` 为 239,233,841 字节，SHA-256 为 `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51`，与[维护者公布的模型哈希](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/blob/main/model.int8.onnx)相同。另有 tokens 文件；sherpa-onnx 1.13.8、NumPy 及内部 ONNX Runtime 库已存在，相关包约 69.7 MiB，不含约 228 MiB 的模型及 Python。实际 Windows 包体和资源峰值尚未重新验收。

既有 `SenseVoiceBackend` 直接读本地文件并使用 CPU，没有发现源码层下载或云回退；已有 HTTP 服务启动时还会先载入流式模型，不能直接当成独立 SenseVoice 服务。最小候选是只在专用 stdio 子进程中运行已冻结的整句 PCM/WAV 识别，再将文字交给现有 PrivacyCore。WAV 解码可使用标准库，无需为该范围引入 FFmpeg。[官方模型说明](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)支持中文等语言；本轮没有运行模型，也没有用历史合成语料读数代替当前真实效果验收。

代码许可与模型许可独立。[模型 LICENSE](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/blob/main/LICENSE)指向 FunASR 模型协议，本机候选目录未发现随附许可，不能直接按代码 Apache-2.0 许可分发权重。后续若继续，须冻结解释器、原生库、模型及许可证来源，验证禁网、取消、时长/内存预算、失败零外发及中文数字/姓名效果。

**裁决：不新增重型 ASR 框架，不把完整 ASR 作为 3.1 发布硬门。** 保留整句本地转写后发送保护文字作为可选组件候选，优先完成音频发送封锁和 CLI 隔离。只有组件许可、隔离与实际闭环都通过，才把这条有限路径列入已支持；否则保护开启时继续拒绝原音频外发，并提示改用可编辑文字，不能回退云端识别。图片、文档和视频画面处理仍按 86 的独立范围推进；本轮不顺带承诺原音轨改写或音色匿名化。
