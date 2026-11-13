# P4 真实系统恢复增量

2026-11-08，当前 macOS27 arm64 开发 App。用户已授权一次真实睡眠及临时登录项注册后注销。

## 本轮结果

实际执行一次 `pmset sleepnow`。powerd 记录 Software Sleep 进入 DarkWake，约2.816秒后由HID活动回到FullWake。原生报告 sleep/wake 各一次、wakeValidated为true，参数未模拟系统事件。App和Node创建身份、服务overlay均与睡前一致。独立复核者验证了这些记录和当前进程。[睡前](sleep-baseline.json) [恢复](sleep-wake-observed.json) [系统日志](powerd.txt) [验收范围](validation.json)

CUA确认页面醒后重新连接SSE并返回200，请求携带Last-Event-ID 2，收到presence.ack及新thread.created id3。通过真实API创建的“P4 唤醒后事件”自动出现在原页面，任务数由1变为2。[真实创建](post-wake-session.json) [界面记录](ui-observed.json)

原生菜单临时注册登录项后，系统“登录时打开”实际出现Ruyi。随后通过同一菜单取消注册，该行移除，原生最终登录状态为0。外链通过真实WKWebView链接交给默认Safari，显示验收页标题和文案；已关闭本次测试标签页。[界面步骤](ui-observed.json) [注销后报告](report.json)

## 范围

本轮覆盖短时Software Sleep/DarkWake恢复。长时挂起、深睡、该物理周期的真实调度补偿和精确睡前游标连续性仍未验证。生命周期23项另有真实后端暂停与恢复、调度late-run/skip和MCP/CLI子树回收证据。

## 菜单栏设置动作补验

界面工具无法呈现系统顶部状态项菜单。用户确认展开含“显示工作台”的菜单并点击“设置…”，随后CUA确认同一App打开设置面板，原生激活计数由5增至7。设置面板已关闭。此项为用户辅助菜单操作及工具核对结果。[动作前](status-menu-before.json) [动作后](status-menu-after.json)
