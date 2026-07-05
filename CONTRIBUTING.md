# 贡献指南 · Contributing

感谢你有意贡献如意 Ruyi。本项目是面向政企内网/气隙环境的本地 AI 工作台,有几条**硬约束**与产品定位深度绑定——它们不是风格偏好,而是贡献的红线。请先读完再动手。

## 五条硬约束(= 贡献红线)

1. **纯离线可用。** 任何功能都必须在**无公网**的机器上可跑。联网是增强,不能是前提;缺网时相关能力应优雅降级而非报错崩溃。
2. **`server.js` 零 npm 运行时依赖。** 工作台后端 `ruyi-workbench/app/server.js` **只用 Node 内建模块**(`http`/`fs`/`crypto`/`zlib`/`child_process` 等),不引入任何运行时 npm 包。这是内网安全过审的地基,不可动摇。(构建期 devDependencies 如打包器不受此限。)
3. **Clean-room。** 不得贴入任何来源不明或受限的代码/文本:不含 Anthropic 泄露源码,不分发官方 Claude CLI,不复制第三方插件源码。所有新写文档/代码必须原创。
4. **Windows 10/11 为一等目标。** 路径、编码、进程、控制台代码页都以 Windows 为首要正确性目标(PowerShell 5.1 无 `&&`;写文本文件用 UTF-8;`.cmd` 保持纯 ASCII)。
5. **行为变更必须带/更新 e2e。** 改了对外行为(API、事件协议、工具语义、权限判定)就要新增或更新 `dev-harness/` 里对应的离线 e2e。断言**只加不改语义**——可以断言新字段,不要删旧断言。

## 跑测试套件

```powershell
node dev-harness\plan-mode.e2e.js
node dev-harness\repo-hygiene.e2e.js
```

- **串行跑**:端口固定,并行会撞。
- **全绿为过**:每件末行打印 `... E2E: ALL PASS`,进程 `exit 0`。
- **实弹件可跳过**:`deepseek-live` / `deepseek-tools`(真密钥)、`desktop-bridge-live`(真桌面 MCP)、`desktop-mcp-smoke`(已装 ACC 的 Python 环境)等需外部条件,常规离线回归中跳过。每件文件头部注释写明了它断言的边界与所需条件。

写新 e2e 的自查:临时 `HOME`(tmpdir)、健康轮询起服务(别裸 sleep)、`finally` 里 `taskkill /T /F` 清理 fake + workbench、逐条 `PASS/FAIL <label>`、`process.exit(fail?1:0)`、跑两遍确认无端口/临时目录残留导致的偶发。

## ai-computer-control(桌面控制 MCP)开发

ACC 在 `mcp/ai-computer-control/`,是独立打包的 Python FastMCP。

- **可编辑安装**:`pip install -e mcp/ai-computer-control`(Python 3.10+ 可跑;建议 3.13,与预置离线 wheels 对齐)。
- **冒烟**:`python -X utf8 mcp/ai-computer-control/tests/smoke_registry.py`(校验工具数与版本)、`smoke_stdio.py`(校验 stdio 协议)。
- **新增「动文件」工具**(会创建/移动/删除/写入路径的工具)**必须**把其路径参数登记进 `BRIDGED_WRITE_PATH_ARGS` 快照表——工作台据此在动手前建检查点。`checkpoint-coverage.e2e.js` 会机制性把关:漏登记即测试变红。
- 可选依赖缺失时,对应工具须优雅降级(给安装提示,不崩溃),其余工具照常。

## 加新 MCP 连接器

给工作台加一个新 MCP 的**正道是 drop-in**,不用改工作台代码:做一个「文件夹 + 一份 `ruyi-mcp.json` 清单」放进 `mcp/`。详见 [`mcp/README.md`](./mcp/README.md)。(内置桌面控制 MCP `ai-computer-control/` 例外:它由专用探测识别,不加清单,避免双注册。)

## PR 期望

- **小步**:一个 PR 一件事,便于复核。
- **带验证证据**:贴上相关 e2e 的 `ALL PASS` 输出或复现步骤。
- 中文或英文皆可。

---

## English (summary)

Ruyi is an offline-first, air-gap-oriented local AI workbench. A few **hard constraints** are product-defining red lines, not style preferences:

1. **Works fully offline.** Networking is an enhancement, never a prerequisite; degrade gracefully when offline.
2. **`server.js` has zero npm runtime dependencies** — Node built-ins only. (Build-time devDependencies are exempt.)
3. **Clean-room.** No code/text of unknown or restricted provenance; no leaked Anthropic source, no bundled official Claude CLI, no copied third-party plugin source.
4. **Windows 10/11 is a first-class target** for paths, encoding, processes, and console code pages.
5. **Behavior changes must ship/update an e2e** in `dev-harness/`. Assertions are add-only in meaning — assert new fields, don't delete old assertions.

Run the suite **serially** (fixed ports): `node dev-harness\<name>.e2e.js`; passing prints `... E2E: ALL PASS` and exits 0. Live tests need your own key/desktop/Python and are skipped by default.

For ACC (`mcp/ai-computer-control/`): `pip install -e`, run `tests/smoke_*.py`; any new file-mutating tool **must** be registered in the `BRIDGED_WRITE_PATH_ARGS` snapshot table (`checkpoint-coverage.e2e.js` enforces this — a missing entry turns the test red). Add new MCPs the drop-in way via `mcp/` (see [`mcp/README.md`](./mcp/README.md)) — no workbench code changes needed. PRs: small, with verification evidence; Chinese or English both welcome.
