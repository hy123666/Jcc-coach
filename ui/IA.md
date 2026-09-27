# Information Architecture

## Primary App Shell

```text
+------------------------------------------+
| MuMu connected       Menu  Start  Stop  Close |
+------------------------------------------+
| Cruise | Augment | Season choice | Item | Lineup | Variables |
+------------------------------------------+
| [Pinned Result, only when needed]           |
|   阵容 / 己方站位 / 变量                    |
|   board + unit equipment + notes            |
+------------------------------------------+
| Conversation / advice stream               |
|   user asks / runtime triggers             |
|   agent answers directly                   |
|   evidence appears only when useful        |
+------------------------------------------+
| Input: free chat / open prompt       Send |
+------------------------------------------+
```

Choice modes render as structured card workflows. Augment cards, active-season cards, and item cards provide catalog-backed searchable slots and shared equipment tokens. Raw technical rows are classified before catalog generation, so reward and subchoice entities cannot leak into another choice kind. Empty candidate dropdowns browse the complete exact-stage legal list; explicit typing searches the full current-season catalog and labels cross-stage or unknown-stage matches. Unknown-stage true choices are search-only. Refresh means editing only affected slots and never auto-sends. The player may request candidate-only, whole-equipment, or whole-card advice. Candidate-bearing actions use the current canonical report revision; stale drafts cannot overwrite newer candidates. A separate final-confirm section may be used without prior advice; it atomically saves dirty candidates first, records the exact selection, and creates at most one strategy follow-up owner. A stale renderer binding may be recovered only for that final confirmation, inside the same match/stage/choice kind, when exact slot and candidate identity still match. Success is shown only after persistence and creation of the promised response task.

If persistence completed but response-task creation did not, the same card remains retryable; exact reconfirmation creates the missing single owner without appending another confirmation.

The shared equipment editor has component, completed-item, radiant-item, artifact, and emblem token groups in every structured choice mode, including Equipment choice. Each group occupies one full-width row and supports a catalog-backed dropdown, full-catalog search, whole-token Backspace, and one-click clear. Completed-item and artifact dropdowns may expose multi-tag browse facets, but typed search ignores facet boundaries. Each token edit is a no-model fact update shared across modes and stages. After daemon-owned equipment hydration, the whole-snapshot `Confirm equipment` action remains fact-only, is available with a missing or stale surrounding choice-set binding, and refreshes the current match/stage scope even when contents are unchanged; an unhydrated empty renderer draft cannot be confirmed. The separate `Whole equipment advice` action is the only equipment-editor action that opens a Coach answer. Omitted groups preserve their current value, while an explicitly submitted empty group clears only that group.

## Screen States

### No Active Match

Show:
- connect MuMu
- Start New Match
- daily chat
- postgame review
- recent match summaries
- user strategy settings
- strategy wiki entry context

Hide:
- live advice
- removed opponent scan controls
- active match state

No-match mode uses the same conversation stream, but the selected context changes what the agent is allowed to read or write:

- daily chat: normal strategy discussion
- user preferences: long-term settings and approved preference updates
- strategy wiki: user-authored strategy lines and conflict checks
- postgame review: recent structured match summaries

Data update is not a chat context. It lives under Menu -> Data update as a maintenance panel. Daily chat or review may suggest updating stale data, but the canonical entry point remains the menu panel.

### Data Update

Show:
- current Zhangmeng data date
- last successful update time
- update status
- update Zhangmeng live meta data action
- optional latest-diff / rank-signal summary action

Behavior:
- update replaces latest data after success
- previous data is retained for diff generation
- current active match continues listening
- strategy advice should use the new snapshot only after the update completes

### Active Match: Cruise

Show:
- latest final advice from host CLI model
- important trigger history
- a small contract-backed row of professional quick actions for ceiling lineup, economy tempo, adaptive lineup direction, current data, augment fit, and item/roll timing
- immediately after Start Match, the pinned Variables tab for the active major season while Cruise remains the selected mode

Do not show a permanent state dashboard. Runtime facts stay hidden unless a response needs them.

