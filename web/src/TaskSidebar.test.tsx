// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import { TaskSidebar } from './TaskSidebar.js'

afterEach(cleanup)

function card(overrides: Partial<Card> & Pick<Card, 'id' | 'headline' | 'createdAt'>): Card {
  return {
    stage: 'plan',
    session: { agent: 'codex', project: '/workspace/product-a', title: 'Checkout sprint' },
    blocks: [],
    decisions: [
      {
        id: 'd1',
        prompt: 'Decide?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      },
    ],
    status: 'pending',
    ...overrides,
  }
}

describe('TaskSidebar session grouping', () => {
  it('groups pending cards by project and then session', () => {
    render(
      <TaskSidebar
        selectedId={null}
        cards={[
          card({ id: 'newer', headline: 'Folder upload plan', createdAt: '2026-06-16T12:05:00.000Z' }),
          card({ id: 'older', headline: 'Canvas upload review', createdAt: '2026-06-16T12:00:00.000Z' }),
          card({
            id: 'other-session',
            headline: 'Notebook review',
            createdAt: '2026-06-16T11:59:00.000Z',
            session: { agent: 'codex', project: '/workspace/product-a', title: 'Notebook sprint' },
          }),
        ]}
      />,
    )

    const project = screen.getByRole('group', { name: '/workspace/product-a' })
    expect(within(project).getByRole('heading', { name: '/workspace/product-a' })).toBeTruthy()

    const checkout = within(project).getByRole('group', { name: 'Checkout sprint' })
    expect(within(checkout).getByRole('heading', { name: 'Checkout sprint' })).toBeTruthy()
    expect(within(checkout).getByText('2 cards')).toBeTruthy()
    expect(within(checkout).getByText('Folder upload plan')).toBeTruthy()
    expect(within(checkout).getByText('Canvas upload review')).toBeTruthy()

    const notebook = within(project).getByRole('group', { name: 'Notebook sprint' })
    expect(within(notebook).getByText('Notebook review')).toBeTruthy()
  })

  it('keeps sessions with the same title separate across projects', () => {
    render(
      <TaskSidebar
        selectedId={null}
        cards={[
          card({ id: 'a', headline: 'Project A card', createdAt: '2026-06-16T12:00:00.000Z' }),
          card({
            id: 'b',
            headline: 'Project B card',
            createdAt: '2026-06-16T12:01:00.000Z',
            session: { agent: 'codex', project: '/workspace/product-b', title: 'Checkout sprint' },
          }),
        ]}
      />,
    )

    expect(screen.getByRole('group', { name: '/workspace/product-a' })).toBeTruthy()
    expect(screen.getByRole('group', { name: '/workspace/product-b' })).toBeTruthy()
    expect(screen.getAllByRole('group', { name: 'Checkout sprint' })).toHaveLength(2)
  })
})
