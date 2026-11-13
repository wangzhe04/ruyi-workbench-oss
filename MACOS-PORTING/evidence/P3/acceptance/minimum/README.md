# P3 最低部署版本静态审计补验

2026-11-07，补验实现 `d95cce74`；生产实现仍为 `2f45aba4`。当前执行宿主为 macOS27.0.1 arm64，未执行 macOS14。

准备的64个wheel（63个依赖和ACC）及必需完整Chromium缓存，检查98个arm64 Mach-O：最高声明最低版本14.0，无解析错误或超过目标项，见 [required-cache.json](required-cache.json)。原完整缓存包含最低要求15.0的 `ffmpeg-1013/ffmpeg-mac`，审计退出1，保留 [original-cache.json](original-cache.json)，不能声称该完整缓存支持14。

当前12个浏览器工具不录像。仅复制完整Chromium、不提供ffmpeg或headless-shell时，真实本地页面测试26项通过，覆盖启动、中文表单、导航、截图、标签页、隔离profile、关闭/EOF与失败清理，见 [原始日志](browser-chromium-only.txt)及 [运行信息](browser-artifacts/runtime.json)。未来录像能力须另审兼容的ffmpeg。

独立复核发现解析器可读取command或fat slice边界外的部署元数据，导致6类误判通过。已修复slice、sizeofcmds、command长度、ntools表与CPU校验；14项CLI样例及9项补充边界均符合预期。保留 [修复前](matrix-before-review.json)、[修复后](matrix-after-review.json)、[补充边界](extra-review.json)、[系统otool交叉核对](otool-review.json)与 [独立复核记录](review.json)，无剩余代码发现。源码指纹见 [source-fingerprint.json](source-fingerprint.json)。修改后Python编译、Node语法及diff检查通过；受影响的家目录和进程安全静态组通过，无新增生产代码。

复现命令（从仓库根目录执行；依赖/cache路径为本次准备目录）：

```bash
python3 MACOS-PORTING/probes/audit-macos-minimum.py \
  --wheelhouse /tmp/ruyi-p3-03-wheelhouse \
  --browser-root /tmp/ruyi-p3-browser-required-cache \
  --out /tmp/ruyi-p3-minimum-required.json
python3 MACOS-PORTING/evidence/P3/acceptance/minimum/matrix-review.py
python3 MACOS-PORTING/evidence/P3/acceptance/minimum/extra-review.py
```

本结果只证明所列二进制的静态arm64部署声明，不证明系统符号兼容、Python/Node完整发行闭包、macOS14实际运行、签名或干净机离线安装。完整Chromium版本固定为1248/156.0.8078.4，升级须重新审计。P3整体保持进行中。
