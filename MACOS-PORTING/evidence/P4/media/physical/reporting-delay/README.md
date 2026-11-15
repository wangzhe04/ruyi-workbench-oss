# 原生停止完成与有效录音复验候选

2026-11-08，未提交工作树。此前两轮KVO报告采集状态持续约3秒，第二轮原生停止回调已在约657ms返回。公开WebKit源码明确其reported状态存在默认3秒显示下限，WKWebView getter读取reported状态；Apple公开文档规定setMicrophoneCaptureState完成回调在改变页面使用麦克风状态后执行。独立复核者核对了公开机制。已安装WebKit的精确源码提交未知，公开机制与重复观测一致。[公开语义与固定提交链接](../launchservices-first/reporting-semantics.json) [保留失败](../launchservices-first/validation.json)

验收专用观察器在同一run的原生停止回调完成后取消两秒保护计时。物理probe仅允许一次成功采集，授权被拒后可重试，避免reported状态未归零期间再次采集。正常结束约1.1秒，兜底释放1.3秒。判定同时要求页面音轨在3秒内结束、同代次正常原生停止完成在3秒内、无独立保护触发、有效非零16kHz单声道16bit PCM WAV时长不超过3秒、最终reported none与无未完成stop、转写回填且发送0、App与Node回收。KVO显示持续时间独立保留。

源码及原生构建指纹在本目录。生产composer和后端在此修正中未改。新候选已构建，静态独立复核通过，四原生回归及物理复验进行中。

## 独立自动化结果

媒体36、生命周期23、桥接47项通过，均自然退出0。宿主30通过/1失败，唯一失败为LaunchServices的service_start_timeout，TCC明确新ad-hoc候选与旧文稿访问code requirement不匹配并重新提示，App和Node已退出。该轮失败保留，等待用户解锁处理已授权的文稿访问后复跑。六项构建输入和strict签名验证通过。[宿主原失败](host-independent.txt) [该轮TCC](host-tcc-independent.txt) [媒体](media-independent.txt) [生命周期](lifecycle-independent.txt) [桥接](bridge-independent.txt)

## 最新成功结果

用户允许系统提示后，同一LaunchServices探针正常取得麦克风。真实WAV为20764字节、10360帧、16kHz单声道16bit PCM，时长647.5ms，有非零信号。JS音轨1110ms结束，同run原生停止完成1417.118ms，独立deadline未触发，最终reported none且无stop待完成。KVO报告持续3000.704ms，按公开显示下限机制单列。假ASR上传一次、回填成功、自动发送0。正常完成后App6799与Node6802均回收，探针自然退出0。原音频继续只留隔离目录。[最终报告](physical-final-report.json) [上传元数据](physical-final-uploads.json) [退出](physical-final.txt) [清理](physical-final-cleanup.json)

独立复核者重新解析RIFF及PCM，核对SHA、非零样本、录音时九项源码指纹、六原生输入及已退出进程。TCC独立日志确认本次请求责任主体为开发App，03:08:52授权authValue2。授权后同冻结App宿主独立复跑31通过/0失败、自然退出0，原30/1记录保留。[TCC](physical-tcc-independent.txt) [宿主恢复](host-after-permission-independent.txt)
