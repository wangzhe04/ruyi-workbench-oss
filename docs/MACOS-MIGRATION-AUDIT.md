# macOS 迁移前评估

日期：2026-10-30（Asia/Shanghai）  
源码基线：`f5223548`，工作台 3.0.1，ACC 1.9.1。  
范围：文件与功能梳理、平台依赖评估、小范围 Mac 实测；未实施产品代码改造。

## 1. 结论

**可以改造成 Mac 版。建议保留 Node.js 后端、Web 界面与 Agent 业务逻辑，新增 macOS 平台适配层，重做桌面壳及系统自动化后端。**

这不是“把 EXE 换成 APP”即可完成的工作。模型调用、会话、管家、多 Agent、工作流、记忆等主要业务具备复用基础；Windows 进程、PowerShell、Explorer、DPAPI、Win32/UIA/WinRT 形成明确的适配边界。

建议先做 **Mac 基础版（浏览器入口 + Agent、文件、脚本、文档、浏览器自动化）**，再做 **Mac 桌面版（独立窗口、菜单栏、通知、密钥串、桌面控制）**。不能把“源码服务能启动”当成“完整功能已经兼容”。本报告不按文件数推算复用率或工期：小文件中的系统依赖也可能影响整个调用链。

“不可直接兼容”主要指现有实现与二进制，通常仍有 Mac 替代方案。真正不能原样搬过去的是 Windows 专用程序、注册表/COM/UIA 语义、Windows DPAPI 密文和 Windows 二进制运行包。

## 2. 文件范围与工程结构

通过 `git ls-files` 枚举基线全部 **1,599 个跟踪文件**，包含隐藏目录；全路径、字节数、职责分类、平台关键词命中行及处理建议见 [MACOS-FILE-INVENTORY.json](MACOS-FILE-INVENTORY.json)。不含 `.git` 对象、外部可选组件、未发布离线运行时和本次新增评估文件。

遍历与全文关键词扫描覆盖全部可解码的跟踪文本文件；深读范围集中在启动、命令派发、路径护栏、进程回收、加密、桌面桥、ACC 注册/工具、打包及测试入口。图片、DLL、EXE 等仅盘点类型与用途，未反编译；普通文档和测试按目录/主题归类，并非每份都做逐行功能验收。索引中的“未命中”不等于已经验证跨平台。

| 位置 | 文件数 | 职责及处理方向 |
|---|---:|---|
| `ruyi-workbench/` | 306 | 产品主体，拆分详见下表 |
| `mcp/` | 88 | ACC 及 MCP 接入说明；独立适配 Python 工具层 |
| `dev-harness/` | 993 | 测试、假模型、浏览器夹具、基准、录音样本；需要 Mac 基线 |
| `docs/` | 191 | 架构、历史提案、规范、截图、设计稿；方案文档不能当作已实现功能 |
| `.github/` | 5 | CI 与协作模板；当前没有 macOS CI job |
| `.claude/` | 2 | 开发环境钩子与配置，需要检查平台命令 |
| 根目录文件 | 14 | README、许可、安全/贡献指南、变更记录、facts 等 |

| 产品子目录 | 文件数 | 内容 |
|---|---:|---|
| `app/src/` | 91 | 87 个有序 JS 源模块 + 4 个 JSON 元数据/规则文件 |
| `app/public/` | 113 | 76 个 `js/*.js` 模块、入口、CSS、语言包及静态资源 |
| `app/` 直属 | 2 | `build.js` 拼接器、`server.js` 生成物；后者不能手改 |
| `app/vendor-bin/` | 1 | 仅随附 `rg.exe`，Mac 需自己的 ripgrep 或系统 `rg` |
| `desktop/` | 7 | C# WinForms + WebView2、DLL、manifest、图标和 PS 构建脚本 |
| `resources/` | 61 | 16 个 Playbook、39 个插件文件、2 个 PS 安装/启动脚本、4 个直属辅助文件 |
| `config/` | 3 | 出厂配置、Claude 与 MCP 示例 |
| `tools/` | 9 | 打包、开发启动、overlay 升级、manifest、外部机器人网关、假 CLI |
| `docs/` | 14 | 产品使用/管理/部署/架构手册 |
| 产品目录直属 | 5 | package 清单/锁、启动 CMD、说明文件 |

源码量：后端 JS 约 **90,238 行**；ACC 的 50 个 Python 源文件约 **15,589 行**。前端代码与随附静态库混在一起，不用其总行数估算开发量。README 仍有“77 个后端模块、70 个前端模块”的旧描述，本报告以当前文件/manifest 为准。

结构关系：

```text
浏览器界面 / Windows 桌面壳（未来新增 Mac 桌面壳）
  └─ HTTP + SSE → Node server.js（由 app/src 按 manifest 拼接）
      ├─ 原生 Provider：Chat Completions / Responses / Anthropic Messages
      ├─ Agent CLI：Claude Code / Kimi Code ACP
      ├─ 会话、权限、管家、记忆、多 Agent、工作流、调度器
      ├─ 120 个原生工具：文件、脚本、Git、网络、媒体、管家等
      └─ MCP stdio / HTTP → ACC / drop-in MCP / 外部工具
                            ├─ Python 文件、Office、浏览器工具
                            └─ Windows 桌面控制（需要 Mac 后端）
```

## 3. 功能兼容矩阵

等级：**A 主要逻辑可复用**；**B 保留主体、适配边界**；**C 现有实现不可直接运行、需要替代**。A 不表示所有关联依赖已经在 Mac 上实测。

