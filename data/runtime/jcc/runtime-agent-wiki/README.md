# JCC Runtime Agent Wiki

This directory is the product-facing wiki for agents that connect to JCC runtime.
It is not the OMX development wiki, and it is not a strategy source.

Runtime strategy must use:

1. Project typed indexes for rules, formulas, entity mechanics, and decision routes.
2. Daily Zhangmeng/live-ranking big data for meta strength and rate signals.
3. Current match `live_state` for the player's actual board, bench, shop, economy, items, and choices.
4. User-confirmed current-match variables when automatic recognition is missing or uncertain.

This wiki supplies operating instructions, source boundaries, and user memory entrypoints.
Agents may read it to understand how the runtime works, but they must not treat wiki prose as a replacement for hard data, big data, or current match observations.

## Namespaces

- `official/`: project-maintained runbooks and contracts. Runtime agents read these; they do not rewrite them during play.
- `user-memory/`: user-approved preferences, habits, and postgame review notes. Runtime agents can suggest updates here only when the product memory writer is enabled.

## Current Runtime Source Order

For MuMu desktop:

1. MuMu `gi_plugin_jkchess` logcat bridge for board/bench/shop/phase.
2. Visible 4354 shop self-view anchor plus fresh 4353 gate for local board candidate promotion.
3. Resident RapidOCR over calibrated, mode-scoped ROIs for HUD fields and visible choice text.
4. Host CLI multimodal sensing only when scoped OCR is missing or ambiguous; it returns candidates and never overrides MuMu structured facts or confirmed selections.

Scene-scoped icon matching is fallback/conflict evidence only. Opponent board, opponent power scan, and counter-positioning are not product sensing paths.

MuMu desktop product UI must include a one-click `Detect MuMu and Connect` action.
That user-triggered action wraps automatic ADB target discovery and must not require users to know MuMu ports, install paths, or device serials. Normal app startup must reuse the persisted device binding and must not re-run MuMu discovery unless the user clicks bind/re-scan.

For phone/tablet or non-MuMu:

1. Companion visual/OCR bridge.
2. Structured observations only.
3. No screenshot persistence by default.

## Memory Boundary

User memory can influence communication style, risk tolerance, coaching defaults, and postgame review focus.
It must not overwrite facts from hard-data, daily big-data, or current match live_state.

## Optional Current-Match Variables

Season-specific fields are declared only by the active major-season descriptor. The
common UI renders that declaration and exposes nothing when the field list is empty.
Confirmed values are match-scoped live inputs, not long-term user memory.
