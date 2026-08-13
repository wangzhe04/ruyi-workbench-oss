# 17 · M5 实施文档 — 高频模板方法论工具（候选 D 波首个：codebase-audit 符号检索）

> 关联：`07-microagent-lessons.md` §4 M5 / §5 候选 D 波、`10-m4-ablation.md`（单轴消融纪律）、`12-agent-architecture-research-roadmap.md`。
> 基线：2026-08-13 工作树（R5 已收口 `40501f0`；Escapade 2.5.0 线）。**先落文档再动代码**；M5 纪律 =「一次只做一个 + 过第 49 波新工具入库全部门 + 用 M4 单轴消融验证收益再做下一个」。
> 性质：本文档只覆盖 **M5 三个候选中的第一个**（codebase-audit 符号/引用检索）；debug-root-cause 二分复现记录器、data-insights 数据画像摘要**本波不做**，待首个工具消融验证后再逐个启动。

---

## 0. 一句话结论

MicroAgent 消融显示「专门工具」是独立贡献因子，论文动机例子的核心教训是「裸 LLM 会幻觉不存在的类名、按名称相似而非代码级使用证据分配」。Ruyi 的方法论全写在模板 prompt 里，靠模型自觉执行。M5 首个工具 `codebase_symbol_search` 把「符号定义/引用检索」落成确定性工具：给定符号名，返回它在代码库中**真实存在**的文件级定义/引用证据，让 codebase-audit 类模板用「文件:行号」证据说话，而不是凭名称猜。**初版是 grep/ctags 级（§7 诚实性承诺），不承诺 AST 精度。**

---

## 1. 问题

- codebase-audit 模板（`08-agent-runs.js` 注册）要求子代理「按代码级使用证据分配类/责任」，但现有工具只有通用 `file_search`/`glob`/`docs_search`，没有「给定符号 → 定义在哪、谁引用」的专门检索；子代理只能自己反复 grep + 目测，既烧 token 又容易幻觉符号名。
- 论文的符号检索是 JavaParser AST 静态分析；Ruyi 面向任意语言/任意任务，**不照搬 DDD 五阶段或 Java 依赖分析**，只把「符号 → 文件级证据」抽象为通用能力（07 §7）。

---

## 2. 工具契约

### 2.1 注册四元组

| 维度 | 值 |
|---|---|
| 工具名 | `codebase_symbol_search` |
| pack | `code`（与 `code_review_scan`/`dependency_inventory`/`docs_search` 同族） |
| tier | `read`（只读检索，无落盘/exec，自动放行） |
| paths | `read`（handler 内 `guardFileToolPath` 读闸校验 root，远端模型越界读拒；遍历仍经 `walkFiles` 敏感子树跳过） |

### 2.2 inputSchema（OpenAI function 定义）

```json
{
  "type": "object",
  "properties": {
    "symbol": { "type": "string", "description": "要检索的符号名(函数/类/方法/变量)。当作字面标识符处理,含正则元字符也会被转义。" },
    "root": { "type": "string", "description": "代码库根目录(缺省回落工作区,同其它 code 工具)。" },
    "kind": { "type": "string", "enum": ["any", "definition", "reference"], "description": "只返回定义/引用/全部(默认 any)。" },
    "maxResults": { "type": "number", "description": "命中总数上限(默认 200)。" },
    "maxFiles": { "type": "number", "description": "扫描文件数上限(默认 1500)。" },
    "maxDepth": { "type": "number", "description": "目录深度上限(默认 8)。" },
    "ignoreDirs": { "type": "array", "items": { "type": "string" }, "description": "额外跳过目录(node_modules/.git/.venv 恒跳过)。" }
  },
  "required": ["symbol"]
}
```

### 2.3 返回形状

```json
{
  "ok": true, "root": "/abs", "symbol": "foo", "kind": "any",
  "definitionCount": 2, "referenceCount": 7, "fileCount": 4,
  "definitions": [{ "path": "/abs/a.js", "relativePath": "a.js", "line": 10, "text": "function foo() {", "kind": "function" }],
  "references": [{ "path": "/abs/b.js", "relativePath": "b.js", "line": 3, "text": "foo(1, 2);" }],
  "files": [{ "relativePath": "a.js", "path": "/abs/a.js", "definitions": 1, "references": 0 }],
  "note": "grep-level lexical identifier scan; definition classification is keyword-pattern heuristic, not AST-accurate."
}
```

- `definitions[].kind` ∈ `function` / `class` / `variable` / `type`（关键词启发式，见 §3.1）。
- `files[]` 是**文件级依赖图**：每个命中文件给出 def/ref 计数，供 LLM 按「哪些文件定义、哪些文件引用」做证据优先的判断。