| 功能 | 主要文件/模块 | 等级 | Mac 处理 |
|---|---|---|---|
| 聊天、流式输出、模型选择、模型故障切换 | `04h/04i`、`06-provider-engine`、`09-workflow` | A | Node HTTP/协议逻辑保留，实际端点另验 |
| Claude Code / Kimi Code CLI | `01-config`、`01f`、`05*` | B | CLI 协议保留；补 Homebrew、`.local/bin`、GUI 启动 PATH 与解释器探测；用户自备 CLI |
| 会话、历史、搜索、回退、文件检查点 | `02*`、`06h`、`11b` | B | JSON/NDJSON/压缩与事务逻辑保留；验路径、符号链接、大小写、权限、原子写入 |
| 多 Agent、角色、班组、资源租约、工作流图 | `06g`、`08`、`09*`、前端 workflows | B | 编排逻辑保留；必须先修进程树清理和平台工具能力 |
| 管家、收件箱、任务待决、交付、接续 | `06i`、`13g`～`13q`、`13aa` | B | 主体保留；改系统提示词、命令风险规则、通知桥与不可用工具提示 |
| 自治授权、五档权限、审批、审计 | `01e`、`03`、`04-permission-runtime`、`06f` | B | 权限模型保留；系统关键路径、命令识别、进程停止语义必须适配 |
| 上下文压缩、召回、token 与成本计量 | `06h`、`09d`、`10`、用量 UI | A | 算法/协议可复用，已有单测可复用 |
| 定时任务、cron、暂停/立即执行 | `06j`、`13s`、`13t` | B | 应用内调度可复用，不依赖 Windows 任务计划程序；退出、睡眠、唤醒与后台常驻另做验收 |
| 记忆、技能、Playbook、离线插件 | `06d`、`06b`、resources | B | 存储/装载保留；清理 Windows 指令与示例，按平台暴露模板 |
| 文本文件读写、编辑、搜索、压缩 | `11`、`11b`、`12` | B | Node 实现大体可用；补 Mac 系统目录保护，验 APFS/外置卷；随包 `rg.exe` 替换 |
| DOCX/XLSX/PPTX/ODF/PDF 内容提取 | `11c`、`resources/native-file-read.py` | B | 现有 `python3` 回退可用；PDF 等依赖与图片提取需安装/打包和验收 |
| Word/Excel/PPT/PDF 生成、表格样式、图表 | ACC `document`、`office_*` | B | 主体使用 python-docx/openpyxl/python-pptx/reportlab/matplotlib，可保留；拆除 ACC Windows 安装阻塞，校验字体与渲染 |
| 打开文档、交给编辑器、Finder 定位 | `03-bridge-guard`、`04-desktop-shell`、`13-http-router` | C | Explorer、注册表文件关联、WinForms 选择器改用 Mac 系统接口；保留危险类型不直接执行的护栏 |
| Git 查询、差异、提交、worktree | `02`、`08`、`11`、`12` | B | Git CLI 大体通用；Git 安装、路径、子进程及权限另验；基本 Git e2e 已通过 |
| 一次性脚本执行 | `12-tool-dispatch` | B | `node`/`python` 分支保留；默认 PowerShell 改为平台相关；可新增 bash/zsh，不能直接改名冒充 PowerShell |
| PowerShell 与常驻 shell 会话 | `04-desktop-shell`、`11-native-tools` | C | 当前固定 `powershell.exe`；设计 bash/zsh 会话、流式输出、中断和生命周期；pwsh 仅可选兼容项 |
| 原生截图、键盘注入、窗口/鼠标控制 | `12`、ACC screen/keyboard/mouse/window | C/B | WinForms SendKeys、Win32 窗口需替代；PyAutoGUI 部分逻辑可复用但要处理 Cmd、Retina 与系统授权 |
| UI 元素定位与调用 | ACC `uia.py`、`observe.py` | C | UIAutomation/comtypes 改为 macOS Accessibility AX；角色、属性、动作无法机械一一映射 |
| OCR 与“找文字点击” | ACC `ocr.py` | C | WinRT OCR 改为 Vision 或离线 OCR 引擎；语言、坐标、结果结构重新验证 |
| 浏览器自动化 | ACC `browser.py` | B | Playwright 核心保留，已存在 darwin 浏览器候选；需可启动的 Mac ACC/独立 MCP 与 Mac 浏览器运行时 |
| 浏览器打开链接 | 原生 `browser_open` → `buildOpenSpawn` | C | 这是 Explorer 打开 URL，不等于 Playwright；单独改为 `/usr/bin/open` |
| 联网搜索、抓取、HTTP、下载 | `11`、`12`、ACC web_fetch | A/B | HTTP 主体可复用，继续保留 SSRF、路径和审批边界；系统代理行为另验 |
| 语音输入、转写、词库学习 | 前端 composer-voice、`04j`、`06` | B | 词库与 ASR 协议保留；麦克风权限及 WebView 录音格式需验；当前固定 webm/opus，不能假定 WKWebView 支持 |
| 音视频探测、代码检查、截图验证 | `11d-media-inspection` | B | 已有 Mac Chrome 路径；ffmpeg/ffprobe/浏览器/Python 属外部依赖，未随仓库提供完整运行时 |
| 外部机器人与消息渠道 | `13v`～`13z`、`tools/external-bot-gateway.js` | B/C | 网络协议可复用；本地凭据保存明确拒绝非 Windows，环境变量路径与完整配置流程需分别验收 |
| 隐私识别、脱敏、凭据恢复 | `01h/i/m`、`03a`、`01j/k/l`、`13ab` | B/C | 检测与网关逻辑保留；DPAPI 存储换 Keychain，启用/API 平台门也要一起改 |
| MCP 接入、工具搜索/按需加载、toolbox | `04-permission-runtime`、`04f`、`07` | B | 协议可复用；MCP 启动命令、解释器、组件清单和退出清理需平台化；toolbox 组件源码不在此仓库 |
| 独立窗口、托盘、通知、窗口状态 | `desktop/RuyiDesktop.cs`、quiet-card/notify-policy | C | WinForms/WebView2/Win32 不能用于 Mac；重做 Mac 宿主及前端消息桥 |
| 迁移中心与旧包清理 | `13u-migration-center` | B/C | 配置扫描与引用修复可复用；回收站与 Windows 包识别规则需适配；Windows 绝对路径需用户映射 |
| 安装、离线 Full/Slim、overlay 升级 | CMD/PS1、`13c`、package scripts | C | 现有包与脚本不能作为 Mac 发行包；重做平台打包、升级、签名/公证流程 |
| 中英界面、主题、Markdown、Mermaid、工作流编辑器 | `app/public/` | A/B | 主要复用；补 Cmd 快捷键、Finder 文案、Mac 字体和 WebKit/Chromium 浏览器验收 |

## 4. 已确认的平台阻塞与对应方案

### P0：开放 Mac 执行能力之前必须处理

1. **任务停止不能可靠清理子进程树。** `04-permission-runtime.js:451` 的 `killPosixChildTree` 用 Linux `/proc`；注释和实现都明确 macOS 退化为只杀根进程。`killOwnProcessTree` 非 Windows 分支也只处理根 PID。影响 CLI、MCP、脚本、toolbox 与中断/超时；测试清理器 `dev-harness/lib/kill-own-tree.js` 也需要改。建议使用自有进程组/明确的子进程登记与身份校验，覆盖父进程先退出、孙进程、PID 复用和超时场景，不对陌生进程做无差别清理。
2. **系统路径保护仍按 Windows 配置。** `03-bridge-guard.js:744` 的 `OS_CRITICAL_ROOTS` 只列 Windows/Program Files 等；ACC `safety.py:81` 同样从 Windows 环境变量构建系统树。工作区普通边界已有 POSIX 逻辑，但不能以此证明全自动宽写模式安全。需要按 Mac 保护 `/System`、系统配置和应用自有敏感数据，明确 `/Library`、`/usr/local`、`/opt/homebrew` 等目录的业务权限；同时保留 realpath/符号链接检查。
3. **模型仍被要求输出 Windows 路径。** `06b-prompt-registry.js:130` 与 `:525` 的中英提示直接写绝对 Windows 路径。`12-tool-dispatch.js:3113` 甚至把 `bash` 别名映射至 `powershell_run`。必须按宿主 OS 和能力生成提示、schema、工具目录与别名，不能只改执行器。
4. **密钥存储只支持 DPAPI。** `01j-local-crypto.js:29` 拒绝非 Windows；`13y-external-bot-credentials.js` 保存凭据、`13w-external-bots.js` 部分创建流程、`13ab-privacy-api.js` 的支持/启用判据都有平台门。Mac 应新增 Keychain 保护器并调整调用链，维持密钥不经命令行参数暴露的边界。现有 Windows 用户绑定 DPAPI 密文无法直接在 Mac 解密，需要原 Windows 端解锁后通过受支持迁移方式导出，或在 Mac 重新输入密钥。

