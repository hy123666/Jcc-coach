# JCC Core Patch Package: jcc-mode17-s18-17.17.8

Official source tuple: mode=17, season=S18, version=17.17.8.
Runtime patch id: s17_8.

This immutable package was collected through the official JCC framework. Raw official values already include the target patch, so the hard-data builder must not replay earlier patch transforms over these files.

Cross-source facts inside this immutable package must preserve the official
player-facing entity rather than create a duplicate. The official `10611 /
邦！` augment links to chess variant 1464, whose skill name `DUANG!` is a search
alias and whose current attack speed is 0.8. Historical `patch17_*` synthetic
IDs and old patch prose are not valid current-package truth.

Build and verify before promotion:
- node tools/build-jcc-hard-data.mjs --candidate-manifest data/core-patches/jcc/jcc-mode17-s18-17.17.8/manifest.json
- node tools/verify-jcc-hard-data.mjs --candidate-manifest data/core-patches/jcc/jcc-mode17-s18-17.17.8/manifest.json
