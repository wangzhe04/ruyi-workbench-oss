# 工作台本地语义检索

Windows 普通启动使用 EmbeddingGemma 2 CPU Q4（`embeddinggemma-2-text-q4`，768 维）。解压离线包后运行 `Start-Workbench.cmd`。搜索和首次启动均使用包内模型、分词器、CPU 运行时及包内 Node。桌面版和命令行共用同一选择逻辑。语义开关关闭时仍按关键词搜索。

## 打包与验证

用 `tools/package-offline.ps1` 的 `-Gemma2Profile` 参数传入已验证、含 `asset-lock.json` 的构建 profile。旧参数名 `-Gemma2CandidateProfile` 仍可用。打包器核对来源、实现、运行时、许可证和 Node 摘要，写出 `resources/gemma2/portable-lock.json`；解压后的工作台使用实际安装目录重新绑定文件路径。开发运行也可显式指定 `RUYI_SEMANTIC_GEMMA2_ROOT` 和对应的 `RUYI_SEMANTIC_GEMMA2_LOCK_SHA256`。

在仓库目录执行以下命令，使用解压包的 Node 与服务入口验证实际模型和搜索结果。

```powershell
node dev-harness/session-search.e2e.js --gemma2-package C:/test/ruyi-full-local
```

## 召回行为

历史搜索对完整可见候选池保留一个语义补充。显式工作台记忆搜索可以补充三个不同的记忆，优先按得分排序，同一记忆的重叠文本片段共用一个名额。最高候选已有强词法依据时沿用原有词法结果。两条路径的最低余弦分数均为 0.70；该分数不表示正确概率。查询明确点名大写标记或编号时，核对可见来源中的完整代号。自动记忆注入不从这条显式搜索路径增加新候选。

目录中的 `install.cjs`、`bundle.cjs` 和 `models.lock.json` 用于显式选取其他历史研究对照模型。当前产品由 `tools/bundle-gemma2.cjs` 交付模型与许可证。
