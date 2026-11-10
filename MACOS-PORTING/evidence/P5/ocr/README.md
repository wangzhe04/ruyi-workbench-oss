# P5-04 OCR 与模板匹配

2026-11-10，当前主机 macOS 27.0.1 arm64、Python 3.12.10、Node 24.15.0、SDK 15.2，原生编译目标 macOS 14.0。工作包保持进行中，当前主机独立验收及最终工程门已通过。实现提交绑定进行中，P5-05 与原环境门继续推进。

## 工具与坐标

五项 OCR 工具使用系统 Vision revision 3 accurate。`ocr_image`、`ocr_available_languages`服务本地图片和语言查询。`ocr_screen`、`ocr_find_text`、`ocr_click`通过 ScreenCaptureKit 观察桌面。默认语言提示为简体中文与英语，显式不支持的语言返回错误及有界语言列表。

四项模板工具为 `find_template`、`find_all_templates`、`vision_click`、`wait_for_image`。OpenCV headless 在独立只读子进程中匹配，截图来自 Mac 捕获后端。共享 OCR 短语算法及 OpenCV 算法被提取为纯函数，旧模块继续导出已有私有名称。

本地 OCR 返回左上原点的图片像素。屏幕 OCR 和模板结果返回全局逻辑点，使用实际截图宽高与 logical_bounds 分别回映射两条轴。屏幕 OCR 的 width、height 记录原截图像素尺寸。图片采用第一帧原始解码像素方向，EXIF 旋转元数据不参与归一化。

## 点击、取消与资源期限

点击要求完整的当前活动窗口 target，并将搜索区域裁剪到窗口。多项匹配需要显式 nth 或唯一最近点。匹配全量集合参与选择，响应截断单独标记。派发前重新观察窗口身份与几何、截图尺寸与逻辑范围，并逐字节比较匹配区域及三像素边距。原生派发继续核验焦点和命中窗口。观察计时从第一次截图开始，派发年龄上限为十秒。

后台线程仅执行只读观察。取消后，未结束的工作继续持有并发门，直至有界工作实际结束和子进程被回收。点击在观察 await 与取消检查之后进入原生派发。返回 `native_events_posted`、`confirmed=null` 和 `outcome=unconfirmed`，接收端实际效果另由后续观察验证。

首次系统模型编译曾超过十二秒，初次超时保留。计算设备配置试验仍观察到神经引擎编译，因此最终使用 Vision 默认设备。原生识别期限为六十秒，Python 外层为六十五秒。冷识别超过十秒时，点击依据原观察年龄返回过期错误。后续请求使用新帧。当前已观测到同 helper 的独立进程暖态识别约 0.15–0.19 秒。[初次超时](development/first-ocr-timeout.json)

原生图片最多 50MB、3200 万像素、每边 16384 像素。打开文件后，使用同一个 FD 有界读取，核对读取前后长度、mtime 和 ctime，再由内存字节解码。普通图片符号链接受支持。OCR 最多 2000 行、10000 词，模型响应最多 500 词。模板最多 8MB、400 万像素。OpenCV 原始命中上限 4096，在收集命中数组前检查，软匹配期限六秒，子进程硬期限八秒。模板等待使用剩余期限，并拒绝晚到命中。

## 当前运行记录

- 25 项纯逻辑测试通过，包括取消后禁止后台输入、等待截止、并发门、双轴坐标、失效目标、画面变化、截断、独立 worker 和依赖缺失撤目录。
- 真实 MCP 通过中英图片、语言拒绝、无效文件、符号链接、桌面 OCR、重复文字选择、模板全量匹配与点击。两个文字按钮和中文按钮的实际计数逐项验证。[主执行](development/third-live/results.json)
- LaunchServices 如意 App 经普通 HTTP 工具入口完成本地图片识别、中文定位及点击、模板重复目标选择，接收端最终计数为 `[0,1,1]`。该模式十三条断言通过，自有 App/service/ACC/helper 进程清理通过。[App 主执行](development/app-first/visual-host.json)

## 开发失败与处理

第一轮实时测试还包含无效图片分类不准确及测试清理调用了不存在的方法。第二轮无效图片分类和清理通过，保留十项失败。检查模板截图发现系统深色外观下，测试按钮文字与显式白色窗口背景对比不足。夹具固定为浅色外观，第三轮文字与模板闭环全部通过。窗口焦点切换时，原生活动窗口查询也可能先返回 window_not_found，测试接受这条明确拒绝路径。[第二轮结果](development/second-live/results.json) [当时模板截图](development/second-live/button-template.png)

独立源码复核发现同步工具会阻塞 MCP 事件循环，以及等待可能接受迟到命中。Mac OCR 与视觉工具现使用异步入口，观察与原生派发分开，取消与剩余期限均有针对性测试。两项问题已由独立复核从源码关闭，Windows 公开入口与迁移函数另有 AST 核验。[代码复核](code-review.json)

## 依赖与待验环境

OpenCV headless 4.14.0.94 的官方 wheel 实际字节与 PyPI SHA-256 一致，并经 `--no-index --no-deps` 离线安装。NumPy 为当前环境已有的 2.5.4。完整 Mac 视觉锁文件基于现有浏览器/文档依赖清单增加 OpenCV，缓存文件按既有约定留在本机。[wheel 记录](dependencies/vision-wheel.json) [离线安装](dependencies/offline-install.txt) [依赖锁](../../../dependencies/requirements-macos-arm64-cp312-vision.lock.txt)

实际 macOS 14、物理多屏和非 Retina、正式签名身份、真实权限撤销与动作中锁屏，以及同候选 Windows 回归仍待验。P5-05 的宏录制和执行后组合验证尚未实现。

## 当前主机最终验收

独立执行十四条命令各一次，八组真实 E2E 共 215 条、六组 Python 共 87 项通过，零失败、零跳过、零自动重跑。默认 helper 同时用于真实 MCP 与 LaunchServices App 视觉验收。八十份源码文档和三份二进制/构建元数据在每条命令前后及最终均一致，App 记录的全部创建身份已退出，额外受控路径残留为空，剪贴板恢复断言通过。[独立报告](independent/report.json)

工程四门通过，语法检查 1147 文件，构建产物新鲜，完整单元 2499 通过与 18 项既有跳过，静态 80/80、零 flaky、测试浏览器残留零。测试后收口 TASKS、P5 阶段文档与跟踪记录，并删除两份提取纯函数文件的冗余末尾换行，分别为两字节和一字节。其余字节及 Python AST 一致，25 项相关测试再次通过。交付指纹逐项列出三份文档和两处空白差异。[工程记录](acceptance/engineering/results.json) [最终交付指纹](source-fingerprint-final-delivery.json) [空白修正](eof-formatting.json) [专项复测](acceptance/eof-smoke.txt)

默认 helper SHA-256 为 `d46352387964c9a1ef95cc766bd26af92c7a5c1df0a22283c9204e0a48b656c9`，它与如意 App 的 strict codesign 验证通过。首次默认位置识别耗时 33.186 秒，随后使用同一已验产物完成独立视觉链。[默认产物](acceptance/default-helper.json)
