# 129 · 工具图片接入 toolImage face（2026-11-05）

工具结果图片（`toolimg_*`）在启用态不再落明文：`10-context-governance` 先试
`WorkDataAttachmentUploadHooks.sealToolImage`，返回 `true` 就跳过原写盘；下载 hook 的 `info/read` 现在
**依次查 attachment 与 toolImage 两面**；删会话时前缀清理之外再按 catalog 退掉 sealed 行。版本仍 **3.0.1**。

## 行为

- 写入（启用态）：`sealToolImage({id,name,mime,data})` → 以 `toolImage` face 调 `01ak.seal`（kind `tool-image`）。
  config 为假时返回 `null`，调用方照旧写原始文件；密封失败则 `stored=false`（该图不暴露、不落明文）。
  id 是内容哈希，重复截图会撞 `id_exists`：hook 捕获后若 `has(id)` 为真即视为成功（与明文路径「已存在则跳过」等价）。
- 读取：`info(id)`/`read({id,...})` 先查 attachment face，未命中再查 toolImage face；同 id 两面都命中时
  attachment 优先（两面的 opaque 目录本来就按 face 加盐，不会互相覆盖）。
- 删除：`removeSessionToolImages` 保留原来的前缀清理（清 OFF 遗留），随后调用 `removeToolImages(sessionId)`，
  把该会话标签下的 sealed 行 `retireSealed`；单行失败只跳过该行、不中断整批，hook 抛错被吞掉（行留给显式清理）。

## 验证

- `work-data-attachment-upload-hook.test.js`：**5/5 pass**，新增工具图用例：密封 → 重复密封仍成功（幂等）
  → `info` 返回 totalBytes/mime → 整读 → `removeToolImages` 退掉后 `info` 为 `null`。
- `tool-result-shrink` + `tool-dispatch-hardening`：**32/32 pass**（写入路径未回归）。
- `upload-range.e2e.js`：ALL PASS；`build` 115025 行；`module-graph` 141/939 PASS。
- **未覆盖**：启用态下真实工具图（需要代理跑一次带图的工具调用）在 HTTP 层写入/显示；目前只有 hook 单测。
- 已知性能边界：每次 `info/read` 最多两次 `has`，而 `has` 每次整读并解密 catalog（无缓存），随工具图数量线性。

## 下一步

1. 启用代 HTTP 夹具里加一张工具图（可直接调 hook 或经工具结果路径）验证显示与删除
2. 清册两面 adapter `pending → wired`
3. 回到 M3 其它面
