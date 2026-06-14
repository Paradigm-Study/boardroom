import { EventEmitter } from 'node:events'
import { OTHER_OPTION_ID, type Card, type CardResponse, type DecisionAnswer } from '../shared/card.js'
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

  constructor(private store: Store) {
    super()
  }

  private now(): number {
    return Date.parse(new Date().toISOString())
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
    const existing = this.store.findReattachable(card.fingerprint, this.now())

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
      const revived: Card = { ...existing, status: 'pending' }
      this.store.update(revived)
      const gen = this.attach(existing.id, waiter)
      this.emit('card', revived)
      return { cardId: existing.id, gen }
    }

    this.store.insert(card)
    const gen = this.attach(card.id, waiter)
    this.emit('card', card)
    return { cardId: card.id, gen }
  }

  private getOrThrow(id: string): Card {
    const card = this.store.get(id)
    if (!card) throw new NotFoundError(`no card "${id}"`)
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
  decide(id: string, answers: Record<string, DecisionAnswer>): { card: Card; summary: string; delivered: boolean } {
    const card = this.getOrThrow(id)
    if (card.status === 'decided') throw new ConflictError('card is already decided')
    this.validateAnswers(card, answers)
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
    const updated: Card = { ...card, status: 'orphaned' }
    this.store.update(updated)
    entry.waiter.reject(new Error('caller disconnected before a decision was made'))
    this.emit('card', updated)
  }

  pendingCount(): number {
    return this.store.list('pending').length
  }
}
