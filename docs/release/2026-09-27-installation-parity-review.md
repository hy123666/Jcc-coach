# Installation Parity Review

## Confirmed Findings

- The installed 0.1.3 resources matched the release staging copy in the audited
  Electron, tools and runtime-contract trees. The development repository and
  staging copy differed in packaging adapters. Build time versus commit time
  alone does not establish source drift.
- Installed ADB matched the development ADB binary. The bundled Python could
  import RapidOCR, ONNX Runtime, OpenCV and NumPy. All three PP-OCRv5 model
  sessions loaded on CPU. This does not establish end-to-end capture readiness.
- Read-only inspection of canonical SQLite found an active `augment_choice`
  mode and a completed, unacknowledged 2-7 automatic response. The two recorded
  augment confirmations used `state_only_no_host_task`.
- The shared renderer defers an automatic answer while a manual mode is active.
  Replaying the captured state against the delivery decision reproduces defer;
  changing only the mode to `cruise` allows delivery. Manual advice delivery
  returns to Cruise, but fact-only confirmation does not run that completion
  path. Historical successful-match logs available here are insufficient to
  prove which interaction sequence the user took previously.

## Changes

Packaging adapters, installer configuration and checks now live in the
development repository. Packaged-only resource/user-data configuration must
not change the development data directory. Release preparation synchronizes
allowlisted sources, checks dependency declarations, performs a locked install
and a fresh renderer build, then compares the packaged sources and assets.
These checks prevent silent source/build divergence; they are not proof of a
successful full Match.

## Fix And Adversarial Review

Removed mode-only admission and delivery blocks. Card navigation cannot own
the Host lane; real user tasks still do, including cancellation awaiting
Provider confirmation. Canonical delivery still validates Match identity,
freshness and actual rendering before ACK. Existing legacy retry reasons stay
readable so a persisted old-mode retry can recover without deleting user data.

First review: source parity alone did not prove dependency parity. The staging
lockfile contained application-version strings in third-party package version
fields. Package metadata and the regenerated lockfile now come from development;
release builds use npm ci and never bulk-rewrite dependency version fields.

Second review: removal of the tab gate must not let a cancelling task lose its
owner. Added explicit cancellation-pending protection, testing active manual
owners, settled cancellation, next-checkpoint admission, render-before-ACK,
duplicate delivery and unchanged selected cards. Source hashes, archive hashes,
packaged-service regression and offline dependency checks are release gates.

The real NSIS build also exposed an unsupported legacy customUnInstallSection
hook that the old isolated fixture had invoked by hand. Replaced it with the
upstream template's customUnWelcomePage and customUnInstall hooks; the resource
gate verifies those hooks exist, and the seven isolated cases exercise the
same cleanup hook. This preserves the actual unchecked cleanup component.

## Acceptance Boundary

Watcher discovery failures need their own timestamped cause analysis; their
presence after a match does not prove they caused an earlier delivery block.
No installed user data is cleared by these fixes. Deterministic packaged
regression is not a real MuMu game or a real Provider turn; full live-game
acceptance must be reported separately from build and fixture results.