---

## 3. 实现方案（grep/ctags 级，零依赖）

### 3.1 核心算法

1. `symbol` 先做**字面转义**（`escapeRegex`，同 `globToRegExp` 的元字符转义），杜绝 LLM 传 `(`/`$` 等触发 `Invalid group` 崩溃（同 file_search F2 教训）；纯标识符（`[A-Za-z_$][A-Za-z0-9_$]*`）用 `\b…\b` 词边界，非标识符退化为字面匹配。
2. 遍历经 `walkFiles`（复用：默认跳过 `node_modules/.git/.venv` + 敏感子树）筛出的代码文件（后缀白名单 `.js/.mjs/.cjs/.jsx/.ts/.tsx/.py/.go/.rs/.java/.cs/.rb/.php/.c/.h/.cpp/.hpp/.sh/.ps1/.sql` 等），单文件 >1MB 跳过。
3. 每行判定：
   - **定义**（关键词启发式，命中任一即记 def，kind 取命中组）：
     - `function|func|fn|def|sub` + symbol → `function`
     - `class|interface|struct|enum|trait` + symbol → `class`
     - `type` + symbol（Go/Rust/TS 类型声明）→ `type`
     - `const|let|var|val` + symbol → `variable`
   - **引用**：行匹配 symbol 但非定义行 → `references`。
4. `kind` 参数过滤输出；`maxResults` 封顶，`files[]` 按命中文件聚合。

### 3.2 代码切入点（共享作用域拼接，零 import）

| 文件 | 改动 |
|---|---|
| `app/src/11-native-tools.js` | 新增 `codebaseSymbolSearch(root, args)` 实现（紧邻 `docsSearch` 之后，复用 `walkFiles`/`readIfExists`） |
| `app/src/12-tool-dispatch.js` | `CODE_TOOL_HANDLERS` 加 `codebase_symbol_search`（`paths:'read'`，handler 内 `guardFileToolPath` 读闸 → `codebaseSymbolSearch(root, args)`） |
| `app/src/07-autonomy.js` | `NATIVE_TOOL_PACKS` 加 `codebase_symbol_search: 'code'`；`NATIVE_TOOL_TIER` 加 `codebase_symbol_search: 'read'` |
| `app/src/13-http-router.js` | `MCP_TOOLS` 加 `codebase_symbol_search` schema（§2.2） |

---

## 4. 入库全部门（第 49 波纪律，逐项落）

| 门 | 落地 |
|---|---|
| **契约** | §2 的 schema/返回形状即契约；e2e 逐条直调断言（见 §6） |
| **fake 回归** | 内置工具无独立 fake-mcp 镜像（那是桥接 ACC 的纪律）；等价物 = 新 e2e `codebase-symbol-search.e2e.js` 直调 `/api/tools/codebase_symbol_search`，覆盖定义/引用分类、符号转义、kind 过滤、敏感子树跳过 |
| **description 审计** | `MCP_TOOLS` 的 description 遵守「何时用 + 何时别用 + 参数约定」三要素（见 §2 实现时的 description 文案）；内置工具无 `smoke_descriptions.py`（那是 ACC 专用），本波以「description 含 use-case + non-use + 参数语义」为人工审计标准 |
| **行为锁** | `tool-dispatch.e2e.js` L1 工具数 `55 → 56`；L4 注册表键集 === `NATIVE_TOOL_PACKS` 键集（两处同步加，否则锁红）；L5 tier 无孤儿 |
| **门面数字** | `facts.json` `nativeTools 55 → 56`（跑 `node dev-harness/facts-generate.js` 生成）；新增 e2e 使 `e2eCount 219 → 220`（`facts.static.e2e.js` 目录重算自动覆盖） |
| **构建** | `node app/build.js` 重建 `app/server.js`；`facts.static.e2e.js` 的产物版本/原生工具数断言随之通过 |

---

## 5. 消融设计（M4 工具轴，后续执行）

本工具落在 M4 三轴的**工具轴**（注入的工具集）。收益验证分两步（按 `10-m4-ablation.md` §3.2）：

1. **单轴对比**：codebase-audit 模板「注入 `codebase_symbol_search`」vs「不注入」跑 HB360 固定子集，记三指标（outcome / process / cost）独立收益。
2. **全量对比**：开全量项对比累进，验证无回退。

**本波不跑**（见 §7 诚实性）：真正 HB360 回测需固定 benchmark + holdout + 真实 provider，属后续。模板接入（§6.2）作为消融前置动作已完成。

