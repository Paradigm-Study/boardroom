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

export class Queue extends EventEmitter {
  private waiters = new Map<string, Waiter>()

  constructor(private store: Store) {
    super()
  }

  add(card: Card, waiter?: Waiter): void {
    this.store.insert(card)
    if (waiter) this.waiters.set(card.id, waiter)
    this.emit('card', card)
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

  decide(id: string, answers: Record<string, DecisionAnswer>): { card: Card; response: CardResponse } {
    const card = this.getOrThrow(id)
    if (card.status !== 'pending') throw new ConflictError(`card is ${card.status}`)
    this.validateAnswers(card, answers)
    const summary = buildSummary(card, answers)
    const updated: Card = { ...card, status: 'decided', decidedAt: new Date().toISOString(), answers }
    this.store.update(updated)
    const response: CardResponse = { cardId: id, decisions: answers, summary }
    const waiter = this.waiters.get(id)
    this.waiters.delete(id)
    waiter?.resolve(response)
    this.emit('card', updated)
    return { card: updated, response }
  }

  orphan(id: string): void {
    const card = this.store.get(id)
    if (!card || card.status !== 'pending') return
    const updated: Card = { ...card, status: 'orphaned' }
    this.store.update(updated)
    const waiter = this.waiters.get(id)
    this.waiters.delete(id)
    waiter?.reject(new Error('caller disconnected before a decision was made'))
    this.emit('card', updated)
  }

  offlineAnswer(id: string, answers: Record<string, DecisionAnswer>): { card: Card; summary: string } {
    const card = this.getOrThrow(id)
    if (card.status !== 'orphaned') throw new ConflictError(`offline answers only apply to orphaned cards (card is ${card.status})`)
    this.validateAnswers(card, answers)
    const summary = buildSummary(card, answers)
    const updated: Card = { ...card, decidedAt: new Date().toISOString(), answers }
    this.store.update(updated)
    this.emit('card', updated)
    return { card: updated, summary }
  }

  pendingCount(): number {
    return this.store.list('pending').length
  }
}
