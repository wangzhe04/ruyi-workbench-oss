# 124 · 启用态上传走密封写入（2026-11-05）

上传路由在 `workDataEncryptionV1 === true` 时不再把附件写成明文：字节交给 `01ak` 封存，返回带 `sealed` 的
附件记录；OFF 路径完全不变。写入逻辑放在新模块 `13ax-work-data-attachment-upload.js`，通过
`WorkDataAttachmentUploadHooks` 命名空间挂接，`13-http-router` 不因此新增静态边。版本仍 **3.0.1**。

## 行为

- 启用态（配置位为真且存在加密代时）：`POST /api/upload` → `WorkDataAttachmentUploadHooks.sealUpload(body)`
  → `01ak.seal`（attachment face，`file_<16hex>`）→ 返回 `{id,name,size,createdAt,sealed:true,kind?}`。
  空附件返回 400 `upload.empty`；封存失败（密钥不可用、路径异常等）返回 503 `upload.sealed_unavailable`，
  **不会回退成明文写入**。
- 派生处理（OCR / 转写 / 压缩）在启用态暂不执行：它们需要读取密封字节，留待后续接线；记录里不带 `textPreview`。
- OFF 态：仍走 `makeAttachmentRecord`，字节与旧行为一致（`upload-range.e2e.js` 13 项仍全过）。

## 架构

- 新增 `13ax-work-data-attachment-upload.js`：`13-http-router` 只引用 `WorkDataAttachmentUploadHooks`
  （00-boot 的空命名空间），没有指向 01ak 的静态边，因此巨型 SCC 规模保持 **31**，`module-dependency-graph`
  与静态门全过（141 modules / 938 edges）。
- 首版尝试直接在 13 里引用 01ak，被 SCC 上限（>31）拒绝；改为 hook 后恢复。

## 验证

- 新增 `dev-harness/unit/work-data-attachment-upload-hook.test.js`：**3/3 pass** ——
  路径穿越名被消毒为 `evil.txt`、id 形如 `file_<16hex>`、真实 runtime 能读回原字节；
  空数据返回 `null`、非法 mime 回落；密钥不可用时 hook 直接抛错，目录里不留 `file_*` 明文残留。
- `build` 114926 行、产物新鲜；`module graph` 141/938 PASS、`module-dependency-graph.static` PASS；
  `facts` 455 unit / 629 e2e、`facts.static` 与 `route-inventory.static` 全过；README 模块数/套件数同步。
- **未覆盖**：启用态 HTTP 正向链路。`workDataEncryptionV1` 在无加密代时会被归一为 false，手工置 true
  进不了该分支；需要「先冷操作 enable，再起服务发请求」的夹具。已列入下一步。
