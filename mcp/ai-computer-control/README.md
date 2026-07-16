# AI Computer Control

一套基于 MCP (Model Context Protocol) 的 AI 电脑操控工具集，支持离线部署。

## 功能概览

| 类别 | 工具数 | 说明 |
|------|--------|------|
| 屏幕截图 | 4 | 全屏/区域截图、屏幕信息、图像定位（find_on_screen） |
| 窗口截图 | 1 | window_screenshot（PrintWindow，可截后台窗口） |
| 鼠标操作 | 6 | 点击、移动、拖拽、滚动、定点滚动（scroll_at）、获取位置 |
| 键盘操作 | 5 | 打字、按键、快捷键、按下/释放 |
| 剪贴板 | 2 | 读取/设置剪贴板 |
| 窗口管理 | 9 | 列表、聚焦、调整大小/位置、最小化/最大化/关闭/置顶 |
| 应用管理 | 3 | 启动应用、进程列表、结束进程 |
| 文件系统 | 7 | 读写文件、目录浏览、复制/移动/删除、文件信息 |
| Shell | 1 | 执行命令行命令 |
| 系统信息 | 3 | 系统信息、等待、环境变量 |
| 浏览器 (可选) | 12 | 默认用系统浏览器打开URL；可选 Playwright/CDP 点击、输入、截图、提取文本、JS执行、导航、标签页与后端状态 |
| 文档读写 | 4 | 读取Word/Excel/PDF、创建Word、创建Excel、导出PDF（中文字体自动内嵌） |
| Office 模板体系 | 4 | excel_beautify / excel_chart / write_pptx / chart_image——模板驱动出「好看」，三套设计系统（青花商务/墨白极简/活力现代），中文字体纪律（w:eastAsia） |
| Office 读取 | 2 | excel_read（结构化读表，含公式）/ pdf_read_pages（分页读大 PDF） |
| 图像工具 | 2 | image_info / image_resize（等比缩放/格式转换） |
| 对话框 | 2 | Toast通知、消息框 |
| 批处理 | 2 | batch_actions / macro_run 一次调用跑多步 |
| 音频提示 | 3 | beep / notify_attention / play_sound |
| 桌面扩展 | 7 | 像素取色、剪贴板图像读写、显示器枚举、DPI、等待窗口/空闲 |
| UI Automation (可选) | 3 | ui_inspect / ui_find / ui_invoke（无 uiautomation 时优雅降级） |
| OCR (可选) | 4 | ocr_image / ocr_screen / ocr_click / ocr_find_text（无 winsdk 时降级） |
| 视觉匹配 (可选) | 4 | find_template / find_all_templates / wait_for_image / vision_click（无 cv2 时降级） |
| 观察与验证 | 2 | observe（一次拿截图+窗口+UIA+OCR）/ act_and_verify（操作后测量屏幕变化） |
| 宏录制 (可选) | 3 | record_start / record_stop / macro_list（无 pynput 时录制降级） |
| 同步原语 | 1 | wait_for_pixel（轮询像素直到匹配/超时） |
| 诊断与安全 | 4 | diagnostics / version_info / safety_info / audit_tail |

**共计 100 个工具**（v1.8.2；总数与分组由注册表实测导出，`tests/smoke_registry.py` 钉死）

### v1.8.2 浏览器与视觉可靠性

- `browser_open` 默认在用户实际浏览器的新标签页/窗口打开，不再默认启动 Chrome for Testing；不会复用或导航检测到的 Ruyi/Workbench 标签页。可用 `ACC_BROWSER_MODE=managed|custom|cdp|bundled` 自定义；`bundled` 才会显式使用隔离测试浏览器。
- `browser_backend_status` 返回当前浏览器目标、连接状态和 CDP 地址。系统浏览器不受本工具所有，`browser_close` 不会关闭它。
- Chromium 管理模式加入 renderer accessibility 参数；如果 Direct3D/硬件加速页面仍只暴露浏览器外壳，`ui_inspect`、`ui_find` 和 `observe` 会返回 `accessibilityLimited`，提示直接切换 DOM/CDP、OCR 或截图坐标，不再反复重试 UIA。
- OCR 统一接受 `bytes`、`bytearray`、`memoryview` 与二进制流，并兼容不同 winsdk 的 `DataWriter.write_bytes` 参数形态，修复 `TypeError: bytes-like object required`。

### v1.6–v1.8 新增工具（Office 模板体系 + 读取与图像）

| 工具 | 版本 | 说明 |
|------|------|------|
| `excel_beautify` | v1.6 | 对已有 .xlsx 落样式：表头/斑马纹/边框/数字格式启发式（千分位/货币/百分比）/格式化感知列宽，幂等 |
| `excel_chart` | v1.6 | 在 .xlsx 内嵌原生图表（柱/条/折/饼），v1.7.1 起支持 X/Y 轴标题（缺省自动推导自表头） |
| `write_pptx` | v1.6 | 16:9 演示文稿：封面/内容（≤3 条大字居中、6–10 条自动两栏）/数字亮点卡（stats）/表格/图片/结尾版式 |
| `chart_image` | v1.6 | matplotlib 出 .png 制图（Agg 后端、DPI150、中文字体链），带轴标题 |
| `excel_read` | v1.8 | 结构化读表：单元格值+公式+合并区+数字格式，供「读回再加工」 |
| `pdf_read_pages` | v1.8 | 分页读 PDF（页码范围），大文件不撑爆上下文 |
| `image_info` | v1.8 | 图像元数据（尺寸/格式/EXIF 摘要） |
| `image_resize` | v1.8 | 等比缩放/格式转换，输出走 output_path（进工作台检查点，可回撤） |

