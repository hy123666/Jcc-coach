# JCC coach / AI Coach for JCC

[简体中文](README.md) | **English**

A Windows coaching app combining Master+ rankings, game knowledge and live match context to recommend lineups, augments, items and actions at strategic checkpoints. Codex CLI is the primary model host; a Kimi Code adapter is also available.

## User Installation

1. Download the Windows x64 installer from this repository's Releases when published. GitHub's Source code ZIP is not an installer.
2. Install and authenticate your own Codex CLI (preferred) or Kimi Code. In Runtime, scan and connect a host under “宿主 Agent”, then select an available model and reasoning level.
3. Test a question in lobby chat first. Lobby chat does not require an emulator.
4. For Start Match, launch MuMu and the game. Confirm ADB debugging is set to “开启本地连接” (local connections enabled); leave it unchanged if already enabled. Open the game window's **工具箱 → 金铲铲之战工具箱** and enable **金铲铲阵容大师**.
5. In Runtime, choose “连接 MuMu”, use “一键识别 MuMu / ADB 端口”, connect the correct instance, then start a match.

See the [Getting Started guide](docs/GETTING-STARTED.en.md) for setup and troubleshooting. MuMu is the currently supported environment for complete live board/shop information. A successful ADB connection alone does not confirm all game data is available. Chinese UI labels are retained here so you can find the actual controls; this translation does not imply an English application UI.

## Version and Data

Published version: **[0.1.5](https://github.com/hy123666/Jcc-coach/releases/tag/v0.1.5)**. Included game knowledge: S18 / 18.2a. Ranking statistics date: **2026-09-26**. The current full generations are September 23, 25 and 26. Normal retention is the active generation plus two eligible historical generations, with compact trends covering up to 14 dates, not 14 full snapshots.

Use “更新今日数据” to synchronize data, run semantic maintenance, verify and publish it. Statistics dates come from the upstream source, not the date the app starts. An ongoing match pins its snapshot and must not mix generations.

## Source Development

Use Windows, npm and Node.js with built-in `node:sqlite` support. The source export was verified using Node.js 25.7.0.

```powershell
npm --prefix ui ci
npm --prefix ui run build
npm --prefix ui run start:built
```

For development mode, run `npm --prefix ui run start` instead. Connect an authenticated model host in the app. MuMu and OCR setup are separate requirements for live matches.

The public source excludes credentials, Python environments, OCR models, node_modules, ADB binaries and personal runtime state. Installers must include Electron, Python/OCR resources, models and ADB so ordinary users do not install these separately. See `docs/release/INSTALLER_DEPENDENCIES.md` for the detailed packaging inventory (Chinese).

## Maintenance

Read `AGENTS.md` and `docs/MAINTAINING.md`. The repository-local engineering skill is `.codex/skills/jcc-runtime-agent/SKILL.md`; personal developer plugins are not required.

Check Ranking bindings with `node tools/verify-jcc-live-ranking-active-closure.mjs`. Use the registered update pipeline described in the maintenance guide. Never edit immutable Core or Ranking generations manually.

## Publication Status

See the [publication checklist](docs/release/PUBLICATION-CHECKLIST.en.md). `docs/release/PREPARATION.md` records an older export, not current readiness. The public repository uses a filtered initial source commit, without private development/staging history. Installers are distributed separately through Releases. Successful source export is not a clean-machine live-match acceptance test.

## License and Privacy

Original code uses [PolyForm Noncommercial 1.0.0](LICENSE), permitting noncommercial use under its terms. This is source-available software, not MIT or OSI-defined open source. Third-party code, game data and models retain their own terms; see [NOTICE](NOTICE.md).

Configuration, databases and logs reside in Electron's user-data directory, separate from the installation directory. Do not upload them to this repository. Your chosen model service receives questions and selected match evidence needed to answer. Report issues with the version, reproduction steps and redacted diagnostics, never credentials or private chats.

## Community and Feedback

You're welcome to share your experience and report issues. Please include "JCC coach" in your friend request.

WeChat:

<img src="docs/images/wechat-contact.png" alt="WeChat contact QR code for feedback" width="320">
