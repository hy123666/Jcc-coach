# Compatibility Boundary

Compatibility code is classified by purpose:

- `source_identity`: upstream provenance and association keys; never game
  semantic authority.
- `migration_input`: read-only legacy input accepted only by an explicit
  migration guard.
- `compatibility_adapter`: shape or naming translation at a boundary; it must
  resolve through current Core/Ranking identity before producing product data.
- `retired_authority`: old current pointers, raw family bindings, and legacy
  publishers retained only as rejection evidence or historical references.

Raw family IDs remain opaque source-row identifiers for fetch association,
history, deduplication, and audit. They must not select a trait, lineup
meaning, score, or other game rule.
