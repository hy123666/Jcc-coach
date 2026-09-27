# Design

Requirements authority is classified by
`docs/requirements/requirements-registry.json`; runtime mode semantics are
machine-defined in `data/runtime/jcc/runtime-ui-mode-contract.json`.

## Design Read

This is a product UI for a live game coach, with a restrained tactical cockpit language. It should feel closer to a professional command surface than to a landing page or streamer overlay.

## Visual Direction

Use a dark operational theme by default because the product runs beside a game client, often during focused play. The background should be quiet and neutral, with one controlled accent for active mode, current recommendation, and selected state.

Recommended visual language:

- Dense but organized.
- Low-glare dark neutral surfaces.
- Crisp dividers instead of stacked decorative cards.
- Compact mode controls with icons and short labels.
- Monospace only for structured state, IDs, logs, and CLI-board renderings.
- Clear distinction between observed facts, pending visual requests, confirmed user memory, and AI advice.

Avoid decorative gradients, animated hero moments, nested cards, rounded pill overload, and big marketing copy.

## Layout

Desktop-first sidecar shell:

1. Top control strip
   - MuMu connection status, independent from match session state
   - match session Start / Stop controls; these do not connect or disconnect MuMu
   - top-right Stop means stop the current match_session, not pause a response
   - settings menu
   - close Runtime UI control

2. Mode stack
   - Cruise mode
   - Augment choice
   - God choice
   - Equipment choice
   - Refresh own status
   - Manual variables
   - Daily chat / postgame review when no active match is running

3. Conversation stream
   - system-triggered coaching messages
   - user questions
   - final host-model advice
   - compact evidence only when the advice needs it

4. Pinned result card
   - one shared slot for `lineup_card`, self-board placement notes, or match variables
   - appears when the current answer produces a board, lineup, or variable editor
   - stays in a fixed middle region and does not scroll away with chat history
   - stays visible until replaced by a newer result
   - supports internal hidden scrolling for small screens
   - also remains copied into the conversation history as text

5. Bottom input
   - current-mode prefilled prompt
   - send action
   - while a host-model answer is active, Send becomes a square Stop response button
   - Stop response cancels only the active answer/output task, keeps MuMu connected, keeps match_session live_state, and returns the UI to cruise or the current mode prompt
   - compact attachment/status affordances when needed

Default sidecar dimensions:

- expanded width: 360-420 px
- collapsed width: 64-72 px
- height: match MuMu window height or roughly 90-100vh
- placement: snap to MuMu's right side by default

## Component Rules

- Use segmented controls for mode groups.
- Use icon buttons for fast actions, with tooltips.
- Use compact chips for confidence, source, freshness, and urgency.
- Use toggles or checkboxes for binary settings.
- Use inputs or steppers for numeric values such as rank, operation speed, or manual HP/gold corrections.
- Use searchable select for large lists such as encounters.
- Use simple lists for advice actions; no nested cards.
- Use the menu as a floating settings layer, not as a navigation page.
- Daily chat, user preferences, strategy wiki, and postgame review are no-match conversation contexts.
- MuMu can stay connected in daily chat and postgame review; no-match means no active match session, not no emulator connection.
- Manual variables should use compact data-entry controls, not rows of large option buttons:
  - encounter: searchable text input with a dropdown suggestion list and alias matching
  - god 1 / god 2: native select controls
  - observer: native select control
  - target direction: editable multiline text
- Host CLI Agent settings should mirror local CLI detection patterns: scan local CLIs, show detected CLI cards, select a model from the CLI-provided model list, and choose reasoning effort. Do not add a separate "test multimodal ability" primary action; use helper text to tell the user that the selected host model should support multimodal input.
- The host CLI panel should prioritize discovered local agents only. Do not turn this surface into an installer marketplace.
- Data update is a menu-level maintenance surface, not a daily-chat or postgame-review mode. It should show the current data date, last update time, update status, and one primary action for updating Zhangmeng/live meta data.
- Strategy Wiki entry must also show existing saved strategy lines so the user can inspect what has already been written before adding a new rule.

## CLI Board Rendering

`lineup_card` and self-board placement advice should support a mechanical board renderer. In the final UI this is not a raw terminal block; it is a refined symbol-like board card using the same structure:

- 4 rows by 7 cells.
- Row 1 and row 3 visually offset left by half a cell.
- Row 2 and row 4 visually offset right by half a cell.
- Each cell has stable width.
- Cell content is the unit name only.
- Equipment, star level, and reasons are listed below the board.
- Row 1 and row 3 are a shorter row aligned left.
- Row 2 and row 4 are the same shorter width aligned right.

The model should output structured positions; the renderer turns them into the board. The model should not hand-format the board manually.

Visual treatment:

- dark board surface
- low-brightness grid lines
- near-white unit names
- amber or green border for recommended move cells
- red warning mark for danger cells
- empty cells stay subdued

## AI-Native Advice

The UI should not display backend scorer drafts as final advice.

Correct flow:

```text
runtime facts
-> estimator / scorer / pending visual requests
-> response_request for host CLI model
-> host model returns final advice_response
-> UI displays final advice_response
```

The visible answer should be short and actionable, but it appears as normal chat/advice text rather than a separate fixed "advice panel":

- conclusion
- why it matters
- exact action
- evidence used
- confidence or uncertainty
- next user input if needed

The UI may store structured fields for rendering, but the final sentence should come from the host CLI model whenever a coaching response is required.

## Color Tokens

Use OKLCH tokens when implementation begins. Initial direction:

- body background: near-black neutral
- surface: slightly lifted neutral
- surface-muted: side rail, floating settings, and result details
- border: low-contrast neutral line
- ink: high-contrast text
- muted: secondary labels
- accent: one cool tactical accent
- success / warning / danger: reserved for state, not decoration

Do not use the default AI purple/blue glow palette.

## Motion

Motion is for state only:

- active mode transition
- pending request to completed request
- advice update
- snapshot recorded
- warning raised

Keep transitions around 150-250 ms. No page-load choreography.

## Empty, Loading, Error States

Required states:

- no MuMu detected
- MuMu detected but game not running
- active match but no stable self-view yet
- visual request pending
- host model response pending
- removed opponent scan unavailable
- no target plan selected
- postgame history empty
- stale live_state warning
- low-confidence visual observation

## Open Design Direction

If Open Design is used to generate a prototype, use it for high-fidelity exploration of the app shell and panels. It should not create a marketing landing page, even if the project metadata says `includeLandingPage=true`.
