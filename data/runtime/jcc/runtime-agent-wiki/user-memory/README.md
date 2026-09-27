# User Memory

This namespace stores user-approved long-term memory for coaching.
It is separate from official runtime instructions.

## Allowed Memory

- Preferred playstyle, such as aggressive tempo, economy greed, or safe top-four lines.
- Comfort picks and disliked comps.
- APM and attention constraints.
- Postgame review notes.
- Repeated mistakes the user explicitly wants tracked.
- Communication preferences for in-game advice.

## Forbidden Memory

- Current match facts from old sessions.
- Unverified board or item states.
- Account secrets, credentials, or private tokens.
- Strategy facts that should come from hard-data or daily big-data.

## Suggested Page Shape

```json
{
  "schema": "jcc-runtime-user-memory-v1",
  "updated_at": "YYYY-MM-DDTHH:mm:ssZ",
  "rank_tier": "unknown",
  "operation_speed": "normal_can_pivot_next_round",
  "default_goal": "balanced_climb",
  "preferences": [],
  "habits": [],
  "review_notes": [],
  "recent_match_summary_refs": [],
  "do_not_assume": [],
  "source": "explicit_user_confirmation"
}
```

Recent match summaries are capped by
`data/runtime/jcc/runtime-user-settings-and-review-contract.json`. Store
structured decisions and review tags only; do not store raw screenshots, full
logcat, or previous-match concrete board state in user memory.
