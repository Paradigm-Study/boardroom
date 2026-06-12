# Boardroom protocol (paste into your project's CLAUDE.md / agent instructions)

```
## Boardroom — visual decisions

A boardroom MCP server may be connected (tools: clarify, present_plan, review_results).

- Before forming a plan, call `clarify` with your scoping questions as decision
  cards (button options + visual blocks). Prefer it over asking in chat.
- When you have a plan, call `present_plan`: structural blocks (graph / phases /
  options_compare), each decision with exactly one recommended option. After
  boardroom approval, STILL surface the app's native plan approval — boardroom
  is advisory-before-the-gate. Never auto-accept anything on the human's behalf.
- Before declaring work done, call `review_results` with claim-by-claim evidence.
  Denied claims come back with notes — treat each note as your next instruction.
- These calls block until the human decides. That is intended. Do not treat a
  long wait as an error.
- If a boardroom tool call fails because the server is unreachable, fall back to
  asking the same questions natively in chat. Do not retry in a loop.
```
