# 19 · M5 实施文档 — data-insights 数据画像摘要工具（候选 D 波第三个）

> 关联：`07-microagent-lessons.md` §4 M5 / §5 候选 D 波、`17-m5-methodology-tools.md`（首个工具的入库/对抗范式）、`18-m5-debug-recorder.md`（第二个工具）。
> 基线：2026-08-13 工作树（`codebase_symbol_search` `700b055`、`debug_hypothesis` 已交付）。**先落文档再动代码**；M5 纪律 =「一次只做一个 + 过第 49 波新工具入库全部门 + 用 M4 单轴消融验证收益再做下一个」。
> 性质：本文档覆盖 **M5 三个候选中的最后一个**（data-insights 数据画像摘要）。到此 M5 三个候选全部落地。

---

## 0. 一句话结论

data-insights 模板的 `profile` 节点要求「字段与结构、规模、数据质量问题(缺失/异常/重复/格式)」，但模型靠 `file_read` 读几行 + 目测——大文件目测既费 token 又漏列。本工具 `data_profile` 把「数据画像」落成确定性机器统计：读取数据文件（CSV/TSV/JSON/JSONL/文本日志），返回行列规模、每列类型、缺失率、唯一值数、数值列的 min/max/mean/median/std + 离群点计数、以及样本值——替代 LLM 目测。

---

## 1. 问题

- `data-insights` 模板的 `profile` 节点（`08-agent-runs.js:1438`）要求机器级数据画像，但现有工具只有通用 `file_read`/`file_search`/`powershell_run`——模型要么目测（漏列、漏异常、费 token），要么写脚本（烧 exec tier、易错）。
- 论文式的「专门工具」把结构性统计交给确定性算法，LLM 只做语义判断（07 §1）。数据画像的「行数/分布/缺失/异常值」正是该交给机器的部分。

---

## 2. 工具契约

### 2.1 注册四元组

| 维度 | 值 |
|---|---|
| 工具名 | `data_profile` |
| pack | `code`（与 `codebase_symbol_search`/`debug_hypothesis` 同族） |
| tier | `read`（只读数据文件，无落盘/exec） |
| paths | `read`（handler 内 `guardFileToolPath` 读闸校验 path，远端模型越界读拒） |

