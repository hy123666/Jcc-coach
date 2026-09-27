# Host Multimodal Visual Sensing Runbook

Requirements authority is classified by
`docs/requirements/requirements-registry.json`.

Host multimodal visual sensing is fallback evidence. It is used when the user
asks a question that needs current visible screen facts and MuMu structured
sources or scoped HUD / owned-augment text-panel OCR are missing or ambiguous.
It is not a fallback for active augment, descriptor-owned season choice, or
item/anvil candidate intake; those choice candidates are current-match user reports only.

Examples:

- "The scoped HUD RapidOCR path missed current gold, level, XP, or HP."
- "The user asked about a current visible non-choice fact that MuMu structured
  sources cannot provide."

## Trigger Policy

The runtime agent may trigger one current-frame visual observation when the user asks for immediate advice or when a high-value runtime mode is active and the primary structured/text path cannot provide enough evidence.
It should not replace MuMu GI for board/bench/shop/item structure, HUD ROI for
phase/economy text, owned-augment text-panel OCR for explicit recovery, or
current-match user reports for active choice candidates.

## Capture Policy

- Do not persist screenshots by default.
- Send the transient frame to the host CLI agent's native multimodal model.
- Emit structured observations only.
- Persist frames only in explicit debug/fixture mode.
- Scope every observation to the current `match_session_id`.
- Treat the result as fallback/conflict-check evidence unless the current mode
  explicitly accepts host vision because primary text/structured sensing failed.
- Do not emit active augment, descriptor-owned season-choice, or item/anvil candidate names from
  host vision. Ask for the current-match user report instead.

## Structured Output

Host multimodal visual sensing should produce candidates under:

- `economy.hp` when HUD RapidOCR is missing or ambiguous
- `economy.gold` when HUD RapidOCR is missing or ambiguous
- `economy.level` when HUD RapidOCR is missing or ambiguous
- `economy.xp` when HUD RapidOCR is missing or ambiguous
- `augments.selected_augments` only as a user-confirmed/manual-panel fallback
  candidate, never as automatic final selected augment state
- `items.item_bench_candidates`
- `items.visible_equipment_unassigned`

Primary item facts are MuMu structured sources: `4357` for the left item rail /
inventory, and gated `4356` to trusted `4353` coordinates under `S=1 + fresh
4354`. Host vision and icon matching must remain fallback/conflict-check
evidence and must not override those sources. All fields are candidates unless
another source verifies them or the user confirms them. Opponent board/unit facts
are not a product visual sensing path; use user-confirmed scouting notes instead.
Active choice candidate fields such as `augments.choices`, descriptor-declared
season-choice fields, and `items.choice_options` are populated only from
current-match user reports and explicit confirmations, not host vision.

## Catalog Resolution

Use `data/runtime/jcc/mumu-catalog-overlay.json` and `data/runtime/jcc/visual-icons/manifest.json` as reference data:

- champion names and icons;
- augment and active descriptor-owned choice names and icons;
- equipment names and icons;
- trait names and icons.

The icon files are reference assets for the host multimodal model, not live template-matcher output.

Do not use MuMu lineup recommendation data as strategy input.
