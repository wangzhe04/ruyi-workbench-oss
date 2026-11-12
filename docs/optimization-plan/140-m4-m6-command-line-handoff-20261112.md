# 140 · M4-M6 命令行收口与交接（2026-11-12）

按用户要求保存进度、交接并commit/push；本批不继续长诊断。**不是全绿收尾：原631范围RED、19失败；其中1项静态数量锁随后单独修复并复验，余18项待查。** 详见[92 §12.75](92-3.1-implementation-handoff.md#1275--2026-11-12-m4-m6-命令行收口与交接)和[本批证据](evidence/m4-m6-command-line-handoff-20261112.json)。

当前生成服务6bf65669…7a099，安装器f16d0650…3439e；第一唯一合格服务商默认行为、copied-only60s安装探针、M5组合及包来源已实现并有各自有限实测。版本仍3.0.1，3.1未发布。用户禁止Computer Use：两个新Desktop GUI以及artifacts、desktop-mcp-smoke、privacy-clipboard-copy、privacy-mermaid-export四个默认件未执行，不能以旧D879 GUI或额外skip冒充。

| 范围 | 原实测 |
| --- | --- |
| 本次全unit阶段 | 5331 tests／194 suites；5298 PASS／0 FAIL／33 SKIP；不是479文件数或此前预测。 |
| 命令行限定631 | 612 PASS／19 FAIL，13 FLAKY包含在612内；7个原live skip，另4个用户未执行；原held runner exit1／close1／双EOF、无kill，10:19:00.081Z结束。 |
| 当前M5 | 四类各两轮，8次／166 labels；合成QQ／飞书回调，不是真平台。 |
| 当前两包console | 各两轮，4次／34 labels；完整app271与Full installer映射、ZIP回读/来源、DPAPI冷reader及Full图像链资格各自保留。 |
| release3 | 整轮RED，Slim19core中1flaky被原no-retry门拒；Full后续业务/安装在该次未到。 |
| 独立Full安装partial | 原67040退出0、34wrapper checks；安装／幂等／两个stdio入口108工具与file-info。明确不含Full业务／upgrade／19core／rollback／GUI，不改release3RED。 |
| 数量锁后修 | process-safety.static只366→367及说明，真实HEAD对照/独审，efa8源；原direct static退出0；随后仅build--check／facts.static／diff短检查0。原19FAIL仍保留，不重写成18FAIL。 |

原631前后1924项输入为4183510b…1308d1；after捕获后才修数量锁，post1924为603f140b…ac885c。业务app仍6bf；只补验该静态入口，未重跑修后整套unit／631／syntax。CF54／B145／3ff／D879结果均历史，不搬到当前源；原release1／2及B493两UNKNOWN、原full3RED不被后续成功洗绿。

后续工作从以下18项开始。**观察是最终同名错误节中的现象，不是根因判断**；没有证据把它们统一归为产品、并发或夹具。预算为原run-all每次尝试的timeoutFor，禁止靠放宽预算／断言、假owner或新增全局skip让它变绿。四个work-data长期件要保留原Windows owner／source／IPC／exit-close／UNKNOWN证据；未知清理不得标已闭合。

| 待查原失败件 | 原每次预算 | 最终原观察／起点 |
| --- | --- | --- |
| external-bots.browser.e2e.js | 120s | 末次TIMEOUT；B2 owner-bound progress保存断言红。 |
| rail-session-search.browser.e2e.js | 120s | S4搜索命中会话数断言（实得1）。 |
| work-data-completed-claim-recovery.e2e.js | 900s | 末次exit1；恢复/held actor错误节待查。 |
| attachment-http-roundtrip.e2e.js | 120s | 末次TIMEOUT，无FAIL断言行。 |
| config-read-safety.e2e.js | 120s | D4b恢复已知policy后strict audit读取断言红。 |
| overlay-update-core.e2e.js | 300s | 末次exit2；原更新过程错误节待查。 |
| privacy-gateway.e2e.js | 120s | 末次TIMEOUT；不得与release3的另一次首轮timeout混同根因。 |
| scheduler-crash.e2e.js | 120s | 末次TIMEOUT；mid-run实际退出码3221226505≠预期3。 |
| budget-guard.e2e.js | 120s | E31零触发路径出现预算日志。 |
| checkpoint-mcpchild.e2e.js | 120s | 末次exit1，无FAIL断言行。 |
| context-compact-v2.e2e.js | 120s | D6未知CLI模型手动1M断言，实得undefined。 |
| external-bot-setup.browser.e2e.js | 120s | 等待“绑定账号”状态的UI条件超时。 |
| privacy-channels.e2e.js | 120s | Privacy CLI child close deadline。 |
| privacy-managed-mcp.e2e.js | 120s | 末次TIMEOUT，无FAIL断言行。 |
| shell-session.e2e.js | 120s | f2显式cwd输出断言不符，包含提示符/命令。 |
| work-data-bound-directory-deep-path.e2e.js | 900s | 末次exit1；原完整native/owner阶段未完成诊断。 |
| work-data-completed-intent-recovery.e2e.js | 1200s | 独占C11真实新增失败，末次exit1。 |
| work-data-owned-source-recovery.e2e.js | 900s | 独占C11真实新增失败，末次exit1。 |

13个FLAKY_PASS也保留在证据，表示首轮失败后自动重跑过，不能写“所有首轮通过”。早期跨B桶邻接归名和漏TIMEOUT导致的旧诊断target计划已EARLY_ROOT_PROGRESS_MISATTRIBUTION_SUPERSEDED，不是历史genuine业务失败。只用最终631 compact结果和同名完整错误节取名；不要继续沿旧错计划查无关case。

复现参考（**本次交接不执行**）。先读CONTRIBUTING/CLAUDE，准备明确的Python312绝对可执行路径并保留命令行/隔离headless约束。下一位先独占一件，使用原runner保持原预算/单位测试门；parallel1是新的定向形态，不能替代原4路RED。下面命令不恢复四个用户排除项：

```powershell
Set-Location -LiteralPath "<repo>"
$env:RUYI_TEST_ACC_INSTALLER_PYTHON = "<absolute Python312 python.exe>"
node dev-harness/run-all.js --parallel 1 config-read-safety.e2e.js
```

若以后获准重跑原631范围，使用已审外部run-full-supervisor.command-line-4.cjs（dc4b9d44…）与全新job/输出路径、固定selection-review-631名单SHA56ab1a95…1ec1c05f；原runner1808e69e…不改。或从权威compact结果生成余18显式列表后经原runner逐件复验，不能把未来focused PASS回写原631。保存修改前后fixture/source/inputStage、原CP exit/close双EOF和详细HTTP/error.code／阶段；先定位后选最小产品或夹具修复，失败/UNKNOWN也落盘。

证据入口：[本批JSON及原件映射](evidence/m4-m6-command-line-handoff-20261112.json)／[15份原件gzip归档](evidence/m4-m6-command-line-20261112/)。另见[独立证据审查收据](evidence/m4-m6-command-line-handoff-review-20261112.json)。仓库已携带日志、原held收据和freeze原件；解压后按JSON的原bytes／sha校验，不从摘要补造原始输出。本机外部原现场仍在C:/r31-1111/m5-m6-local：

- command-line-default-4-results.log：唯一权威631状态/19FAIL/13FLAKY名单；command-line-default-4.log：末尾同名“=== case (状态) ===”完整错误节，不能按交错进度邻接行归名。
- command-line-default-4-receipt.json及-root-exit.json：原held对象终态；-unit.log：实际unit5331；inputs-before/after-command-line-default-4.json：原1924/4183。
- process-safety-owner-fixed-1.log／-exit.json及inputs-after-process-safety-owner-fix-1.json：只证明efa8单项后修／post603f，非整套复跑。
- final-command-line-evidence-1.json：Root实际只读收集器5的原612/19/13、M5、包和Full partial；收集器退出0是材料装配成功，不是测试全绿。公开repo evidence另加postcountfix/handoff18范围。
- release-final-3/validation.json及其log/exit：保整轮RED；release-full-install-1/validation.json及log/exit：保独立partial；package-final-source-receipt-v3.json及patch：13copied/18materials/app271和installer映射。

失败合成现场的保留／清理：原log含“Retained synthetic owned-source recovery evidence”，可能仍保留keeper／worker。原runner退出／close／双EOF只证明该原父对象，不证明全部native后代已退出。下一位先按原进程创建身份／原句柄或Job收据核对再收，不用进程名或旧PID直接kill，不先删除现场；未知生命周期继续记UNKNOWN。本批不新增CIM／native清理或诊断。

后续仍未完成：18件根因/修复及其真实定向资格；新GUI/四用户排除（须尊重当前禁止条件）；真实QQ／飞书/连续群成员revision生产适配；跨账号／机器、掉电及全后代kernel证明；Full-local公开来源准入（精确DLL构建attestation、21项分发/source/notices/archives与法律/source-delivery/relink）。不在本批捏造这些通过或继续长测。commit/push真实结果由Root最终报告，不预填SHA或已发布。