### 2.2 inputSchema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "要画像的数据文件绝对路径(CSV/TSV/JSON/JSONL/文本日志)。" },
    "maxRows": { "type": "number", "description": "采样行数上限(默认 2000;先采样再统计,大文件不整读)。" },
    "delimiter": { "type": "string", "description": "CSV/TSV 分隔符,缺省按扩展名+内容嗅探(逗号/制表符/竖线)。" },
    "maxSampleValues": { "type": "number", "description": "每列展示的样本值数(默认 5)。" }
  },
  "required": ["path"]
}
```

### 2.3 返回形状

```json
{
  "ok": true, "path": "/abs/data.csv", "format": "csv",
  "rowCount": 2000, "colCount": 5, "sampled": true, "totalBytes": 123456,
  "columns": [
    { "name": "amount", "type": "numeric", "nonNullCount": 1990, "nullCount": 10,
      "uniqueCount": 87, "min": 0, "max": 9999, "mean": 123.4, "median": 50, "std": 88.8,
      "outlierCount": 12, "sampleValues": ["0", "1", "2", "9999", ""] }
  ],
  "note": "采样画像(grep 级启发式): 列类型/离群点是统计启发式,非数据血缘;CSV 引号内换行/转义由简单状态机处理,不保证 100% 兼容所有方言。"
}
```

- `columns[].type` ∈ `numeric` / `boolean` / `datetime` / `text`（启发式，见 §3.1）。
- `rowCount` = 实际采样/解析的行数；`sampled:true` 表示文件行数超过 `maxRows` 被截断采样。
- `outlierCount` = IQR 法（Q1−1.5·IQR / Q3+1.5·IQR 之外）离群点计数。

---

## 3. 实现方案（纯 JS，零依赖）

### 3.1 核心算法

1. `readIfExists(path, 1MB)` 读取（上限 1MB，超出截断并 `truncated:true`）。
2. 格式探测：扩展名（`.csv`→csv、`.tsv`→tsv、`.json`→json、`.jsonl/.ndjson`→jsonl）；无扩展名时按内容嗅探（首非空字符 `[`/`{`→json；逐行均能 `JSON.parse`→jsonl；含分隔符→csv/tsv；否则 text）。
3. 分格式解析（采样 `maxRows` 行）：
   - **csv/tsv**：简单状态机 CSV 解析器（处理引号内分隔符/换行、`""` 转义）；首行作表头，否则 `col1..colN`。
   - **json**：`safeJsonParse` 后取数组（或单对象）；数组每元素一行、键并集为列。
   - **jsonl**：逐行 `safeJsonParse`，键并集为列。
   - **text/log**：逐行为一行，无结构化列 → 返回 `rowCount` + 行长度统计 + 常见行首模式（非完整列画像）。
4. 列类型推断（启发式，逐列）：值全空→text；全 `true/false`→boolean；全 `YYYY-MM-DD`/ISO 时间→datetime；其余可解析为 number 的比例 ≥90% → numeric；否则 text。
5. 统计：非空/空计数、唯一值数；numeric 列 min/max/mean/median/std + IQR 离群点；每列样本值（前 `maxSampleValues` 个唯一值）。

### 3.2 代码切入点（共享作用域拼接，零 import）

| 文件 | 改动 |
|---|---|
| `app/src/11-native-tools.js` | 新增 `dataProfile(root, args)` 实现（紧邻 `debugHypothesis` 之后，复用 `readIfExists`/`safeJsonParse`） |
| `app/src/12-tool-dispatch.js` | `CODE_TOOL_HANDLERS` 加 `data_profile`（`paths:'read'`，handler 内 `guardFileToolPath` 读闸） |
| `app/src/07-autonomy.js` | `NATIVE_TOOL_PACKS` 加 `data_profile: 'code'`；`NATIVE_TOOL_TIER` 加 `data_profile: 'read'` |
| `app/src/13-http-router.js` | `MCP_TOOLS` 加 `data_profile` schema（§2.2） |

---

## 4. 入库全部门（第 49 波纪律）

| 门 | 落地 |
|---|---|
| **契约** | §2 schema/返回形状；e2e 逐条直调断言 |
| **fake 回归** | 新 e2e `data-profile.e2e.js` 直调 `/api/tools/data_profile`，覆盖 csv/tsv/json/jsonl/text + 列类型 + 缺失/离群 + 越界 root 拒绝 |
| **description 审计** | `MCP_TOOLS` description 遵守「何时用 + 何时别用 + 参数约定」 |
| **行为锁** | `tool-dispatch.e2e.js` L1 工具数 `57 → 58`；L4 键集一致；B4 加 `data_profile` 越界读断言 |
| **门面数字** | `facts.json` `nativeTools 57 → 58`、`e2eCount 224 → 225`（跑 `facts-generate.js`） |
| **构建** | `node app/build.js` 重建 `app/server.js` |

---

## 5. 消融设计（M4 工具轴，后续执行）

同 `17 §5`/`18 §5`：本工具落**工具轴**。data-insights 模板「注入 `data_profile`」vs「不注入」跑 HB360 固定子集，记 outcome/process/cost 三指标单轴收益。**本波不跑**（需真实 provider + 固定 benchmark/holdout）。

---

## 6. 验收（本波）

1. 新 e2e `data-profile.e2e.js` 全绿（18 断言）：五种格式解析、列类型推断、缺失/离群统计、越界 root 拒绝、JSONL 回落、极值列 `std=null`。
2. `tool-dispatch.e2e.js`（L1=58、B4 含 data_profile）、`facts.static.e2e.js`（nativeTools=58、e2eCount=225）全绿。
3. `node app/build.js` 重建后 `facts.static` 产物断言通过。
4. 模板接入后 `agent-workflow-templates.e2e.js`、`prompt-snapshot.static.e2e.js` 回归绿。

---

## 6.1 对抗验证收口（2026-08-13，主会话亲验）

首版经主会话逐项对抗审查 + 脚本实测（critic 子代理两轮被终止，改主会话亲验），确认 2 处真实缺陷并修复：

1. **MEDIUM——无扩展名/非标准扩展名的多行 JSONL 被误判为 JSON 而整体解析失败**（首字符 `{`/`[` 触发 sniff，`safeJsonParse` 对整个文件失败后直接报错，误拒合法数据）。**修复**：JSON 分支整体解析失败时回落逐行解析（成功 → `format:'jsonl'`），仍失败才报错。
2. **LOW——极值列（如 `[1e308, -1e308]`）使 `std`/`mean` 为 `Infinity`**，经 `JSON.stringify` 序列化后静默变 `null`。**修复**：统计值非有限时显式输出 `null`。

亲验排除（非缺陷）：BOM 表头（`String.trim()` 依 ES2015 规范剥离 `﻿`）、引号内逗号/`""` 转义、空列名（自动 `colN`）、全空列（`type:'text'` + `nullCount`）、坏 JSON 拒绝、越界 `path` 读闸拒绝。

e2e 补 `(d2)` 无扩展名 JSONL 回落、`(d3)` 极值列 `std=null` 两断言（现 18 断言）。

---

## 7. 本文档未做项（诚实性）

- **grep 级启发式，非数据血缘**：列类型/离群点是统计启发式；CSV 简单状态机不保证兼容所有方言（BOM、多字符分隔符、嵌入引号边缘）。不承诺 pandas/duckdb 级精度。
- **不跑 HB360 消融**：§5 收益验证留待后续真实 provider 回测。
- **不自动生成清洗脚本**：本工具只画像，不写代码；清洗/分析仍由 `analyze_main`/`analyze_cross` 节点按画像结论执行。
