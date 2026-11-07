# P3 Mac 最终验收

2026-11-07，按用户“继续完成P3最终验收，只需要Mac端”的范围完成验收。P3-01至P3-04及当前主机上的组合工作链路均通过，P3登记为 `done`，完成范围为当前Mac开发环境。执行候选为 `6717378f`，新增组合验收探针提交为 `aa2d7846`。

环境为 macOS27.0.1 arm64、Node24.15.0、Python3.12.10、Playwright1.64.1、Chromium156.0.8078.4。Windows按用户决定排除本轮，其首轮失败保存在原CI交接记录中。macOS14实际运行、正式签名及干净机离线发行继续由O2/P6验收。

## 验收结果

| 范围 | 结果与证据 |
|---|---|
| 构建与代码契约 | 构建新鲜度通过，最终语法1128文件零失败，完整单元2491通过/18跳过，完整静态80/80通过。[日志](checks/fast.txt) |
| P3-01 共享ACC | 当前43个真实工具注册、保护路径、失败隔离、实际写入审计通过。[共享ACC](checks/macos-acc-shared.txt)与[Python专项](checks/smoke_macos_shared.txt) |
| P3-02 文档与图表 | 实际工作台MCP调用24项、独立产物检查24项通过。DOCX/XLSX/PPTX/PDF读写、中文字体、图片、图表、检查点及HTTP回滚均覆盖。[实际链路](checks/macos-office-artifacts.txt)与[独立检查](checks/office-independent.txt) |
| P3-03 浏览器 | 仅完整Chromium的26项真实测试通过，覆盖导航、填写、截图、标签页、隔离profile、CDP保留与清理。生命周期8项通过。[真实运行](checks/macos-browser-runtime.txt)与[生命周期](checks/smoke_browser_runtime.txt) |
| P3-04 模板及界面 | 真实模板38项、中英界面18项、Playbooks94项、能力56项、权限37项、技能工具26项通过。原71项内容独立审计可按最新指纹复用。[模板](checks/macos-platform-templates.txt)与[界面](checks/macos-capability-popover.browser.txt) |
| 组合工作链路 | 本地确定性Provider经工作台实际调用ACC，生成并读取Word，启动Chromium填写并提交中文本地表单，保存真实截图附件，关闭浏览器并清理自有进程树。有窗口和无窗口各27项通过。[有窗口](checks/workflow-headed.txt)与[无窗口](checks/workflow-headless.txt) |
| 产物视觉检查 | 新DOCX1页、XLSX1页、PPTX3页、生成PDF1页共六页逐页检查通过，样例三城市与数值从固定输入逐项读回。[渲染对账](samples/renders-4x5Not/verification.json) |

组合链路保留真实主Chromium启动参数、Playwright驱动与进程树快照，并在结束时核实进程及profile消失。文档由独立DOCX读取器再次确认，截图按1280×720 PNG实际字节确认。两种模式的[有窗口记录](workflow-headed/summary.json)、[无窗口记录](workflow-headless/summary.json)及相应事件均已归档。

59项首轮命令57项通过，两项因总运行器覆盖临时HOME或WCW_DATA_DIR而失败。使用各测试标准自隔离入口定向重验后两项通过，最终59项全部通过。新增探针首轮的profile路径比较也曾因 `/var` 与 `/private/var` 别名误红，捕获时规范化后两种模式通过。原始失败及处理保存在 [首次结果](validation-first.json)、[最终汇总](validation.json)与对应日志中。

独立复核发现的实际启动参数、驱动观察、路径规范化、截图留存及清理判据均已补齐。最新P3记录87项及P1–P3叠加323项文件指纹一致，复用的离线安装及先前独立复核证据据此关联到当前代码。候选间变更为组合验收探针，生产代码对应指纹一致。[源码审计](source-audit.json)与[本轮指纹](source-fingerprint.json)

## 保留的验收边界

- 本轮范围为当前macOS27.0.1 arm64主机。64个wheel与必需完整Chromium共98个arm64二进制的静态部署声明最高14.0，macOS14实际运行留待O2/P6。原可选ffmpeg的15.0声明失败记录继续保留。[最低部署审计](../acceptance/minimum/README.md)
- 本地确定性Provider验证协议、工具执行及产物链路。真实模型质量、正式账号服务与登录Keychain实际交互沿用P2暂缓项。
- 有窗口Chromium156的实际启动参数、页面操作和工具返回截图已验证。人工界面观察时，按应用名选择到了另一148版本欢迎窗口，随后Mac锁屏，该次人工观察列为未验收。
- 独立App、通知、语音及宿主生命周期归P4，桌面输入、AX/OCR归P5，签名、公证、干净机离线安装、升级回退与Trash归P6。
- 完整单元中的18项跳过、fast排除的7项live件，以及旧checkpoint覆盖件内部的real-ACC-audit跳过均保留。P3真实43工具对账、真实Office写入审计和回滚使用本轮直接证据。[完整跳过清单](validation.json)

本轮复核与处理结果见 [独立复核](review.json)。P3适用功能、单元及静态门已覆盖，当前Mac全仓库全部e2e的执行范围按日志清单登记。

## 复现

从仓库根目录执行，依赖与Chromium缓存按原P3准备流程提供。两个组合模式使用各自新的输出目录。

```bash
node dev-harness/run-all.js --fast
RUYI_BROWSER_CACHE_SOURCE=/tmp/ruyi-p3-browser-required-cache \
  node MACOS-PORTING/probes/accept-mac-workflow.cjs --headed --out /tmp/ruyi-mac-headed-replay
RUYI_BROWSER_CACHE_SOURCE=/tmp/ruyi-p3-browser-required-cache \
  node MACOS-PORTING/probes/accept-mac-workflow.cjs --out /tmp/ruyi-mac-headless-replay
```

本机Python运行时所需DYLD路径保存在 [执行器存档](run-candidate.cjs)，每项完整命令见 [原始执行记录](validation-first.json)。
