# Boardroom protocol (paste into your project's CLAUDE.md / agent instructions)

```
## Boardroom — the session workflow

A boardroom MCP server may be connected (tools: clarify, present_plan,
review_results). The human decides everything as cards on a dashboard; the agent
runs in auto-permission mode and handles per-command permissions itself. Never
auto-accept anything on the human's behalf — approval lives in the cards.

- Judge first: simple skill calls, automatable/mechanical tasks, factual
  questions and single-obvious fixes — just do them. Route genuine decisions,
  plans and substantive results through boardroom.
- Decide (form the plan): before acting on an ambiguous task, call `clarify` with
  scoping questions as decision cards (button options + visual blocks) — prefer
  it over asking in chat. When the plan is formed, call `present_plan`: structural
  blocks (graph / phases / options_compare), each decision with exactly one
  recommended option. Once the human finalizes on the dashboard, just start
  working — do not re-ask in chat.
- For UI change requests, include lightweight wireframes or layout sketches in
  the option context so each option is visually understandable. Let each
  wireframe use its natural dimensions; do not force all options into one fixed
  card size unless readability requires it.
- Confirm mid-way: anything that needs a human call goes back to boardroom, never
  to chat.
- Finish: call `review_results` with screenshots or claim-by-claim bullet
  evidence so the human can decide whether the session is complete. Denied claims
  come back with notes — treat each note as your next instruction.
- Keep every card glanceable — the human reads like a CEO. Each block must help
  answer either one specific decision or the card as a whole; drop context that
  doesn't change the answer. Put tabular / comparative / quantitative /
  sequential info in a structured block (table, options_compare, phases, graph,
  diff_stat), never in prose. Markdown = 1–2 sentences, never essays. For
  results, evidence = proof it works (tests, diff), not a narration of how you
  built it.
- Treat `blockRefs` as the local/global boundary. Blocks referenced from a
  decision's `blockRefs` are question-local and render inside that question row;
  unreferenced blocks are global card context and render separately. Every
  `clarify` / `present_plan` call must include at least one global block and at
  least one question-local block for each decision. Do not attach a global block
  to every decision unless it materially changes every answer.
- Optimize for the dashboard layout: put the most useful graph/table/phases or
  options_compare block first, keep decision prompts to one sentence, and attach
  only the blocks needed for that decision through `blockRefs`. For result
  claims, use short claim text plus concrete evidence; long command output
  belongs inside an `evidence` block, not in the claim.
- These calls block until the human decides. That is intended. Do not treat a
  long wait as an error.
- If a boardroom tool call fails because the server is unreachable, fall back to
  asking the same questions natively in chat. Do not retry in a loop.
```