### P1：基础版体验和安装阻塞

5. **启动与系统打开仍是 Windows。** `13-http-router.js:2263` 的 `--open` 调 `cmd.exe`；`03-bridge-guard.js:1170` 的 `buildOpenSpawn` 返回 `explorer.exe`；编辑器/打开目录/定位文件路由直接拒绝非 win32。选择器在 `04-desktop-shell` 也有平台拒绝。Mac 用参数数组调用 `open`、`open -R`，选择器用原生宿主或有严格参数边界的系统桥。
6. **脚本默认与交互式 shell 为 PowerShell。** `11-native-tools.js:395` 固定启动 `powershell.exe`；`script_run` 默认语言也是 PowerShell。目前显式 `language:node/python` 有跨平台基础。建议新增统一 shell 抽象，保留 Windows 行为，按平台提供默认值；Windows PowerShell 5.1 脚本含 WinForms/注册表/COM 时，安装跨平台 PowerShell 7 也不能解决。
7. **ACC 安装依赖把整包绑到 Windows。** `pyproject.toml` 无条件依赖 `pywin32`；offline requirements 还有 winsdk、uiautomation、comtypes。`audio.py` 顶层导入 winsound、`desktop_extra.py` 顶层访问 ctypes.windll。注册器有模块加载失败隔离，但这不能绕过 pip 的硬依赖安装失败，也不能保证 108 个工具可用。需平台条件依赖、按能力注册与 Mac 实现。
8. **CLI/解释器发现不完整。** `01-config` 包内 Node/Python 布局主要是 `node.exe`、`Scripts/python.exe`。源码模式已有 `process.execPath`、裸 `claude/kimi` 和 `python3` 回退。Mac APP 从 Finder 启动时 PATH 不等于终端 PATH，需明确 arm64/x64 包布局、`/opt/homebrew/bin`、`/usr/local/bin` 与用户覆盖配置。
9. **模板会把模型引向错误工具。** 16 个 Playbook 中 `folder-inventory`、`clean-downloads`、`scheduled-digest` 直接写 PowerShell；`desktop-open-app` 明写 Windows 11 应用语义。插件 `windows-control`、`windows-operator` 需 Mac 对应内容，办公/打包/诊断指令亦要检查平台示例。
10. **浏览器、通知与录音是不同宿主契约。** `quiet-card`、`notify-policy` 认 `chrome.webview`；Mac 宿主不能直接沿用此桥。`composer-voice.js:59` 固定 `audio/webm;codecs=opus`；若选 WKWebView，必须测试具体最低系统版本并按能力协商格式，或使用已有 PCM 流式路径。

### P2：完整桌面版和发行

11. **桌面壳重写。** `RuyiDesktop.cs` 使用 System.Windows.Forms、WebView2 COM、user32/kernel32/dwmapi 和 NotifyIcon。可选 Swift/AppKit + WKWebView；若追求 Chromium 行为一致，可评估 Electron，但会增加体积与依赖；Tauri 同样需要处理 WebKit 媒体差异。首期浏览器入口最容易验证共用业务。保留 Node 后端零 npm 运行时依赖约束不妨碍单独选择宿主技术。
12. **桌面自动化按能力重建。** AX 替代 UIA；ScreenCaptureKit/Quartz 替代 Win32 截图；CGEvent/AX 替代 SendKeys/Win32 输入；Vision/离线 OCR 替代 WinRT。适配必须包含辅助功能、屏幕录制、自动化（如使用 Apple Events）、麦克风授权及拒绝/撤销后的错误提示。Retina 的逻辑点与截图像素、负坐标、多屏幕、中文输入、Cmd+V 都要单独验收。
13. **打包和更新另开 Mac 发行路径。** `package.json` 目标为 `node24-win-x64`；桌面构建使用 .NET Framework csc.exe；Full 安装依赖 Windows CPython 3.12 wheels、OCR 与 Chromium。Mac 至少区分 Apple Silicon/Intel，提供对应 Node/Python/rg/浏览器，重新校验 manifest/hash；面向外部分发时完成 APP 签名、公证、DMG/ZIP 与首次启动验证。旧 `Manage-Overlay.ps1` 和 `13c-overlay-routes` 的 PowerShell 更新链不能直接复用。

## 5. 不应承诺原样兼容的内容

| 现有内容 | 不能直接兼容的原因 | 可交付的替代范围 |
|---|---|---|
| Ruyi.exe、WebView2Loader.dll、rg.exe、Windows Python wheels | Windows ABI/PE 文件与平台扩展 | Mac 构建产物；不能改后缀使用 |
| Windows Registry、HWND、COM/UIA 对象与模式 | macOS 不提供同一系统接口 | AX、Launch Services、Apple Events 等重新设计；返回字段要版本化 |
| Windows PowerShell 5.1 + WinForms/WinRT 脚本 | 缺少系统组件与对应 .NET API | 等价工作流重写；纯算法 PowerShell 可选 pwsh 逐项验证 |
| 记事本、Windows 计算器、Windows 专用企业应用 | Mac 无对应应用或业务接口 | 若有 Mac 版应用则重新编写自动化；仅 Windows 软件需要远程 Windows 环境/虚拟机，非原生兼容 |
| Windows 用户绑定 DPAPI 密文 | 依赖原用户与 Windows 密钥保护环境 | 先在原机恢复/导出，或重新配置凭据；普通会话与非密钥配置可迁移但路径需映射 |
| PrintWindow、Windows DPI、UIA Pattern 的精确行为 | Mac 捕获和可访问性模型不同 | 达成功能近似，不承诺后台/最小化窗口捕获、元素动作完全一致 |

本仓库的 Office 生成主要基于文件库，**没有证据支持“整个 Office 模块都因 COM 而不可迁移”**。操作已打开 Word/Excel/WPS 窗口属于另一层桌面自动化；文件生成成功也不等于宏、公式重算、字体版式或应用内操作已兼容。

## 6. 推荐改造顺序与验收边界

| 阶段 | 改造范围 | 验收结果 |
|---|---|---|
| 0：平台基线 | 增加 Darwin 平台/能力层、Mac CI、测试夹具分流，修路径保护与进程清理 | 普通用户、中文/空格路径、子进程停止、数据隔离和安全边界有实测；Windows 原功能不回退 |
| 1：Mac 基础版 | 启动入口、默认浏览器、CLI/解释器发现、shell、文件/文档、Git、MCP、提示词/Playbook | 浏览器内能完成模型回合、文件改动与回退、脚本、管家、工作流、调度与文档交付；不可用能力被明确标注 |
| 2：Mac 桌面版 | 独立壳、菜单栏、原生选择器、通知、Keychain、语音、后台生命周期 | Finder 启动与终端启动结果一致；权限拒绝可恢复；休眠/唤醒、退出/重启行为明确 |
| 3：Mac 桌面自动化 | AX、截图、输入、窗口、OCR、应用控制与宏录制 | 以实际应用场景验收；不以“注册了同名工具”代替成功执行 |
| 4：离线发行 | arm64/x64 依赖闭包、Full/Slim、签名公证、升级/回退、迁移文档 | 干净机器断网安装成功；模型可以是本机/内网；不在首次运行临时下载依赖 |

