# 第三方声明 · Third-Party Notices

如意 Ruyi(Ruyi Workbench)本体在 Apache-2.0 下发布(见根目录 `LICENSE`)。
本文件逐项列出仓库随附、随发行包分发的第三方组件及其许可义务。**§1 的前端静态库与 §2 的 ripgrep 二进制都已提交在仓库里**,
打包脚本会把它们随发行包一起带走;§3 的 ACC Python 依赖不进仓库,由 Full 发行包随附的离线 wheels 分发。

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
| mermaid | 11.17.2 | MIT | https://github.com/mermaid-js/mermaid | 流程图/时序图等 Mermaid 渲染(`mermaid.min.js`,懒加载)。Copyright (c) 2014-2024 Knut Sveidqvist 及贡献者。 |

> mermaid 说明(109a):`mermaid.min.js` 取自上游 MIT 发布物,**已提交在仓库里**
> (`ruyi-workbench/app/public/vendor/mermaid.min.js`),Slim 与 Full 发行包都随 `app/` 整树带上它。工作台对它做懒加载
> (首次遇到 ```mermaid 围栏才注入本源脚本);文件若被删掉,图表降级为普通代码块加一行提示,不联网、不报错。

### 许可全文摘要

**MIT(marked、mermaid;ripgrep 的 MIT 全文见 §2)**

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

## 2. 随仓库与发行包分发的二进制

| 组件 | 版本 | 许可 | 上游 | 说明 |
|---|---|---|---|---|
| ripgrep(`ruyi-workbench/app/vendor-bin/rg.exe`) | 14.x(二进制内嵌的手册页日期为 2024-09-08,与上游 14.1.1 的发布日期相符;精确版本以该文件的 `rg --version` 为准) | MIT 或 Unlicense(双许可,发行方任选其一) | https://github.com/BurntSushi/ripgrep | 上游官方发布流程产出的 Windows 预编译二进制(文件内的构建路径指向上游 GitHub Actions)。Copyright (c) 2015 Andrew Gallant。用于 `file_search` 的快路径,并在服务启动时加进服务进程的 PATH 前部,让模型在终端里也能直接跑 `rg`。`app/` 整树随 Slim 与 Full 发行包一起带走,覆盖包也把它列为可选载荷(文件存在就一并打进去)。文件缺失时 `file_search` 静默退回纯 JS 扫描器,功能降级、不报错。 |

**MIT(ripgrep)**

```
The MIT License (MIT)

Copyright (c) 2015 Andrew Gallant

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

> `rg.exe` 是预编译的单文件,里面静态链接了若干 Rust 依赖(均为 MIT / Apache-2.0 / BSD / Unlicense 一类宽松许可);
> 逐条清单以上游对应版本的 `Cargo.lock` 为准。上游的 Unlicense 文本见其仓库根目录的 `UNLICENSE`。
>
> 便携 git 等 GPL 系二进制**有意不纳入** `vendor-bin`(GPLv2 再分发义务)。

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

## 4. 随产物分发的数据

| 数据 | 许可 | 上游 | 说明 |
|---|---|---|---|
| Unicode 汉字数据库 Unihan(读音字段 kMandarin、kXHC1983) | Unicode License v3 | https://www.unicode.org/charts/unihan.html | 语音词库判断「改动读音像不像」用的汉字 → 普通话读音小表(`ruyi-workbench/app/src/04j-hanzi-pinyin.js`,随 `server.js` 分发)。只取 CJK 统一汉字基本区 U+4E00–U+9FFF 有读音的 20,898 字,去掉声调后重新编码;由 `dev-harness/hanzi-pinyin-generate.js` 从 `Unihan_Readings.txt` 生成。本次生成所用的读音取自 npm 包 cjk-unihan 0.0.3 所附 Unihan 原样转储(SQLite)。Copyright © 1991-2024 Unicode, Inc. |

**Unicode License v3(Unihan)**

```
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2024 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY DOWNLOADING, INSTALLING,
COPYING OR OTHERWISE USING DATA FILES, AND/OR SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE
TO BE BOUND BY, ALL OF THE TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO
NOT DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a copy of data files
and any associated documentation (the "Data Files") or software and any associated
documentation (the "Software") to deal in the Data Files or Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
and/or sell copies of the Data Files or Software, and to permit persons to whom the Data
Files or Software are furnished to do so, provided that either (a) this copyright and
permission notice appear with all copies of the Data Files or Software, or (b) this
copyright and permission notice appear in associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT OF THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE BE LIABLE FOR ANY
CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES, OR ANY DAMAGES WHATSOEVER RESULTING
FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall not be used in
advertising or otherwise to promote the sale, use or other dealings in these Data Files or
Software without prior written authorization of the copyright holder.
```

---

_本文件随组件增删更新。如发现遗漏或错误,请提 issue。_
