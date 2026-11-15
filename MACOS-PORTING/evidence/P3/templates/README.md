# P3-04：平台模板与能力文案单独本地验收

2026-11-07，macOS 27.0.1 arm64、Node 24.15.0、Python 3.12.10。实现 SHA 与源码哈希见 [source-fingerprint.json](source-fingerprint.json)，完整验收对账见 [validation.json](validation.json)。

## 交付

- [独立内容审计](content-audit.json)逐项覆盖 **71 项**：16 Playbook、20 离线技能、13 命令、4 插件 agent、10 内置角色、8 工作流。[12 组处理对账](content-resolution.json)保留基线发现与最终修正；内置角色/工作流没有 Windows 专属执行假设，其联网、工具、输入格式前置条件继续有效。
- 目录清点、定时摘要、下载清理提供 Mac Python 路径，保留 Windows PowerShell；输入根按真实身份核验，目录/文件符号链接只记录、不读取目标。重命名按目标卷实际大小写与 Unicode 等价检查，保留预览、明确同意和不覆盖。Mac 下载清理只生成建议，因暂无已验证的废纸篓工具而不执行删除。
- `desktopMcp` 仍表示共享 ACC 连接；新增 `desktopAutomation`、`ocr`、`browserControl` 需求。Mac 桌面/OCR 模板显示不支持；system 浏览器仅交接 URL，不能启用填表。准备好依赖但尚未连接的 DOM 浏览器允许显式尝试，状态保持 unknown；包/文件存在不能升级为 ready。桌面/OCR 授权未知也保留 unknown，明确拒绝或未就绪则阻止。
- 能力矩阵读真实 `browser_backend_status`，区别包、二进制、连接与探针失败。查询失败保持未知，不指引用户错误地重装浏览器。缓存按浏览器/桌面配置与工具闸隔离，旧慢探针不能覆盖新配置或回切命中的快照；同目标仍共用进行中探针。
- Mac 提示词不再因共享 Office 连接而要求 UIA/OCR/窗口操作；Windows 原路径保留。浏览器、前端审计命令和独立 agent 都有明确平台边界；CDP 核对目标 URL、保护未拥有页面，窄屏检查必须实际改变 viewport，不能缩放截图冒充。
- 修正文档原生读取能力的旧说明，以及短 PDF 默认页码和单页 `2-1` 指令。COM、Windows 发行命令与 Mac 开发启动/doctor 分开，未把 P4/P6 当作已交付。离线插件升级为 **0.3.1**，供缓存按版本更新。
- 主要中英文说明、能力弹层与不可用原因同步。弹层区分共享 ACC、未实现的 Mac 桌面后端和未验证的 DOM 浏览器；进行中/失败刷新不保留旧 ready。

## 验证

- [真实 Workbench + ACC 专项](templates.txt)：**38 项通过，无失败或跳过**。system、缺缓存、预备完整缓存三个实际场景，16 个模板全部可见并给出真实状态；共享文档保留可用，未实现的桌面/OCR 禁用；修改浏览器目标后无需强制刷新即可取得新事实。另有 Windows 选择和授权/ready/缺依赖矩阵，未冒充 Windows 实机执行。
- [既有 Playbook 回归](playbooks.txt) **94 项**、[能力矩阵回归](capabilities.txt) **56 项**、[权限总闸](acc-gates.txt) **37 项**、[Playbook/技能工具](skill-tools.txt) **26 项**全部通过。保留旧网络/共享连接/视觉能力矩阵语义和权限护栏。
- [真实中英文弹层](popover.txt)：**18 项通过**，含刷新失败清理 DOM-ready 声明、实际 UI 七条新原因英文翻译、弹层更新与定位。中文[正常](samples/ready.png)/[执行能力不可用](samples/unavailable.png)及[英文](samples/english.png)截图已目视检查，无溢出；英文 DOM 标签按实际宽度换行。
- [缓存专项](cache.txt) **6 项通过**，包括真实生产函数的受控异步乱序、命中缓存后回切、同目标请求合并。独立复核另以受控 MCP 传输重放 SDK 探测失败和授权矩阵。
- 最终完整[单元](unit.txt) **2491 通过、18 既有跳过、0 失败**；完整[静态](fast.txt) **79/80**。唯一失败为 ASR 静态门中的旧三项 Playbook 枚举锁，现通过实际运行时常量精确断言原三项与新增三项，[定向复验](asr-contract-final.txt)通过，其余79组复用未变范围结果；没有宣称另一次完整80/80。语法与构建见 [syntax.txt](syntax.txt)、[build.txt](build.txt)。路由/事实/依赖图按仓库生成器重算，后端零 npm 运行时依赖不变。
- [独立复核](review.json)记录实现范围、发现、修复和复测。所发现的授权/ready 升格、探针错误误判、缓存乱序发布问题均已修复，无剩余代码发现。

## 失败记录与限制

[首轮专项](templates-first.txt)在读取需要鉴权的 Playbook API 时因测试缺 token 被拒；夹具改走真实 bootstrap，未放宽鉴权。[首轮单元](unit-first.txt)有5条语言镜像不一致失败，初次[fast](fast-first.txt)因此拒跑静态；补齐 docs/i18n 镜像后才进行最终完整复验。修复前独立探针与处理记录在 review.json，未把原失败或跳过算通过。

**P3-04 Mac 开发与单独本地验收完成。P3 四包的 Mac 本地验收均已完成，P3 整体仍进行中。** Windows 同候选实际 CI/实机回归未执行且未获豁免；macOS 14、正式签名、默认有界面浏览器用户交互与干净机离线发行仍按原阶段交接。71项是内容与能力条件审计，不宣称71种任务都已由真实模型执行；模板模型执行质量不是代码或资源存在就能证明。Mac桌面与OCR依然待P5，废纸篓交P6，不新增这些能力。
