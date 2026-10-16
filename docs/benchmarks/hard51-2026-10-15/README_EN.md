# SWE-bench Pro V2 HARD-51 (51-task hard subset): Ruyi + DeepSeek V4.1 Flash

[中文](README.md) · **English**

**44 of 51 tasks resolved (86.27%), estimated model API charges CNY 42.15.** With an affordable model, Ruyi reached a completion rate close to selected flagship model and coding-harness combinations. This first-party local run took place on 2026-10-15 and was published on 2026-10-16. It is neither an official submission nor independent third-party certification.

## Model–harness comparison

These are selected results for the same SWE-bench Pro V2 **HARD-51** subset, not the full 642-task set. Official scores were checked on 2026-10-16. Differences use the board's rounded percentages, without inferring official task counts or ranks.

| Model | Harness | Reasoning configuration | Resolve rate | Ruyi minus this entry |
|---|---|---|---:|---:|
| GPT-6 Astra | Codex | high | 90.20% | −3.93 pp |
| Sonnet 5 | Claude Code | xhigh | 88.20% | −1.93 pp |
| GPT-5.6 Terra | Codex | xhigh | 86.30% | Close (−0.03 pp) |
| **DeepSeek V4.1 Flash** | **Ruyi** | Local provider configuration | **86.27% (44/51)** | — |
| Sonnet 5.5 | mini-swe-agent | xhigh | 70.59% | +15.68 pp |

Source: [official HARD leaderboard](https://labs.scale.com/leaderboard/swe_bench_pro_public_v2?tab=hard); [all 15 official entries in the captured snapshot](leaderboard-snapshot.json). The Sonnet 5.5 entry uses **mini-swe-agent**, not Claude Code; the Claude Code comparison is **Sonnet 5**.

The supported result is concrete: **Ruyi + DeepSeek V4.1 Flash reached 86.27% for roughly CNY 42 in model API charges, close to the listed flagship combinations.** This demonstrates Ruyi's ability to deliver engineering tasks. Different models, harnesses, reasoning configurations and execution environments do not isolate a harness's causal contribution or establish underlying model capability rankings. A fixed-model, fixed-budget, fixed-environment ablation would be needed for that claim; this run did not perform one. A single 51-task result is not a full-set score.

The board does not publish comparable per-run charges or timings. No competitor cost, speed or cost-efficiency multiple is inferred.

## Results, timing and cost

| Measure | Result |
|---|---:|
| Tasks | 51; 44 passed, 7 failed |
| Resolve rate | 86.2745098% |
| Run interval, UTC+8 | 2026-10-15 16:41:40–23:02:07 |
| Wall time | 6:20:27 |
| Sum of task solving time | 14:17:31 |
| Sum of grading time | 1:30:04 |
| Concurrency | Initially 2; up to 3 after 17:00:42 UTC+8 |
| Estimated model API charges | CNY 42.15462508 |
| Per attempted / resolved task | CNY 0.8266 / 0.9581 |

Wall time includes image preparation and Docker storage migration after the first model run began, excluding preparation before that point. Solving and grading totals sum concurrent tasks, so they exceed wall time.

| Billing category | Tokens | Estimated CNY |
|---|---:|---:|
| Cached input | 211,562,240 | 4.87812608 |
| Uncached input | 10,534,753 | 12.079523 |
| Output | 5,352,235 | 25.196976 |
| **Total** | **227,449,228** | **42.15462508** |

Input cache hit rate: **95.26%**. Charges include Ruyi auxiliary calls such as titles and compaction. Input includes repeated conversation context; output usage already includes provider-billed reasoning tokens and is not counted twice. This is a request-start-time list-price estimate, not an invoice. It excludes Codex orchestration, infrastructure, electricity and networking.

[DeepSeek pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/): on the run date, `DeepSeek V4.1 Flash` (DeepSeek-V4.1-Flash) peak rates per million tokens for cached input / uncached input / output were CNY 0.04 / 2 / 8; off-peak rates were 0.02 / 1 / 4. Peak windows are 09:00–12:00 and 14:00–18:00 UTC+8 on weekdays excluding Chinese public holidays. [results.json](results.json) includes the quantities and charges split by time band.

## Protocol and runtime identity

- **Ruyi 3.0.0 runtime build**; `app/server.js` SHA-256: `a80a4e1b6a6d6a13eb292f28135a1eb9f0fb2c676b7674cbf5dc1a297e3a5779`. This identifies the evaluated build, not every 3.0.0 build or a new run of the subsequent 3.0.1 release.
- The model was **DeepSeek V4.1 Flash**, called with the actual API name `deepseek-flash` through the local DeepSeek provider. Its configuration is not labelled as equivalent to another vendor's `high` or `xhigh` setting.
- Dataset: [SWE-bench_Pro-os](https://github.com/scaleapi/SWE-bench_Pro-os), pinned verifier commit `66f92766bba642462d4bbe5479e83f91f9211862`; HARD-51 ID-list SHA-256 `6e35e84708a26443e1746ae928940555a3188654c90f3a2eb691f4f699482bd1`.
- One fresh session and one model run per task; 50-minute solving limit and the original task.toml resources, 1 CPU / 4096 MiB. Up to three concurrent tasks, without voting or best-of-N selection.
- Ruyi ran on a Windows host. Repository operations used MCP `docker exec` in an offline task container. No external solution lookup, reference patches or hidden tests were provided to the model. No model retries or answer repairs after hidden-test feedback.
- Every patch was applied to a pristine official image and graded by the unmodified pinned verifier. Graders could use public networking for dependencies. This preserves those task conditions but **is not official Harbor execution or a leaderboard submission**. See the [official V2 protocol](https://github.com/scaleapi/SWE-bench_Pro-os/blob/66f92766bba642462d4bbe5479e83f91f9211862/v2/README.md).

## Published evidence and its limits

[results.json](results.json) includes all 51 instance IDs, official image digests, base commits, verdicts, required-test counts, timings, tokens, charges and model-patch SHA-256 hashes, including every failure. Required-test counts use the official parser's target set; they need not equal every test collected in the underlying pytest/Jest run.

Pre-publication checks covered 51 patch hashes, 255 original verifier-file hashes, verdict/reward agreement and all cost totals. The 85 audited host file/report calls cover validation evidence in isolated scratch directories and unsuccessful path/syntax mistakes. Successful repository changes and tests went through the container MCP; no audit items remain unresolved.

Complete trajectories, patch bodies and per-request receipts are retained locally. This public export contains sanitized summaries and hashes, without local machine paths, API credentials or raw provider responses. It supports checking the report's arithmetic and cost calculations; hashes identify retained originals but do not let readers independently re-grade unpublished patch bodies. The first task (local task index 33) uses real Ruyi turn usage plus the auxiliary ledger within one peak-rate window; other tasks use per-request accounting. No task has missing billing usage.

All seven failures retain their original verdicts: Ansible Galaxy cache handling; four Open Library author/MARC/observation tasks; Proton Mail API waiting; and qutebrowser process cleanup. No environment-error retry was used to improve these scores. Teleport was **6/6**, Flipt **7/7**, and Element Web **4/4**; all repository totals are in the JSON.
