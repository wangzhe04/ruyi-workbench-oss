# P1 验收缺口审计

2026-11-03，独立复核者 `/root/ownership_review`。对照 02-P1-RUNTIME、08-VALIDATION、11-P0-DECISIONS、TASKS 和各批证据逐包核对。此记录用于更新阶段待办，P1 继续进行中。

| 工作包 | 已有专项证据覆盖 | 当前未闭合项 |
|---|---|---|
| P1-01 | 集中平台层、启动器、干净 PATH、Node/Python/rg 探针、内核锁与有证据 socket 恢复、宿主 open 完成语义 | Finder 实际窗口/选中对象、最终版本 Windows 回归 |
| P1-02 | 系统/托管路径、Data alias、符号链接、真实大小写敏感 APFS、Unicode、只读目录、写链、原子写取消及部分失败快照、copy/move 提交取消与失败恢复、临时清理失败结果 | 最终交付版本文件交叉回归 |
| P1-03 | bash 默认/显式语言、非登录环境、非 TTY 常驻会话、私有 FD 协议、超时/取消、输出预算及归属 | Windows 真 PowerShell 回归、冻结版本 V04 汇总 |
| P1-04 | CLI/MCP/shell/toolbox/Git/文档/媒体/搜索与探针监督、guardian 单故障恢复、句柄身份、worker 收尾、能力发现与界面 | 冻结版本执行入口指纹及 V03 汇总、Windows 进程回归、阶段最终独立复核 |

## 已关闭的旧待办

启动和宿主打开的独立复核、helper 版本及失效能力门、常驻 shell/Git owner、CLI/MCP 发现和能力弹层、共享 rg 探针、内容及路径 worker 取消、同步及 Python 探针均有后续实现和复核记录。TASKS 已据此更新。历史批次 README 保留当时状态，当前待办以阶段清单为准。

## 冻结边界

observed-only、单 helper 故障模型、未知归属 socket 拒绝接管符合冻结契约。后续验收仍须准确记录这些限制。最低 macOS 14 尚未实机验证，既定关口归 P3/P6。Keychain、完整 AppKit 宿主、AX/OCR、正式离线依赖包和真实 CLI 登录回合分别在后续阶段验收。

## 阶段证据要求

各批专项通过不能证明全部默认 e2e 通过。当前 deliveryCommit 仍为空，本地实现候选提交为 `a8374a243679a673e2e3363f4c9bb4037ff291a9`，冻结Mac回归的产品源码已与该提交核对一致。Windows 同版本证据仍待补齐。win32 参数夹具不能代替 Windows 运行结果。

Finder 权限预检为 -1744。此前夹具意外发出的临时目录定位请求没有窗口/选中状态证据，不能计为验收。系统授权请求尚待用户答复。

当前入口分类已按源码归档 execution-entry-audit.md 并经独立复核。临时清理失败结果已由 temporary-cleanup 批完成；最终交付版本回归持续待办。

受控启动布局已由 controlled-layout 批验证真实重定位 Node/helper、独立家目录及缺失恢复。完整离线包和干净机器继续在 P3/P6 验收。

最终冻结源码相关回归为 29 件、818 条断言通过，完整单元与80组静态通过。真实主回合Stop贯通缺口已修复。媒体语法超时曾单项失败，两次完整媒体复跑及8次独立实验未重现，根因尚未确认，详见 frozen-mac-regression。

候选提交后重新执行 Finder 非交互权限预检，仍为 -1744，未请求系统弹窗。Windows远端候选分支/PR操作授权也仍待用户答复。