优先实现一个集中接口层管理：`openExternal/revealPath/pickFile/pickFolder`、`spawnShell/killOwnedProcessTree`、CLI/Python/rg 定位、系统路径保护、密钥保护、系统通知和桌面能力探测。纯业务模块按 capability 调用，避免在 87 个模块里继续散落 win32/darwin 判断。

项目现有文档要求 Windows 为一等目标。此次用户提出 Mac 版本就是新增 Mac 支持的方向，不需要为开展评估另求许可；后续建议共用业务层、保留 Windows 适配，更新贡献规范与 CI。开发规范要求行为变更带测试，并只改 `app/src` 再生成 `server.js`。

## 7. 本次实测与局限

环境：Darwin arm64，Node.js **24.15.0**，系统 `python3` **3.14.7**；没有为本次评估安装 ACC、修改真实 CLI 配置或运行真实模型调用。测试使用仓库家目录隔离辅助件。Python 版本不等于项目离线发行基线 3.12，未据此宣称 ACC 依赖安装兼容。

| 检查 | 结果 | 证明范围 |
|---|---|---|
| `node ruyi-workbench/app/build.js --check` | 通过 | 生成物与 87 个源模块一致 |
| 10 个选定 unit 文件 | 82 tests：81 pass、0 fail、1 skip | Provider 协议、Anthropic 编解码、调度内核、权限、文件内核、凭据测试、实例所有权、CLI 适配、路径与命令行纯函数；skip 为实际 Windows cmd 执行 |
| `provider-custom-headers.e2e.js` | exit 0，ALL PASS | 配置读写/脱敏、自定义请求头与本地假模型交互 |
| `git.e2e.js` | exit 0，ALL PASS | 本件覆盖的真实服务、Git 查询/提交等行为 |
| `scheduler-api.e2e.js` | exit 0，ALL PASS | 本件覆盖的真实服务与定时任务 API，不覆盖 Mac 睡眠/常驻 |
| `mcp-bridge.e2e.js` | exit 0，ALL PASS | 真实工作台 + 假 MCP/Provider 的完整工具回合 |
| `file-guard.e2e.js` | exit 1，未完成 | 前段断言通过；在第 92 行尝试写 `C:\Windows/Temp/...` 时 ENOENT，中断于 Windows 夹具；不能据此认定文件护栏全通过 |

unit 文件：`provider-wire-protocols`、`provider-wire-anthropic`、`scheduler-core`、`credential-vault`、`permission-resolve`、`file-tools-core`、`server-ownership`、`win-cmdline-quote`、`agent-cli-adapters`、`workspace-trailing-sep`（均在 `dev-harness/unit/` 下，后缀 `.test.js`）。

日志见 [MACOS-BASELINE-TESTS.txt](MACOS-BASELINE-TESTS.txt)。没有跑全量 539 个 e2e、278 个 unit 文件、25 个 ACC smoke；没有做浏览器可视化验收、真 CLI 登录/恢复、真实桌面权限或 Intel Mac 验证。四个 e2e 通过只证明选定链路已经具有跨平台基础。文件护栏夹具失败已定位，不把其他未运行测试预先归为平台问题。

## 8. 全模块与工具索引

下面附录按当前源码自动列出全部后端模块、前端模块、ACC 工具模块，以及 120 个原生工具。分级为迁移初判，需结合上述依赖链；例如一个 Office 工具算法可复用，不意味着当前 ACC 包已经可以在 Mac 安装。

### 8.1 后端全部 87 个有序模块

路径前缀：`ruyi-workbench/app/src/`。职责原注取自 manifest；历史注释仅用于定位，行为结论以上文源码核对为准。

