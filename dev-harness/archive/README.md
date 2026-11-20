# 历史迁移工具与临时复现

归档日期：2026-10-21。以下五份脚本从 `dev-harness/` 原样迁入，文件字节未改。没有运行它们，也未将历史冒烟列入正式回归。当前测试入口见 [harness 说明](../README.md)，实施方向见 [86 号规划](../../docs/optimization-plan/86-3.1-completion-and-privacy-roadmap.md)。

| 文件 | 原用途与适用时期 |
|---|---|
| [codemod-toolcall-table.js](codemod-toolcall-table.js) | 第 41 波，一次性将旧 `toolCall` switch 转为注册表；按当时源码形状工作 |
| [codemod-slice-modules.js](codemod-slice-modules.js) | 第 43 波，按固定行号将 18,485 行旧单体切为 15 模块；会删除并重建 `app/src`，不能用于当前源码 |
| [migrate-ports.js](migrate-ports.js) | V1.8-A 第一轮，将当时 e2e 固定端口迁为动态分配 |
| [migrate-ports-v2.js](migrate-ports-v2.js) | V1.8-A 第二轮，补第一轮遗漏的单行端口声明 |
| [v25-smoke.js](v25-smoke.js) | v2.5 临时复现：Claude Code 技能源、MCP 自动导入和删除技能；原文件明确不进正式套件 |

这些文件的 `__dirname` 仍描述原始目录布局，**不作为可在归档位置直接运行的维护工具**。需要复现时，从 Git 历史找到对应波次版本，在独立历史检出中恢复原 `dev-harness/<文件名>` 布局；先核对源码和路径，再判断是否适合执行。旧冒烟会启动服务并在用户家目录下创建测试技能，不能把它当安全的只读检查。

第 41／43 波的历史交付证据见 [早期路线记录](../../docs/archive/OPTIMIZATION-ROADMAP-HISTORY-V1-2.md)。现行回归中的 [技能注册表](../skills-registry.e2e.js)、[MCP 配置导入](../mcp-import-config.e2e.js)、[导入来源](../mcp-import-origin.e2e.js)和 [MCP 配置变更](../config-mutate-mcp-parity.e2e.js)承接相关领域，但本次未声称与旧冒烟逐条等价；原复现完整保留。

五份脚本平放在此目录，以继续被 `syntax-gate.js` 对 `dev-harness` 的深度 1 扫描覆盖。根目录 `*.e2e.js` 发现集合仍为 539 件，未变更正式 runner、生成器或生产构建入口。

## 语义检索研究证据(151 阶段 5 P14,2026-11-20)

`dev-harness/semantic/` 的研究脚本、数据与结果(语义检索选型、校准、常驻运行时控制器、工作数据还原研究等)与只测它们的
19 件研究测试,按提交 `d5d3caff05d0e8e17e3d6a38fa3a85da07a50703` 的 git 对象原样打成一个包,共 953 个文件;
原位置已删除,CI 与默认回归(`node --test "dev-harness/unit/*.test.js"`、`run-all.js`)不再加载它们。

| 文件 | 内容 |
|---|---|
| `semantic-research-d5d3caff.tar.gz` | POSIX ustar + gzip,1,237,210 字节。路径与原仓库相对路径相同 |
| `semantic-research-d5d3caff.manifest.json` | 每个文件的相对路径、字节数、sha256、git blob 号;包与解压后 tar 的 sha256;移出默认回归的 19 件及理由;未归档件及理由 |
| `semantic-research-d5d3caff.sha256` | 包与清单自身的 sha256(`sha256sum -c` 格式) |

冻结身份:清单 sha256 `211dccf41c9ebd52fd8412e99f8f472768f451aa7cc8ef6df6bee8daccb218c0`,
包 sha256 `08d0479055bd7942d024dd4f8388d4049d7f883075141f844ec8dc785304b1bb`,
tar sha256 `8a90e7ee03334c32f0083e7d259bf09c2d4e6a9a9a38dcfa43c05742f900d163`。
文档或证据里引用的某个研究文件的 sha256 / blob 号,在清单里按路径查。

