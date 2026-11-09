# P1-03 Mac 一次性与常驻 shell

2026-11-02，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，交付尚未提交。P1-03 与 P1-04 保持进行中。

## 产品行为

- 新增 exec 档 `shell_run`，Mac 默认 bash、Windows 默认 PowerShell，可显式选择语言。`script_run` 在 Mac 默认 bash，已有显式 PowerShell/Python/Node 参数继续解析。bash 名称纠错指向平台 shell 工具。工具发现、命令开关、不可逆账、超时中断、元数据与模型提示已同步。
- bash 固定使用 `/bin/bash --noprofile --norc`，启动环境移除 `BASH_*`、ENV、SHELLOPTS、BASHOPTS、CDPATH、GLOBIGNORE、PROMPT_COMMAND、PS4。一次性和有限后台命令写入私有临时脚本，支持超出 argv 上限的源码，结束后清理。缺少原生监督器时，新 bash 入口在执行前返回依赖错误。
- `shell_start` 无 command 时建立非 TTY 常驻会话，保留变量、export 和 cwd。输入采用 NUL 分隔的命令协议，完成帧使用独立 FD4。eval 临时关闭 FD4 并给命令关闭的 stdin，普通输出与完成状态分离。监督器继续在目标 exec 前关闭 FD3，并在自身关闭 FD4。
- `shell_send` 在 Mac 返回 completed/timeout/exit、commandExitCode、commandRunning 和真实 cwd。非零命令会失败，但 shell 可继续使用。长命令超出等待时间后保持 pending，拒绝重叠输入，后续通过 shell_poll 获取状态。命令上限 1MiB UTF-8，NUL 输入拒绝。
- UTF-8 跨块解码即时输出，保留已有环形缓冲、游标分页和头尾输出预算。私有完成帧释放 pending 前先让已就绪的 stdout/stderr 回调排空。
- 后台启动在异步脚本创建前登记容量 reservation，启动期间取消可阻止 spawn。会话归属同时识别 sessionId 和 session.id。显式中断、shell_kill 与服务退出走监督停止，清理未确认会保留失败信息和重试归属。
- Windows 命令构造及 PowerShell 编码分支有原假件回归。选择了 PowerShell 的旧测试现在显式传入 language，原断言保留。历史工具表里的 PowerShell 名字按原顺序恢复，Mac 默认起手工具追加平台 shell。

## 验证

- 新 shell E2E 两轮各 32 项通过，见 [第一轮](e2e-1.txt)和[第二轮](e2e-2.txt)。覆盖启动环境注入、工作区 execute=false、命令开关、显式语言、长脚本、空格/emoji/星号/换行 cwd、跨块 UTF-8、无换行输出、stdout 伪造帧、FD4 关闭、stdin EOF、跨会话拒绝、pending/超时、容量竞争、启动取消、显式中断及后台子孙清理。
- 进程 runtime 回归 34/34，清理回归 33/33，见 `process-regression.txt` 与 `cleanup-regression.txt`。独立 reviewer 在最终源码上验证 shell 31/31 与两件进程回归通过。随后在同一生产源码上增加 200KB 常驻命令输入断言，两轮各 32/32 通过。
- 专项回归 42 项，41 通过、0 失败、1 平台跳过，见 [专项日志](unit-regression.txt)。新增保存旧工具表顺序的回归。
- 最终全量单测 2509 项，2491 通过、0 失败、18 跳过，见 [日志](unit-final.txt)。静态检查 80/80，残留测试浏览器 0，见 [快速检查](fast-final.txt)。
- 语法检查 1100 文件、0 失败。构建及依赖契约通过。schema 字符预算保持原上限，稳定提示词 1894 字符，小于原 1900 上限。
- 独立复核发现与处理记录见 [review.json](review.json)，环境、哈希和汇总见 [summary.json](summary.json)。`fast.txt`、`unit-targeted*.txt` 保留首次平台假件/清册与预算失败记录，后续已修复并重验。

## 剩余验收

Windows 真 PowerShell 与 macOS 14 尚未实测。helper 的统一能力快照、版本可用性与中途失效组合验收继续待办。逃逸覆盖仍为 `observed-only`，尚不能把已观察身份的完成外推到所有未观察后代。

完整 P1 还包含 P1-02 系统与文件路径边界，以及 P1-01 剩余启动和实际 Finder 验收。
