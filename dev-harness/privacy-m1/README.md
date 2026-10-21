# M1 隐私边界原型

[86 号路线](../../docs/optimization-plan/86-3.1-completion-and-privacy-roadmap.md)规定版本范围；[88 号设计与结果](../../docs/optimization-plan/88-privacy-m1-prototypes.md)规定本轮实验合同。这里的代码均为独立原型，未接入生产发送路径。

最新成本取舍见 [91 号裁决](../../docs/optimization-plan/91-independent-namespace-cost-decision.md)：独立命名空间与严格托管 CLI 支持暂缓；Claude 普通宿主有限 HTTP 基线通过，不构成隔离证明。

此前 CLI 裁决按 [90 号记录](../../docs/optimization-plan/90-claude-and-filesystem-feasibility.md)：Kimi 的有限模型传输可行，严格文件视图有反例，Claude 的预加载/管道连通尚不能代替模型完成。历史证据保留原源码身份，重跑结果另存。

| 目录 | 作用 | 运行说明 |
|---|---|---|
| `egress/` | 第一方外发能力清册与变更复核 | [审计说明](egress/AUDIT.md) |
| `cli/` | Windows AppContainer/LPAC、子进程、文件/网络负控与 Kimi 专用管道网关实验 | [CLI 说明](cli/README.md) |
| `namespace/` | 独立命名空间只读依赖与成本调查 | [依赖说明](namespace/README.md) |
| `namespace-claude/` | 普通宿主 Claude 有限 HTTP 兼容基线 | [实验说明](namespace-claude/README.md) |
| `media/` | 本地 OCR、完整敏感区间映射、像素处理及派生上传 | [媒体说明](media/README.md) |

从仓库根目录运行各目录说明中的命令。需要 Windows/Full ACC 或已安装 CLI 的实验明确记录依赖缺失和未通过；不自动下载依赖、不访问真实模型、账号或用户媒体。CLI 和媒体行为实验建议串行运行，结果与普通离线全量 runner 分开维护。

源文件及小型汇总入库；合成媒体、临时程序副本和编译物只放自有临时目录并清理。清册生成件在 `docs/architecture/`，CLI/媒体证据在 `docs/optimization-plan/evidence/`。不要把运行输出散放仓库根目录。
