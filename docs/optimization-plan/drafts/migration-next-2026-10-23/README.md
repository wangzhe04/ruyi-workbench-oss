# Migration storage continuation draft

状态：**DRAFT / DO NOT APPLY**。关机前续接材料，尚未独审、未应用；只保存小片，不增加产品实现或生成物。

- `DRAFT-DO-NOT-APPLY.patch`：仅六个产品模块的局部 hunks；不含 shared marker 修复、不含重复测试 diff。
- `migration-records-work-data.test.js`：14 项真实源码/crypto/fs 单测草稿，使用合成临时目录和自有测试钥；未涉及真实用户数据。
- `baseline.json`：基线 commit、逐文件原始/候选 SHA、TEMP 位置、原始日志路径及 SHA。
- `handoff.md`：已做范围、尚需验证的合同及下一族方案。

先核对当前源码并重新合并局部 hunks；不得用 TEMP 整份候选覆盖现文件。shared escaped-key marker 独立补丁由 root 评审，其身份记录在 baseline。memory 与 journals 后续修改须保留。

后续获准实施并完成评审后，将测试放到 `dev-harness/unit/`，才能使用其 `../lib` fixture 路径。正常 source 模式读取当前 `app/src`；TEMP 续跑可设置 `RUYI_MIGRATION_SOURCE_DIR` 指向基线核对后的候选目录。不要直接在本 docs 目录执行测试。

已有一次 14/14、0 skip 的源码结果；该次早于 shared marker 最终线性 carry 小修，因此**不能声称最终组合已测试**。未创建/运行本族真实 DPAPI E2E；未 build、未迁移或发布真实数据。下一次需要精确重基后的 source 回归、独立评审及隔离 E2E。
