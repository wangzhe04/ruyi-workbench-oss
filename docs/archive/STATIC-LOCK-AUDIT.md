# 42a 静态锁大盘点 + 模块化成本实测报告

> 日期:2026-07-19 · 目的:为第 43 波「构建期拼接模块化」提供 go/no-go 决策依据。
> 一句话结论:**GO,走方案 A(有序切片 + 构建期拼接 + 产物字节级不变)**;迁移成本已被 src-reader 收口,预期锁零破损。

## 1. 盘点结果(机器扫描,非估算)

| 面 | 断言条数 | 分布文件数 | 说明 |
|---|---|---|---|
| 前端形状锁(app.js/index.html/css) | ~400 | 14 | workflow-editor-v2(58)、ui-v3-p2(53)、ui-v3-wave1(50)、usage-dashboard(48)、ui-v3-p3a(40)、ui-v3-p3b(37)、ui-v3-p1(23) 等 |
| 后端源码锁(server.js) | ~150 | 19 | monitor-incremental(30)、orchestrate-model-select(20)、autonomy-grant(18)、audit-w23(11)、meta-guard(11)、subagent-net-tools(11) 等 |
| **合计** | **~548** | **34** | |

后端锁按脆弱性分类:

| 类型 | 量级 | 抗拆分性 |
|---|---|---|
| 存在性锁(`/pattern/.test(src)` / `src.includes`) | ~120 | ✅ 拆分任意顺序均存活 |
| 计数锁(`match(...)≥N`) | ~10 | ✅ 拼接不复制文本即存活 |
| 排序/邻接锁(`indexOf(A)..indexOf(B)` 切片、函数体边界截取) | ~20,集中在 6 件(meta-guard 6、audit-w23 5、subagent-net-tools 3、monitor-incremental 2、autonomy-resume 2、autonomy-grant 2) | ⚠️ **声明顺序改变即破** —— 这是唯一的硬性约束 |

## 2. 已完成的收口(本波落地)

- 新建 **`dev-harness/src-reader.js`**:后端「逻辑全文」统一读取口。今天读单体 `app/server.js`;43 波后自动改读 `app/src/manifest.json` 清单按序拼接。测试永远面对逻辑全文,不关心物理布局。
- **19 件后端锁测试全部迁移**至 `readServerSource()`(一次性 codemod,逐件 `node --check` + 13 件可独立运行件全绿)。
- 全仓扫描确认:unit/、产品代码、其余 e2e **零直读残留**。
- 新规:新增源码锁一律 `readServerSource()`;安全关键不变量优先行为锁(41b 的 TOOL_DISPATCH 内省是样板)。

## 3. 43 波两个方案的成本实测对比

### 方案 A:有序切片 + 构建期拼接(产物字节级不变)

- 做法:`app/src/*.js` 是 server.js 的**连续区间切片**,`build.js`(零依赖,~100 行)按 manifest 顺序拼接出 `app/server.js` 产物;CI 校验「产物 == 拼接(src)」。
- 锁存活:**548 条全部原样存活**(产物字节级等于今天的 server.js,存在性/计数/排序锁无感知)。
- 代价:① 开发循环多一步构建 —— 由 run-all.js 起跑前自动做 freshness 校验(src 比产物新则拒绝并提示,一行 check)消解;② 拆分点必须选在顶层声明边界(排序锁的硬约束);③ 产物不注入 banner(保字节一致),源映射以 manifest 行区间表提供。
- 审计面:运行时产物仍是单文件、零依赖、气隙可审 —— **红线不变**。

### 方案 B:原生 ESM 拆分(FE1 前端先例)

- 做法:server.js 变薄入口 import ./src/*.js,无构建步。
- 锁存活:存在性/计数锁经 src-reader 拼接后存活;排序锁在 manifest 顺序保持时存活;**跨模块边界的邻接模式会破**(拼接处文本不再连续)。
- 代价:① 单文件审计故事终结,发行包/离线安装器必须携带 src/ 树;② `node --check`、syntax-gate、spawn 入口语义全部要重验;③ 与「产物单文件零依赖」红线冲突,需要正式修订红线。
- 收益:无构建步;但前端 FE1 已证明该模式可行,后端没有等量收益(后端不需要浏览器按需加载)。

### 决策:**GO —— 方案 A**

理由:548 条锁零迁移成本 vs 方案 B 的红线修订 + 打包面变更;build.js 复杂度低且有 FE1 的先例背书工程纪律。方案 B 留作构建器被证明脆弱时的降级预案。

## 4. 对 43 波的硬性约束(写进实施单)

1. **声明顺序 = 原单体顺序**,逐模块对应连续行区间;产物字节级 == 今天(首轮切片后 `git diff` 必须为空)。
2. 拆分点只选顶层声明之间的空行区;禁止在函数体/类体/大对象字面量内部下刀。
3. 产物无 banner、无包装;源映射 = manifest 的 `{module, startLine, endLine}` 表。
4. run-all.js 起跑前 freshness 校验;CI 加「build 幂等」校验(拼接(src) == 产物)。
5. 43 之后再做跨模块搬运时,触及的排序锁(~20 条/6 件)随搬运同步迁移 —— 已在 src-reader 之上,单点可控。

## 5. 风险残余

- **首轮切片的手工错刀**:18,476 行切 ~10 段,错一处字节级 diff 就红 —— 恰是好事,build + diff 校验让错刀无处遁形;用 codemod 按行区间机械切片,不手工搬。
- **require 钩子**:19 件测试里有 `require(SERVER)` 拿导出(TOOL_DISPATCH 等)—— 产物单文件,导出块不动,不受影响。
- **新增锁纪律回潮**:README + 本报告登记,评审时拦截。
