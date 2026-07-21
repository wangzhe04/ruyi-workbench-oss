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

## seeds.json 类别（04 §Phase A 点名 5 类）

- `tool-protocol`：工具使用规范（先读后改、最小改动、todo 计划）
- `read-before-write`：先读后改（编辑前必须先读）
- `office-ban`：Office 禁令（终端命令内联手写 Office 被软闸拦）
- `loop-self-rescue`：loop 自救（连击 5 次同工具被 guard 中止，非预算烧穿）
- `plan-trigger`：plan 触发（高风险操作进 plan 模式待批）

51 波可扩到 10-20 个（04 §Phase A 建议量）。每加一个 seed = 多一道行为漂移防线。
