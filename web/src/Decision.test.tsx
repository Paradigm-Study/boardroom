// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card, Decision } from '../../src/shared/card.js'
import { DecisionSection } from './Decision.js'

afterEach(cleanup)

const card: Card = {
  id: 'c1',
  stage: 'plan',
  session: { agent: 'codex', project: 'boardroom' },
  headline: 'Plan',
  blocks: [],
  decisions: [],
  status: 'pending',
  createdAt: '2026-06-16T12:00:00.000Z',
}

const decision: Decision = {
  id: 'shape',
  prompt: 'Which shape should lead?',
  options: [
    { id: 'cockpit', label: 'Visual cockpit', recommended: true },
    { id: 'wizard', label: 'Wizard' },
  ],
}

describe('DecisionSection', () => {
  it('can apply the recommended option as a quick action', () => {
    const onChange = vi.fn()

    render(
      <DecisionSection
        card={card}
        decision={decision}
        index={0}
        total={1}
        blocks={[]}
        answer={{ chosen: [], note: '', custom: '' }}
        readonly={false}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Use recommended: Visual cockpit' }))

    expect(onChange).toHaveBeenCalledWith({ chosen: ['cockpit'], note: '', custom: '' })
  })

  it('shows upload controls for the note input and custom Other input', () => {
    const onChange = vi.fn()

    render(
      <DecisionSection
        card={card}
        decision={decision}
        index={0}
        total={1}
        blocks={[]}
        answer={{ chosen: [], note: '', custom: '' }}
        readonly={false}
        onChange={onChange}
      />,
    )

    expect(screen.getByRole('button', { name: 'Attach file to note' })).toBeTruthy()

    cleanup()
    render(
      <DecisionSection
        card={card}
        decision={decision}
        index={0}
        total={1}
        blocks={[]}
        answer={{ chosen: ['__other__'], note: '', custom: '' }}
        readonly={false}
        onChange={onChange}
      />,
    )

    expect(screen.getByRole('button', { name: 'Attach file to custom answer' })).toBeTruthy()
  })
})
