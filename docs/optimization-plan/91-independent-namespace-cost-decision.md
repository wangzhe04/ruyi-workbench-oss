# 91 · 独立文件命名空间与部署成本裁决

2026-10-21，承接 [90](90-claude-and-filesystem-feasibility.md)。用户明确要求同时评估实现和用户部署成本，复杂时暂缓并记录局限。ASR 继续暂停。

## 裁决与候选架构

**严格宿主文件命名空间暂缓实施，不作为当前 CLI 已支持能力。** 本轮交付依赖探针、候选合同和有限 Claude HTTP 兼容实验；没有建设或启用虚拟机。这是成本取舍，不是隔离验收通过，也不代表其余 3.1 发布门自动放行。

若以后恢复，优先验证完整 Hyper-V guest：独立系统盘、无虚拟网卡、只读脱敏投影介质；原项目、宿主 home、凭据和可写输出目录均不共享。guest 内 Claude 只连接本机 HTTP 入口，该入口通过固定 VM 身份和 service ID 的 Hyper-V socket 请求宿主 broker；真实上游凭据与 PrivacyCore 留在宿主。输出作为受限消息回传，不能把共享输出目录当作没有风险的附属功能。

这仍是待验证设计。需关闭增强会话、剪贴板、设备/磁盘重定向和不必要的集成服务，并审计 guest 可触达的其他 socket 服务。无网卡不等于所有宿主通道均已关闭；任意 guest 代码、子孙进程、手动挂载、路径替换、取消、崩溃和重启都须实际负例验证。不得用 guest 内可自行修改的代理环境变量或防火墙充当宿主强制边界。

微软文档确认 Hyper-V socket 可不经网络通信，宿主服务注册需管理员操作；它没有证明上述产品合同已经成立。见 [Hyper-V socket 官方说明](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/make-integration-service)。Sandbox 的网络和宿主文件映射是额外通道，默认配置还会启用剪贴板，见 [Sandbox 配置说明](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)。本轮未执行系统组件安装、服务注册或重启。

## 本机依赖与成本

[只读探针和详细成本表](../../dev-harness/privacy-m1/namespace/README.md)及[实际观察](../../dev-harness/privacy-m1/namespace/dependency-observation.json)保留在对应原型目录。观察到 hypervisor 存在，但 Sandbox 程序缺失；组件查询返回 COMException、Hyper-V VM 查询返回 VirtualizationException，均保持未知。WSL 查询成功及 Docker 可执行程序存在只能说明发现了入口，不能证明隔离可用。没有启动已有用户 VM、WSL 发行版或容器。

工程粗估 **21–45 人日**，由镜像与支持矩阵、生命周期与投影介质、socket broker、Claude 适配、边界和恢复测试组成；这是设计估算，未计独立安全审计、持续发行和支持，未知问题可能增加成本。不能把数日的模型文本 demo 等同于完整工具链产品化。

用户侧需要支持的 Windows 版本及虚拟化硬件、管理员权限，可能需启用组件并重启；还需 guest 系统授权、离线镜像和运行时交付、内存/磁盘预算、安全补丁和回滚清理。镜像按 GB 级预算，准确容量与启动时间尚未实测。系统版本和安装要求以 [微软 Hyper-V 安装说明](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/Install-Hyper-V)为依据；本项目尚未冻结最低支持矩阵，不承诺 Home 或企业受管设备可用。

这些成本与当前轻量离线工作台的部署方式差异较大，因此暂缓完整 VM 路线。LPAC 的 ARAP 反例仍成立；普通 WSL、关闭自动挂载、文件 API 包装都不能代替严格文件边界。未来恢复条件是接受部署门槛、取得可信离线镜像与许可、完成可管理 guest 和专用通信的实际验证。

## CLI 支持与发布边界

Claude 普通宿主 HTTP 基线与隔离验收分别记录，结果见[实验说明](../../dev-harness/privacy-m1/namespace-claude/README.md)。普通宿主没有 OS 外发限制，CLI 的禁遥测设置不构成网络强制；有限文本模型请求也不覆盖工具、恢复、缓存、附件或真实服务商协议全集。

冻结 Claude 2.1.202 的最终基线退出 0，实际一次请求经固定 HTTP 入口进入 broker，真实 assistant 与 success result 返回仅宿主持有的随机挑战。实际路径 `/v1/messages?beta=true` 仅作精确映射，未知查询和 HEAD 仍拒绝；最初严格路径拒绝的失败证据保留。合成 prompt 在宿主先投影，接收正文哈希与 broker 相等、没有原秘密；本次 broker 的新增匹配数为 0，不能描述为在真实 CLI 请求中再次发现了秘密。根进程已退出、临时目录已删除，不将此扩大为所有后代都经过 OS 隔离或回收证明。

严格隐私档位不能因为这一取舍而回退为普通宿主运行 CLI 并声称全链路脱敏。生产支持仍须明确拒绝不满足边界的路径，告知限制并保留已有可验收路径。3.1 的其余范围按 [86](86-3.1-completion-and-privacy-roadmap.md)继续；独立命名空间从强制补完改为暂缓研究，相关强隔离能力不能进入支持声明。

## 本轮审查与检查

两名 6.1 Sol 实现者交叉审查，主代理复核设计与证据。已处理 HTTP 观察日志任意路径/无界增长、失败退出码、输出上限、清理路径校验及源码绑定；最终文档补齐根退出不等于后代清理、预投影请求零新增匹配的限制。依赖/HTTP 六项测试通过，最终 Claude 九项源码哈希及依赖探针哈希匹配。没有产品代码改动，没有执行 VM 或严格隔离验收。
