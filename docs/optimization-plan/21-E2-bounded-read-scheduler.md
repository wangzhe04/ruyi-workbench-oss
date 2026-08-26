# 21-E2 · 有界只读批次调度器（boundedReadSchedulerV1）

> 状态：**E2a 已实施（纯 read worker pool），E2b 待实施，E2c 重放脚本已上线**（决策日期 2026-08-17）
> 基座：21-E0/E1 已有代码，抽样／总量口径待校准；E2c 已有重放（历史结果见 §4.4），不等于新增收益已证明。
> 主动开关：`boundedReadSchedulerV1` 默认 `false`；当前先验证 E2a/E2c 增量，E2b 后排，主动实验串行。

> **2026-08-27 证据与顺序修订**：原 E2a → E2b → E2c 顺序改为先验证已有实现的增量，E2b 仍后排。可用构造夹具＋实际本地安全只读工具完成限定范围性能／正确性验证，不必等自然用户产生 >8 批；历史真实样本不足仍如实标记，不等于历史门已通过。开关继续关闭，本文不授权启用。与 [22 号方案](22-agent-soc-microarchitecture.md) §4／§6 共用准入纪律。

---

## 0. 决策摘要

把现有「宽度 2–8 且全为安全原生 read 的全有或全无并发」升级为：

1. **纯 read 批不再限宽**：`>8` 也并发，有界 worker pool 限流
2. **混合批提取只读并行岛**：同一连续安全 read 段可并发，edit/exec/control 保持原位串行

**已拍板的决策点：**

| 决策点 | 结论 |
|---|---|
| 5–8 宽批并发语义 | **B**：`concurrency = min(8, max(4, batchWidth))`。≤8 宽批保持现有全量并发（与现状逐字节一致），>8 才限流 8；min 4 只影响 worker 创建上限，不改变 ≤4 批行为 |
| 离线重放脚本 | **现在就做**：`dev-harness/read-pool-replay.js`，不依赖新真实数据（用假 provider + 已保存会话） |

**明确不做**：不把不同模型轮次的动作重排到一起（21 方案 §5.1）；不碰 bridge 并发（未声明 thread-safe 的 connector 一律不并发）；不改变 prompt、history、结果内容、权限语义。

**收益口径**：测量相对当前 legacy 的 `tool_phase p95` 与端到端耗时；不预先承诺下降。serial 只作诊断参照，已有并行收益不重新计价；**不**把模型调用数下降作为 E2 收益（调度只改工具阶段）。

---

## 1. 现状对照（已核实的代码事实）

| 现状 | 位置 | E2 改动 |
|---|---|---|
| 并行触发条件 `length > 1 && <= 8 && allSafeRead && !loopTrip`，`Promise.all` 全量并发 | `09-workflow.js` ~L2230-2260 | 放宽为 `>= 2`（>8 也进 pool），`Promise.all` 换成有界 worker pool |
| `PARALLEL_UNSAFE` 集合 + `!resolveBridge` + `nativeToolTier==='read'` 安全谓词 | 同上 | 原样复用，另加混合批分段变体 |
| 结果按 id 存 `parallelReadResults` Map，主循环按原顺序消费 | ~L2583 | 零改动——E2 只扩展 Map 的填充范围 |
| loop guard 预扫描命中 `LOOP_ABORT_AT` → 整批回退串行 | ~L2235-2242 | 保持整批回退语义（混合批任一 safe-read 命中 → 不提取岛） |
| `acquireResourceLease` 排队式、冲突挂起 + `onWait` + 死锁检测 | `07-autonomy.js` L3171 | 复用；排队时长差值为 `queueWaitMs` |
| spawn_agent 预派发在并行块之前（unsafe） | ~L2210-2223 | 保持原位不动 |
| 视觉回路：批截图经 `pendingToolImages` 批关闭后 flush | ~L2601-2607 | 岛内 read 返回图片同样适用（结果按 id 存表，主循环照常） |

---

## 2. 开关与配置（01-config.js）

```js
boundedReadSchedulerV1: false,   // 默认关，主动实验
boundedReadConcurrencyV1: 4,     // 默认并发；clamp 1..8；压力对照取 8
```

- 会话内 **session-sticky**：同一长会话中途不切换开关状态（21 方案 §11 纪律）
- canary 路径：5% → 25% → 默认评估；E3/E4 不与其同批主动开

## 3. 核心实现

### 3.1 并发公式（决策点 B）

```js
const poolWorkers = calls => Math.min(calls.length, Math.min(8, Math.max(4, calls.length)));
```

