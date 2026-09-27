# Ranking Migration Boundary

This directory contains one-time migration inputs and guards only. It is not a
production refresh, update, or promotion surface.

`migrate-jcc-current-ranking-generation.mjs` may copy a legacy `current/`
compatibility directory into one immutable Ranking generation only when the
Active Ranking closure does not yet exist. Once the closure exists, the script
fails closed and the registered full refresh pipeline is the only entrypoint.

Migration input is evidence for conversion. It does not grant source rows,
raw family IDs, or legacy current pointers authority over game semantics.
