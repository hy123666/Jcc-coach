# Third-party notice collection

Collected 2026-09-27 from the actual installed 0.1.5 archive and staging OCR
environment. inventory.json records 67 npm packages, 43 Python distribution
metadata directories, 181 locally supplied notice files and their hashes.
This is an inventory, not a claim that all redistribution obligations are closed.

- electron/: installed Electron and Chromium notices.
- npm/: notices extracted from installed app.asar, not a guessed npm tree.
- python/: Python, Tcl and available site-package notices. Duplicate dist-info
  versions remain explicitly inventoried; they are not proof of two active modules.
- models/: publisher model card and PaddleOCR license. All three model hashes
  match the RapidOCR 3.8.4 default_models.yaml source index, pinned to ModelScope
  RapidAI/RapidOCR revision v3.8.0. That model card declares Apache License 2.0.
- upstream/: supplementary upstream licenses where wheel-local notices were
  missing. antlr and jiter use exact release tags; RapidOCR main and flatbuffers
  master are reference copies, not proof of exact installed-release attribution.
- adb-reference/: NOTICE from Google's platform-tools_r36.0.0-win.zip. The
  installed three ADB binary hashes DIFFER from this same-version archive.
  This reference MUST NOT be represented as verified notice coverage of the
  current binaries. Exact distributor attribution is still outstanding.

Sources for supplementary files:

- https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.8.0/README.md
- https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/LICENSE
- https://raw.githubusercontent.com/RapidAI/RapidOCR/main/LICENSE
- https://raw.githubusercontent.com/antlr/antlr4/4.9.3/LICENSE.txt
- https://raw.githubusercontent.com/google/flatbuffers/master/LICENSE
- https://raw.githubusercontent.com/pydantic/jiter/v0.9.0/LICENSE
- https://dl.google.com/android/repository/platform-tools_r36.0.0-win.zip

Project noncommercial terms do not replace any third-party license. Preserve
original texts. This directory has not yet been inserted into the existing EXE;
a validated rebuild is required before claiming that the installer includes it.
