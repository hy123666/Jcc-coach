# Product

## Register

product

## Users

Players using MuMu on desktop while running a CLI-agent-backed JCC runtime coach. They are in a live match, often under time pressure, and need short, actionable advice without losing attention from the game.

The primary user context is not browsing or studying. It is live play: choosing augments, deciding whether to hold units, preserve interest, level, roll, pivot, slam items, or adjust the user's own board.

## Product Purpose

JCC Runtime Coach is a desktop companion UI for a runtime agent that watches the current match, keeps a structured live state, and asks the host CLI model for AI-native coaching when useful.

The UI should make these things fast:

- Open JCC Runtime from a recognizable desktop shortcut after installation;
- Connect to MuMu and start or stop a match session.
- Keep cruise mode running as the default live coach.
- Trigger focused task modes when the player needs a decision.
- Show short AI-native advice directly in the conversation stream.
- Render lineup and own-board placement plans as readable text or CLI-board layouts instead of fragile external lineup codes.
- Support postgame review and user strategy memory outside active matches.

Success means the user can keep playing while the coach quietly tracks state and only speaks when the advice is worth attention.

On Windows, the installed product must create desktop and Start Menu shortcuts
named `JCC Runtime`. A second launch focuses the existing window instead of
starting another Runtime stack. Development shortcuts may use the repository
launcher, but player shortcuts must target only the installed executable.

## Core Modes

### Cruise Mode

Default always-on mode during an active match. It listens continuously, refreshes key state, queues visual requests when needed, and creates advice requests only when there is a meaningful trigger.

Cruise should cover early, mid, and late game:
- Early: opener direction, item slams, hold or sell units, interest breakpoints, win-streak or lose-streak posture.
- Mid: augment fit, level or roll timing, board stabilization, pivot pressure, economy risk.
- Late: cap gap, survival pressure, item completion, own-board placement, final board upgrades.

When the player has not confirmed a durable target, Cruise still advances the
lineup conversation proactively. Stage 2 should present two or three candidate
directions with equipment, augment, card, economy, HP, and ranking entry
conditions. After 3-2 it narrows to one primary and one backup, including carry,
tank, roll level, and what the next major choice could change. Around 3-5 to
3-7 it recommends relative convergence or explains why waiting for the next
major choice is justified. After 4-2 it moves to commit/pivot execution. This
agenda does not require the player to press the lineup-direction quick action.
When a target already exists, Cruise stops reopening generic candidate discovery
but still runs a post-4-2 execution checkpoint that validates continue versus
exit conditions and gives the immediate roll, level, economy, item, or transition
action. The quick action remains an on-demand re-evaluation only.

Cruise also exposes a compact, contract-backed set of professional quick actions. These actions make expert concepts discoverable without hardcoding a season: ceiling lineup, economy tempo, lineup direction, current data, augment fit, and item/roll timing. Lineup direction validates a durable target when one exists; without one it discovers candidate directions from the current stage, board, bench, equipment, choices, economy, HP, and rankings instead of pretending a ranking line is already the player's target. The label explains the concept through a tooltip. Open-ended actions such as current data and ceiling lineup prefill and focus a general prompt so the player can add the actual subject before sending.

### Task Modes

Task modes are temporary high-priority contexts. They return to cruise when done.

- Augment choice: let the player search and select the three visible choices plus shared current equipment in a structured card, or explicitly run Quick OCR after selecting stage and tier. Each uniquely recognized legal row fills only its physical local slot; partial results keep unresolved/manual rows and show the recognized count. OCR never auto-sends or becomes choice truth until the player reviews and submits the card. Advise hold or reroll, react to slot-level refresh edits, and record the final confirmed choice in the same card.
- Major-season choice: derive the visible mode, report shape, and fields from the active major-season descriptor. Common UI must not embed a specific season mechanic.
- Equipment choice: let the player search and select reward or forge choices in a structured card and combine them with trusted own items, shared user-confirmed equipment, board, augments, and plan.
- Refresh own status: run a scoped current-match refresh. Stage, HP, gold, level, and XP use HUD ROI OCR; own shop/board/bench and trusted item facts continue to prefer MuMu structured sources. Active choice truth never comes from automatic OCR or vision; the separate augment Quick OCR action can fill only a user-reviewed renderer draft. Item icon matching is limited to an explicit missing-field fallback or conflict check.
- Manual variables: collect the active major season's setup fields plus an optional target plan. Rank tier, operation speed, default goal, and long-term strategy belong to user preferences rather than match setup.
- Daily chat / postgame review: only available when no active match is running or the match is stopped.

