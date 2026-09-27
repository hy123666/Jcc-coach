# Getting Started and Troubleshooting

[简体中文](GETTING-STARTED.md) | **English**

## Install and Connect a Host

Download the Windows x64 installer from Releases when available. The source ZIP is not an installer. The installer does not include an emulator, the game or a model account.

Install and authenticate a supported CLI using the [Codex CLI documentation](https://developers.openai.com/codex/cli/) or [Kimi Code documentation](https://www.kimi.com/code/docs/). Confirm it can answer independently first. Codex CLI is the primary host; Kimi Code has a separate adapter. Other Agents cannot be enabled merely by entering their executable path. Upstream protocol changes may require adapter updates.

Under “宿主 Agent”, choose “扫描本机 CLI Agent”, select the host and click “连接所选 Agent”. Select a model available to your account; low/medium reasoning is a starting point for ordinary strategy questions. Test a complete lobby response first.

## MuMu Setup

1. Launch MuMu and the game.
2. Check **… → 设备设置 → 开发者选项 → ADB 调试**. The tested version defaults to “开启本地连接” (local connections enabled). If already enabled, leave it unchanged; otherwise enable local connections. Menu locations may vary. Do not copy another computer's port.
3. In the game window, open **工具箱 → 金铲铲之战工具箱** and enable **金铲铲阵容大师**. Product testing identifies this as necessary for complete board and shop champion information.
4. In Runtime, open “连接 MuMu”, use “一键识别 MuMu / ADB 端口” and connect the instance running your game.

ADB connectivity is not equivalent to full telemetry readiness. For missing board/shop data, check the lineup assistant switch. For missing stage/HP information, check monitoring and HUD/OCR status. Complete live telemetry currently requires MuMu; lobby chat does not.

## Matches and Manual Records

Click Start Match after entering the game to create a match session and start monitoring. Confirm stage and state updates. Automatic advice runs at registered strategic checkpoints, not every shop refresh; you can ask questions at any time.

Save/confirm augments, equipment and emblems in their respective cards. Unsaved text is not a confirmed record. OCR or spectator views may omit information, so supplement it manually when necessary. “Connected” does not mean every field has been recognized. Lineup cards display advice; they do not control the game.

Stop the match when it ends before starting another. “开启新对话” starts a separate lobby conversation.

## Updates and Uninstallation

“更新今日数据” requires network access; semantic maintenance also requires a working model host. Wait for completion and check the actual statistics date. Do not relabel older source data as today's data or edit active pointers manually.

Install upgrades to the same directory to retain user data. Uninstallation keeps data by default. Select “同时删除用户配置和运行数据” only to remove the application's own data. Silent uninstalls and upgrades preserve data by default.

User data normally resides in the system-resolved `%APPDATA%\jcc-runtime-ui`, with Runtime state under `runtime-data`. Redirected Windows folders may change the actual location. Do not delete Codex/Kimi credentials or emulator directories to clean Runtime data.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| CLI not found | Installation and standalone operation; restart Runtime and rescan |
| Provider 401/403/404/429 | Authentication, permissions, model mapping, service health or quota |
| MuMu discovery fails | Running instance, ADB setting, selected device and port |
| Connected, but no board/shop | Enable 金铲铲阵容大师 in the game toolbox |
| HUD not ready | Game view and HUD/OCR status, separately from ADB connectivity |
| Manual chat works, no automatic advice | Stage updates, checkpoint eligibility, task completion and delivery |
| daemon exited before ready | Preserve the full startup error, version and install path, not only code 1 |

Share reproduction steps and redacted diagnostics. Do not publish credentials, private chats, databases or complete Provider logs.
