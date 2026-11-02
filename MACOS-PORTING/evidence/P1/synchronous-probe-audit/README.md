# P1 同步探针原生监督基础

2026-11-03，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，工作树未提交，P1 保持进行中。

## 发现与实现

实测现有 v2 supervisor 可以由 spawnSync 通过 FD3 额外管道取得完整 started、cleanup、exit、guardian-cleanup 帧。原始记录见 socket-experiment.txt。这提供了保留同步 API 的实现路径。

原生 helper 新增可选 --supervise-v2-deadline 毫秒 命令 参数入口，capabilities 显式报告 deadline 支持。primary 在已有观察循环中检查 monotonic 截止时间，达到预算时发 deadline 帧并执行原有清理。guardian 给 primary 1500ms 清理宽限后执行兜底，以覆盖 primary 停止或握手阻塞。旧入口传入零预算，沿用原有生命周期。

清理仍采用已有身份核验、冻结、回收与退出确认机制。缺少 primary 报告时，即使 guardian 已停止目标，调用方仍须保留协议不完整状态。截止检查和清理存在调度与处理开销，后续 JS 层还需安全预算及严格帧校验。

## 验证范围

专项 18 项覆盖能力报告、同步 stdout/stderr/退出码、正常结束无 deadline、原生预算内停止及两层确认、deadline 帧顺序、Node 阻塞期间 detached 后代停止、进程退出、自然信号、primary 被 SIGSTOP/SIGKILL 后 guardian 回收及不完整报告、零预算、非法参数拒绝、exec 失败 errno 与清理。

本批原生 helper 已重新构建。实现者最终两轮各 18 项通过，独立复核另跑 Sync 18 项、Runtime 62 项、Cleanup 37 项通过。完整单测 2509 项，2491 通过、0 失败、18 跳过；80 项静态检查通过。语法检查 1112 文件、0 失败，构建与 diff 检查通过。详情见 review.json、summary.json 和日志。

## 下一步与限制

后续状态更新：产品同步入口接入已完成，见 [同步探针接入](../synchronous-probes/README.md)。下段保留原生基础批次当时的验证边界。

**产品同步探针尚未接入这个新入口。** 下一步在 ProcessRuntime 提供同步探针适配，复用严格协议校验，再替换 CLI/rg/Python 的冷缓存同步执行，保持各调用方返回语义与候选失败传播。不能据本批测试宣称同步探针迁移已完成。

共享探针取消、JS worker 取消、实际 FFmpeg、剩余路径与生命周期、干净依赖布局、Windows、macOS 14、同 SHA 与实际 Finder 验收仍待完成。逃逸覆盖保持 observed-only。
