# JCC Runtime Agent Skill And Session Design

Requirements authority is classified by
`docs/requirements/requirements-registry.json`.

## Decision

Use one root skill: `.codex/skills/jcc-runtime-agent/SKILL.md`.

Do not create one skill per mode. Mode-specific knowledge is injected as a generated context pack:

```text
root skill -> startup context pack -> match context pack -> lazy mode context pack
```

This keeps the host CLI model fast while preserving correct behavior.

## Session Model

```text
device_connection
  MuMu / ADB connection. May stay alive across games.

daily_session
  No active match. Daily chat, review, user preferences, strategy wiki.
  Uses one persistent provider-native lobby process/session until app exit or
  explicit New Conversation. New Conversation closes this lobby conversation
  and starts a new provider-native lobby conversation without clearing durable
  preferences, Wiki, review records, MuMu, or an active match.
  Must not write current-match live_state.

match_session
  One active game. Start Match creates a new match_session_id, starts one
  persistent match provider process/session, and clears match-scoped state.
  Repeated turns within the live game reuse that provider process/session.

response_task
  One host-model answer. Input-box square Stop cancels only this answer.
  If the provider has not exposed a targetable turn/prompt yet, cancellation is
  reported as pending or failed; JCC does not kill the provider transport to
  manufacture a successful Stop.
```

Start Match is not reconnect MuMu. Stop Match first preempts an unfinished
match-provider bootstrap, then closes the active match provider process/session
and returns to the existing lobby provider process/session; it is not disconnect
MuMu. Exit closes all lobby, match, provider, watcher, OCR,
daemon-owned child, and app runtime resources.

A clean app Exit invalidates any active match route in canonical state. The
next app launch cannot recover that match; it requires a new Start Match. An
unclean provider/runtime interruption may try provider-native resume/load once.
If the saved thread/session no longer exists, JCC starts one fresh native
conversation for the still-active owner, bootstraps static context once, and
includes the current turn. It does not replay the old transcript or loop
resume attempts.

Provider session resume is crash/recovery only. Normal repeated turns inside a
live lobby or match provider process/session are not "resume" operations and
must not use provider memory as gameplay truth.

Codex `thread` and Kimi ACP `session` are the conversation/history mechanisms.
They own native transcript retention and native context compaction. JCC Runtime
does not replay earlier chat messages and does not create a parallel transcript
or summarization system. SQLite owns current product/game facts; the native
provider conversation supplies dialogue continuity.

If rules, rankings, published Wiki, user preferences, or another static
fingerprint input changes while the owning process/session is alive, send one
versioned static-context update inside that same live session. This is neither
a new session nor a resume operation.

## Startup

Startup should do only cheap, durable preparation:

- Check hard-data/catalog presence.
- Check live ranking/current data status.
- Load user memory and recent match summary entry points.
- Generate a startup context pack.
- Enter `daily_session`.

Startup should not:

- Re-scan MuMu if a device is already bound.
- Start watcher.
- Create a match session.
- Write current-match live_state.

MuMu discovery is a settings/menu action: Connect / Re-scan MuMu.

## Start Match

Start Match should:

1. Run `tools/start-jcc-new-match-session.mjs` and require the new canonical
   `match_session_id` to succeed before changing the old match route.
2. Close any previous match provider route while leaving the lobby route alive.
3. Commit the new match boundary, clear only match-scoped state, and start the
   watcher/OCR workers with the new `match_session_id`.
4. Generate the match context pack.
5. Start one new persistent match provider process/session, inject its static
   capsule once, and wait for that bootstrap result before reporting Start
   Match readiness.
6. Enter cruise mode. If provider bootstrap is unavailable, keep the new match
   boundary and report retryable provider readiness; never restore the old
   match and risk cross-match pollution.

## Mode Injection

Static common, season, hard-data, daily-ranking, strategy-wiki, and economy
context is injected once per provider-session fingerprint. Dynamic current
facts are injected per turn: response identity, active mode, current turn
contract, live_state summary, match variables, confirmed choices, current user
intent, semantic event focus, missing facts, and cancellation state. Prior chat
turns are not resent. Runtime SQLite remains the source of product/game truth;
the provider-native conversation owns dialogue history and compaction.

Use lazy mode packs:

- `daily_chat`
- `postgame_review`
- `user_preferences`
- `strategy_wiki`
- `cruise`
- `augment_choice`
- `god_sequence`
- `item_choice`
- `lineup_card`
- `refresh_self_state`
- `manual_match_variables`

The host model should only receive the active mode pack plus current state/evidence.
