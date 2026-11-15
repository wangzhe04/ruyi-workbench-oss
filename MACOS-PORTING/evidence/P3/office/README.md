# P3-02：文档与图表单独本地验收

2026-11-07。实现提交 `bd2eb093fc85e05dfb36f63c9254fb24c271bfde`，分支 `codex/p3-macos-documents`。当前验证环境为 macOS 27.0.1 arm64、Python 3.12.10、Node 24.15.0。需求映射、命令结果和失败修复见 [validation.json](validation.json)，源码及 Git blob 对账见 [source-fingerprint.json](source-fingerprint.json)。

## 交付

- Office 样式在 Mac 使用本机中文字体；图表报告实际加载的字体 family，字体无法加载时保留准确提示和缓存警告。Windows 的微软雅黑默认保持。
- PDF 尝试将本机中文 TrueType 字体子集嵌入产物；依赖阅读器字体的 CID 回退明确给 warning。没有新增以字体选择器代替实际资源证明的 `font_embedded` 字段；空白 PDF 无字体资源的情况独立检查。
- `pdf_read_pages` 省略页码时读取实际存在的前 5 页，解决 1–4 页文件默认请求越界；显式越界、空页码和零页码仍拒绝。
- [固定样例输入](../../../../mcp/ai-computer-control/tests/fixtures/macos-office-sample.json)和 [60 项运行依赖锁文件](../../../dependencies/requirements-macos-arm64-cp312-office.lock.txt)已固定。ACC wheel 单独构建，61 个缓存 wheel 的名称、大小和 SHA256 见 [wheel-manifest.json](wheel-manifest.json)。本机字体不随源码分发。
- [渲染探针](../../../probes/render-office-samples.cjs)使用私有 HOME/profile/cache 和本机 Fontconfig，每次创建新的输出目录，避免零退出码和旧 PDF 形成假绿。

## 本包验收

- [新环境断网重放](offline.txt)：PIP_NO_INDEX/--no-index 从预备缓存安装非 editable wheel，pip check 无缺项，实际导入位置在新虚拟环境；没有 PYTHONPATH 指向源码。随后真实工作台 CLI MCP 代理调用实际 ACC，**24 项通过、0 失败、0 跳过**。六个写工具、四格式读回、五个目标检查点、每个写工具审计、HTTP 回滚都经过真实链路。原 Word 被覆盖后逐字节恢复，新 XLSX/PPTX/PDF/PNG 撤销删除。
- [独立产物检查](independent.txt)：**24 项通过、0 失败、0 跳过**。不同读取库核对完整样例数据、原生 Excel 图表、PPTX 三页和边界、实际 PDF 字体流、中文/English 文本、样例字形覆盖，以及 DOCX/XLSX/PPTX 内嵌图片的原始字节 SHA256 与 PDF 页栅格。也覆盖缺字体、损坏字体缓存警告、空 PDF 和渲染器旧结果负控制。
- 复用既有 [Office v2](office-v2-final.txt) **116 项**、[读取 v2](office-read-final.txt) **98 项**、[图表类型](chart-types.txt) **43 项**，均通过且无跳过。[原质量往返](office-quality.txt)通过，保留 23 条要点/25 行表格分页、数字/公式类型、Word 分页等原断言。新增 ReportLab 缺依赖和 1/3/7 页默认读取用例，没有删弱旧断言。
- [独立渲染](render.txt)与[内容读回](render-content.txt)：DOCX 1 页、XLSX 1 页、PPTX 3 页，均保留三座城市数据。加上实际生成 PDF 1 页，共六张 PNG 已逐张检查中文、数字、图表及裁切；本次最终包产出的渲染图与已目视检查的图像像素完全一致，见 [视觉对账](samples/renders/visual-comparison.json)。
- 完整单元 **2490 通过、18 既有跳过、0 失败**，见 [unit.txt](unit.txt)。首轮静态 **78/80**，见 [原始记录](fast-first.txt)；新增工作台专项带来的进程清册 344→345 和路由测试覆盖引用按实际刷新后，[进程门](process-safety-final.txt)及[路由门](route-final.txt)复测通过。其余 78 组复用未变范围的原证据，没有宣称另有一次完整 80/80 运行。
- [语法门](syntax.txt)：1126 文件、0 错误；[构建](build.txt)：生成物新鲜。Node 业务源码未改变，路由仍 175 个判定点、161 个鉴权行。
- [独立复核](review.json)最终无剩余代码发现。原三项发现均有关闭记录，默认 PDF 页码修复也完成定向复核。

## 可查看的产物

[Word](samples/report.docx)、[Excel](samples/data.xlsx)、[PPT](samples/slides.pptx)、[生成 PDF](samples/summary.pdf)、[图表](samples/chart.png)。

最终视觉证据：[Word](samples/renders/report.png)、[Excel](samples/renders/data.png)、[PPT 1](samples/renders/slide-1.png)、[PPT 2](samples/renders/slide-2.png)、[PPT 3](samples/renders/slide-3.png)、[生成 PDF](samples/renders/summary.png)。

[工具返回](samples/tool-results.json)、[独立读取明细](samples/verification.json)、[渲染文本](samples/render-verification.json)均来自受控固定样例，不包含用户资料。两个 `source-with-image` 文件是为原生图片提取额外构造的源夹具，原始五个工具产物另行保留。

## 失败与修复

真实 MCP 首轮以 edit 档调用现有 exec 档图表工具被拒，夹具改用正确代理，未放宽权限。短 PDF 的默认页码越界最终修复在生产读取器；夹具曾误传列表页码的验证错误也保留，最终用只传 path 的真实调用验证。

ReportLab 缺依赖的新增夹具先用错扩展名、随后仅阻断顶层模块而遗漏已缓存子模块。独立复核确认生产降级正确；夹具改为有效 PDF 路径及完整模块树移除/恢复后，缺依赖断言确实通过。旧读取套件首轮缺 fetch 是测试环境裁剪过窄，恢复完整平台支持工具集后全套通过，没有跳过该段。

首轮 LibreOffice 默认只看到自带西文字体，中文缺字，见 [初次渲染](render-first.txt)、[失败读回](render-first-check.txt)及[失败图](render-first-failure.png)。Arial 控制组同样失败，Mac 原生 QuickLook 中文正常，确认是独立渲染环境问题。探针私有 Fontconfig 加载系统字体后全量显示和提取通过，未通过更换产品字体掩盖问题。

渲染探针最初可能复用旧结果，独立复核用“当前无效输入 + 旧 PDF + 退出 0 但不转换的 renderer”复现假绿。现每次创建独立输出目录，同一负控制必须失败。

## 限制与下一包

**P3-02 Mac 开发与单独本地验收完成。** Windows 同候选实际 CI/实机仍未执行且未获豁免，保留为 P3 整体阶段关口；macOS 14 arm64/最低 wheel 部署目标、正式签名身份和干净机离线发行维持原 P3/P6 交接。字形验证只覆盖固定样例，不宣称所有 Unicode。P3 整体继续进行，下一包 P3-03 浏览器运行时。