| batchWidth | workers | 与现状对比 |
|---|---:|---|
| 2–4 | = width | 逐字节等价（全量并发） |
| 5–8 | = width | 逐字节等价（全量并发，保留现状） |
| 9+ | 8 | 新行为：限 8 并发 |

### 3.2 安全判定谓词（复用现有 + 混合变体）

```js
const isSafeRead = tc => tc && tc.name && !PARALLEL_UNSAFE.has(tc.name)
  && !resolveBridge(bridgedRoute, tc.name) && nativeToolTier(tc.name) === 'read';
// 批级 loop-guard 预扫描沿用现有 simSig/simCount，命中 → 整批回退串行
```

### 3.3 有界 worker pool

```js
async function runReadPool(calls, { results, iter }) {
  let next = 0;                                  // 提交顺序推进，完成顺序可乱
  const workers = Array.from({ length: poolWorkers(calls) }, async () => {
    while (next < calls.length) {
      const tc = calls[next++];
      let res, lease = '', t0 = Date.now();
      try {
        const resources = inferToolResources(tc.name, pargs, null, workingDir, 'read');
        lease = await acquireResourceLease(`turn:${session.id}:${session.turnSeq}`, resources,
          ctrl && ctrl.signal, blockers => onEvent({ type: 'agent_resource', state: 'waiting', ... }));
        if (econOn && econSampledIter(iter)) econToolStartAt.set(String(tc.id), Date.now());
        res = await awaitProviderTool(tc, signal => toolCall(tc.name, pargs, { ... }), false);
      } catch (e) { res = { ok: false, error: ... }; }
      finally { releaseResourceLease(lease); }
      results.set(tc.id, res);
    }
  });
  await Promise.all(workers);
}
```

- `queueWaitMs` = `acquireResourceLease` 返回时刻 − worker 进入时刻，累加进 phase 事件
- 资源锁语义零变化：岛内同资源冲突由排队天然处理，不需要岛内额外互斥

### 3.4 混合批只读岛提取

```
输入 localToolCalls（保持原顺序）
1. 预扫描 batchLoopTrip → true 则整批回退串行（含纯 read 批）
2. 分段：沿原顺序把连续 isSafeRead 切为 island；unsafe 调用单独成"原位槽"
   例 [readA, readB, editC, readD, readE] → island1={A,B}, slotC, island2={D,E}
3. 每个 island 跑 runReadPool，结果入 parallelReadResults
4. 主循环按原顺序消费：island 命中取 Map，原位槽走串行
```

- island 之间不跨越 unsafe 调用（"连续"硬约束）
- unsafe 槽内权限决策、资源锁、loop guard 拒绝逻辑与现状一致
- spawn_agent 预派发保持原位（绝不进岛）

### 3.5 不变式（验收硬线）

1. **配对铁律**：每个 tool call 恰有一个 result 或显式 skipped/refused（assistant.tool_calls → 连续 role:'tool' 不劈块）
2. **顺序**：执行完成顺序可不同；写入 providerHistory / `tool_result` 顺序必须与 assistant tool_calls 一致
3. **loop guard / 权限 / checkpoint / steer / 资源锁**：逐字节或语义等价
4. **中断**：abort/steer 中断后，批内未执行调用补配对 refusal（复用 loop_abort 模式）

### 3.6 埋点扩展（兼容 E1，旧事件无字段默认旧值）

`tool_phase_completed.strategy` 扩展：`parallel`（≤8 全量）→ `pool_read`（>8 纯 read 批）、`pool_island`（混合批岛）、`serial`（含回退）。新增 `queueWaitMs`。
E1 报表 `batchShape` 增加 `poolReadBatchShare / islandBatchShare`，与 E0 时段基线对比归因。

---

## 4. 数据门与验收

### 4.1 前置：计量校准 + 固定本地基准／离线重放（2026-08-27 修订）

2026-08-17 历史样本中 >8 纯 read 批为 **0**、混合批稀少，不能从该批数据推断新增收益。**无需等待长期使用积累**：先构造 ≤8／>8／混合批、文件大小和冷热读、资源竞争、故障与取消夹具，使用真实本地安全只读工具测量；假 provider 用于协议与调度验证，sleep 假工具不能代表实际 I/O 收益。E1 口径校准或可独立对账的基准计数是正式报告前置。

已有 **`dev-harness/read-pool-replay.js`** 可复用为历史重放来源；新增夹具／实际工具基准需单独交付并标明执行方式，不能仅凭模式名声称实际运行了不同并发度。已有记录重放仅限在隔离测试资源中授权的白名单，不能把历史 read 一律视为无外部影响。报告包含：

