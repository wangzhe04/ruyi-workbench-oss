# Mac arm64 离线候选包 / Offline candidates

P6-01 将 AppKit/WKWebView 宿主、Node/Web 程序、运行时与许可放在一个可搬移的 `Ruyi.app` 中。当前为 **ad-hoc 开发签名、未公证的候选包**；正式 Developer ID、Gatekeeper 首次安装、签名身份下的 Keychain/TCC、升级/回退归 P6-02/03，最终发行回归归 P6-04。

目标为 Apple Silicon arm64/macOS14。原生文件的 arm64 架构、最低部署声明和动态库闭包会在构建时检查；**这不等于已在 macOS14 实际运行**。当前实测系统在证据记录中逐项注明，不宣传未验兼容。

## 变体与承诺

| 变体 | 包内依赖 | 能力边界 |
|---|---|---|
| Slim | Node24、ripgrep、宿主与三个原生 helper、Web UI、配置模板、内置资源 | 工作台、Provider API、文件/搜索/Shell；不随附 Python/ACC、Office 与浏览器自动化依赖 |
| Full | Slim 加独立 CPython3.12、非 editable ACC、锁定的 Office/图表/视觉/Playwright wheels、完整 arm64 Chrome for Testing | 增加文档、图表、浏览器及已验范围内的桌面 MCP；桌面能力仍需要用户授予相应系统权限 |

两种变体均不打包官方 Agent CLI、Git、模型权重、Homebrew、Xcode 或用户凭据。模型服务需用户配置；本地/内网模型可无公网运行，云 API 需要网络。Git/CLI 集成需要用户另行安装相应工具。Full 的离线浏览器在工作台浏览器设置中选择 **bundled**；保留用户已有 system/custom/CDP 等选择，不自动接管默认浏览器。

不会将 P5 原未验范围变成发行承诺，也不会打开默认关闭的执行回执。压力手势、特定应用限制、多屏与最低系统等继续以 P5 收尾记录及最终候选验收为准。

## 两步构建

仓库根目录执行。准备工作站需要 Node24、Apple SDK，以及 **Python3.14+（仅用于解压上游 Python 构建的 Zstandard 许可归档）**。包内运行时仍是 Python3.12。资产、缓存与输出目录使用仓库外的新目录；准备器和构建器均拒绝覆盖已有输出。

1. 有网准备工作站显式下载已锁定资产：

```sh
python3.14 ruyi-workbench/tools/prepare-macos-offline-assets.py \
  --cache /path/to/download-cache --output /path/to/macos-assets --download
```

下载地址、版本和 SHA256 固定在 `MACOS-PORTING/dependencies/macos-offline-arm64.assets.json`。Node/Python/ripgrep 来自上游归档；Python 附带依赖的原始许可来自对应 standalone full 构建；Chrome for Testing 使用 Playwright 对应修订。每个 PyPI wheel 固定下载 URL 与 hash。去掉 `--download` 时只读已有缓存，缺项或损坏立即失败，不联网补齐。准备器解压后，离线构建器还会核对完整组件目录摘要。

2. 将准备好的资产带到构建 Mac，在无公网条件下构建：

```sh
node ruyi-workbench/app/build.js --check
node ruyi-workbench/tools/package-macos-offline.js \
  --assets /path/to/macos-assets --output /path/to/Ruyi-full-candidate --variant full
node ruyi-workbench/tools/package-macos-offline.js \
  --assets /path/to/macos-assets --output /path/to/Ruyi-slim-candidate --variant slim
```

Full 使用隔离 HOME、临时目录和固定构建环境，从当前候选源码构建 ACC wheel，再用 `--no-index`、hash 锁定的 requirements 安装到独立 Python 中并执行 `pip check`。build isolation 也只使用同一锁定 wheelhouse 的 setuptools/wheel。构建中不运行 Playwright 下载器。浏览器的 credits/terms 从实际包内 `chrome://` 页面提取保存；Python 原始许可和各分发包元数据随包保留。

## 布局

```text
Ruyi-full-candidate/
  Ruyi.app/Contents/
    MacOS/RuyiDesktop
    Resources/workbench/
      app/server.js, app/public/, app/vendor-bin/rg
      desktop-macos/service-lease.cjs
      runtime/node/bin/node, runtime/node/LICENSE
      runtime/macos/ruyi-{process,keychain,automation}-helper
      mcp/ai-computer-control/                 # Full only
        runtime/python/                      # standalone, not a copied venv
        wheels/, requirements.lock.txt
        playwright_browsers/chromium-1248/
      resources/offline-manifest.json
      native-dependencies.json
      python-licenses.json, browser-notices/  # Full only
      LICENSE, THIRD-PARTY-NOTICES.md
  package-manifest.json
  SHA256SUMS
  README.txt
```

App 按自身 Resources 定位工作台，忽略开发用的 `--workbench-root`/`RUYI_NODE_PATH` 覆盖；已安装 ACC 直接用包内 Python 的 site-packages，不使用 PYTHONPATH 指向源码。Python/rg 也进入工作台子命令的 PATH。数据仍写入 `~/.ruyi-workbench` 或显式 `RUYI_HOME`；App 内载荷按只读使用。Python 提供相对 `python` 别名，wheel 的 console entrypoints 改用同目录 Python 的相对启动脚本，避免 pip 生成的临时 staging 绝对 shebang 在搬移后失效。

## 校验与验收

```sh
node ruyi-workbench/tools/package-macos-offline.js --verify /path/to/Ruyi-full-candidate
RUYI_OFFLINE_CANDIDATE=/path/to/Ruyi-full-candidate RUYI_OFFLINE_REQUIRED=1 \
  node dev-harness/macos-offline-package.e2e.js
```

清单逐项绑定文件 SHA256、大小、模式及相对 symlink，额外/缺失文件和外部链接都会失败；它用于检测损坏与候选一致性，正式发行真实性由 P6-02 签名公证承担。源码提交与逐文件指纹均记录，未提交实现不会冒充为已提交 SHA 的全部内容。

专项验收复制候选到含中文、空格、emoji 的路径并设只读，以隔离数据根运行；子进程 sandbox 实际拒绝开发源码/依赖目录及公网连接，只允许本地回环。Full 通过真实工作台 MCP 验证 DOCX/XLSX/PPTX/PDF/图表和本地 Chromium；两种变体都启动真实 AppKit/WKWebView。验收不修改系统防护、网络、登录项或用户的真实配置。

## English summary

Preparation is explicitly online only with `--download`; assembly uses a pinned local asset cache and never downloads runtime dependencies. Full bundles standalone Python, a freshly built non-editable ACC wheel, Office/vision/Playwright dependencies and the matching full Chromium. Slim omits these dependencies. Neither variant contains an official agent CLI, Git, model weights or user credentials.

The App resolves all program resources relative to its own bundle and keeps business data outside it. Integrity manifests cover bytes, modes and relative links. Candidates use an ad-hoc development identity; Developer ID, notarization, clean-user installation, minimum macOS14 runtime qualification and upgrade/rollback acceptance remain separate gates. Select bundled mode in browser settings to use the shipped browser.
