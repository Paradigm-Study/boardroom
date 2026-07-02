# Session Scroll Memory Acceptance Contract

Goal: when the dashboard switches between sessions, the visible decision flow starts at the right place: top on first visit, previous offset on return.

## Criteria

- `crit-first-visit-top`: First visit to a different selected session starts at the top of the decision flow.
  - Good: switching from a scrolled Session A to first-time Session B calls the page scroll to top.
  - Bad: Session B inherits Session A's scrolled-down offset.
  - Traces to: `scroll_strategy`

- `crit-return-restore`: Returning to a previously visited session restores that session's saved scroll offset.
  - Good: after scrolling Session B and switching back to Session A, Session A returns to its saved offset.
  - Bad: every return is forced to top or inherits another session's offset.
  - Traces to: `scroll_strategy`

- `crit-cheap-state`: Scroll memory is lightweight, browser-local, and garbage-collectable.
  - Good: implementation stores bounded per-session numeric offsets in the current browser session, survives dashboard component remounts/reloads and multi-hop navigation in the same window, and is cleaned up by browser-session lifetime, TTL, and max count.
  - Bad: the fix introduces localStorage, backend writes, polling, unbounded storage, expensive DOM scanning, or memory that disappears after a routine dashboard remount or after visiting other sessions.
  - Note: sessionStorage is acceptable here because it is scoped to the browser window/session and is naturally collected when that runtime is gone.
  - Traces to: `scroll_strategy`

- `crit-regression-test`: The behavior is protected by an automated regression test.
  - Good: targeted unit tests and Playwright E2E tests cover first-visit top, A to B to C back to A restore, same-window reload restore, and the layout-clamp regression in both the browser dashboard and menubar shell.
  - Bad: only manual validation or jsdom-only coverage protects the behavior.
  - Note: use the workflow and superpowers testing guardrails, including real browser verification.
  - Traces to: `scroll_strategy`
