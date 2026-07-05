# 第三方声明 · Third-Party Notices

如意 Ruyi(Ruyi Workbench)本体在 Apache-2.0 下发布(见根目录 `LICENSE`)。
本文件逐项列出仓库随附或可选依赖的第三方组件及其许可义务。**所有列出的静态库均随仓库分发**;
标注为「可选/不随仓库分发」的组件由用户自行安装。

> clean-room 说明:本项目不含 Anthropic 泄露源码、不分发官方 Claude CLI、不复制第三方插件源码。
> 详见根目录 `README.md` 的 clean-room 声明段。

---

## 1. 随仓库分发的前端静态库

位置:`ruyi-workbench/app/public/vendor/`

| 组件 | 版本 | 许可 | 上游 | 说明 |
|---|---|---|---|---|
| marked | 12.0.2 | MIT | https://github.com/markedjs/marked | Markdown 解析/渲染(`marked.min.js`)。Copyright (c) 2011-2024, Christopher Jeffrey 等。 |
| highlight.js | 11.9.0 | BSD-3-Clause | https://github.com/highlightjs/highlight.js | 代码高亮(`highlight.min.js`)。(c) 2006-2023 Ivan Sagalaev 及贡献者。 |
| highlight.js 主题 · GitHub(light) | 随 highlight.js 11.x | BSD-3-Clause | https://github.com/highlightjs/highlight.js/tree/main/src/styles | 高亮亮色主题(`github.min.css`)。取自 GitHub 语法配色,Maintainer @Hirse。 |
| highlight.js 主题 · GitHub Dark | 随 highlight.js 11.x | BSD-3-Clause | https://github.com/highlightjs/highlight.js/tree/main/src/styles | 高亮暗色主题(`github-dark.min.css`)。取自 GitHub 语法配色,Maintainer @Hirse。 |

### 许可全文摘要

**MIT(marked)**

```
Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
to whom the Software is furnished to do so, subject to the inclusion of the above copyright
notice and this permission notice. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND.
```

**BSD-3-Clause(highlight.js 及其 GitHub 主题)**

```
Redistribution and use in source and binary forms, with or without modification, are
permitted provided that the following conditions are met: (1) retain the copyright notice,
(2) reproduce the copyright notice in documentation/materials, (3) neither the name of the
copyright holder nor the names of its contributors may be used to endorse or promote products
derived from this software without specific prior written permission. THE SOFTWARE IS PROVIDED
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES ARE DISCLAIMED.
```

> 各库完整许可文本随其上游仓库分发;上表 SPDX 标识与上游地址足以定位原文。

---

## 2. 可选二进制(不随仓库分发,用户自装)

| 组件 | 许可 | 上游 | 说明 |
|---|---|---|---|
| ripgrep(`vendor-bin/rg.exe`) | MIT 或 Unlicense(双许可) | https://github.com/BurntSushi/ripgrep | grep 快路径可选加速。**不进最小 overlay、不随本仓库分发**;用户自行放入 `ruyi-workbench/vendor-bin/rg.exe` 即被探测启用,缺失时自动降级为纯 JS 扫描。其 MIT/Unlicense 许可可再分发,若发行方选择随包附带需一并附上其许可。 |

> 便携 git 等 GPL 系二进制**有意不纳入** vendor-bin(GPLv2 再分发义务)。

---

## 3. ai-computer-control(ACC)桌面控制子项目的 Python 依赖

ACC 是独立打包的桌面控制 MCP。其运行时依赖在 `mcp/ai-computer-control/requirements_offline.txt` 中声明,
**各依赖遵循各自的上游许可**(未在本文件逐条转录;安装/打包离线 wheels 时应核实并按各自许可履行义务)。
概览(非穷尽,以 `requirements_offline.txt` 为准):

| 依赖 | 典型许可 | 用途 |
|---|---|---|
| mcp[cli] | MIT | MCP 协议实现 |
| pyautogui | BSD-3-Clause | 键鼠自动化 |
| Pillow | MIT-CMU(HPND) | 图像处理 |
| pywin32 | PSF-2.0 | Windows API |
| psutil | BSD-3-Clause | 进程/系统信息 |
| playwright | Apache-2.0 | 浏览器自动化(顶层 import 已守护降级) |
| python-docx | MIT | Word 读写 |
| openpyxl | MIT | Excel 读写 |
| pdfplumber | MIT | PDF 文本抽取 |
| pyperclip | BSD-3-Clause | 剪贴板 |
| reportlab | BSD(见上游 LICENSE) | PDF 导出(`write_pdf`,可选降级) |
| uiautomation | Apache-2.0 | UI Automation 无障碍树(可选降级) |
| comtypes | MIT | COM 绑定(uiautomation 运行时依赖) |
| winsdk | MIT | Windows.Media.Ocr 离线 OCR(可选降级) |
| opencv-python-headless | Apache-2.0(wrapper;OpenCV 本体 Apache-2.0) | 多尺度模板匹配(可选降级) |
| numpy | BSD-3-Clause | 数值计算 |
| python-pptx | MIT | PowerPoint 生成(`write_pptx`,可选降级) |
| matplotlib | PSF-based(matplotlib 许可,BSD 兼容) | 图表出图(`chart_image`,可选降级) |
| XlsxWriter | BSD-2-Clause | Excel 写入(python-pptx 相关链路的传递依赖) |
| lxml | BSD-3-Clause | XML 处理(python-docx / python-pptx 的传递依赖) |

> **pynput(LGPL-3.0)** —— 用于宏录制(`record_start` / `record_stop`,缺失时相关工具优雅降级)。
> 本仓库**仅以依赖名引用 pynput,不在仓库内分发其任何代码**;用户经 `pip` / PyPI 自行获取,其源码可从 PyPI 及上游获得。
> 以依赖形式动态链接使用 LGPL 库时,义务主要落在**分发其二进制/wheels 的发行方**;本仓库不承载其 wheels。

> 上表为便于审阅的概览;确切版本与许可条款以实际安装的 wheels 元数据(`*.dist-info/METADATA`、`LICENSE`)为准。

---

_本文件随组件增删更新。如发现遗漏或错误,请提 issue。_
