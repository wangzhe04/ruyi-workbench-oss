# P1 收尾与交接

2026-11-03，P1 运行时与系统边界实现阶段完成，P1-01 至 P1-04 均登记 done。实现交付提交为 `a8374a243679a673e2e3363f4c9bb4037ff291a9`，分支为 `codex/p1-macos-runtime`。

## 收尾依据

用户明确要求“不需要Windows回归，收尾P1”，本次 P1 的 Windows 实机回归门槛据此取消。Windows 实机状态仍为未验证，现有 Windows 分支和参数契约继续保留。

Finder 打开协议、参数边界、鉴权、路径与完成状态，以及受控布局启动已由 P1 自动化验证。Finder 实际窗口、选中对象和桌面宿主体验按原验收矩阵 V10 交接 P4-02，权限预检 -1744 的记录随交接保留。

| 验收项 | 交付与证据 |
|---|---|
| P1-01 启动与依赖 | 内核锁、socket恢复、clean PATH、Node/Python/rg探针、真实Node/helper重定位启动及缺失恢复，见 controlled-layout、ownership、opener-completion |
| P1-02 文件与路径 | 系统/托管路径、别名、真实大小写敏感APFS卷、只读目录、写链、取消、原子回退、部分写快照及清理结果，见 files、atomic-write-cancellation、file-mutation-recovery、temporary-cleanup |
| P1-03 shell | 默认bash、显式语言、私有协议、非TTY常驻会话、输出预算、超时与停止，见 shell、frozen-mac-regression |
| P1-04 进程 | 统一owner/句柄、身份校验、双层监督、真实主回合Stop贯通、执行入口清册，见 supervisor、process-integration、provider-stop、execution-entry-audit.md |
| V02/V03/V04相关回归 | 29件相关专项、818条断言通过；完整单元2491通过、18跳过、0失败；静态80组及语法1120文件通过 |
| 产物与独立复核 | 构建新鲜度、差异检查通过。207项产品指纹一致，其中206个已跟踪文件与实现交付提交一致，另有本地helper。独立收尾复核见 review.json |

## 已知限制与交接

- 媒体语法超时曾单次失败，根因未确认。随后五次完整媒体专项和八次独立超时实验通过，保留原失败与诊断，后续回归再次出现时继续取证。
- Finder 可见实机验收交接 P4-02/V10，当前尚未通过该项验收。
- macOS 14 实机与完整离线包、干净标准用户机器按 P3/P6 关口验证。当前环境为 macOS 27.0.1 arm64、Node 24.15.0。
- 仓库557件默认e2e尚未全部在Mac执行，本次通过的是P1相关集合与完整单元/静态门禁。
- 进程逃逸覆盖为 observed-only，保留单helper故障模型、未知socket拒绝接管及非TTY边界。

P2可按既有前置关系开始。源码行为、测试日志与历史批次记录完整保留，本页作为当前阶段状态入口。
