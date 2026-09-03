# 提示词 A/B 评测夹具（48a · 04 Phase A 第 3 项骨架）

> 第 48 波 48a 建立的**骨架**，第 51 波（04 Phase B/C）填实运行器。原则见 `docs/i18n/README.md:99`："模型内容本地化须版本化、回归评测、安全审查"--提示词复用同款纪律。

## 目的

任何提示词文本改动（51 波外置/i18n/缓存分层会大量触动）前后，各跑一次 `seeds.json` 里的代表性任务，对比通过率。通过率回退 = 行为漂移，挡住合入。与 `prompt-snapshot.static.e2e.js`（文本基线锁）互补：快照管"文本变了可见"，A/B 管"行为没变可证"。

## 用法（51 波填实）

```
node dev-harness/prompt-benchmark/run.js --before   # 改提示词前跑一次，落 baseline.json
# ... 改提示词 ...
node dev-harness/prompt-benchmark/run.js --after    # 改后跑，与 baseline 对比，输出 diff
```

运行器（待 51 波实现）以 `model-tier-probe.js` 为底，对每个 seed：
1. 起 fake-openai（或真 provider，按 seed.modelTier）+ workbench；
2. 发送 `task`，收集工具调用序列与最终输出；
3. 按 `pass_criteria`（预期工具集 / 关键行为标记）判 pass/fail；
4. 汇总通过率，与 baseline 对比。

`seeds.json` 的 `pass_criteria` 是机械可判的（工具名集合 ⊆ / 关键词出现），不依赖主观打分；主观质量留 51 波的质量门节点。

## seeds.json 类别（04 §Phase A 点名 5 类 + tool-batching）

现有 7 个 seed：

- `tp-01`（tool-protocol）：找齐 .js 文件用现成工具（file_search/glob），不先掉终端
- `rbw-01`（read-before-write）：编辑 config.json 前必须先 file_read
- `tb-01`（tool-batching）：两个互不依赖的 file_read 合批发出（同 batchId）
- `ob-01`（office-ban）：终端脚本手写 Excel 被软闸拦并提示改用 write_excel
- `lsr-01`（loop-self-rescue）：file_read 连击 5 次——只读 read-tier 工具
- `lsr-02`（loop-self-rescue）：file_edit 以相同参数连击 5 次——有副作用 edit-tier 工具
- `pt-01`（plan-trigger）：批量删除 .log 高风险操作须进 plan 模式待批

### loop-guard 分层语义（99f3a9a 起，lsr-01/lsr-02 分别覆盖两侧）

`07-autonomy.js` 的 `NATIVE_TOOL_TIER` 把原生工具分 `read`/`edit`/`exec` 三档；loop guard（`09-workflow.js`）按档位区别对待同一签名（工具名+参数）连续调用：
- **read 档**（如 `file_read`）：`loopWarnOnly()` 为真，同签名连击只在第 3 次 `tool_result` 上追加 `loopWarning` 字段提醒模型换策略，**永不中止**——`lsr-01` 断言 5 次全部执行完、第 3 次带 `loopWarning`、且没有任何 `tool_result.loopAborted === true`。
- **edit/exec 档**（如 `file_edit`）：同签名连击到第 5 次时该次调用**不执行**，直接返回 `tool_result` 且 `content.loopAborted === true`，错误文案含「连续 5 次相同工具调用」——`lsr-02` 覆盖这条旧语义仍然成立的一侧。

51 波可扩到 10-20 个（04 §Phase A 建议量）。每加一个 seed = 多一道行为漂移防线。
