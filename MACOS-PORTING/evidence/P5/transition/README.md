# 真实窗口移动期间的捕获拒绝

测试实现 `1b03da0433cfff6a715af822f36a1c89b33b219a` 已提交。冻结 v3 独立 **18 项通过**，0 fail/skip/retry；8 次实际移动捕获全部正常返回 `window_changed`，没有图像。该切片新增测试窗口、回归与清册，产品运行时未变，P5 保持 `in_progress`。[独立报告](independent-v1/report.json) · [提交绑定](commit-binding.json) · [独立绑定](independent-commit-binding.json)。

自有 Cocoa 四色窗口在当前屏幕可见区域做单调水平平移，公开 WindowServer API 每次读取并记录其实际 PID/window ID/几何。原生生产 helper 使用默认 raw `1cc945…`，没有注入 fake capture。独立验收按固定数值 `[x,y,width,height]`、同一 owned PID/ID 重算请求待响应区间的位置见证，8 次分别为 18/12/9/9/14/18/11/8 个不同实际位置；每个拒绝均为自然 exit 1、signal null、无 PNG。[逐请求见证](independent-v1/motion-witnesses.json)。见证区间覆盖实际 helper 请求；`window_changed` 源码又明确执行捕获前后几何检查，因此不把只有外层计时当作原生捕获中变化的唯一证明。

移动前后都实际捕获成功，分别核对 exact owned CG bounds、窗口独立报告的 backingScale 2、PNG 1280×896 与 640×448 逻辑 bounds，以及四个内容色点。原始 helper 没有 Python 包装层的 scale/scale_y，测试未假定其存在。独立验收用 Python 标准库另行校验 PNG CRC/zlib/filter 并解码八个样点，没有仅重复夹具的 PNG 解码器。[独立像素核验](independent-v1/independent-png-checks.json)。

本次主执行与独立执行各一次、各18项；两次的8个移动请求全部拒绝，**未覆盖移动中成功帧**。测试允许合法成功分支时额外验证物理尺寸、颜色、身份和实际运动范围，但不能由未执行的分支声称瞬时 origin 精度。本次也没有窗口 resize、物理显示器切换/重排、混合缩放或负坐标拓扑、键鼠/剪贴板/TCC/锁屏、Workbench provider/App 启动或 Windows 运行验收。

源码审查的 T1–T4 均在首次实际运行前闭合：出生身份观测失败不能用空集合证明退出；位置按有限数值 tuple 而非 JSON key 顺序去重；拒绝必须正常 exit1/signal null；像素比例由独立 NSWindow backingScale 提供。v1/v2/v3 候选修改不被写作已运行测试或产品缺陷。[源码审查](code-review-v1.json)。

完整工程四门通过：语法1155、构建新鲜度、单元2499/18既有跳过、静态80/80、7项集中实弹跳过，0flaky。统一快通道会再次执行单元前置。12来源与生产 capture helper/工作树 process helper 两份产物在工程各门前后8次一致；独立四次检查及签名前后保持，完整工程按hash复用，没有再跑unit/fast。[工程记录](development/engineering-v1/results.json)。

夹具仅操作自有窗口，不注入键鼠、不读取用户文件或剪贴板，不变更系统显示/锁屏设置。12个夹具内已观察 root 及14个外层采样出生身份均已退出，无强制清理、无保留根。采样不等同覆盖所有瞬时系统进程。两张归档 PNG 只含该自有四色窗口，不是桌面全屏。

原12小时保持唤醒进程在本次继续时已不存在，已按用户此前“不自动锁屏”要求恢复新的12小时断言，PID31171；屏保idleTime仍为0。这不是实际锁屏/恢复验收。[保持唤醒状态](wake-state.json)。
