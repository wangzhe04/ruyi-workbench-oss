# P2 最终验收（排除用户明确暂缓项）

2026-11-06。用户要求：“除了暂缓部分，整体验收P2”。本次逐项验收四个工作包；只排除真实账号服务、登录Keychain实际交互、Windows同候选三类既有暂缓项，均继续记未验收。正式签名/升级ACL、真实睡眠唤醒、最低系统与离线发行按原P3/P4/P6交接，不扩大或改变P2范围。

验收候选 `287d2d2196e50bff49e47b6fe92e299a93565351`。最终串行回归结果见 [validation.json](validation.json)，需求与暂缓映射见 [acceptance.json](acceptance.json)。最终结果：完整单元2490通过/18跳过，80静态通过，31组相关e2e全部通过；P2及四个工作包按用户指定范围登记done。

已核对7批实现与独立评审，68个最新交付文件，加2份本次刷新生成清册，共70个文件与候选逐项一致，见 [source-audit.json](source-audit.json)与[source-fingerprint.json](source-fingerprint.json)。两家官方CLI的真实工具、权限、active prompt停止与原生恢复使用既有本地确定性模型证据；本次不为重复相同证据重新安装第三方CLI。

首轮完整单元2490通过/18skip，静态79/80通过；route-inventory因Claude新探针引用未刷新而失败。已使用原生成器更新bootstrap/stop/session三条现有端点的coveredBy引用，175路由、161鉴权及原未覆盖项未变，无运行时行为改变。记录保留为 validation-first.json / fast-gates-first.txt；修复后的候选完整重跑，不把首轮写作全绿。

最终验证复用现有31组相关e2e；没有新增测试。run-all --fast内含完整单元，另有7个live入口按该模式跳过，未计通过；单元18项既有跳过及条件见unit.txt。所有服务、假端点、原生helper和凭据夹具按既有隔离策略运行，不使用真实账号，不将skip记为通过。详细暂缓步骤仍见 [外部验收交接](../acceptance/HANDOFF.md)。

第二轮完整门禁通过后，机器人控制用例暴露夹具重启读取旧runtime token的竞态，明确返回auth.token_invalid/403。原fault preload对后续runtime rename延迟200ms可稳定复现；等待条件加入当前server.pid后通过，readItem保留明确HTTP错误且不吞错。该文件语法/直接静态契约及失败e2e重验，补齐余下3组e2e；生产树未变，已通过完整单元及其他e2e复用。原失败见 validation-second.json、external-bots-control-first.txt、external-bots-control-red.txt。没有将失败归入暂缓项或改成skip。

暂缓项仍未验收；正式签名/升级ACL等既定交接未被记为通过。这是本次约定范围的P2完成，不等同所有真实环境或正式发行验收完成。
