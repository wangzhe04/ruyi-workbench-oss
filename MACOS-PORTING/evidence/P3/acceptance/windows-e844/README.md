# e844 首轮 Windows CI

候选 `e8445972f2961b2dbcf430fc4e1c8fbc0c8b65cd`，fork内[草稿PR #1](https://github.com/Sonata17inD/ruyi-workbench-mac/pull/1)，目标fork master，无合并。

2026-11-07的 [e2e运行42293298968](https://github.com/Sonata17inD/ruyi-workbench-mac/actions/runs/42293298968)：Linux static与Windows release dry-run通过；ACC CI子集失败，facts对账跳过；Windows credential IPC smoke失败，后续完整单元与e2e跳过。[平台基线42293298887](https://github.com/Sonata17inD/ruyi-workbench-mac/actions/runs/42293298887)的Windows子集失败；macos-14因runner配置不支持而取消。完整步骤/状态和注解保存在本目录JSON，入口 [summary.json](summary.json)。

只有失败步骤和exit1注解，尚未读取具体远端日志。公开日志API返回403，Codex GitHub诊断连接不可用；通过已登录Safari读取时Mac已锁屏，已请求用户解锁。不能断言IPC失败与旧P2具有相同根因，也不能把上述部分通过记为整套Windows验收。

等待日志期间，独立复现新增浏览器测试的路径夹具缺陷：模拟darwin平台时，Windows的ntpath构造结果与硬编码POSIX期望不一致。`fecd3262`仅将测试期望用同一os.path.join构造，无生产改动。独立复核原POSIX通过/ntpath失败，修复后两者通过；真实Mac smoke 8/8通过。见 [复核](crosshost-browser-review.json)、[前后矩阵](browser-fixture-review.json)及 [Mac日志](browser-smoke-mac.txt)。这尚不能确认远端ACC失败的完整根因；需推送新候选后再跑Windows。

后续：解锁后读取ACC/IPC/Windows基线的具体日志，逐项归因；GitHub Desktop发布已复核补验提交，记录新head和CI运行ID，完成修复、独立复核及Windows复验。最低系统静态审计见 [minimum](../minimum/README.md)，不代替macOS14实际运行。