---

## 6. 验收（本波）

1. 新 e2e `codebase-symbol-search.e2e.js` 全绿：定义/引用分类正确、含元字符 symbol 不崩（转义生效）、`kind` 过滤、`files[]` 文件级聚合、返回含 `note` 诚实标注 grep 级；`root` 走 `guardFileToolPath` 工作区读闸（与 `file_search`/`file_list` 同闸，远端/无 provider 模型越界读被拒），不再仅靠 `walkFiles` 敏感子树跳过。
2. `tool-dispatch.e2e.js`（L1=56、L4 键集一致、L5 tier 无孤儿、**B4 六工具越界读同闸拒绝**）、`facts.static.e2e.js`（nativeTools=56）全绿。
3. `node app/build.js` 重建后 `facts.static` 产物断言通过。
4. 相关回归：`search-robust.e2e.js`（共享 `walkFiles`/正则基建不受影响）、`file-guard.e2e.js`（root 越界闸）。

---

## 6.1 对抗验证收口（2026-08-13）

首版提交后经 critic 子代理对抗审查（verdict UNSAFE），亲验并修复 3 处：

1. **HIGH 越权面**：`codebase_symbol_search` 漏接 `guardFileToolPath` 工作区读闸（`paths:null` + 直接 `resolveFileToolRoot`），远端模型可传越界 `root` 把符号匹配行（代码内容）确定性外传。**修复**：接 `guardFileToolPath`、`paths:'read'`（与 `file_search`/`file_list`/`glob`/`project_snapshot` 同闸）。**顺带收口**：同族 `dependency_inventory`/`code_review_scan`/`frontend_audit`/`claude_md_audit`/`docs_search` 五工具是同一逃逸（`project_snapshot` 第 41 波「首擒」证明此类漏接反复出现），一并接闸（用户拍板）。
2. **MEDIUM 逻辑矛盾**：`files[]` 聚合不按 `kind` 过滤 → `kind='definition'` 时顶层 `referenceCount=0` 但 `files[].references>0`。**修复**：聚合按 `wantDef`/`wantRef` 过滤，与数组一致；`truncated` 改 `hitCap` 语义（第 maxResults+1 条才置 true，恰好满时不误报）。
3. **顺带**：原生 `file_edit` 的 `$` 展开 bug（`raw.replace` 把 newText 当 replacement 展开 `$&`/`$1`）改为 `split/join` 字面替换；ACC `edit_file` 用 Python `str.replace` 无此 bug（已核实，无需改）。

e2e 补断言：`(g)` 越界 root 拒绝、`(c)` `files[].references` 一致性、`(h)` `$dollarVar` 元字符字面精确命中、`B4` 六工具越界读同闸拒绝。

---

## 6.2 模板 prompt 接入（2026-08-13）

把工具接入 codebase-audit 模板的 prompt 引导（`08-agent-runs.js` `BUILTIN_AGENT_WORKFLOWS`，纯文本层、零迁移——不增删节点、不改 role/gate/依赖）：

1. **模板 `description`**：追加「审计全程优先用 `codebase_symbol_search` 检索符号真实定义/引用，以文件:行证据为准，勿凭名称相似下结论」。
2. **`map` 节点（explorer）**：建地图时引导「用 `codebase_symbol_search` 抽查关键符号/函数/类的定义与引用，确认模块、入口点与依赖真实存在、命名与文件对应，不要凭名称猜测」。
3. **`verify` 节点（critic，高风险证据门）**：对抗核验时引导「对发现中引用的符号/函数/类，用 `codebase_symbol_search` 反查其定义与调用是否真实存在、文件:行是否对得上，否证幻觉与名称相近的误判」。

工具可见性无需额外改动：`codebase_symbol_search` 是 read tier 且已入 `MCP_TOOLS`，`buildOpenAiTools` 按 `tierFilter` 注入时 read 工具对所有 read/edit/exec 子代理可见（`07-autonomy.js:1402`）。回归：`agent-workflow-templates.e2e.js`、`prompt-snapshot.static.e2e.js` 全绿。

---

## 7. 本文档未做项（诚实性）

- **grep/ctags 级，非 AST 级**：定义/引用分类是关键词启发式，方法定义与调用、重载、跨文件符号解析不在本版能力内（07 §7 明确初版只能「够用」级）。
- **不跑 HB360 消融**：§5 的收益验证留待首个工具入库稳定后、以真实 provider 回测执行。
- **debug-root-cause / data-insights 两个候选本波不做**：遵守「一次只做一个」，待本工具消融验证收益后再逐个启动。