| 模块 | 职责/原注摘要 | 等级与处理 |
|---|---|---|
| `00-boot.js` | shebang/use strict/requires/paths/小工具 | B：数据根迁移、运行时布局、编码与系统路径 |
| `00b-ruyi-names.js` | 3.0 收口: 如意自有的对外标识 —— MCP server id ruyi(工具名 mcp__ruyi__*)、旧 id win-claude-workbench(只用于认出并清理存量登记、导入时保留)、i | A：主体复用；按依赖链验收 |
| `01b-route-auth.js` | 110-2a: 从 01-config.js 搬出 ROUTE_AUTH 路由鉴权表(纯搬家,零行为变更) | A：主体复用；按依赖链验收 |
| `01c-runtime-flags.js` | 110-2b: 从 01-config.js 搬出运行时开关判定函数(纯搬家,零行为变更) | A：主体复用；按依赖链验收 |
| `01d-win-cmdline.js` | 架构还债批 3·B: 从 01-config.js 搬出 Windows 命令行包装与整行长度预算(isBatchLauncher/quoteWinArg/batchSafeSpawn/CMD_*/cmdLin | B：Windows 分支保留；POSIX 不套 cmd 引号和长度限制 |
| `01e-permission-modes.js` | 架构还债批 3·B: 从 01-config.js 搬出权限档表/三层权限解析/内置 Agent 角色与归一(PERMISSION_MODES/AGENT_ROLE_PERMISSION_MODES/CLAUD | A：主体复用；按依赖链验收 |
| `01f-agent-cli-types.js` | 架构还债批 4: 从 01-config.js 搬出 Agent CLI 类型登记表 AGENT_CLI_TYPES(并把各 CLI 的装机候选/路径探测/起进程/MCP 清单同步收成登记项成员)与唯一的 CL | B：CLI 平台候选与启动参数 |
| `01g-server-ownership.js` | 62: OS-held per-data-directory serve ownership; standalone built-in IPC gate | B：已有非 Linux POSIX 路径；测试 Unix socket 和目录长度 |
| `01i-privacy-rules.js` | 81-P1: versioned offline rule catalog, no dependencies | A：主体复用；按依赖链验收 |
| `01h-privacy-core.js` | 81-P0: isolated privacy detector, scoped references and authenticated envelopes; not yet wired to product | A：主体复用；按依赖链验收 |
| `01m-privacy-regex.js` | 81-P3: disposable bounded regex worker, no application dependencies | A：主体复用；按依赖链验收 |
| `01j-local-crypto.js` | 81-P1: bounded shared Windows DPAPI helper, no app dependencies | C：DPAPI 保护器换 Keychain；同步所有平台启用门 |
| `01-config.js` | defaultConfig/normalizeConfig/readConfig/launcher 解析/ROUTE_AUTH | B：CLI/Python/Node 探测与默认配置、包布局 |
| `01k-credential-vault.js` | 81-P1: encrypted immutable credential records and config persistence/hydration hooks | B：记录模型复用，依赖新平台加密器 |
| `01l-credential-recovery.js` | 81-P1: transactional recovery with encrypted rollback journal | B：恢复事务复用，适配密钥迁移/错误语义 |
| `02c-turn-segments.js` | 110-3b: 从 02-session-store.js 搬出回合分段构建器 createTurnSegmentBuilder(纯搬家,零行为变更) | A：主体复用；按依赖链验收 |
| `02d-session-overrides.js` | 架构还债批 3·B: 从 02-session-store.js 搬出会话级内存覆盖表(sessionEngineRouteOverrides/sessionPermissionModeOverrides/se | A：主体复用；按依赖链验收 |
| `02e-session-engine-route.js` | 架构还债批 3·B: 从 02-session-store.js 搬出会话引擎路由的纯函数(normalizeSessionEngineRoute/sessionEngineRouteFromConfig/in | A：主体复用；按依赖链验收 |
| `02f-turn-effect-kinds.js` | 架构还债批 3·B: 从 02-session-store.js 搬出回合摘要的工具分类表(TURN_SUMMARY_FILE_TOOLS/TURN_SUMMARY_COMMAND_TOOLS/TURN_SUM | B：新平台工具同步不可逆操作分类 |
| `02-session-store.js` | 会话存储 v2(head+NDJSON 正文)/索引/load-save/checkpoint journal/日志 | B：路径/检查点/Git/链接/权限边界复测 |
| `03-bridge-guard.js` | 桥接写族覆盖审计/工作区护栏 | B：系统路径、文件关联、编辑器、浏览器与 Finder |
| `03a-privacy-gateway.js` | 81-P2: scoped bidirectional privacy gateway | B：隐私网关复用；持久化加密依赖新保护器 |
| `04-visual-pipeline.js` | 第104波：Provider 附件与桌面截图视觉历史管线（隔离命名空间） | A：主体复用；按依赖链验收 |
| `04-permission-runtime.js` | pendingPermissions/plan 批准/原生权限请求 | B：Mac 子进程树、MCP 生命周期、命令审批 |
| `04-desktop-shell.js` | 第104波：Windows 进程执行、原生选择器与 Explorer reveal（隔离命名空间） | C：保留通用 runProcess；重做 PowerShell、原生选择器、Explorer |
| `04f-toolbox-services.js` | ruyi-toolbox 服务类组件：拉起／探活／接成能力端点／回收（登记读取与 MCP 并入住 04） | B：组件启动路径、能力探测、进程回收 |
| `04h-provider-http.js` | 架构还债批 2·A:OpenAI 兼容服务商 HTTP 原语的唯一住处(端点 URL 归一化/请求头/非流式 POST/瞬时错误重试骨架;自 05/06/07/08/09/10 纯搬家,零出边故不进任何环) | A：主体复用；按依赖链验收 |
| `04i-provider-anthropic.js` | 58 号方案批 2: Anthropic Messages 线协议(apiStyle:anthropic)的编解码纯函数——端点/鉴权头(x-api-key/Bearer/auto)、chat 形历史→Mess | A：主体复用；按依赖链验收 |
| `04i-provider-wire.js` | 58 号方案批 1: 服务商线协议登记表 PROVIDER_WIRE_PROTOCOLS(chat/responses 的端点、请求头、请求体编码、推理强度、工具、流式/非流式解码、用量归一、落历史字段)与唯一 | A：主体复用；按依赖链验收 |
| `04j-hanzi-pinyin.js` | 59 号文 §6(语音词库第二步):汉字 → 普通话读音(不带声调)的离线小表 —— Unicode Unihan(kMandarin 主读音 + kXHC1983 其余现代读音,Unicode License | A：主体复用；按依赖链验收 |
| `04j-voice-lexicon.js` | 59 号文(语音词库第一步):个人词 + 原厂常用词表的纯函数内核 —— 词条形状与清洗、设置页文本读写、按这一句挑词、给句尾改错 <glossary> / 整段识别 prompt / 实时识别热词各出一份形状 | A：主体复用；按依赖链验收 |
| `04j-voice-learn.js` | 59 号文 §6(语音词库第二步):从用户手改里学词的纯函数内核 —— 机器写的几句在发出去的字里定位与对齐、抽改动、读音像不像(拼音/辅音骨架/字母)、人名单字改动拼窗口、打字里抽专名英文词、请改字大模型复核 | A：主体复用；按依赖链验收 |
| `05-claude-engine.js` | runClaudeTurn/stream-json 解析/spawn 环境/权限桥接线 | B：CLI 启动/环境/中断/路径与恢复 |
| `05b-kimi-bridge.js` | Kimi Code ACP 驱动：会话/流式/工具/权限/提问/排队 steer；Server API 原生压缩与 wire 状态补强 | B：ACP 主体复用，终端进程与 CLI 环境适配 |
| `05c-kimi-search-policy.js` | Kimi ACP 原生只读 Grep/Glob 安全分类器 | B：路径与命令分类规则逐平台验收 |
| `05d-kimi-prompt-parts.js` | Kimi ACP 本回合提示词/图片 ContentBlock 安全降级 | A：主体复用；按依赖链验收 |
| `06-provider-engine.js` | provider 引擎助手/能力探测/metrics/转录 GC/存储管家/playbooks | B：能力探测、ASR 外部依赖、系统环境提示 |
| `06b-prompt-registry.js` | 第51波51c-b(04 Phase B):提示词外置 i18n registry(PROMPT_PACK_VERSION + PROMPT_ZH 中文包,Phase1 中文版骨架) | B：清理强制绝对 Windows 路径与 PowerShell 文案 |
| `06c-agent-loop-hooks.js` | 第75d波 Escapade Harness 小迭代:Agent Loop 只读生命周期钩子、故障隔离与 trace spine | A：主体复用；按依赖链验收 |
| `06h-retrieval-index.js` | 113a:离线检索原语(特征哈希向量/TF-IDF/余弦/RRF),记忆召回与会话搜索共用 | A：主体复用；按依赖链验收 |
| `06i-steward-core.js` | 第116波116a:管家(Steward)引擎侧纯函数与延迟绑定命名空间 StewardHooks(不实现,契约声明) | B：Mac 命令风险规则、工具能力/措辞 |
| `06d-memory-domain.js` | 第104波：跨会话记忆、提议、关系图与检索 | A：主体复用；按依赖链验收 |
| `06e-mission-domain.js` | 第104波：Mission 提示摘要与 until-done 驱动 | A：主体复用；按依赖链验收 |
| `06f-autonomy-grants.js` | 第104波：自治授权签发、消费、撤销与预检 | B：自治模型复用，新增 Mac 命令/目录边界 |
| `06g-resource-leases.js` | 第104波：Agent 资源归一化、冲突检测与租约 | B：路径归一化、Mac 桌面租约资源语义 |
| `06j-scheduler-core.js` | 第123波 M1(37 号文 §3.1;设计权威 29 号文 §3):定时任务纯函数内核 —— normalizeSchedulerTask / nextFireAt / parseCronExpr / des | A：主体复用；按依赖链验收 |
| `06k-config-patch.js` | 架构还债批 2 B2: 从 13-http-router.js 搬出 applyConfigPatch(配置补丁落盘与副作用;纯搬家,零行为变更),经 01 的 ConfigPatchHooks 调用、零入边 | B：新平台能力开关和配置副作用 |
| `07-autonomy.js` | Provider 工具目录、权限 gate、failover 与 Agent 角色支撑 | B：按真实平台能力提供工具目录与提示 |
| `08-agent-runs.js` | run 事件日志/恢复分级/runSubAgentCore | B：多 Agent 主体复用，CLI/进程树和 worktree 验收 |
| `09b-replan-ledger.js` | 110-4a: 节点续点与重规划补丁账本(自 09-workflow.js 纯搬家) | A：主体复用；按依赖链验收 |
| `09d-token-estimation.js` | 110-4b: token 估算与分桶簇(自 09-workflow.js 纯搬家) | A：主体复用；按依赖链验收 |
| `09-workflow.js` | 调度器/launchPersistedAgentRun/runOpenAiTurn | B：工作流主体复用，平台执行能力与中断链 |
| `10-context-governance.js` | 上下文窗口三级/摘要内核/L1 蒸发/L2 重播种 | A：主体复用；按依赖链验收 |
| `11-native-tools.js` | shell 会话/git 族/web_search/归档族/桌面桥 | B：PowerShell 常驻会话重做，其余工具按依赖适配 |
| `11b-file-text-io.js` | 单文件工具的文本 I/O 内核:编码嗅探/GB18030 编码、有界流式读、原子写、file_edit 未命中诊断;零出边(冻结对象 FileTextIo),不进依赖环 | B：文本内核复用，Mac 原子写/权限/编码验收 |
| `11c-file-visual-io.js` | 11c-file-visual-io.js | B：Python 与文档/图片运行依赖 |
| `11d-media-inspection.js` | Local dependency discovery, bounded audio measurement and parse-only syntax validation; built-ins only | B：ffmpeg/ffprobe/Chrome/Python 探测和发行依赖 |
| `12-tool-dispatch.js` | invokeAdaptiveMcpTool/TOOL_DISPATCH 注册表/toolCall | B：默认 shell、截图/键盘、平台别名、路径护栏 |
| `13f-native-tool-schemas.js` | 110-1: 从 13-http-router.js 搬出 MCP_TOOLS 原生工具 schema 数组(纯搬家,零行为变更) | B：平台 shell/schema/工具能力描述 |
| `13-http-router.js` | handleApi 全路由(49f 起 MCP/checkpoint/steer 三组域路由抽出至 13b) | B：--open、Finder/编辑器路由、端口体检和宿主集成 |
| `13b-api-domain-routes.js` | 第49波49f(A1): handleApi 域分组拆分第一批 — MCP/checkpoint·storage/steer 三组域路由 | A：主体复用；按依赖链验收 |
| `13c-overlay-routes.js` | 第53波 EC-B(53b):overlay 离线更新 API 编排层(precheck/apply/rollback/status,编排 Manage-Overlay.ps1 受测核心) | C：PowerShell 解包/升级调用链换平台实现 |
| `13d-core-domain-routes.js` | 第65波 EC-D 收口:session CRUD、question/permission/plan 干预、Agent Run 查询/事件/控制三组后端域路由 | A：主体复用；按依赖链验收 |
| `13e-pretender-index.js` | 第75c波 Pretender Mission/Intervention 可重建物化索引、revision cursor、ETag 与规模门 | A：主体复用；按依赖链验收 |
| `13i-steward-inbox.js` | 第116波116b(116-2e 拆分):管家收件箱轮询器/三源增量归一化/游标(零行为搬家自 13g 前半) | A：主体复用；按依赖链验收 |
| `13j-steward-tool-base.js` | 第117波 T1(32 号文 §2.1 拆分):管家工具面共享底座 —— 共享常量/稳定信封/会话头读取/决策日志/记忆存储/读预算/派活原语(零行为搬家自 13g) | A：主体复用；按依赖链验收 |
| `13aa-steward-delivery.js` | Bounded per-turn delivery evidence, file freshness and revision source projection via StewardHooks | A：主体复用；按依赖链验收 |
| `13k-steward-threads.js` | 第117波 T1(32 号文 §2.1 拆分):管家线程族工具 thread_*/quick_ask/threads_search 与收件箱行增强(零行为搬家自 13g) | A：主体复用；按依赖链验收 |
| `13l-steward-ops.js` | 第117波 T1(32 号文 §2.1 拆分):管家观察/决策/记忆/设置/内容管理族工具(零行为搬家自 13g) | A：主体复用；按依赖链验收 |
| `13g-steward.js` | 第116波116c(117波 T1 拆分):/api/steward/* 域路由、记忆面板、工具门控壳与 StewardHooks 注册表(工具实现已前移至 13j/13k/13l) | A：主体复用；按依赖链验收 |
| `13m-steward-runner-base.js` | 第117波 T2(32 号文 §5 拆分):管家回合运行器共享底座 —— 落盘面与回合层常量/写工具白名单/运行时内存态/停机唤醒/管家会话单例(零行为搬家自 13h) | A：主体复用；按依赖链验收 |
| `13n-steward-arbiter.js` | 第117波 T2(32 号文 §5 拆分):116h 线程间仲裁 —— 并发位/同 cwd 写锁/预算/可解释排队/饥饿提升(零行为搬家自 13h) | A：主体复用；按依赖链验收 |
| `13o-steward-runner-prompt.js` | 第117波 T2(32 号文 §5 拆分):管家提示词装配(记忆块/线程摘要/递话预判/总览/两个分叉入口)与输出契约解析(零行为搬家自 13h) | A：主体复用；按依赖链验收 |
| `13p-steward-runner-actions.js` | 第117波 T2(32 号文 §5 拆分):actions 执行与降级/116-2b 自理动作/id 人话化/熔断/收件箱消息装配(零行为搬家自 13h) | A：主体复用；按依赖链验收 |
| `13q-steward-runner-turn.js` | 第117波 T2(32 号文 §5 拆分):回合入口 runStewardTurn/收件箱去抖驱动/到访与归档/117l D2 递话通道/acts 落定(零行为搬家自 13h) | A：主体复用；按依赖链验收 |
| `13h-steward-runner.js` | 第116波116f(117波 T2 拆分):管家回合运行器族的 StewardHooks 注册表、/api/steward/{visit,message,act,arbiter} 路由、运行器状态与 threa | A：主体复用；按依赖链验收 |
| `13r-event-stream.js` | 第121波 K2a(34 号文 §6.1):GET /api/events/stream 事件流 —— 进程内总线订阅、SSE 扇出、内存环断线补发、在场快照(零落盘;经 00-boot 的 EventStre | A：主体复用；按依赖链验收 |
| `13s-scheduler.js` | 第123波 M1(37 号文 §3.2/§3.3/§3.4;设计权威 29 号文 §4):定时任务调度器 —— tick 与四段触发、启动恢复(错过补一次/崩溃记 unknown)、上限与熔断、六条 /api/ | B：调度主体保留；Mac 常驻、睡眠/唤醒行为验收 |
| `13t-steward-schedule.js` | 第123波 M2(37 号文 §3.5;设计权威 29 号文 §5/§8/§10):定时任务的管家面 —— 六个 steward_schedule_* 工具(沿 13g 门控壳)、reminder 出箱的 Sc | B：调度主体保留；平台相关 Playbook 与执行能力 |
| `13u-migration-center.js` | W2 迁移中心(56 号文 §3):从 Claude Code / Codex / Kimi 导入(指令文件→核心记忆、MCP、技能)与老版本如意→当前包(登记表+各处配置里的绝对路径认老包、备份后改写、按日志 | B：Mac 回收站、包布局、旧 Windows 路径映射 |
| `13v-external-channel-protocols.js` | External QQ/Feishu signed protocol normalization; pure built-in crypto helpers | A：主体复用；按依赖链验收 |
| `13x-external-channel-delivery.js` | Single bounded official QQ/Feishu reply delivery, explicit sent/failed/unknown outcomes | A：主体复用；按依赖链验收 |
| `13y-external-bot-credentials.js` | Bounded Windows DPAPI bot credential vault with explicit env precedence and credential revision CAS | C：保留绑定/CAS/记录模型，替换 DPAPI 与非 Windows 保存拒绝 |
| `13z-external-bot-discovery.js` | Owner-initiated fixed official-host Feishu identity probe, bounded and never persisted | A：主体复用；按依赖链验收 |
| `13ab-privacy-api.js` | 81-P2: token-authenticated security settings and recovery API | B：DPAPI 平台门改为保护器能力探测 |
| `13w-external-bots.js` | Opt-in owner remote control with durable inbox, execution and reply delivery worker | B：创建平台门、密钥落地、后台连接 |
| `14-main.js` | main()/module.exports | B：入口保持，串联新启动/退出生命周期 |

### 8.2 前端全部 76 个 JS 模块

路径前缀：`ruyi-workbench/app/public/js/`。聊天、管家、设置、模型、工作流、文件、音频、记忆、迁移与基础 UI 由文件名分域。所有模块都需要 Mac 浏览器回归，表中仅突出已定位的平台边界。

| 模块 | 初判 |
|---|---|
| `agent-cli-registry.js` | B：平台 CLI 说明 |
| `agent-roles.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `agent-workflows.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `app-frame.js` | B：Ctrl/Cmd 快捷键与宿主入口 |
| `artifact-changes.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `attachment-tray.js` | B：原生选择器/拖放行为 |
| `background-tray.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `boot-failure.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `chat-render-primitives.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `chat-scroll.js` | B：Mac 滚轮/触控板事件复验 |
| `chat-static-renderer.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `chat-stream-runtime.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `composer-voice.js` | B：webm/opus、PCM 与麦克风授权 |
| `confirm-panel.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `event-stream.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `external-bot-setup.js` | B：Mac 凭据配置能力 |
| `external-bots.js` | B：Mac 凭据/连接错误状态 |
| `file-browser.js` | B：Finder、编辑器、路径显示 |
| `health-i18n.js` | B：体检能力与平台文案 |
| `help-menu.js` | B：打开本地目录/日志入口 |
| `help-viewer.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `i18n.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `icons.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `interaction-prompts.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `mermaid-postprocess.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `mermaid-runtime.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `mermaid-source.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `migration-center.js` | B：Mac 包与 Trash 操作 |
| `mission-state.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `modal.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `model-catalog.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `model-menu.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `navigation-controls.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `net.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `notify-policy.js` | B：宿主通知权限状态 |
| `onboarding-wizard.js` | B：选择器/路径/平台向导 |
| `operations-observability.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `playbook-reuse.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `popover.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `presence-viewing.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `privacy-settings.js` | B：加密支持状态与恢复提示 |
| `prompt-queue.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `provider-api-styles.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `provider-settings.js` | B：密钥保护器与 CLI 配置状态 |
| `quiet-card.js` | B：WebView2 通知桥替代 |
| `rail-pocket.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `run-health.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `run-state.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `session-experience.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `settings-catalog.js` | B：平台能力/选项显示 |
| `settings-operations.js` | B：安装/更新/系统操作 |
| `settings-skills.js` | B：平台技能内容 |
| `shell-mode.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `skills-memory.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `state.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `steward-board.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `steward-chips.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `steward-composer.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `steward-conversation.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `steward-decisions.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `steward-delivery.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `steward-drawer.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `steward-handoff-recovery.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `steward-presence.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `steward-settings-receipt.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `steward-settings.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `steward-shell.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `thread-facts.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `thread-head.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `tool-runtime.js` | B：平台工具状态与错误 |
| `turn-activity.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `turn-narrative.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `usage-dashboard.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `util.js` | B：POSIX 路径及通用 DOM 函数复验 |
| `workbench.js` | A：Web 业务/基础 UI 主体复用；宿主依赖另验 |
| `workspace-preferences.js` | B：路径大小写和常用目录去重 |

### 8.3 ACC 全部工具模块与 108 个声明工具

路径前缀：`mcp/ai-computer-control/src/ai_computer_control/tools/`。工具名从 `@mcp.tool` 的函数声明用 Python AST 提取，未启动 ACC 活注册表；有依赖缺失时实际注册数可能更少。

| 模块 | 工具 | 初判与处理 |
|---|---|---|
| `__init__.py` | 公共辅助，无直接工具 | A：公共辅助/算法可复用；安装与平台依赖先适配 |
| `act_and_verify.py` | `act_and_verify` | B：组合工具依赖新的桌面观测/执行后端 |
| `application.py` | `launch_application`, `list_processes`, `kill_process` | C：注册表/.exe/窗口探测换 Launch Services/AX，psutil 部分复用 |
| `audio.py` | `beep`, `notify_attention`, `play_sound` | C：winsound 换系统音频接口 |
| `audit.py` | `audit_tail` | A：公共辅助/算法可复用；安装与平台依赖先适配 |
| `batch.py` | `batch_actions`, `macro_run` | B：批处理框架保留，动作与宏键位按平台适配 |
| `browser.py` | `browser_open`, `browser_backend_status`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_get_text`, `browser_execute_js`, `browser_navigate`, `browser_get_elements`, `browser_list_tabs`, `browser_switch_tab`, `browser_close` | B：Playwright 主体保留，Mac 已有候选；独立安装/浏览器包验收 |
| `capture.py` | `window_screenshot` | C：PrintWindow 换 Mac 窗口捕获 |
| `clipboard.py` | `get_clipboard`, `set_clipboard` | B：文本 pyperclip 可复用，系统行为验收 |
| `desktop_extra.py` | `get_dpi_info`, `get_pixel_color`, `get_clipboard_image`, `set_clipboard_image`, `list_monitors`, `wait_for_window`, `wait_for_window_idle` | C：Win32 DPI/窗口/图片剪贴板换 Mac API |
| `diagnostics.py` | `diagnostics`, `safety_info`, `version_info` | B：按 Mac 后端报告真实可用能力 |
| `dialog.py` | `show_notification`, `message_box` | C：Windows 通知/消息框换 Mac 原生接口 |
| `document.py` | `read_document`, `write_document`, `write_excel`, `write_pdf` | B：Office/PDF 库复用；依赖安装、字体、写入权限验收 |
| `editing.py` | `edit_file` | B：文件编辑复用，系统路径保护适配 |
| `filesystem.py` | `read_file`, `write_file`, `list_directory`, `copy_file`, `move_file`, `delete_file`, `file_info` | B：文件操作复用，路径保护/卷/链接/权限适配 |
| `image_tools.py` | `image_info`, `image_resize` | A：公共辅助/算法可复用；安装与平台依赖先适配 |
| `keyboard.py` | `type_text`, `press_key`, `hotkey`, `key_down`, `key_up` | B：固定 Ctrl+V 改 Cmd；授权、Unicode 输入和剪贴板序号 |
| `memory.py` | `memory_save`, `memory_read`, `memory_list`, `memory_delete` | B：数据路径/权限适配，存储逻辑保留 |
| `mouse.py` | `mouse_click`, `mouse_move`, `mouse_drag`, `mouse_scroll`, `scroll_at`, `get_mouse_position` | B：PyAutoGUI 部分可复用；Win32 横滚、Retina、多屏坐标 |
| `observe.py` | `observe` | B：组合截图/OCR/UIA 更换后端 |
| `ocr.py` | `ocr_image`, `ocr_screen`, `ocr_available_languages`, `ocr_click`, `ocr_find_text` | C：WinRT OCR 换 Vision 或离线 OCR |
| `office_chart.py` | `chart_image` | B：库可复用；Mac wheels 与中文字体 |
| `office_excel.py` | `excel_beautify`, `excel_chart` | B：openpyxl 主体复用，Office 文件验收 |
| `office_io.py` | 公共辅助，无直接工具 | A：公共辅助/算法可复用；安装与平台依赖先适配 |
| `office_markup.py` | 公共辅助，无直接工具 | A：公共辅助/算法可复用；安装与平台依赖先适配 |
| `office_pptx.py` | `write_pptx` | B：python-pptx 主体复用，字体/渲染验收 |
| `office_read.py` | `excel_read`, `pdf_read_pages` | B：openpyxl/pdfplumber 可复用，依赖安装验收 |
| `office_style.py` | 公共辅助，无直接工具 | A：公共辅助/算法可复用；安装与平台依赖先适配 |
| `record.py` | `record_start`, `record_stop`, `macro_list` | B：pynput/录制需 Mac 授权与键位复验 |
| `safety.py` | 公共辅助，无直接工具 | B：Windows 系统树/关键进程/命令规则平台化 |
| `screen.py` | `screenshot`, `screenshot_region`, `get_screen_info`, `find_on_screen` | B：基础截图可复用；Win32 DPI/多屏与坐标需重做 |
| `shell.py` | `run_command` | B：子进程主体保留，shell 语义、编码与安全规则适配 |
| `sync.py` | `wait_for_pixel` | B：像素等待依赖 Mac 截图和坐标 |
| `system.py` | `get_system_info`, `wait`, `get_environment_variable` | A：公共辅助/算法可复用；安装与平台依赖先适配 |
| `thinking.py` | `sequential_thinking` | A：公共辅助/算法可复用；安装与平台依赖先适配 |
| `uia.py` | `ui_inspect`, `ui_find`, `ui_invoke` | C：UIAutomation/comtypes 换 AX，动作语义重新映射 |
| `vision.py` | `find_template`, `find_all_templates`, `vision_click`, `wait_for_image` | B：OpenCV 算法复用，点击/截图坐标适配 |
| `web_fetch.py` | `fetch` | A：公共辅助/算法可复用；安装与平台依赖先适配 |
| `window.py` | `list_windows`, `get_active_window`, `focus_window`, `resize_window`, `move_window`, `minimize_window`, `maximize_window`, `close_window`, `set_window_topmost` | C：win32gui/窗口句柄换 AX/Quartz |

### 8.4 原生全部 120 个工具

从隔离家目录中的当前 `server.js` 导出 `TOOL_HANDLERS` 获取实际派发键。下面分组覆盖全部键，不能把原生 `browser_open` 与 ACC Playwright `browser_open` 混为一谈。

**A/B：管家、记忆与线程业务复用，执行动作继承平台依赖（51）**

`workbench_memory_list`, `workbench_memory_read`, `workbench_memory_propose`, `workbench_memory_relation_propose`, `workbench_memory_revise`, `workbench_memory_relation_revoke`, `observation_recall`, `threads_search`, `thread_read`, `steward_self_status`, `steward_threads_search`, `steward_thread_status`, `steward_thread_read`, `steward_missions`, `steward_skills`, `steward_providers`, `steward_playbooks`, `steward_notify`, `steward_web_search`, `steward_web_fetch`, `steward_file_read`, `steward_thread_artifact_read`, `steward_runs_status`, `steward_inbox_read`, `steward_usage`, `steward_health`, `steward_audit_tail`, `steward_thread_new`, `steward_thread_continue`, `steward_thread_rename`, `steward_thread_workspace`, `steward_thread_permission`, `steward_thread_note`, `steward_thread_prioritize`, `steward_decide`, `steward_run_action`, `steward_thread_stop`, `steward_memory_write`, `steward_memory_veto`, `steward_memory_search`, `steward_config_get`, `steward_config_set`, `steward_playbook_draft`, `steward_skill_toggle`, `steward_quick_ask`, `steward_schedule_create`, `steward_schedule_list`, `steward_schedule_pause`, `steward_schedule_resume`, `steward_schedule_run_now`, `steward_schedule_delete`

**A/B：通用协议、审批、网络、代码分析与任务工具；相关执行/路径边界另验（27）**

`checkpoint_list`, `scratchpad_write`, `thread_title_update`, `list_tools`, `tool_search`, `tool_load`, `tool_invoke_read`, `tool_invoke_edit`, `tool_invoke_exec`, `permission_prompt`, `request_user_input`, `todo_write`, `mission_update`, `workbench_self_status`, `acceptance_report`, `web_search`, `web_fetch`, `http_request`, `http_download`, `dependency_inventory`, `code_review_scan`, `frontend_audit`, `claude_md_audit`, `docs_search`, `codebase_symbol_search`, `debug_hypothesis`, `data_profile`

**B：解释器/外部依赖/配置/凭据适配（8）**

`media_probe`, `audio_inspect`, `code_check`, `script_run`, `audio_transcribe`, `mcp_list`, `mcp_configure`, `steward_bot_setup`

**B：文件与 Git 主体复用，路径护栏/链接/进程/外部命令复验（16）**

`file_read`, `file_write`, `file_edit`, `file_delete`, `file_move`, `file_copy`, `file_list`, `file_search`, `glob`, `project_snapshot`, `archive_zip`, `archive_unzip`, `git_status`, `git_diff`, `git_log`, `git_commit`

**C：Windows 执行/桌面后端需要替代（shell 查询工具随会话后端一起迁移）（10）**

`powershell_run`, `shell_start`, `shell_send`, `shell_poll`, `shell_kill`, `shell_list`, `desktop_screenshot`, `keyboard_send_keys`, `office_open`, `browser_open`

**B：多 Agent 编排复用，进程回收与执行能力适配（4）**

`spawn_agent`, `orchestrate_agents`, `wait_agents`, `agent_result`

**B：资源装载复用，模板内容平台化（4）**

`skill_read`, `playbook_list`, `playbook_read`, `skill_list`


### 8.5 其余文件逐项清单

[MACOS-FILE-INVENTORY.json](MACOS-FILE-INVENTORY.json) 每个文件都有独立记录，覆盖测试、资源、文档、打包、CI、样例、图形和二进制；`platformSignals` 提供关键词命中行号用于后续定位，不复制业务凭据或运行时配置。A/B 混合标记用于同一文件包含可复用业务和平台集成的情况，不代表实测通过。

