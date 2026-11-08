# P4-02 工作区目录别名

2026-11-08，当前 Mac 本地开发候选，基线 `d97db57b` 上的未提交工作树。处理原生选择器返回 `/private/var`、已有收藏使用 `/var` 时重复添加的问题。

## 实现

复用现有受 token 保护的 `/api/workspace/resolve`，在 Darwin 接受显式 `selectedPath`。目录身份由有界 BigInt stat 的精确 dev/ino 比较，保留首个已配置收藏的路径写法和完整权限。name/children 入口处理目录指纹，Windows 入口使用盘符和 UNC 路径。

Mac 宿主工作区入口先解析别名，清理该目录已有的重复收藏和历史记录。客户端配置落后时使用服务端返回的收藏行。解析返回、线程写入返回和配置保存返回均核对选择代次与目标线程，写入串行化，较新的选择在较旧写入后提交。

POSIX 路径比较及 Mac 配置清洗保留字面末尾反斜杠和空白。工作区标签使用 Mac 路径分隔符，实际目录名与显示一致。已有会话的 cwd PATCH 同样保留 Darwin 绝对路径末尾空格。

## 验证

真实 WKWebView 中的正常 workspace domain 与配置接口完成别名和 symlink、存量重复行、原权限与陈旧客户端权限、特殊目录字符真实落盘、标签，以及线程切换和迟到响应回归。受控失联收藏验证一秒 I/O 超时边界。大小写测试明确验证客户端比较策略。

主代理与独立复核者各 50 项通过、0 失败。新增覆盖超出 JavaScript 安全整数范围的相邻 inode，以及 domain 经真实 HTTP PATCH 后 GET 已有会话 cwd 的往返。独立审查发现的权限默认上浮与异步选择竞态均已修复并补断言。[正常验收](normal-final.txt) [独立验收](independent-final.txt) [源码指纹](source-fingerprint.json)

首轮把新增目录的规范路径误写为原始别名，另一次夹具恢复误传完整配置而被专用隐私设置保护拒绝，原失败均保留。恢复现在只发送本件修改的三个工作区字段。[首次](first.txt) [恢复失败](fixture-restore-first.txt)

旧 workspace-resolve 件在当前树为 37 通过、1 失败。独立 detached HEAD `d97db57b` 工作树原样运行得到相同的 37/1，唯一失败均为旧 recent 列表大小写断言。临时基线工作树已正常移除，原断言保留。[当前](legacy-current.txt) [独立基线](legacy-baseline.txt)

该测试原先对所有平台要求大小写不敏感，现有 POSIX 路径比较与注释契约均区分大小写。修正后 Windows 分支执行原断言，POSIX 分支检查包含两个大小写变体的完整有序数组。在后续会话存储修改前的 BigInt 候选上，主代理与独立复跑各 38 项通过、0 失败。最终 50 项候选的会话存储改动由真实 PATCH/GET 专项覆盖，旧解析件未在该候选重新运行。[修正后](legacy-corrected.txt) [独立复跑](legacy-corrected-independent.txt)

工程快门首轮单元 2491 通过、18 跳过，静态两组失败。默认新增收藏的结构断言通过，权威权限随后覆盖。固定超时行为断言已登记墙钟豁免和文件清册，两组定向通过。此前 48 项候选的完整工程门已归档为 `fast-final-48.txt`。其后一次检查期间修改源文件，导致产物新鲜度检查失败，静态 79/80，原日志保留。重新生成后冻结源码完成本轮检查，最终完整单元 2491 通过、18 跳过，静态 80/80，语法 1134 文件通过，构建新鲜度与源码指纹通过。[首轮工程门](fast-first.txt) [夹具门](home-static-retest.txt) [UI 门](ui-static-retest.txt) [完整工程门](fast-final.txt) [复核](review.json) [新鲜度失败](fast-freshness-failure.txt) [单元明细](unit-final.txt)

此前 48 项候选的日志、复核和源码指纹保留为文件名带 `-48` 的历史证据。本轮源码指纹包含会话存储和 manifest。

可见 NSOpenPanel 最终候选复验及其余 P4 系统权限仍等待手动解锁。

## 最新生产树旧解析件补验

2026-11-08，包含会话cwd尾空格落盘修改的当前生产树，旧workspace-resolve主代理及独立复跑各38通过、0失败、自然退出0。该补验更新此前“会话存储修改后未重跑”的范围记录，覆盖HTTP与解析算法。[主代理](workspace-main-current.txt) [独立](workspace-independent-current.txt)
