# P1 受控启动布局验证

2026-11-03，macOS 27.0.1 arm64，Node 24.15.0。当前未提交工作区，HEAD 0a430880。

## 场景

macos-runtime-start 保留原来源码启动与 HTTP 路由断言，新增复制真实 Node、server.js、public 和 native helper 到包含中文、空格、emoji 的临时安装目录。从 `/` 启动，PATH 仅为 `/usr/bin:/bin`，使用独立 HOME、USERPROFILE、AppData 和数据根。

- 记录实际 process.execPath 与 cwd，确认由安装目录内复制的 Node 启动真实服务。
- 两套隔离家目录放入可观察的 profile 标记，验证均未被执行。
- 服务发现目录内 helper。删除 helper 后执行能力关闭，HTTP 持续可用；恢复后无需重启即可重新就绪。
- 当前机器不存在系统候选 Node，自动缺失场景返回明确错误；显式缺失路径与版本检查失败的可执行夹具也在服务启动前拒绝。
- 所有宿主 opener 均由 preload 拦截，验证委托参数与完成结果。

## 结果

主线 35 条通过，独立 reviewer 35 条通过，无 skip。冻结源码回归再次运行本件，日志见 ../frozen-mac-regression/macos-runtime-start.txt。首次日志见 start-first.txt。

增加了一个真实服务 spawn 点，隔离清册从 223 更新为 224；清理仍归原测试文件所有。首次开发测试因模板字符串换行转义导致 preload 语法错误，已修正。随后静态检查发现新增 spawn 清册及显式环境展开未同步，已按既有规则补齐。

## 边界

此处证明当前 Mac 的受控重定位布局和 clean PATH 启动。Node 来自本机已有二进制，宿主 OS 与基础环境仍在，完整离线依赖包和干净标准用户机器在 P3/P6 验收。自动缺失 Node 用例在已经安装系统 fallback Node 的机器会明确 skip。

Finder 实际窗口及选中对象仍需授权后的可见验收。本件的 opener 拦截不提供此项证据。Windows 同版本回归仍待完成。
