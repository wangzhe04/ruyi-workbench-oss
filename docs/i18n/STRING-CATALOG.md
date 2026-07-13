# 多语言文案目录与审校清单

`locales/zh-CN.json` 与 `locales/en-US.json` 是第一批可直接接入的产品 UI 文案包。它覆盖日常主路径和最容易造成英文界面“半中文”的系统反馈；后续迁移仅能复用其中语义相同的键，不能为了省事强行套用。

## 覆盖范围

| 域 | 资源前缀 | 当前主要来源 | 首批状态 |
|---|---|---|---|
| 通用操作与导航 | `common.*`、`navigation.*` | `index.html`、`app.js` | 已整理 |
| 会话、工作区、首启与聊天 | `session.*`、`workspace.*`、`onboarding.*`、`chat.*` | `app.js` | 已整理 |
| 权限、任务、变更与错误 | `permission.*`、`mission.*`、`changes.*`、`error.*` | `app.js` | 已整理 |
| 设置、模型、能力与用量 | `settings.*`、`provider.*`、`capability.*`、`usage.*` | `index.html`、`app.js` | 已整理 |
| 工作流、Agent、文件、审计 | `workflow.*`、`agent.*`、`file.*`、`audit.*` | `app.js` | 已整理 |
| 低频模态框、全部工具参数、MCP/ACC 结果 | 待审计 | `app.js`、`server.js` | P1/P2 |
| 模型提示词、日志、开发注释、测试描述 | 不进入 UI 资源 | 多处 | 单独流程 |

首批资源是“可见 UI 基线”，而不是对正则命中结果的逐字复制。例外包括代码注释、`PLAN:` 等协议文本、工具名、`read/edit/exec` 档位值、模型输出、文件内容与命令行内容。

## 使用与替换示例

| 现有模式 | 替换后 | 注意事项 |
|---|---|---|
| `el('button', '...', '新会话')` | `el('button', '...', t('session.new'))` | 创建时翻译，不要再扫描 DOM 反翻译 |
| `toast('工作目录已切换到 ' + dir, 'ok')` | `toast(t('workspace.switch.success', { directory: dir }), 'ok')` | `dir` 作为转义插值 |
| `confirm('删除该会话？')` | `confirm(t('session.delete.confirm'))` | 破坏性操作使用独立确认键 |
| `btn.title = '重命名'` | `btn.title = t('session.rename')` | 同时更新 `aria-label` |
| `` `${count} 条` `` | `tCount('session.messageCount', count, { count })` | 不在 JS 中手工处理英文复数 |
| 后端返回中文错误句 | `{ code, params }` + `t('error.' + code, params)` | 未知 code 可显示安全的通用错误 |

## 产品术语表

| 中文基准 | 英文推荐 | 说明 |
|---|---|---|
| 如意 Ruyi | Ruyi | 品牌不翻译；首次可写作 “Ruyi Workbench” |
| 本地优先 | local-first | 不用 *local only*，产品仍可连接模型端点 |
| 内网或离线环境 | intranet or offline environment | 不再用“气隙”；只有确指物理隔离时才用 *air-gapped* |
| 工作区 | workspace | 指用户授予访问范围的文件夹 |
| 工作台 | workbench | 指应用整体或主工作区域 |
| 简易界面 / 专家界面 | Simple mode / Expert mode | 避免 *beginner* 的能力贬义 |
| 权限模式 | permission mode | 不混用 authorization/access control |
| 检查点 | checkpoint | 文件变更前的可回滚快照 |
| 回溯 | rewind | 对话/会话状态的历史回退；文件使用 *revert* |
| 撤销 | revert | 明确“把已发生的变更还原” |
| 多 Agent 编排 | multi-agent orchestration | 工作流图与调度机制 |
| 工作流 | workflow | DAG 运行定义，不译作 pipeline 除非强调数据流水线 |
| 任务账本 | mission ledger | 长任务的里程碑与状态记录 |
| 自主推进 | autonomous progress | 用户可停止、可恢复的任务推进 |
| 授权书 | autonomy grant | 有效期、范围、次数受限的显式授权 |
| 能力矩阵 | capability matrix | 模型/端点支持能力的可视化 |
| 用量与成本 | usage and cost | 用量与计费数据，不写 *consumption* |
| 模型服务商 | model provider | 包含本机/内网兼容端点，不限定云厂商 |
| 工具调用 | tool call | 模型发起的一次受控工具请求 |

## 禁止机械替换的文本

1. **安全确认句**：保持风险、范围、是否可撤销和后果四个信息点；英文不能把“不可自动撤销”弱化为“可能无法撤销”。
2. **带路径、命令、错误详情的提示**：句子可本地化，动态值不可翻译且必须安全插值。
3. **模型提示词和结构化协议**：`PLAN:`、JSON 字段、工具名、角色 schema 是运行契约，需要评测而非人工直译。
4. **截图、说明文档与帮助内容**：UI 资源完成后另建 `README.zh-CN.md`/`README.en-US.md` 等文档本地化任务，避免文档与产品承诺漂移。
5. **品牌、供应商、许可证和标准名**：除解释性描述外不翻译正式名称。

## 审校负责人清单

- 产品：用语是否符合“非程序员可用、程序员不受限”的双模式定位。
- 工程：键语义、插值、复数、回退与 JSON 键一致性。
- 安全：权限、命令、文件删除、网络和不可撤销操作的风险表达不被弱化。
- 支持/文档：术语与 README、用户手册、设置帮助、错误排障文档一致。
- 英文母语审校：按钮长度、语气、大小写（sentence case）和 Windows 常用术语。
