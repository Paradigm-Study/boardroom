import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { OTHER_OPTION_ID, PLAN_VERDICT_ID, PLAN_VERDICTS, RESULTS_VERDICT_ID, RESULTS_VERDICTS, SPEC_VERDICT_ID, SPEC_VERDICTS, type Card, type CardResponse, type DecideResponse, type DecisionAnswer } from '../shared/card.js'
import { Entry } from '../shared/entry.js'
import { REATTACH_WINDOW_MS } from '../shared/needsHuman.js'
import type { Store } from './store.js'
import { buildSummary } from './summary.js'

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class ValidationError extends Error {}

export interface Waiter {
  resolve(response: CardResponse): void
  reject(error: Error): void
}

interface Attached {
  waiter: Waiter
  gen: number
}

export class Queue extends EventEmitter {
  private waiters = new Map<string, Attached>()
  // Monotonic per-card generation. Survives waiter deletion (disconnect) so a
  // stale close event can never collide with a revived card's new waiter.
  private gens = new Map<string, number>()

  constructor(private store: Store, private reattachWindowMs = REATTACH_WINDOW_MS) {
    super()
  }

  private now(): number {
    return Date.now()
  }

  private attach(id: string, waiter: Waiter): number {
    const prev = this.waiters.get(id)
    const gen = (this.gens.get(id) ?? 0) + 1
    this.gens.set(id, gen)
    this.waiters.set(id, { waiter, gen })
    prev?.waiter.reject(new Error('superseded by a newer connection'))
    return gen
  }

  // Entry point for a (possibly retried) tool call. Returns the resolved id and
  // a generation token used by disconnect() to avoid orphaning a card that a
  // newer connection has already taken over. If a prior decision is waiting to
  // be claimed, the waiter resolves immediately and gen is -1.
  submit(card: Card, waiter: Waiter): { cardId: string; gen: number } {
    const existing = this.store.findReattachable(card, this.now(), this.reattachWindowMs)

    if (existing?.status === 'decided' && existing.answers) {
      const delivered: Card = { ...existing, deliveredAt: new Date().toISOString() }
      this.store.update(delivered)
      waiter.resolve({
        cardId: existing.id,
        decisions: existing.answers,
        summary: buildSummary(existing, existing.answers),
      })
      this.emit('card', delivered)
      return { cardId: existing.id, gen: -1 }
    }

    if (existing?.status === 'orphaned') {
      // Reattach: back to a live waiter. Clear the orphan metadata so a now-live
      // card carries no stale orphanedAt/Reason (which would otherwise mislead the
      // dashboard's "reconnecting" surfacing if it were ever read on a pending card).
      const revived: Card = { ...existing, status: 'pending', orphanedAt: undefined, orphanedReason: undefined }
      this.store.update(revived)
      const gen = this.attach(existing.id, waiter)
      this.emit('card', revived)
      return { cardId: existing.id, gen }
    }

    this.store.insert(card)
    const gen = this.attach(card.id, waiter)
    this.emit('card', card)
    this.recordTag(card, 'raised')
    return { cardId: card.id, gen }
  }

  // Auto-derived stage tag on a gate raise/decide. NOT called from the reattach
  // (decided-undelivered claim, gen: -1) or orphan-revive branches of submit — a
  // re-issued call is not a new gate, so it must not add a second 'raised' tag.
  //
  // Best-effort side channel: by the time this runs, the card is already
  // persisted and the waiter already attached/resolved (submit/decide's own
  // work is done). A store failure here (e.g. disk full) must NEVER surface as
  // a failure of the gate call that already succeeded — swallow it, warn, and
  // move on, so the tag stream is "nice to have," not load-bearing.
  private recordTag(card: Card, event: 'raised' | 'decided'): void {
    try {
      const tag: Entry = {
        id: randomUUID(),
        type: 'tag',
        ...(card.claudeSessionId ? { claudeSessionId: card.claudeSessionId } : {}),
        session: card.session,
        tag: `stage:${card.stage}:${event}`,
        cardId: card.id,
        createdAt: new Date().toISOString(),
      }
      this.store.insertEntry(tag)
      this.emit('entry', tag)
    } catch (error) {
      console.warn(`[queue] failed to record stage tag for card "${card.id}" (${event}):`, error)
    }
  }

  // Validate, persist, and emit a report entry. The seam present_report calls so
  // mcp.ts never touches the Store directly.
  postReport(entry: Entry): void {
    const valid = Entry.parse(entry)
    this.store.insertEntry(valid)
    this.emit('entry', valid)
  }

  private getOrThrow(id: string): Card {
    const card = this.store.get(id)
    if (!card) throw new NotFoundError(`no card "${id}"`)
    return card
  }