Opening the Variables tab after Start Match is a setup affordance, not a mode transition. It must not call the manual-variable backend mode, auto-confirm blank values, or create a Host response task.

The UI should not stream constant prose. It should update only when a meaningful task or advice event exists.

Cruise advice freshness follows the decision, not every raw snapshot field. Non-durable advice requires a current stage. A stable economy, tempo, lineup-direction, or equipment action may remain deliverable through unrelated same-stage churn and at most one ordinary round only while its own action fingerprint is unchanged. Scorer-driven events are revalidated in the same registered decision-trigger fingerprint domain used when admitted. Exact shop/bench actions fail closed without a material fingerprint; changed exact actions, choice boundaries, major-stage changes, elimination, and newer same-family decisions invalidate the older answer.

Opening economy advice is a compact proactive event. It uses canonical response-task delivery, distinguishes known facts, covers keep/sell, the next interest threshold, credible streak spending, and the first augment/equipment posture in at most five lines, and cannot create a sibling Host answer.

### Augment Choice

Show:
- three catalog-backed searchable augment slots for the current round and tier
- shared current equipment tokens, inherited from earlier rounds and edited only where facts changed
- recommended keep / reroll actions
- reason tied to cruise context
- confirm chosen augment action

When the user rerolls one or more slots, the card keeps every unchanged slot. The player replaces only the rerolled slots and requests advice again. No refresh control may clear all slots or auto-send. Augment mode may separately offer a user-triggered Quick OCR draft action after stage and tier are selected; it replaces the local draft only after a complete current-stage/tier catalog match and never writes canonical choice state or starts a Host answer.

Confirm chosen augment is the final-state boundary. Reported cards and rerolled cards are candidates only until final confirm.

### Major-Season Choice

The active major-season descriptor owns whether a season-specific choice mode exists, its label, fields, number of options, and report prompt. Common UI consumes the descriptor and must hide unavailable modes rather than naming an old-season mechanic.

If a selected season mechanic later creates hidden or random information that materially affects strategy, its descriptor may leave that field optional during advice and require it only for final confirmation. The structured card records the exact revealed result for the selected option as current-match user-confirmed memory; unrevealed or unselected results do not block advice.

Archived season descriptors may retain their historical choice definitions for audit. The current UI reads only the active descriptor, so an undeclared season choice mode and its missing-choice prompts remain hidden.

### Equipment Choice

Show:
- four or five catalog-backed searchable reward or forge slots, according to the selected forge kind
- the same shared equipment tokens used by augment and major-season choice cards
- own board
- own item bench
- equipped items
- target plan
- recommended pick and why

If trusted structured equipment facts are absent, use current-match user confirmation for the exact missing field. Visual candidates remain conditional evidence and must not be presented as confirmed ownership.

Equipment choice is not a general item scanner. It accepts only supported item, anvil, or forge choice cards and reads item bench plus equipped items through the shared effective equipment context.

### Manual Variables

Settings and match variables:

- active major-season primary setup fields
- active major-season advanced setup fields
- optional target plan
- current round selector
- rank tier selector

Rank tier, operation speed, default goal, and user strategy lines are long-term preferences outside this match-scoped card. If a new strategy conflicts with an older one, keep the latest confirmed strategy and surface the conflict.

The round selector writes current-match phase context. The rank-tier selector writes user settings. Both show operational status only and do not open a Host answer lane.

Manual variables reuse the pinned result slot during an active match. They are not a separate page.

### Lineup Card

Show:
- pinned result title
- 4x7 board coordinates
- current-season units
- unit items, stars, and notes when known
- loadouts
- moves and timing checkpoints
- missing cap conditions

Lineup-card output must follow `jcc-internal-lineup-plan-v1`. The renderer materializes the board from structured rows and columns; prose-only lineup-card output is rejected.

## Output Principles

Every visible coaching output should answer:

- What should I do?
- Why now?
- What evidence did you use?
- How certain are you?
- What should I confirm if the data is weak?

Keep the answer compact. Save deeper reasoning for user follow-up.
