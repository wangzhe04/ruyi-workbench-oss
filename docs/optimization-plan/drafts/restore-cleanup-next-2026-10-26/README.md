# 未晋升：恢复私有支持层清理补片

本目录保存2026-10-26五模块私有支持候选的选定清理补丁、测试和证据。不是生产恢复能力，不覆盖当前ordinary安装继承元数据首红，不得自动配置维护worker或启用用户数据加密。

`all-cleanup-spans.json`的基线是97号源码ZIP中 `packages/codex-ruyi-current118-durability-union-v2-20261025/runtime/app/src` 的五源，**不是当前live源码**。先校整个ZIP及内部成员，再用 `reconstruct-five.cjs` 读该精确私有基线，将唯一span施加到新的独立输出目录；逐文件核摘要及完整逆向，不加载服务、不构建、不测试。13y保持该私有基线原字节。

```powershell
node reconstruct-five.cjs '<已校验私有union的src绝对路径>' '<父目录已存在的新输出目录>'
```

当前live的13u为7ebd、实际native字符串为f79；私有union的13u为ee359、native为ef53。所谓“native不变”只表示本次清理、target14span及诊断7span未改变**已有私有ef53**，不能把它表述为live→整个私有支持层没有原生增量。该原生增量和五模块完整增量仍须分别按准确身份独审。

原始五源清理缺口包括falsy主原因被finally覆盖、擦零失败跳过后续release、共享snapshot disposal吞掉release未知。原55项、13u70项、其他13项和共享disposal4项分列，不能简单相加成完整原生恢复验收。原反例是证明旧缺陷的红，不是修后绿。测试保留当时执行路径；继续时只适配明确源位置、重新冻结并独审，不能直接执行旧测试或回写原失败时间/刷新固定before。

新119源组合的 `private119-composition-proof.json` 另记录：以当前119为底保114无关模块，五支持→清理→target14→诊断7均逐层唯一可逆。它仍只是源准备，没有server.js或新原生绿灯。本目录是选定子集，具体保留范围见 `preserved-subset.json`。

最终非作者审查见 `formal-review.json`：f9清理87项轻纯通过，但a25的target新增scope仍有getter覆盖主错误及Promise release未知被洗掉两项反例，**旧a25不得build或进入实际门**。曾给出的临时无阻断判断已撤回；唯一/可逆及原73绿都不能替代这两个组合缺口。后续须在新目录窄修、重新组合冻结、由非作者复审，不能改写本文件记录的旧红或沿旧a25身份放行。

本轮随后形成修正组合61b2，唯一新增target清理span复用已审的保守清理聚合器，34项独立轻纯与原73项分列记证；448成员重新冻结并获非作者批准进入自有隔离实际门。选定span、身份及日志保存在 `../../evidence/3.1-resume-20261026/ordinary/target61b/`，不是本目录旧a25的身份更新。原native仍为私有ef53，不能据此声称live原生增量已经验收。

执行准备脚本旧9504因祖先junction可越界而阻断；新5405增加物理路径准入和排他写入，非作者13项轻测通过。实际新树的121执行输入、119源码精确拼接及四个派生文件完整逆向另获独审，见同证据目录的 `prepare5405/`、`final119/`；它们保留当时的绝对执行路径，仅供追溯，不可在新机器直接运行。实际恢复门结果及后续队列以92的12.24和主证据JSON为准，准备成功不能替代恢复成功。

52fb真实门的新诊断明确为继承objects-v1根目录的Change单项漂移。后续独立源码核对发现普通移动遗漏已有 `preserveMetadata:true`（originals已有），新02d2候选只补此选项，保持native ef53、固定stage proof和全部拒绝谓词。非作者26项强纯及旧源码2项原断言负控通过；已有移动合同保存的是同一held对象移动前实测Basic，不拿失败snapshot重置expected。补丁和选定测试/历史首红在 `ordinary/move-option/`，4ee新准备器与独审在 `ordinary/prepare4ee/`，新e1b私有运行身份及实际门记录在 `ordinary/move-actual/`。原61b、a25、9504及61WuRD现场和红灯不改写；最终范围和结果仍以主证据为准。

e1b后三轮密码恢复/冷读均通过，但完整门仍未过。最后独立special包标签修复排除了旧mode-0的确定性wx碰撞，真实special已返回预期拒绝码且权威pointer未变，随后原backup metadata谓词失败，clean内容比较未执行。具体before/after局部值未持久化，不推断唯一字段或原因。诊断初版code对象泄漏反例、修后有界输出、标签wx反例和最终失败分别保存在 `ordinary/special-diagnostic/`、`ordinary/special-label-fix/`、`ordinary/special-label-actual/`。下一批须在新根记录第一次before和有界after/delta，原严格断言不改；不要把此目录或三轮局部绿灯当作生产恢复准入。
