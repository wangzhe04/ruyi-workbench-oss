# 本轮回归对账

官方完整轮的594件、608总清册与14项live排除一一对应，无缺件。原始为588成功／6失败／1重试通过；32件内部SKIP逐行保存在[coverage](regression-coverage.json)。

| 原失败 | 后续结果 | 证据 |
|---|---|---|
| facts.static | README两种语言293→294，主执行及独立通过 | targeted-recheck、independent-closeout |
| macos-input-events | 路径规范化后实际观察到/private/tmp与/tmp相同身份；后续捕获真实SIGTERM分类竞态并修复，官方与独立通过 | native-official-attempts、independent-closeout |
| macos-observe | 冷OCR累计202.021s，原120s整件墙不足；保留单调用期限，300s整件墙官方通过50.669s | native-latency.json |
| macos-ocr | 冷调用累计166.525s；同上，官方通过14.415s | native-latency.json |
| macos-capture-host | App真实录屏denied；本人认证未提供，仍未通过 | app-failure-receipts |
| macos-input-host | App真实AX／event denied；无成功输入，仍未通过 | app-failure-receipts |

[合并结果](regression-composite.json)592进程成功／2未通过，不冒充最终应用候选594件整轮重跑。生产变化只在native events停止准入及错误分类；对应官方3件与独立input-events/input-apps通过，其他历史行保留其原冻结来源。8处清理caller另经主执行，独立代表性复验。

历史完整轮macos-input-apps首跑清理确认失败、runner重试通过，原始两attempt均保留；最终独立同件一次通过。内部SKIP不是功能通过；Windows专属、缺真实历史资料与显式Mac opt-in分别列在coverage。新Full/Slim包的实际安装、离线、Trash及升级回退是额外补充，不能让其他live／原环境门隐形消失。

Full普通第二copy的ENOSPC保留；Full15为明确APFS独立副本路径，Slim14仍普通复制。签名子系统首败与重试、原36件旧失败、开发诊断与取消竞态初败均保留，不回写历史为通过。
