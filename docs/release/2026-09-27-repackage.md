# 0.1.5 重打包验证 / Repackage Verification

2026-09-27，保持版本 0.1.5，不更新游戏逻辑或依赖版本。
Version remains 0.1.5; no game-logic or dependency-version upgrade.

- 中文标题“用户安装”，英文标题“User Installation”，三处文档同步。
- Project LICENSE, NOTICE.md and third-party-notices are included in resources.
- 181 inventoried notice files: all hashes matched packaged resource bytes.
- Source/resource parity: 1,463 checks passed.
- Renderer type check/build and event-delivery regression passed.
- Seven isolated uninstall cases passed, including optional deletion and junction handling.
- Packaged Daemon ready in 19.735 seconds on the explicit post-build check.
- Packaged cruise/offline dependencies passed with a simulated Provider; no real Provider was used.
- Core/Ranking/Recipe closure and semantic-maintenance readiness passed; statistics date 2026-09-26.

File: JCC-Runtime-0.1.5-x64.exe

Size: 316508774 bytes

SHA-256: `1beae4374bb0eb9dcf73e69210568f44060ce835328dc46a440b24458073f2eb`

本次未安装到用户正在使用的目录，未做真实对局全流程验收，未上传 GitHub。
Not installed over the user's running installation; no new full real-match acceptance or GitHub upload.

Known limitations retained: ADB provenance discrepancy and dependency advisories.
Full npm ci audit reports 22 entries (2 low, 1 moderate, 16 high, 3 critical),
including development dependencies. The earlier reachability review covered
only the five production-tree entries, not all 22. No claim of a clean audit.
