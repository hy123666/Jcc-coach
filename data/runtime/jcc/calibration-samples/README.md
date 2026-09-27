# JCC Calibration Samples

This directory contains reviewed, user-labeled visual fixtures for the MuMu
desktop runtime sensing pipeline.

Retention policy:

- Keep only minimal fixtures required by verifier scripts.
- Fixtures may include PNG frames because they are calibration inputs, not
  runtime evidence or product screenshot retention.
- Verifier outputs, matcher dumps, OCR dumps, and exploratory intermediate
  files must be written to temporary directories and deleted after each run.
- Product/runtime paths must not persist raw frames; they should emit only
  structured observations.