  // Which decisions a submission must satisfy. Most stages: all of them. But a
  // "send-back" verdict is a judgement on the whole card, so the human needn't
  // have answered every sub-decision:
  //   - plan revise/reject  → validate only the plan verdict.
  //   - results "keep going" → validate the verdict plus only the claims actually
  //     voted on (an unreviewed claim shouldn't block continuing, but a
  //     deny/changes vote still needs its note).
  //   - spec "revise"        → validate only the spec verdict (the send-back analog:
  //     sending the whole contract back doesn't require addressing each criterion).
  // "mark complete" / "lock spec" stay strict: you cannot declare the session done
  // (or freeze the contract) while a claim / criterion is left unaddressed.
  private validationScope(card: Card, answers: Record<string, DecisionAnswer>): Card {
    if (card.stage === 'plan') {
      const v = PLAN_VERDICTS.find(o => o === answers[PLAN_VERDICT_ID]?.chosen[0])
      if (v === 'revise' || v === 'reject') {
        return { ...card, decisions: card.decisions.filter(d => d.id === PLAN_VERDICT_ID) }
      }
    }
    if (card.stage === 'spec') {
      const v = SPEC_VERDICTS.find(o => o === answers[SPEC_VERDICT_ID]?.chosen[0])
      if (v === 'revise') {
        return { ...card, decisions: card.decisions.filter(d => d.id === SPEC_VERDICT_ID) }
      }
    }
    if (card.stage === 'results') {
      const v = RESULTS_VERDICTS.find(o => o === answers[RESULTS_VERDICT_ID]?.chosen[0])
      if (v === 'continue') {
        return {
          ...card,
          decisions: card.decisions.filter(
            d => d.id === RESULTS_VERDICT_ID || (answers[d.id]?.chosen.length ?? 0) > 0,
          ),
        }
      }
    }
    return card
  }

  private validateAnswers(card: Card, answers: Record<string, DecisionAnswer>): void {
    for (const d of card.decisions) {
      const a = answers[d.id]
      if (!a || a.chosen.length === 0) throw new ValidationError(`missing answer for decision "${d.id}"`)
      for (const chosen of a.chosen) {
        if (chosen === OTHER_OPTION_ID) {
          if (!a.custom?.trim()) {
            throw new ValidationError(`decision "${d.id}": the "other" choice requires custom text`)
          }
          continue
        }
        if (!d.options.some(o => o.id === chosen)) {
          throw new ValidationError(`decision "${d.id}": unknown option "${chosen}"`)
        }
      }
      if (!d.multi && a.chosen.length !== 1) {
        throw new ValidationError(`decision "${d.id}" is single-choice`)
      }
      if ((d.noteRequiredOn ?? []).some(o => a.chosen.includes(o)) && !a.note?.trim()) {
        throw new ValidationError(`decision "${d.id}" requires a note for the chosen option`)
      }
    }
  }

  // Record the human's decision. Works on a live (pending) card AND on an
  // orphaned one whose agent has disconnected. If a waiter is live, the answer
  // is delivered through it now (delivered=true). If not, the decision is stored
  // and waits to be claimed when the agent reconnects (delivered=false) — the
  // dashboard offers the copy-paste summary as a manual fallback.
  decide(id: string, answers: Record<string, DecisionAnswer>): DecideResponse {
    const card = this.getOrThrow(id)
    if (card.status === 'decided') throw new ConflictError('card is already decided')
    this.validateAnswers(this.validationScope(card, answers), answers)
    const summary = buildSummary(card, answers)
    const entry = this.waiters.get(id)
    const delivered = entry !== undefined
    const ts = new Date().toISOString()
    const updated: Card = {
      ...card,
      status: 'decided',
      decidedAt: ts,
      answers,
      ...(delivered ? { deliveredAt: ts } : {}),
    }
    this.store.update(updated)
    if (entry) {
      this.waiters.delete(id)
      entry.waiter.resolve({ cardId: id, decisions: answers, summary })
    }
    this.emit('card', updated)
    this.recordTag(updated, 'decided')
    return { card: updated, summary, delivered }
  }

  // The HTTP request behind this card's waiter closed (sleep, interrupt, client
  // timeout). Orphan the card so it leaves the live queue, but it stays
  // reattachable: a retry revives it, and the human can still decide it. The gen
  // guard ensures a stale close event can't orphan a card a newer connection
  // already adopted.
  disconnect(id: string, gen: number): void {
    const entry = this.waiters.get(id)
    if (!entry || entry.gen !== gen) return
    this.waiters.delete(id)
    const card = this.store.get(id)
    if (!card || card.status !== 'pending') return
    const updated: Card = { ...card, status: 'orphaned', orphanedAt: new Date().toISOString(), orphanedReason: 'disconnect' }
    this.store.update(updated)
    entry.waiter.reject(new Error('caller disconnected before a decision was made'))
    this.emit('card', updated)
  }

  // The bounded block window elapsed with no decision. Detach the waiter and
  // orphan the card — the GRACEFUL counterpart to disconnect(): the card is left
  // exactly as a dropped connection would (orphaned, so a re-issued identical
  // call reattaches via findReattachable — a 'pending' card would instead be
  // duplicated), but we do NOT reject the waiter. The hanging handler resolves
  // its own promise with a "parked, re-issue to claim" sentinel instead of
  // surfacing an error. Returns false if a decision already landed or a newer
  // connection took over (gen guard), so the handler keeps the real result.
  park(id: string, gen: number): boolean {
    const entry = this.waiters.get(id)
    if (!entry || entry.gen !== gen) return false
    const card = this.store.get(id)
    if (!card || card.status !== 'pending') return false
    this.waiters.delete(id)
    const updated: Card = { ...card, status: 'orphaned', orphanedAt: new Date().toISOString(), orphanedReason: 'park' }
    this.store.update(updated)
    this.emit('card', updated)
    return true
  }

  pendingCount(): number {
    return this.store.list('pending').length
  }
}