> **模板驱动设计**：Office 产出的美观由 `office_style.py` 的三套设计令牌保证（business 青花商务=藏蓝+鎏金/古铜金、minimal 墨白极简、vibrant 活力现代），AI 只填内容——不赌模型审美。Word 经样式表级 `w:eastAsia` 字体纪律根治中英混排字号不一。
> **可回撤**：本 MCP 所有「动文件」工具在如意工作台内均进文件检查点（快照表机制性审计钉死），可一键撤销。

### v1.5 新增工具

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `write_pdf` | 由 markdown-lite 文本导出 PDF（周报/汇总/归档摘要等）；中文字体自动解析并内嵌（微软雅黑→宋体→内置 STSong-Light CID→Helvetica 兜底），段落 CJK 断行；可附一张表 | `path`, `content`, `title`, `table_headers`, `table_data`, `page_size='A4'\|'letter'` |

> **中文渲染**：`write_pdf` 按 微软雅黑(`msyh.ttc`) → 宋体(`simsun.ttc`) → reportlab 内置 `STSong-Light`(零外部文件，阅读器侧 CID) → Helvetica(仅拉丁，兜底) 的顺序注册一次并全局缓存；返回的 `font` 字段标明实际所用字体。**可选依赖 reportlab** 缺失时返回 `{error: 'PDF 导出需要 reportlab…'}` 优雅降级，不影响其它工具。

### v1.4 新增工具

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `observe` | 一次调用返回预算后截图 + 焦点窗口 + UIA 元素(≤80) + OCR 词(≤200)；坐标为未缩放物理屏幕坐标 | `max_width=1280`, `window_title`, `include_uia`, `include_ocr`, `format`, `quality` |
| `act_and_verify` | 前截图 → 执行 click/type/key → 等待稳定 → 后截图 → 区域像素 diff 比率 | `action{type,...}`, `region`, `settle_ms=500`, `save_shots` |
| `record_start` | 开始录制真实鼠标/键盘为可回放宏（需 pynput） | — |
| `record_stop` | 停止录制，返回 macro_run 兼容步骤，可存 `<data>/macros/<name>.json` | `save_as` |
| `macro_list` | 列出已存宏（无需 pynput，仅读目录） | — |

> **截图预算**：`screenshot` / `screenshot_region` / `window_screenshot` 新增 `max_width`（>0 等比缩放，0=原尺寸）、`format`（png/jpeg）、`quality`（jpeg）；返回 `scale` 供坐标回映（`x_screen = x_in_image / scale`）。**注意**：observe 的 uia_elements/ocr_words 及 ocr_find_text/ui_find 的 rect/center 始终为**未缩放**物理屏幕坐标（可直接点击），仅截图字节受 `scale` 影响。
> **ocr_click 消歧**：新增 `nth`（0 基读序索引）、`nearest_to{x,y}`（就近点击）、`return_candidates`（只返候选不点击）。
> **diagnostics.optional**：顶层新增紧凑布尔 `{ocr,uia,cv2,playwright,pynput}`，与工作台 `probeDesktopMcp` 扫描字段对齐（沿用 `optional_modules` 完整导入级映射不变）。
> **浏览器目标与降级**：默认 `system` 模式无需 Playwright，通过用户默认浏览器打开后使用桌面截图/UIA/OCR；DOM 工具会明确提示切换到 `managed`、`custom` 或 `cdp`。这些模式缺少 Playwright 时返回安装提示；`bundled` 是显式兼容/测试选项。

### v1.3 新增工具

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `diagnostics` | 版本 / Python / 管理员 / 显示器 / DPI / 可选模块可用性 / 工具数 | — |
| `version_info` | 精简版本 + 工具数 | — |
| `safety_info` | 生效护栏（内置 + 数据目录 safety.json 覆盖）及来源标注 | — |
| `audit_tail` | 读取最近 n 条改动型工具审计记录（NDJSON） | `n=50` |
| `window_screenshot` | 按标题模糊匹配截取指定窗口，优先 PrintWindow，失败回退裁剪 | `title_substring`, `output_path` |
| `ocr_find_text` | OCR 屏幕/区域，跨相邻词定位文本，返回中心坐标；可点击（需 winsdk） | `text`, `region`, `click` |
| `vision_click` | 多尺度模板匹配定位并可点击中心（需 cv2） | `template_path`, `threshold`, `click` |
| `wait_for_pixel` | 轮询 (x,y) 像素直到匹配 color_hex 或超时 | `x`, `y`, `color_hex`, `timeout_ms`, `tolerance` |
| `scroll_at` | 在 (x,y) 处滚轮滚动 amount | `x`, `y`, `amount` |

