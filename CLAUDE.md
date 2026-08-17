# Boardroom — project instructions

Boardroom is heading toward public distribution as a downloadable local app.
That raises the bar on security, licensing, maintenance burden, and polish —
and changes how we build: we are a small team and cannot own every subsystem.

## Rule: adopt before build (OSS-first)

Before implementing any non-trivial capability, run the search-and-comparison
pipeline for existing open-source solutions. Building it ourselves is the
fallback, not the default, and requires a written justification.

### When to trigger the pipeline

Trigger it far more often than feels necessary. Concretely, always trigger for:

- Any new dependency-shaped capability: packaging/installers, auto-update,
  code signing/notarization, crash reporting, telemetry, log rotation.
- Anything security-sensitive: auth/token handling, sandboxing, IPC,
  secrets storage, input validation, rate limiting. (Never hand-roll crypto.)
- Protocol/format work: MCP plumbing, SSE/WebSocket handling, parsers,
  serialization, schema validation.
- UI infrastructure: component patterns, virtualized lists, diff viewers,
  markdown rendering, state sync.
- Anything a first-time external user touches: onboarding, config migration,
  error surfaces, uninstall.

Skip only for: trivial glue (< ~50 lines with no edge-case surface), code
that is the product's core differentiator (the decision-layer UX itself), or
where a prior recorded comparison already covers the need.

### The pipeline

1. **Search** — web search (or the deep-research skill for big decisions) for
   existing libraries/tools/products solving the need. Cast wide: npm,
   GitHub, awesome-lists, how comparable apps (e.g. other Electron/menu-bar
   or local-daemon apps) solve it.
2. **Shortlist** 2–4 candidates and compare on:
   - License compatibility with public distribution (permissive — MIT/
     Apache-2.0/BSD/ISC — is fine; copyleft (GPL/AGPL) needs explicit
     sign-off from Geo before adoption).
   - Maintenance health: recent commits/releases, open-issue triage,
     bus factor.
   - Security posture: audit history, CVE record, dependency tree size
     (supply-chain surface), install scripts.
   - Fit: API match to our need, runtime/bundle weight, TypeScript support.
3. **Present the comparison** before writing code — a short table plus a
   recommendation (adopt X / wrap X / build custom because Y).
4. **Record the decision** in the feature's plan/spec doc under
   `docs/superpowers/` (existing dated-file convention), including the
   rejected candidates and why — so the comparison isn't re-litigated later.

### Supply-chain caution (adopting is not risk-free)

OSS-first does not mean dependency-maximal. Every adoption must clear this
vetting bar — a feature match alone is not enough:

- **Small dependency trees preferred.** A candidate dragging in hundreds of
  transitive deps needs strong justification; each transitive dep is
  supply-chain surface we ship to users.
- **No install scripts.** Reject or sandbox packages with `postinstall`/
  `preinstall` hooks unless the script is audited and pinned.
- **Maturity floor:** >1 year old, a release or meaningful commit within the
  last 6 months, real adoption (downloads/dependents), ideally >1 maintainer.
- **Pin exact versions**, commit the lockfile, and review upgrade diffs —
  Dependabot PRs get read, not auto-merged.
- **Check CVE history and `npm audit`** before adoption, not after.
- **Safety overrides the default:** for security-critical needs where no
  candidate passes this bar, a minimal in-house implementation beats a risky
  dependency. OSS-first yields to supply-chain safety, never the reverse.

### Default bias

When a maintained, license-compatible candidate covers ≥80% of the need,
adopt it and wrap the gap. "We could build a nicer one" is not a
justification; "no candidate passes the license/security bar" or "the need
is our core differentiator" is.
