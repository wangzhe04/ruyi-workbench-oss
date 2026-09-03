# 26 · 第 114 波实施方案（语音识别 ASR：云端／本地双路径、三入口）

> **状态（2026-09-03）**：候选立项（用户 2026-09-03 要求纳入规划），编号 114 顺延自 25 号的 111–113。**功能线，不是 Pretender 3.0 发布前置**（23 号 §7 原话）；执行位置待用户拍板（本文 §6 给建议）。前置只要求 103a 路由 descriptor 已出门（已交付）。
> **依据**：[23 号 §7 独立候选：音频转文字与本地 ASR](23-architecture-repayment-sequence.md)（候选边界原文照录于 §0）；主树只读摸底（2026-09-03，HEAD `0c4831e`）。
> **性质**：新增用户可见功能，含新路由、新配置字段、新原生工具与可选本地子进程；沿用 24 号 §0 统一纪律，行为切片独立开关、默认「未配置即不可见」，纯离线无 ASR 时零变化。

---

## 0. 冻结边界（23 号 §7 原文）

- 复用现有 providers 注册表，以模型 `caps: ['asr']` 标能力；`asrProviderId`／`asrModel` 独立选择，主模型与 ASR 选择器不共享状态。可选 `audioBaseUrl`，本地 provider 可选 `localCommand`；没有该字段只探活、绝不拉起。
- 如意侧新增 token 级 `POST /api/audio/transcribe`，入站 raw body、出站 OpenAI-compatible `/v1/audio/transcriptions`；附件、原生工具、composer 三入口读同一选择事实源。
- 本地 Windows 候选为 Qwen3-ASR-0.6B + OpenAI-compatible shim：只绑 `127.0.0.1`，环境变量传端口／模型目录，按需拉起、随主进程回收、模型懒加载与空闲卸载；模型与 Python 依赖不打入离线包。
- 转写文本标注不可信来源；调用计入 `kind:'aux', note:'asr'`，本地缺 usage 时标 `estimated:true`；不做实时流式、说话人分离或内置 2GB 权重分发。
- 立项时必须另写功能 Release Brief、协议威胁模型、云端／离线双路径实机验收与 UI／a11y 范围。

## 1. 摸底结论（2026-09-03）

| 项 | 现状 | 对设计的影响 |
|---|---|---|
| 音频／ASR 代码 | 全仓 NOT FOUND（`transcri*`／`wav`／`webm` 命中均为无关同名） | 全部新建 |
| provider 形状 | `models[]` 无 `caps`（`05-claude-engine.js:1109-1114`）；配置迁移为 `01-config.js:391` 内联 `incomingConfigSchema < N` 分支；`CONFIG_SCHEMA=11`（`00-boot.js:32`） | 114a 引入 `models[].caps` 与 `CONFIG_SCHEMA` 12；与 25 号 113c `caps:['embedding']` 共用字段形状，先落者建字段 |
| 附件管线 | JSON＋base64 上传（`13-http-router.js:1136`），`makeAttachmentRecord`（`04-permission-runtime.js:1-27`）无音频类；服务端因零 npm 红线不做 pdf/docx 抽文（`03-bridge-guard.js:937-938`） | 音频转写必须走 provider／shim，不在进程内解码 |
| 输入框入口 | 主 composer `#promptInput` 与交办台 `#previewDispatchInput` 两套，各自维护附件托盘；`insertTemplate()`（`provider-settings.js:1043`）是「回填输入框」现成模式 | ASR 选择挂 config，不挂任一 composer 状态；回填复用 insertTemplate 模式 |
| HTTP 客户端 | `singleSummaryCall`（`10-context-governance.js:1342-1457`）＝内置 `fetch`＋`AbortController` 范式；**multipart／FormData 构建器 NOT FOUND** | 用 Node 内置 `FormData`／`Blob`（node24 目标）零依赖实现 multipart |
| 记账 | `appendUsageLedger(kind:'aux', note)` 成熟；`estimated:true` 先例 `05-claude-engine.js:950` | 直接套用 `note:'asr'` |
| 本地子进程 | 只有 stdio JSON-RPC MCP 子进程先例（spawn `04-permission-runtime.js:500-517`、惰性重连 `:1310-1317`、收尾 `:107-116`）；无 HTTP＋127.0.0.1＋端口先例；空闲卸载 NOT FOUND | 114d 新写「本地 HTTP 助手进程」管理器，复用 spawn／reap 纪律 |
| 不可信围栏 | 提示词侧尖括号中和成熟（`06-provider-engine.js:1526-1548`）；**`buildAttachmentPrompt`（`03-bridge-guard.js:966-982`）未做同款中和** | 114c 顺带补齐附件文本中和 |
| 麦克风权限 | 前端从未 `getUserMedia`；WebView2 壳声明了 `PermissionRequested`（`RuyiDesktop.cs:210-211`）但无处理器 | 114e 在桌面壳挂处理器，仅放行本机源的 Microphone |
| 测试面 | 无 `config-migration*`／`attachments*` 专用 e2e；`route-inventory.static` 为新路由必过门；`usage-ledger.e2e.js` 为记账断言落点；`vision-loop.e2e.js` 覆盖附件 | 新增 `asr-*.e2e.js`（fake ASR 服务），其余只加 |

