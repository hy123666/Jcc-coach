# JCC Runtime Windows 安装包依赖

本文档定义公开发布版的安装边界。源码启动器不是发行入口；发布验收必须使用安装包在一台没有开发环境的 Windows 机器上完成。

## 安装包内置内容

- Electron 应用和构建后的 `ui/dist`。
- Electron 自带的 Node 运行时；用户不需要另装 Node.js。
- 安装包自己的 Runtime daemon、`tools`、`data` 和 Host 初始化入口；安装后的运行根目录位于 Electron 的 `resources` 目录，不依赖源码仓库路径。
- Runtime daemon、当前稳定的 S18 Core/Common、当前 Active Ranking、两个可回归的历史 Ranking generation、Recipe 和最多 14 日精简趋势。
- `tools/bin/adb.exe`、`AdbWinApi.dll`、`AdbWinUsbApi.dll`。它们必须放在安装包的 unpacked resources 中，不能依赖用户 PATH。
- 独立 OCR runtime：Python 解释器、RapidOCR 依赖、固定的 CPU ONNX Runtime 和 PP-OCRv5 模型。模型路径必须是安装包内的明确路径，首次启动不得要求联网下载模型。
- `data/runtime/jcc/rapidocr-ppocrv5-mobile.yaml` 及其发布版模型路径配置。

## 安装与卸载

- Windows 安装包使用 NSIS，默认提供可修改的安装目录、桌面快捷方式和开始菜单快捷方式。
- 安装完成后会注册标准的 Windows 卸载入口，可在“设置 -> 应用 -> 已安装的应用”或控制面板中卸载。
- 卸载界面提供默认不勾选的“同时删除用户配置和运行数据（无法恢复）”。不勾选时只卸载程序，保留用户数据。勾选后删除当前用户的 `%APPDATA%/jcc-runtime-ui` 和 `%TEMP%/jcc-runtime-ui`，包含配置、数据库、缓存及临时日志；系统重定向目录时以实际路径为准。
- 覆盖升级、取消卸载和默认静默卸载保留数据。清理不触及 Codex/Kimi 的外部登录配置、模拟器、项目源码或用户自行指定的 Runtime 数据目录。
- 文件被占用导致清理失败时显示提示，不把残留误报为已删除，也不安排重启后删除。
- 安装目录可能位于 `Program Files`，程序不得向安装目录写数据库、日志、截图、OCR 缓存或会话状态。

## 安装包外部前置条件

这些内容不能随包提供，首次启动必须检查并在 UI 中说明缺什么：

- Codex CLI 或 Kimi Code，以及用户自己的登录和 Provider 配置。当前正式适配 Codex CLI，Kimi Code 属于已支持的第二适配器；不承诺任意 CLI 可直接接入。
- MuMu、已启动的《金铲铲之战》及游戏窗口工具箱中的“金铲铲阵容大师”。ADB 与阵容大师必须同时开启；仅有 ADB 的其他模拟器不在当前完整棋盘/商店信息链路的支持范围。Runtime 必须显示真实连接状态，不得用“已发现端口”冒充健康连接。
- Provider 网络、账号额度和权限。

## 可写目录

安装目录只放代码和只读资源。数据库、截图、OCR 缓存和会话状态使用 Electron userData 下的 runtime-data，默认位于 %APPDATA%/jcc-runtime-ui/runtime-data。桌面启动诊断日志目前位于系统临时目录的 jcc-runtime-ui/electron.log。

## 构建

```powershell
npm --prefix ui ci
npm --prefix ui run build
npm --prefix ui run package:win
```

`package:win` 必须先执行发布资源门禁。缺少 OCR Python、模型、ADB DLL、Core/Ranking 或 Electron 构建结果时应失败并列出缺失路径。

打包后的资源布局至少应包含：

- `resources/ocr`：内置 Python、RapidOCR、ONNX Runtime 和模型。
- `resources/adb`：`adb.exe` 及两个 Windows ADB DLL。
- `resources/tools`、`resources/data`：Runtime 工具、Core、Common、Ranking、Recipe 和知识数据。
- `resources/ui/electron`：Runtime daemon 源码，保留 tools 与 ui/electron 的相对导入关系。
- `resources/node_modules/minisearch`：独立后台进程使用的搜索依赖；仅放入 app.asar 无法供该进程解析。
- `resources/AGENTS.md`、`resources/CLAUDE.md`：Host 初始化所需的项目入口。

## 首次启动检查

构建的 afterPack 钩子必须使用打包后的 Electron 可执行文件启动独立后台，以临时目录作为工作目录和数据目录，验证 ready、HTTP health、SQLite state 及正常退出。任何失败都中止安装包生成。该检查不发起 Provider 请求。

手动复验：`node tools/verify-jcc-packaged-daemon.mjs "安装后的程序目录"`。

卸载选项回归：`node tools/verify-jcc-uninstall-user-data.mjs`。它使用真实 NSIS 编译器和独立临时样本，不触及本机用户的 JCC 数据。

首次启动顺序必须是：

1. 检查安装资源版本和 SHA-256 manifest。
2. 检查 OCR runtime、模型、ADB 和当前数据快照。
3. 检查 Codex/Kimi 适配器和用户认证状态。
4. 检查用户数据目录可写。
5. 通过后才显示 Runtime 可用；否则显示可操作的缺失项，不进入假运行状态。

## 明确不随包提供

- 用户聊天记录、Provider session、认证密钥、SQLite 运行状态、个人对局和截图。
- 开发用 `node_modules`、`.venv-ocr` 的未裁剪副本、构建缓存和开发启动器。

`.venv-ocr` 只能作为构建输入。发布包应由锁定依赖和资源清单生成最小可运行 OCR runtime，而不是把开发目录原样打进去。
