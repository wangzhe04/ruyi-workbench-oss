# 套用 如意 Ruyi 增量覆盖包（overlay）

> 第53波 EC-B 安全更新中心加固版。overlay 增量包不重装整包,只覆盖变化的文件;套用前先 precheck(路径逃逸/完整性/版本兼容/幂等),失败即拒、绝不写入,且全程可审计、可回滚。

## 这份覆盖包做什么

把已部署的 如意 Ruyi 工作台升级到新版本:覆盖 `app/server.js`、前端 `app/public/*`、源码 `app/src/*`、`Start-Workbench.cmd` 等变化的文件。包内结构:

```
Manage-Overlay.cmd        薄封装(双击/命令行调用)
Manage-Overlay.ps1        受测核心(precheck/apply/rollback/verify/audit)
APPLY-OVERLAY.md          本文档
payload\                  落地文件(相对部署根的路径)
  update-manifest.json    每文件 sha256 + minHostVersion + version
  app\... Start-Workbench.cmd resources\... ...
```

## 两种套用方式

### 方式一:应用内更新中心(推荐,第53波 EC-B)

打开工作台 -> 设置 -> 「更新中心」页签(专家模式可见):

1. **选择 zip** -> 点「选择 zip…」挑本地 overlay 包
2. **预检** -> 点「预检」,展示变更预览(新增/覆盖/未变/移除)+ 版本兼容(宿主 vs 包要求最低版本)+ 四类预检结果
3. **应用** -> 预检通过后「应用更新」可用;同版本已应用会提示「强制重装」复选
4. **重启** -> 应用成功后提示重启工作台生效
5. **回滚** -> 「回滚到上一版」恢复最近备份;「刷新」查看当前状态与最近更新记录

失败时(预检拒绝/应用失败)给出失败恢复卡,可一键回滚。CLI 保留为救援路径。

### 方式二:命令行(救援路径)

```cmd
Manage-Overlay.cmd apply    "C:\...\Ruyi-offline"
Manage-Overlay.cmd rollback "C:\...\Ruyi-offline"
Manage-Overlay.cmd list     "C:\...\Ruyi-offline"
Manage-Overlay.cmd verify   "C:\...\Ruyi-offline"
```

第53波安全原语(GUI/API 编排用,CLI 亦可):

```powershell
# precheck:写入前全检 + 变更预览,不写一字节
Manage-Overlay.ps1 -Action precheck -OverlayRoot <解压包> -Target "C:\...\Ruyi-offline" [-Json] [-Force]
# audit:查看 .overlay-audit.jsonl 审计尾
Manage-Overlay.ps1 -Action audit -Target "C:\...\Ruyi-offline" [-Json] [-Limit 50]
```

`-Json` 输出单 JSON 对象(供 API 消费);`-Force` 跳过幂等拒(同版本重 apply)/ rollback 端口拒。

## precheck 四类写入前拒绝(第53波 EC-B)

apply 前先内联 precheck 全检,失败即拒、绝不写入(backup 目录都不建):

| 类别 | 拒绝条件 | 防什么 |
|---|---|---|
| **路径逃逸** | manifest 条目含 `..`/盘符/绝对路径 | zip-slip 越界写(写到部署目录外) |
| **完整性** | payload 文件缺失或 sha256 != manifest | 篡改包 / 缺文件包 |
| **版本兼容** | 包 `minHostVersion` > 宿主 `package.json` version | 不兼容版本(如 2.0.1 宿主装要求 2.1 的包) |
| **幂等** | 同 `version` 已 apply 且无 `-Force` | 重复应用(明确拒绝语义) |

## apply 流程(`Do-Apply`)

1. **内联 precheck** 全检(失败即拒,绝不写入)
2. **备份** 目标里将被覆盖的每个文件 -> `目标\.overlay-backups\<版本>-<时间戳>\`
3. **覆盖** payload 文件复制到部署根
4. **标记 + 审计** 写 `.overlay-applied.json` + 追加 `.overlay-audit.jsonl`(seq/ts/action/version/result/fileCount/backup/error)
5. **post-apply verify** sha256 逐文件校验,结果决定顶层 `ok`/审计 `result`(`ok`/`verify_failed`,不再硬编码 ok)
6. 只保留最近 5 份备份

## rollback(可恢复)

`rollback` 恢复最近一次备份。CLI 默认拒(服务在跑别覆盖,先停进程);`-Force` 跳过(API 路径自动带,因 API 跑在服务内,文件覆写后 restart 加载恢复的旧文件)。新增的文件(如 vendor 库)会留下,无害。

## 故障恢复

- **apply 中途失败**:catch 块记审计 `failed` + backup 路径,可手动 rollback 恢复
- **verify 失败**(copy 成功但写入损坏):审计记 `verify_failed`,rollback 恢复原版本,用户数据不丢
- **审计可追溯**:`.overlay-audit.jsonl` 记录每次 apply/rollback 的结果,故障->恢复链完整可查

## 套用后验证

浏览器打开 `http://127.0.0.1:<端口>/health` 应返回 `{"ok":true,...}`;「体检」页签的 `overlay-integrity` 应为 `verified`。

## 出包要求(发布方)

- 产物新鲜:`build-overlay.js` 内部强制 `build --check`(产物==拼接 src),陈旧产物拒入包
- sha256 完整:`gen-manifest.js` 逐文件算 sha256 写 manifest,apply 前 precheck 校验
- 版本号:每包用不同 `version`(幂等预检);`minHostVersion` 自动从 `package.json` 注入
- 新增文件登记:`app/src/*` 经 `src/manifest.json` 自动纳入;非 src 新文件(如新 `public/js/*`、`resources/*`、`tools/*`)必须手动加到 `build-overlay.js` 的 `PAYLOAD_FILES`,否则 overlay 不覆盖 -> 存量部署停在旧版
- PS1 UTF-8 BOM:含中文注释,PS5.1 在中文系统上读 no-BOM 会破坏解析

发布前跑 `node dev-harness/release-dryrun.js --pkg`(含 overlay 包装配 + manifest sha256 对账 + Ruyi.exe 冒烟)。
