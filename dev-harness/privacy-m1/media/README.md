# M1 本地媒体可执行原型

这是离线、合成夹具的可行性验证，未接入应用上传或模型出口，不是图片通用安全认证。

从仓库根目录运行，要求现有 Full ACC `build_offline/python_embed` 可用；不安装依赖、不下载模型：

```powershell
node --test dev-harness/privacy-m1/media/mapping.test.js
node dev-harness/privacy-m1/media/media.e2e.js
node dev-harness/privacy-m1/media/media.e2e.js --write-evidence
```

最后一条只写脱敏汇总 `docs/optimization-plan/evidence/privacy-m1-media.json`。其余文件写入唯一自有系统临时目录，正常或失败收尾均清理；不读取用户图片、录音或桌面。只有 `127.0.0.1` 本地模拟接收端接收测试派生件，不访问公网。

流程为 Pillow 生成五行合成文字、EXIF/XMP/tEXt 元数据 → 单次源字节快照 → 按 EXIF 方向归一 → 真实 Windows.Media.Ocr 取得词坐标 → VM 加载仓库真实 PrivacyRules/PrivacyCore → UTF-16 全区间映射所有相交词框 → 实际像素涂黑 → 全新 RGB PNG 编码 → 再次 OCR 与像素/元数据断言 → HTTP 接收端捕获实际上传字节。规则覆盖手机号、邮箱及跨三个 OCR word 的本地规则实体；不会只遮敏感值词首。

三组真实图片覆盖原尺寸、1.2 倍缩放、90 度像素旋转及 EXIF 方向恢复。校验源与派生件哈希、公开标题像素逐字节不变、公开标题/计数再次识别保留、敏感实体再次识别消失、所有命中框像素全黑、元数据移除。发送名称固定为 `derived.png`，请求体只含派生件。源快照、当前源文件和派生件在发送前再次核对，篡改则拒绝；禁止回退原图。

负例包括组件缺失、空识别、处理前与发送前取消、运行中子进程取消、处理超时、源快照/当前源/派生件变更、真实策略版本升级及预期处理器哈希过期。不修改共享源码；过期 manifest 用固定预期哈希验证拒绝。策略由独立 owner 提供权威 revision/hash，替换新策略对象及新 detector 时，旧 detector 在处理阶段和 HTTP 提交点均拒绝；不能只观察旧对象是否原地变化。HTTP 发送器收到 signal、绝对 deadline 和同步提交校验，在创建请求前及 `req.end` 前复核。上述提交前拒绝以独立接收端请求计数不变证明零外发。

已提交的 HTTP 请求无法撤回。另用两个真实接收端接收派生件后故意不回应，验证 250ms 上传期限和接收后取消会销毁本次请求、有界结束且不重试；这两项归入独立 `uploadOutcomes`，发送方状态为 `unknown`，接收端确实有派生字节，不能列为零外发或声称撤回。204 确认的普通发送记录 `sent`。超时/取消只清理本原型创建的子进程（公共 `killOwnTree`）或本次 HTTP 请求。证据保留生成时间、OS/Node 版本、验收源码哈希、处理器版本/哈希、Python 程序哈希、策略版本/哈希、真实规则源码哈希、源/派生/HTTP 捕获哈希，不保留绝对用户路径、原始 OCR 文本或媒体。生产规则源码变化的校验存在，但未通过修改 app 源码作故障注入，不能声称该独立负例已验收。

WinSDK 无识别置信度输出。此原型在空文字或无规则命中时保守阻止；“没有识别到敏感值”无法证明任意图片安全。任意角度、边缘截断、多语言、人脸、签名、二维码、动画、PDF/Office、视频逐帧遮盖均未验收。图片尺寸限制为 800 万像素，动画拒绝。现有 Full 的 WinSDK OCR 库被直接调用，未修改 ACC 工具或生产应用。

当前已验证运行库为 Python 3.12.10、Pillow 12.3.0（本地包 METADATA: MIT-CMU）、winsdk 1.0.0b10（本地 METADATA: MIT）；OCR 为 Windows OS 组件，适用 Windows 许可，原型不分发模型。许可证/版本来自本地安装元数据，不是网络推测。ASR 只作限定范围只读探测（ACC Full runtime、系统 Python、既有仓库模型位置、PATH），不是整机搜索；已检查的解释器没有 whisper/faster-whisper/vosk/sherpa-onnx/torch/transformers/onnxruntime，PATH 没有 ffmpeg/ffprobe。没有冻结可执行 ASR 适配器及模型/校验和/许可证，故音频始终返回 `missing-component`；生成的静音 WAV 不发送。完整本地转写及视频处理明确为未完成，不能把 fail-closed 测试记作 ASR 通过。
