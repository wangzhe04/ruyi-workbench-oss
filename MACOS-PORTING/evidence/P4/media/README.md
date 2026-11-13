# P4-03 麦克风与媒体兼容

2026-11-08，当前 macOS27.0.1 arm64 开发环境。P4-03本地实现、合成媒体与真实麦克风独立验收通过，最新证据见末节。基线 `d97db57b`，修改保存在未提交工作树。

## 实现

- 按 MediaRecorder 实际能力选择格式，保留 WebM/Opus 首选并支持 MP4/AAC、WebM 和 Ogg/Opus。
- 各段记录真实 MIME，上传优先转成 16kHz 单声道 16-bit WAV。解码失败时按真实容器设置 Content-Type 与文件名。
- 原生宿主仅向受信主 frame 的精确来源开放纯麦克风授权提示，拒绝其他来源、子 frame 和摄像头请求。
- Mac 拒绝提示包含系统设置恢复路径。部分初始化失败时回收 AudioContext、节点与流式服务端会话。
- 解码完成后重新检查取消意图。持续讲话也会按既有最大分段时长切段。

## 已验证

真实 WKWebView 使用合成音源，正常 composer 入口完成 MP4 录制、WAV 上传、MP4 回退、模拟拒绝和重试、取消及轨道释放。真实 ScriptProcessor 产生 PCM 并通过工作台后端送达环回流式假服务，完成 partial、finish 和取消。处理器与分析器失败注入确认上下文关闭和服务端 DELETE。延迟解码中取消后零新增上传，持续响度超过 30 秒也触发分段。[最终本地结果](media-final.txt)

完整单元 2491 通过、18 既有跳过。语法检查 1133 文件通过。最终独立复核与候选工程门另行归档。[单元](unit-final.txt) [语法](syntax.txt)

## 保留的失败

初版夹具未持续引用 MediaDevices 对象，WebKit 回收包装对象后丢失合成输入替换，后续请求停留在授权等待。原生验收器又把脚本异常当作尚未就绪并重新执行，造成多一发上传。夹具已保留强引用并校验替换身份，验收器现在一次性报告脚本及结果序列化异常，失败仍走正常服务回收。[初轮](first.txt) [首次异常保留](script-error-first.txt)

新增连续响度场景还暴露既有 VAD 的提前返回，使最大时长判断无法触达。修复后该场景及解码取消均通过。[流式首轮](stream-first.txt) [按停顿取消](pause-cancel.txt) [持续响度最终](media-final.txt)

## 当时待验事项（历史快照，最新状态见末节）

- 用户已允许通知权限测试与最长 3 秒物理麦克风录音。此部分尚待手动解锁后，通过真实系统授权、拒绝恢复和短录音验收。
- 物理录音须留在隔离目录，ASR 使用环回假端点。
- 最终候选独立复跑、既有语音浏览器回归和相关工程门。

P4-03 继续登记 `in_progress`。正式签名身份和最低系统验收按已有交接保留。

## P4-04 组合候选补验

最终组合候选独立媒体件 36 项通过，桥接 35 项通过。新增四个生命周期竞态覆盖转写中暂停、待流式初始化时取消、旧初始化迟到及旧 stop 事件迟到。ASR 后端完整 41 项通过。[最终媒体](combined-independent-final.txt) [后端协议](asr-backend.txt)

旧 Chrome 分段件首次停在空文档。加入公共夹具已有的 Mac mock-keychain/basic 参数后，首屏恢复，但原生采集仍停在 `starting`。分段与公共流式件分别在独立 JavaScript world 调用原生 getUserMedia，安全本机来源上均超过 3 秒未完成。保留具体挂起结果，采集阻塞原因尚待定位。[分段首轮](chrome-first.txt) [隔离参数修正后](chrome-keychain-fixed.txt) [流式](chrome-stream.txt) [原生 API 诊断](chrome-native-gum.json)

分段修正后 29 通过、30 失败，流式 12 通过、9 失败，两件在取得诊断后关闭隔离浏览器进入夹具收尾，后段尚未执行。预热件自然结束 44 通过、14 失败。三件均未记通过，断言保留。[预热](chrome-warmup.txt)

## 最新独立回归与物理结果

已安装CFT148完整执行既有语音98、流式39、预热58项，全部自然退出0，断言及原生采集接口保留。Chrome156的挂起及原失败继续归档。当前原生候选合成媒体36项独立通过。[浏览器回归](native-gum-stages/README.md) [当前候选](../current-candidate/README.md)

真实WebKit拒绝后恢复已完成，1.01秒WAV成功上传至本机假ASR并回填，未发送消息。但原生结束边界严格判定失败，改进候选改用LaunchServices及独立原生停止保护，当前等待系统授权提示处理。原音频只在隔离目录。[物理结果](physical/README.md)

## 当前物理验收完成

当前冻结开发App在LaunchServices真实权限归属下，647.5ms有效PCM、音轨1110ms结束、原生停止完成1417.118ms，无独立保护触发，最终none且无stop待完成。转写回填一次、发送0，App/Node均退出。独立复核重新解析音频并核对哈希与TCC记录。P4-03当前主机本地验收完成，真实拒绝恢复记录为WebKit来源层；旧严格失败及Chrome156挂起按原范围保留。[最新严格结果](physical/reporting-delay/README.md) [独立复核](physical/reporting-delay/review.json)