## 2. 目标与非目标

- **目标**：用户在主对话或交办台按住／点击麦克风说话，或拖入音频文件，几秒内得到可编辑的文字；云端 OpenAI-compatible ASR 与本地 Qwen3-ASR shim 两条路径行为一致；未配置 ASR 时界面不出现相关控件、纯离线安装零变化。
- **非目标**：实时流式转写、说话人分离、TTS、内置模型权重分发、自动发送（转写只回填，不替用户点发送）。

## 3. 切片

| 切片 | 类型 | 内容 | 门 |
|---|---|---|---|
| **114a · 配置与能力字段** | 零行为（未配置时） | `CONFIG_SCHEMA` 11→12：`models[].caps?: string[]`（白名单 `asr`／`embedding`，去重，normalize 回填空数组不写盘）；顶层 `asrProviderId`／`asrModel`（默认空＝未配置）；provider 可选 `audioBaseUrl`、`localCommand`（仅本地 shim 用）；设置页新增「语音识别」选择器（provider＋模型，只列 `caps` 含 `asr` 的模型；未配置态说明）；`workbench_self_status` config 段增 `asr:{providerId, model, local}`；`GET /api/status` 增 `asr` 摘要 | 配置 normalize／迁移只加断言（并入既有 provider e2e）；`provider-reasoning-effort-ui.static` 同款静态锁；`route-inventory` 不变；`prompt-snapshot` 不变 |
| **114b · 转写端点与客户端** | 后端 | `POST /api/audio/transcribe`（`ROUTE_AUTH` `token`；入站 `Content-Type: audio/*` raw body，query `filename`／`language`／`prompt?`；ASR 专用上限 25 MB，早于 128 MB 总闸）→ 出站 multipart（Node 内置 `FormData`＋`Blob`）到 `audioBaseUrl || baseUrl` 的 `/v1/audio/transcriptions`（`model=asrModel`、`response_format=json`），`AbortController` 120s；返回 `{ ok, text, language?, durationMs, providerId, model, estimated }`；错误走统一信封；记账 `kind:'aux', note:'asr'`，无 usage 时 `estimated:true`；`audioBaseUrl` 必须通过与 provider `baseUrl` 相同的 URL 校验（127.0.0.1 仅对 `localCommand` provider 放行） | `dev-harness/fake-openai.js` 增 `/v1/audio/transcriptions` 桩（回显收到的 model／filename／字节数＋固定文本）；新增 `asr-transcribe.e2e.js`（鉴权 401／未配置 409／超限 413／成功／上游 5xx 信封／记账条目）；`route-inventory.js` 重算（判定点 +1）；`usage-ledger.e2e.js` 只加 |
| **114c · 三入口接入** | UI＋后端＋工具 | ① composer 麦克风（主与交办台）：`MediaRecorder`（`audio/webm;codecs=opus`，不支持时回退 `audio/wav` 经 `AudioContext`）→ 114b → 光标处回填（不自动发送）；录音态（时长、停止、取消、Esc）、键盘可达、`aria-live` 状态、双主题、390px；未配置即不渲染按钮。② 音频附件：`makeAttachmentRecord` 增 `kind:'audio'`（扩展名白名单 wav/mp3/m4a/webm/ogg/flac），上传后服务端转写并作为附件文本进提示词，`buildAttachmentPrompt` 补尖括号中和并以 `<attachment kind="audio-transcript" untrusted>` 围栏标注，原文件保留可下载。③ 原生工具 `audio_transcribe({path, language?})`：读本地音频（`guardFileToolPath`）→ 114b 内部调用；tier `exec`（用户文件出网），pack `files_read`；走第 49 波入库全部门（`tool-dispatch` 63→64、facts、README、`workbench-self-status` counts） | `ui-*` 静态锁只加；新增 `asr-composer.static.e2e.js`（按钮门控、未配置不渲染、无 CDN、i18n 键四文件）；`vision-loop.e2e.js` 只加音频附件用例；`tool-dispatch.e2e.js` 重钉 64；`capabilities.e2e.js` 身份守卫；i18n.static；真实浏览器走查截图（录音态×双主题×390px） |
| **114d · 本地 shim（可选、不打包）** | 后端＋外部脚本 | `ruyi-workbench/tools/asr-shim/`：Python 标准库 `http.server` 实现 `/health` 与 OpenAI-compatible `/v1/audio/transcriptions`，只绑 `127.0.0.1`，端口／模型目录经 `RUYI_ASR_PORT`／`RUYI_ASR_MODEL_DIR`；Qwen3-ASR-0.6B 依赖（`transformers`／`torch`／`soundfile`）写在 shim 自己的 `requirements.txt`，**不进 `requirements_offline.txt`、不进离线包**；工作台侧「本地 HTTP 助手进程」管理器：仅当 provider 有 `localCommand` 才拉起（`spawn` 隐藏窗口、`RUYI_HOME` 注入、健康轮询 ≤ 20s）、随主进程回收（复用 MCP 子进程收尾纪律）、空闲 10 分钟卸载、审计事件 `asr_shim start/stop/fail`；`doctor` 增检查项 | 新增 `asr-local-shim.e2e.js`（用 Node 写的假 shim 脚本充当 `localCommand`：拉起→健康→转写→空闲回收→主进程退出回收）；`durable-state-inventory` 若新增 pid／状态文件须登记；`repo-hygiene` |
| **114e · 桌面壳麦克风权限** | 桌面壳（C#） | `RuyiDesktop.cs` 挂 `CoreWebView2.PermissionRequested`：仅当 `PermissionKind == Microphone` 且请求源为本机工作台地址时 `Allow`，其余保持默认；记录到桌面壳日志 | 无法 e2e：新增静态锁（grep `.cs` 含处理器与源校验）＋人工走查记录（浏览器模式与桌面壳各一次） |