Augment, major-season, and item choices are card workflows. Raw source assets are classified before becoming player-facing options, so star-god rewards and internal reward subchoices cannot appear as augments. Opening an empty candidate dropdown shows the complete exact-stage legal list for the selected tier. Typing searches the full current-season catalog: known cross-stage matches remain visible with their legal stage but cannot be confirmed in the wrong stage, while unknown-stage true augments are visibly marked and require explicit current-match selection. Natural-language chat may add context, but it never writes candidate sets or final choices. Automatic OCR/vision candidate intake remains disabled. Augment mode alone may provide a user-triggered Quick OCR draft; Start Match prewarms the single shared OCR worker, then the click captures the current frame and sends the full frame plus normalized panel ROI to that resident worker for in-memory crop and recognition before resolving the three rows against the active generated decision-input catalog. Sharing the worker removes duplicate model processes, prewarming loads that one model before the time-limited choice window, and the hot click path does not start a separate Python/Pillow crop process. The catalog is valid only when its season, patch, and deterministic source fingerprint over the exact manifest, normalized catalog inputs, alias gateway, stage authority, and common/major-season choice rules match the active runtime. Any same-version source drift fails closed before dropdown, search, save, confirmation, or OCR consumes it. Each recognized result must match the selected stage and tier, populate only its physical card slot, update only the local card, preserve unresolved or newer manual slots on partial/failure, discard late results after newer player edits or a match boundary, and wait for explicit submission. Reports and drafts remain scoped to their exact match/stage, and identical concurrent submissions collapse into one report. Owned-augment panel OCR remains diagnostic and cannot confirm a choice. Refreshing means editing only the slots that changed; it never auto-sends. The player may request candidate-only or whole-card advice, but advice is not a prerequisite for final confirmation: one confirm click atomically saves dirty candidates without a model answer and then confirms the selected option with exactly one strategy follow-up owner.

If that exact selection is persisted but the follow-up owner cannot be created, the card stays open with a retryable local status. Reconfirming recovers the missing owner instead of duplicating the selected-choice fact.

Structured-card drafts are current-match work, not disposable view state. Tier, stage, candidates, target note, and the selected option survive a temporary return to Cruise and reappear when the player reopens the mode; Start Match and Stop Match are the reset boundaries. Candidate-bearing saves and advice must use the current canonical report revision, so an older card cannot overwrite a newer candidate set. Final confirmation may recover a stale renderer binding only inside the same match, stage, and choice kind when the exact slot plus candidate identity is still current. An explicit card advice or final-confirm action remains the one response owner until terminal delivery, even when a choice-window reservation or stage update arrives. A punctuation-only status check reports that existing task instead of replacing it. Final-confirm success is visible only after persistence and creation of the promised response task; its semantic observer cannot create a second answer. A successfully rendered response may return the temporary mode to Cruise after acknowledgement. A failed card response is acknowledged as an error but keeps the card mode and draft open for correction or retry.

All structured choice cards expose one shared current-match equipment editor for components, completed items, radiant items, artifacts, and emblems. Each category is one full-width row with a catalog-backed dropdown. Add, remove, and clear operations persist as no-model facts and immediately inherit across stages and modes. After the daemon-owned equipment snapshot is hydrated, `Confirm equipment` writes the whole visible snapshot as a fact without opening the Host answer lane and works even when the surrounding choice card has no reported candidates or carries a stale choice revision. The button remains unavailable while the renderer still holds an unhydrated default, preventing an accidental empty-inventory confirmation. Reconfirming unchanged contents refreshes the equipment fact into the active match and current stage instead of being dropped as a no-op. `Whole equipment advice` is the separate explicit action that asks the Coach to evaluate all current equipment with live context. Empty completed-item and artifact dropdowns may be narrowed with lookup facets; explicit typing always searches the full equipment category regardless of facet. Category-only advice is intentionally absent because it would ignore the rest of the owned item state.

The S17 star-god choice is descriptor-owned. S17 exposes a god-card two-choice mode from the active Core Profile's `season.runtime_contract`; S18 or any future season without an equivalent descriptor hides that mode and its missing-choice prompts. A descriptor may mark a selected reward as delayed or random: advice can proceed while it is unrevealed, but final confirmation records the exact revealed reward for the selected option only.

Item mode is intentionally narrow. It handles user-reported item, anvil, and forge choice cards plus item-dependent advice from the same shared equipment editor used by other choice cards. It is not a general inventory scanner, opponent item scan, or hero/item reward three-choice path.

## Primary UI Shape

The product is a vertical sidecar next to MuMu, not a large dashboard.

Default layout:

- Top: connection, start, stop, collapse.
- Middle: mode buttons.
- On successful Start Match: keep Cruise selected and immediately reveal the pinned Variables tab so setup is discoverable. Showing the blank card does not switch backend mode, confirm facts, or create a Host answer.
- Body: conversation and advice stream.
- Bottom: input box with current-mode prefilled prompt.

