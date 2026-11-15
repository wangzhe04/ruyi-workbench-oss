# Chrome 原生采集阶段诊断

2026-11-08，锁屏期间，Chrome 156 headless、独立 HOME/浏览器 profile、环回静态页与假媒体设备。页面只调用原生 API，假设备输出用于诊断。

设备枚举返回 Fake Audio Input，浏览器麦克风权限为 `granted`。日志对同一请求记录了批准、打开设备、`STATE_DONE` 和 `OnStreamStarted`，页面 Promise 在五秒后仍未返回。[设备及请求](device-enumeration.json) [浏览器日志](device-enumeration-log.txt)

另一个新 profile 先关闭回声消除、降噪及自动增益，再使用 `audio=true`，两次原生请求各五秒仍等待。这个结果缩小了应用脚本和处理约束的排查范围，具体系统原因仍待进一步验证。[约束对比](constraints.json) [日志](constraints-log.txt)

原有分段、流式及预热回归的失败和未执行范围继续保留，后续在可操作桌面重新验证。

## 已安装 Chrome for Testing 对比

使用相同探针及相同隔离参数，Chrome for Testing 148.0.7778.96 的两种原生假音源请求分别约157 ms与15 ms成功返回live音轨并立即释放，此时CUA仍报告Mac锁屏。普通Chrome156的等待记录保留。版本与发行构建同时不同，具体差异原因仍未确定，后续用148完整重跑三组既有语音件。[148结果](cft148-constraints.json) [148日志](cft148-log.txt)

独立复核者在同一CFT148单次环境覆盖下，完整运行原有voice98项、stream39项、warmup58项，三件均0失败、自然退出码0，未修改断言或替换采集接口。先前未执行的后段也已运行。该结果对应148环境，普通Chrome156的失败与挂起继续保留。[结构化结果](browser-regression.json)
