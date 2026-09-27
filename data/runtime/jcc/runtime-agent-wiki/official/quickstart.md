# Quickstart

This is the short product tutorial for JCC Runtime users.

## MuMu Desktop Steps

1. Open MuMu and launch 金铲铲之战.
2. Enable 金铲铲阵容大师 inside MuMu.
3. Return to JCC Runtime and click `连接 MuMu`.
4. Start a new match while looking at your own board.
5. Confirm the current match variables when the Cruise card asks for them.

## Product Notes

- 金铲铲阵容大师 is required for the MuMu structured bridge, but it is not the whole setup.
- ADB ports and device serials stay hidden unless advanced diagnostics are opened.
- Match variables are optional when automatic evidence is unavailable. Season-only fields come from the active major-season descriptor rather than common UI code.
- Augment, season-mechanic, and item/anvil candidates are entered and finally confirmed through their structured cards. Ordinary chat never writes canonical candidates or selections.
- Augment mode may use `快速 OCR` after stage and tier are selected. It only fills a complete, catalog-validated local draft; it never saves, sends, or confirms by itself.
- Opponent board, power, and counter-positioning are intentionally not product sensing paths because MuMu does not expose reliable opponent-unit identity.
- The lineup card is generated from the Host model's `jcc-internal-lineup-plan-v1` output and rendered deterministically by Runtime.

## Future Phone/Tablet Steps

Phone and tablet setup is intentionally deferred. Do not present APK setup as the current primary path until that route is resumed.

## Acceptance

The setup is ready when `tools/start-jcc-mumu-runtime-watch.mjs --dry-run` reports:

```text
ok: true
status: ready
recommended_target.serial: present
```
