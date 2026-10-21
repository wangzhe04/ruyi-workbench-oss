# 89 · 音频发送修复与 CLI 隔离续验

> 2026-10-21。承接 [88 号原型](88-privacy-m1-prototypes.md)，基线提交 `6d1e6544`。用户调整顺序：先修音频策略切换漏检查，再验证 LPAC 与 CLI 网关；ASR 先评估，成本过高可撤下。应用版本与正式发布门仍按 [86 号路线](86-3.1-completion-and-privacy-roadmap.md)。

## 音频修复合同

`transcribeAudioViaProvider` 与非 DELETE 的 `audioStreamUpstream` 在最后一次异步等待之后、实际 `fetch` 提交之前，同步检查当前权威策略。旧 off 配置快照不能覆盖已经开启的保护。DELETE 只负责回收已有会话，不因开启保护而禁止清理。

审查进一步发现，旧 `readConfig` 可在异步凭据处理之后迟到返回，并重新发布旧 off 策略，覆盖较晚保存的新 basic。仅增加发送检查不足以修复这个竞态；配置读取的迟到完成不得回退已经提交的权威策略与恢复快照。配置恢复事务必须在持久提交后发布，不能被修复绕过。

回归以真实生成服务器函数、可控制的等待点和独立本机 HTTP 接收端验证：off 正常传递原字节，basic/enhanced/strict 已开启或等待期间开启时零音频外发；旧读取不能撤销新策略；PCM 与 DELETE 路径分别验收。初始化或读配置失败不得继续发送，privacy 错误不转换成普通上游网络错误。

生产修复已完成并独立复核：发送点同步检查、旧 off 快照不能覆盖当前 on；配置读取、缓存、lastGood 与读派生迁移回写采用代次门控，普通写入不被静默取消，凭据恢复的 defer/提交/回滚顺序保留。已提交请求的字节无法撤回，本修复验证的是发送提交之前的策略约束。

验证：新音频 E2E 22 项通过，使用真实生成服务器函数及本机 HTTP 接收端；新增配置发布单测 6 项通过，独立审查连同缓存/恢复等五份相关 unit 共 46 项通过。原有转写、预热 E2E 通过。既有 unit 全套 2494 项中 2468 通过、26 按原条件跳过、零失败；这次全套启动时尚未发现新增 publication 测试，新增六项与最终配置代码由后续定向复验覆盖。没有将跳过项计作通过。

清册按六份已审源码及生成 manifest 更新指纹，保持 267 份源码/配置、653 条候选；音频合同记录修复后的真实行为，仍不声称已有本地 ASR 或完整接收方保护。

## LPAC 与网关裁决

前一轮普通 AppContainer 实测可读取投影外带 `ALL APPLICATION PACKAGES` 权限的文件，且真实 CLI 无法访问宿主网关。续验需同时回答文件范围和模型传输两个问题。

LPAC 先不添加网络 capability，通过额外进程创建属性退出普通应用包的通用资源授权。重复普通 AppContainer 的文件负控、后代继承和独立接收端测试；不修改系统或用户目录 ACL，不添加 loopback 豁免。运行时缺资源时只记录失败，或逐项评估必要的只读程序资源，不授予整个用户目录。机制依据：[Microsoft LPAC 启动说明](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)。

网关需提供固定接收方、有界载荷、明确 purpose 和实际发送保护；任意 URL 代理不能作为通过。区分固定 IPC fixture、原始 HTTP 传输、实际官方 CLI 模型请求和完整工具闭环。Node 运行器的公开预加载机制、同进程 loopback 与本地命名管道可以作为候选实验，但需要实测，不能因为模拟脚本可用就认定 Claude/Kimi 已支持。参考 [Microsoft IPC 限制](https://learn.microsoft.com/windows/uwp/communication/interprocess-communication)。

本节尚未取得新的 LPAC 结果，不能沿用普通 AppContainer 证据。

## ASR 评估与缩小范围

此前媒体探针只检查 ACC、系统 Python、主仓已知模型目录及 PATH。相邻的既有 `ruyi-toolbox/asr-stream` 实际有 SenseVoice 及 sherpa-onnx 依赖，因此“ACC 缺包”不能解释为整机没有本地 ASR。

只读评估证实：本机候选 `model.int8.onnx` 为 239,233,841 字节，SHA-256 为 `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51`，与[维护者公布的模型哈希](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/blob/main/model.int8.onnx)相同。另有 tokens 文件；sherpa-onnx 1.13.8、NumPy 及内部 ONNX Runtime 库已存在，相关包约 69.7 MiB，不含约 228 MiB 的模型及 Python。实际 Windows 包体和资源峰值尚未重新验收。

既有 `SenseVoiceBackend` 直接读本地文件并使用 CPU，没有发现源码层下载或云回退；已有 HTTP 服务启动时还会先载入流式模型，不能直接当成独立 SenseVoice 服务。最小候选是只在专用 stdio 子进程中运行已冻结的整句 PCM/WAV 识别，再将文字交给现有 PrivacyCore。WAV 解码可使用标准库，无需为该范围引入 FFmpeg。[官方模型说明](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)支持中文等语言；本轮没有运行模型，也没有用历史合成语料读数代替当前真实效果验收。

代码许可与模型许可独立。[模型 LICENSE](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/blob/main/LICENSE)指向 FunASR 模型协议，本机候选目录未发现随附许可，不能直接按代码 Apache-2.0 许可分发权重。后续若继续，须冻结解释器、原生库、模型及许可证来源，验证禁网、取消、时长/内存预算、失败零外发及中文数字/姓名效果。

**裁决：不新增重型 ASR 框架，不把完整 ASR 作为 3.1 发布硬门。** 保留整句本地转写后发送保护文字作为可选组件候选，优先完成音频发送封锁和 CLI 隔离。只有组件许可、隔离与实际闭环都通过，才把这条有限路径列入已支持；否则保护开启时继续拒绝原音频外发，并提示改用可编辑文字，不能回退云端识别。图片、文档和视频画面处理仍按 86 的独立范围推进；本轮不顺带承诺原音轨改写或音色匿名化。
