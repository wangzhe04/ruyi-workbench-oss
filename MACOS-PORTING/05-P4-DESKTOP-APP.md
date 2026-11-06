# P4：Mac 桌面壳

状态：待开始 · 前置：P2, P3 · 基础工作量：**10–16 人日**。估算包含本阶段实现、相关测试、修复、文档与独立复核响应；共用风险容量只在总估算另加一次。

## 目标

将已验证的浏览器工作台封装成独立 Mac App，补系统交互和稳定的后台生命周期。

## 入口条件

前置阶段已验收或明确仅开展不依赖其结果的探针；读取架构约定和当前基线。开始时核对源码变化，复用现有函数和测试，不根据旧行号盲改。

## 涉及文件与调用链

- [`ruyi-workbench/desktop/RuyiDesktop.cs`](../ruyi-workbench/desktop/RuyiDesktop.cs)
- [`ruyi-workbench/app/public/js/quiet-card.js`](../ruyi-workbench/app/public/js/quiet-card.js)
- [`ruyi-workbench/app/public/js/notify-policy.js`](../ruyi-workbench/app/public/js/notify-policy.js)
- [`ruyi-workbench/app/public/js/composer-voice.js`](../ruyi-workbench/app/public/js/composer-voice.js)
- [`ruyi-workbench/app/public/js/app-frame.js`](../ruyi-workbench/app/public/js/app-frame.js)
- [`ruyi-workbench/app/public/js/onboarding-wizard.js`](../ruyi-workbench/app/public/js/onboarding-wizard.js)
- [`ruyi-workbench/app/src/04-desktop-shell.js`](../ruyi-workbench/app/src/04-desktop-shell.js)
- [`ruyi-workbench/app/src/13-http-router.js`](../ruyi-workbench/app/src/13-http-router.js)

## 工作包与推荐顺序

同阶段工作包按下表顺序推进；已冻结接口下可分工，但共享源文件的改动需串行集成。

| ID | 工作包 | 人日 | 具体交付 |
|---|---|---:|---|
| P4-01 | App 宿主与服务管理 | 3–5 | 新增拟议 desktop-macos 宿主；窗口/WebView、单实例、Node 启动/健康、错误页面、窗口状态；按 P0 结论选一种技术栈。 |
| P4-02 | 受控系统桥与交互 | 2–3 | 原生文件选择器、Finder/编辑器、菜单栏、通知、Cmd 快捷键与安全的 URL 打开；验证页面来源/消息 schema。 |
| P4-03 | 麦克风与媒体兼容 | 2–3 | 按 WebView 实际能力选择录音格式或 PCM；测试授权、拒绝、重试、语音流式路径和资源释放，保留 ASR 协议与词库。 |
| P4-04 | 生命周期与签名身份复验 | 3–5 | 关闭窗口/退出/登录启动的明确设置；睡眠唤醒、调度恢复、MCP/CLI 回收；用拟发行身份验证 Keychain/TCC，提前准备签名。 |

## 阶段验收

- [ ] V07/V10 通过；Finder 启动和终端启动找到同一套受控运行依赖。
- [ ] 关闭窗口与退出应用行为明确；退出后自有服务回收；不默认开登录启动。
- [ ] 页面依旧支持普通浏览器；远程导航不能获取宿主执行桥。
- [ ] 通知/录音拒绝授权可恢复，App 升级身份不会意外造成密钥不可读。

- [ ] 相关 Windows 回归、构建新鲜度与代码契约通过；独立复核发现均有处理记录。

- [ ] TASKS.json 与执行看板已登记真实状态、提交 SHA、日志、已知限制。

## 回退与失败处理

保留浏览器入口作为可用回退。宿主缓存与业务数据分离；回滚 App 不重置 Keychain 或会话数据，不自动恢复旧登录项。

## 交接要求

提交修改文件清单、平台接口/配置差异、已执行命令与结果、未验证环境、下一阶段需要消费的接口。对估算外新增需求单列工作包，不从其他阶段验收项中扣除。通用模板见 [执行与交接看板](10-TRACKING.md)，测试编号见 [验收矩阵](08-VALIDATION.md)。

## P1交接（2026-11-03）

P4-02/V10承接Finder实际窗口与选中对象的可见实机验收。P1已验证打开协议、鉴权、路径及受控启动布局；当前Finder自动化非交互预检为-1744，待本阶段取得相应权限后执行可见验收。证据见 [P1收尾记录](evidence/P1/closeout/README.md)。
