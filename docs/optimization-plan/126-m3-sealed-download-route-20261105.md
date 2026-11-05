# 126 · 下载路由密封读取（2026-11-05）

在 125 的失败之后定位到真正原因并做成：**命名函数表达式的名字会被依赖扫描器当成模块级 provides**，
`info` / `read` 这类常见名字因此跨模块撞名，一次新增 37 条假边。改成匿名箭头函数后，图仍是
**141 modules / 938 edges / 1 SCC**，下载路由可以安全接密封读取。版本仍 **3.0.1**。

## 行为

- `GET /api/upload/content?id&name` 在 `workDataEncryptionV1 === true` 且 hook 可用时：
  1. `WorkDataAttachmentUploadHooks.info(id)` 返回 `{totalBytes,sha256,mime}` 或 `null`（不是 sealed）；
  2. 命中 → 无 `Range` 时 200 全量；有 `Range` 时用 `singleByteRange(header,total)` 解析 → 206 + `content-range`
     或 416 + `bytes */size`；不回调原始文件路径（sealed 附件没有 raw 文件）；
  3. 未命中或 hook 不可用 → 保持既有原始文件路径（含词法 + realpath 包含校验）。
- 读取失败一律 404 `upload.not_found`，不返回半截内容。
- OFF 行为不变。

## 验证

- `work-data-attachment-upload-hook.test.js`：**4/4 pass**，新增 sealed `info` 与整读/区间读断言
  （`0..total` 与 `2..5`），未知 id 返回 `null`。
- `upload-range.e2e.js`（OFF 真实 HTTP）：**ALL PASS**（13 项）。
- `build` 114977 行；`module-dependency-graph --check` 141/938 PASS；`module-dependency-graph.static` ALL PASS。
- **未覆盖**：启用代下的 HTTP 正向链路（配置位在无加密代时归一为 false），仍需要「先冷 enable 再起服务」的夹具。

## 教训

写 hook 命名空间成员时，**不要给函数表达式起名**（`WorkDataHooks.read = async function read(){}`）；
用匿名箭头（`= async () => {}`）。扫描器把具名函数表达式登记为 provides，常见名字会与各模块本地符号撞名，
产生大量假依赖边与假循环。
