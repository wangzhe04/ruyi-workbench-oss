# 正常入口真实编辑器差异验收

2026-11-08，基线 `d97db57b` 上未提交工作树。通过隔离开发App中的“打开验收差异”按钮调用正常 `/api/checkpoints/open-external`，返回 `ok=true`、`mode=diff`、`failed=[]`。CUA真实Code截图显示双栏，左红 `answer = 41`、右绿 `answer = 42`，AX中的两份文件路径对应本轮夹具。独立复核者也查看了截图与AX。[截图](visible-diff.png) [AX](visible-diff-ax.txt) [夹具](fixture.json) [App报告](report.json)

## 夹具修正与保留失败

旧fixture HOME下Code IPC socket长116字节，原生绑定返回EINVAL，短别名78字节可绑定。官方CLI短HOME诊断可以打开差异，最终使用新建短 `/tmp/ruyi-e2e-home-*` 隔离HOME及两个AppData位置，业务数据仍独立。该修正只涉及验收夹具。[IPC诊断](editor-unix-socket-diagnostic.json) [CLI诊断](editor-official-cli-diagnostic.json)

本轮最初将隔离Code辅助功能支持设为on后，CUA读取AX及截图连续超时，常规退出和SIGTERM未使实例退出，按夹具argv及创建身份核验后回收自有临时实例。改该隔离设置为off、重新从同一正常API入口打开后，AX和截图通过。该关联尚不足以确定Code超时根因。两栏设置保留，未改用户Code设置。[清理记录](code-timeout-cleanup.json) [有效设置](effective-code-settings.json) [夹具源码](host-ui-probe.cjs.txt)

最终临时Code正常退出，宿主quit文件触发正常退出，父探针退出码0，App654/Node659均已消失。正常用户Code已用原用户profile恢复，关闭自动出现的更新说明和Welcome页，CUA确认Editor Group 1为空。
