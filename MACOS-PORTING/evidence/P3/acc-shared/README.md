# P3-01：Mac 共享 ACC 单独本地验收

2026-11-06。实现提交 `f135bda1c4bb9703ccbb926f36d99f855ad0f63c`，分支 `codex/p3-macos-documents`。本机 macOS 27 arm64、Node 24.15.0、Python 3.12.10。完整需求/结果见 [validation.json](validation.json)，代码哈希见 [source-fingerprint.json](source-fingerprint.json)。

## 交付范围

- pyproject 与离线依赖清单使用平台标记。Mac 基础安装无需 pywin32、PyAutoGUI、UIA、WinSDK 或 pynput，Windows 保留这些依赖。
- Mac 默认实际注册 43 个文件、Office、浏览器和其他共享工具。尚未实现的桌面、UIA、OCR、录制等模块不进入模型目录，显式 ACC_TOOLSETS 也无法启用。诊断区分平台不支持、加载失败与依赖可发现；可选包可发现不等于浏览器运行时或系统权限已就绪。
- Mac 文件护栏覆盖系统树、根目录、家目录和 Keychains；解析链接、Data 卷别名及实际文件身份。尚不存在的保护目录按所在卷的大小写语义比较；APFSX 上保留不同大小写，同时保护 Unicode 等价路径；卷语义查询失败时保守保护。临时工作区正常可写。
- Windows Full 打包仍严格验证 WinSDK 固定版本，兼容准确的 Windows-only 标记；错误平台或浮动版本仍拒绝。

## 本包验收

- [Python 专项](python-final.txt)：8 项通过、0 失败、0 跳过，包括真实默认卷与受控 64 MiB APFSX 卷、缺依赖隔离、未创建保护根、NFC/NFD 路径及查询异常。系统路径只做规则检查，无系统写入；受控测试卷已卸载。
- [真实 MCP 专项](mcp-e2e.txt)：14 项通过、0 失败、0 跳过。生产 stdio 客户端完成目录读取、中文/空格/emoji 文件读写、已有文件拒绝、链接与缺失保护根拒绝、写入审计、自有进程退出，以及真实共享工具目录的检查点清册对账。
- [断网安装](offline-install.txt)：预先准备本平台 wheel 缓存后，以 PIP_NO_INDEX/--no-index 在全新隔离虚拟环境安装非 editable wheel，pip check 通过；从安装目录实际加载 43 工具且 load_errors 为空。实际执行源见 [安装验证脚本快照](offline-install-runner.cjs.txt)，缓存文件与哈希见 [wheel-manifest.json](wheel-manifest.json)。准备缓存允许联网，安装/运行验证不下载。这是开发环境验证，未作为签名发行包交付。
- [依赖标记](markers.txt)：Mac 排除、Windows 保留六组原桌面依赖；[Windows Full 静态契约](installer-final.txt)通过。Windows 实机/CI 仍未执行。
- 完整单元 2490 通过、18 既有跳过、0 失败，见 [unit.txt](unit.txt)。首轮静态 78/80，两组失败分别为新测试引起的 facts 漂移与真实 Full 标记校验失配，见 [原记录](fast-first.txt)；修复后 [facts](facts-final.txt) 与 [installer](installer-final.txt) 均复测通过。其余 78 组复用首轮结果，不宣称另有一次完整 80/80 运行。
- [检查点回归](checkpoint.txt)与[能力总闸](capability-gates.txt)通过。旧检查点件的可选真实 ACC 子分支因解释器环境跳过；其静态清册/假 MCP 回滚分支通过，当前真实 43 工具清册由新增强制 MCP 专项补齐，跳过项未计通过。
- [语法](syntax.txt)：1125 文件、0 错误；[构建](build.txt)：生成物新鲜。

## 独立复核与失败记录

[独立复核](review.json)最终无剩余代码发现。复核发现并修复：未创建保护目录的大小写绕过、Windows Full 版本正则失配、pathconf 失败放行、APFSX 上 NFC/NFD 缺失根绕过。最后两项先补 [红测](python-red.txt)确认实际失败，再修复与复测；没有通过删除断言或改为 skip 收尾。

首次 wheel 准备遗漏本机迁移 Python 的 CA 路径，TLS 验证失败，保留 [首次日志](wheel-preparation-first.txt)；补正确证书路径，未禁用证书检查。最终 [wheel 构建](wheel-build.txt)使用预备构建缓存与 --no-index 完成。新 smoke 文件首轮语法缩进错误已在行为验证前修正。

## 限制与下一包

本包 **Mac 开发与单独本地验收完成**。Windows 同候选实际回归未执行且未获豁免，保留为 P3 整体阶段关口；不能以本包静态契约代替 Windows Full 实际运行。macOS 14 arm64/最低 wheel 部署目标、正式签名身份和干净机离线发行维持原 P3/P6 交接。P3 整体进行中，下一包为 P3-02 文档、图表、中文字体及独立产物检查。
