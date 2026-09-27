# Windows Release Workflow

The repository has three deliberately separate layers:

1. `G:\OneDrive\000-AI\jcc-runtime` is the development source of truth. It
   contains code, tests, Core and Ranking generators, contracts, and the full
   Git history.
2. `F:\Jcc-coach` is the release staging checkout. It contains the files that
   are allowed into a Windows release and is also the clean-machine test
   surface.
3. `F:\Jcc-coach\ui\release-*` contains distributable installers only. It is
   never a development source.

## Daily Ranking Versus Repackaging

`更新今日数据` updates the development repository's active Ranking and runs
semantic maintenance. That does not require rebuilding an installer for an
already-installed user: the Runtime update flow owns post-install data.

Before publishing a new installer, however, the release staging checkout must
receive the latest verified Ranking so a first-time install starts with the
current data. The package also carries the current Core profile and its
required runtime resources.

## One-Command Release

From the development repository, after the Ranking pipeline has published the
intended snapshot:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\build-jcc-windows-release.ps1 `
  -ReleaseRoot F:\Jcc-coach `
  -Version 0.1.4 `
  -ExpectedStatDate 20260925
```

The script performs these gates before it publishes the installer:

- verifies the active Core/Ranking/Recipe closure and semantic-maintenance
  status in the development repository;
- mirrors the verified `data/live-rankings/jcc` tree to the release checkout;
- copies allowlisted application source, runtime contracts and build inputs
  from the development checkout, validates their hashes, and records a source
  manifest; user state, credentials, caches and development history are not copied;
- rejects dependency declaration drift, installs the release lockfile with
  `npm ci`, and runs a fresh TypeScript/Vite build instead of reusing `ui/dist`;
- verifies the release resources, including ADB, OCR runtime/model files,
  current Core and current Ranking;
- runs the NSIS uninstall-data fixture, including the default-retain and
  explicit-delete paths;
- builds Electron in a temporary local directory instead of a synced release
  directory, avoiding Windows/OneDrive rename locks;
- starts the packaged daemon and checks health plus SQLite placement;
- compares packaged external source, the archive's Electron code and renderer
  assets against the synchronized source and fresh build before publishing;
- runs the packaged Cruise gate matrix with an isolated data directory and no
  Provider, loads all three OCR models using the bundled Python, and executes
  bundled ADB independently of the development PATH;
- copies the installer and blockmap to `ui/release-<version>` and verifies the
  copied installer hash.

The `ExpectedStatDate` argument is intentional. The current source date may
be the latest available upstream date rather than the local calendar date;
the release must name the date it actually verified.

The development repository remains the only place for future code and data
updates. Do not edit the staging copy to fix product behavior; regenerate it
from the development repository and rerun the release gates.
