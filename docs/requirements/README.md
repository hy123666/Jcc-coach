# JCC Requirements Authority

This directory is the machine-readable authority layer for JCC Runtime
requirements.

The source of truth is `docs/requirements/requirements-registry.json`. It
classifies requirement-like files by status and authority tier so historical
plans, paused prototypes, and generated review snapshots cannot override the
current product baseline.

## Authority hierarchy

The registry decides which artifacts are allowed to define acceptance criteria;
it does not replace the domain contracts that define behavior. Resolve authority
in this order:

1. Use the registry's `authority_domains` to find the owning machine contract,
   guidance, implementation, and verifier paths for the behavior being changed.
2. The domain's registered machine contract defines executable behavior. A
   selected version module or data manifest is authoritative only through that
   contract's active tuple and resolution rules.
3. Current product requirements and runbooks explain intent and operation. The
   append-only changelog records decisions and supersession history.
4. `AGENTS.md` and `.codex/skills/jcc-runtime-agent/SKILL.md` are discovery and
   authoring entrypoints. They are not fallback product authorities and cannot
   override a registered machine contract.
5. Verifiers and the core product gate enforce the chain. A conflict between an
   entrypoint and its owning contract is a release-blocking drift defect, not a
   reason to choose whichever text is more convenient.

## Requirement change workflow

Every product decision change must update the authority layer in the same
change as the implementation:

1. Update the current machine contract and the current product/engineering doc
   that owns the behavior.
2. Update `requirements-registry.json`: bump `contract_version` when behavior
   changes, refresh `last_reviewed`, and reclassify any superseded source.
3. Append the decision to `CHANGELOG.md`, including the new behavior, the old
   behavior it replaces, affected authorities, and required verification.
4. Add `REQUIREMENTS-STATUS` banners to newly historical, paused, or generated
   spec-like documents.
5. Run the authority verifier and the core product gate.

A new PRD, design, plan, runbook, or engineering contract is not a current
requirement until it has a registry entry. Review prompts must read the registry
first and exclude `historical`, `paused`, and `generated` entries from release
acceptance.

The authority verifier scans every Markdown requirement surface in the repository.
Each file needs an exact registry entry unless it lives below an explicitly
classified non-current entry with `covers_subtree: true` and `scope_root`. Current
requirements cannot inherit broad subtree authority; they must be registered
individually so an unreviewed PRD cannot silently become current.

## Versioned change routing

Keep universal behavior, major-season mechanics, and minor-patch evidence in
separate ownership layers:

| Change kind | Owning layer | Required default action | Must not happen |
| --- | --- | --- | --- |
| Provider-neutral coach behavior | `host-coach-instruction-contract.json` plus its shared builder | Update the canonical contract, its verifier snapshots, registry metadata, and decision log | Copy S17, patch, or fixed-stage mechanics into common instructions |
| Cross-season game doctrine | `data/game-knowledge/jcc/common/` through the Core Profile compiler | Change only behavior that remains valid when the active major season changes | Use Common as a fallback copy of a current season mechanic |
| Major-season mechanics | `data/game-knowledge/jcc/seasons/<season_id>/season-descriptor.json`, compiled into the immutable Core Profile | Add a new descriptor and promote a verified complete profile for new matches | Mutate one season into another or leave absent retired mechanics advertised in a future season |
| Ordinary minor patch | New hard-data package/manifest, live rankings, optional patch strategy override, and the promoted tuple | Refresh data and strategy priors; preserve old package/history; apply to new matches | Edit common instructions or major-season rule timing for balance, popularity, or meta-only changes |
| Exceptional same-season rule change | Audited `rule-overrides.json` declared by the season contract | Declare exact changed surfaces, old/new behavior, applicability, rollback evidence, and run isolation tests | Generic deep merge, undeclared payload, or silent in-place mutation |

An ordinary small patch therefore uses the version-governance mechanism, but it
does not enter the common instruction or major-season rule layer. Update the
requirements registry itself only when authority classification, an owning
contract, a requirement-like document, or governance behavior changes. Record
the promoted patch decision in the changelog for rollback and audit history.

Current runtime requirements must agree with these invariants:

- JCC Runtime daemon owns durable state in `.jcc-runtime-data/app.sqlite`;
  legacy JSON is mirror/debug output only.
- Active augment, active-season, and item/anvil choice candidates come from a
  current-match user report. These flows do not use OCR or host multimodal
  fallback. Scoped RapidOCR remains the product path for HUD self-state and the
  explicit owned-augment text-panel recovery action.
- MuMu `4357` is the primary left item rail / inventory source.
- MuMu `4356` may become own equipped items only after `S=1` plus a fresh
  non-empty `4354` shop anchor and trusted `4353` coordinate assignment.
- Opponent board, opponent power scan, and counter-positioning current-view
  product paths are removed. Use user-confirmed scouting notes only.
- Runtime UI mode semantics are defined by
  `data/runtime/jcc/runtime-ui-mode-contract.json`, including `lineup_card`.

Run:

```powershell
node tools\verify-jcc-requirements-authority.mjs
```
