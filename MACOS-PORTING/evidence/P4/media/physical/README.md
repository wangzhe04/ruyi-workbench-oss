# P4 真实麦克风验收进度

2026-11-08，基线 `d97db57b` 上的未提交工作树。用户已授权真实通知权限与最长三秒的本机短录音，音频仅保存在隔离目录，ASR 为环回假端点。

## 实际执行结果

CUA 在正常 composer 入口拒绝 WebKit 本机来源的麦克风提示，页面返回 NotAllowedError 与本地化恢复指引。再次点击原按钮重新出现授权提示，允许后完成录制、WAV 上传和假转写回填，发送计数为零。

录音文件经主代理和独立复核者解析均为 1.01 秒、16000 Hz、单声道、16-bit PCM，哈希与上传清单一致。原音频留在隔离测试目录，仓库仅保存元数据和日志。[独立解析记录](sample-inspection.json) [执行报告](native-first-report.json) [上传元数据](native-first-uploads.json)

严格探针退出码为 1。页面记录轨道在 1009 ms 结束，WKWebView 原生采集状态在 3000.271 ms 后才变为 none，并触发了两秒保护。该轮仅能确认两种状态读数不同步，原因仍待定位。原生结束边界继续登记失败。[判定](validation.json) [原结果](native-first.txt)

该轮使用开发 App 的直接可执行入口，开发 App 自身的系统麦克风授权归属需另用 LaunchServices 验证。旧失败候选未在重建前保存六项原生构建指纹，现有证据包含实际 monitor 脚本和运行记录。[当轮页面脚本](native-first-monitor.js.txt)

## 新候选待复验

验收专用原生观察器现在在页面轨道结束后调用 WebKit 停止麦克风接口，同时保留独立两秒兜底和三秒通过上限，记录正常清理请求、完成及 KVO none 的时间。物理探针改用 LaunchServices，显式传入隔离环境，并在启动前核对及保存源码与原生构建指纹。App/Node 按已记录的创建身份回收和核验，缺少身份记录时登记未验证。

新候选已通过LaunchServices启动并由CUA点击正常语音按钮，getUserMedia停在requesting，原生仍为none且没有上传。系统提示App的CUA访问被规则拒绝，已请求用户手动查看并处理提示。本轮尚未开始物理采集。宿主、合成媒体和生命周期独立回归另行记录。[新候选指纹](next-candidate-source-fingerprint.json) [原生构建](next-candidate-native-build.json)

## 保留的夹具失败

初轮监控通信被页面 CSP 拦住，采集未开始。随后采集前启动的进程外时限在授权等待时触发，上传数为零。改用原生采集状态计时后发现 KVO initial 事件未记录，修正回调读取方式并确认 none 事件已落盘才执行真实录音。源码变动期间的一次构建被一致性保护拒绝，冻结后重建通过，原日志保留。[CSP](csp-first.txt) [授权等待](permission-deadline-first.txt) [初始观察](observer-empty-initial.json) [构建拒绝](build-fourth.txt) [冻结构建](build-final.txt)

## LaunchServices授权等待快照

正常语音按钮已点击，页面请求仍等待，原生采集状态none、上传清单为空。系统设置麦克风列表尚无如意条目，工具访问系统提示App被规则拒绝。已请用户查看屏幕并处理如意或127.0.0.1的麦克风提示；探针继续保留，未判通过或失败。[等待快照](launchservices-pending/observation.json) [原生报告](launchservices-pending/report.json)

## LaunchServices首次结果与测量修正

用户手动允许系统提示后，真实请求返回，页面在591ms记录音轨结束，原生正常停止回调约657ms完成，回填成功且发送0。上传仅5字节WebM片段，未证明含有效音频，严格退出1。App和Node已按创建身份跟踪并完成回收。[本轮失败与清理](launchservices-first/validation.json)

独立复核公开WebKit机制确认reported采集状态有默认3秒显示下限。改进候选使用公开停止完成回调判定实际停止，继续保留两秒原生独立保护、三秒采集上限及最终reported none。新增实际PCM格式/长度/帧数和非零信号校验。原失败继续保留。新候选重新构建，待回归及解锁后物理复验。[候选口径与源码绑定](reporting-delay/README.md)

## 当前候选通过

最新LaunchServices物理探针自然退出0，647.5ms有效非零PCM、tracks1110ms、同run原生停止1417.118ms、无deadline、最终none、回填零发送及进程清理经独立核验。TCC记录明确归属开发App并允许。上文授权等待及失败段落对应历史轮次，完整原日志保留。[最终结果](reporting-delay/README.md) [独立复核](reporting-delay/review.json)