```bash
node dev-harness/research-archive.js verify                         # 核对校验和、清单与逐条目摘要,不需要 git
node dev-harness/research-archive.js extract --into <空目录>         # 先核对再解包;已有文件字节不同一律拒绝,不覆盖
node dev-harness/research-archive.js clean --dir <同一目录>          # 收回解包:只删与归档逐字节相同的文件,改过的保留并报告(退出码 1)
node dev-harness/research-archive.js compare-git --dir <解包目录>     # 与 d5d3caff 的 git 对象逐字节比对(需要完整历史)
node dev-harness/research-archive.js build --commit d5d3caff --out <目录>  # 从 git 对象重建
```

复现性的边界:`build` 重建出的 tar 与清单逐字节相同只取决于输入;`.tar.gz` 逐字节相同**只在同一 zlib 实现下成立**
(本机 Node 24.14.0 实测相同),换了 zlib,gzip 层字节可能不同,这时以 `tarSha256` 与逐文件 sha256 为准。
`verify` 的规范形检查(用读出的条目重写必须逐字节相同)只作用于解压后的 tar,gzip 层只核入库那份文件的 sha256。

包是标准 ustar,不依赖本工具也能复核:Windows 10/11 自带 `tar.exe -xzf semantic-research-d5d3caff.tar.gz -C <目录>`。
要复现研究,解到仓库根即可回到原布局(研究目录里留下的文件不在包内,不会冲突):
`node dev-harness/research-archive.js extract --into .`。这会让 `node --test` 的 glob 重新扫到那些研究单测,
其中多数还依赖未入库的 `output/` 证据目录,用完用 `node dev-harness/research-archive.js clean --dir .` 收回:
只删与归档逐字节相同的文件、并移除因此变空的目录;改过的文件保留并逐个报告。解包拒绝 Windows 不安全的名字(`:`、段尾 `.` 或空格、
CON/PRN/AUX/NUL/COM1-9/LPT1-9)、只差大小写的重名,以及穿过符号链接或 junction 的写入。

**未归档、留在原处的 18 个文件**(清单 `notArchived`,各带理由):
- 盲测相关 15 个,只记路径、git blob 号与大小,不读取内容:`semantic-coarse-policy-candidate-v7.cjs` 与其 `.recipe.json`
  (按硬线不打开不移动);`.rgignore` 声明为盲测材料的 `acceptance*.cjs` 与 `acceptance-v5/`、`acceptance-v6/` 共 13 个。
- `.rgignore` 本身。
- 产品维护脚本 2 个:`refresh-license-lock.cjs`(刷新 `ruyi-workbench/semantic-runtime/licenses` 的许可证锁,
  `licenses/NOTICE.md` 按原路径指向它)与 `download-candidates.cjs`(按 `models.lock.json` 下载模型资产并用产品
  `verify.cjs` 校验,`semantic-runtime/README.md` 按原路径指向它)。两者只依赖产品文件,不依赖任何归档件。

`.gitignore` 对 `dev-harness/semantic/acceptance-v7*`、`acceptance-zh-v1*` 的忽略规则照旧有效。

建包只读 git 对象(`git ls-tree` / `git cat-file`),不遍历工作区,所以主树里未入库的盲测材料不会被卷进包;
盲测件只按文件名识别。`unit/research-archive.test.js` 钉着冻结身份、清单与包逐条一致、归档路径已从工作区消失、
研究目录里的名字恰为上面 18 个(本机 `.gitignore` 挡住的盲测材料名除外)、默认回归的发现集合与 CI 不再触及研究目录、
dev-harness 与 `ruyi-workbench/tools` 里没有代码再按路径找研究目录。原 `unit/semantic-calibration.test.js` 里守产品 06ha
的断言原样迁到 `unit/semantic-production-admission.test.js`,原件整份在包里。