顺序：114a → 114b → 114c（①→②→③）→ 114d → 114e。114d／114e 独立可后置；114a–114c 是最小可用闭环（云端 ASR）。

## 4. 威胁模型（协议）
- **出网面**：只有 114b 一处出站调用，目标 URL 来自配置（与 provider `baseUrl` 同源校验：协议白名单、禁私网除本地 shim、禁凭据内嵌）；不接受请求体里的 URL。
- **入站面**：token 鉴权；raw body 上限 25 MB；`Content-Type` 白名单；不落盘（内存转发），附件路径除外（已有附件存储纪律）。
- **本地 shim**：只绑 127.0.0.1、随机端口、无鉴权但仅本机可达；`localCommand` 只能来自配置文件（不接受 API 写入），启动前记审计；缺 `localCommand` 绝不拉起。
- **不可信文本**：转写结果进提示词一律围栏＋中和；原生工具返回值标 `untrusted:true`。
- **隐私**：录音数据不持久化（composer 路径）；附件路径按现有附件权属；使用台账不存音频内容，只存字节数与耗时。
- **拒绝服务**：单会话并发转写 ≤ 1，队列超过 3 拒绝；上游超时 120s。

## 5. Release Brief 骨架（出门时填）
1. 服务范围：云端 OpenAI-compatible ASR（必交）；本地 Qwen3-ASR shim（可选）；桌面壳权限（可选）。
2. 验证集与结果：fake ASR e2e 全绿；真实端点各一次（云端 provider 与本地 shim）中文／英文各 3 段实机转写，记录字错率粗估、耗时、费用；未配置路径逐字节零变化（提示词快照、路由清册、UI 截图）。
3. 默认启用范围与回退：功能默认「未配置＝不可见」；回退＝清空 `asrProviderId`；彻底回退＝删路由／工具／字段（迁移向下兼容：schema 12 → 11 忽略未知字段）。
4. 发布门与未完成项：Escapade 六类门；离线包不含模型；文档（用户手册「语音输入」节、shim 安装说明）。

## 6. 依赖与排期建议
- 前置：103a（已出门）；`models[].caps` 字段与 25 号 113c 共用，先落者建字段、后者复用。
- 与 110 的关系：114b／114c 触碰 `13-http-router.js`／`12-tool-dispatch.js`／`04-permission-runtime.js`，建议排在 110 对这些文件的拆分之后（或至少在 110-1 `13f` 拆分之后），避免搬家与新增交叉。
- **建议执行序**：110 → 114a–114c（最小闭环）→ 111 → 112 → 113 → 114d／114e → 107 批准点；若用户更急需语音输入，可把 114a–114c 提到 110 之后立即做。待拍板。