- serial／当前 legacy／候选的 `tool_phase p95`、端到端占比与本地资源开销；正式收益对比候选与 legacy，原“相对 serial -20%”只保留为诊断，不能作为新增 pool 的放行证据；具体增量阈值在实验前冻结。
- 配对完整性、顺序、权限／锁／中断不变量、CPU／句柄／磁盘争用与小任务开销。
- 历史样本与构造样本分列，报告任务范围、实际工具／硬件、冷热状态、重复次数和不确定性。

历史样本不足仍标 `insufficient_wide_read_batches`；构造基准通过可形成限定范围证据并申请 opt-in／受控 canary，不冒称总体收益或强行扩大默认范围。长期真实流量用于扩围；没有当前对照的净收益则保持关闭。

### 4.2 e2e 回归清单（新增 `dev-harness/read-pool.e2e.js`）

| 场景 | 断言 |
|---|---|
| 12 个纯 read | 全配对、顺序一致、`strategy=pool_read`、criticalPath < serialEstimate |
| 混合批 read+edit+read | 两岛并行、edit 原位串行、结果顺序正确、`strategy=pool_island` |
| 权限拒绝（gate:'ask'） | unsafe 槽照常拒绝；岛不吞权限决策 |
| loop abort（5x 同签名） | 整批回退串行，拒绝结果配对完整 |
| steer 中断 | 批内未执行调用补 refusal，不劈块 |
| 同资源冲突（同路径多 read） | 排队计量入 queueWaitMs，无死锁 |
| bridge 工具 | 绝不进岛（隔离断言） |
| 开关 off | 行为与现状逐字节一致（>8 回退串行、混合批串行） |

### 4.3 压力对照

并发 4 vs 8 各跑一轮：CPU/句柄/provider 限流/UI 争用恶化 → 回退 4。`boundedReadConcurrencyV1` clamp 1..8。

### 4.4 重放首轮结果（2026-08-17，`node dev-harness/read-pool-replay.js`）

对真实会话库（48 个 `<id>.provider.ndjson`）离线重放：**254 个多工具 read 批、597 个调用**，四种调度 p95：

| 模式 | tool_phase p95 | 说明 |
|---|---:|---|
| serial | 187ms | 全串行基线 |
| legacy-2-8 | 139ms | 现状（≤8 全量并发） |
| pool4 | 139ms | 与 legacy 完全一致 → **决策 B 零回归证据** |
| pool8 | 139ms | 同上 |

- **pool 相对 serial p95 下降 26%**：现有并行能力已兑现主要收益
- **legacy == pool4 == pool8**：≤8 批下 worker pool 与全量并发墙钟等价，验证决策 B 不改变现有行为
- **`wideReadBatchesOver8: 0`（`insufficientWideReadBatches: true`）**：该历史数据中 >8 纯 read 批为零，未证明 E2 新增收益，开关保持关闭。2026-08-17 当时决定等待真实使用积累；**2026-08-27 改按 §4.1 先补构造夹具与实际本地工具基准**，不以长期数据作为限定范围验证的统一前置。该历史结果不改记通过或有新增收益。

---

## 5. 实施切片

| 切片 | 产出 | 状态 |
|---|---|---|
| **E2a** 纯 read pool | 放宽 >8、Promise.all → pool（并发公式 B）、queueWaitMs、strategy=pool_read | ✅ 已实施（2026-08-17），read-pool.e2e.js 14 断言全过 |
| **E2b** 混合批岛 | 分段提取、pool_island | ⏳ 待实施，先完成 E2a 增量验证；之后可用构造混合批验证边界与收益，不必等待长期真实样本 |
| **E2c** 重放 + 报表扩展 + 回归套件 | read-pool-replay.js（✅ 上线）、read-pool.e2e.js（✅ 上线）、E1 报表 batchShape 扩展（⏳） | 部分完成 |

每个切片独立 shadow/开关，主动实验串行（21 方案 §11/§12）。

---

## 6. 风险与停止条件

- E1 显示 tool phase 占总时长过低（如 <15%）→ 保留简单 pool，不扩混合批岛（21 方案 §13.3）
- 任何 pairing 回归（strict provider 400 卡会话）→ 立即关开关，先修配对
- 并发 8 导致 CPU/句柄/限流恶化 → 回退 4
- E2 与 E3 不同时主动开（单轴纪律）
- bridge 并发是永久禁区，不因 E2 收益而松动
