# CLAUDE.md —— 给 Claude Code(本机与云端)的项目说明

先读 [CONTRIBUTING.md](CONTRIBUTING.md) 的「五条硬约束」:纯离线可用、`server.js` 零 npm 运行时依赖、clean-room、
**Windows 10/11 为一等目标**、行为变更必须带/更新 e2e。下面只写动手时最容易踩的点。

## 代码形状

- 后端运行产物 `ruyi-workbench/app/server.js` 由 `app/build.js` 把 `app/src/*.js`(按 `manifest.json` 顺序)拼接而成。
  **只改 `app/src/`,改完跑 `node ruyi-workbench/app/build.js`**,产物与 manifest 一起提交。
  CI 用 `build.js --check` 拒绝陈旧产物。
- 前端 `ruyi-workbench/app/public/` 无框架、无构建。
- `dev-harness/` 是离线 e2e 与假件;`dev-harness/unit/*.test.js` 是 `node --test` 快通道。

## 提交前的快速检查(与 CI 同序)

```bash
node dev-harness/syntax-gate.js
node ruyi-workbench/app/build.js --check
node --test "dev-harness/unit/*.test.js"
node dev-harness/run-all.js --fast            # .static 纯静态锁,秒级
node dev-harness/<改动相关>.e2e.js             # 单件:末行 ... E2E: ALL PASS,exit 0
```

## 生成物:改了源码要重算、不要手改

| 生成物 | 重算 | 对应静态门 |
|---|---|---|
| `docs/architecture/route-inventory.{json,md}` | `node dev-harness/route-inventory.js` | `route-inventory.static.e2e.js` |
| `docs/architecture/module-dependency-graph.json` | `node dev-harness/module-dependency-graph.js --write` | `module-dependency-graph.static.e2e.js` |
| `facts.json` | `node dev-harness/facts-generate.js` | `facts.static.e2e.js` |

这些生成物记着 `app/src` 的**行号**:小改动尽量不增删行(注释写在已有行尾),就不用连带重算几千行。
只有 `generatedAt` 时间戳变化时不要提交生成物。

## 在云端(Linux 容器)开发

`.claude/hooks/session-start.sh` 在云端会话启动时检查 Node ≥ 20,并把 Chromium 包装成
`--no-sandbox --lang=zh-CN`,通过 `RUYI_E2E_BROWSER` 交给浏览器件(`dev-harness/lib/browser-path.js`)。

- 起服务看界面:`node ruyi-workbench/app/server.js serve`(只监听 127.0.0.1,默认 8765,被占自动顺延)。
  用 `HOME=<临时目录>` 起可避免污染数据目录。页面带 SSE 长连接,Playwright 等 `load` 而不是 `networkidle`。
- 全量回归:`LANG=zh_CN.UTF-8 node dev-harness/run-all.js --parallel 4`(4 核约 25–30 分钟,放后台跑)。
- **Linux 上全量不会全绿,这是预期。** 2026-09 实测 402 件约 366 过。剩下的主要是:
  PowerShell 会话、`.cmd` 启动器、资源管理器、`C:\` 路径、像素基线;`observation-recall-*` 依赖未随开源仓发布的
  `realhist-fixtures/`;root 身份下「只读文件写不进去」一类断言。**判断回归要和改动前的同环境基线比**,
  不要把这些当成自己改坏的;最终以 Windows CI(`.github/workflows/e2e.yml` 的 `e2e` job)为准。
- `mcp/ai-computer-control`(ACC)依赖 pywin32/pyautogui 与真桌面,云端装不上、测不了,改它只能靠 Windows CI。
- 发布打包(`package:offline*`、`build:desktop`)是 PowerShell 脚本,只在 Windows 上跑。

## 平台相关代码的写法

- 模型/用户给的路径按 **Windows 形**处理:取文件名用 `path.win32.basename`(它同时认 `\` 与 `/`),
  不要用宿主相关的 `path.basename`。
- 测试收尾杀进程走 `dev-harness/lib/kill-own-tree.js` 的 `killOwnTree`(Windows 按创建时间认子孙,Linux 读 `/proc`),
  不要写 `taskkill /T` 或裸 `child.kill()`。
- 只在非 Windows 执行的断言(`if (process.platform !== 'win32')`)不会被 Windows CI 跑到,改接口形状时要记得同步。
