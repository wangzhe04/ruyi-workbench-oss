# P6：离线打包与发行

状态：进行中（2026-11-12，P6-01 已完成当前 Mac 候选实现与验证，P6-02 待开始） · 前置：P5 按已验 Mac 范围交付 · 基础工作量：**8–14 人日**。估算包含本阶段实现、相关测试、修复、文档与独立复核响应；共用风险容量只在总估算另加一次。

## 目标

把已验证的功能变成可安装、可升级、可回退且可解释限制的 Mac 正式发行物。打包探针应从 P0/P3 起提前开展。

## 入口条件

前置阶段已验收或明确仅开展不依赖其结果的探针；读取架构约定和当前基线。开始时核对源码变化，复用现有函数和测试，不根据旧行号盲改。

## 涉及文件与调用链

- [`ruyi-workbench/package.json`](../ruyi-workbench/package.json)
- [`ruyi-workbench/tools/package-offline.ps1`](../ruyi-workbench/tools/package-offline.ps1)
- [`ruyi-workbench/tools/Manage-Overlay.ps1`](../ruyi-workbench/tools/Manage-Overlay.ps1)
- [`ruyi-workbench/app/src/13c-overlay-routes.js`](../ruyi-workbench/app/src/13c-overlay-routes.js)
- [`ruyi-workbench/app/src/13u-migration-center.js`](../ruyi-workbench/app/src/13u-migration-center.js)
- [`ruyi-workbench/resources/offline-manifest.json`](../ruyi-workbench/resources/offline-manifest.json)
- [`mcp/ai-computer-control/installer`](../mcp/ai-computer-control/installer)
- [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)
- [`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml)

## 工作包与推荐顺序

同阶段工作包按下表顺序推进；已冻结接口下可分工，但共享源文件的改动需串行集成。

| ID | 工作包 | 人日 | 具体交付 |
|---|---|---:|---|
| P6-01 | arm64 离线依赖与包布局 | 2–4 | 打包 Node/Python/rg/必要 wheels 与浏览器；区分各发行变体承诺能力、许可、hash 校验和版本锁；不打入官方 Agent CLI。 |
| P6-02 | 签名、公证与安装 | 2–3 | 递归处理 App/helper/原生依赖签名、hardened runtime 与必要 entitlement；公证与票据附加；干净标准用户安装/首次运行验证。 |
| P6-03 | 更新、回退与数据迁移 | 2–3 | 首发支持整包替换升级和保留旧包的回退；Mac Trash 语义、路径映射、旧配置与凭据恢复文档；旧 Windows overlay 明确不可用。 |
| P6-04 | 最终回归与交付文档 | 2–4 | 全量适用回归和受控真机验收；更新中英文用户/管理/离线部署说明及兼容清单；记录候选 SHA、版本、hash、测试和独立复核。 |

## 阶段验收

P6-01 的可复现构建、包布局、Full/Slim 能力及当前验证边界见 [Mac 离线候选包说明](../ruyi-workbench/desktop-macos/OFFLINE-PACKAGING.md)。开发签名候选不等于 P6-02 正式签名、公证与干净安装完成。

- [ ] V13/V14 及其他适用验收无阻断缺陷；没有未说明的 skip 或伪装可用的 Windows 功能。
- [ ] 断网安装时无需临时下载；本地/内网模型可工作，真云 API 的网络需求仍准确说明。
- [ ] 签名/公证与分发来源首次启动真实验证；更新失败可保留旧版本和用户数据。
- [ ] 正式版交付物、能力清单、已知限制、升级/回退说明对应同一版本。

- [ ] 相关 Windows 回归、构建新鲜度与代码契约通过；独立复核发现均有处理记录。

- [ ] TASKS.json 与执行看板已登记真实状态、提交 SHA、日志、已知限制。

## 回退与失败处理

升级先备份业务数据并验证 schema 回退策略；不能单靠换旧 App 处理不可逆数据迁移。公证/凭据未就绪时保留候选包与证据，不标记正式发行完成。

## 交接要求

提交修改文件清单、平台接口/配置差异、已执行命令与结果、未验证环境、下一阶段需要消费的接口。对估算外新增需求单列工作包，不从其他阶段验收项中扣除。通用模板见 [执行与交接看板](10-TRACKING.md)，测试编号见 [验收矩阵](08-VALIDATION.md)。
