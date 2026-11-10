# P5-05 组合观察与执行后验证切片

2026-11-10，当前主机 macOS 27.0.1 arm64、Python 3.12.10、Node 24.15.0。本切片接入 `observe`、`act_and_verify`、`batch_actions`、`macro_run` 及宏内异步 `wait`，当前主机独立验收及最终工程门已通过，实施提交绑定进行中。P5-05 的原生输入录制继续后续实施。

## 组合观察

`observe` 的截图与 OCR 共享一个原生捕获帧。返回截图的 origin、scale、scale_y 依据实际输出尺寸和逻辑范围计算，OCR 与 AX 坐标均为全局逻辑点。最多返回 200 个 OCR 词和 80 个有界 AX 节点，完整计数及截断状态单独列出。AX 观察发生于独立查询，返回 observation_age_ms 说明捕获年龄。

完整 target 要求该窗口当前活动。window_title 使用唯一窗口选择，截图后核对 handle、PID、过程出生身份、几何和私有 target。被覆盖窗口可通过独立窗口捕获观察。明确指定窗口的歧义或失效返回错误。

`include_screenshot=False` 省略编码图像。缺少可选 OCR 后端时跳过相关捕获，OCR 单独捕获失败可返回 AX 信息和 degraded/backend_errors。只启用 observe 工具组时，内部使用的纯 OCR 后端参与工作，直接 OCR、截图和键鼠工具保持按工具组注册。完整只读观察期限为八十秒。

## 动作与像素验证

`act_and_verify` 要求完整 target，支持 click、type、key。派发前检查窗口身份、几何、焦点和原捕获十秒年龄。点击处的像素及三像素边距重新捕获比较，随后由原生输入守卫核对实际窗口命中。验证区域可指定逻辑点 ROI，changed_ratio_full 的范围明确为当前目标窗口。

effect_observed 表示 ROI 至少八个原生像素发生变化，confirmed 为 null。验证失败及超时保留已派发的 action_result，后续通过 AX/OCR 读取应用状态。零 settle_ms 预算也根据实际 after 帧统计变化。证据图按请求或无变化路径写入内部 shots 目录，并修剪为四十份。

耗时观察位于后台线程，原生输入位于取消检查后的调用路径。观察 task 使用 shield，取消后门锁保留到实际工作结束。整体动作验证期限四十五秒，超时后仍在结束的后台工作只做观察或已授权的内部证据保存。

## 宏与图片通道

宏沿用真实 FastMCP 工具注册表进行逐步派发，默认遇错停止。工具自身的 target 和权限守卫逐步执行。Mac 的 wait 使用可取消的异步等待，单次最多三百秒。

批量图片提升从真正包含图像的容器取得元数据，包括嵌套 observe.screenshot。顶层及 lifted_images 保留 origin、scale_y、logical_bounds、coordinate_space 和 source_pixel_scale。Windows 入口和共享视觉函数的兼容性由独立源码复核核对。

## 当前主执行

- 组合 E2E 十六项通过，包括真实点击、可见计数变化、零预算变化、无变化证据、宏内等待/观察/OCR 读回、图片坐标、缺 target 停止和焦点变化拒绝。[主执行](acceptance/main-live.txt)
- 真实 LaunchServices 如意 App 普通 HTTP 工具链十三项通过，包含共享截图/OCR、AX、像素变化验证和宏内 OCR 计数读回。[App 主执行](acceptance/main-app.txt)
- 新组合合约测试当前十六项，涵盖取消、超时、后续观察失败、可选后端降级、注册隔离、双轴映射、宏等待及图片提升。其余六组 Mac Python 回归继续复用。

## 开发失败与修正

第一轮真实宏已完成点击、观察和文字查询，接收端计数正确，但 Vision 将界面 `COUNTS 1 1 0` 的数字空格融合为 `110`，精确 OCR 读回断言失败。夹具改用等宽字体与三空格分隔，原精确查询继续通过。首次失败结果保留。[原结果](development/first-live/results.json) [修正后结果](development/spaced-counter/results.json)

独立源码复核发现共享等待函数在零预算时固定返回 changed=false。Mac 结果现同时依据最终 ROI 像素差判断，纯测试走真实 after/poll 函数链，真实桌面也增加零预算点击断言。Windows 共享函数原语义继续由其入口消费。

## 范围与后续

默认 helper 使用已验 P5-04 产物 `d46352387964c9a1ef95cc766bd26af92c7a5c1df0a22283c9204e0a48b656c9`。本切片的捕获、AX 和输入调用复用该原生后端，开发过程已通过真实如意 App 身份。

原生输入录制、真实撤权与动作中锁屏、物理多屏/非 Retina、输入法、实际 macOS 14、正式签名与同候选 Windows 执行继续保留。P5 与 P5-05 保持进行中。

## 当前主机独立验收

十七条测试命令各执行一次，十组 Node 真实 E2E 共 244 项、七组 Python 共 103 项通过，零失败、零跳过、零自动重跑。88 份源码文档与 3 份运行产物每件前后及最终一致。四组真实 App 记录的 42、40、23、25 个创建身份均退出，额外受控路径残留为空，测试前剪贴板恢复断言通过。[独立报告](independent/report.json)

工程四门通过，语法 1148 文件、构建新鲜度、完整单元 2499 通过和 18 项既有跳过、静态 80/80、零 flaky、测试浏览器残留零。各门前后完整 91 项指纹一致。验收后收口 TASKS、阶段文档及跟踪记录三份文档，功能与测试源码沿用独立候选。[工程记录](acceptance/engineering/results.json) [最终交付指纹](source-fingerprint-final-delivery.json)

独立源码复核已关闭零预算变化误报，迁移函数与 Windows 入口的 AST 比对通过。默认 helper 与如意 App 的严格签名验证通过，二进制字节沿用已验版本。[代码复核](code-review.json)
