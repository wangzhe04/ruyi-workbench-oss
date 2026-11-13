# P3-03：浏览器运行时单独本地验收

2026-11-07。实现提交见 [source-fingerprint.json](source-fingerprint.json)。macOS 27.0.1 arm64、Python 3.12.10、Node 24.15.0，Playwright 1.64.1 + Chromium 156.0.8078.4（revision 1248）。

## 交付与验证

- Mac managed 模式发现本机 Chrome/Edge/Chromium；bundled 模式按 SDK 解析完整 Chromium，尊重 `PLAYWRIGHT_BROWSERS_PATH`，启动独立临时 profile。`ACC_BROWSER_HEADLESS=1` 可用于受控无界面验证；默认仍有界面。
- `browser_backend_status` 区别配置/活动目标、包存在、二进制存在、连接就绪、profile 隔离和实际版本；CDP 未连接时不猜测安装状态。Mac system 模式只报告 URL 交接请求，`navigationVerified=false`，不声称 DOM、UIA 或 OCR 可用。
- CDP 退出只关闭工具创建的页面，保留原用户页面、未提交文本、浏览器及 profile。自有浏览器显式关闭或正常 stdio EOF 都清理浏览器、驱动和临时 profile。启动/状态探测取消及自身超时也保留资源所有权并清理；清理失败明确返回 incomplete。
- [真实 MCP 验收](runtime.txt)与[全新环境断网重放](offline.txt)各 **25 项通过、0 失败、0 跳过**。测试只有本机 HTTP 表单与受控浏览器，覆盖中文输入/提交、截图、前进后退、标签页、错误页面、缺包/缺缓存降级、独立 profile、显式关闭、EOF 及 CDP 页面保护。没有操作用户默认浏览器或账号。
- [63 项运行依赖锁](../../../dependencies/requirements-macos-arm64-cp312-browser.lock.txt)保留 Office 基础依赖；ACC wheel 单独构建。全新非 editable 环境使用 `PIP_NO_INDEX=1` / `--no-index` 安装，`pip check` 通过，导入位置确认在新虚拟环境，再重复上述真实 MCP 测试。预备阶段下载与离线运行阶段分开；运行不安装或下载浏览器。[wheel 清单](wheel-manifest.json)、[浏览器清单](browser-manifest.json)记录外部缓存身份，不把二进制打入源码证据。
- [生命周期专项](lifecycle.txt) **8 项通过、无跳过**，包括真实可控 launcher/driver 在启动返回前、启动中与状态探测中的取消/超时。既有[读取及浏览器 FakePage 回归](office-read.txt) **98 项通过、无跳过**。
- 最终[页面截图](samples/page.png)已经目视检查：中文提交结果完整、无截断；[实际状态](samples/runtime.json)记录版本、profile 与缓存路径。
- 完整[单元](unit.txt) **2490 通过、18 既有跳过、0 失败**；[语法](syntax.txt)1127 文件零错误，[构建](build.txt)新鲜。初次[静态](fast-first.txt) **78/80**，PDF binary 属性和 Mac 夹具清理清册修正后，[EOL](eol-final.txt)、[夹具](fixture-final.txt)与[进程门](process-final.txt)定向复验通过；其余78组复用未变范围结果，不宣称另有一次完整80/80。
- [独立复核](review.json)发现的两项驱动清理缺陷均有修复与真实探针复测，无剩余代码发现。

## 失败修复与边界

早期夹具把 MCP 的 Python 进程误算成关闭浏览器时应退出的进程，现只观察真实浏览器/驱动；EOF 另要求整条自有树退出。CDP 列表同时包含非 page target，现保留原页面并逐项检查工具拥有的页面全部关闭。Workbench 的 JS 保护仍应拒绝调用，未为测试放宽；独立 WebSocket 仅查看夹具自己创建的页面。

独立启动的新 Chrome 曾在未使用测试钥匙串参数时阻塞导航；最小控制组确认加 `--password-store=basic` / `--use-mock-keychain` 后出现本地请求。正式夹具沿用 Playwright 的这些既有参数，产品启动本已包含，无需改产品或访问用户钥匙串。首轮、第二轮、第四轮、第五轮失败日志均保留。

独立复核分别复现启动取消和状态探测取消/超时的驱动泄漏；现在 manager/start task 在 SDK 分配进程前登记，取消后执行有上界的屏蔽清理。[取消前](status-cancel-before.txt)、[超时前](status-timeout-before.txt)及对应[修复后取消](status-cancel-after.txt)、[超时](status-timeout-after.txt)证据保留。协议 gate 持续不返回时也终止真实驱动，同时如实报告启动协议清理 incomplete。

**P3-03 Mac 开发与单独本地验收完成。** Windows 同候选实际回归未执行且未获豁免，macOS 14、签名身份与干净机离线发行仍未验证。当前真实浏览器运行验证使用 headless；默认有界面模式的用户可见交互另待受控桌面验收。P3 整体继续进行，下一包 P3-04 模板与能力文案。
