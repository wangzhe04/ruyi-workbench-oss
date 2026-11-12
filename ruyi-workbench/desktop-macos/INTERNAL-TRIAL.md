# P6-02 本地／内部试用包

2026-11-12，用户确认没有 Apple 开发者账号，先交付本地／内部试用版；当前也没有专用干净标准用户或测试 Mac，因此只验收当前账号的隔离安装环境。Developer ID、公证与票据、真实标准用户环境继续待验，不将这一范围决定写成原正式发行门全部通过。

## 构建

使用已冻结、校验通过的 P6-01 Full/Slim 包目录。无需重新下载运行时，也不改变原目录；业务源码来源继续登记为输入包的提交，P6-02 包装源码提交与指纹单独记录。

```sh
node ruyi-workbench/tools/package-macos-trial.js \
  --package /path/to/Ruyi-macos-arm64-full-p6-01 \
  --output /path/to/new-full-trial
node ruyi-workbench/tools/package-macos-trial.js \
  --package /path/to/Ruyi-macos-arm64-slim-p6-01 \
  --output /path/to/new-slim-trial
node ruyi-workbench/tools/package-macos-trial.js --verify /path/to/new-full-trial
```

构建机需要 Node24、Git、macOS 的 codesign/hdiutil/plutil，以及本地输入包；装机用户只需系统本身。构建器拒绝覆盖已有输出，也拒绝输出与输入包重叠。安装仅覆盖新位置，采用正常拷贝进度语义，不承诺原子替换或升级。

## 签名策略

- 原 P6-01 包中的所有原生对象均先核对完整性。对明确 unsigned 的单独原生扩展补 ad-hoc 签名；保留已经有效的签名。
- 某些 Chromium App/framework 的 linker-signed 主程序没有资源封印。对这项明确且可重复的状态，在副本中从内到外重建 ad-hoc 容器封印，保留标识和已有 entitlement；其他未知签名错误直接失败。
- 在正确的 App/framework 容器上验证资源封印，对独立 Mach-O 文件单独验证，再封印外层 Ruyi.app。最后逐项复核，不能用外层 deep verify 代替 Resources 中每个原生对象的检查。
- 输出记录每项补签前后 hash、容器封印变化、原始/新 App tree、输入 manifest 和包装源码。签名变化后重新生成 package-manifest.json/SHA256SUMS，原包保持不变。

ad-hoc 签名证明本地代码结构一致性，不证明 Apple 认可的发布者身份。本轮不将 hardened runtime、Developer ID 或公证标为已完成。App 保留现有开发 Bundle ID；权限和 Keychain 升级身份稳定性另行验收。

## DMG 内容与安装

只读 HFS+ 压缩 DMG 包含 `Ruyi.app`、指向 `/Applications` 的专用快捷方式、中英文安装说明及校验/来源清单。这个唯一的 DMG 根快捷方式单独检查，不放宽 App 内禁止外部 symlink 的完整性规则。

用户双击 DMG，将 App 复制到应用程序目录；没有共享目录写入权限时使用 `~/Applications`。拷贝结束后推出 DMG，再从安装位置运行。已有安装先保留，升级、回退与完整数据恢复按[中英文用户／管理员说明](../docs/MACOS-RELEASE_CN.md)操作。

从网络或传输软件获得的包可能触发 Gatekeeper。用户确认可信来源后，按系统提供的“隐私与安全性／仍要打开”流程操作；组织策略不允许时由设备管理员处理。没有移除 quarantine、关闭 Gatekeeper/SIP 或修改系统策略的脚本。详见包内 [中文说明](trial/INSTALL-CN.txt)与[English instructions](trial/INSTALL-EN.txt)。

## 验收

```sh
RUYI_TRIAL_DISTRIBUTION=/path/to/new-full-trial RUYI_TRIAL_REQUIRED=1 \
  node dev-harness/macos-trial-install.e2e.js
```

测试真实挂载只读 DMG、逐项签名校验、复制到隔离 HOME 下包含中文/空格/emoji 的个人 Applications 路径、拒绝覆盖、推出镜像后原生与 LaunchServices 启动、业务数据保留、安装后实际离线工作台链路。Full 包括 Office/图表与真实 Chromium，Slim 核对缺失依赖范围。测试不创建账号、不提权，不使用其他现有账号或真实用户业务目录。

当前账号属于管理员组；隔离 HOME、短 PATH 和子进程拒绝访问开发目录不等同于另一台没有开发工具的机器。命令行 Gatekeeper assessment 仅作诊断，不冒充真实下载来源的首次用户允许。实际交互、未执行的门槛与本机版本分别在验收记录登记。
