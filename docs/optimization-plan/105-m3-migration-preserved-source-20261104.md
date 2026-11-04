# 105 · M3 migrationFactory 只读源解码与所有权收口（2026-11-04）

本片从 `3847514a`（104 之后）起，让冷迁移/恢复走真实保留源读取：候选与 intent 写入后重新捕获源树，
仍按**原始耐久见证**校验；每个 codec 源读走一次性 grant；失败与清理错误同时保留。版本仍 **3.0.1**，
完整 M3 与 3.1 未完成、未发布。

## 产品变化与合同

- `13ak-work-data-cold-operations.js`：冷操作宿主把 `migrationFactory` 交给保留读取实现，四操作冷回归走真实源读。
- `13aq-work-data-native-adapters.js`：迁移工厂接 `preservedRead`（`bounded-native-v1`）与同步独占判据。
- `01ad-work-data-migration-host.js`：
  - `codecSourceScope(plan)`：每次 codec 转换前 `current(expected)` → `acceptIntent` → 重新 `capture(base)` →
    `validateSource` 对比**原始** `plan.sourceProof` → work → `verify(captured)` → 再 `validateSource`。
  - factory 内再校验绝对路径属于 expected.root、sha256 与 dev/ino/mtime/ctime 未变，才 `borrowCapturedFile`
    借出一次性文件句柄。
  - `preservedRead` 未定义时整条路径退回旧行为（无 captured scope、无额外断言）。
  - **本片修复**：`publish()` 的前置 `checkSource`/`tree.verify` 失败现在会释放 `plan.sourceCapture`
    （先置空再 `closeSource(...,true)`），与 prepare 的失败路径语义一致；`plan.disposable`（target capture）
    保留，使同一 plan 在前置失败后仍可重试。
- `01x-work-data-migration-codecs.js`：`sourceScope`/`sourceGrant`/`readSource` 与 fused 读取
  （text/gzip/archive 用 Store 的物理解码结果，不再重复读一遍源）。
- `13u`/`01p` 配套；`dev-harness/run-all.js` 把 cold-operations 整文件守卫按用户 2026-11-04 授权改为 **490000**
  （`migration-native-rename-size.test.js` 断言同步）。

## 独立审查与处理

- 首轮（deepseek-flash）判 fail@0.72：F1 publish 前置失败泄漏 `sourceCapture`；F2 每个 codec 文件两轮全树
  capture/validate/verify（O(N²) 成本）；F3 key release 失败时 `key_release_failed` 顶替主错误码。
- 本片修复 F1，并补一条前置失败语义测试（`work-data-migration-host.test.js`：源在 prepare 后被改动 →
  publish 报 `source_changed` → 同一 plan 可再次尝试 → `cancel` 干净返回，manifest 仍为 generation 0）。
  释放动作本身在合成夹具里没有可观测计数器（captured 对象按身份登记，外部包装会破坏身份），
  故该测试锁的是错误码与重试/取消语义；**它不证明释放已发生**，publish 前置失败的释放路径目前没有
  判别力回归覆盖（已列入下一步）。新增 NTFS e2e 只断言 codec 读取作用域的闭合，不覆盖该分支。
- F2、F3 保留为待办：二者都需要设计决定（批量 scope / 错误码优先级），不能靠改断言收口。
- 第三轮（可执行工具的子代理）实测发现：根 `README.md`/`README_EN.md` 未随 facts 更新，`facts.static.e2e.js`
  4 项 FAIL —— 已修（628 e2e / 448 suite），该门现为 ALL PASS。同轮做了变异实验：删掉 publish 前置失败分支的
  try/catch 后，新用例仍全过，证明该夹具无法观测 captured 的释放；用例已改名并在注释里说明它只锁错误码、
  可重试与干净取消，真实所有权闭合由新增 NTFS e2e 断言。

## 验证与边界

- 全量 unit：448 文件 / **5014 tests / 4988 pass / 0 fail / 26 skip / 194 suites**（本机 Node v24.14.0）。
- 新增 `work-data-migration-preserved-source.e2e.js`（真实 NTFS）：**ALL PASS**，17.7s；断言两次 genuine
  grant、物理解码只读一次、源 DATA/ADS/只读/四个 Basic 时间/安全元数据不变。
- `work-data-cold-operations.e2e.js`：**ALL PASS**，261.4s（旧 240 秒会红，490 秒为本片授权口径）。
- `build.js`：114294 行，`--check` 通过；module graph 135 modules / 922 edges；facts 448 unit / 628 e2e 与实测一致。
- `syntax-gate`：1456 files / 0 failed。
- 未运行：完整 620+ 默认 e2e 全集、production maintenance/restore 单件、真实安装包。

## 下一步（M3 未完成项）

1. 给 publish 前置失败的释放路径补一条有判别力的回归（需要能观察 captured 生命周期的测试缝，不能靠外部包装）。
2. F2：把 per-file scope 收敛为按批次复用或降低重复 verify 的设计（同时保住“写入后重新捕获”的判据）。
3. F3：清理失败时保留主错误码，清理状态用独立字段表达。
4. 附件 catalog 生产方与 uploads/tool-image/send 三个二进制面登记接线。
5. 非空 special、精确 owner delta、同 producer 恢复证明、all families、retention sealed-fault、完整索引组合。