> 说明：所有工具统一返回带 `ok` 布尔字段的字典；改动型工具（键鼠/文件/进程/剪贴板/命令/窗口/宏等）自动写入数据目录审计日志 `logs/audit-YYYYMMDD.ndjson`。可选依赖（uiautomation / winsdk / opencv / **playwright / pynput**）缺失时对应工具返回 `{ok:false, error:...}` 并附安装提示，不会导致服务崩溃。护栏可通过数据目录 `safety.json` **仅加严**（额外保护路径 / 禁止命令 / 禁杀进程名）。

## 快速开始 (开发模式)

```bash
# 安装依赖
pip install -e .

# 对齐 Full 包的完整桌面/OCR 能力：在 CPython 3.12 环境中，用完整离线包的
# offline_packages 作为 wheel 缓存安装 requirements_offline.txt；其中包含 winsdk，
# 默认 OCR 使用 Windows.Media.Ocr，不需要 Tesseract。
pip install --no-index --find-links <Full包路径>\offline_packages -r requirements_offline.txt

# 安装 Playwright 浏览器（可选：仅 managed/custom/CDP/bundled DOM 自动化需要；system 模式不需要）
playwright install chromium

# 启动 MCP Server
python -m ai_computer_control
```

## MCP 配置

在 Claude Desktop 或其他支持 MCP 的 AI 工具中添加如下配置：

```json
{
  "mcpServers": {
    "ai-computer-control": {
      "command": "python",
      "args": ["-m", "ai_computer_control"]
    }
  }
}
```

## 离线部署

### 第一步：构建离线安装包（需联网）

```bash
python installer/build_offline_package.py
```

生成 `ai-computer-control-offline.zip`，构建过程会先执行一次严格的 `--no-index` 空目录安装回放，产物包含：
- 已预装并通过导入检查的 Python 3.12 嵌入式运行时
- 所有 Python 依赖的纯 wheel 修复缓存（不含 sdist，不在目标机编译）
- Playwright Chromium 浏览器
- SHA-256 完整性清单和安装脚本

### 第二步：离线安装（无需联网）

将 zip 文件拷贝到目标机器，解压后双击运行 `install.bat`。

安装脚本会自动：
1. 校验离线包内全部文件的大小和 SHA-256
2. 原子部署已预装的 Python 运行时并再次执行 ACC 导入检查
3. 配置 Playwright 浏览器
4. 注册 MCP Server 配置并生成手动启动脚本

目标机无需系统 Python、pip、编译器或网络。旧的自定义包仍可使用系统 Python ≥3.12 回退安装，但安装器会明确拒绝任何 `.tar.gz` / sdist，防止再次出现离线构建依赖失败。

## 项目结构

```
ai-computer-control/
├── src/ai_computer_control/
│   ├── server.py          # MCP Server 入口
│   ├── tools/
│   │   ├── screen.py      # 屏幕截图工具
│   │   ├── mouse.py       # 鼠标操作
│   │   ├── keyboard.py    # 键盘操作
│   │   ├── clipboard.py   # 剪贴板
│   │   ├── window.py      # 窗口管理
│   │   ├── application.py # 应用管理
│   │   ├── filesystem.py  # 文件系统
│   │   ├── shell.py       # Shell命令
│   │   ├── system.py      # 系统信息
│   │   ├── browser.py     # 浏览器自动化（可选 playwright，优雅降级）
│   │   ├── document.py    # 文档读写
│   │   ├── dialog.py      # 对话框/通知
│   │   ├── observe.py     # observe：一次拿截图+窗口+UIA+OCR（v1.4）
│   │   ├── act_and_verify.py # 操作后测量屏幕变化（v1.4）
│   │   ├── record.py      # 宏录制（可选 pynput，优雅降级）（v1.4）
│   │   ├── office_style.py   # 三套设计令牌（青花商务/墨白极简/活力现代）+ 中文字体链探测（v1.6+）
│   │   ├── office_excel.py   # excel_beautify / excel_chart（v1.6+）
│   │   ├── office_pptx.py    # write_pptx 多版式演示文稿（v1.6+）
│   │   ├── office_chart.py   # chart_image matplotlib 制图（v1.6）
│   │   ├── office_read.py    # excel_read / pdf_read_pages（v1.8）
│   │   └── image_tools.py    # image_info / image_resize（v1.8）
│   └── utils/
│       └── image.py       # 图像编码工具（含 encode_with_budget 截图预算）
├── installer/
│   ├── build_offline_package.py  # 离线包构建脚本
│   ├── install.py                # 安装逻辑
│   └── install.bat               # 一键安装入口
└── pyproject.toml
```

## 系统要求

- Windows 10/11 (64位)
- Python 3.12（离线 Full 包自带已验证的 CPython 3.12 与纯 wheel 缓存；`winsdk` 的 OCR wheel 以 cp312 提供，默认 OCR 不使用 Tesseract）
