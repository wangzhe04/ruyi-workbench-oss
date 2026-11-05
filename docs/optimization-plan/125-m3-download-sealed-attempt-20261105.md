# 125 · 下载路由密封读取：一次被依赖门拦下的尝试（2026-11-05）

尝试把下载路由（`GET /api/upload/content`）在启用态改为经 hook 读 sealed 附件（复用 206/416），
结果被 `module-dependency-graph` 门连续拦下，已**整体回退**；当前树仍是 `ba1eb581`（上传密封 + 检查点）的干净状态。
本片只记录这次尝试与教训，没有产品代码改动。

## 尝试内容

1. 新增 `13ay-work-data-attachment-download.js`，注册 `info(id)` / `read({id,start,end})`；
2. `13-http-router` 在启用态优先走 hook（未命中 sealed 再回退原始文件），并把 Range 解析抽成
   `singleByteRange(header,total)` 供原始/密封两条路共用。

## 被拦下的原因

- 新增模块后，图从 938 条边膨胀到 975 条，并报出两类问题：「新增循环边」与「新增前向/越层边」，
  大量边指向这个新模块（00-boot→13ay、01p→13ay、13-http-router→13ay …），`module-dependency-graph --check` 失败。
- 把下载 hook 合并进已存在的 `13ax` 后仍复现（972 条边），说明不是新模块数量问题，而是
  **扫描器把 hook 命名空间上的新增赋值/引用解析成了大量模块间依赖**（`WorkDataAttachmentDownloadHooks`
  与 `WorkDataAttachmentUploadHooks` 上的成员赋值在图上被当成 provider 关系）。
- 尝试直接让 13 引用 `01ak` 的第一版则更早被拦：巨型 SCC 从 31 涨到 34，超过静态上限。

## 回退与当前状态

- `git checkout` 回退 `00-boot` / `13-http-router` / `13ax` / `manifest`，重建 `server.js`（114926 行）与依赖图；
- `build --check`、`module-graph --check`（141 modules / 938 edges, SCC 31）、`module-dependency-graph.static` 全部通过；
- 工作区干净，停在 `ba1eb581`。

## 下一步（按依赖纪律）

1. 先读懂扫描器对「命名空间成员赋值」的解析规则（`dev-harness/module-dependency-graph.js` 的 tokenize/provides 段），
   确认 hook 的正确写法（可能需要把 sealed 读取实现放进已有模块的导出函数，而不是在命名空间上挂新成员）。
2. 再实现下载路由：优先复用 `13ax` 已注册的 hook，或把读取函数放进一个**零入边**的叶子模块（先例 13t）。
3. 加 HTTP 层用例时，用「先冷 enable 再起服务」的夹具（当前配置位在无加密代时会被归一为 false）。

版本仍 3.0.1，M3 未完成、未发布。
