# 独立命名空间：依赖调查

2026-10-21。本目录是只读依赖探针与候选设计，不是已实现的隔离运行器。ASR 暂停。`isolationPassed` 固定为 false，依赖发现不能作为文件边界或 Claude 模型成功证据。

```powershell
node dev-harness/privacy-m1/namespace/dependency-probe.js
node --test dev-harness/privacy-m1/namespace/dependency-probe.test.js
```

探针用自有临时 cwd，固定命令、12 秒期限、32 KiB 合计输出上限；超时/超限通过公共 killOwnTree 清理自有进程。临时目录在 finally 删除。PowerShell 仅查系统版本、hypervisor、可选组件、固定工具存在性及 VM 状态（不保存 VM 名称）。WSL 仅查 status/注册列表，结果仅保留退出码与是否非空，不保存发行版名称。它不启动 VM/distro/container、不读取凭据或修改配置。Docker 仅发现可执行程序；未证明 daemon 或容器可用。未知/权限错误保持 unknown。

期限是命令执行预算；公共 killOwnTree 的同步系统清理耗时另计，不能称为整个进程的硬实时上限。清理返回后 3 秒仍无 close，明确记录 `close-unconfirmed`，停止收集并返回失败观察；不把它当进程已消失。最终记录绑定探针 SHA-256，并核自有临时目录确已删除。正常 close 也不等于独立验证所有后代消失，本探针不启动 guest/工作负载，其清理标记仅指命令 close 与临时目录。

实际结果见 [dependency-observation.json](dependency-observation.json)：hypervisor 存在，Sandbox 程序不存在；可选组件查询 COMException，状态未知；Hyper-V cmdlet 存在，VM 查询 VirtualizationException；WSL 两项查询退出 0。尚未建立独立 guest 或观察其文件视图。

## 优先候选与尚缺依赖

优先完整 Hyper-V guest：独立 VHD，无虚拟网络适配器；固定 VMID/serviceID 的 Hyper-V socket 连接宿主 broker。宿主必须用 OS 机制鉴别连接 VM 身份，broker 只接受固定模型请求结构、固定上游目标和有界输出。Hyper-V socket 服务注册涉及 HKLM 与管理员权限，本轮没有注册。尚需明确支持的宿主版本/权限、可信离线 guest image 来源与许可、guest Node/Claude 运行时离线提供方式及 guest socket 客户端实现。

不映射原项目或任何可写宿主目录。只读模型投影优先用独立只读介质交付，guest 输出经有界 broker 消息回传；不把共享输出目录漏计为通道。关闭增强会话/剪贴板、磁盘/设备重定向、共享凭据及不需要的 guest 集成服务；guest 系统资源、VHD 自有存储、投影、输出/home/cache 分开列账。投影制作拒绝重解析点及多链接文件，介质制作与连接还须验证路径替换负例。

没有 NIC 只能减少网络通道；Hyper-V socket 仍须核实 guest 能触达的全部宿主 serviceID、宿主注册面和 broker 鉴权，不能只检查预期连接成功。普通 WSL 关闭 automount/interop 仍不证明手动挂载及其他宿主通道被禁止。Windows Sandbox 的无网络配置只能调查离线文件边界；默认网络不能据此满足固定 broker 合同。

## 进入运行设计前的门

以下均未运行，不能标成通过：父/子/任意 guest 后代读取与枚举宿主普通用户/ARAP 合成秘密；手动挂载宿主目录；共享与虚拟设备通道；连接非预期 socket 服务与联网旁路；只读投影写入；超额/非法输出；取消、重启、崩溃、路径替换。每项需宿主正控制、guest 明确回执、进程身份与清理验证。Claude 后续必须单列启动、初始化、真实模型提交、助手完成；不能把 guest 启动或依赖查询通过写成 Claude 通过。

当前阻断：缺可访问并可管理的专用 guest、离线镜像/CLI 依赖尚未冻结、socket 服务尚未注册与审计、边界负例矩阵未执行。没有安装/启用系统功能、修改既有 ACL/防火墙/用户配置或重启系统。

## 成本评估与暂缓建议

以下是设计阶段粗估，以熟悉 Windows/Hyper-V 的工程师为前提，不是交付承诺；未知运行时和系统权限问题可能扩大范围。

| 工作 | 粗估工程量 | 未解决风险 |
|---|---:|---|
| 冻结支持矩阵、离线镜像来源/许可、精简 guest | 3–7 人日 | 镜像合法分发、驱动、更新及最低主机条件 |
| 无 NIC VM 生命周期、只读投影介质、异常回收 | 5–10 人日 | 重启/崩溃遗留、路径替换与并发所有权 |
| Hyper-V socket broker、身份/协议/输出限制与服务面核查 | 5–10 人日 | Windows guest 客户端、额外 socket 服务及鉴权 |
| Claude 离线安装和固定 HTTP 模型网关适配 | 3–8 人日 | guest 初始化与 socket 传输尚未证实 |
| 恶意后代、手动挂载、生命周期矩阵和部署恢复测试 | 5–10 人日 | 宿主版本差异、维护升级后的边界漂移 |

合计约 21–45 人日，尚不含安全审计、持续发行与用户支持。第一项调查仍可能判定方案不适合本产品。

Claude 当前进度补充：普通宿主的有限 HTTP 文本轮已通过，见[独立基线](../namespace-claude/README.md)；它没有运行 guest，也没有 OS 网络限制。表内 3–8 人日仍指未来 guest 的离线交付、初始化及 broker 传输适配，不能将宿主通过直接算成 guest 工程已完成。

用户部署成本较高：需核验支持 Hyper-V 的 Windows 版本/版本号、固件虚拟化和硬件资源；功能安装与 socket 注册涉及管理员权限，启用系统组件可能要求重启。不能承诺 Windows Home、受管企业策略或现有虚拟化工具组合可用。离线 guest 镜像与 CLI/运行时通常按 GB 级预算，准确下载/磁盘/内存数值须由实际镜像测量；还需 OS 授权、离线更新、安全补丁、回滚与磁盘清理机制。对纯离线用户，依赖包和更新介质同样属于部署交付物。

Sandbox 仍依赖系统版本/组件和可能的重启，固定 broker 传输未解；普通 WSL/容器可能更容易启动，但需要额外宿主通道/挂载/daemon 权限审计，不能免费得到本合同；LPAC 已有 ARAP 反例；文件 API 包装只是兼容层。基于当前依赖未知和部署负担，建议严格文件命名空间方案暂缓产品承诺，只保留本探针、失败边界及候选设计，待明确接受部署成本后再开展 guest 原型。
