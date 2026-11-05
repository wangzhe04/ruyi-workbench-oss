# 111 · M3 附件 catalog 持久化（2026-11-05）

本片新增 `01aj-work-data-attachment-catalogs.js`：把 01ah 的 catalog 接到真实密封 store 上，提供两个面
（`attachment` / `toolImage`）的打开入口。仍然是草稿：上传路由、下载路由、工具图片路径都还没用它。
版本仍 **3.0.1**。

## 合同

- `create({root, keys, enabled})`：`root` 必须是绝对路径；`keys.snapshot()` 必备；`enabled()` 为 `false` 时
  `open()` 直接拒绝（`work_data_attachment_catalogs.disabled`），**不会**退化成明文 catalog。
- `open('attachment')` → `_catalog-attachments-v1.json`（purpose `session`、scope `sessions`）；
  `open('toolImage')` → `_catalog-tool-images-v1.json`（purpose `cache`、scope `index-cache`）。
  两个文件都用 `WorkDataStore.createText({chunked:true})`，与 107 的设计一致。
- 每个面各自一条 promise 串行链（按 `root + face` 记忆化），避免并发 `begin/seal` 丢行（含同一 root 的多个
  handle）；失败不阻塞后续写。**只保证单进程内串行**：跨进程并发写没有锁，靠 sealed store 的 AAD/认证在读取侧
  失败关闭，这一点在设计上仍未解决。

## 验证

- 新增 `dev-harness/unit/work-data-attachment-catalogs.test.js`：**4/4 pass**
  - 通过 01ai 封存 280 KiB → 换一个全新的 catalogs 实例重新打开 → 行仍是 `sealed`，01ag 读到原字节；
  - `enabled=false` 时打开被拒；`attachment` 与 `toolImage` 各自独立；落盘 catalog 是 `workData:3` 密文，
    明文中不含附件 id；
  - 同一 root 的两个 handle 并发 `begin` 不丢行（串行链按 root+face 记忆化）；
  - 同一 handle 并发 `begin` 两个 id → 两行都落盘。
- 全量附件相关单测：**17/17**（catalog 6 + 组合 3 + 写入器 4 + 持久化 4）。
- 生成物：`build` 114532 行；`module-dependency-graph --check` 138 modules / 927 edges；
  `facts` 452 unit / 628 e2e，两份 README 同步；`facts.static` ALL PASS。

## 边界与下一步

- 没有 HTTP/路由接线，没有迁移 codec，没有真实 NTFS 验收；adapter 仍 `pending`。
- 下一步：上传路由在 ON 模式下用 `catalogs.open('attachment')` + 01ai 封存并在成功后删原件；
  下载路由用 `catalogs.open` 得到的 authority 接 01ag（Range/206/416）；工具图片同理。
  之后再补迁移 codec 两族与真实 NTFS 验收，最后才改 adapter 状态。
