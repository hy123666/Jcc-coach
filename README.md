# JCC coach / 金铲铲 AI 教练

**简体中文** | [English](README.en.md)

结合 Master+ 大数据、游戏知识和实时对局信息，提供阵容、强化、装备建议与固定阶段巡航。以 Codex CLI 为主要模型宿主，同时适配 Kimi Code。

## 用户安装

1. 从本仓库 Releases 下载 Windows x64 安装包；Source code ZIP 不是安装包。
2. 自行安装并认证 Codex CLI（优先）或 Kimi Code，在 Runtime 的“宿主 Agent”中扫描、连接，选择账号可用的模型与推理强度。
3. 先在大厅提问，确认模型能回答。大厅不需要模拟器。
4. 使用 Start Match 前，打开 MuMu 与游戏，确认 ADB 调试为“开启本地连接”（已开启则无需修改），并在游戏窗口右上角 **工具箱 → 金铲铲之战工具箱** 开启 **金铲铲阵容大师**。
5. 在 Runtime “连接 MuMu”中点击“一键识别 MuMu / ADB 端口”，连接正确实例后启动 Start Match。

完整步骤及排错见 [首次使用指南](docs/GETTING-STARTED.md)。当前完整实时信息链路以 MuMu 为支持环境；ADB 连接成功不等于棋盘和商店信息已经就绪。

## 当前版本与数据

已发布版本为 **[0.1.5](https://github.com/hy123666/Jcc-coach/releases/tag/v0.1.5)**，内置 S18 / 18.2a 数据；Ranking 统计日期为 **2026-09-26**。当前完整 generation 日期是 9 月 23、25、26 日。正常保留活动一份加两份符合条件的历史，精简趋势最多 14 个日期，不是 14 份完整快照。

用户可使用“更新今日数据”完成同步、语义维护、验证及发布。统计日期以来源为准，不等于程序启动日期。进行中的 Match 固定自己的快照，不混用不同代数据。

## 源码开发

- 开发环境：Windows、支持内置 `node:sqlite` 的 Node.js 和 npm；源码导出使用 Node.js 25.7.0 验证。
- 安装界面依赖：`npm --prefix ui ci`。
- 启动开发界面与 Electron：`npm --prefix ui run start`。
- 类型检查与构建：`npm --prefix ui run build`。
- 运行已构建界面：`npm --prefix ui run start:built`。
- 在应用中连接已认证的模型宿主。实时对局另需连接 MuMu；OCR 配置见 `docs/runtime-ocr-inventory.md`。

公开源码不包含 CLI 凭据、Python 环境、OCR 模型、node_modules、ADB 二进制或个人运行状态。安装包与源码不同，安装包须包含 Electron、Python/OCR、模型及 ADB，普通用户不需要自行安装这些运行依赖。源码打包依赖见 [依赖清单](docs/release/INSTALLER_DEPENDENCIES.md)。

## 工程维护

先阅读 `AGENTS.md` 与 `docs/MAINTAINING.md`。项目内 Skill 位于 `.codex/skills/jcc-runtime-agent/SKILL.md`，供不同编码 Agent 作为工程维护契约阅读，不需要安装作者的个人插件。

使用 `node tools/verify-jcc-live-ranking-active-closure.mjs` 检查 Ranking 绑定。数据更新遵循维护指南中的正式流水线，不手工修改不可变 Core 或 Ranking generation。

## 发布状态

当前进度见 [发布检查表](docs/release/PUBLICATION-CHECKLIST.md)。`docs/release/PREPARATION.md` 是较早的导出历史记录，不代表当前发布状态。
公开仓库使用经筛选的源码首次提交，不继承本机开发和发布副本历史。安装包通过 Releases 单独分发。具体已验证范围及发布前剩余项见发布检查表，不把源码导出成功等同于新电脑完整对局验收。

原创代码采用 [PolyForm Noncommercial 1.0.0](LICENSE)，仅按该许可证授权非商业用途。这是源码公开的非商业许可，不是 MIT，也不是 OSI 意义上的开源许可证。第三方代码、游戏资料和模型保留各自条款，见 [NOTICE](NOTICE.md)。

安装目录与用户数据目录不同。配置、数据库和运行记录保存在 Electron 用户数据目录；不要上传到公开仓库。模型服务会收到回答需要的问题和选定对局证据，请使用可信服务。提交问题请提供版本、复现步骤与脱敏日志，不要上传认证文件或私人聊天。