Setup may expose round and tier selectors. The round selector writes current-match phase context only. The rank-tier selector writes user preference context only. Both are status-only controls; neither creates a strategy answer.

Do not keep these fields always visible:

- current phase
- current mode
- gold, HP, level, XP
- current augments
- item bench
- board core units
- current target direction

The backend knows those facts. The UI should reveal them only when the user requests "refresh own status" or when a piece of evidence is needed to explain an answer.

Equipment ownership uses trusted structured facts first. If those facts are unavailable and a current decision materially depends on items, Cruise may ask one concise contextual question in the conversation. The player can answer naturally or update the shared equipment tokens embedded in the current choice card. The narrow Equipment Choice mode remains available for forge/anvil decisions, but there is no separate permanent general-inventory report mode or empty-send preset. Confirmation is scoped to the active match, while explicit Refresh own status remains the only user-facing path that may run bounded visual item fallback.

HUD numeric facts are promoted independently. If the HP crop is unavailable or rejected, HP remains unknown while valid stage, gold, level, and XP from the same frame may still update. Missing text must never become zero through numeric coercion. During an active match, non-positive HUD HP is not a life total or elimination signal unless the runtime separately confirms elimination or match end. Previously persisted false-zero HUD authority is cleared on hydration or a later failed refresh without erasing valid sibling facts.

Lineup and own-board placement outputs use a pinned result card. Ordinary advice stays in the conversation stream. If an answer contains a board, lineup, or placement plan, the UI pins that result near the top until a newer board result replaces it. The lineup card must use the strict `jcc-internal-lineup-plan-v1` shape: renderer-safe 4x7 row and column coordinates, current-season champion names, loadouts, and moves. Prose-only lineup-card answers are invalid.

Ceiling-lineup and data quick actions prefill only a short open-ended question for the player to complete. When the player sends it, runtime attaches the active season catalog, current hard data, daily big data, current match facts, confirmed choices, shared equipment context, and missing-condition evidence without exposing that payload in the composer.

Cruise also exposes `快速记录` as a separate editable prefill. Only this explicit control sends the hidden `match_fact_capture` request kind. The Host normalizes player shorthand, speech-to-text mistakes, quantities, corrections, equipment holders, confirmed choices, and descriptor-owned season variables; Runtime then validates canonical identities and writes only accepted current-match facts. Its Agent reply is a factual receipt, never strategy advice or target-lineup confirmation. Ordinary chat that happens to use the same words remains ordinary conversation and cannot write those facts.

Opening economy advice is a compact proactive result delivered through the same canonical response-task lane as other host answers. In at most five short lines it should distinguish known facts, the immediate keep/sell action, next interest threshold, whether spending for a credible streak is justified, and what first-augment or equipment fact can change that posture. It must render exactly one strategy answer and must not create a parallel follow-up.

Proactive delivery uses decision-scoped freshness. Durable confirmations survive normal fact updates; non-durable advice requires a current stage. Economy, tempo, lineup-direction, and equipment actions may survive at most one ordinary round while their own action fingerprint remains unchanged and no newer same-family decision changes the action. Scorer-driven events use the same registered decision-trigger fingerprint at admission and delivery. Shop and bench instructions remain exact-stage and material-state strict and fail closed without the required fingerprint. Choice windows, major-stage transitions, elimination, and newer contradictory decisions invalidate older advice.

## Brand Personality

Sharp, calm, tactical.

The UI should feel like a serious live coaching cockpit, not a streamer overlay, not a landing page, and not a decorative game companion. It should be dense enough for repeated use, but with strong hierarchy so the user can scan it under pressure.

## Anti-References

Avoid:

- AI-purple gradient dashboards.
- Hero sections or marketing-style first screens.
- Card-heavy pages where every group floats in a card.
- Decorative glassmorphism, bokeh, or oversized illustrations.
- Long chain-of-thought style model output.
- Fragile manual ROI debug surfaces in the main product UI.
- External lineup-code generation as the primary recommendation format.

## Design Principles

1. Live play first.
   Every primary action should be reachable without interrupting the match.

2. Advice is event-driven.
   The runtime listens constantly, but the coach speaks only when the trigger is meaningful.

3. Facts stay separate from recommendations.
   Live state, visual observations, user confirmations, and AI advice must be visually distinct.

4. User confirmation is a first-class input.
   When the user confirms an augment, god, item choice, or personal strategy, the UI should preserve that as stronger evidence than inferred observations.

5. Prefer stable text and board renderings over brittle import codes.
   Since official lineup-code generation is not reliable enough, the product should present readable boards, unit moves, and item lists directly.

## Accessibility & Inclusion

Target WCAG AA for text contrast and interactive states. Use reduced-motion alternatives. The interface should be usable at desktop scale while the game is visible, so density, focus states, keyboard shortcuts, and predictable button placement matter more than decorative motion.
